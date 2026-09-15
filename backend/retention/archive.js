// =============================================================
//  Archive one conversation (retention plan 5.3 steps 2–5, 5.4):
//  summarise, then one transaction that inserts the archive, purges
//  the raw chat, stamps the memories and the thread; then scrub the
//  trace text and log the event.
//
//    archiveConversation   the whole step for one thread; dry-run
//                          returns what it would write and writes
//                          nothing
//    getArchive            the caller's own archive row
//
//  Failure policy: a model failure defers the thread (attempt counted
//  in conversations.metadata.retention_attempts); on the third
//  failure the thread is archived with the metadata-only record, so
//  retention never stalls on a model outage. Threads with fewer than
//  two user turns get the metadata-only record without a model call
//  (R-10). Empty threads are reported, not archived: the sweep
//  deletes them.
// =============================================================

import { retentionSchemaReady } from "./schema.js";
import { holdOn } from "./purge.js";
import { scrubTraces } from "../retrieval/trace.js";
import { summarizeForArchive, buildArchive, metadataOnlyArchive, renderArchive, PROMPT_VERSION, ARCHIVE_MODEL } from "./summarize.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID.test(v);
export const MAX_ATTEMPTS = Number(process.env.RETENTION_ARCHIVE_ATTEMPTS || 3);
const MIN_USER_TURNS = 2;

const THREAD_FIELDS = "id, organization_id, namespace_id, user_id, title, message_count, last_message_at, archived_at, purged_at, legal_hold, legal_hold_reason, metadata, created_at";

/** The thread with its running summary and turns, in order. Service-role read; `identity` narrows to an owner. */
export async function loadThreadForArchive(supabase, conversationId, { identity = null } = {}) {
  let q = supabase.from("conversations").select(THREAD_FIELDS).eq("id", conversationId);
  if (identity) q = q.eq("organization_id", identity.organizationId).eq("namespace_id", identity.namespaceId).eq("user_id", identity.userId);
  const { data: conversation, error } = await q.maybeSingle();
  if (error) throw new Error(`archive: thread lookup failed: ${error.message}`);
  if (!conversation) return null;
  const [{ data: summary }, { data: messages, error: mErr }] = await Promise.all([
    supabase.from("conversation_summaries").select("summary, through_seq").eq("conversation_id", conversationId).maybeSingle(),
    supabase.from("messages").select("seq, role, content, sources, created_at").eq("conversation_id", conversationId).order("seq", { ascending: true }),
  ]);
  if (mErr) throw new Error(`archive: messages failed: ${mErr.message}`);
  return { conversation, summary: summary || null, messages: messages || [] };
}

async function bumpAttempts(supabase, conversation, error, log) {
  const attempts = (Number(conversation.metadata?.retention_attempts) || 0) + 1;
  const metadata = { ...(conversation.metadata || {}), retention_attempts: attempts, retention_last_error: String(error?.message || error).slice(0, 200), retention_last_attempt_at: new Date().toISOString() };
  const { error: upErr } = await supabase.from("conversations").update({ metadata }).eq("id", conversation.id);
  if (upErr) log?.warn?.({ err: upErr.message }, "archive: could not record the attempt");
  return attempts;
}

/**
 * Archive one thread.
 * @returns {{ status: "archived"|"dry_run"|"deferred"|"held"|"already_archived"|"empty"|"not_found"|"not_ready", ... }}
 */
export async function archiveConversation(supabase, openai, conversationId, { dryRun = false, log = null, usage = null, identity = null, actor = "system:retention" } = {}) {
  if (!isUuid(conversationId)) return { status: "not_found" };
  if (!(await retentionSchemaReady(supabase, log))) return { status: "not_ready" };

  const thread = await loadThreadForArchive(supabase, conversationId, { identity });
  if (!thread) return { status: "not_found" };
  const { conversation, summary, messages } = thread;
  if (conversation.archived_at) return { status: "already_archived", archived_at: conversation.archived_at };
  const hold = await holdOn(supabase, conversation, { ready: true });
  if (hold) return { status: "held", hold };
  if (!messages.length) return { status: "empty" };

  const userTurns = messages.filter((m) => m.role === "user").length;
  const priorAttempts = Number(conversation.metadata?.retention_attempts) || 0;
  let archive, fallback = false, reason = null, model = null, input = null;

  if (userTurns < MIN_USER_TURNS) {
    fallback = true; reason = "too short for a summary";
    archive = metadataOnlyArchive({ conversation, messages, reason });
  } else if (priorAttempts >= MAX_ATTEMPTS) {
    fallback = true; reason = `summary failed ${priorAttempts} times`;
    archive = metadataOnlyArchive({ conversation, messages, reason });
  } else {
    try {
      const out = await summarizeForArchive({ openai, conversation, summary, messages, usage, log });
      model = out.model; input = out.input;
      archive = buildArchive({ conversation, messages, fields: out.fields, model });
    } catch (err) {
      if (dryRun) return { status: "deferred", attempts: priorAttempts + 1, error: err?.message, dryRun: true };
      const attempts = await bumpAttempts(supabase, conversation, err, log);
      log?.warn?.({ conversationId, attempts, err: err?.message }, "archive: summary failed; deferred");
      if (attempts < MAX_ATTEMPTS) return { status: "deferred", attempts, error: err?.message };
      fallback = true; reason = `summary failed ${attempts} times`;
      archive = metadataOnlyArchive({ conversation, messages, reason });
    }
  }
  const summaryText = renderArchive(archive);

  if (dryRun) {
    return { status: "dry_run", archive, summaryText, fallback, reason, model, input, messages: messages.length };
  }

  const { data: removed, error } = await supabase.rpc("archive_conversation", {
    p_id: conversationId,
    p_archive: archive,
    p_summary_text: summaryText,
    p_model: fallback ? null : (model || ARCHIVE_MODEL),
    p_prompt_version: PROMPT_VERSION,
    p_fallback: fallback,
  });
  if (error) throw new Error(`archive: archive_conversation failed: ${error.message}`);
  if (removed === null || removed === undefined) return { status: "already_archived" };   // lost a race with another pass

  const tracesScrubbed = await scrubTraces(supabase, log, { conversationId });
  const detail = { messages: Number(removed) || 0, traces_scrubbed: tracesScrubbed, fallback, reason, model: fallback ? null : model, prompt_version: PROMPT_VERSION, chars: summaryText.length, input };
  const { error: evErr } = await supabase.from("memory_events").insert([{
    event: "conversation_archived",
    actor,
    actor_organization_id: conversation.organization_id,
    target_organization_id: conversation.organization_id,
    target_user_id: conversation.user_id,
    conversation_id: conversationId,
    detail,
  }]);
  if (evErr) log?.warn?.({ err: evErr.message }, "archive: event log failed");
  log?.info?.({ conversationId, ...detail, input: undefined }, "retention: conversation archived");
  return { status: "archived", archive, summaryText, fallback, reason, model, messages: Number(removed) || 0, tracesScrubbed };
}

/** The caller's own archive row, or null. */
export async function getArchive(supabase, identity, conversationId) {
  if (!isUuid(conversationId) || !(await retentionSchemaReady(supabase))) return null;
  const { data, error } = await supabase
    .from("conversation_archives")
    .select("conversation_id, title, summary, summary_text, started_at, ended_at, message_count, model, prompt_version, fallback, created_at")
    .eq("conversation_id", conversationId)
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (error) throw new Error(`archive: lookup failed: ${error.message}`);
  return data || null;
}

export function publicArchive(a) {
  if (!a) return null;
  return {
    conversation_id: a.conversation_id,
    title: a.title,
    summary: a.summary,
    summary_text: a.summary_text,
    started_at: a.started_at,
    ended_at: a.ended_at,
    message_count: a.message_count,
    model: a.model,
    prompt_version: a.prompt_version,
    fallback: a.fallback,
    created_at: a.created_at,
  };
}
