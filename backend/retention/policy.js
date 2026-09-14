// =============================================================
//  Retention policy resolution (plan 5.2, decision R-1).
//
//    days = memory_settings.retention_days for the namespace, when set
//         = organization.chat_retention_days otherwise
//         = CHAT_RETENTION_DAYS from the environment otherwise (30)
//    0 keeps forever. RETENTION_TRACE_DAYS overrides the age after
//    which thread-less trace text is nulled; blank = the same days.
//
//    retentionPolicyFor     one namespace, cached a minute
//    listRetentionPolicies  every namespace in one pass (the sweep)
//    invalidateRetentionPolicy  after an admin change
//
//  Until migration 0013 the organization columns do not exist; the
//  environment default is reported with ready: false and the sweep
//  stays idle.
// =============================================================

import { retentionSchemaReady } from "./schema.js";

const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : dflt; };

export function envPolicyDefaults() {
  return {
    days: Math.max(0, num("CHAT_RETENTION_DAYS", 30)),
    traceDays: process.env.RETENTION_TRACE_DAYS ? Math.max(0, num("RETENTION_TRACE_DAYS", 0)) : null,   // null = same as days
  };
}

const CACHE_MS = 60_000;
const cache = new Map();   // namespaceId -> { at, policy }

export function invalidateRetentionPolicy(namespaceId) {
  if (namespaceId) cache.delete(namespaceId); else cache.clear();
}

const cutoffFor = (days) => (days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null);

function compose({ namespaceId, organizationId, namespaceName = null, orgRow = null, settingsRow = null, ready = true }) {
  const env = envPolicyDefaults();
  let days = env.days, source = "environment";
  if (orgRow && orgRow.chat_retention_days !== null && orgRow.chat_retention_days !== undefined) { days = orgRow.chat_retention_days; source = "organization"; }
  if (settingsRow && settingsRow.retention_days !== null && settingsRow.retention_days !== undefined) { days = settingsRow.retention_days; source = "namespace"; }
  days = Math.max(0, Number(days) || 0);
  const traceDays = env.traceDays === null ? days : env.traceDays;
  return {
    namespaceId, organizationId, namespaceName,
    days, source, keepForever: days === 0, cutoff: cutoffFor(days),
    traceDays, traceCutoff: cutoffFor(traceDays),
    hold: Boolean(orgRow?.retention_hold), holdReason: orgRow?.retention_hold_reason || null,
    ready,
  };
}

/** The effective policy for one namespace. Never throws. */
export async function retentionPolicyFor(supabase, namespaceId, log) {
  const hit = cache.get(namespaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.policy, cutoff: cutoffFor(hit.policy.days), traceCutoff: cutoffFor(hit.policy.traceDays) };
  let policy;
  try {
    if (!(await retentionSchemaReady(supabase, log))) {
      policy = compose({ namespaceId, organizationId: null, ready: false });
    } else {
      const [{ data: ns, error: nsErr }, { data: ms }] = await Promise.all([
        supabase.from("namespace").select("id, name, organization_id, organization:organization_id(chat_retention_days, retention_hold, retention_hold_reason)").eq("id", namespaceId).maybeSingle(),
        supabase.from("memory_settings").select("retention_days").eq("namespace_id", namespaceId).maybeSingle(),
      ]);
      if (nsErr) throw new Error(nsErr.message);
      policy = compose({ namespaceId, organizationId: ns?.organization_id || null, namespaceName: ns?.name || null, orgRow: ns?.organization || null, settingsRow: ms || null });
    }
  } catch (err) {
    log?.warn?.({ err: err?.message, namespaceId }, "retention: policy lookup failed; using the environment default");
    policy = compose({ namespaceId, organizationId: null, ready: false });
  }
  cache.set(namespaceId, { at: Date.now(), policy });
  return policy;
}

/**
 * Every namespace's effective policy, one query each for namespaces
 * (with their organization) and settings rows. `organizationId` narrows.
 */
export async function listRetentionPolicies(supabase, { organizationId = null, log = null } = {}) {
  if (!(await retentionSchemaReady(supabase, log))) return [];
  let q = supabase.from("namespace").select("id, name, organization_id, organization:organization_id(chat_retention_days, retention_hold, retention_hold_reason)").order("name");
  if (organizationId) q = q.eq("organization_id", organizationId);
  const [{ data: namespaces, error }, { data: settings, error: sErr }] = await Promise.all([q, supabase.from("memory_settings").select("namespace_id, retention_days")]);
  if (error) throw new Error(`retention: namespaces failed: ${error.message}`);
  if (sErr) log?.warn?.({ err: sErr.message }, "retention: settings rows unavailable; organization values apply");
  const byNs = new Map((settings || []).map((s) => [s.namespace_id, s]));
  return (namespaces || []).map((ns) => compose({
    namespaceId: ns.id, organizationId: ns.organization_id, namespaceName: ns.name,
    orgRow: ns.organization || null, settingsRow: byNs.get(ns.id) || null,
  }));
}
