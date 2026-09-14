// =============================================================
//  Memory store: the one save path for durable memories (design doc
//  5.7, 5.9), plus read, update, archive and delete for the caller's
//  own rows.
//
//    saveMemory     clean, scan, hash, embed, dedupe, insert or
//                   supersede, log the event, write the attestation
//    getMemory      one memory the caller may see, or null
//    listMemories   the caller's user memories plus the namespace's
//                   shared ones, with filters
//    updateMemory   edit content, kind or importance; re-embeds
//    archiveMemory  status → archived
//    deleteMemory   clears content and embedding, status → deleted
//    touchMemories  bump access counts and log 'recalled' (hook H5)
//    enforceUserCap archive the least-used memories over the cap (P4.3)
//    memoryHistory  the event log of one memory
//
//  Every function takes the full identity (organizationId, namespaceId,
//  userId) and filters on all three. A user memory is visible only to
//  its owner; a namespace memory to everyone in the namespace. A row
//  the caller may not see is indistinguishable from one that does not
//  exist. Plain functions over the service-role client.
// =============================================================

import { createHash } from "node:crypto";
import { runDLPScan } from "../lib/dlp.js";
import { hasPermission } from "../lib/permissions.js";
import { recordUsage } from "../lib/usage.js";
import { POLICY, vote, stateFromStances, basisHash, describeVote, sourceKey } from "./policy.js";
import { retentionSchemaReady } from "../retention/schema.js";

export const MEMORY_KINDS = ["fact", "preference", "decision", "entity", "task", "note"];
export const MEMORY_SCOPES = ["user", "namespace"];
export const MEMORY_MAX_CHARS = 300;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

// Source layer per source type; authority per layer comes from the
// policy (design doc 9.4), so the attestation and the vote agree.
const LAYER_AUTHORITY = POLICY.authority;
const LAYER_FOR_SOURCE = { admin: "admin", user_explicit: "user_explicit", import: "admin", extracted: "extracted", validation: "user_explicit" };
const STANCES = ["asserts", "denies", "reports", "questions"];
const STRENGTHS = ["direct_statement", "allegation", "inference", "observation", "measurement", "computation", "expert_judgment"];
const RELATIONS = ["same", "different_value", "unrelated"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID.test(v);

const MEMORY_FIELDS =
  "id, organization_id, namespace_id, user_id, scope, kind, content, importance, confidence, source_type, " +
  "source_conversation_id, source_message_id, supersedes_id, suggested_shared, status, access_count, last_accessed_at, " +
  "expires_at, subject, predicate, semantic_key, truth_status, superseded_at, created_at, updated_at";

function requireIdentity(identity) {
  if (!identity?.organizationId || !identity?.namespaceId || !identity?.userId) {
    throw new Error("memory: identity must carry organizationId, namespaceId and userId");
  }
}

/** Rows the caller may see: their own user memories and the namespace's shared ones. */
function visible(query, identity) {
  return query
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .or(`and(scope.eq.user,user_id.eq.${identity.userId}),and(scope.eq.namespace,user_id.is.null)`);
}

/** Whitespace-collapsed, trimmed, capped. */
export function normalizeContent(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CHARS);
}

/** Case- and punctuation-insensitive hash, so "FY starts July 1." and "fy starts july 1" are one memory. */
export function contentHash(text = "") {
  const key = normalizeContent(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return createHash("sha256").update(key).digest("hex");
}

export function semanticKey(subject, predicate) {
  const s = String(subject || "").toLowerCase().replace(/\s+/g, " ").trim();
  const p = String(predicate || "").toLowerCase().replace(/\s+/g, " ").trim();
  return s && p ? `${s}|${p}` : null;
}

/** One embedding. Records the call on the turn's usage tally when given one. */
export async function embedText(openai, text, { usage = null, stage = "embed" } = {}) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: String(text).slice(0, 4000) });
  recordUsage(usage, stage, EMBED_MODEL, res.usage);
  return res.data[0].embedding;
}

async function logEvent(supabase, row, log) {
  const { error } = await supabase.from("memory_events").insert([row]);
  if (error) log?.warn?.({ err: error.message, event: row.event }, "memory: event log failed");
}

/** Can this caller create or edit a memory of this scope? (D2: shared ones are admin-only by hand.) */
export function mayWriteScope(identity, scope) {
  if (!hasPermission(identity, "memory_write")) return false;
  if (scope === "namespace") return hasPermission(identity, "admin");
  return true;
}

/**
 * Save one memory. Returns { memory, action } where action is
 * 'created', 'superseded' (created and an older near-duplicate marked
 * superseded), 'duplicate' (an identical active memory already exists;
 * that one is returned) or 'blocked' (sensitive data; nothing saved).
 *
 * @param {object} supabase
 * @param {object} openai
 * @param {{organizationId,namespaceId,userId,role}} identity
 * @param {{content, kind?, scope?, importance?, sourceType?, sourceConversationId?, sourceMessageId?, supersedesId?, targetId?, relation?, stance?, subject?, predicate?, expiresAt?, suggestedShared?, actor?, confidence?, strength?, embedding?}} input
 *   embedding: an embedding of the content computed already (skips the embedding call)
 *   stance: asserts (default) | denies | reports | questions
 *   relation / targetId (or supersedesId): how this claim relates to an existing memory, when a caller already knows
 *   Returns { memory, action, truthStatus, counterpart? } where action is created | superseded | duplicate |
 *   accepted | denied | contested (after a vote against another source) | retracted | denial_recorded
 * @param {{settings?, usage?, log?}} opts
 */
export async function saveMemory(supabase, openai, identity, input = {}, { settings = null, usage = null, log = null } = {}) {
  requireIdentity(identity);
  const scope = MEMORY_SCOPES.includes(input.scope) ? input.scope : "user";
  const kind = MEMORY_KINDS.includes(input.kind) ? input.kind : "note";
  const sourceType = ["user_explicit", "extracted", "import", "admin", "validation"].includes(input.sourceType) ? input.sourceType : "user_explicit";
  const importance = Math.min(5, Math.max(1, Math.round(Number(input.importance) || 3)));
  const actor = input.actor || identity.userId;

  if (!mayWriteScope(identity, scope)) {
    const err = new Error(scope === "namespace" ? "Only admins can create shared memories." : "Your role can't save memories.");
    err.statusCode = 403;
    throw err;
  }

  const content = normalizeContent(input.content);
  if (!content) {
    const err = new Error("Nothing to remember.");
    err.statusCode = 400;
    throw err;
  }

  // Sensitive-data scan before anything is stored. Blocked candidates
  // are dropped and the fact that one was dropped is logged, not its text.
  const dlp = runDLPScan(content);
  if (dlp.block) {
    await logEvent(supabase, {
      memory_id: null, event: "blocked", actor, actor_organization_id: identity.organizationId,
      target_organization_id: identity.organizationId, target_user_id: identity.userId,
      conversation_id: input.sourceConversationId || null, message_id: input.sourceMessageId || null,
      detail: { reason: dlp.reason, source_type: sourceType },
    }, log);
    log?.warn?.({ reason: dlp.reason }, "memory: candidate blocked by DLP");
    return { memory: null, action: "blocked" };
  }
  const cleaned = normalizeContent(dlp.sanitized);
  const hash = contentHash(cleaned);
  const ownerUserId = scope === "user" ? identity.userId : null;

  const stance = STANCES.includes(input.stance) ? input.stance : "asserts";
  // What this write attests: the source, its layer and authority, and the
  // seam fields. Scope decides the layer for a hand-written note: a shared
  // note is an admin's, a private one is the user's own statement.
  const layerSource = scope === "namespace" && sourceType === "user_explicit" ? "admin" : sourceType;
  const sourceConversationId = isUuid(input.sourceConversationId) ? input.sourceConversationId : null;
  const sourceMessageId = isUuid(input.sourceMessageId) ? input.sourceMessageId : null;
  const attestSpec = {
    stance,
    strength: STRENGTHS.includes(input.strength) ? input.strength : "direct_statement",
    source_layer: LAYER_FOR_SOURCE[layerSource] || "user_explicit",
    source_ref: sourceConversationId ? { conversation_id: sourceConversationId, message_id: sourceMessageId } : { actor: identity.userId },
    authority_score: LAYER_AUTHORITY[LAYER_FOR_SOURCE[layerSource]] ?? 0.5,
    confidence: Number.isFinite(Number(input.confidence)) ? Math.min(1, Math.max(0, Number(input.confidence))) : 1.0,
    extraction_method: sourceType === "extracted" ? "llm_extract" : sourceType === "import" || sourceType === "admin" ? "admin_import" : "user",
    // a user's own statement about their own matters is first-party and not self-serving (9.4)
    first_party: scope === "user" && (sourceType === "user_explicit" || sourceType === "extracted") ? true : null,
    self_serving: scope === "user" && (sourceType === "user_explicit" || sourceType === "extracted") ? false : null,
    actor: identity.userId,                    // the person behind the write; the event actor may be a system name
  };
  const eventBase = {
    actor, actor_organization_id: identity.organizationId, target_organization_id: identity.organizationId,
    target_user_id: ownerUserId, conversation_id: sourceConversationId, message_id: sourceMessageId,
  };
  const ctx = { supabase, identity, log, eventBase };

  // Exact duplicate: the same normalised text already active for this
  // owner. A second source saying the same thing strengthens it (9.3:
  // duplicates are attestations of one proposition, not rivals).
  {
    let q = supabase
      .from("memories")
      .select(MEMORY_FIELDS)
      .eq("organization_id", identity.organizationId)
      .eq("namespace_id", identity.namespaceId)
      .eq("scope", scope)
      .eq("content_hash", hash)
      .eq("status", "active");
    q = ownerUserId ? q.eq("user_id", ownerUserId) : q.is("user_id", null);
    const { data: dup, error } = await q.maybeSingle();
    if (error) throw new Error(`memory: duplicate check failed: ${error.message}`);
    if (dup) {
      if (stance === "denies") return denyProposition(ctx, dup, attestSpec);
      const attested = await attestIfNewSource(ctx, dup, attestSpec);
      return { memory: attested ? await getMemory(supabase, identity, dup.id) : dup, action: "duplicate", attested, truthStatus: dup.truth_status };
    }
  }

  const embedding =
    Array.isArray(input.embedding) && input.embedding.length && cleaned === normalizeContent(input.content)
      ? input.embedding
      : await embedText(openai, cleaned, { usage, stage: "memory_embed" });

  // ---- Find the proposition this write is about (9.5 step 1): an explicit
  // target from the caller, else the nearest active memory of the same
  // scope within the near-duplicate threshold, else the same semantic key.
  // `relation` says how the new claim relates to it: "same" (restates it),
  // "different_value" (same subject, another value) or "unrelated".
  let target = null;
  let relation = RELATIONS.includes(input.relation) ? input.relation : null;
  const nearDupSim = Number(settings?.near_dup_sim ?? process.env.MEMORY_NEAR_DUP_SIM ?? POLICY.nearDuplicate);
  const targetId = isUuid(input.supersedesId) ? input.supersedesId : isUuid(input.targetId) ? input.targetId : null;
  if (relation !== "unrelated") {
    if (targetId) {
      const t = await getMemory(supabase, identity, targetId);
      if (t && t.scope === scope && t.status === "active") { target = t; relation = relation || "different_value"; }
    }
    if (!target) {
      const { data: near, error } = await supabase.rpc("match_memories", {
        query_embedding: embedding,
        query_organization_id: identity.organizationId,
        query_namespace_id: identity.namespaceId,
        query_user_id: identity.userId,
        match_count: 5,
        include_shared: scope === "namespace",
      });
      if (error) throw new Error(`memory: near-duplicate check failed: ${error.message}`);
      // A near duplicate with no relation stated is the same proposition
      // (9.3): it gains an attestation rather than replacing the row. A
      // caller that knows the value changed says so with relation or
      // supersedesId (extraction and the remember path both do).
      const best = (near || []).filter((r) => r.scope === scope).sort((a, b) => b.similarity - a.similarity)[0];
      if (best && best.similarity >= nearDupSim) { target = await getMemory(supabase, identity, best.id); relation = relation || "same"; }
    }
    if (!target && row_semanticKey(input)) {
      let q = supabase.from("memories").select(MEMORY_FIELDS)
        .eq("organization_id", identity.organizationId).eq("namespace_id", identity.namespaceId)
        .eq("scope", scope).eq("status", "active").eq("semantic_key", row_semanticKey(input));
      q = ownerUserId ? q.eq("user_id", ownerUserId) : q.is("user_id", null);
      const { data } = await q.order("created_at", { ascending: false }).limit(1);
      if (data?.[0]) { target = data[0]; relation = relation || "different_value"; }
    }
  }

  // ---- The same claim again, from possibly another source: attest, do not duplicate.
  if (target && relation === "same") {
    if (stance === "denies") return denyProposition(ctx, target, attestSpec);
    const attested = await attestIfNewSource(ctx, target, attestSpec);
    return { memory: attested ? await getMemory(supabase, identity, target.id) : target, action: "duplicate", attested, truthStatus: target.truth_status };
  }

  // ---- A denial of what the target says (9.5: retractions first).
  if (target && stance === "denies") return denyProposition(ctx, target, attestSpec);

  // ---- A different value for the same subject: supersession when the
  // same person said the earlier one (9.5: UPDATE, the only place recency
  // decides), otherwise a second proposition and the vote.
  let supersedesId = null;
  let contest = null;
  if (target) {
    const tAtts = await liveAttestations(supabase, target.id);
    const sameActor = tAtts.some((a) => a.stance === "asserts" && a.actor === identity.userId);
    if (sameActor) supersedesId = target.id;
    else contest = target;
  }

  const row = {
    organization_id: identity.organizationId,
    namespace_id: identity.namespaceId,
    user_id: ownerUserId,
    scope,
    kind,
    content: cleaned,
    content_hash: hash,
    embedding,
    importance,
    confidence: attestSpec.confidence,
    source_type: sourceType,
    source_conversation_id: sourceConversationId,
    source_message_id: sourceMessageId,
    supersedes_id: supersedesId,
    suggested_shared: Boolean(input.suggestedShared),
    expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    subject: input.subject ? String(input.subject).slice(0, 120) : null,
    predicate: input.predicate ? String(input.predicate).slice(0, 120) : null,
    semantic_key: semanticKey(input.subject, input.predicate),
    truth_status: stance === "reports" ? "reported" : stance === "asserts" ? "accepted" : "unknown",
  };
  const { data: memory, error: insErr } = await supabase.from("memories").insert([row]).select(MEMORY_FIELDS).single();
  if (insErr) {
    // a concurrent identical save: return the row that won
    if (/duplicate key/i.test(insErr.message)) {
      let q = supabase.from("memories").select(MEMORY_FIELDS).eq("namespace_id", identity.namespaceId).eq("content_hash", hash).eq("status", "active");
      q = ownerUserId ? q.eq("user_id", ownerUserId) : q.is("user_id", null);
      const { data: dup } = await q.maybeSingle();
      if (dup) return { memory: dup, action: "duplicate" };
    }
    throw new Error(`memory: insert failed: ${insErr.message}`);
  }

  await logEvent(supabase, {
    ...eventBase, memory_id: memory.id, event: "created",
    detail: { source_type: sourceType, scope, kind, stance, supersedes: supersedesId, contests: contest?.id || null },
  }, log);

  // Seam step: one attestation per write; policy step: one state per write.
  const attestation = await addAttestation(ctx, memory.id, attestSpec);

  let action = "created";
  let truthStatus = row.truth_status;
  let counterpart = null;
  if (supersedesId) {
    const { error: supErr } = await supabase
      .from("memories")
      .update({ status: "superseded", truth_status: "superseded", superseded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", supersedesId)
      .eq("organization_id", identity.organizationId)
      .eq("namespace_id", identity.namespaceId)
      .eq("status", "active");
    if (supErr) log?.warn?.({ err: supErr.message, supersedesId }, "memory: supersede update failed");
    else {
      action = "superseded";
      await logEvent(supabase, { ...eventBase, memory_id: supersedesId, event: "superseded", detail: { superseded_by: memory.id } }, log);
      await writeState(ctx, target, { truthStatus: "superseded", counterpartId: memory.id, reason: "a later statement by the same person gives a different value", basis: (await liveAttestations(supabase, target.id)).map((a) => ({ id: a.id, role: "neutral" })), event: null });
    }
    await writeState(ctx, memory, { truthStatus, reason: `${stance === "reports" ? "reported" : "asserted"} by its source; replaces an earlier note`, basis: attestation ? [{ id: attestation.id, role: "supporting" }] : [], event: null });
  } else if (contest) {
    const current = await currentState(supabase, contest.id);
    if (current?.review_status === "overridden") {
      // an admin decision stands until an admin changes it (9.4)
      truthStatus = "denied";
      action = "denied";
      counterpart = contest;
      await writeState(ctx, memory, { truthStatus, counterpartId: contest.id, reason: "an admin's decision on the other note stands", basis: attestation ? [{ id: attestation.id, role: "neutral" }] : [], event: "resolved" });
      await supabase.from("memories").update({ truth_status: "denied", updated_at: new Date().toISOString() }).eq("id", memory.id);
    } else {
      const outcome = await resolvePair(ctx, contest, memory);
      truthStatus = outcome.truthStatus;
      action = outcome.truthStatus;                      // accepted | denied | contested
      counterpart = contest;
    }
  } else {
    await writeState(ctx, memory, { truthStatus, reason: stance === "reports" ? "reported second-hand by its source" : stance === "asserts" ? "one source asserts it and nothing disagrees" : "an open question", basis: attestation ? [{ id: attestation.id, role: stance === "questions" ? "neutral" : "supporting" }] : [], event: null });
  }

  const saved = (await getMemory(supabase, identity, memory.id)) || memory;
  log?.info?.({ memoryId: memory.id, action, truthStatus, scope, kind, sourceType, counterpart: counterpart?.id || null }, "memory: saved");
  return { memory: saved, action, truthStatus, counterpart: counterpart ? { id: counterpart.id, content: counterpart.content, scope: counterpart.scope } : null };
}

const row_semanticKey = (input) => semanticKey(input.subject, input.predicate);

// =============================================================
//  Attestations and truth states (design doc 9.3, 9.5)
// =============================================================
const ATTESTATION_FIELDS = "id, memory_id, stance, strength, source_layer, source_ref, authority_score, confidence, extraction_method, first_party, self_serving, status, actor, asserted_at, invalidated_at, created_at";

let statesMissing = false;          // 0010 not applied yet: states are skipped, everything else works
function noStates(error) {
  if (!error) return false;
  if (/memory_states|memory_state_basis/.test(error.message || "") && (/does not exist|PGRST205|42P01/i.test(error.message || "") || ["42P01", "PGRST205"].includes(error.code))) {
    statesMissing = true;
    return true;
  }
  return false;
}

/** Live attestations of one proposition: accepted and not retracted. */
export async function liveAttestations(supabase, memoryId) {
  const { data, error } = await supabase.from("attestations").select(ATTESTATION_FIELDS)
    .eq("memory_id", memoryId).eq("status", "accepted").is("invalidated_at", null).order("asserted_at", { ascending: true });
  if (error) throw new Error(`memory: attestations failed: ${error.message}`);
  return data || [];
}

async function addAttestation({ supabase, identity, log, eventBase }, memoryId, spec) {
  const { data, error } = await supabase.from("attestations").insert([{
    memory_id: memoryId, organization_id: identity.organizationId, namespace_id: identity.namespaceId, ...spec,
  }]).select(ATTESTATION_FIELDS).single();
  if (error) { log?.warn?.({ err: error.message }, "memory: attestation insert failed"); return null; }
  await logEvent(supabase, { ...eventBase, memory_id: memoryId, event: "attested", detail: { attestation_id: data.id, stance: spec.stance, source_layer: spec.source_layer } }, log);
  return data;
}

/** A second source for the same claim adds an attestation; the same source again does not. */
async function attestIfNewSource(ctx, memory, spec) {
  const existing = await liveAttestations(ctx.supabase, memory.id);
  const key = sourceKey({ source_ref: spec.source_ref, actor: spec.actor });
  if (existing.some((a) => a.stance === spec.stance && sourceKey(a) === key)) return false;
  const att = await addAttestation(ctx, memory.id, spec);
  if (att) await resolveSingle(ctx, memory, { reason: "another source says the same" });
  return Boolean(att);
}

/** The open state row of one memory, or null. */
export async function currentState(supabase, memoryId) {
  if (statesMissing) return null;
  // PostgREST cannot filter on upper(range): fetch the newest row and check that its window is open
  const { data: rows, error } = await supabase.from("memory_states").select("*").eq("memory_id", memoryId).order("computed_at", { ascending: false }).limit(1);
  if (noStates(error)) return null;
  if (error) throw new Error(`memory: state lookup failed: ${error.message}`);
  const s = rows?.[0];
  return s && isOpen(s.effective_range) ? s : null;
}

const isOpen = (range) => typeof range === "string" && /,\s*\)$/.test(range.trim());
const lowerBound = (range) => (String(range || "").match(/^[\[(]\s*"?([^",]+)"?\s*,/) || [])[1] || null;

/**
 * Close the open state of a memory and open a new one (9.5): mirrors
 * truth_status onto the row, writes the basis rows and an event. Skips
 * quietly until migration 0010 exists.
 */
export async function writeState({ supabase, identity, log, eventBase }, memory, { truthStatus, reviewStatus = "auto_computed", counterpartId = null, dimensions = null, reason = null, basis = [], reviewedBy = null, reviewNote = null, event = "resolved" }) {
  if (!memory?.id) return null;
  const now = new Date().toISOString();
  const mirror = { truth_status: truthStatus, updated_at: now, ...(truthStatus === "superseded" ? { superseded_at: now } : {}) };
  await supabase.from("memories").update(mirror).eq("id", memory.id).eq("namespace_id", identity.namespaceId);
  if (statesMissing) return null;

  // close the open window
  const { data: open, error: openErr } = await supabase.from("memory_states").select("id, effective_range").eq("memory_id", memory.id).order("computed_at", { ascending: false }).limit(1);
  if (noStates(openErr)) return null;
  if (openErr) { log?.warn?.({ err: openErr.message }, "memory: state lookup failed"); return null; }
  const prev = open?.[0];
  if (prev && isOpen(prev.effective_range)) {
    const lo = lowerBound(prev.effective_range) || now;
    await supabase.from("memory_states").update({ effective_range: `[${lo},${now})` }).eq("id", prev.id);
  }
  // the new window starts exactly where the old one closed (the same
  // timestamp from this process), so clock skew between here and the
  // database can never make the two windows overlap
  const { data: state, error } = await supabase.from("memory_states").insert([{
    memory_id: memory.id, organization_id: identity.organizationId, namespace_id: identity.namespaceId,
    truth_status: truthStatus, review_status: reviewStatus, reviewed_by: reviewedBy, reviewed_at: reviewedBy ? now : null, review_note: reviewNote,
    policy_version: POLICY.version, counterpart_id: counterpartId, dimensions, reason,
    basis_hash: basisHash(basis.map((b) => b.id)),
    effective_range: `[${now},)`,
  }]).select("*").single();
  if (error) { log?.warn?.({ err: error.message }, "memory: state insert failed"); return null; }
  if (basis.length) {
    const { error: bErr } = await supabase.from("memory_state_basis").insert(basis.map((b) => ({ state_id: state.id, attestation_id: b.id, role: b.role })));
    if (bErr) log?.warn?.({ err: bErr.message }, "memory: state basis insert failed");
  }
  if (event) {
    await logEvent(supabase, {
      ...eventBase, memory_id: memory.id, event: truthStatus === "contested" ? "contested" : event,
      detail: { truth_status: truthStatus, review_status: reviewStatus, counterpart: counterpartId, reason, policy_version: POLICY.version },
    }, log);
  }
  return state;
}

/**
 * Recompute one memory's state from its own attestations: after its
 * counterpart was deleted, or to repair a stale state. Returns the state.
 */
export async function recomputeState(supabase, identity, id, { log = null, reason = "recomputed" } = {}) {
  requireIdentity(identity);
  const memory = await getMemoryAny(supabase, identity, id);
  if (!memory) return null;
  const eventBase = { actor: identity.userId, actor_organization_id: identity.organizationId, target_organization_id: identity.organizationId, target_user_id: memory.user_id };
  return resolveSingle({ supabase, identity, log, eventBase }, memory, { reason });
}

/** One proposition, resolved from its own attestations (assertions against denials). */
async function resolveSingle(ctx, memory, { reason = null } = {}) {
  const atts = await liveAttestations(ctx.supabase, memory.id);
  let truthStatus = stateFromStances(atts);
  let dimensions = null;
  let basis = atts.map((a) => ({ id: a.id, role: a.stance === "asserts" ? "supporting" : a.stance === "denies" ? "contradicting" : "neutral" }));
  let why = reason;
  if (truthStatus === null) {
    const r = vote(atts.filter((a) => a.stance === "asserts"), atts.filter((a) => a.stance === "denies"));
    truthStatus = r.winner === "a" ? "accepted" : r.winner === "b" ? "denied" : "contested";
    dimensions = { ...norm(r.dimensions), tally: { this: r.tally.a, other: r.tally.b } };
    why = describeVote(r, "the claim", "the denial");
  }
  const current = await currentState(ctx.supabase, memory.id);
  if (current && current.truth_status === truthStatus && current.basis_hash === basisHash(basis.map((b) => b.id))) return { truthStatus, changed: false };
  await writeState(ctx, memory, { truthStatus, dimensions, reason: why, basis, event: current ? "resolved" : null });
  return { truthStatus, changed: true };
}

/**
 * Two propositions with different values (9.5 "Run the vote"): the winner
 * is accepted and the other denied; short of three dimensions, both are
 * contested and point at each other.
 */
async function resolvePair(ctx, first, second) {
  const a = await liveAttestations(ctx.supabase, first.id);
  const b = await liveAttestations(ctx.supabase, second.id);
  const r = vote(a.filter((x) => x.stance === "asserts"), b.filter((x) => x.stance === "asserts"));
  const flip = (d) => ({ authority: swap(d.authority), independent: swap(d.independent), confidence: swap(d.confidence), direct: swap(d.direct), first_party: swap(d.first_party) });
  const dimsFirst = { ...norm(r.dimensions), tally: { this: r.tally.a, other: r.tally.b } };
  const dimsSecond = { ...norm(flip(r.dimensions)), tally: { this: r.tally.b, other: r.tally.a } };
  const reason = describeVote(r, "the earlier note", "the new note");
  const basisFirst = [...a.map((x) => ({ id: x.id, role: "supporting" })), ...b.map((x) => ({ id: x.id, role: "contradicting" }))];
  const basisSecond = [...b.map((x) => ({ id: x.id, role: "supporting" })), ...a.map((x) => ({ id: x.id, role: "contradicting" }))];
  const statusFirst = r.winner === "a" ? "accepted" : r.winner === "b" ? "denied" : "contested";
  const statusSecond = r.winner === "b" ? "accepted" : r.winner === "a" ? "denied" : "contested";
  await writeState(ctx, first, { truthStatus: statusFirst, counterpartId: second.id, dimensions: dimsFirst, reason, basis: basisFirst });
  await writeState(ctx, second, { truthStatus: statusSecond, counterpartId: first.id, dimensions: dimsSecond, reason, basis: basisSecond });
  return { truthStatus: statusSecond, first: statusFirst, vote: r };
}
const swap = (w) => (w === "a" ? "b" : w === "b" ? "a" : "tie");
const norm = (d) => Object.fromEntries(Object.entries(d).map(([k, w]) => [k, w === "a" ? "this" : w === "b" ? "other" : "tie"]));

/**
 * A denial of what a proposition says (9.5: retractions first). From the
 * person who asserted it, it retracts their assertion and the proposition
 * drops out of recall. From someone else, it is a denial and the vote runs.
 */
async function denyProposition(ctx, target, spec) {
  const { supabase, identity, log, eventBase } = ctx;
  const atts = await liveAttestations(supabase, target.id);
  const own = atts.filter((a) => a.stance === "asserts" && a.actor === identity.userId);
  const denial = await addAttestation(ctx, target.id, { ...spec, stance: "denies" });
  if (own.length) {
    const now = new Date().toISOString();
    await supabase.from("attestations").update({ invalidated_at: now }).in("id", own.map((a) => a.id));
    const remaining = atts.filter((a) => !own.some((o) => o.id === a.id) && a.stance === "asserts");
    if (!remaining.length) {
      await writeState(ctx, target, { truthStatus: "retracted", reason: "retracted by the person who stated it", basis: [...(denial ? [{ id: denial.id, role: "supporting" }] : []), ...own.map((a) => ({ id: a.id, role: "neutral" }))] });
      await logEvent(supabase, { ...eventBase, memory_id: target.id, event: "updated", detail: { retracted: true } }, log);
      return { memory: await getMemory(supabase, identity, target.id), action: "retracted", truthStatus: "retracted" };
    }
  }
  const { truthStatus } = await resolveSingle(ctx, target, { reason: "a denial was recorded" });
  return { memory: await getMemory(supabase, identity, target.id), action: truthStatus === "accepted" ? "denial_recorded" : truthStatus, truthStatus };
}

/**
 * Add a deciding attestation to a memory the caller may write (a user
 * confirming or denying, an admin weighing in) and re-run the vote.
 */
export async function attestMemory(supabase, identity, id, { stance = "asserts", strength = "direct_statement", note = null, log = null } = {}) {
  requireIdentity(identity);
  const memory = await getMemory(supabase, identity, id);
  if (!memory) return null;
  if (!mayWriteScope(identity, memory.scope)) { const err = new Error("You can't attest this memory."); err.statusCode = 403; throw err; }
  const layer = hasPermission(identity, "admin") && memory.scope === "namespace" ? "admin" : "user_explicit";
  const eventBase = { actor: identity.userId, actor_organization_id: identity.organizationId, target_organization_id: identity.organizationId, target_user_id: memory.user_id };
  const ctx = { supabase, identity, log, eventBase };
  const spec = {
    stance: STANCES.includes(stance) ? stance : "asserts",
    strength: STRENGTHS.includes(strength) ? strength : "direct_statement",
    source_layer: layer, source_ref: { actor: identity.userId, note: note ? String(note).slice(0, 300) : undefined },
    authority_score: LAYER_AUTHORITY[layer], confidence: 1.0, extraction_method: "user",
    first_party: memory.scope === "user" ? true : null, self_serving: memory.scope === "user" ? false : null, actor: identity.userId,
  };
  if (spec.stance === "denies") return denyProposition(ctx, memory, spec);
  const att = await addAttestation(ctx, memory.id, spec);
  const current = await currentState(supabase, memory.id);
  let truthStatus;
  if (current?.counterpart_id) {
    const other = await getMemoryAny(supabase, identity, current.counterpart_id);
    const outcome = other ? await resolvePair(ctx, other, memory) : await resolveSingle(ctx, memory);
    truthStatus = outcome.truthStatus;
  } else {
    truthStatus = (await resolveSingle(ctx, memory, { reason: "a deciding attestation was added" })).truthStatus;
  }
  return { memory: await getMemory(supabase, identity, memory.id), attestation: att, truthStatus };
}

/**
 * A person settles a contested pair (9.5 "Surface contested"): the chosen
 * side is accepted, the other denied, both marked overridden and reviewed.
 * winnerId is the memory to accept; null accepts neither (both denied).
 */
export async function resolveContested(supabase, identity, id, { winnerId = null, note = null, log = null } = {}) {
  requireIdentity(identity);
  const memory = await getMemory(supabase, identity, id);
  if (!memory) return null;
  if (!mayWriteScope(identity, memory.scope)) { const err = new Error("You can't resolve this memory."); err.statusCode = 403; throw err; }
  const current = await currentState(supabase, memory.id);
  const other = current?.counterpart_id ? await getMemoryAny(supabase, identity, current.counterpart_id) : null;
  const pair = other ? [memory, other] : [memory];
  if (winnerId && !pair.some((m) => m.id === winnerId)) { const err = new Error("winner_id must be this memory or its counterpart."); err.statusCode = 400; throw err; }
  const eventBase = { actor: identity.userId, actor_organization_id: identity.organizationId, target_organization_id: identity.organizationId, target_user_id: memory.user_id };
  const ctx = { supabase, identity, log, eventBase };
  for (const m of pair) {
    const atts = await liveAttestations(supabase, m.id);
    const truthStatus = m.id === winnerId ? "accepted" : "denied";
    await writeState(ctx, m, {
      truthStatus, reviewStatus: "overridden", reviewedBy: identity.userId, reviewNote: note ? String(note).slice(0, 500) : null,
      counterpartId: pair.find((x) => x.id !== m.id)?.id || null,
      reason: winnerId ? (m.id === winnerId ? "chosen by a person" : "set aside by a person") : "set aside by a person",
      basis: atts.map((a) => ({ id: a.id, role: "neutral" })), event: "reviewed",
    });
  }
  return { memory: await getMemory(supabase, identity, memory.id), counterpart: other ? await getMemoryAny(supabase, identity, other.id) : null, winnerId };
}

/** The counterpart of a contested memory may be another user's private note; fetch it within the namespace. */
async function getMemoryAny(supabase, identity, id) {
  if (!isUuid(id)) return null;
  const { data } = await supabase.from("memories").select(MEMORY_FIELDS).eq("id", id).eq("organization_id", identity.organizationId).eq("namespace_id", identity.namespaceId).maybeSingle();
  return data || null;
}

/** The belief history of one memory the caller may see: every state with its basis, newest first. */
export async function memoryStates(supabase, identity, id) {
  requireIdentity(identity);
  const memory = await getMemory(supabase, identity, id);
  if (!memory) return null;
  const { data: states, error } = await supabase.from("memory_states").select("*").eq("memory_id", id).order("computed_at", { ascending: false });
  if (noStates(error)) return { memory, states: [], attestations: [] };
  if (error) throw new Error(`memory: states failed: ${error.message}`);
  const ids = (states || []).map((s) => s.id);
  const { data: basis } = ids.length ? await supabase.from("memory_state_basis").select("state_id, attestation_id, role").in("state_id", ids) : { data: [] };
  const { data: atts } = await supabase.from("attestations").select(ATTESTATION_FIELDS).eq("memory_id", id).order("asserted_at", { ascending: true });
  return {
    memory,
    states: (states || []).map((s) => ({ ...s, basis: (basis || []).filter((b) => b.state_id === s.id).map(({ attestation_id, role }) => ({ attestation_id, role })) })),
    attestations: atts || [],
  };
}

/** What the state of a memory was at a moment: the row whose window contains it. */
export function stateAsOf(states = [], at = new Date()) {
  const t = new Date(at).getTime();
  return states.find((s) => {
    const lo = lowerBound(s.effective_range);
    const hiMatch = String(s.effective_range || "").match(/,\s*"?([^")\]]+)"?\s*[)\]]$/);
    const hi = hiMatch ? new Date(hiMatch[1]).getTime() : Infinity;
    return lo && new Date(lo).getTime() <= t && t < hi;
  }) || null;
}

/** Contested memories the caller may see, each with its current state and counterpart. */
export async function listContested(supabase, identity, { limit = 50 } = {}) {
  requireIdentity(identity);
  const rows = await listMemories(supabase, identity, { limit, status: "active" }).then((all) => all.filter((m) => m.truth_status === "contested"));
  const out = [];
  for (const m of rows) {
    const state = await currentState(supabase, m.id);
    const other = state?.counterpart_id ? await getMemoryAny(supabase, identity, state.counterpart_id) : null;
    out.push({ memory: m, state, counterpart: other ? { id: other.id, scope: other.scope, content: other.content, truth_status: other.truth_status } : null });
  }
  return out;
}

/** One memory the caller may see (any status), or null. */
/**
 * The read fields, plus source_purged_at (retention, migration 0013)
 * once the column exists: a note that outlived its source chat says so.
 */
async function readFields(supabase) {
  return (await retentionSchemaReady(supabase)) ? `${MEMORY_FIELDS}, source_purged_at` : MEMORY_FIELDS;
}

export async function getMemory(supabase, identity, id) {
  requireIdentity(identity);
  if (!isUuid(id)) return null;
  const { data, error } = await visible(supabase.from("memories").select(await readFields(supabase)).eq("id", id), identity).maybeSingle();
  if (error) throw new Error(`memory: lookup failed: ${error.message}`);
  return data || null;
}

/**
 * The caller's memories: own user-scope rows plus the namespace's shared
 * rows. Filters: scope, kind, status (default active), q (keyword search),
 * source ("purged" = notes whose source chat was purged or deleted).
 */
export async function listMemories(supabase, identity, { scope = null, kind = null, status = "active", q = null, source = null, limit = 50, offset = 0 } = {}) {
  requireIdentity(identity);
  const fields = await readFields(supabase);
  let query = visible(supabase.from("memories").select(fields), identity);
  if (scope && MEMORY_SCOPES.includes(scope)) query = query.eq("scope", scope);
  if (kind && MEMORY_KINDS.includes(kind)) query = query.eq("kind", kind);
  if (status && status !== "all") query = query.eq("status", status);
  if (source === "purged" && fields !== MEMORY_FIELDS) query = query.not("source_purged_at", "is", null);
  if (source === "linked" && fields !== MEMORY_FIELDS) query = query.is("source_purged_at", null);
  // keyword filter on the tsv column, so archived and superseded rows can be searched too
  if (q && String(q).trim()) query = query.textSearch("tsv", String(q).slice(0, 200), { type: "websearch", config: "english" });
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`memory: list failed: ${error.message}`);
  return data || [];
}

/** Edit content, kind or importance of a memory the caller may write. Re-embeds on a content change. */
export async function updateMemory(supabase, openai, identity, id, patch = {}, { log = null } = {}) {
  requireIdentity(identity);
  const existing = await getMemory(supabase, identity, id);
  if (!existing) return null;
  if (!mayWriteScope(identity, existing.scope)) {
    const err = new Error("You can't edit this memory.");
    err.statusCode = 403;
    throw err;
  }
  if (existing.status !== "active") {
    const err = new Error("Only active memories can be edited.");
    err.statusCode = 409;
    throw err;
  }
  const update = { updated_at: new Date().toISOString() };
  const changed = {};
  if (patch.content !== undefined) {
    const content = normalizeContent(patch.content);
    if (!content) { const err = new Error("Content can't be empty."); err.statusCode = 400; throw err; }
    const dlp = runDLPScan(content);
    if (dlp.block) { const err = new Error("Sensitive data blocked"); err.statusCode = 400; throw err; }
    const cleaned = normalizeContent(dlp.sanitized);
    if (cleaned !== existing.content) {
      update.content = cleaned;
      update.content_hash = contentHash(cleaned);
      update.embedding = await embedText(openai, cleaned);
      changed.content = true;
    }
  }
  if (patch.kind !== undefined && MEMORY_KINDS.includes(patch.kind) && patch.kind !== existing.kind) { update.kind = patch.kind; changed.kind = patch.kind; }
  if (patch.importance !== undefined) {
    const imp = Math.min(5, Math.max(1, Math.round(Number(patch.importance) || existing.importance)));
    if (imp !== existing.importance) { update.importance = imp; changed.importance = imp; }
  }
  if (patch.subject !== undefined || patch.predicate !== undefined) {
    update.subject = patch.subject !== undefined ? (patch.subject ? String(patch.subject).slice(0, 120) : null) : existing.subject;
    update.predicate = patch.predicate !== undefined ? (patch.predicate ? String(patch.predicate).slice(0, 120) : null) : existing.predicate;
    update.semantic_key = semanticKey(update.subject, update.predicate);
    changed.proposition = true;
  }
  if (!Object.keys(changed).length) return existing;

  const { data, error } = await supabase
    .from("memories")
    .update(update)
    .eq("id", id)
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .select(MEMORY_FIELDS)
    .single();
  if (error) {
    if (/duplicate key/i.test(error.message)) { const err = new Error("An identical memory already exists."); err.statusCode = 409; throw err; }
    throw new Error(`memory: update failed: ${error.message}`);
  }
  await logEvent(supabase, {
    memory_id: id, event: "updated", actor: identity.userId, actor_organization_id: identity.organizationId,
    target_organization_id: identity.organizationId, target_user_id: existing.user_id, detail: changed,
  }, log);
  return data;
}

export async function archiveMemory(supabase, identity, id, archived = true, { actor = null, log = null } = {}) {
  requireIdentity(identity);
  const existing = await getMemory(supabase, identity, id);
  if (!existing) return null;
  if (!mayWriteScope(identity, existing.scope)) { const err = new Error("You can't change this memory."); err.statusCode = 403; throw err; }
  const from = archived ? "active" : "archived";
  const to = archived ? "archived" : "active";
  if (existing.status !== from) return existing;
  const { data, error } = await supabase
    .from("memories")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .select(MEMORY_FIELDS)
    .single();
  if (error) throw new Error(`memory: archive failed: ${error.message}`);
  await logEvent(supabase, {
    memory_id: id, event: archived ? "archived" : "updated", actor: actor || identity.userId, actor_organization_id: identity.organizationId,
    target_organization_id: identity.organizationId, target_user_id: existing.user_id, detail: archived ? null : { restored: true },
  }, log);
  if (archived) await releaseCounterpart(supabase, identity, id, log);
  return data;
}

/**
 * Real deletion: content and embedding are cleared and the row is marked
 * deleted. The log records that a deletion happened, not what was deleted.
 * Returns true when a row was deleted, false when there was nothing to delete.
 */
export async function deleteMemory(supabase, identity, id, { actor = null, log = null } = {}) {
  requireIdentity(identity);
  const existing = await getMemory(supabase, identity, id);
  if (!existing || existing.status === "deleted") return false;
  if (!mayWriteScope(identity, existing.scope)) { const err = new Error("You can't delete this memory."); err.statusCode = 403; throw err; }
  const { error } = await supabase
    .from("memories")
    .update({ content: "", content_hash: "", embedding: null, subject: null, predicate: null, semantic_key: null, status: "deleted", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId);
  if (error) throw new Error(`memory: delete failed: ${error.message}`);
  await logEvent(supabase, {
    memory_id: id, event: "deleted", actor: actor || identity.userId, actor_organization_id: identity.organizationId,
    target_organization_id: identity.organizationId, target_user_id: existing.user_id,
  }, log);
  await releaseCounterpart(supabase, identity, id, log);
  await restorePredecessor(supabase, identity, existing, log);
  return true;
}

/**
 * Deleting a note that had replaced an earlier one brings the earlier one
 * back, so a fact never vanishes silently: the person deleted the update,
 * not the history. It returns as active and is re-resolved; the belief
 * history keeps both windows.
 */
async function restorePredecessor(supabase, identity, deleted, log) {
  if (!isUuid(deleted?.supersedes_id)) return;
  try {
    const { data: prev } = await supabase.from("memories").select(MEMORY_FIELDS).eq("id", deleted.supersedes_id)
      .eq("organization_id", identity.organizationId).eq("namespace_id", identity.namespaceId).eq("status", "superseded").maybeSingle();
    if (!prev) return;
    const { data: others } = await supabase.from("memories").select("id").eq("supersedes_id", prev.id).eq("status", "active").neq("id", deleted.id);
    if (others?.length) return;                            // another successor still stands
    await supabase.from("memories").update({ status: "active", truth_status: "accepted", superseded_at: null, updated_at: new Date().toISOString() }).eq("id", prev.id);
    await logEvent(supabase, {
      memory_id: prev.id, event: "updated", actor: identity.userId, actor_organization_id: identity.organizationId,
      target_organization_id: identity.organizationId, target_user_id: prev.user_id, detail: { restored: true, reason: "the note that replaced it was deleted", deleted: deleted.id },
    }, log);
    await recomputeState(supabase, identity, prev.id, { log, reason: "restored: the note that replaced it was deleted" });
  } catch (err) { log?.warn?.({ err: err?.message }, "memory: predecessor restore failed"); }
}

/** When a memory leaves the active set, a counterpart it was contested with is resolved from its own attestations. */
async function releaseCounterpart(supabase, identity, id, log) {
  try {
    const state = await currentState(supabase, id);
    if (state?.counterpart_id) await recomputeState(supabase, identity, state.counterpart_id, { log, reason: "its counterpart is no longer active" });
  } catch (err) { log?.warn?.({ err: err?.message }, "memory: counterpart recompute failed"); }
}

/**
 * Hook H5: the answer used these memories. Bump their counters and log
 * one 'recalled' event each, with the conversation and message.
 */
export async function touchMemories(supabase, identity, ids = [], { conversationId = null, messageId = null, log = null } = {}) {
  requireIdentity(identity);
  const wanted = [...new Set((ids || []).filter(isUuid))];
  if (!wanted.length) return 0;
  // only ids that are active rows of this namespace: a stray id would break
  // the event insert's foreign key and lose the whole batch
  const { data: rows, error: selErr } = await supabase
    .from("memories").select("id").in("id", wanted)
    .eq("organization_id", identity.organizationId).eq("namespace_id", identity.namespaceId).eq("status", "active");
  if (selErr) { log?.warn?.({ err: selErr.message }, "memory: touch lookup failed"); return 0; }
  const list = (rows || []).map((r) => r.id);
  if (!list.length) return 0;
  const { data, error } = await supabase.rpc("touch_memories", {
    p_ids: list, p_organization_id: identity.organizationId, p_namespace_id: identity.namespaceId,
  });
  if (error) { log?.warn?.({ err: error.message }, "memory: touch failed"); return 0; }
  const { error: evErr } = await supabase.from("memory_events").insert(list.map((id) => ({
    memory_id: id, event: "recalled", actor: "system:recall", actor_organization_id: identity.organizationId,
    target_organization_id: identity.organizationId, target_user_id: identity.userId,
    conversation_id: isUuid(conversationId) ? conversationId : null, message_id: isUuid(messageId) ? messageId : null,
  })));
  if (evErr) log?.warn?.({ err: evErr.message }, "memory: recalled events failed");
  return Number(data) || list.length;
}

/** The event log of one memory the caller may see, newest first. */
export async function memoryHistory(supabase, identity, id, { limit = 100 } = {}) {
  requireIdentity(identity);
  const existing = await getMemory(supabase, identity, id);
  if (!existing) return null;
  const { data, error } = await supabase
    .from("memory_events")
    .select("id, event, actor, conversation_id, message_id, detail, cross_tenant, reason, created_at")
    .eq("memory_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`memory: history failed: ${error.message}`);
  return { memory: existing, events: data || [] };
}

/**
 * P4.3: when the caller has more active user memories than the cap,
 * archive the excess, least used first (fewest recalls, then longest
 * since last use, then oldest). Superseded and archived rows do not
 * count. Returns how many were archived.
 */
export async function enforceUserCap(supabase, identity, cap, { log = null } = {}) {
  requireIdentity(identity);
  const limit = Math.floor(Number(cap));
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const count = await countActiveUserMemories(supabase, identity);
  const excess = count - limit;
  if (excess <= 0) return 0;

  const { data: victims, error } = await supabase
    .from("memories")
    .select("id")
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId)
    .eq("scope", "user")
    .eq("status", "active")
    .order("access_count", { ascending: true })
    .order("last_accessed_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(excess);
  if (error) throw new Error(`memory: cap sweep lookup failed: ${error.message}`);
  const ids = (victims || []).map((r) => r.id);
  if (!ids.length) return 0;

  const { error: updErr } = await supabase
    .from("memories")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .in("id", ids)
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("status", "active");
  if (updErr) throw new Error(`memory: cap sweep failed: ${updErr.message}`);
  const { error: evErr } = await supabase.from("memory_events").insert(ids.map((id) => ({
    memory_id: id, event: "archived", actor: "system:cap", actor_organization_id: identity.organizationId,
    target_organization_id: identity.organizationId, target_user_id: identity.userId,
    detail: { reason: "over the per-user cap", cap: limit, active: count },
  })));
  if (evErr) log?.warn?.({ err: evErr.message }, "memory: cap sweep events failed");
  log?.info?.({ archived: ids.length, cap: limit, active: count }, "memory: cap sweep");
  return ids.length;
}

/** Active memories owned by the caller (the per-user cap counts these). */
export async function countActiveUserMemories(supabase, identity) {
  requireIdentity(identity);
  const { count, error } = await supabase
    .from("memories")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId)
    .eq("scope", "user")
    .eq("status", "active");
  if (error) throw new Error(`memory: count failed: ${error.message}`);
  return count || 0;
}
