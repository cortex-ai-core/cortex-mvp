// =============================================================
//  Resolution policy for memory propositions (design doc section 9,
//  after MapU's truth policy). Pure functions over attestation rows:
//  no database, no model, so the policy can be tested as a unit with
//  fixed inputs and its determinism is real. The version is stored on
//  every state row so a later change never reinterprets old states.
//
//    POLICY            the constants (D15), one versioned object
//    scoreSide         the five dimensions for one side's attestations
//    vote              which side wins, dimension by dimension
//    stateFromStances  the state when only one kind of stance exists
//    basisHash         sha256 of the sorted attestation ids considered
//    describeVote      the one-line "Basis: …" the model and panel show
// =============================================================

import { createHash } from "node:crypto";

export const POLICY = Object.freeze({
  version: "cortex-v1",
  // Source authority per layer (design doc 9.4), inside MapU's own range.
  authority: Object.freeze({
    knowledge: 0.85,
    user_explicit: 0.80,
    admin: 0.75,
    extracted: 0.50,
    current_context: 0.40,
    history: 0.35,
  }),
  authorityMargin: 0.15,
  confidenceMargin: 0.10,
  needed: 3,              // dimensions a side must win, out of five
  nearDuplicate: 0.92,    // the first-pass proposition matcher
});

export const VISIBLE_TRUTH = Object.freeze(["accepted", "contested", "reported"]);

const live = (a) => a && a.status === "accepted" && !a.invalidated_at;

/** Distinct-source key: a document, a conversation, or the actor. */
export function sourceKey(a) {
  const ref = a?.source_ref || {};
  return ref.document_id ? `doc:${ref.document_id}`
    : ref.conversation_id ? `conv:${ref.conversation_id}`
    : `actor:${a?.actor || "unknown"}`;
}

/**
 * The five dimensions for one side. `attestations` are that side's live
 * rows (asserts for a proposition, or denies against it).
 */
export function scoreSide(attestations = []) {
  const rows = attestations.filter(live);
  return {
    authority: rows.reduce((m, a) => Math.max(m, Number(a.authority_score) || 0), 0),
    independent: new Set(rows.map(sourceKey)).size,
    confidence: rows.reduce((m, a) => Math.max(m, Number(a.confidence) || 0), 0),
    direct: rows.some((a) => a.strength === "direct_statement"),
    firstParty: rows.some((a) => a.first_party === true && a.self_serving === false),
    count: rows.length,
  };
}

/**
 * Compare two sides. Returns which side won each dimension ('a', 'b' or
 * 'tie'), the tally, and the winner ('a', 'b') or null when neither
 * reaches POLICY.needed, which is the contested outcome.
 */
export function vote(sideA = [], sideB = []) {
  const a = scoreSide(sideA);
  const b = scoreSide(sideB);
  const byMargin = (x, y, margin) => (x - y > margin ? "a" : y - x > margin ? "b" : "tie");
  const byAny = (x, y) => (x > y ? "a" : y > x ? "b" : "tie");
  const byFlag = (x, y) => (x && !y ? "a" : y && !x ? "b" : "tie");
  const dimensions = {
    authority: byMargin(a.authority, b.authority, POLICY.authorityMargin),
    independent: byAny(a.independent, b.independent),
    confidence: byMargin(a.confidence, b.confidence, POLICY.confidenceMargin),
    direct: byFlag(a.direct, b.direct),
    first_party: byFlag(a.firstParty, b.firstParty),
  };
  const tally = { a: 0, b: 0 };
  for (const w of Object.values(dimensions)) if (w !== "tie") tally[w] += 1;
  const winner = tally.a >= POLICY.needed ? "a" : tally.b >= POLICY.needed ? "b" : null;
  return { winner, dimensions, tally, sides: { a, b }, policy_version: POLICY.version };
}

/**
 * The state of one proposition from its live attestations when no vote
 * is needed (design doc 9.5, "Evidence"): only assertions → accepted,
 * only denials → denied, only reports → reported, nothing → unknown.
 * Both assertions and denials → null: run the vote.
 */
export function stateFromStances(attestations = []) {
  const rows = attestations.filter(live);
  const has = (s) => rows.some((a) => a.stance === s);
  if (!rows.length) return "unknown";
  if (has("asserts") && has("denies")) return null;
  if (has("asserts")) return "accepted";
  if (has("denies")) return "denied";
  if (has("reports")) return "reported";
  return "unknown";                                   // questions and conditions are neutral
}

export function basisHash(attestationIds = []) {
  const ids = [...new Set((attestationIds || []).filter(Boolean).map(String))].sort();
  return createHash("sha256").update(ids.join(",")).digest("hex");
}

/**
 * "Basis: knowledge wins authority and independence; you win directness
 * and first-party." labelA/labelB name the two sides for the reader.
 */
export function describeVote(result, labelA = "the first", labelB = "the second") {
  const names = { authority: "authority", independent: "independence", confidence: "confidence", direct: "directness", first_party: "first-party" };
  const won = (side) => Object.entries(result.dimensions).filter(([, w]) => w === side).map(([k]) => names[k]);
  const parts = [];
  const wa = won("a"), wb = won("b");
  if (wa.length) parts.push(`${labelA} wins ${list(wa)}`);
  if (wb.length) parts.push(`${labelB} wins ${list(wb)}`);
  if (!parts.length) parts.push("every dimension ties");
  const outcome = result.winner === "a" ? `${labelA} prevails` : result.winner === "b" ? `${labelB} prevails` : "unresolved";
  return `${parts.join("; ")} (${outcome}, ${result.tally.a} to ${result.tally.b})`;
}

function list(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
