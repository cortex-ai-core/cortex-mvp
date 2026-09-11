// ============================================================
//  DOCUMENT TYPES — one list per workspace, managed in Settings
// ============================================================

import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";

const FIELDS = "id, namespace_id, name, description, sort_order, created_at";

function cleanName(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export default async function documentTypeRoutes(fastify) {

  fastify.addHook("preHandler", requireNamespaceMember(fastify));

  // anyone who can chat in the workspace can read its types
  fastify.get("/api/document-types", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "chat")) return reply.code(403).send({ error: "Forbidden" });

    const { data, error } = await fastify.supabase
      .from("document_types")
      .select(FIELDS)
      .eq("namespace_id", identity.namespaceId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) return reply.code(500).send({ error: "Failed to load document types" });
    return reply.send({ types: data || [] });
  });

  // managing types needs upload rights in the workspace
  fastify.post("/api/document-types", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "upload")) return reply.code(403).send({ error: "Forbidden" });

    const name = cleanName(request.body?.name);
    if (!name) return reply.code(400).send({ error: "Give the type a name." });
    const description = String(request.body?.description || "").trim().slice(0, 200) || null;
    const sort_order = Number.isFinite(request.body?.sort_order) ? request.body.sort_order : 0;

    const { data, error } = await fastify.supabase
      .from("document_types")
      .insert([{ namespace_id: identity.namespaceId, name, description, sort_order }])
      .select(FIELDS)
      .single();

    if (error) {
      if (/duplicate|unique/i.test(error.message)) return reply.code(409).send({ error: `"${name}" already exists.` });
      return reply.code(500).send({ error: "Couldn't create the type." });
    }
    return reply.code(201).send({ type: data });
  });

  fastify.patch("/api/document-types/:id", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "upload")) return reply.code(403).send({ error: "Forbidden" });

    const patch = {};
    if (request.body?.name !== undefined) {
      const name = cleanName(request.body.name);
      if (!name) return reply.code(400).send({ error: "Give the type a name." });
      patch.name = name;
    }
    if (request.body?.description !== undefined) patch.description = String(request.body.description || "").trim().slice(0, 200) || null;
    if (Number.isFinite(request.body?.sort_order)) patch.sort_order = request.body.sort_order;
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "Nothing to update." });

    // keep documents in step when a type is renamed
    const { data: before } = await fastify.supabase
      .from("document_types").select("name").eq("id", request.params.id).eq("namespace_id", identity.namespaceId).maybeSingle();
    if (!before) return reply.code(404).send({ error: "Type not found" });

    const { data, error } = await fastify.supabase
      .from("document_types")
      .update(patch)
      .eq("id", request.params.id)
      .eq("namespace_id", identity.namespaceId)
      .select(FIELDS)
      .single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return reply.code(409).send({ error: `"${patch.name}" already exists.` });
      return reply.code(500).send({ error: "Couldn't update the type." });
    }

    if (patch.name && patch.name !== before.name) {
      await fastify.supabase.from("documents")
        .update({ document_type: patch.name })
        .eq("namespace_id", identity.namespaceId)
        .eq("document_type", before.name);
    }
    return reply.send({ type: data });
  });

  fastify.delete("/api/document-types/:id", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "upload")) return reply.code(403).send({ error: "Forbidden" });

    const { data: type } = await fastify.supabase
      .from("document_types").select("name").eq("id", request.params.id).eq("namespace_id", identity.namespaceId).maybeSingle();
    if (!type) return reply.code(404).send({ error: "Type not found" });

    // documents keep working; they just lose the label
    await fastify.supabase.from("documents")
      .update({ document_type: null })
      .eq("namespace_id", identity.namespaceId)
      .eq("document_type", type.name);

    const { error } = await fastify.supabase
      .from("document_types").delete().eq("id", request.params.id).eq("namespace_id", identity.namespaceId);
    if (error) return reply.code(500).send({ error: "Couldn't delete the type." });
    return reply.send({ deleted: true });
  });
}
