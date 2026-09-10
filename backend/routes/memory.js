// ============================================================
//  MEMORY ROUTES — the caller's own durable memories (design doc 5.3)
//  list · search · fetch · history · save · edit · archive · delete
//  A user memory is the owner's only; a namespace memory is visible
//  to everyone in the namespace and editable by admins (D2).
//  Someone else's id is 404, the same as a missing one.
// ============================================================

import OpenAI from "openai";
import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";
import { effectiveSettings } from "../memory/settings.js";
import {
  listMemories, getMemory, saveMemory, updateMemory, archiveMemory, deleteMemory, memoryHistory,
  MEMORY_KINDS, MEMORY_SCOPES,
} from "../memory/store.js";

export function publicMemory(m) {
  return {
    memory_id: m.id,
    scope: m.scope,
    kind: m.kind,
    content: m.content,
    importance: m.importance,
    confidence: m.confidence,
    source_type: m.source_type,
    source_conversation_id: m.source_conversation_id,
    supersedes_id: m.supersedes_id,
    suggested_shared: m.suggested_shared,
    status: m.status,
    truth_status: m.truth_status,
    subject: m.subject,
    predicate: m.predicate,
    access_count: m.access_count,
    last_accessed_at: m.last_accessed_at,
    expires_at: m.expires_at,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

export default async function memoryRoutes(fastify) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  fastify.addHook("preHandler", requireNamespaceMember(fastify));
  fastify.addHook("preHandler", async (request, reply) => {
    if (!hasPermission(identityFrom(request), "memory_read")) {
      return reply.code(403).send({ error: "Your role can't use memory." });
    }
  });

  const fail = (reply, err, what) => {
    if (err?.statusCode) return reply.code(err.statusCode).send({ error: err.message });
    fastify.log.error({ err: err?.message }, `memory: ${what} failed`);
    return reply.code(500).send({ error: `Couldn't ${what}.` });
  };
  const requireWrite = (request, reply) => {
    if (!hasPermission(identityFrom(request), "memory_write")) {
      reply.code(403).send({ error: "Your role can't change memory." });
      return false;
    }
    return true;
  };

  // GET /api/memory?scope=user|namespace&kind=&status=active|archived|superseded|all&q=&limit=&offset=
  fastify.get("/api/memory", async (request, reply) => {
    const identity = identityFrom(request);
    const q = request.query || {};
    try {
      const rows = await listMemories(fastify.supabase, identity, {
        scope: MEMORY_SCOPES.includes(q.scope) ? q.scope : null,
        kind: MEMORY_KINDS.includes(q.kind) ? q.kind : null,
        status: q.status || "active",
        q: q.q || null,
        limit: Math.min(Math.max(Number(q.limit) || 50, 1), 200),
        offset: Math.max(Number(q.offset) || 0, 0),
      });
      return reply.send({ memories: rows.map(publicMemory) });
    } catch (err) {
      return fail(reply, err, "list memories");
    }
  });

  // GET /api/memory/:id
  fastify.get("/api/memory/:id", async (request, reply) => {
    const identity = identityFrom(request);
    try {
      const m = await getMemory(fastify.supabase, identity, request.params.id);
      if (!m) return reply.code(404).send({ error: "Memory not found." });
      return reply.send(publicMemory(m));
    } catch (err) {
      return fail(reply, err, "load memory");
    }
  });

  // GET /api/memory/:id/history
  fastify.get("/api/memory/:id/history", async (request, reply) => {
    const identity = identityFrom(request);
    try {
      const h = await memoryHistory(fastify.supabase, identity, request.params.id);
      if (!h) return reply.code(404).send({ error: "Memory not found." });
      return reply.send({ memory: publicMemory(h.memory), events: h.events });
    } catch (err) {
      return fail(reply, err, "load memory history");
    }
  });

  // POST /api/memory  { content, kind?, scope?, importance?, subject?, predicate? }
  fastify.post("/api/memory", async (request, reply) => {
    if (!requireWrite(request, reply)) return;
    const identity = identityFrom(request);
    const b = request.body || {};
    if (!b.content || !String(b.content).trim()) return reply.code(400).send({ error: "Content is required." });
    try {
      const settings = await effectiveSettings(fastify.supabase, identity.namespaceId, fastify.log);
      if (!settings.memory_enabled) return reply.code(409).send({ error: "Memory is off in this workspace." });
      const { memory, action } = await saveMemory(fastify.supabase, openai, identity, {
        content: b.content,
        kind: b.kind,
        scope: b.scope,
        importance: b.importance ?? 4,
        sourceType: "user_explicit",
        subject: b.subject,
        predicate: b.predicate,
      }, { settings, log: fastify.log });
      if (action === "blocked") return reply.code(400).send({ error: "Sensitive data blocked" });
      return reply.code(action === "duplicate" ? 200 : 201).send({ memory: publicMemory(memory), action });
    } catch (err) {
      return fail(reply, err, "save memory");
    }
  });

  // PATCH /api/memory/:id  { content?, kind?, importance?, subject?, predicate? }
  fastify.patch("/api/memory/:id", async (request, reply) => {
    if (!requireWrite(request, reply)) return;
    const identity = identityFrom(request);
    try {
      const m = await updateMemory(fastify.supabase, openai, identity, request.params.id, request.body || {}, { log: fastify.log });
      if (!m) return reply.code(404).send({ error: "Memory not found." });
      return reply.send(publicMemory(m));
    } catch (err) {
      return fail(reply, err, "update memory");
    }
  });

  // POST /api/memory/:id/archive  { archived?: true }
  fastify.post("/api/memory/:id/archive", async (request, reply) => {
    if (!requireWrite(request, reply)) return;
    const identity = identityFrom(request);
    const archived = request.body?.archived !== false;
    try {
      const m = await archiveMemory(fastify.supabase, identity, request.params.id, archived, { log: fastify.log });
      if (!m) return reply.code(404).send({ error: "Memory not found." });
      return reply.send(publicMemory(m));
    } catch (err) {
      return fail(reply, err, archived ? "archive memory" : "restore memory");
    }
  });

  // DELETE /api/memory/:id
  fastify.delete("/api/memory/:id", async (request, reply) => {
    if (!requireWrite(request, reply)) return;
    const identity = identityFrom(request);
    try {
      const ok = await deleteMemory(fastify.supabase, identity, request.params.id, { log: fastify.log });
      if (!ok) return reply.code(404).send({ error: "Memory not found." });
      return reply.send({ deleted: true });
    } catch (err) {
      return fail(reply, err, "delete memory");
    }
  });
}
