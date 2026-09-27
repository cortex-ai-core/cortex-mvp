// =============================================================
//  D2: which document is the question about? (docs/KEV_PROTOTYPE.md §3)
//
//  Retrieval knows the documents whose profiles are closest to the
//  question; the decision model picks one of them, "none" (not about one
//  particular document) or "several" (spans or compares several). Today
//  a similarity lead rule decides (retrieve.js: DOC_LEAD_MIN and
//  DOC_LEAD_MARGIN). Kev never filters: a document it picks is named at
//  boost strength only.
// =============================================================

import { systemOne, choiceOf } from "./systemone.js";

const MAX_OPTIONS = 8;

const nameOf = (d) => String(d.display_name || d.file_name || "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").trim();

/**
 * @param {string} query
 * @param {{id, file_name, display_name?}[]} candidates  closest first
 * @returns {Promise<null | { kind: "doc"|"none"|"several", doc: object|null, p: number|null, confidence: number|null, ms: number, probabilities: object }>}
 */
export async function kevNamedDocument(query, candidates, { log = null, usage = null, timeoutMs = null } = {}) {
  const docs = (candidates || []).filter((d) => d?.id).slice(0, MAX_OPTIONS);
  if (!docs.length || !String(query || "").trim()) return null;
  const criteria = {};
  docs.forEach((d, i) => { criteria[`d${i + 1}`] = `the document "${nameOf(d)}"`; });
  criteria.none = "no one particular document: a general question, a topic to search for across the collection, or a document not listed";
  criteria.several = "two or more of the listed documents, for example a comparison between them";
  const res = await systemOne(
    { question: String(query).slice(0, 1500) },
    { document: { type: "choice", instructions: "Which document is this question about?", criteria } },
    { stage: "named_doc_kev", usage, log, timeoutMs }
  );
  const c = choiceOf(res?.answers?.document);
  if (!c) return null;
  const idx = /^d(\d+)$/.exec(c.value);
  return {
    kind: idx ? "doc" : c.value === "several" ? "several" : "none",
    doc: idx ? docs[Number(idx[1]) - 1] || null : null,
    p: c.p,
    confidence: c.confidence,
    ms: res.ms,
    inputTokens: res.inputTokens,
    probabilities: c.probabilities,
    options: docs.map((d, i) => ({ key: `d${i + 1}`, id: d.id, name: nameOf(d) })),
  };
}
