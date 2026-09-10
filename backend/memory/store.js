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

export const MEMORY_KINDS = ["fact", "preference", "decision", "entity", "task", "note"];
export const MEMORY_SCOPES = ["user", "namespace"];
export const MEMORY_MAX_CHARS = 300;
const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

// Authority per source layer for the attestation row (design doc 9,
// seam step): constants until per-source evaluation exists.
const LAYER_AUTHORITY = { admin: 0.9, user_explicit: 0.8, import: 0.7, extracted: 0.5, validation: 0.1 };
const LAYER_FOR_SOURCE = { admin: "admin", user_explicit: "user_explicit", import: "admin", extracted: "extracted", validation: "user_explicit" };

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

export async function embedText(openai, text) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: String(text).slice(0, 4000) });
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
 * @param {{content, kind?, scope?, importance?, sourceType?, sourceConversationId?, sourceMessageId?, supersedesId?, subject?, predicate?, expiresAt?, suggestedShared?, actor?, confidence?, strength?}} input
 * @param {{settings?, log?}} opts
 */
export async function saveMemory(supabase, openai, identity, input = {}, { settings = null, log = null } = {}) {
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

  // Exact duplicate: the same normalised text already active for this owner.
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
    if (dup) return { memory: dup, action: "duplicate" };
  }

  const embedding = await embedText(openai, cleaned);

  // Near duplicate: the closest active memory of the same scope for this
  // owner at or above the threshold is superseded by the new one.
  let supersedesId = isUuid(input.supersedesId) ? input.supersedesId : null;
  const nearDupSim = Number(settings?.near_dup_sim ?? process.env.MEMORY_NEAR_DUP_SIM ?? 0.92);
  if (!supersedesId) {
    const { data: near, error } = await supabase.rpc("match_memories", {
      query_embedding: embedding,
      query_organization_id: identity.organizationId,
      query_namespace_id: identity.namespaceId,
      query_user_id: identity.userId,
      match_count: 5,
      include_shared: scope === "namespace",
    });
    if (error) throw new Error(`memory: near-duplicate check failed: ${error.message}`);
    const best = (near || []).filter((r) => r.scope === scope).sort((a, b) => b.similarity - a.similarity)[0];
    if (best && best.similarity >= nearDupSim) supersedesId = best.id;
  } else {
    // an explicit supersedes must be a memory the caller may see
    const target = await getMemory(supabase, identity, supersedesId);
    if (!target || target.scope !== scope) supersedesId = null;
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
    confidence: Number.isFinite(Number(input.confidence)) ? Math.min(1, Math.max(0, Number(input.confidence))) : 1.0,
    source_type: sourceType,
    source_conversation_id: isUuid(input.sourceConversationId) ? input.sourceConversationId : null,
    source_message_id: isUuid(input.sourceMessageId) ? input.sourceMessageId : null,
    supersedes_id: supersedesId,
    suggested_shared: Boolean(input.suggestedShared),
    expires_at: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    subject: input.subject ? String(input.subject).slice(0, 120) : null,
    predicate: input.predicate ? String(input.predicate).slice(0, 120) : null,
    semantic_key: semanticKey(input.subject, input.predicate),
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

  let action = "created";
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
      await logEvent(supabase, {
        memory_id: supersedesId, event: "superseded", actor, actor_organization_id: identity.organizationId,
        target_organization_id: identity.organizationId, target_user_id: ownerUserId,
        conversation_id: row.source_conversation_id, message_id: row.source_message_id,
        detail: { superseded_by: memory.id },
      }, log);
    }
  }

  await logEvent(supabase, {
    memory_id: memory.id, event: "created", actor, actor_organization_id: identity.organizationId,
    target_organization_id: identity.organizationId, target_user_id: ownerUserId,
    conversation_id: row.source_conversation_id, message_id: row.source_message_id,
    detail: { source_type: sourceType, scope, kind, supersedes: supersedesId },
  }, log);

  // Seam step: one attestation per write.
  const layer = LAYER_FOR_SOURCE[sourceType] || "user_explicit";
  const { error: attErr } = await supabase.from("attestations").insert([{
    memory_id: memory.id,
    organization_id: identity.organizationId,
    namespace_id: identity.namespaceId,
    stance: "asserts",
    strength: ["direct_statement", "allegation", "inference", "observation", "measurement", "computation", "expert_judgment"].includes(input.strength) ? input.strength : "direct_statement",
    source_layer: layer,
    source_ref: row.source_conversation_id ? { conversation_id: row.source_conversation_id, message_id: row.source_message_id } : { actor },
    authority_score: LAYER_AUTHORITY[sourceType] ?? 0.5,
    confidence: row.confidence,
    extraction_method: sourceType === "extracted" ? "llm_extract" : sourceType === "import" || sourceType === "admin" ? "admin_import" : "user",
    first_party: sourceType === "user_explicit" ? true : null,
    actor,
  }]);
  if (attErr) log?.warn?.({ err: attErr.message }, "memory: attestation insert failed");

  log?.info?.({ memoryId: memory.id, action, scope, kind, sourceType }, "memory: saved");
  return { memory, action };
}

/** One memory the caller may see (any status), or null. */
export async function getMemory(supabase, identity, id) {
  requireIdentity(identity);
  if (!isUuid(id)) return null;
  const { data, error } = await visible(supabase.from("memories").select(MEMORY_FIELDS).eq("id", id), identity).maybeSingle();
  if (error) throw new Error(`memory: lookup failed: ${error.message}`);
  return data || null;
}

/**
 * The caller's memories: own user-scope rows plus the namespace's shared
 * rows. Filters: scope, kind, status (default active), q (keyword search).
 */
export async function listMemories(supabase, identity, { scope = null, kind = null, status = "active", q = null, limit = 50, offset = 0 } = {}) {
  requireIdentity(identity);
  let query = visible(supabase.from("memories").select(MEMORY_FIELDS), identity);
  if (scope && MEMORY_SCOPES.includes(scope)) query = query.eq("scope", scope);
  if (kind && MEMORY_KINDS.includes(kind)) query = query.eq("kind", kind);
  if (status && status !== "all") query = query.eq("status", status);
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
  return true;
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

/** Active memories owned by the caller (for the per-user cap, Phase 4). */
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
