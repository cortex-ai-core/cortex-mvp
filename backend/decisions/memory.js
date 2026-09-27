// =============================================================
//  D3 and D4 (docs/KEV_PROTOTYPE.md §3): the two memory decisions a
//  decision model can take off the chat model.
//
//    kevRelation     how a new note relates to up to five similar
//                    memories: the same claim, a new value for one of
//                    them, or unrelated. One choice of at most 11 options.
//    kevExtractGate  is there anything in the user's message worth
//                    keeping? A yes/no in front of the extraction call.
// =============================================================

import { systemOne, choiceOf, noulOf } from "./systemone.js";

/**
 * @param {string} note
 * @param {{id, content}[]} related  at most five
 * @returns {Promise<null | { relation: "same"|"different_value"|"unrelated", targetId: string|null, p: number|null, confidence: number|null, ms: number }>}
 */
export async function kevRelation(note, related, { usage = null, log = null, timeoutMs = null } = {}) {
  const list = (related || []).filter((m) => m?.id && m?.content).slice(0, 5);
  if (!list.length || !String(note || "").trim()) return null;
  const state = { new_note: String(note).slice(0, 600) };
  list.forEach((m, i) => { state[`existing_memory_${i + 1}`] = String(m.content).slice(0, 400); });
  const criteria = { unrelated: "the new note is a separate fact from every existing memory, even if the subject is similar" };
  list.forEach((_, i) => {
    const k = i + 1;
    criteria[`same_${k}`] = `the new note restates existing memory ${k}: the same claim with the same value (a rewording, a repeat, or more detail about the same fact)`;
    criteria[`update_${k}`] = `the new note is about the same subject and kind of fact as existing memory ${k} but gives a different value: a new name, date, number, owner, preference or decision; a correction or update`;
  });
  const res = await systemOne(state, { relation: { type: "choice", instructions: "How does the new note relate to the existing memories?", criteria } }, { stage: "relation_kev", usage, log, timeoutMs });
  const c = choiceOf(res?.answers?.relation);
  if (!c) return null;
  const m = /^(same|update)_(\d+)$/.exec(c.value);
  const target = m ? list[Number(m[2]) - 1] : null;
  return {
    relation: m ? (m[1] === "same" ? "same" : "different_value") : "unrelated",
    targetId: target?.id || null,
    p: c.p,
    confidence: c.confidence,
    ms: res.ms,
    inputTokens: res.inputTokens,
  };
}

const GATE_INSTRUCTIONS =
  "Does the user's message state something durable about themselves, their organization or their work that would matter in a later conversation: " +
  "a preference, a decision, a correction, or a named person, project, date, code or term they introduce? " +
  "Questions, greetings, thanks, and what the user is doing right now do not count.";

/**
 * @returns {Promise<null | { p: number, ms: number }>}  p = probability there is something to keep
 */
export async function kevExtractGate(userMessage, { usage = null, log = null, timeoutMs = null } = {}) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const res = await systemOne({ user_message: text.slice(0, 1500) }, { worth_keeping: { type: "noul", instructions: GATE_INSTRUCTIONS } }, { stage: "extract_gate_kev", usage, log, timeoutMs });
  const p = noulOf(res?.answers?.worth_keeping);
  return p == null ? null : { p, ms: res.ms, inputTokens: res.inputTokens };
}
