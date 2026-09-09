// ============================================================
//  CORTÉX — CHAT ENGINE
//  v1.8.7 SURVIVABILITY ORCHESTRATION HARDENING
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { requireAuth } from "../lib/authMiddleware.js";

// 🔒 DLP
import { runDLPScan, stripSensitiveFields } from "../lib/dlp.js";

// 🔥 Step 46 Reasoning Modules
import { decodeIntent } from "../reasoning/intent.js";
import { synthesizeFinalAnswer } from "../reasoning/synthesis.js";
import { formatOutput } from "../reasoning/outputFormatter.js";

// 🔥 Step 47 Identity Layer
import { applyIdentityLayer } from "../identity/applyIdentity.js";
import { resolveToneForNamespace } from "../identity/toneRouter.js";

// 🔥 Whole-document overview path
import { downloadObject, parsedPath } from "../ingest/storage.js";
import { renderOverview } from "../ingest/summarize.js";

// ----------------------------------------------------
const MAX_INPUT = 10000;
const MAX_EPHEMERAL_CONTEXT = 18000;
const MAX_RAG_CONTEXT = 22000;
// Whole-document path: the full parsed text of one named document (~40k tokens)
const WHOLE_DOC_MAX_CHARS = Number(process.env.WHOLE_DOC_MAX_CHARS || 160000);
const WHOLE_DOC_MAX_CHUNKS = Number(process.env.WHOLE_DOC_MAX_CHUNKS || 2000);

// Only genuine "tell me about the whole document" questions take the whole-document
// path; a specific question that happens to name a file stays on retrieval.
const OVERVIEW_PATTERN =
  /\b(summari[sz]e|summary|overview|what(?:'s| is) in|what does .{0,60}(?:contain|cover)|outline|walk me through|tl;?dr|main points|key points|list (?:all|every|each)|complete list|full list|enumerate|extract all|table of contents)\b/i;

// ------------------------------------------------
// 🔖 NUMBERED SOURCES + CITATIONS
// ------------------------------------------------
function sourceLabel(src) {
  const name = src.display_name || src.file_name || "Document";
  const page =
    src.page_start != null
      ? src.page_end != null && src.page_end !== src.page_start
        ? `pages ${src.page_start}–${src.page_end}`
        : `page ${src.page_start}`
      : null;
  return [name, page, src.section_label].filter(Boolean).join(" — ");
}

// Chunk text may carry a "SOURCE FILE: x" line from the retriever; the numbered
// label replaces it.
function stripSourceHeader(text = "") {
  return String(text || "").replace(/^(?:PRIMARY ENTITY:[^\n]*\n)?SOURCE FILE:[^\n]*\n+/i, "").trim();
}

// Group chunk-level sources into one numbered source per (document, page).
// Word files have no pages, so they group by section; legacy chunks stay one-per-chunk.
// Fewer numbers in the prompt → fewer chips in the answer, and a chip means "this page".
const MAX_CITATIONS_PER_SENTENCE = Number(process.env.MAX_CITATIONS_PER_SENTENCE || 2);
const LEGACY_CHUNKS_PER_PART = Number(process.env.LEGACY_CHUNKS_PER_PART || 4);

function groupSources(chunkSources = []) {
  const groups = [];
  const byKey = new Map();
  for (const s of chunkSources) {
    // Legacy (text-only) chunks are ~500 characters with no page or section, so
    // four consecutive chunks (~one printed page) share a number, labelled "part N".
    const legacyPart = s.chunk_index != null ? Math.floor(s.chunk_index / LEGACY_CHUNKS_PER_PART) + 1 : null;
    const key =
      s.page_start != null ? `${s.document_id}|p${s.page_start}`
      : s.section_label ? `${s.document_id}|s${s.section_label}`
      : legacyPart != null ? `${s.document_id || s.file_name}|k${legacyPart}`
      : `${s.document_id || s.file_name}|c${s.chunk_id}`;
    const rank = s.rank ?? s.n ?? groups.length;
    let g = byKey.get(key);
    if (!g) {
      g = {
        n: groups.length + 1,
        key,
        document_id: s.document_id || null,
        file_name: s.file_name || null,
        display_name: s.display_name || null,
        page_start: s.page_start ?? null,
        page_end: s.page_end ?? null,
        section_label: s.section_label || (s.page_start == null && legacyPart != null ? `part ${legacyPart}` : null),
        chunk_ids: [],
        chunks: [],
        rank                                   // best retrieval rank in the group
      };
      byKey.set(key, g);
      groups.push(g);
    }
    g.chunk_ids.push(s.chunk_id || null);
    g.chunks.push({
      chunk_id: s.chunk_id || null,
      chunk_index: s.chunk_index ?? null,
      section_label: s.section_label || null,
      text: stripSourceHeader(s.text)
    });
    g.rank = Math.min(g.rank, rank);
    if (s.page_end != null && (g.page_end == null || s.page_end > g.page_end)) g.page_end = s.page_end;
    if (g.section_label && s.section_label && s.section_label !== g.section_label) g.section_label = null; // mixed sections on one page
  }
  return groups.map(g => ({ ...g, text: joinChunkTexts(g) }));
}

// The chunk text never contains its heading (the parser keeps headings in the
// section label). A page that mixes sections loses the label above, so each
// chunk's own heading is written inline instead: a number that lives only in a
// heading ("Core Education Requirements: 13 credits") still reaches the model.
function joinChunkTexts(g) {
  const labels = new Set(g.chunks.map(c => c.section_label).filter(Boolean));
  const mixed = labels.size > 1 || (labels.size === 1 && !g.section_label);
  return g.chunks.map((c, i) => {
    const prev = i > 0 ? g.chunks[i - 1].section_label : null;
    const show = mixed && c.section_label && c.section_label !== prev;
    return show ? `${c.section_label}\n${c.text}` : c.text;
  }).join("\n\n");
}

// Drop the lowest-ranked sources until the numbered block fits the budget, then
// renumber in place. Whole sources only: a source is never cut mid-text, and a
// number the model can cite always has its full text in the prompt.
function fitSourcesToBudget(sources = [], budget = MAX_RAG_CONTEXT) {
  const cost = s => `[${s.n}] ${sourceLabel(s)}\n`.length + String(s.text || "").length + 2;
  const byRank = [...sources].sort((a, b) => (a.rank ?? a.n) - (b.rank ?? b.n));
  const keep = new Set();
  let chars = 0;
  for (const s of byRank) {
    const c = cost(s);
    if (chars + c > budget && keep.size) break;
    chars += c;
    keep.add(s);
  }
  const kept = sources.filter(s => keep.has(s)).map((s, i) => ({ ...s, n: i + 1 }));
  return { sources: kept, dropped: sources.length - kept.length, chars };
}

// "[3][5][7][9]" → keep the first two distinct *valid* numbers of each run. Runs
// are limited independently: a bullet that cites the same page as the previous
// bullet keeps its citation (the earlier version deleted it).
function limitCitations(answer = "", max = MAX_CITATIONS_PER_SENTENCE, known = null) {
  return String(answer).replace(/(?:\s*\[\d{1,3}\])+/g, (run) => {
    let nums = [...new Set([...run.matchAll(/\[(\d{1,3})\]/g)].map(m => Number(m[1])))];
    if (known) nums = nums.filter(n => known.has(n));
    const kept = nums.slice(0, max);
    if (!kept.length) return "";
    const lead = run.match(/^\s*/)[0];
    return lead + kept.map(n => `[${n}]`).join("");
  });
}

// "[1, 2]" and "[1-3]" are written by the model now and then; turn them into the
// "[1][2]" form the rest of the pipeline understands (ranges only when every
// number is a real source, so a genuine "[1-3]" in a document is left alone).
function normalizeCitationLists(answer = "", known = new Set()) {
  return String(answer)
    .replace(/\[(\d{1,3})(?:\s*,\s*\d{1,3})+\]/g, (m) =>
      m.slice(1, -1).split(/\s*,\s*/).map(n => `[${Number(n)}]`).join(""))
    .replace(/\[(\d{1,3})\s*[-–]\s*(\d{1,3})\]/g, (m, a, b) => {
      const lo = Number(a), hi = Number(b);
      if (hi <= lo || hi - lo > 4) return m;
      const nums = [];
      for (let n = lo; n <= hi; n++) { if (!known.has(n)) return m; nums.push(n); }
      return nums.map(n => `[${n}]`).join("");
    });
}

// Sources are labelled with the display name; when that differs from the file name,
// say so once, so a question that names the file ("what is in LEE_3311?") is
// recognised as being about this document.
function documentNamesPreamble(sources) {
  const seen = new Map();
  for (const s of sources) {
    if (s.display_name && s.file_name && s.display_name !== s.file_name && !seen.has(s.file_name)) {
      seen.set(s.file_name, s.display_name);
    }
  }
  if (!seen.size) return "";
  return "DOCUMENTS: " + [...seen].map(([file, name]) => `"${name}" is the file ${file}`).join("; ") + "\n\n";
}

function buildNumberedContext(sources) {
  return documentNamesPreamble(sources) + sources
    .map(s => `[${s.n}] ${sourceLabel(s)}\n${stripSourceHeader(s.text)}`)
    .join("\n\n");
}

// The passage shown for a citation is the chunk of that page that best matches the
// sentence the marker closes, not simply the first chunk on the page.
function overlapTokens(text = "") {
  return new Set(String(text).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}
function bestChunkFor(group, sentence) {
  const chunks = group.chunks || [];
  if (!chunks.length) return { chunk: null, score: 0 };
  if (chunks.length === 1) return { chunk: chunks[0], score: 0 };
  const q = overlapTokens(sentence);
  let best = chunks[0], bestScore = -1;
  for (const c of chunks) {
    const t = overlapTokens(c.text);
    let score = 0;
    for (const w of q) if (t.has(w)) score++;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return { chunk: best, score: bestScore };
}

// Pull [n] markers out of the answer; keep only numbers that exist.
function extractCitations(answer = "", sources = []) {
  const byN = new Map(sources.map(s => [s.n, s]));
  const used = new Map();   // n → best supporting chunk seen across the answer
  const text = String(answer || "");
  const cleaned = text.replace(/\[(\d{1,3})\]/g, (m, n, offset) => {
    const k = Number(n);
    const s = byN.get(k);
    if (!s) return "";
    const before = text.slice(Math.max(0, offset - 400), offset);
    const sentence = before.split(/\n|(?<=[.!?])\s+/).pop() || before;
    const pick = bestChunkFor(s, sentence);
    const prev = used.get(k);
    if (!prev || pick.score > prev.score) used.set(k, pick);
    return m;
  });
  const citations = [...used.keys()].sort((a, b) => a - b).map(n => {
    const s = byN.get(n);
    const chunk = used.get(n)?.chunk || null;
    const passage = chunk ? chunk.text : stripSourceHeader(s.text);
    return {
      n,
      chunk_id: chunk?.chunk_id || s.chunk_id || null,
      document_id: s.document_id || null,
      file_name: s.file_name || null,
      display_name: s.display_name || null,
      page_start: s.page_start ?? null,
      page_end: s.page_end ?? null,
      section_label: s.section_label || null,
      chunk_ids: s.chunk_ids || (s.chunk_id ? [s.chunk_id] : []),
      snippet: String(passage || "").replace(/\s+/g, " ").slice(0, 320)
    };
  });
  return { answer: cleaned.replace(/[ \t]+\n/g, "\n"), citations };
}

function isOverviewQuestion(text = "") {
  return OVERVIEW_PATTERN.test(String(text || ""));
}

// Build context for one named document: stored summary + full text within budget.
async function buildWholeDocumentContext(fastify, documentId) {
  const { data: doc } = await fastify.supabase
    .from("documents")
    .select("id, file_name, display_name, namespace, page_count, status, metadata")
    .eq("id", documentId)
    .maybeSingle();
  if (!doc || doc.status !== "ready") return null;

  const summary = doc.metadata?.ingest?.summary || null;
  const overview = renderOverview(summary, { fileName: doc.display_name || doc.file_name, pageCount: doc.page_count });

  // Every section of the document, in reading order, as a numbered source.
  const { data: chunks } = await fastify.supabase
    .from("document_chunks")
    .select("id, chunk_index, chunk_text, page_start, page_end, section_label")
    .eq("document_id", doc.id)
    .order("chunk_index", { ascending: true })
    .limit(WHOLE_DOC_MAX_CHUNKS);

  const sources = [];
  let chars = 0;
  let truncated = false;
  if ((chunks || []).length >= WHOLE_DOC_MAX_CHUNKS) truncated = true;
  for (const c of chunks || []) {
    const len = (c.chunk_text || "").length;
    if (!len) continue;
    if (chars + len > WHOLE_DOC_MAX_CHARS) { truncated = true; break; }
    chars += len;
    sources.push({
      n: sources.length + 1,
      chunk_id: c.id, document_id: doc.id,
      file_name: doc.file_name, display_name: doc.display_name || null,
      page_start: c.page_start, page_end: c.page_end, section_label: c.section_label,
      chunk_index: c.chunk_index,
      text: c.chunk_text
    });
  }

  let markdown = "";
  if (!sources.length) {
    try {
      const buf = await downloadObject(fastify.supabase, parsedPath(doc.namespace, doc.id));
      markdown = buf.toString("utf8").slice(0, WHOLE_DOC_MAX_CHARS);
    } catch { /* legacy or missing parsed text */ }
  }
  if (!overview && !sources.length && !markdown) return null;

  const grouped = groupSources(sources);

  const parts = [];
  parts.push(
    doc.display_name && doc.display_name !== doc.file_name
      ? `DOCUMENT FILE: ${doc.file_name} (titled "${doc.display_name}")`
      : `DOCUMENT FILE: ${doc.file_name}`
  );
  if (overview) parts.push(overview);
  if (grouped.length) {
    parts.push(`FULL TEXT OF "${doc.display_name || doc.file_name}" as numbered sources (one per page)${truncated ? " (truncated to the first part of the document)" : ""}:\n${buildNumberedContext(grouped)}`);
  } else if (markdown) {
    parts.push(`FULL TEXT OF "${doc.display_name || doc.file_name}" (markdown):\n${markdown}`);
  }
  return { context: parts.join("\n\n"), sources: grouped, fileName: doc.file_name, chars, truncated, hasSummary: Boolean(overview) };
}
const TIMEOUT_MS = 45000;
const RATE_LIMIT = 20;

const userBuckets = new Map();

// ----------------------------------------------------
function trimEphemeralContext(context = "") {

  if (!context) return "";

  if (context.length <= MAX_EPHEMERAL_CONTEXT) {
    return context;
  }

  return context.slice(0, MAX_EPHEMERAL_CONTEXT);
}

// ----------------------------------------------------
function trimRagContext(context = "") {

  if (!context) return "";

  if (context.length <= MAX_RAG_CONTEXT) {
    return context;
  }

  return context.slice(0, MAX_RAG_CONTEXT);
}

// ----------------------------------------------------
function checkRateLimit(userId) {

  const now = Date.now();
  const windowMs = 60000;

  if (!userBuckets.has(userId)) {
    userBuckets.set(userId, []);
  }

  const timestamps =
    userBuckets.get(userId).filter(
      ts => now - ts < windowMs
    );

  const allowed =
    timestamps.length < RATE_LIMIT;

  if (allowed) {
    timestamps.push(now);
  }

  userBuckets.set(userId, timestamps);

  return {
    allowed,
    remaining:
      Math.max(
        0,
        RATE_LIMIT - timestamps.length
      ),

    retryAfter:
      timestamps.length > 0
        ? Math.ceil(
            (
              windowMs -
              (now - timestamps[0])
            ) / 1000
          )
        : 0
  };
}

// ----------------------------------------------------
function withTimeout(promise, ms) {

  return Promise.race([

    promise,

    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("timeout")),
        ms
      )
    )
  ]);
}

// ----------------------------------------------------
function logEvent(fastify, data) {
  fastify.log.info(data);
}

// ----------------------------------------------------
function handleSimpleCases(input = "") {

  const text =
    input.toLowerCase().trim();

  if (
    text === "who are you" ||
    text === "who are you?"
  ) {

    return {
      finalAnswer:
        "Cortéx. KING’s Intelligence Engine."
    };
  }

  if (
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
      .test(input)
  ) {

    return {
      finalAnswer:
        "Email detected. No context."
    };
  }

  if (text.length <= 10) {

    return {
      finalAnswer: "No subject."
    };
  }

  return null;
}

// ----------------------------------------------------
function resolveUserMessageEntity(input = "") {

  const match =
    String(input || "")
      .match(
        /\b[A-Z][a-zA-Z'’-]+ [A-Z][a-zA-Z'’-]+\b/
      );

  if (match && match[0]) {
    return match[0].trim();
  }

  return null;
}

// ----------------------------------------------------
function resolveRequestedResumeToken(input = "") {

  const match =
    String(input || "").match(
      /\b([A-Za-z]+?)(?:['’]s|s)?\s+resume\b/i
    );

  if (!match || !match[1]) {
    return null;
  }

  const raw = match[1].trim();

  if (!raw) {
    return null;
  }

  return (
    raw.charAt(0).toUpperCase() +
    raw.slice(1).toLowerCase()
  );
}

// ----------------------------------------------------
function resolveFullNameFromContextByToken(
  context = "",
  token = ""
) {

  if (!context || !token) {
    return null;
  }

  const escapedToken =
    token.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const pattern =
    new RegExp(
      `\\b(${escapedToken}\\s+[A-Z][a-z]+)\\b`,
      "i"
    );

  const match =
    String(context || "").match(pattern);

  if (match && match[1]) {

    return match[1]
      .split(" ")
      .map(part =>
        part.charAt(0).toUpperCase() +
        part.slice(1).toLowerCase()
      )
      .join(" ")
      .trim();
  }

  return null;
}

// ----------------------------------------------------
// 🔥 v1.8.7 GENERALIZED RETRIEVAL ARBITRATION
// ----------------------------------------------------
function determineRetrievalPriority({
  intent = "",
  normalized = "",
  message = "",
  hasEphemeralContext = false
}) {

  // ------------------------------------------------
  // Evidence dependency indicators
  // ------------------------------------------------

  const evidenceIndicators = [
    "compare",
    "across",
    "uploaded",
    "documents",
    "materials",
    "artifacts",
    "summarize",
    "analyze",
    "assessment",
    "rank",
    "evaluate",
    "identify",
    "review",
    "synthesize",
    "analysis"
  ];

  // ------------------------------------------------
  // Inline synthesis indicators
  // ------------------------------------------------

  const synthesisIndicators = [
    "brainstorm",
    "rewrite",
    "refine",
    "polish",
    "draft",
    "improve",
    "generate",
    "ideas",
    "proposal",
    "communication"
  ];

  const evidenceDependency =
    evidenceIndicators.some(term =>
      normalized.includes(term)
    );

  const synthesisHeavy =
    synthesisIndicators.some(term =>
      normalized.includes(term)
    );

  const inlineContextRich =
    message.length >= 150;

  // ------------------------------------------------
  // Ephemeral/private context already sufficient
  // ------------------------------------------------

  if (hasEphemeralContext) {

    return evidenceDependency
      ? "LOW"
      : "NONE";
  }

  // ------------------------------------------------
  // Evidence-backed analytical reasoning
  // ------------------------------------------------

  if (
    evidenceDependency &&
    !synthesisHeavy
  ) {
    return "HIGH";
  }

  // ------------------------------------------------
  // General analytical workflows
  // ------------------------------------------------

  if (
    ["analysis", "lookup", "question"]
      .includes(intent)
  ) {

    return "MEDIUM";
  }

  // ------------------------------------------------
  // Rich inline drafting/synthesis workflows
  // ------------------------------------------------

  if (
    synthesisHeavy &&
    inlineContextRich
  ) {

    return "LOW";
  }

  return "LOW";
}

// ============================================================
// 🚀 ROUTE
// ============================================================

export default fp(async function chatRoute(fastify) {

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });

  // ------------------------------------------------------------
  // Shared pipeline. `sse` is null for the JSON route; for the
  // streaming route it carries emitters for sources/token/done/error.
  // ------------------------------------------------------------
  async function handleChat(req, reply, sse) {

      const respond = (status, payload) => {
        if (sse) {
          if (status >= 400 || payload?.error) sse.error(payload?.error || "Request failed", status);
          else sse.done(payload);
          return reply;
        }
        return status === 200 ? reply.send(payload) : reply.code(status).send(payload);
      };

      const start = Date.now();

      const identity = req.user;

      const userId =
        identity?.userId || "unknown";

      const namespace =
        identity?.namespace || "unknown";

      try {

        const {
          message = "",
          ephemeralContext = "",
          privateMode = false
        } = req.body || {};

        if (!message.trim()) {

          return respond(400, {
            error: "Message required"
          });
        }

        if (message.length > MAX_INPUT) {

          return respond(400, {
            error: "Input too large"
          });
        }

        const dlp =
          runDLPScan(message);

        if (dlp.block) {

          return respond(200, {
            error:
              "Sensitive data blocked"
          });
        }

        const sanitizedMessage =
          dlp.sanitized;

        const simple =
          handleSimpleCases(
            sanitizedMessage
          );

        if (simple) {
          return respond(200, simple);
        }

        const intent =
          decodeIntent(
            sanitizedMessage
          );

        const normalized =
          sanitizedMessage.toLowerCase();

        const tone =
          resolveToneForNamespace(
            namespace
          );

        const identityContext =
          applyIdentityLayer({
            userId,
            role: identity.role,
            namespace,
            tone
          });

        let ragContext = "";
        let wholeDocument = null;
        let retrievalSources = [];

        let normalizedMessage =
          sanitizedMessage;

        const requestedResumeToken =
          resolveRequestedResumeToken(
            sanitizedMessage
          );

        let resolvedName =
          resolveUserMessageEntity(
            sanitizedMessage
          );

        // ------------------------------------------------
        // 🔒 PRIVATE / EPHEMERAL CONTEXT
        // ------------------------------------------------

        const boundedEphemeralContext =
          trimEphemeralContext(
            ephemeralContext
          );

        const hasEphemeralContext =
          Boolean(
            boundedEphemeralContext.trim()
          );

        // ------------------------------------------------
        // 🔥 GENERALIZED RETRIEVAL ARBITRATION
        // ------------------------------------------------

        const retrievalPriority =
          determineRetrievalPriority({
            intent,
            normalized,
            message: sanitizedMessage,
            hasEphemeralContext
          });

        // ------------------------------------------------
        // PRIVATE MODE
        // ------------------------------------------------

        if (privateMode) {

          ragContext =
            boundedEphemeralContext;

        } else if (
          hasEphemeralContext &&
          retrievalPriority === "NONE"
        ) {

          ragContext =
            boundedEphemeralContext;

        } else if (
          retrievalPriority === "HIGH" ||
          retrievalPriority === "MEDIUM" ||
          retrievalPriority === "LOW"
        ) {

          const retrievalQuery =
            sanitizedMessage;

          const res =
            await fastify.inject({

              method: "POST",

              url: "/api/retrieve",

              payload: {
                query: retrievalQuery,
                namespace
              },

              headers: {
                authorization:
                  req.headers.authorization,
                ...(req.headers["x-retrieval-mode"]
                  ? { "x-retrieval-mode": req.headers["x-retrieval-mode"] }
                  : {})
              }
            });

          // A failed search must not look like "your documents don't mention this".
          if (res.statusCode !== 200) {
            fastify.log.error(
              { route: "/api/chat", retrieveStatus: res.statusCode, body: String(res.body || "").slice(0, 300) },
              "chat: retrieval failed"
            );
            return respond(502, {
              error: "Document search is unavailable right now. Please try again in a moment."
            });
          }
          let parsed = {};
          try { parsed = JSON.parse(res.body || "{}"); } catch { parsed = {}; }

          const results =
            Array.isArray(parsed.results)
              ? parsed.results
              : [];

          // ------------------------------------------------
          // 🔥 WHOLE-DOCUMENT OVERVIEW
          // One named document + an overview question → use the
          // stored summary and full text instead of a few chunks.
          // ------------------------------------------------
          const named = Array.isArray(parsed.namedDocuments) ? parsed.namedDocuments : [];
          if (named.length === 1 && isOverviewQuestion(sanitizedMessage)) {
            const whole = await buildWholeDocumentContext(fastify, named[0].id);
            if (whole) {
              wholeDocument = whole;
              fastify.log.info({
                route: "/api/chat",
                wholeDocument: whole.fileName,
                chars: whole.chars,
                truncated: whole.truncated,
                hasSummary: whole.hasSummary
              });
            }
          }

          const safeResults =
            results.filter(
              r =>
                r &&
                r.content &&
                r.content.trim()
            );

          if (
            safeResults.length === 1 &&
            retrievalPriority === "HIGH"
          ) {

            fastify.log.warn({
              route: "/api/chat",
              warning:
                "single ecosystem survivability",
              namespace,
              retrievalPriority
            });
          }

          // Reading order for the prompt: a list or table that spans chunks reads the way
          // it does on the page. Rank order is preserved in the retrieve API itself.
          // Documents in order of their best hit, chunks within a document in reading
          // order. The retrieval rank travels with each chunk so the budget can drop
          // the least relevant sources first.
          safeResults.forEach((r, i) => { r.rank = i; });
          const docKey = r => r.document_id || r.filename || "";
          const docBest = new Map();
          for (const r of safeResults) if (!docBest.has(docKey(r))) docBest.set(docKey(r), r.rank);
          const ordered = [...safeResults].sort((a, b) =>
            docKey(a) === docKey(b)
              ? (a.chunk_index ?? 0) - (b.chunk_index ?? 0)
              : docBest.get(docKey(a)) - docBest.get(docKey(b))
          );

          retrievalSources = groupSources(ordered.map((r, i) => ({
            n: i + 1,
            chunk_id: r.chunk_id || null,
            document_id: r.document_id || null,
            file_name: r.filename || null,
            display_name: r.display_name || null,
            page_start: r.page_start ?? null,
            page_end: r.page_end ?? null,
            section_label: r.section_label || null,
            chunk_index: r.chunk_index ?? null,
            rank: r.rank,
            text: r.content
          })));

          const fitted = fitSourcesToBudget(retrievalSources, MAX_RAG_CONTEXT);
          if (fitted.dropped) {
            fastify.log.info({ route: "/api/chat", droppedSources: fitted.dropped, chars: fitted.chars }, "chat: sources trimmed to budget");
          }
          retrievalSources = fitted.sources;

          const retrievalContext =
            buildNumberedContext(retrievalSources);

          if (
            hasEphemeralContext &&
            boundedEphemeralContext
          ) {

            ragContext =
              `${boundedEphemeralContext}\n\n${retrievalContext}`;

          } else {

            ragContext =
              retrievalContext;
          }
        }

        if (wholeDocument) {
          ragContext = hasEphemeralContext && boundedEphemeralContext
            ? `${boundedEphemeralContext}\n\n${wholeDocument.context}`
            : wholeDocument.context;
        } else if (!retrievalSources.length) {
          // attachment-only context; numbered sources are already budgeted whole
          ragContext =
            trimRagContext(
              ragContext
            );
        }

        // ------------------------------------------------
        // ENTITY RESOLUTION
        // ------------------------------------------------

        if (
          !resolvedName &&
          requestedResumeToken
        ) {

          resolvedName =
            resolveFullNameFromContextByToken(
              ragContext,
              requestedResumeToken
            );
        }

        if (resolvedName) {

          ragContext =
            `PRIMARY ENTITY: ${resolvedName}\n\n${ragContext}`;
        }

        // ------------------------------------------------
        // SYNTHESIS
        // ------------------------------------------------

        const activeSources = wholeDocument ? wholeDocument.sources : retrievalSources;
        if (sse) {
          sse.sources(activeSources.map(s => ({
            n: s.n, document_id: s.document_id, file_name: s.file_name, display_name: s.display_name,
            page_start: s.page_start, page_end: s.page_end, section_label: s.section_label
          })), wholeDocument ? "document" : privateMode ? "private" : "retrieval");
        }

        const rawAnswer =
          await withTimeout(

            synthesizeFinalAnswer({

              onToken: sse ? (t) => sse.token(t) : null,

              intent,

              userMessage:
                normalizedMessage,

              contextWindow:
                ragContext,

              model: openai,

              identityContext

            }),

            TIMEOUT_MS
          );

        // ------------------------------------------------
        // FORMATTER
        // ------------------------------------------------

        const formatterUserMessage =
          resolvedName
            ? `${normalizedMessage}\nPrimary Entity: ${resolvedName}`
            : normalizedMessage;

        const formattedAnswer =
          formatOutput(
            rawAnswer,
            {
              intent,

              userMessage:
                formatterUserMessage,

              hasContext:
                Boolean(
                  ragContext &&
                  ragContext.trim()
                ),

              privateMode,

              namespace,

              tone
            }
          );

        const cleaned =
          stripSensitiveFields(
            formattedAnswer
          );

        logEvent(fastify, {
          userId,
          namespace,
          retrievalPriority,
          retrievedChunks: activeSources.length,
          inputLength:
            message.length,
          contextLength:
            ragContext.length,
          outputLength:
            cleaned.length,
          latency:
            Date.now() - start
        });

        const knownNumbers = new Set(activeSources.map(s => s.n));
        const { answer: citedAnswer, citations } =
          extractCitations(
            limitCitations(normalizeCitationLists(cleaned, knownNumbers), MAX_CITATIONS_PER_SENTENCE, knownNumbers),
            activeSources
          );

        return respond(200, {
          finalAnswer: citedAnswer,
          citations,
          sources: activeSources.map(s => ({
            n: s.n, document_id: s.document_id, file_name: s.file_name, display_name: s.display_name,
            page_start: s.page_start, page_end: s.page_end, section_label: s.section_label
          })),
          mode: wholeDocument ? "document" : privateMode ? "private" : "retrieval"
        });

      } catch (err) {

        fastify.log.error({ err: err?.message }, "chat: pipeline failed");
        return respond(500, {
          error:
            "Temporary issue — please retry"
        });
      }
  }

  // ------------------------------------------------------------
  // JSON route (unchanged contract)
  // ------------------------------------------------------------
  fastify.post(
    "/api/chat",
    { preHandler: requireAuth() },
    (req, reply) => handleChat(req, reply, null)
  );

  // ------------------------------------------------------------
  // Streaming route: server-sent events
  // ------------------------------------------------------------
  fastify.post(
    "/api/chat/stream",
    { preHandler: requireAuth() },
    async (req, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": req.headers.origin || "*",
      });
      reply.hijack();

      let closed = false;
      req.raw.on("close", () => { closed = true; });
      const write = (event, data) => {
        if (closed) return;
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const end = () => { if (!closed) { closed = true; reply.raw.end(); } };

      const sse = {
        sources: (sources, mode) => write("sources", { sources, mode }),
        token: (text) => write("token", { text }),
        done: (payload) => { write("done", payload); end(); },
        error: (message, status) => { write("error", { error: message, status }); end(); },
      };

      // keep proxies from timing out a slow model call
      const heartbeat = setInterval(() => { if (!closed) reply.raw.write(": ping\n\n"); }, 15000);
      try {
        await handleChat(req, reply, sse);
      } catch (err) {
        sse.error("Temporary issue — please retry", 500);
      } finally {
        clearInterval(heartbeat);
        end();
      }
    }
  );
});
