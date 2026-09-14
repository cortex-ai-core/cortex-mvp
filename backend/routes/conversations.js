// ============================================================
//  CONVERSATION ROUTES — the caller's own saved threads
//  list · fetch with messages · rename · archive · delete
//  Someone else's id is 404, the same as a missing one.
// ============================================================

import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";
import {
  listConversations, getMessages, renameConversation, isUuid,
} from "../memory/conversations.js";
import { purgeConversation } from "../retention/purge.js";
import { getArchive, publicArchive, archiveConversation as archiveNow } from "../retention/archive.js";
import { retentionPolicyFor } from "../retention/policy.js";

function publicConversation(c) {
  return {
    conversation_id: c.id,
    title: c.title,
    message_count: c.message_count,
    last_message_at: c.last_message_at,
    // retention: "archived" = summarised into an archive, raw messages purged; read-only from then on
    state: c.archived_at ? "archived" : "active",
    archived_at: c.archived_at,
    purged_at: c.purged_at ?? null,
    legal_hold: Boolean(c.legal_hold),
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function publicMessage(m) {
  return {
    message_id: m.id,
    seq: m.seq,
    role: m.role,
    content: m.content,
    mode: m.mode,
    citations: m.citations || [],
    sources: m.sources || [],
    memory_ids: m.memory_ids || [],
    created_at: m.created_at,
  };
}

export default async function conversationRoutes(fastify) {

  fastify.addHook("preHandler", requireNamespaceMember(fastify));
  fastify.addHook("preHandler", async (request, reply) => {
    if (!hasPermission(identityFrom(request), "memory_read")) {
      return reply.code(403).send({ error: "Your role can't use saved conversations." });
    }
  });

  const fail = (reply, err, what) => {
    fastify.log.error({ err: err?.message }, `conversations: ${what} failed`);
    return reply.code(500).send({ error: `Couldn't ${what}.` });
  };

  // GET /api/conversations?state=active|archived|all&limit=50&offset=0   (archived=1 = all, older spelling)
  fastify.get("/api/conversations", async (request, reply) => {
    const identity = identityFrom(request);
    const q = request.query || {};
    try {
      const rows = await listConversations(fastify.supabase, identity, {
        state: ["active", "archived", "all"].includes(q.state) ? q.state : null,
        includeArchived: q.archived === "1" || q.archived === "true",
        limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200),
        offset: Math.max(Number(q.offset) || 0, 0),
      });
      // what the organization does with these chats, so the web app can say so
      const policy = await retentionPolicyFor(fastify.supabase, identity.namespaceId, fastify.log).catch(() => null);
      return reply.send({
        conversations: rows.map(publicConversation),
        retention: policy && policy.ready ? { days: policy.days, hold: policy.hold, source: policy.source } : null,
      });
    } catch (err) { return fail(reply, err, "list conversations"); }
  });

  // GET /api/conversations/:id?after=<seq>
  fastify.get("/api/conversations/:id", async (request, reply) => {
    const identity = identityFrom(request);
    const { id } = request.params;
    if (!isUuid(id)) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const result = await getMessages(fastify.supabase, identity, id, { afterSeq: Number(request.query?.after) || 0 });
      if (!result) return reply.code(404).send({ error: "Conversation not found" });
      // An archived thread has no messages left; its archive record stands in.
      const archive = result.conversation.archived_at ? await getArchive(fastify.supabase, identity, id) : null;
      return reply.send({
        ...publicConversation(result.conversation),
        summary: result.summary ? { text: result.summary.summary, through_seq: result.summary.through_seq, updated_at: result.summary.updated_at } : null,
        archive: publicArchive(archive),
        messages: result.messages.map(publicMessage),
      });
    } catch (err) { return fail(reply, err, "load the conversation"); }
  });

  // PATCH /api/conversations/:id  { title }
  fastify.patch("/api/conversations/:id", async (request, reply) => {
    const identity = identityFrom(request);
    const { id } = request.params;
    const title = String(request.body?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    try {
      const row = await renameConversation(fastify.supabase, identity, id, title || null);
      if (!row) return reply.code(404).send({ error: "Conversation not found" });
      return reply.send(publicConversation(row));
    } catch (err) { return fail(reply, err, "rename the conversation"); }
  });

  // POST /api/conversations/:id/archive   { archived?: true }
  // "Archive now" (retention plan R-9): summarise the caller's own thread
  // and purge its messages ahead of the retention period. Not reversible;
  // { archived: false } is refused. 409 while held; 400 for an empty thread.
  fastify.post("/api/conversations/:id/archive", async (request, reply) => {
    const identity = identityFrom(request);
    const { id } = request.params;
    if (request.body?.archived === false) return reply.code(410).send({ error: "An archived chat can't be reopened. Its messages were removed when it was summarised." });
    if (!isUuid(id)) return reply.code(404).send({ error: "Conversation not found" });
    try {
      const result = await archiveNow(fastify.supabase, fastify.openai, id, { identity, log: fastify.log, actor: identity.userId });
      switch (result.status) {
        case "archived": {
          const archive = await getArchive(fastify.supabase, identity, id);
          return reply.send({ archived: true, conversation_id: id, archive: publicArchive(archive) });
        }
        case "already_archived": return reply.code(409).send({ error: "This chat is already archived." });
        case "held": return reply.code(409).send({ error: result.hold.scope === "organization" ? "Your organization has a retention hold in place, so this chat can't be archived right now." : "This chat is on legal hold, so it can't be archived right now.", hold: result.hold });
        case "empty": return reply.code(400).send({ error: "There is nothing to archive: this chat has no messages." });
        case "deferred": return reply.code(503).send({ error: "The summary couldn't be written just now. Try again in a moment." });
        case "not_ready": return reply.code(503).send({ error: "Archiving isn't set up on this database yet." });
        default: return reply.code(404).send({ error: "Conversation not found" });
      }
    } catch (err) { return fail(reply, err, "archive the conversation"); }
  });

  // DELETE /api/conversations/:id — a complete purge (retention plan 5.5):
  // messages, running summary, archive and trace text go; memories the
  // thread produced stay, stamped, and are named in the receipt.
  // 409 while the thread or its organization is on legal hold.
  fastify.delete("/api/conversations/:id", async (request, reply) => {
    const identity = identityFrom(request);
    const { id } = request.params;
    try {
      const result = await purgeConversation(fastify.supabase, identity, id, { log: fastify.log });
      if (result.status === "not_found") return reply.code(404).send({ error: "Conversation not found" });
      if (result.status === "held") {
        const why = result.hold.scope === "organization" ? "Your organization has a retention hold in place" : "This chat is on legal hold";
        return reply.code(409).send({ error: `${why}, so it can't be deleted right now.`, hold: result.hold });
      }
      return reply.send({ deleted: true, conversation_id: id, receipt: result.receipt });
    } catch (err) { return fail(reply, err, "delete the conversation"); }
  });
}
