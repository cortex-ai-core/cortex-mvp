// =============================================================
//  Chat retention administration (retention plan Phase 4).
//
//    GET   /api/settings/organizations/:id/retention   policy, per-namespace
//                                                      effect, counts
//    PATCH /api/settings/organizations/:id/retention   days, hold, reason
//    GET   /api/settings/organizations/:id/holds       threads on hold
//    POST  /api/settings/conversations/:id/hold        {hold, reason}
//    PATCH /api/settings/namespaces/:id/retention      {retention_days|null}
//
//  Admin: own organization; super admin: any. Everything needs the
//  manage_retention permission. Holds are logged as legal_hold_set /
//  legal_hold_cleared events; policy changes as log lines. Every write
//  forgets the policy cache. 503 until migration 0013 is present.
// =============================================================

import { canAccessOrganization, requireSettingsManager } from "./shared.js";
import { hasPermission, identityFrom } from "../../lib/permissions.js";
import { retentionSchemaReady } from "../../retention/schema.js";
import { envPolicyDefaults, invalidateRetentionPolicy } from "../../retention/policy.js";
import { invalidateSettings } from "../../memory/settings.js";

const MAX_DAYS = 3650;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, max = 200) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

function parseDays(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DAYS) return undefined;
  return n;
}

export default async function retentionAdministration(fastify) {
  const db = fastify.supabase;

  const guard = async (req, reply) => {
    const scope = requireSettingsManager(req, reply);
    if (!scope) return null;
    if (!hasPermission(identityFrom(req), "manage_retention")) { reply.code(403).send({ error: "Your role can't manage chat retention." }); return null; }
    if (!(await retentionSchemaReady(db, fastify.log))) { reply.code(503).send({ error: "Chat retention is not set up on this database yet (migration 0013)." }); return null; }
    return scope;
  };

  const cutoff = (days) => (days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null);

  /**
   * The GET payload for one organization. `previewDays` reports how many
   * threads would be due under a value the admin is considering, so the
   * page can warn before a shorter period is saved.
   */
  async function loadRetention(organizationId, { previewDays = null } = {}) {
    const { data: org, error } = await db.from("organization").select("id, name, chat_retention_days, retention_hold, retention_hold_reason, last_updated_at").eq("id", organizationId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!org) return null;
    const [{ data: namespaces }, { data: settings }] = await Promise.all([
      db.from("namespace").select("id, name").eq("organization_id", organizationId).order("name"),
      db.from("memory_settings").select("namespace_id, retention_days").eq("organization_id", organizationId),
    ]);
    const override = new Map((settings || []).map((s) => [s.namespace_id, s.retention_days]));
    const env = envPolicyDefaults();
    const rows = (namespaces || []).map((ns) => {
      const o = override.get(ns.id);
      const effective = o !== null && o !== undefined ? o : (org.chat_retention_days ?? env.days);
      return { id: ns.id, name: ns.name, retention_days: o ?? null, effective_days: effective, source: o !== null && o !== undefined ? "namespace" : "organization" };
    });
    const count = (q) => q.then((r) => Number(r.count) || 0);
    const base = () => db.from("conversations").select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
    const [active, archived, held] = await Promise.all([
      count(base().is("archived_at", null)),
      count(base().not("archived_at", "is", null)),
      count(base().eq("legal_hold", true)),
    ]);
    const dueFor = async (daysOf) => {
      let due = 0;
      for (const ns of rows) {
        const c = cutoff(daysOf(ns));
        if (!c) continue;
        due += await count(base().eq("namespace_id", ns.id).is("archived_at", null).eq("legal_hold", false).or(`last_message_at.lt.${c},and(last_message_at.is.null,created_at.lt.${c})`));
      }
      return due;
    };
    const due = await dueFor((ns) => ns.effective_days);
    const payload = {
      organization: { id: org.id, name: org.name, chat_retention_days: org.chat_retention_days, retention_hold: Boolean(org.retention_hold), retention_hold_reason: org.retention_hold_reason || null, last_updated_at: org.last_updated_at || null },
      default_days: env.days,
      namespaces: rows,
      counts: { active, archived, held, due },
    };
    if (previewDays !== null) {
      // namespaces with their own override are unaffected by the organization value
      payload.preview = { days: previewDays, due: await dueFor((ns) => (ns.source === "namespace" ? ns.effective_days : previewDays)) };
    }
    return payload;
  }

  const event = async (row) => {
    const { error } = await db.from("memory_events").insert([row]);
    if (error) fastify.log.warn({ err: error.message, event: row.event }, "retention admin: event log failed");
  };

  // GET /api/settings/organizations/:organizationId/retention[?days=N]   (days = preview a value: how many threads would be due)
  fastify.get("/api/settings/organizations/:organizationId/retention", async (req, reply) => {
    const scope = await guard(req, reply);
    if (!scope) return;
    const { organizationId } = req.params;
    if (!canAccessOrganization(scope, organizationId)) return reply.code(403).send({ error: "Organization access denied." });
    const previewDays = req.query?.days !== undefined ? parseDays(req.query.days) : null;
    if (previewDays === undefined) return reply.code(400).send({ error: `days must be a whole number from 0 to ${MAX_DAYS}.` });
    try {
      const payload = await loadRetention(organizationId, { previewDays });
      if (!payload) return reply.code(404).send({ error: "Organization not found." });
      return payload;
    } catch (err) {
      fastify.log.error({ err: err?.message }, "retention admin: load failed");
      return reply.code(500).send({ error: "Unable to load chat retention." });
    }
  });

  // PATCH /api/settings/organizations/:organizationId/retention  { chat_retention_days?, retention_hold?, retention_hold_reason? }
  fastify.patch("/api/settings/organizations/:organizationId/retention", async (req, reply) => {
    const scope = await guard(req, reply);
    if (!scope) return;
    const { organizationId } = req.params;
    if (!canAccessOrganization(scope, organizationId)) return reply.code(403).send({ error: "Organization access denied." });
    const identity = identityFrom(req);
    const body = req.body || {};
    const updates = {};
    if (body.chat_retention_days !== undefined) {
      const days = parseDays(body.chat_retention_days);
      if (days === undefined || days === null) return reply.code(400).send({ error: `chat_retention_days must be a whole number of days from 0 (keep forever) to ${MAX_DAYS}.` });
      updates.chat_retention_days = days;
    }
    let holdChange = null;
    if (body.retention_hold !== undefined) {
      if (typeof body.retention_hold !== "boolean") return reply.code(400).send({ error: "retention_hold must be true or false." });
      const reason = clean(body.retention_hold_reason);
      if (body.retention_hold && !reason) return reply.code(400).send({ error: "A reason is required to place a retention hold." });
      updates.retention_hold = body.retention_hold;
      updates.retention_hold_reason = body.retention_hold ? reason : null;
      holdChange = body.retention_hold;
    } else if (body.retention_hold_reason !== undefined) {
      updates.retention_hold_reason = clean(body.retention_hold_reason) || null;
    }
    if (!Object.keys(updates).length) return reply.code(400).send({ error: "Nothing to change: send chat_retention_days, retention_hold or retention_hold_reason." });

    const { data: before } = await db.from("organization").select("id, chat_retention_days, retention_hold").eq("id", organizationId).maybeSingle();
    if (!before) return reply.code(404).send({ error: "Organization not found." });
    updates.last_updated_at = new Date().toISOString();
    const { error } = await db.from("organization").update(updates).eq("id", organizationId);
    if (error) { fastify.log.error({ err: error.message }, "retention admin: update failed"); return reply.code(500).send({ error: "Unable to update chat retention." }); }
    invalidateRetentionPolicy();

    if (updates.chat_retention_days !== undefined && updates.chat_retention_days !== before.chat_retention_days) {
      fastify.log.info({ organizationId, from: before.chat_retention_days, to: updates.chat_retention_days, by: identity.userId }, "retention admin: chat_retention_days changed");
    }
    if (holdChange !== null && holdChange !== Boolean(before.retention_hold)) {
      await event({
        event: holdChange ? "legal_hold_set" : "legal_hold_cleared", actor: identity.userId,
        actor_organization_id: identity.organizationId, target_organization_id: organizationId,
        reason: updates.retention_hold_reason || null, detail: { scope: "organization" },
      });
    }
    try { return await loadRetention(organizationId); }
    catch { return reply.code(500).send({ error: "Updated, but unable to reload chat retention." }); }
  });

  // GET /api/settings/organizations/:organizationId/holds — threads on legal hold, newest hold first
  fastify.get("/api/settings/organizations/:organizationId/holds", async (req, reply) => {
    const scope = await guard(req, reply);
    if (!scope) return;
    const { organizationId } = req.params;
    if (!canAccessOrganization(scope, organizationId)) return reply.code(403).send({ error: "Organization access denied." });
    const { data, error } = await db.from("conversations")
      .select("id, title, archived_at, legal_hold_reason, legal_hold_by, legal_hold_at, namespace:namespace_id(name), owner:user_id(email)")
      .eq("organization_id", organizationId).eq("legal_hold", true)
      .order("legal_hold_at", { ascending: false, nullsFirst: false }).limit(200);
    if (error) return reply.code(500).send({ error: "Unable to load holds." });
    return { holds: (data || []).map((c) => ({
      conversation_id: c.id, title: c.title, state: c.archived_at ? "archived" : "active",
      namespace: c.namespace?.name || null, owner_email: c.owner?.email || null,
      legal_hold_reason: c.legal_hold_reason, legal_hold_by: c.legal_hold_by, legal_hold_at: c.legal_hold_at,
    })) };
  });

  // POST /api/settings/conversations/:id/hold  { hold: boolean, reason? }
  fastify.post("/api/settings/conversations/:id/hold", async (req, reply) => {
    const scope = await guard(req, reply);
    if (!scope) return;
    const { id } = req.params;
    if (!UUID.test(id)) return reply.code(404).send({ error: "Conversation not found." });
    const identity = identityFrom(req);
    const hold = req.body?.hold;
    if (typeof hold !== "boolean") return reply.code(400).send({ error: "hold must be true or false." });
    const reason = clean(req.body?.reason);
    if (hold && !reason) return reply.code(400).send({ error: "A reason is required to place a legal hold." });

    const { data: c, error } = await db.from("conversations").select("id, organization_id, user_id, title, archived_at, legal_hold").eq("id", id).maybeSingle();
    if (error) return reply.code(500).send({ error: "Unable to load the conversation." });
    if (!c || !canAccessOrganization(scope, c.organization_id)) return reply.code(404).send({ error: "Conversation not found." });

    const patch = hold
      ? { legal_hold: true, legal_hold_reason: reason, legal_hold_by: identity.userId, legal_hold_at: new Date().toISOString() }
      : { legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null };
    const { data: saved, error: upErr } = await db.from("conversations").update(patch).eq("id", id)
      .select("id, title, archived_at, legal_hold, legal_hold_reason, legal_hold_by, legal_hold_at").single();
    if (upErr) return reply.code(500).send({ error: "Unable to update the hold." });
    if (hold !== Boolean(c.legal_hold)) {
      await event({
        event: hold ? "legal_hold_set" : "legal_hold_cleared", actor: identity.userId,
        actor_organization_id: identity.organizationId, target_organization_id: c.organization_id, target_user_id: c.user_id,
        conversation_id: id, reason: reason || null, detail: { scope: "conversation" },
      });
    }
    return { conversation: { conversation_id: saved.id, title: saved.title, state: saved.archived_at ? "archived" : "active", legal_hold: saved.legal_hold, legal_hold_reason: saved.legal_hold_reason, legal_hold_by: saved.legal_hold_by, legal_hold_at: saved.legal_hold_at } };
  });

  // PATCH /api/settings/namespaces/:id/retention  { retention_days: number | null }   (null = inherit the organization)
  fastify.patch("/api/settings/namespaces/:id/retention", async (req, reply) => {
    const scope = await guard(req, reply);
    if (!scope) return;
    const { id } = req.params;
    if (!UUID.test(id)) return reply.code(404).send({ error: "Namespace not found." });
    const days = parseDays(req.body?.retention_days);
    if (days === undefined) return reply.code(400).send({ error: `retention_days must be null (inherit) or a whole number of days from 0 (keep forever) to ${MAX_DAYS}.` });
    const { data: ns, error } = await db.from("namespace").select("id, name, organization_id, organization:organization_id(chat_retention_days)").eq("id", id).maybeSingle();
    if (error) return reply.code(500).send({ error: "Unable to load the namespace." });
    if (!ns || !canAccessOrganization(scope, ns.organization_id)) return reply.code(404).send({ error: "Namespace not found." });
    const identity = identityFrom(req);
    const { error: upErr } = await db.from("memory_settings")
      .upsert({ namespace_id: id, organization_id: ns.organization_id, retention_days: days, updated_by: identity.userId, updated_at: new Date().toISOString() }, { onConflict: "namespace_id" });
    if (upErr) { fastify.log.error({ err: upErr.message }, "retention admin: namespace override failed"); return reply.code(500).send({ error: "Unable to update the namespace's retention." }); }
    invalidateRetentionPolicy(id);
    invalidateSettings(id);
    fastify.log.info({ namespaceId: id, retention_days: days, by: identity.userId }, "retention admin: namespace retention override changed");
    const effective = days !== null ? days : (ns.organization?.chat_retention_days ?? envPolicyDefaults().days);
    return { namespace: { id: ns.id, name: ns.name, retention_days: days, effective_days: effective, source: days !== null ? "namespace" : "organization" } };
  });
}
