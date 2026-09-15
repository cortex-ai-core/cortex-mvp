import {
  canAccessOrganization,
  membershipsFor,
  requireSettingsManager,
  requireSuperAdmin,
  withNamespaces,
} from "./shared.js";
import { retentionSchemaReady } from "../../retention/schema.js";

const clean = (value) => typeof value === "string" ? value.trim() : "";
const ORG_FIELDS = "id,name,description,created_at,last_updated_at";
// The chat retention policy rides along on the list once migration 0013 exists.
const orgFields = async (fastify) => (await retentionSchemaReady(fastify.supabase, fastify.log))
  ? `${ORG_FIELDS},chat_retention_days,retention_hold,retention_hold_reason`
  : ORG_FIELDS;

async function findNamespace(fastify, namespaceId) {
  return fastify.supabase.from("namespace")
    .select("id,name,organization_id")
    .eq("id", namespaceId).maybeSingle();
}

export default async function organizationAdministration(fastify) {
  // Lists all organizations for super_admin and only the caller's organization
  // for admin. Each organization includes its namespaces.
  fastify.get("/api/settings/organizations", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    let organizationQuery = fastify.supabase.from("organization")
      .select(await orgFields(fastify)).order("name");
    let namespaceQuery = fastify.supabase.from("namespace")
      .select("id,name,description,organization_id,default_persona_id,created_at,last_updated_at").order("name");
    if (!scope.isSuperAdmin) {
      organizationQuery = organizationQuery.eq("id", scope.organizationId);
      namespaceQuery = namespaceQuery.eq("organization_id", scope.organizationId);
    }
    const [{ data: organizations, error }, { data: namespaces, error: namespaceError }] =
      await Promise.all([organizationQuery, namespaceQuery]);
    if (error || namespaceError) {
      return reply.code(500).send({ error: "Unable to load organizations." });
    }
    return { organizations: organizations.map((organization) => ({
      ...organization,
      namespaces: namespaces.filter((item) => item.organization_id === organization.id),
    })) };
  });

  // Creates an organization. This is intentionally super_admin-only.
  fastify.post("/api/settings/organizations", async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const name = clean(req.body?.name);
    const description = clean(req.body?.description) || null;
    if (!name) return reply.code(400).send({ error: "Organization name is required." });
    const { data, error } = await fastify.supabase.from("organization")
      .insert({ name, description }).select("id,name,description,created_at,last_updated_at")
      .single();
    if (error) {
      if (error.code === "23505") return reply.code(409).send({ error: "Organization already exists." });
      return reply.code(500).send({ error: "Unable to create organization." });
    }
    return reply.code(201).send({ organization: { ...data, namespaces: [] } });
  });

  // Updates an organization. Admin may update only the organization ID carried
  // in their signed JWT; super_admin may update any organization.
  fastify.patch("/api/settings/organizations/:organizationId", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    if (!canAccessOrganization(scope, req.params.organizationId)) {
      return reply.code(403).send({ error: "Organization access denied." });
    }
    const updates = {};
    if (req.body?.name !== undefined) {
      const name = clean(req.body.name);
      if (!name) return reply.code(400).send({ error: "Organization name cannot be empty." });
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = clean(req.body.description) || null;
    }
    if (!Object.keys(updates).length) {
      return reply.code(400).send({ error: "Name or description is required." });
    }
    updates.last_updated_at = new Date().toISOString();
    const { data, error } = await fastify.supabase.from("organization")
      .update(updates).eq("id", req.params.organizationId)
      .select("id,name,description,created_at,last_updated_at").maybeSingle();
    if (error) return reply.code(500).send({ error: "Unable to update organization." });
    if (!data) return reply.code(404).send({ error: "Organization not found." });
    return { organization: data };
  });

  // Creates a namespace inside the organization in the route. The caller must
  // be a super_admin or an admin scoped to that same organization. Namespace
  // names are unique within an organization (case-insensitive).
  fastify.post("/api/settings/organizations/:organizationId/namespaces", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const { organizationId } = req.params;
    if (!canAccessOrganization(scope, organizationId)) {
      return reply.code(403).send({ error: "Organization access denied." });
    }

    const name = clean(req.body?.name);
    const description = clean(req.body?.description) || null;
    if (!name) return reply.code(400).send({ error: "Namespace name is required." });

    const { data: organization, error: organizationError } = await fastify.supabase
      .from("organization").select("id").eq("id", organizationId).maybeSingle();
    if (organizationError) {
      return reply.code(500).send({ error: "Unable to validate organization." });
    }
    if (!organization) return reply.code(404).send({ error: "Organization not found." });

    const { data: duplicate, error: duplicateError } = await fastify.supabase
      .from("namespace").select("id")
      .eq("organization_id", organizationId).ilike("name", name).limit(1).maybeSingle();
    if (duplicateError) {
      return reply.code(500).send({ error: "Unable to validate namespace name." });
    }
    if (duplicate) {
      return reply.code(409).send({ error: "Namespace name already exists in this organization." });
    }

    const { data: namespace, error } = await fastify.supabase.from("namespace")
      .insert({ name, description, organization_id: organizationId })
      .select("id,name,description,organization_id,created_at,last_updated_at").single();
    if (error) {
      if (error.code === "23505") {
        return reply.code(409).send({ error: "Namespace name already exists in this organization." });
      }
      return reply.code(500).send({ error: "Unable to create namespace." });
    }
    return reply.code(201).send({ namespace });
  });

  // Updates a namespace only when it belongs to the organization in the route
  // and that organization is inside the caller's scope. Renames cannot collide
  // with another namespace in the same organization.
  fastify.patch("/api/settings/organizations/:organizationId/namespaces/:namespaceId", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const { organizationId, namespaceId } = req.params;
    if (!canAccessOrganization(scope, organizationId)) {
      return reply.code(403).send({ error: "Organization access denied." });
    }

    const { data: current, error: lookupError } = await fastify.supabase
      .from("namespace")
      .select("id,name,description,organization_id,created_at,last_updated_at")
      .eq("id", namespaceId).eq("organization_id", organizationId).maybeSingle();
    if (lookupError) return reply.code(500).send({ error: "Unable to load namespace." });
    if (!current) {
      return reply.code(404).send({
        error: "Namespace was not found in the specified organization.",
      });
    }

    const updates = {};
    if (req.body?.name !== undefined) {
      const name = clean(req.body.name);
      if (!name) return reply.code(400).send({ error: "Namespace name cannot be empty." });
      const { data: duplicate, error: duplicateError } = await fastify.supabase
        .from("namespace").select("id")
        .eq("organization_id", organizationId).ilike("name", name)
        .neq("id", namespaceId).limit(1).maybeSingle();
      if (duplicateError) {
        return reply.code(500).send({ error: "Unable to validate namespace name." });
      }
      if (duplicate) {
        return reply.code(409).send({
          error: "Namespace name already exists in this organization.",
        });
      }
      updates.name = name;
    }
    if (req.body?.description !== undefined) {
      updates.description = clean(req.body.description) || null;
    }
    if (!Object.keys(updates).length) {
      return reply.code(400).send({ error: "Name or description is required." });
    }
    updates.last_updated_at = new Date().toISOString();

    const { data: namespace, error } = await fastify.supabase.from("namespace")
      .update(updates).eq("id", namespaceId).eq("organization_id", organizationId)
      .select("id,name,description,organization_id,created_at,last_updated_at").single();
    if (error) {
      if (error.code === "23505") {
        return reply.code(409).send({ error: "Namespace name already exists in this organization." });
      }
      return reply.code(500).send({ error: "Unable to update namespace." });
    }
    return { namespace };
  });

  // Lists members of a namespace after verifying the namespace belongs to the
  // admin's organization (or allowing the super_admin cross-organization view).
  fastify.get("/api/settings/namespaces/:namespaceId/users", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const { data: namespace, error: namespaceLookupError } =
      await findNamespace(fastify, req.params.namespaceId);
    if (namespaceLookupError) return reply.code(500).send({ error: "Unable to load namespace." });
    if (!namespace) return reply.code(404).send({ error: "Namespace not found." });
    if (!canAccessOrganization(scope, namespace.organization_id)) {
      return reply.code(403).send({ error: "Namespace access denied." });
    }
    const { data: memberships, error } = await fastify.supabase.from("namespace_users")
      .select("user_id").eq("namespace_id", namespace.id);
    if (error) return reply.code(500).send({ error: "Unable to load namespace users." });
    const userIds = memberships.map((item) => item.user_id);
    if (!userIds.length) return { namespace, users: [] };
    let usersQuery = fastify.supabase.from("user").select(`
      id, auth_user_id, email, active, created_at, updated_at,
      role:role_id(id,name), organization:organization_id(id,name)
    `).in("id", userIds).order("email");
    if (!scope.isSuperAdmin) usersQuery = usersQuery.eq("organization_id", scope.organizationId);
    const { data: users, error: userError } = await usersQuery;
    if (userError) return reply.code(500).send({ error: "Unable to load users." });
    const { data: allMemberships, error: membershipError } =
      await membershipsFor(fastify, users.map((user) => user.id));
    if (membershipError) return reply.code(500).send({ error: "Unable to load memberships." });
    return { namespace, users: withNamespaces(users, allMemberships) };
  });
}
