import { readPreferences, writePreferences, validPreferencesPatch } from "../../lib/userPreferences.js";
import {
  canAccessOrganization,
  findUser,
  membershipsFor,
  requireSettingsManager,
  withNamespaces,
} from "./shared.js";

const ROLES = new Set(["super_admin", "admin", "operator", "viewer", "client"]);
const slug = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";

async function resolveRole(fastify, value) {
  const role = slug(value);
  if (!ROLES.has(role)) return { data: null };
  return fastify.supabase.from("role").select("id,name")
    .ilike("name", role).maybeSingle();
}

async function resolveOrganization(fastify, body, scope) {
  let query = fastify.supabase.from("organization").select("id,name");
  if (!scope.isSuperAdmin) return query.eq("id", scope.organizationId).maybeSingle();
  if (body.organizationId) return query.eq("id", body.organizationId).maybeSingle();
  if (body.organization) return query.ilike("name", String(body.organization).trim()).maybeSingle();
  return { data: null, error: null };
}

async function validateNamespaces(fastify, organizationId, namespaceIds) {
  const ids = [...new Set((namespaceIds || [])
    .filter((id) => typeof id === "string" && id.trim()))];
  if (!ids.length) return { error: "At least one namespace is required." };
  const { data, error } = await fastify.supabase.from("namespace")
    .select("id,name,organization_id").in("id", ids);
  if (error || data?.length !== ids.length ||
      data.some((item) => item.organization_id !== organizationId)) {
    return { error: "Every namespace must exist and belong to the user's organization." };
  }
  return { namespaces: data };
}

async function validateNamespaceNames(fastify, organizationId, names) {
  const requested = [...new Set((names || []).map(slug).filter(Boolean))];
  if (!requested.length) return { error: "At least one namespace is required." };
  const { data, error } = await fastify.supabase.from("namespace")
    .select("id,name,organization_id").eq("organization_id", organizationId);
  const namespaces = (data || []).filter((item) => requested.includes(slug(item.name)));
  if (error || namespaces.length !== requested.length) {
    return { error: "One or more namespaces do not exist in that organization." };
  }
  return { namespaces };
}

async function authorizeTarget(fastify, scope, userId) {
  const result = await findUser(fastify, userId);
  if (result.error) return { status: 500, error: "Unable to load user." };
  if (!result.data) return { status: 404, error: "User not found." };
  if (!canAccessOrganization(scope, result.data.organization.id)) {
    return { status: 403, error: "User organization access denied." };
  }
  if (!scope.isSuperAdmin && result.data.role?.name === "super_admin") {
    return { status: 403, error: "Administrators cannot manage super administrators." };
  }
  return { user: result.data };
}

async function addMembership(fastify, scope, userId, namespaceId) {
  const target = await authorizeTarget(fastify, scope, userId);
  if (target.error) return target;
  const validation = await validateNamespaces(
    fastify, target.user.organization.id, [namespaceId]
  );
  if (validation.error) return { status: 400, error: validation.error };
  const { data: existing, error } = await fastify.supabase.from("namespace_users")
    .select("id").eq("user_id", userId).eq("namespace_id", namespaceId).maybeSingle();
  if (error) return { status: 500, error: "Unable to check namespace membership." };
  if (!existing) {
    const { error: insertError } = await fastify.supabase.from("namespace_users")
      .insert({ user_id: userId, namespace_id: namespaceId });
    if (insertError) return { status: 500, error: "Unable to assign namespace." };
  }
  return { status: existing ? 200 : 201, namespace: validation.namespaces[0] };
}

async function removeMembership(fastify, scope, userId, namespaceId) {
  const target = await authorizeTarget(fastify, scope, userId);
  if (target.error) return target;
  const validation = await validateNamespaces(
    fastify, target.user.organization.id, [namespaceId]
  );
  if (validation.error) return { status: 400, error: validation.error };
  const { count, error } = await fastify.supabase.from("namespace_users")
    .select("id", { count: "exact", head: true }).eq("user_id", userId);
  if (error) return { status: 500, error: "Unable to load memberships." };
  if ((count || 0) <= 1) {
    return { status: 409, error: "A user must retain at least one namespace." };
  }
  const { error: deleteError } = await fastify.supabase.from("namespace_users")
    .delete().eq("user_id", userId).eq("namespace_id", namespaceId);
  if (deleteError) return { status: 500, error: "Unable to remove namespace." };
  return { status: 204 };
}

export default async function userManagement(fastify) {
  for (const method of ["GET", "PATCH"]) {
    fastify.route({
      method, url: "/api/settings/users/:userId/personalization",
      async handler(req, reply) {
        const scope = requireSettingsManager(req, reply);
        if (!scope) return;
        const target = await authorizeTarget(fastify, scope, req.params.userId);
        if (target.error) return reply.code(target.status).send({ error: target.error });
        if (method === "PATCH" && !validPreferencesPatch(req.body, true)) {
          return reply.code(400).send({ error: "Provide personalization text up to 4,000 characters only." });
        }
        try {
          const preferences = method === "GET"
            ? await readPreferences(fastify, target.user.id)
            : await writePreferences(fastify, target.user.id, req.body);
          if (method === "PATCH") req.log.info({
            event: "user_personalization_updated", actorUserId: req.user.userId,
            targetUserId: target.user.id, timestamp: new Date().toISOString(),
          }, "User personalization updated");
          return { personalization: preferences.personalization };
        } catch {
          return reply.code(500).send({ error: "Unable to " + (method === "GET" ? "load" : "save") + " personalization." });
        }
      },
    });
  }

  // Lists users globally for super_admin and only within the caller's
  // organization for admin. namespaceId is an optional additional filter.
  fastify.get("/api/settings/users", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    let userIds = null;
    if (req.query?.namespaceId) {
      const { data: namespace } = await fastify.supabase.from("namespace")
        .select("id,organization_id").eq("id", req.query.namespaceId).maybeSingle();
      if (!namespace) return reply.code(404).send({ error: "Namespace not found." });
      if (!canAccessOrganization(scope, namespace.organization_id)) {
        return reply.code(403).send({ error: "Namespace access denied." });
      }
      const { data, error } = await fastify.supabase.from("namespace_users")
        .select("user_id").eq("namespace_id", namespace.id);
      if (error) return reply.code(500).send({ error: "Unable to filter users." });
      userIds = data.map((item) => item.user_id);
      if (!userIds.length) return { users: [] };
    }
    let query = fastify.supabase.from("user").select(`
      id, auth_user_id, email, active, created_at, updated_at,
      role:role_id(id,name), organization:organization_id(id,name)
    `).order("created_at", { ascending: false });
    if (!scope.isSuperAdmin) query = query.eq("organization_id", scope.organizationId);
    if (userIds) query = query.in("id", userIds);
    const { data: users, error } = await query;
    if (error) return reply.code(500).send({ error: "Unable to load users." });
    const { data: memberships, error: membershipError } =
      await membershipsFor(fastify, users.map((user) => user.id));
    if (membershipError) return reply.code(500).send({ error: "Unable to load memberships." });
    return { users: withNamespaces(users, memberships) };
  });

  // Creates Auth, application-user, and membership records. Admin is forced
  // into their own organization and cannot create a super_admin.
  fastify.post("/api/settings/users", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const body = req.body || {};
    const email = slug(body.email);
    const password = typeof body.password === "string" ? body.password : "";
    const roleName = slug(body.role);
    if (!email || password.length < 8 || !ROLES.has(roleName)) {
      return reply.code(400).send({ error: "Valid email, password, and role are required." });
    }
    if (!scope.isSuperAdmin && roleName === "super_admin") {
      return reply.code(403).send({ error: "Administrators cannot create super administrators." });
    }
    const [{ data: role }, { data: organization }] = await Promise.all([
      resolveRole(fastify, roleName), resolveOrganization(fastify, body, scope),
    ]);
    if (!role || !organization) {
      return reply.code(400).send({ error: "Role or organization does not exist." });
    }
    const namespaceResult = Array.isArray(body.namespaceIds)
      ? await validateNamespaces(fastify, organization.id, body.namespaceIds)
      : await validateNamespaceNames(
          fastify, organization.id,
          Array.isArray(body.namespaces) ? body.namespaces : [body.namespace]
        );
    if (namespaceResult.error) return reply.code(400).send({ error: namespaceResult.error });

    let authUserId = null;
    let appUserId = null;
    try {
      const { data: authUser, error: authError } =
        await fastify.supabase.auth.admin.createUser({ email, password, email_confirm: true });
      if (authError || !authUser.user) {
        return reply.code(400).send({ error: authError?.message || "Unable to create user." });
      }
      authUserId = authUser.user.id;
      const { data: user, error: userError } = await fastify.supabase.from("user")
        .insert({
          auth_user_id: authUserId, email, role_id: role.id,
          organization_id: organization.id, active: true,
        }).select("id,auth_user_id,email,active,created_at").single();
      if (userError) throw userError;
      appUserId = user.id;
      const { error: membershipError } = await fastify.supabase.from("namespace_users")
        .insert(namespaceResult.namespaces.map((item) => ({
          user_id: user.id, namespace_id: item.id,
        })));
      if (membershipError) throw membershipError;
      return reply.code(201).send({
        user: { ...user, role, organization, namespaces: namespaceResult.namespaces },
      });
    } catch (err) {
      if (appUserId) await fastify.supabase.from("user").delete().eq("id", appUserId);
      if (authUserId) await fastify.supabase.auth.admin.deleteUser(authUserId);
      req.log.error({ err }, "User creation failed");
      return reply.code(500).send({ error: "Unable to create user." });
    }
  });

  // Updates status, role, or organization with target-user and role escalation
  // checks. Only super_admin can move a user to another organization.
  fastify.patch("/api/settings/users/:userId", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const target = await authorizeTarget(fastify, scope, req.params.userId);
    if (target.error) return reply.code(target.status).send({ error: target.error });
    const updates = {};
    if (typeof req.body?.active === "boolean") updates.active = req.body.active;
    if (req.body?.roleId || req.body?.role) {
      let query = fastify.supabase.from("role").select("id,name");
      query = req.body.roleId ? query.eq("id", req.body.roleId) :
        query.ilike("name", String(req.body.role).trim());
      const { data: role } = await query.maybeSingle();
      if (!role) return reply.code(400).send({ error: "Invalid role." });
      if (!scope.isSuperAdmin && role.name === "super_admin") {
        return reply.code(403).send({ error: "Administrators cannot assign super_admin." });
      }
      updates.role_id = role.id;
    }
    if (req.body?.organizationId || req.body?.organization) {
      if (!scope.isSuperAdmin) {
        return reply.code(403).send({ error: "Administrators cannot move users across organizations." });
      }
      const { data: organization } = await resolveOrganization(fastify, req.body, scope);
      if (!organization) return reply.code(400).send({ error: "Invalid organization." });
      updates.organization_id = organization.id;
    }
    if (!Object.keys(updates).length) {
      return reply.code(400).send({ error: "No supported changes supplied." });
    }
    updates.updated_at = new Date().toISOString();
    const { data, error } = await fastify.supabase.from("user")
      .update(updates).eq("id", target.user.id)
      .select("id,email,active,role_id,organization_id,updated_at").single();
    if (error) return reply.code(500).send({ error: "Unable to update user." });
    return { user: data };
  });

  // Replaces all memberships, restricted to the target user's organization.
  fastify.put("/api/settings/users/:userId/namespaces", async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const target = await authorizeTarget(fastify, scope, req.params.userId);
    if (target.error) return reply.code(target.status).send({ error: target.error });
    const validation = await validateNamespaces(
      fastify, target.user.organization.id,
      Array.isArray(req.body?.namespaceIds) ? req.body.namespaceIds : []
    );
    if (validation.error) return reply.code(400).send({ error: validation.error });
    const { data: current, error } = await fastify.supabase.from("namespace_users")
      .select("id,namespace_id").eq("user_id", target.user.id);
    if (error) return reply.code(500).send({ error: "Unable to load memberships." });
    const requested = validation.namespaces.map((item) => item.id);
    const currentIds = new Set(current.map((item) => item.namespace_id));
    const additions = requested.filter((id) => !currentIds.has(id));
    const removals = current.filter((item) => !requested.includes(item.namespace_id));
    if (additions.length) {
      const { error: addError } = await fastify.supabase.from("namespace_users")
        .insert(additions.map((namespaceId) => ({
          user_id: target.user.id, namespace_id: namespaceId,
        })));
      if (addError) return reply.code(500).send({ error: "Unable to add memberships." });
    }
    if (removals.length) {
      const { error: removeError } = await fastify.supabase.from("namespace_users")
        .delete().in("id", removals.map((item) => item.id));
      if (removeError) return reply.code(500).send({ error: "Unable to remove memberships." });
    }
    return { userId: target.user.id, namespaces: validation.namespaces };
  });

  const assign = async (req, reply, userId, namespaceId) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const result = await addMembership(fastify, scope, userId, namespaceId);
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return reply.code(result.status).send({ userId, namespace: result.namespace });
  };
  fastify.post("/api/settings/users/:userId/namespaces", async (req, reply) => {
    if (!req.body?.namespaceId) return reply.code(400).send({ error: "namespaceId is required." });
    return assign(req, reply, req.params.userId, req.body.namespaceId);
  });
  fastify.post("/api/settings/namespaces/:namespaceId/users", async (req, reply) => {
    if (!req.body?.userId) return reply.code(400).send({ error: "userId is required." });
    return assign(req, reply, req.body.userId, req.params.namespaceId);
  });

  const remove = async (req, reply, userId, namespaceId) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return;
    const result = await removeMembership(fastify, scope, userId, namespaceId);
    if (result.error) return reply.code(result.status).send({ error: result.error });
    return reply.code(204).send();
  };
  fastify.delete("/api/settings/users/:userId/namespaces/:namespaceId", async (req, reply) =>
    remove(req, reply, req.params.userId, req.params.namespaceId));
  fastify.delete("/api/settings/namespaces/:namespaceId/users/:userId", async (req, reply) =>
    remove(req, reply, req.params.userId, req.params.namespaceId));
}
