// =============================================================
//  Conversations: create, fetch, append, list, rename, archive, delete.
//  Every function takes the full identity (organizationId, namespaceId,
//  userId) and filters on all three, so a conversation that belongs to
//  someone else is indistinguishable from one that does not exist.
//  Plain functions over the service-role client; callers wrap them so
//  a memory failure never fails chat.
// =============================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === "string" && UUID.test(v);

/** Rough token count: enough for budgets, cheap enough for every turn. */
export function estimateTokens(text = "") {
  return Math.ceil(String(text || "").length / 4);
}

function owned(query, identity) {
  return query
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId);
}

function requireIdentity(identity) {
  if (!identity?.organizationId || !identity?.namespaceId || !identity?.userId) {
    throw new Error("conversations: identity must carry organizationId, namespaceId and userId");
  }
}

import { retentionSchemaReady } from "../retention/schema.js";

const CONVERSATION_FIELDS = "id, title, message_count, last_message_at, archived_at, metadata, created_at, updated_at";
/** Plus the retention columns (migration 0013) once they exist. */
async function fields(supabase) {
  return (await retentionSchemaReady(supabase)) ? `${CONVERSATION_FIELDS}, purged_at, legal_hold, legal_hold_reason` : CONVERSATION_FIELDS;
}

/** A title from the first user message: first line, trimmed, at most 80 chars. */
export function titleFrom(text = "") {
  const line = String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const t = line.replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77).trimEnd() + "…" : t || null;
}

/** The caller's own, unarchived conversation, or null. */
export async function getConversation(supabase, identity, conversationId) {
  requireIdentity(identity);
  if (!isUuid(conversationId)) return null;
  const { data, error } = await owned(
    supabase.from("conversations").select(await fields(supabase)).eq("id", conversationId),
    identity
  ).maybeSingle();
  if (error) throw new Error(`conversations: lookup failed: ${error.message}`);
  return data || null;
}

export async function createConversation(supabase, identity, { title = null, metadata = {} } = {}) {
  requireIdentity(identity);
  const { data, error } = await supabase
    .from("conversations")
    .insert([{
      organization_id: identity.organizationId,
      namespace_id: identity.namespaceId,
      user_id: identity.userId,
      title,
      metadata: metadata || {},
    }])
    .select(await fields(supabase))
    .single();
  if (error) throw new Error(`conversations: create failed: ${error.message}`);
  return data;
}

/**
 * Resolve the conversation for a turn: the requested one if it is the
 * caller's and not archived, otherwise a new one. Returns
 * { conversation, created }. A requested id that is not the caller's
 * is treated as absent rather than refused, so a stale id in the
 * browser never blocks chat.
 */
export async function getOrCreateConversation(supabase, identity, requestedId, { title = null } = {}) {
  if (requestedId) {
    const existing = await getConversation(supabase, identity, requestedId);
    if (existing && !existing.archived_at) return { conversation: existing, created: false };
  }
  const conversation = await createConversation(supabase, identity, { title });
  return { conversation, created: true };
}

/**
 * Append one message through the database function, which locks the
 * conversation, allocates the sequence number and checks ownership.
 */
export async function appendMessage(supabase, identity, conversationId, {
  role, content, mode = null, citations = null, sources = null, memoryIds = null, tokenEstimate = null,
}) {
  requireIdentity(identity);
  const { data, error } = await supabase.rpc("append_message", {
    p_conversation_id: conversationId,
    p_organization_id: identity.organizationId,
    p_namespace_id: identity.namespaceId,
    p_user_id: identity.userId,
    p_role: role,
    p_content: String(content ?? ""),
    p_mode: mode,
    p_citations: citations,
    p_sources: sources,
    p_memory_ids: memoryIds,
    p_token_estimate: tokenEstimate ?? estimateTokens(content),
  });
  if (error) throw new Error(`conversations: append failed: ${error.message}`);
  return data;
}

/** Newest first. `state`: active (default), archived, all. `includeArchived` is the older spelling of all. */
export async function listConversations(supabase, identity, { includeArchived = false, state = null, limit = 50, offset = 0 } = {}) {
  requireIdentity(identity);
  let q = owned(supabase.from("conversations").select(await fields(supabase)), identity);
  const want = state || (includeArchived ? "all" : "active");
  if (want === "active") q = q.is("archived_at", null);
  else if (want === "archived") q = q.not("archived_at", "is", null);
  const { data, error } = await q
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`conversations: list failed: ${error.message}`);
  return data || [];
}

/** Messages of the caller's conversation in order, plus the summary if one exists. */
export async function getMessages(supabase, identity, conversationId, { afterSeq = 0, limit = 500 } = {}) {
  requireIdentity(identity);
  const conversation = await getConversation(supabase, identity, conversationId);
  if (!conversation) return null;
  const { data, error } = await owned(
    supabase
      .from("messages")
      .select("id, seq, role, content, mode, citations, sources, memory_ids, token_estimate, created_at")
      .eq("conversation_id", conversationId)
      .gt("seq", afterSeq),
    identity
  ).order("seq", { ascending: true }).limit(limit);
  if (error) throw new Error(`conversations: messages failed: ${error.message}`);
  const { data: summary } = await supabase
    .from("conversation_summaries")
    .select("summary, through_seq, token_estimate, updated_at")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return { conversation, messages: data || [], summary: summary || null };
}

export async function renameConversation(supabase, identity, conversationId, title) {
  requireIdentity(identity);
  if (!isUuid(conversationId)) return null;
  const { data, error } = await owned(
    supabase.from("conversations").update({ title: title || null }).eq("id", conversationId),
    identity
  ).select(await fields(supabase)).maybeSingle();
  if (error) throw new Error(`conversations: rename failed: ${error.message}`);
  return data || null;
}

export async function archiveConversation(supabase, identity, conversationId, archived = true) {
  requireIdentity(identity);
  if (!isUuid(conversationId)) return null;
  const { data, error } = await owned(
    supabase.from("conversations").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", conversationId),
    identity
  ).select(await fields(supabase)).maybeSingle();
  if (error) throw new Error(`conversations: archive failed: ${error.message}`);
  return data || null;
}

/** Hard delete: messages and summary go by cascade. Returns true if a row was removed. */
export async function deleteConversation(supabase, identity, conversationId) {
  requireIdentity(identity);
  if (!isUuid(conversationId)) return false;
  const { data, error } = await owned(
    supabase.from("conversations").delete().eq("id", conversationId),
    identity
  ).select("id");
  if (error) throw new Error(`conversations: delete failed: ${error.message}`);
  return Boolean(data && data.length);
}
