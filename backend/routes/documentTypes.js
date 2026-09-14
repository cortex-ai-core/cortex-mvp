// ============================================================
//  DOCUMENT TYPES — one list per organization (migration 0014),
//  managed by its admins on the Organizations page, used by every
//  namespace when a document is uploaded or edited.
//
//    GET    /api/document-types[?organizationId=]      any member
//    POST   /api/document-types                         admin, super admin
//    PATCH  /api/document-types/:id                     admin, super admin
//    DELETE /api/document-types/:id                     admin, super admin
//
//  A super admin may pass organizationId to work on another
//  organization; everyone else is held to their own. Before 0014 the
//  same routes fall back to the caller's namespace.
// ============================================================

import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";
import { typeScope, namespaceIdsOf } from "../lib/documentTypeScope.js";

const FIELDS = "id, organization_id, name, description, sort_order, created_at";
const LEGACY_FIELDS = "id, namespace_id, name, description, sort_order, created_at";

function cleanName(v) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export default async function documentTypeRoutes(fastify) {

  fastify.addHook("preHandler", requireNamespaceMember(fastify));

  const db = fastify.supabase;
  const fields = (scope) => (scope.column === "organization_id" ? FIELDS : LEGACY_FIELDS);
  const requested = (request) => request.query?.organizationId || request.body?.organizationId || null;

  /** Scope for a write: admin rights, and the organization the caller may manage. */
  async function writeScope(request, reply) {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "admin")) { reply.code(403).send({ error: "Only an administrator can change document types." }); return null; }
    const scope = await typeScope(db, identity, requested(request));
    if (!scope) { reply.code(403).send({ error: "Organization access denied." }); return null; }
    return { identity, scope };
  }

  /** Documents that carry a type name within the scope. */
  async function documentsQuery(scope) {
    const q = db.from("documents");
    if (scope.column === "namespace_id") return { q, filter: (x) => x.eq("namespace_id", scope.value) };
    const ids = await namespaceIdsOf(db, scope.value);
    return { q, filter: (x) => x.in("namespace_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]) };
  }

  // anyone who can chat can read the organization's types
  fastify.get("/api/document-types", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "chat")) return reply.code(403).send({ error: "Forbidden" });
    const scope = await typeScope(db, identity, requested(request));
    if (!scope) return reply.code(403).send({ error: "Organization access denied." });

    const { data, error } = await db
      .from("document_types")
      .select(fields(scope))
      .eq(scope.column, scope.value)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (error) return reply.code(500).send({ error: "Failed to load document types" });
    return reply.send({ types: data || [], scope: scope.column === "organization_id" ? "organization" : "namespace" });
  });

  fastify.post("/api/document-types", async (request, reply) => {
    const w = await writeScope(request, reply);
    if (!w) return;
    const { scope } = w;

    const name = cleanName(request.body?.name);
    if (!name) return reply.code(400).send({ error: "Give the type a name." });
    const description = String(request.body?.description || "").trim().slice(0, 200) || null;
    const sort_order = Number.isFinite(request.body?.sort_order) ? request.body.sort_order : 0;

    const { data, error } = await db
      .from("document_types")
      .insert([{ [scope.column]: scope.value, name, description, sort_order }])
      .select(fields(scope))
      .single();

    if (error) {
      if (/duplicate|unique/i.test(error.message)) return reply.code(409).send({ error: `"${name}" already exists.` });
      return reply.code(500).send({ error: "Couldn't create the type." });
    }
    fastify.log.info({ type: data.id, name, [scope.column]: scope.value, by: w.identity.userId }, "document types: created");
    return reply.code(201).send({ type: data });
  });

  fastify.patch("/api/document-types/:id", async (request, reply) => {
    const w = await writeScope(request, reply);
    if (!w) return;
    const { scope } = w;

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
    const { data: before } = await db
      .from("document_types").select("name").eq("id", request.params.id).eq(scope.column, scope.value).maybeSingle();
    if (!before) return reply.code(404).send({ error: "Type not found" });

    const { data, error } = await db
      .from("document_types")
      .update(patch)
      .eq("id", request.params.id)
      .eq(scope.column, scope.value)
      .select(fields(scope))
      .single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return reply.code(409).send({ error: `"${patch.name}" already exists.` });
      return reply.code(500).send({ error: "Couldn't update the type." });
    }

    if (patch.name && patch.name !== before.name) {
      const { q, filter } = await documentsQuery(scope);
      await filter(q.update({ document_type: patch.name })).eq("document_type", before.name);
    }
    fastify.log.info({ type: data.id, patch, by: w.identity.userId }, "document types: updated");
    return reply.send({ type: data });
  });

  fastify.delete("/api/document-types/:id", async (request, reply) => {
    const w = await writeScope(request, reply);
    if (!w) return;
    const { scope } = w;

    const { data: type } = await db
      .from("document_types").select("name").eq("id", request.params.id).eq(scope.column, scope.value).maybeSingle();
    if (!type) return reply.code(404).send({ error: "Type not found" });

    // documents keep working; they just lose the label
    const { q, filter } = await documentsQuery(scope);
    await filter(q.update({ document_type: null })).eq("document_type", type.name);

    const { error } = await db
      .from("document_types").delete().eq("id", request.params.id).eq(scope.column, scope.value);
    if (error) return reply.code(500).send({ error: "Couldn't delete the type." });
    fastify.log.info({ type: request.params.id, name: type.name, by: w.identity.userId }, "document types: deleted");
    return reply.send({ deleted: true });
  });
}
