// ============================================================
//  CORTÉX — CHAT ENGINE
//  v1.8.7 SURVIVABILITY ORCHESTRATION HARDENING
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { requireAuth } from "../lib/authMiddleware.js";
import { identityFrom, requireNamespaceMember, hasPermission } from "../lib/permissions.js";

// 🧠 Memory, layer 1: saved conversations (design doc 5.4, hooks H1/H2/H5)
import { effectiveSettings } from "../memory/settings.js";
import { getOrCreateConversation, appendMessage, titleFrom, isUuid } from "../memory/conversations.js";
// 🧠 Memory, layer 1 continued: the thread window in the prompt (design doc 5.5, hook H3)
import { loadWindow, maybeSummarize } from "../memory/window.js";
// 🧠 Memory, layer 2: durable memories (design doc 5.6, 5.7, hooks H3/H4/H5)
import { recallMemories } from "../memory/recall.js";
import { saveMemory, touchMemories, enforceUserCap } from "../memory/store.js";
// 🧠 Memory, layer 2 continued: automatic extraction (design doc 5.7, hook H6)
import { extractMemories, relateToExisting } from "../memory/extract.js";
import { finishTrace, recordTurnUsage } from "../retrieval/trace.js";
import { newUsage, recordUsage, usageSummary } from "../lib/usage.js";
import { randomUUID } from "node:crypto";

// 🔒 DLP
import { runDLPScan, stripSensitiveFields } from "../lib/dlp.js";

// 🔥 Step 46 Reasoning Modules
import { classifyIntent, intentLabel } from "../reasoning/intent.js";
import { synthesizeFinalAnswer, extractConflicts } from "../reasoning/synthesis.js";
import { formatOutput } from "../reasoning/outputFormatter.js";

// 🔥 Step 47 Identity Layer
// Persona / PCL (section 4.4): which persona applies, its newest rules,
// and the user's own style and note, resolved once per turn and
// rendered into the prompt. Never throws; the built-in default with a
// reason when anything is unavailable.
import { resolvePcl } from "../pcl/resolve.js";

// 🔥 Whole-document overview path
import { downloadObject, parsedPathFor } from "../ingest/storage.js";
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
    .select("id, file_name, display_name, namespace_id, storage_path, page_count, status, metadata")
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
      const buf = await downloadObject(fastify.supabase, parsedPathFor(doc));
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

// ------------------------------------------------
// Knowledge-base mode: the whole workspace at a glance. One numbered
// source per ready document, built from the profile written at ingest
// (title, purpose, sections, key facts). A document with no profile
// yet contributes its opening text instead. Sized to the same budget
// as retrieval, so a brief across the collection cites every document.
// ------------------------------------------------
const KB_DOC_MIN_CHARS = 500;
const KB_DOC_MAX_CHARS = 2500;

async function buildKnowledgeBaseContext(fastify, namespaceId) {
  const { data: docs, error } = await fastify.supabase
    .from("documents")
    .select("id, file_name, display_name, document_type, description, page_count, created_at, profile_text, metadata")
    .eq("namespace_id", namespaceId)
    .eq("status", "ready")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`knowledge base: documents lookup failed: ${error.message}`);
  if (!docs?.length) return null;

  // opening text for documents that predate profiles
  const missing = docs.filter(d => !(d.profile_text || "").trim()).map(d => d.id);
  const opening = new Map();
  if (missing.length) {
    const { data: chunks } = await fastify.supabase
      .from("document_chunks")
      .select("document_id, chunk_index, chunk_text")
      .in("document_id", missing)
      .lte("chunk_index", 2)
      .order("chunk_index", { ascending: true });
    for (const c of chunks || []) {
      opening.set(c.document_id, `${opening.get(c.document_id) || ""}${c.chunk_text}\n`);
    }
  }

  const perDoc = Math.max(KB_DOC_MIN_CHARS, Math.min(KB_DOC_MAX_CHARS, Math.floor(MAX_RAG_CONTEXT / docs.length)));
  const sources = docs.map((d, i) => {
    const head = [
      d.document_type ? `Type: ${d.document_type}` : null,
      d.description ? `Description: ${d.description}` : null,
      d.page_count ? `Pages: ${d.page_count}` : null,
      `Added: ${String(d.created_at || "").slice(0, 10)}`
    ].filter(Boolean).join(" · ");
    const body = (d.profile_text || "").trim() || stripSourceHeader(opening.get(d.id) || "").trim() || "(no text available)";
    const text = `${head}\n${body}`.slice(0, perDoc);
    return {
      n: i + 1,
      chunk_id: null, document_id: d.id,
      file_name: d.file_name, display_name: d.display_name || null,
      page_start: null, page_end: null, section_label: "Document overview",
      chunk_ids: [], chunks: [{ chunk_id: null, chunk_index: 0, section_label: null, text }],
      rank: i, text
    };
  });

  const chars = sources.reduce((a, s) => a + s.text.length, 0);
  const context =
    `KNOWLEDGE BASE OVERVIEW: ${docs.length} document${docs.length === 1 ? "" : "s"} in this workspace. ` +
    `Each numbered source below is one document's overview (its purpose, structure and key facts), not its full text. ` +
    `Cite documents by number as usual.\n\n${buildNumberedContext(sources)}`;
  return { context, sources, fileName: null, chars, truncated: false, hasSummary: true, mode: "knowledge_base", count: docs.length };
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
function handleSimpleCases(input = "", { hasHistory = false } = {}) {

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

  // a very short message with no thread behind it has nothing to go on;
  // inside a conversation, "why?" or "and the other?" is a real follow-up
  if (text.length <= 10 && !hasHistory) {

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
// Priority straight from the intent module. Returns null when the intent
// came from the rules fallback, so the keyword lists below still decide.
function priorityFromIntent(intent, hasEphemeralContext) {
  if (!intent || typeof intent !== "object" || intent.source !== "model") return null;
  if (intent.literal) return "NONE";
  switch (intent.scope) {
    case "knowledge_base":
    case "document":
    case "documents":
      return "HIGH";
    case "attached":
      return intent.needsEvidence ? "LOW" : "NONE";
    case "none":
      return "NONE";
    default: { // topic
      if (intent.needsEvidence) {
        return ["question", "lookup", "summary", "analysis", "compare"].includes(intent.type) ? "HIGH" : "MEDIUM";
      }
      return hasEphemeralContext ? "NONE" : "LOW";
    }
  }
}

function determineRetrievalPriority({
  intent = "",
  normalized = "",
  message = "",
  hasEphemeralContext = false
}) {

  const fromIntent = priorityFromIntent(intent, hasEphemeralContext);
  if (fromIntent) return fromIntent;
  const intentType = intentLabel(intent);

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
      .includes(intentType)
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

      const identity = identityFrom(req);

      // Every model call this turn makes adds itself here (P4.4: cost per
      // turn). The synchronous part goes back with the answer; the whole
      // thing, with extraction and the summariser, goes on the trace row.
      const usage = newUsage();

      // One trace row per turn (design doc 5.11): retrieval writes it
      // under this id and the answer completes it below.
      const traceId = randomUUID();
      let hadRetrieval = false;

      const userId =
        identity.userId || "unknown";

      // namespaceId is the key (retrieval, storage); namespace is the
      // display name, used only for tone routing and logs.
      const namespaceId = identity.namespaceId;

      const namespace =
        identity.namespace || "unknown";

      try {

        const {
          message = "",
          ephemeralContext = "",
          privateMode = false,
          conversationId: requestedConversationId = null
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

        // ------------------------------------------------
        // 🧠 H1 — permission and conversation
        // Memory is off unless the namespace allows it and the role has
        // memory_read. Private mode saves nothing and reads nothing.
        // Any failure here means today's stateless chat, never an error.
        // ------------------------------------------------
        const memory = { enabled: false, conversation: null, created: false, settings: null };
        if (!privateMode && hasPermission(identity, "memory_read")) {
          try {
            const settings = await effectiveSettings(fastify.supabase, namespaceId, fastify.log);
            if (settings.memory_enabled) {
              const wanted = isUuid(requestedConversationId) ? requestedConversationId : null;
              const { conversation, created } = await getOrCreateConversation(
                fastify.supabase, identity, wanted, { title: titleFrom(message) }
              );
              Object.assign(memory, {
                enabled: true, conversation, created, settings,
                hasHistory: !created && (conversation.message_count || 0) > 0
              });
              if (sse) sse.conversation(conversation.id, created);
            }
          } catch (err) {
            fastify.log.warn({ err: err?.message }, "chat: conversation unavailable, continuing stateless");
          }
        }

        // Save one turn. A failure logs, switches memory off for the rest
        // of this request, and never reaches the caller.
        const saveTurn = async (role, content, extras = {}) => {
          if (!memory.enabled || !memory.conversation) return null;
          try {
            return await appendMessage(fastify.supabase, identity, memory.conversation.id, { role, content, ...extras });
          } catch (err) {
            fastify.log.warn({ err: err?.message, conversationId: memory.conversation.id }, "chat: message save failed");
            memory.enabled = false;
            return null;
          }
        };

        // What every response carries back: the thread id, or nothing in private mode.
        const withConversation = (payload) =>
          memory.conversation ? { ...payload, conversationId: memory.conversation.id } : payload;

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

        // 🧠 H2 — the user's message, scanned version, before the quick-reply check
        const savedUser = await saveTurn("user", sanitizedMessage);

        // 🧠 H3 (history part) — start loading the thread window now; it is
        // awaited before retrieval so the trace can record how much history
        // the turn had. Failure means an empty window, never an error.
        const threadPromise =
          memory.enabled && memory.hasHistory && memory.settings?.history_enabled
            ? loadWindow(fastify.supabase, identity, memory.conversation.id, memory.settings, { beforeSeq: savedUser?.seq ?? Infinity })
                .catch(err => { fastify.log.warn({ err: err?.message }, "chat: thread window unavailable"); return null; })
            : Promise.resolve(null);

        const simple =
          handleSimpleCases(
            sanitizedMessage,
            { hasHistory: Boolean(memory.hasHistory) }
          );

        if (simple) {
          // quick replies are saved too, so the thread reads correctly later
          await saveTurn("assistant", simple.finalAnswer || simple.message || "", { mode: "simple" });
          return respond(200, withConversation(simple));
        }

        // The thread window is needed now: the intent module reads the
        // previous exchange to resolve references in a follow-up.
        const thread = await threadPromise;

        // One classification for the whole turn: what is wanted, from what
        // material, and the message rewritten to stand alone. The scope
        // selects the answer mode below; the standalone form drives retrieval.
        const intent =
          await classifyIntent(sanitizedMessage, {
            openai,
            hasAttachment: Boolean(String(ephemeralContext || "").trim()),
            context: thread?.context || null,
            log: fastify.log
          });
        if (intent.usage) recordUsage(usage, "intent", intent.usage.model, intent.usage);

        // ------------------------------------------------
        // 🧠 "Remember that …" (design doc 5.7, P3.5). The intent module
        // extracted the note to keep; save it by hand with importance 4
        // and confirm. Nothing else runs for this turn.
        // ------------------------------------------------
        if (intent.type === "remember" && intent.rememberContent) {
          let reply;
          let memorySaved = null;
          if (privateMode) {
            reply = "Private mode is on, so nothing is saved. Turn it off if you want me to keep that.";
          } else if (!memory.enabled) {
            reply = "Memory is off in this workspace, so I can't keep that for later.";
          } else if (!hasPermission(identity, "memory_write")) {
            reply = "Your role can't save memories here, so I can't keep that.";
          } else {
            try {
              // A correction ("our liaison is now Y") replaces the note it
              // corrects even when the wording is too different for the
              // near-duplicate rule to notice (P4.4 forget-and-correct).
              const relation = await relateToExisting(fastify.supabase, openai, identity, {
                content: intent.rememberContent, settings: memory.settings, usage, log: fastify.log
              });
              const { memory: saved, action, counterpart, attested } = await saveMemory(fastify.supabase, openai, identity, {
                content: intent.rememberContent,
                kind: intent.rememberKind || "note",
                scope: "user",
                importance: 4,
                sourceType: "user_explicit",
                sourceConversationId: memory.conversation?.id || null,
                sourceMessageId: savedUser?.id || null,
                relation: relation.relation,
                targetId: relation.targetId,
                embedding: relation.embedding,
              }, { settings: memory.settings, usage, log: fastify.log });
              if (action === "blocked") {
                reply = "I can't keep that: it looks like it contains sensitive data.";
              } else {
                memorySaved = { id: saved.id, content: saved.content, kind: saved.kind, scope: saved.scope, action, truth_status: saved.truth_status, counterpart: counterpart || null };
                // Design doc 9.5: the reply says what the write did, including
                // the outcome of a vote against a note from someone else.
                reply =
                  action === "duplicate" ? (attested ? `I already have that noted, and this conversation now backs it too: "${saved.content}"` : `I already have that noted: "${saved.content}"`) :
                  action === "superseded" ? `Updated what I had. I'll remember: "${saved.content}"` :
                  action === "accepted" ? `Noted. I'll remember: "${saved.content}". It outweighs an earlier note here ("${counterpart?.content}"), which is now set aside.` :
                  action === "denied" ? `Noted, but an earlier note here carries more weight: "${counterpart?.content}". I'll go by that one and keep yours on record as a dissent.` :
                  action === "contested" ? `Noted. That disagrees with another note here ("${counterpart?.content}"), and neither outweighs the other, so I'll show both sides until someone resolves it.` :
                  action === "retracted" ? `Understood. I've retracted: "${saved.content}"` :
                  `Noted. I'll remember: "${saved.content}"`;
                // P4.3: over the per-user cap, the least-used memories are archived.
                if (!["duplicate", "retracted", "denial_recorded"].includes(action)) {
                  enforceUserCap(fastify.supabase, identity, memory.settings?.max_active_per_user, { log: fastify.log }).catch(() => {});
                }
              }
            } catch (err) {
              fastify.log.warn({ err: err?.message }, "chat: remember failed");
              reply = err?.statusCode ? err.message : "I couldn't save that just now. Please try again.";
            }
          }
          await saveTurn("assistant", reply, { mode: "memory", memoryIds: memorySaved ? [memorySaved.id] : null });
          const rememberTrace = finishTrace(fastify.supabase, fastify.log, {
            traceId, hadRetrieval: false,
            query: sanitizedMessage, namespaceId, userId: identity.userId,
            conversationId: memory.conversation?.id || null, historyTurns: thread?.turns ?? 0,
            memoryIds: memorySaved ? [memorySaved.id] : [], memoryBlockTokens: 0, answerMode: "memory", conflicts: null,
            latencyMs: Date.now() - start
          });
          const rememberUsage = usageSummary(usage);
          rememberTrace.then(() => recordTurnUsage(fastify.supabase, fastify.log, { traceId, usage: rememberUsage, extractedMemoryIds: [] })).catch(() => {});
          if (sse) sse.sources([], "memory");
          return respond(200, withConversation({
            finalAnswer: reply,
            citations: [],
            sources: [],
            mode: "memory",
            memorySaved,
            memoriesUsed: [],
            traceId,
            usage: rememberUsage,
            intent: { type: intent.type, scope: intent.scope, maturity: intent.maturity, source: intent.source }
          }));
        }

        // ------------------------------------------------
        // 🧠 H3 (recall part) — what do we already know that bears on
        // this message. Runs alongside retrieval; awaited before the
        // prompt is built. Skipped for literal and rewrite turns (E5.4).
        // Failure means no memory block, never an error.
        // ------------------------------------------------
        const recallPromise =
          memory.enabled && memory.settings?.recall_enabled && !["literal", "rewrite"].includes(intent.type)
            ? recallMemories(fastify.supabase, openai, identity, {
                message: intent.standaloneQuery || sanitizedMessage,
                previousUserMessage: thread?.context?.lastUser || null,
                settings: memory.settings,
                usage,
                log: fastify.log
              }).catch(err => { fastify.log.warn({ err: err?.message }, "chat: memory recall unavailable"); return null; })
            : Promise.resolve(null);

        const normalized =
          sanitizedMessage.toLowerCase();

        // Persona / PCL, resolved beside recall and retrieval from the
        // already-authorized identity (plan section 7). Nothing in the
        // request body picks a persona or a style.
        const pclPromise =
          resolvePcl(fastify.supabase, identity, { log: fastify.log });

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

        } else if (intent.scope === "knowledge_base") {

          // ------------------------------------------------
          // 🔥 KNOWLEDGE-BASE MODE
          // The intent says the answer should draw on the whole
          // collection, so every ready document contributes its
          // overview instead of a similarity search picking a few.
          // ------------------------------------------------
          try {
            const kb = await buildKnowledgeBaseContext(fastify, namespaceId);
            if (kb) {
              wholeDocument = kb;
              fastify.log.info({ route: "/api/chat", knowledgeBase: kb.count, chars: kb.chars }, "chat: knowledge-base mode");
            }
          } catch (err) {
            fastify.log.warn({ err: err?.message }, "chat: knowledge-base mode failed; answering without it");
          }

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

          // the standalone form of a follow-up ("its key points" → "the
          // Operations Playbook's key points") is what retrieval can find
          const retrievalQuery =
            intent.standaloneQuery || sanitizedMessage;
          if (retrievalQuery !== sanitizedMessage) {
            // lengths only: server logs carry no chat text (retention plan section 4)
            fastify.log.info({ route: "/api/chat", fromChars: sanitizedMessage.length, toChars: retrievalQuery.length }, "chat: follow-up rewritten for retrieval");
          }

          const res =
            await fastify.inject({

              method: "POST",

              url: "/api/retrieve",

              payload: {
                query: retrievalQuery,
                namespaceId,
                conversationId: memory.conversation?.id || null,
                historyTurns: thread?.turns ?? 0,
                traceId
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
          hadRetrieval = true;   // retrieval wrote the trace row under traceId
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
          // the intent says "this one document as a whole"; the phrase test only
          // stands in when the rules fallback classified the message
          const wantsWholeDocument =
            intent.source === "model" ? intent.scope === "document" : isOverviewQuestion(sanitizedMessage);
          if (named.length === 1 && wantsWholeDocument) {
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
        const answerMode = wholeDocument ? (wholeDocument.mode || "document") : privateMode ? "private" : "retrieval";

        // 🧠 H3 (recall part) resolves here: the memory block for the prompt.
        const recall = await recallPromise;

        // Persona / PCL resolves here. `pcl` is the rendered persona text
        // plus the user's note and length, or null for the built-in
        // default (synthesis.js, plan 8.2).
        const resolved = await pclPromise;
        const identityContext = { userId, role: identity.role, namespace, personaId: resolved.persona?.id || null };
        const pcl = resolved.rendered;
        const pclInfo = resolved.provenance;

        if (sse) {
          sse.sources(activeSources.map(s => ({
            n: s.n, document_id: s.document_id, file_name: s.file_name, display_name: s.display_name,
            page_start: s.page_start, page_end: s.page_end, section_label: s.section_label
          })), answerMode);
        }

        const rawAnswer =
          await withTimeout(

            synthesizeFinalAnswer({

              onToken: sse ? (t) => sse.token(t) : null,

              intent: intentLabel(intent),

              userMessage:
                normalizedMessage,

              // 🧠 H4 (history part): earlier turns as real chat turns, the
              // running summary as a note. Both empty when memory is off.
              priorMessages: thread?.messages || [],
              conversationSummary: thread?.summary?.text || null,

              // 🧠 H4 (memory part): the MEMORY block, under its own heading
              // in the system prompt, away from the document context.
              memoryBlock: recall?.block || null,

              contextWindow:
                ragContext,

              model: openai,

              identityContext,

              // PCL Phase 0: the user's personalization note, or null for
              // the default prompt.
              pcl,

              usage

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

        // E1.7: lift the model's "conflicts noticed" note out for the trace
        const { answer: rawAnswerText, conflicts } = extractConflicts(rawAnswer);

        const formattedAnswer =
          formatOutput(
            rawAnswerText,
            {
              intent: intentLabel(intent),

              userMessage:
                formatterUserMessage,

              hasContext:
                Boolean(
                  ragContext &&
                  ragContext.trim()
                ),

              privateMode,

              namespace
            }
          );

        const cleaned =
          stripSensitiveFields(
            formattedAnswer
          );

        logEvent(fastify, {
          userId,
          namespaceId,
          namespace,
          intent: intent.type,
          scope: intent.scope,
          intentSource: intent.source,
          mode: answerMode,
          historyTurns: thread?.turns ?? 0,
          historyTokens: thread?.tokens ?? 0,
          hasSummary: Boolean(thread?.summary),
          memoriesUsed: recall?.memories?.length ?? 0,
          memoryBlockTokens: recall?.tokens ?? 0,
          personaKey: pclInfo.persona_key,
          personaSource: pclInfo.persona_source,
          pclVersion: pclInfo.version,
          answerLength: pclInfo.length,
          answerLengthSource: pclInfo.length_source,
          personalizationChars: pclInfo.personalization_chars,
          pclSource: pclInfo.source,
          pclReason: pclInfo.reason,
          conflicts: conflicts.length,
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

        const publicSources = activeSources.map(s => ({
          n: s.n, document_id: s.document_id, file_name: s.file_name, display_name: s.display_name,
          page_start: s.page_start, page_end: s.page_end, section_label: s.section_label
        }));
        const mode = answerMode;

        // 🧠 H5 — the answer, with its mode, citations, sources and the ids
        // of the memories used, so a reloaded thread looks exactly like the
        // live one and "why did it say that" has a link.
        const memoryIds = recall?.memoryIds || [];
        const savedAssistant = await saveTurn("assistant", citedAnswer, { mode, citations, sources: publicSources, memoryIds: memoryIds.length ? memoryIds : null });

        // The memories the answer used: bump their counters and log the recall.
        if (memoryIds.length && memory.enabled) {
          touchMemories(fastify.supabase, identity, memoryIds, {
            conversationId: memory.conversation?.id || null, messageId: savedAssistant?.id || null, log: fastify.log
          }).catch(() => {});
        }

        // Complete the turn's trace row: memories, block size, mode, conflicts.
        const tracePromise = finishTrace(fastify.supabase, fastify.log, {
          traceId, hadRetrieval,
          query: intent.standaloneQuery || sanitizedMessage, namespaceId, userId: identity.userId,
          conversationId: memory.conversation?.id || null, historyTurns: thread?.turns ?? 0,
          memoryIds, memoryBlockTokens: recall?.tokens ?? 0, answerMode: mode, conflicts: conflicts.length ? conflicts : null,
          pcl: pclInfo,
          latencyMs: Date.now() - start
        });

        // ------------------------------------------------
        // 🧠 H6 — look for new memories, after the response (design doc
        // 5.7, P4.2). Runs once the answer is on its way, so it never
        // slows the reply and never throws into the request. Only where
        // the namespace allows it and the role may write; never in
        // private mode (memory is off there) and not for literal or
        // rewrite turns, which carry nothing about the user. The
        // summariser and the trace's usage record run in the same pass.
        // ------------------------------------------------
        const extractionScheduled = Boolean(
          memory.enabled && memory.settings?.extract_enabled &&
          hasPermission(identity, "memory_write") &&
          !["literal", "rewrite"].includes(intent.type)
        );
        const afterReply = async () => {
          let extracted = null;
          if (extractionScheduled) {
            extracted = await extractMemories(fastify.supabase, openai, identity, {
              question: intent.standaloneQuery || sanitizedMessage,
              originalMessage: sanitizedMessage,
              answer: citedAnswer,
              relatedMemories: recall?.memories || [],
              conversationId: memory.conversation?.id || null,
              messageId: savedAssistant?.id || null,
              settings: memory.settings,
              usage,
              log: fastify.log
            }).catch(err => { fastify.log.warn({ err: err?.message }, "chat: extraction failed"); return null; });
          }
          // Fold older turns into the running summary once the thread has
          // grown past the trigger.
          if (memory.enabled && memory.conversation) {
            await maybeSummarize(fastify.supabase, openai, identity, memory.conversation.id, memory.settings, fastify.log, { usage }).catch(() => {});
          }
          await tracePromise.catch(() => {});
          // The trace says what extraction did, including when it was
          // skipped, so "nothing extracted" is distinguishable from "not yet".
          const extraction = extractionScheduled
            ? { ran: Boolean(extracted?.ran), reason: extracted?.reason || null, saved: extracted?.saved?.length || 0, dropped: extracted?.dropped?.length || 0 }
            : { ran: false, reason: "not scheduled", saved: 0, dropped: 0 };
          await recordTurnUsage(fastify.supabase, fastify.log, {
            traceId, usage: usageSummary(usage, { extraction }), extractedMemoryIds: (extracted?.saved || []).map(s => s.id)
          });
        };
        setImmediate(() => afterReply().catch(err => fastify.log.warn({ err: err?.message }, "chat: after-reply hooks failed")));

        return respond(200, withConversation({
          finalAnswer: citedAnswer,
          citations,
          sources: publicSources,
          mode,
          memoriesUsed: (recall?.memories || []).map(m => ({ id: m.id, kind: m.kind, scope: m.scope, content: m.content, truth_status: m.truth_status || "accepted", counterpart_id: m.counterpart_id || null })),
          traceId,
          usage: usageSummary(usage, { pending: extractionScheduled ? ["extraction"] : [] }),
          intent: { type: intent.type, scope: intent.scope, maturity: intent.maturity, source: intent.source },
          // PCL Phase 0: which style and note shaped this answer.
          pcl: pclInfo
        }));

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
    { preHandler: [requireAuth(), requireNamespaceMember(fastify)] },
    (req, reply) => handleChat(req, reply, null)
  );

  // ------------------------------------------------------------
  // Streaming route: server-sent events
  // ------------------------------------------------------------
  fastify.post(
    "/api/chat/stream",
    { preHandler: [requireAuth(), requireNamespaceMember(fastify)] },
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
        // the thread id goes out first, so the client can store it before any token
        conversation: (conversationId, created) => write("conversation", { conversationId, created: Boolean(created) }),
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
