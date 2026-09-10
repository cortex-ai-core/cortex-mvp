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
  listContested, memoryStates, stateAsOf, currentState, liveAttestations, resolveContested, attestMemory,
  MEMORY_KINDS, MEMORY_SCOPES,
} from "../memory/store.js";
import { relateToExisting } from "../memory/extract.js";

/** A state row as the client sees it (design doc 9.1). */
export function publicState(s) {
  if (!s) return null;
  return {
    state_id: s.id,
    truth_status: s.truth_status,
    review_status: s.review_status,
    reviewed_by: s.reviewed_by,
    reviewed_at: s.reviewed_at,
    review_note: s.review_note,
    policy_version: s.policy_version,
    counterpart_id: s.counterpart_id,
    dimensions: s.dimensions,
    reason: s.reason,
    effective_range: s.effective_range,
    computed_at: s.computed_at,
    basis: s.basis,
  };
}

export function publicAttestation(a) {
  return {
    attestation_id: a.id,
    stance: a.stance,
    strength: a.strength,
    source_layer: a.source_layer,
    source_ref: a.source_ref,
    authority_score: a.authority_score,
    confidence: a.confidence,
    first_party: a.first_party,
    self_serving: a.self_serving,
    status: a.status,
    actor: a.actor,
    asserted_at: a.asserted_at,
    invalidated_at: a.invalidated_at,
  };
}

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

  // GET /api/memory/contested — the caller's contested propositions with both sides (9.5 "Surface contested")
  fastify.get("/api/memory/contested", async (request, reply) => {
    const identity = identityFrom(request);
    try {
      const rows = await listContested(fastify.supabase, identity, { limit: Math.min(200, Number(request.query?.limit) || 50) });
      return reply.send({ contested: rows.map((r) => ({ memory: publicMemory(r.memory), state: publicState(r.state), counterpart: r.counterpart })) });
    } catch (err) {
      return fail(reply, err, "list contested memories");
    }
  });

  // GET /api/memory/:id — with its current truth state
  fastify.get("/api/memory/:id", async (request, reply) => {
    const identity = identityFrom(request);
    try {
      const m = await getMemory(fastify.supabase, identity, request.params.id);
      if (!m) return reply.code(404).send({ error: "Memory not found." });
      const state = await currentState(fastify.supabase, m.id).catch(() => null);
      const atts = await liveAttestations(fastify.supabase, m.id).catch(() => []);
      return reply.send({ ...publicMemory(m), state: publicState(state), attestation_count: atts.length });
    } catch (err) {
      return fail(reply, err, "load memory");
    }
  });

  // GET /api/memory/:id/states[?as_of=<iso>] — the belief history (9.1: "what did we hold last Tuesday")
  fastify.get("/api/memory/:id/states", async (request, reply) => {
    const identity = identityFrom(request);
    try {
      const h = await memoryStates(fastify.supabase, identity, request.params.id);
      if (!h) return reply.code(404).send({ error: "Memory not found." });
      const asOf = request.query?.as_of ? new Date(request.query.as_of) : null;
      const at = asOf && !Number.isNaN(asOf.getTime()) ? stateAsOf(h.states, asOf) : undefined;
      return reply.send({
        memory: publicMemory(h.memory),
        states: h.states.map(publicState),
        attestations: h.attestations.map(publicAttestation),
        ...(at !== undefined ? { as_of: asOf.toISOString(), state_as_of: publicState(at) } : {}),
      });
    } catch (err) {
      return fail(reply, err, "load memory states");
    }
  });

  // POST /api/memory/:id/resolve  { winner_id?: <this or its counterpart>, note? }
  // A person settles a contested pair: winner accepted, the other denied, both overridden.
  fastify.post("/api/memory/:id/resolve", async (request, reply) => {
    if (!requireWrite(request, reply)) return;
    const identity = identityFrom(request);
    const b = request.body || {};
    try {
      const r = await resolveContested(fastify.supabase, identity, request.params.id, { winnerId: b.winner_id || null, note: b.note || null, log: fastify.log });
      if (!r) return reply.code(404).send({ error: "Memory not found." });
      return reply.send({ memory: publicMemory(r.memory), counterpart: r.counterpart ? publicMemory(r.counterpart) : null, winner_id: r.winnerId });
    } catch (err) {
      return fail(reply, err, "resolve memory");
    }
  });

  // POST /api/memory/:id/attest  { stance?: asserts|denies|reports, strength?, note? }
  // A deciding attestation from the caller; the vote runs again.
  fastify.post("/api/memory/:id/attest", async (request, reply) => {
    if (!requireWrite(request, reply)) return;
    const identity = identityFrom(request);
    const b = request.body || {};
    try {
      const r = await attestMemory(fastify.supabase, identity, request.params.id, { stance: b.stance, strength: b.strength, note: b.note, log: fastify.log });
      if (!r) return reply.code(404).send({ error: "Memory not found." });
      return reply.send({ memory: publicMemory(r.memory), truth_status: r.truthStatus, action: r.action || "attested" });
    } catch (err) {
      return fail(reply, err, "attest memory");
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
      // Design doc 9.5: find the proposition this note is about before
      // saving, so a reworded correction supersedes and a rival value from
      // someone else goes to the vote. stance: asserts (default) | denies | reports.
      const scope = MEMORY_SCOPES.includes(b.scope) ? b.scope : "user";
      const relation = b.relation && ["same", "different_value", "unrelated"].includes(b.relation)
        ? { relation: b.relation, targetId: b.target_id || null, embedding: null }
        : await relateToExisting(fastify.supabase, openai, identity, { content: b.content, scope, settings, log: fastify.log });
      const { memory, action, truthStatus, counterpart, attested } = await saveMemory(fastify.supabase, openai, identity, {
        content: b.content,
        kind: b.kind,
        scope,
        importance: b.importance ?? 4,
        sourceType: "user_explicit",
        stance: b.stance,
        subject: b.subject,
        predicate: b.predicate,
        relation: relation.relation,
        targetId: relation.targetId,
        embedding: relation.embedding,
      }, { settings, log: fastify.log });
      if (action === "blocked") return reply.code(400).send({ error: "Sensitive data blocked" });
      const created = !["duplicate", "retracted", "denial_recorded"].includes(action);
      return reply.code(created ? 201 : 200).send({ memory: publicMemory(memory), action, truth_status: truthStatus || memory.truth_status, attested: Boolean(attested), counterpart: counterpart || null });
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

  // GET /api/memory/traces/:id — one of the caller's own turn traces
  // ("why did it say that", design doc 5.11): the memories the answer
  // used, the ones extraction wrote afterwards, the answer mode, the
  // conflicts note and what the turn cost. The id comes back with each
  // chat answer as traceId. Another user's trace is 404.
  fastify.get("/api/memory/traces/:id", async (request, reply) => {
    const identity = identityFrom(request);
    const id = String(request.params.id || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return reply.code(404).send({ error: "Trace not found." });
    try {
      // "*" rather than a column list: usage and extracted_memory_ids
      // arrive with migration 0009 and the route must work before it.
      const { data, error } = await fastify.supabase
        .from("rag_queries")
        .select("*")
        .eq("id", id)
        .eq("namespace_id", identity.namespaceId)
        .eq("user_id", String(identity.userId))
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return reply.code(404).send({ error: "Trace not found." });
      return reply.send({
        trace_id: data.id,
        query: data.query,
        retrieval_mode: data.mode,
        answer_mode: data.answer_mode,
        conversation_id: data.conversation_id,
        history_turns: data.history_turns,
        memory_ids: data.memory_ids || [],
        memory_block_tokens: data.memory_block_tokens,
        conflicts: data.conflicts || [],
        usage: data.usage ?? null,
        extracted_memory_ids: data.extracted_memory_ids ?? [],
        result_count: data.result_count,
        latency_ms: data.latency_ms,
        created_at: data.created_at,
      });
    } catch (err) {
      return fail(reply, err, "load trace");
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
