// =============================================================
//  D5: which of the organization's document types is this document?
//  (docs/KEV_PROTOTYPE.md §3). Asked once per ingest, after the summary,
//  and only when the organization has types. The suggestion is stored
//  on the document; in "on" mode it is applied to an untyped document
//  when the model is sure enough.
// =============================================================

import { systemOne, choiceOf } from "./systemone.js";
import { documentTypesByOrganization } from "../lib/documentTypeScope.js";

/** The document types that apply to a document: its organization's, or its namespace's before migration 0014. */
export async function documentTypesFor(supabase, doc) {
  let q = supabase.from("document_types").select("name, description").order("sort_order", { ascending: true });
  if (await documentTypesByOrganization(supabase)) {
    const { data: ns } = await supabase.from("namespace").select("organization_id").eq("id", doc.namespace_id).maybeSingle();
    if (!ns?.organization_id) return [];
    q = q.eq("organization_id", ns.organization_id);
  } else {
    q = q.eq("namespace_id", doc.namespace_id);
  }
  const { data } = await q;
  return (data || []).filter((t) => t?.name).slice(0, 250);
}

/** What the model reads about a document: its name, the ingest summary's purpose and type, and how it opens. */
export function docTypeState({ fileName, summary = null, markdown = "" }) {
  const state = { file_name: String(fileName || "") };
  if (summary?.purpose) state.purpose = String(summary.purpose).slice(0, 400);
  if (summary?.document_type) state.described_as = String(summary.document_type).slice(0, 100);
  state.opening = String(markdown || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  return state;
}

/**
 * @param {{name, description?}[]} types
 * @returns {Promise<null | { name: string|null, p: number|null, confidence: number|null, ms: number, model: string }>}  name null = "other"
 */
export async function kevDocType(state, types, { log = null, usage = null, timeoutMs = 5000 } = {}) {
  if (!types?.length) return null;
  const criteria = {};
  const byKey = new Map();
  types.forEach((t, i) => {
    const key = `t${i + 1}`;
    byKey.set(key, t.name);
    criteria[key] = t.description ? `${t.name}: ${t.description}` : t.name;
  });
  criteria.other = "none of these types fits";
  const res = await systemOne(state, { type: { type: "choice", instructions: "Which type of document is this?", criteria } }, { stage: "doctype_kev", usage, log, timeoutMs });
  const c = choiceOf(res?.answers?.type);
  if (!c) return null;
  return { name: byKey.get(c.value) || null, p: c.p, confidence: c.confidence, ms: res.ms, model: res.model, inputTokens: res.inputTokens };
}
