// =============================================================
//  Purge: what "delete this conversation" means once every copy is
//  accounted for (retention plan section 5.5, decision R-3).
//
//    1. the caller's own thread, or "not found"
//    2. refused while the thread or its organization is on hold
//    3. memories the thread produced are stamped source_purged_at
//       (they are the curated layer and survive; the receipt names them)
//    4. the thread's trace rows lose their question text
//    5. the thread row goes: messages, running summary and archive
//       follow by cascade
//    6. one conversation_deleted event with the receipt as detail
//
//  Without migration 0013 (schema probe says not ready) the hold and
//  stamp steps are skipped and the rest still runs, so the delete
//  button never stops working.
// =============================================================

import { retentionSchemaReady } from "./schema.js";
import { scrubTraces } from "../retrieval/trace.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID.test(v);

function requireIdentity(identity) {
  if (!identity?.organizationId || !identity?.namespaceId || !identity?.userId) {
    throw new Error("purge: identity must carry organizationId, namespaceId and userId");
  }
}

function owned(query, identity) {
  return query
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId);
}

/**
 * Is this thread, or its organization, on hold? Only meaningful once
 * 0013 exists; before that nothing can be held.
 */
export async function holdOn(supabase, conversation, { ready = true } = {}) {
  if (!ready) return null;
  if (conversation?.legal_hold) {
    return { scope: "conversation", reason: conversation.legal_hold_reason || null };
  }
  const { data: org } = await supabase
    .from("organization")
    .select("retention_hold, retention_hold_reason")
    .eq("id", conversation.organization_id)
    .maybeSingle();
  if (org?.retention_hold) return { scope: "organization", reason: org.retention_hold_reason || null };
  return null;
}

/**
 * Delete one of the caller's conversations completely.
 *
 * @returns {{ status: "deleted", receipt } | { status: "held", hold } | { status: "not_found" }}
 *   receipt = { messages, summary, archive, traces_scrubbed, memories_kept: uuid[], schema_ready }
 */
export async function purgeConversation(supabase, identity, conversationId, { log = null, actor = null } = {}) {
  requireIdentity(identity);
  if (!isUuid(conversationId)) return { status: "not_found" };

  const ready = await retentionSchemaReady(supabase, log);
  const fields = "id, organization_id, namespace_id, user_id, title, message_count, archived_at"
    + (ready ? ", purged_at, legal_hold, legal_hold_reason" : "");

  const { data: conversation, error } = await owned(
    supabase.from("conversations").select(fields).eq("id", conversationId),
    identity
  ).maybeSingle();
  if (error) throw new Error(`purge: lookup failed: ${error.message}`);
  if (!conversation) return { status: "not_found" };

  const hold = await holdOn(supabase, conversation, { ready });
  if (hold) {
    log?.info?.({ conversationId, hold }, "purge: refused, on hold");
    return { status: "held", hold };
  }

  // 3. memories the thread produced: stamp, then remember their ids
  //    (the foreign key nulls the link once the thread row goes).
  const { data: memRows, error: memErr } = await supabase
    .from("memories")
    .select("id")
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("source_conversation_id", conversationId)
    .neq("status", "deleted");
  if (memErr) log?.warn?.({ err: memErr.message }, "purge: memory lookup failed");
  const memoryIds = (memRows || []).map((r) => r.id);
  if (ready && memoryIds.length) {
    const { error: stampErr } = await supabase
      .from("memories")
      .update({ source_purged_at: new Date().toISOString() })
      .in("id", memoryIds)
      .is("source_purged_at", null);
    if (stampErr) log?.warn?.({ err: stampErr.message }, "purge: memory stamp failed");
  }

  // 4. trace text
  const tracesScrubbed = await scrubTraces(supabase, log, { conversationId });

  // what the cascade is about to remove, for the receipt
  const [{ count: messageCount }, { count: summaryCount }, archiveCount] = await Promise.all([
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId),
    supabase.from("conversation_summaries").select("conversation_id", { count: "exact", head: true }).eq("conversation_id", conversationId),
    ready
      ? supabase.from("conversation_archives").select("conversation_id", { count: "exact", head: true }).eq("conversation_id", conversationId).then((r) => r.count || 0)
      : Promise.resolve(0),
  ]);

  // 5. the thread row; messages, summary and archive cascade
  const { data: removed, error: delErr } = await owned(
    supabase.from("conversations").delete().eq("id", conversationId),
    identity
  ).select("id");
  if (delErr) throw new Error(`purge: delete failed: ${delErr.message}`);
  if (!removed?.length) return { status: "not_found" };

  const receipt = {
    messages: Number(messageCount) || 0,
    summary: (Number(summaryCount) || 0) > 0,
    archive: (Number(archiveCount) || 0) > 0,
    traces_scrubbed: tracesScrubbed,
    memories_kept: memoryIds,
    schema_ready: ready,
  };

  // 6. the event. The event name exists only with 0013; before that the
  //    constraint would refuse it, so the log line stands in.
  if (ready) {
    const { error: evErr } = await supabase.from("memory_events").insert([{
      event: "conversation_deleted",
      actor: actor || identity.userId,
      actor_organization_id: identity.organizationId,
      target_organization_id: identity.organizationId,
      target_user_id: identity.userId,
      conversation_id: conversationId,
      detail: { ...receipt, title_length: (conversation.title || "").length },
    }]);
    if (evErr) log?.warn?.({ err: evErr.message }, "purge: event log failed");
  }
  log?.info?.({ conversationId, ...receipt, memories_kept: memoryIds.length }, "purge: conversation deleted");
  return { status: "deleted", receipt };
}
