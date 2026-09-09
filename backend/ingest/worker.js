// =============================================================
//  Ingest worker
//  Runs inside the API process. Claims queued documents one at a
//  time, sends the original to the parser, embeds the chunks in
//  batches, and bulk-inserts them. State lives in the documents
//  row, so a restart resumes where it left off.
//
//  status: queued → parsing → structuring → learning → ready | failed
// =============================================================

import { EventEmitter } from "node:events";
import { extname } from "node:path";
import { parseDocument, renderPdf, RENDERABLE_EXT, ParserError } from "./parserClient.js";
import { downloadObject, uploadObject, parsedPath, renditionPath } from "./storage.js";
import { summarizeDocument, documentProfileText } from "./summarize.js";

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const EMBED_BATCH = Number(process.env.EMBED_BATCH || 64);
const POLL_MS = Number(process.env.INGEST_POLL_MS || 2000);
const MAX_ATTEMPTS = 3;
// A document left mid-stage with no heartbeat for this long was abandoned by a worker
// that died. reset_stale_ingests requeues it, or fails it once it has used MAX_ATTEMPTS.
// Heartbeats land every 30 s, so the 2-minute default is four missed beats.
const STALE_MINUTES = Number(process.env.INGEST_STALE_MINUTES ?? 2);
const HEARTBEAT_MS = 30_000;
const STALE_SWEEP_MS = 60_000;   // how often the idle loop re-runs the stale sweep

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Turn a file name into searchable words. Stored on every chunk as `title` (weighted
 * highest in document_chunks.tsv) and prepended to the embedded text, so each word
 * must stand alone. The SQL backfill in migration 0005 applies the same steps.
 *   "2025_LEE_3311_Technical-Teacher-Education_1765784712.pdf" → "2025 LEE 3311 Technical Teacher Education"
 *   "SolluCIO-ArielWilson-ServiceDesk2.docx"                    → "Sollu CIO Ariel Wilson Service Desk 2"
 */
/**
 * What the keyword index and the embedding know the document as: the display name
 * (human words) followed by the words of the file name, so "Teacher Education
 * Program" and "LEE 3311" both find the same chunks.
 */
export function searchTitle(doc = {}) {
  const display = String(doc.display_name || "").trim();
  const fromFile = documentTitle(doc.file_name || "");
  if (!display) return fromFile;
  if (!fromFile || display.toLowerCase() === fromFile.toLowerCase()) return display;
  return `${display} ${fromFile}`;
}

export function documentTitle(fileName = "") {
  return String(fileName)
    .replace(/\.[a-z0-9]{2,5}$/i, "")            // extension
    .replace(/([a-z])([A-Z])/g, "$1 $2")         // camelCase → camel Case
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")      // Desk2 → Desk 2
    .replace(/[-_.]+/g, " ")                     // separators
    .replace(/\b\d{7,}\b/g, "")                  // upload ids and other long numbers
    .replace(/\s+/g, " ")
    .trim();
}

export function createIngestWorker(fastify) {
  const { supabase, openai, log } = fastify;
  const bus = new EventEmitter();
  let running = false;
  let loopPromise = null;

  // -----------------------------------------------------------
  // helpers
  // -----------------------------------------------------------
  async function setStatus(id, patch) {
    const { error } = await supabase.from("documents").update(patch).eq("id", id);
    if (error) log.warn({ id, patch, error: error.message }, "ingest: status update failed");
  }

  function event(id, stage, message) {
    supabase
      .from("ingest_events")
      .insert([{ document_id: id, stage, message }])
      .then(({ error }) => {
        if (error) log.warn({ id, stage, error: error.message }, "ingest: event insert failed");
      });
  }

  async function embedBatch(texts, attempt = 1) {
    try {
      const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
      return res.data.map((d) => d.embedding);
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || !status;
      if (retryable && attempt < 4) {
        const wait = 1500 * attempt ** 2;
        log.warn({ status, attempt, wait }, "ingest: embedding call failed, retrying");
        await sleep(wait);
        return embedBatch(texts, attempt + 1);
      }
      throw new Error(`Embedding failed: ${err?.message || err}`);
    }
  }

  function chunkRow(doc, c) {
    return {
      document_id: doc.id,
      namespace: doc.namespace,
      // weighted highest in the keyword index (document_chunks.tsv, migration 0005)
      title: searchTitle(doc),
      chunk_index: c.index,
      chunk_text: c.text,
      page_start: c.page_start ?? null,
      page_end: c.page_end ?? null,
      bboxes: c.bboxes ?? [],
      headings: c.headings ?? [],
      section_label: c.section_label ?? null,
      item_kind: c.item_kind ?? "paragraph",
      token_count: c.token_count ?? null,
      content_hash: c.content_hash ?? null,
      metadata: { parser: "docling", embed_model: EMBED_MODEL },
    };
  }

  // -----------------------------------------------------------
  // one document
  // -----------------------------------------------------------
  async function processDocument(doc) {
    const id = doc.id;
    const started = Date.now();
    log.info({ id, file: doc.file_name, attempt: doc.attempts }, "ingest: start");
    event(id, "parsing", `Reading ${doc.file_name}`);

    // ---- parsing -------------------------------------------------
    if (!doc.storage_path) throw new Error("No original file is stored for this document.");
    await setStatus(id, { stage_detail: "Reading the document" });

    const buffer = await downloadObject(supabase, doc.storage_path);
    const parsed = await parseDocument({ buffer, fileName: doc.file_name });

    const chunks = parsed.chunks.filter((c) => c.text && c.text.trim());
    const pageCount = parsed.page_count ?? null;

    if (parsed.markdown) {
      await uploadObject(supabase, parsedPath(doc.namespace, id), parsed.markdown, "text/markdown");
    }

    // ---- PDF rendition for Office files (viewing only, non-fatal) ----
    let rendition = null;
    if (RENDERABLE_EXT.has(extname(doc.file_name || "").toLowerCase())) {
      await setStatus(id, { stage_detail: "Preparing a preview" });
      try {
        const r = await renderPdf({ buffer, fileName: doc.file_name });
        const path = renditionPath(doc.namespace, id);
        await uploadObject(supabase, path, r.buffer, "application/pdf");
        rendition = { path, pages: r.pageCount };
        event(id, "rendition", `PDF preview ready (${r.pageCount} pages)`);
      } catch (err) {
        log.warn({ id, err: err?.message }, "ingest: rendition failed (non-fatal)");
        event(id, "rendition", `No PDF preview: ${err?.message || err}`);
      }
    }

    // ---- structuring ---------------------------------------------
    const tables = chunks.filter((c) => c.item_kind === "table").length;
    await setStatus(id, {
      status: "structuring",
      stage_progress: 0,
      // Word files have no pages from the parser; show the rendition's page count instead
      page_count: pageCount || rendition?.pages || null,
      rendition_path: rendition?.path || null,
      parser: "docling",
      parser_version: parsed.parser_version || null,
      stage_detail: `Found ${chunks.length} section${chunks.length === 1 ? "" : "s"}${tables ? ` and ${tables} table${tables === 1 ? "" : "s"}` : ""}`,
    });
    event(id, "structuring", `${chunks.length} sections, ${tables} tables, ${pageCount ?? "?"} pages`);

    // re-ingest or legacy replace: clear whatever was there
    const { error: delErr } = await supabase.from("document_chunks").delete().eq("document_id", id);
    if (delErr) throw new Error(`Could not clear old sections: ${delErr.message}`);

    if (chunks.length === 0) {
      // 422 puts this on failDocument's non-retryable list: re-reading the same
      // file will not produce text either.
      throw new ParserError("The document produced no readable text.", { status: 422 });
    }

    // ---- learning ------------------------------------------------
    await setStatus(id, { status: "learning", stage_progress: 0, stage_detail: `Learning · 0 of ${chunks.length} sections` });
    event(id, "learning", `Embedding ${chunks.length} sections in batches of ${EMBED_BATCH}`);

    let done = 0;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      // The document title rides along in the embedded text (not the stored text) so a
      // question that names the file, not just its subject, still lands on its chunks.
      const title = searchTitle(doc);
      const vectors = await embedBatch(batch.map((c) => `Document: ${title}
${c.embed_text || c.text}`));

      const rows = batch.map((c, j) => ({ ...chunkRow(doc, c), embedding: vectors[j] }));
      const { error } = await supabase.from("document_chunks").insert(rows);
      if (error) throw new Error(`Could not store sections: ${error.message}`);

      done += batch.length;
      await setStatus(id, {
        stage_progress: Math.round((done / chunks.length) * 100),
        stage_detail: `Learning · ${done} of ${chunks.length} sections`,
      });
    }

    // ---- summary (non-fatal) --------------------------------------
    await setStatus(id, { stage_detail: "Writing a summary" });
    const docSummary = await summarizeDocument({
      openai,
      fileName: doc.file_name,
      markdown: parsed.markdown || "",
      chunks,
      pageCount,
      log,
    });
    if (docSummary) event(id, "summary", `${docSummary.sections?.length || 0} sections summarized`);

    // ---- document profile embedding (non-fatal) -------------------
    // One vector for the whole document, so retrieval can tell which documents
    // a question is about before it weighs individual sections.
    let profile = null;
    try {
      const profileText = documentProfileText({
        title: searchTitle(doc),
        summary: docSummary,
        sectionLabels: chunks.map((c) => c.section_label).filter(Boolean),
      });
      if (profileText) {
        const [vector] = await embedBatch([profileText]);
        profile = { profile_text: profileText, embedding: vector, embedded_at: new Date().toISOString() };
      }
    } catch (err) {
      log.warn({ id, err: err?.message }, "ingest: document profile embedding failed");
    }

    // ---- ready ---------------------------------------------------
    const summary = `${pageCount ? `${pageCount} page${pageCount === 1 ? "" : "s"} · ` : ""}${chunks.length} section${chunks.length === 1 ? "" : "s"}`;
    await setStatus(id, {
      status: "ready",
      stage_progress: 100,
      stage_detail: summary,
      error: null,
      ...(profile || {}),
      metadata: {
        ...(doc.metadata || {}),
        ingest: {
          parser: "docling",
          parser_version: parsed.parser_version || null,
          warnings: parsed.warnings || [],
          timings: parsed.timings || {},
          embed_model: EMBED_MODEL,
          chunks: chunks.length,
          tables,
          completed_at: new Date().toISOString(),
          summary: docSummary,
        },
      },
    });
    event(id, "ready", `${summary} in ${Math.round((Date.now() - started) / 1000)}s`);
    log.info({ id, chunks: chunks.length, pages: pageCount, ms: Date.now() - started }, "ingest: ready");
  }

  async function failDocument(doc, err) {
    const message = err instanceof ParserError ? err.message : (err?.message || String(err));
    log.error({ id: doc.id, err: message }, "ingest: failed");

    // never leave a half-embedded document answering questions
    await supabase.from("document_chunks").delete().eq("document_id", doc.id);

    const retryable = !(err instanceof ParserError && [400, 401, 403, 413, 415, 422].includes(err.status));
    const willRetry = retryable && doc.attempts < MAX_ATTEMPTS;

    await setStatus(doc.id, {
      status: willRetry ? "queued" : "failed",
      error: message,
      stage_detail: willRetry ? `Retrying (attempt ${doc.attempts + 1} of ${MAX_ATTEMPTS})` : null,
    });
    event(doc.id, willRetry ? "retry" : "failed", message);
  }

  // -----------------------------------------------------------
  // loop
  // -----------------------------------------------------------
  async function claim() {
    const { data, error } = await supabase.rpc("claim_next_document");
    if (error) {
      log.warn({ error: error.message }, "ingest: claim failed");
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return row && row.id ? row : null;
  }

  function waitForWork() {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, POLL_MS);
      function finish() {
        clearTimeout(timer);
        bus.off("nudge", finish);
        resolve();
      }
      bus.once("nudge", finish);
    });
  }

  // Requeue (or, after MAX_ATTEMPTS, fail) documents whose worker died mid-stage.
  // Returns nothing; never throws.
  async function sweepStale() {
    try {
      const { data: swept, error } = await supabase.rpc("reset_stale_ingests", { older_than: `${STALE_MINUTES} minutes` });
      if (error) throw new Error(error.message);
      if (swept) log.info({ swept, stale_minutes: STALE_MINUTES }, "ingest: reset stale documents (requeued, or failed after 3 attempts)");
    } catch (err) {
      log.warn({ err: err?.message }, "ingest: stale sweep failed");
    }
  }

  // Stamp documents.heartbeat_at while a document is being processed so the
  // stale sweep can tell a slow ingest from a dead worker. Returns a stop function.
  function startHeartbeat(id) {
    const beat = () =>
      supabase
        .from("documents")
        .update({ heartbeat_at: new Date().toISOString() })
        .eq("id", id)
        .then(
          ({ error }) => { if (error) log.warn({ id, error: error.message }, "ingest: heartbeat failed"); },
          (err) => log.warn({ id, err: err?.message }, "ingest: heartbeat failed")
        );
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }

  async function loop() {
    await sweepStale();
    let lastSweep = Date.now();

    while (running) {
      const doc = await claim();
      if (!doc) {
        if (Date.now() - lastSweep >= STALE_SWEEP_MS) {
          await sweepStale();
          lastSweep = Date.now();
        }
        await waitForWork();
        continue;
      }

      const stopHeartbeat = startHeartbeat(doc.id);
      try {
        await processDocument(doc);
      } catch (err) {
        try {
          await failDocument(doc, err);
        } catch (failErr) {
          // recording the failure failed (network, DB); log and keep the loop alive
          log.error({ id: doc.id, err: failErr?.message, cause: err?.message }, "ingest: could not record failure");
        }
      } finally {
        stopHeartbeat();
      }
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loopPromise = loop().catch((err) => log.error({ err: err?.message }, "ingest: loop crashed"));
      log.info({ poll_ms: POLL_MS, batch: EMBED_BATCH, model: EMBED_MODEL }, "ingest: worker started");
    },
    async stop() {
      running = false;
      bus.emit("nudge");
      await loopPromise;
    },
    nudge() {
      bus.emit("nudge");
    },
    get running() {
      return running;
    },
  };
}
