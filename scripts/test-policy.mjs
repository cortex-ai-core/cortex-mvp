#!/usr/bin/env node
// =============================================================
//  The resolution policy as a unit, with fixed inputs (design doc 9.4,
//  9.8: "the policy has to be tested as a unit with fixed inputs so its
//  determinism is real and not just claimed"). No database, no model.
//
//    node scripts/test-policy.mjs
// =============================================================

import { POLICY, vote, scoreSide, stateFromStances, basisHash, describeVote, sourceKey } from "../backend/memory/policy.js";

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const att = (o) => ({ id: o.id || Math.random().toString(36).slice(2), status: "accepted", invalidated_at: null, stance: "asserts", strength: "direct_statement", confidence: 1, first_party: null, self_serving: null, ...o });

// --- 9.4 worked example: pasted identifier against curated knowledge
const knowledge = [
  att({ authority_score: POLICY.authority.knowledge, source_ref: { document_id: "d1", chunk_id: "c1" } }),
  att({ authority_score: POLICY.authority.knowledge, source_ref: { document_id: "d2", chunk_id: "c9" } }),
];
const pasted = [att({ authority_score: POLICY.authority.current_context, strength: "inference", confidence: 0.9, source_ref: { conversation_id: "conv1" } })];
let r = vote(knowledge, pasted);
check("knowledge beats a pasted draft: authority, independence, directness", r.winner === "a" && r.dimensions.authority === "a" && r.dimensions.independent === "a" && r.dimensions.direct === "a", JSON.stringify(r.dimensions));
check("confidence exactly at the margin ties (1.0 vs 0.9 is not over 0.10)", r.dimensions.confidence === "tie", r.dimensions.confidence);
check("confidence over the margin wins", vote([att({ authority_score: 0.5, confidence: 1 })], [att({ authority_score: 0.5, confidence: 0.85 })]).dimensions.confidence === "a");

// --- 9.4: an admin import against the user's own statement: within the authority margin, contested
const adminImport = [att({ authority_score: POLICY.authority.admin, actor: "admin-1", source_ref: { actor: "admin-1" } })];
const userSays = [att({ authority_score: POLICY.authority.user_explicit, actor: "user-1", first_party: true, self_serving: false, source_ref: { conversation_id: "conv2" } })];
r = vote(adminImport, userSays);
check("admin import vs user statement: authority ties (0.75 vs 0.80)", r.dimensions.authority === "tie");
check("user wins first-party only, so contested", r.winner === null && r.tally.b === 1 && r.tally.a === 0, describeVote(r, "the import", "you"));

// --- three of five is the bar, not a majority of decided dimensions
const two = [att({ authority_score: 0.85, strength: "inference", source_ref: { document_id: "d1" } }), att({ authority_score: 0.85, strength: "inference", source_ref: { document_id: "d3" } })];
const one = [att({ authority_score: 0.5, first_party: true, self_serving: false, source_ref: { conversation_id: "c" } })];
r = vote(two, one);
check("two dimensions is not enough", r.winner === null && r.tally.a === 2, JSON.stringify(r.tally));

// --- an extracted note against an explicit statement (would be a supersession by actor, but as a vote):
const extracted = [att({ authority_score: POLICY.authority.extracted, strength: "inference", confidence: 0.8, actor: "user-1", source_ref: { conversation_id: "c3" } })];
r = vote(extracted, userSays);
check("explicit statement beats an extracted note outright", r.winner === "b" && r.tally.b >= 4, JSON.stringify(r.dimensions));

// --- retracted and rejected attestations do not count
const withDead = [...userSays, att({ authority_score: 0.99, status: "rejected" }), att({ authority_score: 0.99, invalidated_at: "2026-09-01T00:00:00Z" })];
check("rejected and invalidated attestations are ignored", scoreSide(withDead).authority === POLICY.authority.user_explicit && scoreSide(withDead).count === 1);

// --- single-proposition states
check("only assertions → accepted", stateFromStances(userSays) === "accepted");
check("only denials → denied", stateFromStances([att({ stance: "denies" })]) === "denied");
check("only reports → reported", stateFromStances([att({ stance: "reports" })]) === "reported");
check("questions alone → unknown", stateFromStances([att({ stance: "questions" })]) === "unknown");
check("nothing live → unknown", stateFromStances([att({ stance: "asserts", invalidated_at: "2026-01-01" })]) === "unknown");
check("assertions and denials → null (vote)", stateFromStances([att({ stance: "asserts" }), att({ stance: "denies" })]) === null);

// --- independence: two chunks of one document are one source
check("two chunks of one document count once", scoreSide(knowledge.concat([att({ authority_score: 0.85, source_ref: { document_id: "d1", chunk_id: "c2" } })])).independent === 2);
check("source key falls back to the actor", sourceKey(att({ actor: "u9" })) === "actor:u9");

// --- determinism and the basis hash
const r1 = JSON.stringify(vote(knowledge, pasted)), r2 = JSON.stringify(vote(knowledge, pasted));
check("the same inputs give the same result", r1 === r2);
check("basis hash is order-independent", basisHash(["b", "a", "c"]) === basisHash(["c", "b", "a"]) && basisHash(["a"]) !== basisHash(["b"]));
check("policy version is stamped on every vote", vote([], []).policy_version === POLICY.version);
check("describeVote reads naturally", /knowledge wins authority, independence and directness/.test(describeVote(vote(knowledge, pasted), "knowledge", "you")), describeVote(vote(knowledge, pasted), "knowledge", "you"));

console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exit(failures ? 1 : 0);
