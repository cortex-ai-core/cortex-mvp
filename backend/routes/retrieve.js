// ============================================================
//  CORTÉX — RAG RETRIEVE ROUTE
//  v1.8.10
//  CONTROLLED SURVIVABILITY EXPANSION
// ============================================================

import fp from "fastify-plugin";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/authMiddleware.js";
import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";
import { hybridRetrieve } from "../retrieval/hybrid.js";
import { resolveRetrievalMode, logRetrievalTrace } from "../retrieval/trace.js";

// ============================================================
// 🔐 PERMISSIONS — shared map in lib/permissions.js
// ============================================================

// ============================================================
// 🔥 BASE RETRIEVAL CONTROL
// ============================================================

const BASE_SIMILARITY_THRESHOLD = 0.22;
const BASE_TOP_K = 6;
const BASE_CONTEXT_CHARS = 10000;
const MAX_RESULTS_PER_FILE = 3;

// ============================================================
// 🔥 SCALABILITY GUARDS
// ============================================================

const MAX_RELATIONSHIP_RESULTS = 15;
const MAX_CONTEXT_BUDGET = 16000;

// ============================================================
// 🔥 EMBEDDING CACHE
// ============================================================

const EMBEDDING_CACHE = new Map();
const MAX_EMBEDDING_CACHE_SIZE = 250;

function getCachedEmbedding(query) {
  return EMBEDDING_CACHE.get(query);
}

function setCachedEmbedding(query, embedding) {

  if (EMBEDDING_CACHE.size >= MAX_EMBEDDING_CACHE_SIZE) {

    const firstKey =
      EMBEDDING_CACHE.keys().next().value;

    EMBEDDING_CACHE.delete(firstKey);
  }

  EMBEDDING_CACHE.set(query, embedding);
}

// ============================================================
// 🔧 QUERY NORMALIZATION
// ============================================================

const TYPO_MAP = {
  hosptial: "hospital",
  sumarize: "summarize",
  incdidnet: "incident",
  incdient: "incident",
  resum: "resume",
  canddate: "candidate"
};

function normalizeRetrievalQuery(text = "") {

  let cleaned = text.toLowerCase().trim();

  cleaned = cleaned.replace(/[^\w\s]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ");

  const words = cleaned.split(" ").map(word => {
    return TYPO_MAP[word] || word;
  });

  return words.join(" ");
}

// ============================================================
// 🔧 STOPWORDS
// ============================================================

const STOPWORDS = new Set([
  "the",
  "and",
  "all",
  "from",
  "with",
  "uploaded",
  "supporting",
  "evidence",
  "notes",
  "document",
  "documents",
  "file",
  "files",
  "summarize",
  "analyze",
  "provide",
  "identify",
  "determine",
  "available",
  "materials"
]);

// ============================================================
// 🔧 QUERY INTELLIGENCE
// ============================================================

function determineQueryProfile(query = "") {

  const lower = query.toLowerCase();

  const abstractSignals = [
    "strategy",
    "governance",
    "leadership",
    "system",
    "systems",
    "risk",
    "architecture",
    "executive",
    "organizational",
    "operational",
    "analysis",
    "synthesis"
  ];

  let abstractMatches = 0;

  for (const signal of abstractSignals) {
    if (lower.includes(signal)) {
      abstractMatches++;
    }
  }

  if (abstractMatches >= 4) {
    return {
      type: "abstract",
      topK: 10,
      matchCount: 20,
      similarityThreshold: 0.18,
      contextBudget: 16000
    };
  }

  if (abstractMatches >= 2) {
    return {
      type: "analytical",
      topK: 8,
      matchCount: 16,
      similarityThreshold: 0.20,
      contextBudget: 14000
    };
  }

  return {
    type: "direct",
    topK: BASE_TOP_K,
    matchCount: 8,
    similarityThreshold: BASE_SIMILARITY_THRESHOLD,
    contextBudget: BASE_CONTEXT_CHARS
  };
}

// ============================================================
// 🔧 SEMANTIC HELPERS
// ============================================================

function contentFingerprint(text = "") {

  const cleaned =
    text
      .toLowerCase()
      .replace(/\s+/g, " ");

  const start =
    cleaned.slice(0, 120);

  const middle =
    cleaned.slice(
      Math.floor(cleaned.length / 2),
      Math.floor(cleaned.length / 2) + 120
    );

  const end =
    cleaned.slice(-120);

  return `${start}|${middle}|${end}`;
}

function generateSyntheticEcosystemId(text = "") {

  const fingerprint =
    contentFingerprint(text);

  const hash =
    fingerprint
      .split("")
      .reduce(
        (acc, char) =>
          acc + char.charCodeAt(0),
        0
      );

  return `ecosystem_${Math.abs(hash)}`;
}

function countTermMatches(content = "", terms = []) {

  const lower = content.toLowerCase();

  let count = 0;

  for (const term of terms) {
    if (lower.includes(term)) count++;
  }

  return count;
}

function calculateSemanticDensity(content = "") {

  const words = content
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const uniqueWords = new Set(words);

  if (!words.length) return 0;

  return uniqueWords.size / words.length;
}

// ============================================================
// 🔥 RETRIEVAL PRESSURE MODEL
// ============================================================

function calculateRetrievalPressure(results = []) {

  if (!results.length) {
    return {
      pressure: 0,
      highPressure: false
    };
  }

  const uniqueFiles =
    new Set(results.map(r => r.filename)).size;

  const averageSimilarity =
    results.reduce(
      (sum, r) => sum + (r.similarity || 0),
      0
    ) / results.length;

  const pressure =
    (
      (results.length * 0.45) +
      (uniqueFiles * 0.35) +
      (averageSimilarity * 10)
    );

  return {
    pressure,
    highPressure: pressure >= 12
  };
}

// ============================================================
// 🔥 ECOSYSTEM SURVIVABILITY
// ============================================================

function applyEcosystemContextAllocation(
  results = [],
  contextBudget = 10000,
  maxRounds = 3
) {

  if (!results.length) return results;

  const ecosystems = {};

  for (const result of results) {

    if (!ecosystems[result.filename]) {
      ecosystems[result.filename] = [];
    }

    ecosystems[result.filename].push(result);
  }

  const sortedEcosystems =
    Object.values(ecosystems)
      .sort((a, b) => {

        const aScore =
          a.reduce(
            (sum, r) => sum + r.finalScore,
            0
          );

        const bScore =
          b.reduce(
            (sum, r) => sum + r.finalScore,
            0
          );

        return bScore - aScore;
      });

  const surviving = [];
  const includedFingerprints = new Set();

  let totalChars = 0;

  // ==========================================================
  // 🔥 PASS 1 — DIVERSITY FLOOR
  // ==========================================================

  for (const ecosystem of sortedEcosystems) {

    const candidate = ecosystem[0];

    if (!candidate) continue;

    const fingerprint =
      contentFingerprint(candidate.content);

    if (includedFingerprints.has(fingerprint)) {
      continue;
    }

    if (
      totalChars + candidate.content.length >
      contextBudget
    ) {
      continue;
    }

    surviving.push(candidate);

    includedFingerprints.add(fingerprint);

    totalChars += candidate.content.length;
  }

  // ==========================================================
  // 🔥 PASS 2 — CONTROLLED SATURATION EXPANSION
  // ==========================================================

  // Each round adds one more chunk per file. With a named document there is
  // one file, so the round limit is the per-document limit; raise it.
  const MAX_ROUNDS = maxRounds;

  let round = 1;

  while (round <= MAX_ROUNDS) {

    let addedThisRound = false;

    for (const ecosystem of sortedEcosystems) {

      if (!ecosystem[round]) continue;

      const candidate =
        ecosystem[round];

      const fingerprint =
        contentFingerprint(candidate.content);

      if (includedFingerprints.has(fingerprint)) {
        continue;
      }

      if (
        totalChars + candidate.content.length >
        contextBudget
      ) {
        continue;
      }

      surviving.push(candidate);

      includedFingerprints.add(fingerprint);

      totalChars += candidate.content.length;

      addedThisRound = true;
    }

    if (!addedThisRound) break;

    round++;
  }

  return surviving;
}

// ============================================================
// 🔥 RELATIONSHIP-AWARE SEMANTIC LAYER
// ============================================================

function calculateSemanticOverlap(a = "", b = "") {

  const aWords = new Set(
    a.toLowerCase().split(/\s+/).filter(Boolean)
  );

  const bWords = new Set(
    b.toLowerCase().split(/\s+/).filter(Boolean)
  );

  let overlap = 0;

  for (const word of aWords) {
    if (
      bWords.has(word) &&
      word.length > 4 &&
      !STOPWORDS.has(word)
    ) {
      overlap++;
    }
  }

  const denominator =
    Math.max(aWords.size, bWords.size) || 1;

  return overlap / denominator;
}

function buildSemanticNeighborhoods(results = []) {

  const limitedResults =
    results.slice(0, MAX_RELATIONSHIP_RESULTS);

  return results.map((result, idx) => {

    let neighborhoodStrength = 0;
    let relationshipCount = 0;

    for (let i = 0; i < limitedResults.length; i++) {

      if (i === idx) continue;

      const other = limitedResults[i];

      const overlap =
        calculateSemanticOverlap(
          result.content,
          other.content
        );

      if (overlap >= 0.12) {

        neighborhoodStrength += overlap;
        relationshipCount++;
      }
    }

    return {
      ...result,
      neighborhoodStrength,
      relationshipCount
    };
  });
}

// ============================================================
// 🔥 PHASE 5 — DISTRIBUTION STABILIZATION
// ============================================================

function applyRelationshipAwareScoring(results = []) {

  if (!results.length) return results;

  const strongestNeighborhood =
    Math.max(
      ...results.map(
        r => r.neighborhoodStrength || 0
      ),
      0.01
    );

  return results.map(result => {

    const neighborhoodRatio =
      (result.neighborhoodStrength || 0) /
      strongestNeighborhood;

    const saturationCurve =
      Math.sqrt(neighborhoodRatio);

    const relationshipBoost =
      saturationCurve * 0.04;

    const continuityBoost =
      Math.min(
        Math.log1p(
          result.relationshipCount || 0
        ) * 0.012,
        0.03
      );

    const confidenceGapPenalty =
      (
        neighborhoodRatio < 0.18 &&
        result.boostedScore < 0.46
      )
        ? 0.025
        : 0;

    const filePressurePenalty =
      Math.min(
        (
          (result.fileOccurrenceCount || 1) - 1
        ) * 0.012,
        0.05
      );

    const finalScore =
      result.boostedScore +
      relationshipBoost +
      continuityBoost -
      confidenceGapPenalty -
      filePressurePenalty;

    return {
      ...result,
      saturationCurve,
      relationshipBoost,
      continuityBoost,
      confidenceGapPenalty,
      filePressurePenalty,
      finalScore
    };
  });
}

// ============================================================
// ROUTE
// ============================================================

// ============================================================
// 🔎 DOCUMENT-NAME INTENT + CHUNK → FILE LOOKUP
// Docling chunks carry no "SOURCE FILE:" header, so the file is
// resolved from the chunk id. If the question names a document,
// retrieval is restricted to that document.
// ============================================================

const NAME_CACHE = new Map(); // namespace -> { at, docs }
const NAME_NOISE = new Set([
  "pdf", "docx", "doc", "xlsx", "pptx", "final", "copy", "draft", "version", "v1", "v2",
  "document", "documents", "file", "files", "what", "about", "does", "the", "and", "for",
  "with", "from", "this", "that", "into", "contain", "contains", "inside"
]);

function nameTokens(text = "") {
  return String(text)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")        // ArielWilson → Ariel Wilson
    .replace(/([A-Za-z])(\d)/g, "$1 $2")        // ServiceDesk2 → ServiceDesk 2
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    // keep 2-letter uppercase codes ("JD", "HR"); drop upload ids such as 1765784712
    .filter(t => (t.length >= 3 || /^[A-Z0-9]{2}$/.test(t)) && !/^\d{7,}$/.test(t))
    .map(t => t.toLowerCase())
    .filter(t => !NAME_NOISE.has(t) && !STOPWORDS.has(t));
}

// Document-level similarity (migration 0006): a document whose profile is clearly
// the closest to the question counts as named, at boost strength.
const DOC_LEAD_MIN = Number(process.env.DOC_LEAD_MIN || 0.45);
const DOC_LEAD_MARGIN = Number(process.env.DOC_LEAD_MARGIN || 0.06);

const COMPARISON_INTENT = /\b(compare|comparison|comparing|versus|vs\.?|both|differ|difference|differences|between|fit|match|suit|against|relate|relative)\b/i;
// Words that name a *kind* of document rather than a particular one; on their own
// they never identify a file ("the report", "his resume").
const GENERIC_NAME_WORDS = new Set([
  "resume", "report", "program", "plan", "policy", "manual", "guide", "notes", "summary", "proposal",
  "description", "internship", "executive", "assistant", "project", "overview", "template", "agreement",
  "contract", "letter", "form", "schedule", "meeting", "recap", "standards", "package", "addendum",
  "section", "statement", "device", "health", "technical", "review", "annual", "quarterly", "monthly",
  "final", "draft", "update", "presentation", "deck", "sheet", "budget", "invoice", "memo", "brief"
]);
const isYear = t => /^(19|20)\d{2}$/.test(t);

async function namespaceDocuments(supabase, namespaceId) {
  const hit = NAME_CACHE.get(namespaceId);
  if (hit && Date.now() - hit.at < 30000) return hit.docs;
  const { data } = await supabase
    .from("documents")
    .select("id, file_name, display_name, status")
    .eq("namespace_id", namespaceId);
  const docs = (data || []).filter(d => !d.status || d.status === "ready");
  NAME_CACHE.set(namespaceId, { at: Date.now(), docs });
  return docs;
}

// Two strengths of match:
//  - filter: a code-like token (digits, but not a bare year) or three name words —
//    the question is clearly about this file, so retrieval is restricted to it;
//  - boost: two name words covering most of a name — the file is guaranteed a
//    place in the results and lifted, but other documents are not excluded.
// Comparison questions, and questions that name more than one document, never
// filter: excluding the other side of a comparison produced wrong answers.
function findNamedDocuments(docs, query) {
  const qTokens = nameTokens(query);
  const q = new Set(qTokens);
  if (!q.size) return [];
  const queryYears = qTokens.filter(isYear);
  // how many documents each name word belongs to (a word shared by several files
  // such as "internship" cannot single out one of them)
  const nameCounts = new Map();
  for (const d of docs) {
    for (const t of new Set([...nameTokens(d.file_name), ...nameTokens(d.display_name || "")])) {
      nameCounts.set(t, (nameCounts.get(t) || 0) + 1);
    }
  }
  const hits = [];
  for (const d of docs) {
    const fileToks = [...new Set(nameTokens(d.file_name))];
    const displayToks = [...new Set(nameTokens(d.display_name || ""))];
    const toks = [...new Set([...fileToks, ...displayToks])];
    if (!toks.length) continue;
    const matched = toks.filter(t => q.has(t));
    if (!matched.length) continue;

    // "the 2023 report" must not lock onto "2024 Annual Report"
    const nameYears = toks.filter(isYear);
    if (queryYears.length && nameYears.length && !nameYears.some(y => q.has(y))) continue;

    // coverage against each name separately: the display name is short and the
    // file name often carries dates and ids that no question repeats
    const coverageOf = list => (list.length ? list.filter(t => q.has(t)).length / list.length : 0);
    const coverage = Math.max(coverageOf(fileToks), coverageOf(displayToks));
    const codeMatch = matched.some(t => /\d/.test(t) && !isYear(t));

    const filter = codeMatch || matched.length >= 3;
    // A boost never excludes anything, so two name words are enough even when the
    // file name carries extra words ("SolluCIO-ArielWilson-ServiceDesk2"), and a
    // single distinctive word ("brad", "multicare") that occurs in exactly one
    // document's name is enough too: people and organisations are usually named
    // with one word in a question.
    const unique = matched.filter(t => t.length >= 4 && !GENERIC_NAME_WORDS.has(t) && nameCounts.get(t) === 1);
    const boost = !filter && ((matched.length >= 2 && coverage >= 0.3) || unique.length > 0);
    if (filter || boost) {
      hits.push({ id: d.id, file_name: d.file_name, matched, score: coverage + (codeMatch ? 1 : 0), filter });
    }
  }
  const top = hits.sort((a, b) => b.score - a.score).slice(0, 3);
  if (top.length > 1 || COMPARISON_INTENT.test(query)) {
    for (const h of top) h.filter = false;
  }
  return top;
}

async function chunkFiles(supabase, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const { data } = await supabase
    .from("document_chunks")
    .select("id, document_id, chunk_index, page_start, page_end, section_label, documents(file_name, display_name)")
    .in("id", ids);
  for (const r of data || []) {
    map.set(r.id, {
      document_id: r.document_id,
      chunk_index: r.chunk_index,
      page_start: r.page_start ?? null,
      page_end: r.page_end ?? null,
      section_label: r.section_label || null,
      file_name: r.documents?.file_name || null,
      display_name: r.documents?.display_name || null
    });
  }
  return map;
}

export default fp(async function retrieveRoute(fastify, opts) {

  fastify.post(
    "/api/retrieve",
    { preHandler: [requireAuth(), requireNamespaceMember(fastify)] },
    async (req, reply) => {

      try {

        const { query, namespaceId: requestedNamespaceId, conversationId = null, historyTurns = null, traceId = null } = req.body || {};

        // The token decides the namespace. A body value is accepted only
        // when it agrees, so a client cannot search another workspace.
        const identity = identityFrom(req);
        const namespaceId = identity.namespaceId;

        if (!hasPermission(identity, "chat")) {
          return reply.code(403).send({
            error: "Forbidden: No permission to retrieve data"
          });
        }

        if (requestedNamespaceId && requestedNamespaceId !== namespaceId) {
          return reply.code(403).send({
            error: "Namespace mismatch. Access denied."
          });
        }

        if (!query || !query.trim()) {
          return reply.code(400).send({
            error: "Query text is required."
          });
        }

        const retrievalProfile =
          determineQueryProfile(query);

        // One shared client (keep-alive) unless the server did not decorate one.
        const supabase =
          fastify.supabase ||
          createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_KEY
          );

        const normalizedQuery =
          normalizeRetrievalQuery(query);

        const queryTerms = normalizedQuery
          .split(" ")
          .filter(
            term =>
              term.length > 3 &&
              !STOPWORDS.has(term)
          );

        // ======================================================
        // 🔎 DOCUMENT-NAME INTENT
        // ======================================================

        const namedDocs =
          findNamedDocuments(
            await namespaceDocuments(supabase, namespaceId),
            query
          );

        // ======================================================
        // 🔥 EMBEDDING CACHE
        // ======================================================

        let embedding =
          getCachedEmbedding(normalizedQuery);

        if (!embedding) {

          const embedRes =
            await fastify.openai.embeddings.create({
              model: "text-embedding-3-small",
              input: normalizedQuery,
            });

          embedding =
            embedRes.data?.[0]?.embedding;

          if (!embedding) {
            return reply.code(500).send({
              error: "Failed to generate embedding."
            });
          }

          setCachedEmbedding(
            normalizedQuery,
            embedding
          );
        }

        // ======================================================
        // 📄 DOCUMENT-LEVEL SIMILARITY
        // Which documents is the question about as a whole? Feeds a
        // prior on chunk scores and can name the leading document.
        // ======================================================
        let docScores = [];
        try {
          const { data: dp, error: dpErr } = await supabase.rpc("match_document_profiles", {
            query_embedding: embedding,
            query_namespace_id: namespaceId,
            match_count: 10
          });
          if (dpErr) throw new Error(dpErr.message);
          docScores = dp || [];
        } catch (err) {
          fastify.log.warn({ err: err?.message }, "retrieve: document profiles unavailable (migration 0006 not applied?)");
        }
        const lead = docScores[0];
        const runnerUp = docScores[1];
        if (
          lead &&
          lead.similarity >= DOC_LEAD_MIN &&
          (!runnerUp || lead.similarity - runnerUp.similarity >= DOC_LEAD_MARGIN) &&
          !namedDocs.some(d => d.id === lead.id)
        ) {
          namedDocs.push({ id: lead.id, file_name: lead.file_name, matched: ["profile"], score: lead.similarity, filter: false, semantic: true });
        }

        // ======================================================
        // 🔀 RETRIEVAL MODE (Phase 2): hybrid SQL vs legacy pipeline
        // ======================================================
        const retrievalMode = resolveRetrievalMode(req);
        const traceStart = Date.now();

        if (retrievalMode === "hybrid") {
          const hybrid = await hybridRetrieve({
            supabase,
            query: query.trim().replace(/\s+/g, " ").replace(/\?+$/, ""),
            embedding,
            namespaceId,
            namedDocs,
            docScores,
            log: fastify.log
          });

          logRetrievalTrace(supabase, fastify.log, {
            traceId, query, namespaceId, conversationId, historyTurns, mode: "hybrid", userId: identity.userId,
            latencyMs: Date.now() - traceStart, results: hybrid.results, namedDocs
          });

          return reply.send({
            results: hybrid.results,
            namedDocuments: namedDocs.map(d => ({ id: d.id, file_name: d.file_name, filter: d.filter === true, semantic: d.semantic === true })),
            documents: docScores.slice(0, 5).map(d => ({ id: d.id, file_name: d.file_name, similarity: Number(d.similarity?.toFixed?.(3) ?? d.similarity) })),
            mode: "hybrid"
          });
        }

        const { data, error } =
          await supabase.rpc("match_documents", {
            query_embedding: embedding,
            match_threshold: 0.10,
            match_count: namedDocs.length
              ? Math.max(retrievalProfile.matchCount, 60)
              : retrievalProfile.matchCount,
            query_namespace_id: namespaceId,
          });

        if (error) {

          console.error(
            "❌ retrieve error:",
            error
          );

          return reply.code(500).send({
            error: error.message
          });
        }

        // ======================================================
        // 🔗 RESOLVE FILE PER CHUNK, RESTRICT TO NAMED DOCUMENT
        // ======================================================

        let rows = data || [];
        let fileById = await chunkFiles(supabase, rows.map(r => r.id));

        // Only filter-strength matches restrict the legacy path; boost matches are advisory.
        const legacyFilterDocs = namedDocs.filter(d => d.filter === true);
        if (legacyFilterDocs.length) {
          const wanted = new Set(legacyFilterDocs.map(d => d.id));
          rows = rows.filter(r => wanted.has(fileById.get(r.id)?.document_id));

          // Overview questions ("what is in X?") score low on similarity, so top up
          // with the document's opening sections in reading order.
          if (rows.length < retrievalProfile.topK) {
            const have = new Set(rows.map(r => r.id));
            const { data: lead } = await supabase
              .from("document_chunks")
              .select("id, chunk_text, document_id, chunk_index, page_start, page_end, section_label, documents(file_name, display_name)")
              .in("document_id", [...wanted])
              .order("chunk_index", { ascending: true })
              .limit(retrievalProfile.topK * 2);
            for (const c of lead || []) {
              if (have.has(c.id)) continue;
              rows.push({ id: c.id, chunk_text: c.chunk_text, similarity: 0.5 });
              fileById.set(c.id, {
                document_id: c.document_id, chunk_index: c.chunk_index,
                page_start: c.page_start ?? null, page_end: c.page_end ?? null, section_label: c.section_label || null,
                file_name: c.documents?.file_name || null, display_name: c.documents?.display_name || null
              });
              if (rows.length >= retrievalProfile.topK * 2) break;
            }
          }

          fastify.log.info({
            route: "/api/retrieve",
            namedDocuments: namedDocs.map(d => d.file_name),
            restrictedRows: rows.length
          });
        }

        // ======================================================
        // 🧠 FORMAT + ECOSYSTEM IDENTITY STABILIZATION
        // ======================================================

        let formatted = rows.map((row) => {

          const content =
            (row.chunk_text || "")
              .replace(/\s+/g, " ")
              .trim();

          const known = fileById.get(row.id);

          const extractedFilename =
            known?.file_name ||
            row.filename ||
            row.chunk_text.match(
              /SOURCE FILE:\s*([^\n\r]+)/i
            )?.[1]?.trim();

          const hasHeader =
            /SOURCE FILE:/i.test(row.chunk_text || "");

          return {

            content:
              known?.file_name && !hasHeader
                ? `SOURCE FILE: ${known.file_name}\n${content}`
                : content,

            similarity: row.similarity,

            filename:
              extractedFilename ||
              generateSyntheticEcosystemId(content),

            document_id: known?.document_id || null,
            chunk_id: row.id,
            chunk_index: known?.chunk_index ?? null,
            page_start: known?.page_start ?? null,
            page_end: known?.page_end ?? null,
            section_label: known?.section_label || null,
            display_name: known?.display_name || null
          };
        });

        formatted =
          formatted.filter(r => r.content);

        formatted =
          formatted.filter(
            r =>
              r.similarity >=
              retrievalProfile.similarityThreshold
          );

        // ======================================================
        // 🔥 EARLY EMPTY EXIT
        // ======================================================

        if (!formatted.length) {
          return reply.send({
            results: [],
            namedDocuments: namedDocs.map(d => ({ id: d.id, file_name: d.file_name }))
          });
        }

        const seen = new Set();

        formatted = formatted.filter(r => {

          const key =
            contentFingerprint(r.content);

          if (seen.has(key)) {
            return false;
          }

          seen.add(key);

          return true;
        });

        formatted = formatted.map(r => {

          const content =
            r.content.toLowerCase();

          let keywordBoost = 0;
          let coverageBoost = 0;

          for (const term of queryTerms) {

            if (content.includes(term)) {
              keywordBoost += 0.03;
            }
          }

          const matchedTerms =
            countTermMatches(
              content,
              queryTerms
            );

          coverageBoost =
            Math.min(
              matchedTerms * 0.015,
              0.08
            );

          const semanticDensity =
            calculateSemanticDensity(content);

          const densityBoost =
            semanticDensity * 0.03;

          const confidenceScore =
            (
              r.similarity +
              keywordBoost +
              coverageBoost +
              densityBoost
            );

          return {
            ...r,
            semanticDensity,
            confidenceScore,
            boostedScore: confidenceScore
          };
        });

        const fileOccurrenceMap = {};

        for (const item of formatted) {

          fileOccurrenceMap[item.filename] =
            (fileOccurrenceMap[item.filename] || 0) + 1;
        }

        formatted = formatted.map(item => ({
          ...item,
          fileOccurrenceCount:
            fileOccurrenceMap[item.filename] || 1
        }));

        formatted =
          buildSemanticNeighborhoods(formatted);

        formatted =
          applyRelationshipAwareScoring(formatted);

        const retrievalPressure =
          calculateRetrievalPressure(formatted);

        formatted.sort(
          (a, b) =>
            b.finalScore - a.finalScore
        );

        // ======================================================
        // 🔥 STATIC FILE CAP
        // ======================================================

        const fileCounts = {};

        formatted = formatted.filter(r => {

          const key = r.filename;

          fileCounts[key] =
            (fileCounts[key] || 0) + 1;

          // A named document is the whole point of the question; don't cap it at 3.
          return (
            fileCounts[key] <=
            (namedDocs.length ? MAX_RESULTS_PER_FILE * 5 : MAX_RESULTS_PER_FILE)
          );
        });

        // ======================================================
        // 🔥 HARD CONTEXT CEILING
        // ======================================================

        const adaptiveContextBudget =
          namedDocs.length
            ? MAX_CONTEXT_BUDGET
            : retrievalPressure.highPressure
            ? Math.min(
                retrievalProfile.contextBudget + 2000,
                MAX_CONTEXT_BUDGET
              )
            : retrievalProfile.contextBudget;

        formatted =
          applyEcosystemContextAllocation(
            formatted,
            adaptiveContextBudget,
            namedDocs.length ? 40 : 3
          );

        const adaptiveTopK =
          namedDocs.length
            ? Math.max(retrievalProfile.topK + 6, 12)
            : retrievalPressure.highPressure
            ? retrievalProfile.topK + 4
            : retrievalProfile.topK;

        formatted =
          formatted.slice(
            0,
            adaptiveTopK
          );

        fastify.log.info({
          route: "/api/retrieve",
          namespaceId,
          normalizedQuery,
          queryTerms,
          queryType: retrievalProfile.type,
          retrievalPressure:
            retrievalPressure.pressure,
          highPressure:
            retrievalPressure.highPressure,
          adaptiveTopK,
          matchCount: formatted.length,
          ragUsed: formatted.length > 0
        });

        logRetrievalTrace(supabase, fastify.log, {
          traceId, query, namespaceId, conversationId, historyTurns, mode: "legacy", userId: identity.userId,
          latencyMs: Date.now() - traceStart, results: formatted, namedDocs
        });

        return reply.send({
          results: formatted,
          namedDocuments: namedDocs.map(d => ({ id: d.id, file_name: d.file_name, filter: d.filter === true })),
          mode: "legacy"
        });

      } catch (err) {

        console.error(
          "❌ /api/retrieve FAILURE:",
          err
        );

        return reply.code(500).send({
          error: "RAG retrieve failure",
          detail: err.message,
        });
      }
    }
  );
});
