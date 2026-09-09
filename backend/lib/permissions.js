// =============================================================
//  Role → namespace → action permissions.
//  Same map the retrieve and legacy ingest routes carry inline;
//  new code imports this one.
// =============================================================

export const PERMISSION_MAP = {
  super_admin: {
    namespaces: ["*"],
    actions: ["chat", "upload", "admin", "delete"],
  },
  admin: {
    namespaces: ["*"],
    actions: ["chat", "upload", "delete"],
  },
  advisor: {
    namespaces: ["advisory"],
    actions: ["chat", "upload"],
  },
  cyber: {
    namespaces: ["cybersecurity"],
    actions: ["chat"],
  },
  datamanagement: {
    namespaces: ["datamanagement"],
    actions: ["chat", "upload"],
  },
  recruiting: {
    namespaces: ["recruiting"],
    actions: ["chat", "upload"],
  },
  ventures: {
    namespaces: ["ventures"],
    actions: ["chat", "upload"],
  },
};

export function hasPermission(identity, action) {
  const role = identity?.role;
  const namespace = identity?.namespace;
  const perms = PERMISSION_MAP[role];
  if (!perms) return false;

  const namespaceAllowed =
    perms.namespaces.includes("*") || perms.namespaces.includes(namespace);
  if (!namespaceAllowed) return false;

  return perms.actions.includes(action);
}

/** Normalize the JWT payload the auth hook attaches to the request. */
export function identityFrom(request) {
  const u = request.user?.user || request.user || {};
  return {
    userId: u.userId || u.id || null,
    role: u.role || null,
    namespace: u.namespace || null,
  };
}
