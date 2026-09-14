// =============================================================
//  Document types belong to the organization (migration 0014). One
//  place decides which column scopes a query, so the routes and the
//  upload validation agree, and so a database still on the namespace
//  column (before 0014) keeps working.
// =============================================================

let byOrganization = null;      // null = not probed; then { ready, checkedAt }

/** True once document_types.organization_id exists. Probed once per process; a miss is retried after a minute. */
export async function documentTypesByOrganization(supabase) {
  if (byOrganization?.ready) return true;
  if (byOrganization && Date.now() - byOrganization.checkedAt < 60_000) return false;
  const { error } = await supabase.from("document_types").select("organization_id").limit(1);
  byOrganization = { ready: !error, checkedAt: Date.now() };
  return byOrganization.ready;
}

/**
 * The column and value that scope document types for this caller.
 * `organizationId` lets a super admin work on another organization;
 * anyone else is held to their own.
 */
export async function typeScope(supabase, identity, organizationId = null) {
  if (await documentTypesByOrganization(supabase)) {
    const own = identity.organizationId;
    const wanted = organizationId && organizationId !== own ? (identity.role === "super_admin" ? organizationId : null) : own;
    if (!wanted) return null;
    return { column: "organization_id", value: wanted };
  }
  return { column: "namespace_id", value: identity.namespaceId };
}

/** The stored row whose name matches (case-insensitively) within the caller's scope, or null. */
export async function findDocumentType(supabase, identity, name) {
  const scope = await typeScope(supabase, identity);
  if (!scope || !name) return null;
  const { data } = await supabase.from("document_types").select("id, name").eq(scope.column, scope.value).ilike("name", String(name)).limit(1).maybeSingle();
  return data || null;
}

/** Every namespace id of an organization, for cascading a rename or delete onto documents. */
export async function namespaceIdsOf(supabase, organizationId) {
  const { data } = await supabase.from("namespace").select("id").eq("organization_id", organizationId);
  return (data || []).map((n) => n.id);
}
