#!/usr/bin/env node
// =============================================================
//  Backfill document profiles + embeddings (migration 0006)
//
//    node scripts/backfill-document-profiles.mjs [--namespace core] [--force] [--dry]
//
//  For every ready document without an embedding (or all, with --force):
//    1. reuse metadata.ingest.summary, or write one from the stored chunks
//       (legacy documents never had a summary);
//    2. build the profile text (title, type, purpose, sections, entities,
//       key facts) and embed it;
//    3. store profile_text, embedding, embedded_at, and the summary.
//  Safe to re-run. Uses the same .env as the server.
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { summarizeDocument, documentProfileText } from "../backend/ingest/summarize.js";
import { searchTitle } from "../backend/ingest/worker.js";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] || true; };
const NAMESPACE = opt("--namespace");
const FORCE = args.includes("--force");
const DRY = args.includes("--dry");
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const log = { info: (o, m) => console.log(m || "", JSON.stringify(o)), warn: (o, m) => console.warn(m || "", JSON.stringify(o)) };

let q = supabase.from("documents").select("id, namespace, file_name, display_name, status, page_count, metadata, embedded_at").eq("status", "ready").order("created_at");
if (NAMESPACE) q = q.eq("namespace", NAMESPACE);
const { data: docs, error } = await q;
if (error) { console.error("documents query failed:", error.message); process.exit(1); }

let done = 0, skipped = 0, failed = 0;
for (const doc of docs) {
  const tag = `${doc.namespace} · ${doc.display_name || doc.file_name}`;
  if (doc.embedded_at && !FORCE) { skipped++; continue; }

  const { data: chunks, error: cErr } = await supabase
    .from("document_chunks")
    .select("chunk_index, chunk_text, section_label, page_start")
    .eq("document_id", doc.id)
    .order("chunk_index", { ascending: true })
    .limit(2000);
  if (cErr) { console.error(`${tag}: chunks failed: ${cErr.message}`); failed++; continue; }
  if (!chunks?.length) { console.log(`${tag}: no chunks, skipped`); skipped++; continue; }

  try {
    let summary = doc.metadata?.ingest?.summary || null;
    if (!summary || FORCE) {
      const markdown = chunks
        .map((c) => `${c.section_label ? `## ${c.section_label}\n` : ""}${c.chunk_text}`)
        .join("\n\n");
      summary = await summarizeDocument({
        openai,
        fileName: doc.file_name,
        markdown,
        chunks: chunks.map((c) => ({ text: c.chunk_text, section_label: c.section_label, page_start: c.page_start })),
        pageCount: doc.page_count,
        log,
      });
    }
    const profileText = documentProfileText({
      title: searchTitle(doc),
      summary,
      sectionLabels: chunks.map((c) => c.section_label).filter(Boolean),
    });
    if (DRY) { console.log(`${tag}:\n${profileText}\n`); done++; continue; }

    const res = await openai.embeddings.create({ model: EMBED_MODEL, input: profileText });
    const embedding = res.data[0].embedding;
    const patch = {
      profile_text: profileText,
      embedding,
      embedded_at: new Date().toISOString(),
      metadata: { ...(doc.metadata || {}), ingest: { ...(doc.metadata?.ingest || {}), summary } },
    };
    const { error: uErr } = await supabase.from("documents").update(patch).eq("id", doc.id);
    if (uErr) throw new Error(uErr.message);
    console.log(`${tag}: ok (${profileText.length} chars${doc.metadata?.ingest?.summary ? "" : ", summary written"})`);
    done++;
  } catch (err) {
    console.error(`${tag}: FAILED ${err?.message || err}`);
    failed++;
  }
}
console.log(`\ndone=${done} skipped=${skipped} failed=${failed}`);
