export function requireSettingsManager(req, reply) {
  const role = req.user?.role;
  if (role !== "super_admin" && role !== "admin") {
    reply.code(403).send({ error: "Settings administrator access required." });
    return null;
  }
  if (role === "admin" && !req.user?.organizationId) {
    reply.code(403).send({ error: "Administrator organization is missing." });
    return null;
  }
  return {
    isSuperAdmin: role === "super_admin",
    organizationId: req.user?.organizationId || null,
  };
}

export function requireSuperAdmin(req, reply) {
  const scope = requireSettingsManager(req, reply);
  if (!scope) return null;
  if (!scope.isSuperAdmin) {
    reply.code(403).send({ error: "Super administrator access required." });
    return null;
  }
  return scope;
}

export function canAccessOrganization(scope, organizationId) {
  return scope.isSuperAdmin || scope.organizationId === organizationId;
}

export async function findUser(fastify, userId) {
  return fastify.supabase
    .from("user")
    .select(`
      id, auth_user_id, email, active, created_at, updated_at,
      role:role_id(id,name),
      organization:organization_id(id,name)
    `)
    .eq("id", userId)
    .maybeSingle();
}

export async function membershipsFor(fastify, userIds) {
  if (!userIds.length) return { data: [], error: null };
  return fastify.supabase
    .from("namespace_users")
    .select("id,user_id,namespace:namespace_id(id,name,organization_id)")
    .in("user_id", userIds)
    .order("created_at", { ascending: true });
}

export function withNamespaces(users, memberships) {
  return users.map((user) => ({
    ...user,
    namespaces: memberships
      .filter((membership) => membership.user_id === user.id)
      .map((membership) => membership.namespace)
      .filter(Boolean),
  }));
}
