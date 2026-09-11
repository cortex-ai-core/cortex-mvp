// =============================================================
//  Role → action permissions.
//
//  Roles are the five rows of the `role` table. Which namespaces a
//  user may use is not decided here: `namespace_users` is the source
//  of truth, and requireNamespaceMember() checks it on every request,
//  so a user removed from a namespace is refused on their next call.
//
//  The two memory actions gate the memory work (design doc 5.10):
//  memory_read before recall and on the memory/conversation routes,
//  memory_write before extraction and on the memory routes. Which of
//  operator, viewer and client may write is a default to confirm
//  with the customer.
// =============================================================

export const PERMISSION_MAP = {
  super_admin: ["chat", "upload", "delete", "admin", "memory_read", "memory_write", "manage_personas", "manage_pcl"],
  admin:       ["chat", "upload", "delete", "admin", "memory_read", "memory_write", "manage_personas", "manage_pcl"],
  operator:    ["chat", "upload", "delete", "memory_read", "memory_write"],
  client:      ["chat", "upload", "memory_read", "memory_write"],
  viewer:      ["chat", "memory_read"],
};

export function hasPermission(identity, action) {
  const actions = PERMISSION_MAP[identity?.role];
  return Array.isArray(actions) && actions.includes(action);
}

/**
 * Normalize the JWT payload the auth hook attaches to the request.
 * Ids are the keys; `namespace` is the display name and is never used
 * to look anything up.
 */
export function identityFrom(request) {
  const u = request.user?.user || request.user || {};
  return {
    userId: u.userId || u.id || null,
    email: u.email || null,
    role: u.role || null,
    organizationId: u.organizationId || null,
    namespaceId: u.namespaceId || null,
    namespace: u.namespace || null,
    namespaces: Array.isArray(u.namespaces) ? u.namespaces : [],
  };
}

/**
 * True when namespace_users has a row for (namespace, user) and the
 * namespace belongs to the caller's organization. One indexed query;
 * no cache, so revocation takes effect on the next request.
 */
export async function isNamespaceMember(supabase, identity) {
  if (!identity?.userId || !identity?.namespaceId) return false;
  const { data, error } = await supabase
    .from("namespace_users")
    .select("id, namespace:namespace_id(organization_id)")
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (error || !data) return false;
  if (identity.organizationId && data.namespace?.organization_id !== identity.organizationId) return false;
  return true;
}

/**
 * Fastify preHandler: the token's namespace must still be one the user
 * belongs to. Use on every route that reads or writes namespace data.
 */
export function requireNamespaceMember(fastify) {
  return async function namespaceGuard(request, reply) {
    const identity = identityFrom(request);
    if (!identity.userId || !identity.namespaceId) {
      return reply.code(401).send({ error: "Sign in again: this session has no workspace." });
    }
    const ok = await isNamespaceMember(fastify.supabase, identity);
    if (!ok) {
      return reply.code(403).send({ error: "You no longer have access to this workspace." });
    }
  };
}
