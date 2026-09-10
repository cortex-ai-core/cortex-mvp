// ============================================================
//  CONVERSATION ROUTES — the caller's own saved threads
//  list · fetch with messages · rename · archive · delete
//  Someone else's id is 404, the same as a missing one.
// ============================================================

import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";
import {
  listConversations, getMessages, renameConversation, archiveConversation, deleteConversation, isUuid,
} from "../memory/conversations.js";

function publicConversation(c) {
  return {
    conversation_id: c.id,
    title: c.title,
    message_count: c.message_count,
    last_message_at: c.last_message_at,
    archived_at: c.archived_at,
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

  // GET /api/conversations?archived=1&limit=50&offset=0
  fastify.get("/api/conversations", async (request, reply) => {
    const identity = identityFrom(request);
    const q = request.query || {};
    try {
      const rows = await listConversations(fastify.supabase, identity, {
        includeArchived: q.archived === "1" || q.archived === "true",
        limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200),
        offset: Math.max(Number(q.offset) || 0, 0),
      });
      return reply.send({ conversations: rows.map(publicConversation) });
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
      return reply.send({
        ...publicConversation(result.conversation),
        summary: result.summary ? { text: result.summary.summary, through_seq: result.summary.through_seq, updated_at: result.summary.updated_at } : null,
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

  // POST /api/conversations/:id/archive   { archived?: boolean }
  fastify.post("/api/conversations/:id/archive", async (request, reply) => {
    const identity = identityFrom(request);
    const { id } = request.params;
    const archived = request.body?.archived !== false;
    try {
      const row = await archiveConversation(fastify.supabase, identity, id, archived);
      if (!row) return reply.code(404).send({ error: "Conversation not found" });
      return reply.send(publicConversation(row));
    } catch (err) { return fail(reply, err, "archive the conversation"); }
  });

  // DELETE /api/conversations/:id
  fastify.delete("/api/conversations/:id", async (request, reply) => {
    const identity = identityFrom(request);
    const { id } = request.params;
    try {
      const removed = await deleteConversation(fastify.supabase, identity, id);
      if (!removed) return reply.code(404).send({ error: "Conversation not found" });
      return reply.send({ deleted: true, conversation_id: id });
    } catch (err) { return fail(reply, err, "delete the conversation"); }
  });
}
