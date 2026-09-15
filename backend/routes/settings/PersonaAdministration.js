// =============================================================
//  Persona and PCL administration (customer spec 4.4, plan section 9).
//
//  Personas are named definitions; their rules live in pcl as an
//  append-only version history. Administrators create personas in
//  their organization, save new versions (validated; a failed save
//  inserts nothing), activate and deactivate them, assign them to
//  users and set namespace defaults. Shared personas (no organization)
//  are super-admin only to change.
//
//  Nothing here touches roles, memberships, documents or memories:
//  assigning a persona writes one column on user_settings, and the
//  response echoes the user's unchanged role and namespaces so that
//  is visible. Every write logs a structured line and clears the
//  resolver cache so the next chat turn sees it.
// =============================================================

import { hasPermission, identityFrom } from "../../lib/permissions.js";
import { validateConfiguration } from "../../pcl/validate.js";
import { renderConfiguration } from "../../pcl/render.js";
import { resolvePcl, invalidatePcl } from "../../pcl/resolve.js";
import {
  canAccessOrganization,
  findUser,
  membershipsFor,
  requireSettingsManager,
  withNamespaces,
} from "./shared.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const clean = (value) => (typeof value === "string" ? value.trim() : "");
const PERSONA_COLUMNS = "id,key,name,description,is_active,organization_id,created_at,updated_at";
const VERSION_COLUMNS = "id,version,configuration,created_by,created_at";

/** Settings-manager scope plus the permission-map action (spec section 10). */
function requirePersonaManager(req, reply, action) {
  const scope = requireSettingsManager(req, reply);
  if (!scope) return null;
  if (!hasPermission(identityFrom(req), action)) {
    reply.code(403).send({ error: `${action} permission required.` });
    return null;
  }
  return scope;
}

const canSee = (scope, persona) => !persona.organization_id || canAccessOrganization(scope, persona.organization_id);
const canEdit = (scope, persona) => persona.organization_id ? canAccessOrganization(scope, persona.organization_id) : scope.isSuperAdmin;

function publicPersona(p) {
  const { organization, ...rest } = p;
  return { ...rest, shared: !p.organization_id, organization: organization || null };
}

function logEvent(req, event, fields) {
  req.log.info({ event, actorUserId: req.user?.userId || null, timestamp: new Date().toISOString(), ...fields }, event.replace(/_/g, " "));
}

export default async function personaAdministration(fastify) {
  const db = () => fastify.supabase;

  async function loadPersona(id) {
    if (!UUID.test(String(id || ""))) return { data: null, error: null };
    return db().from("personas").select(`${PERSONA_COLUMNS}, organization:organization_id(id,name)`).eq("id", id).maybeSingle();
  }

  async function newestVersion(personaId) {
    return db().from("pcl").select(VERSION_COLUMNS).eq("persona_id", personaId)
      .order("version", { ascending: false }).limit(1).maybeSingle();
  }

  /** A persona the scope may see, or a reply already sent (404 for out-of-scope, same as missing). */
  async function visiblePersona(scope, id, reply) {
    const { data, error } = await loadPersona(id);
    if (error) { reply.code(500).send({ error: "Unable to load persona." }); return null; }
    if (!data || !canSee(scope, data)) { reply.code(404).send({ error: "Persona not found." }); return null; }
    return data;
  }

  /** A persona the scope may change, or a reply already sent. */
  async function editablePersona(scope, id, reply) {
    const persona = await visiblePersona(scope, id, reply);
    if (!persona) return null;
    if (!canEdit(scope, persona)) {
      reply.code(403).send({ error: persona.organization_id ? "Persona organization access denied." : "Shared personas can be changed only by a super administrator." });
      return null;
    }
    return persona;
  }

  /** The target user for an assignment: in scope, and admins never manage super admins. */
  async function targetUser(scope, userId, reply) {
    if (!UUID.test(String(userId || ""))) { reply.code(404).send({ error: "User not found." }); return null; }
    const { data, error } = await findUser(fastify, userId);
    if (error) { reply.code(500).send({ error: "Unable to load user." }); return null; }
    if (!data) { reply.code(404).send({ error: "User not found." }); return null; }
    if (!canAccessOrganization(scope, data.organization?.id)) { reply.code(403).send({ error: "User organization access denied." }); return null; }
    if (!scope.isSuperAdmin && data.role?.name === "super_admin") { reply.code(403).send({ error: "Administrators cannot manage super administrators." }); return null; }
    return data;
  }

  /** A persona that may be assigned within `organizationId`: visible, active, shared or that organization's. */
  async function assignablePersona(scope, personaId, organizationId, reply) {
    if (!UUID.test(String(personaId || ""))) { reply.code(400).send({ error: "persona_id must be a persona id or null." }); return null; }
    const { data, error } = await loadPersona(personaId);
    if (error) { reply.code(500).send({ error: "Unable to load persona." }); return null; }
    if (!data || !canSee(scope, data)) { reply.code(404).send({ error: "Persona not found." }); return null; }
    if (data.organization_id && data.organization_id !== organizationId) { reply.code(400).send({ error: "That persona belongs to another organization." }); return null; }
    if (!data.is_active) { reply.code(409).send({ error: "That persona is deactivated." }); return null; }
    return data;
  }

  // ---------------------------------------------------------------
  // GET /api/settings/personas
  // Shared personas plus the caller's organization's (super admin: every
  // organization), each with its current version and how many users and
  // namespaces use it.
  // ---------------------------------------------------------------
  fastify.get("/api/settings/personas", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_personas");
    if (!scope) return;
    let query = db().from("personas").select(`${PERSONA_COLUMNS}, organization:organization_id(id,name)`).order("name");
    if (!scope.isSuperAdmin) query = query.or(`organization_id.is.null,organization_id.eq.${scope.organizationId}`);
    const { data: personas, error } = await query;
    if (error) return reply.code(500).send({ error: "Unable to load personas." });
    const ids = personas.map(p => p.id);
    if (!ids.length) return { personas: [] };
    const [versions, users, namespaces] = await Promise.all([
      db().from("pcl").select("persona_id,version,created_by,created_at").in("persona_id", ids).order("version", { ascending: false }),
      db().from("user_settings").select("persona_id").in("persona_id", ids),
      db().from("namespace").select("id,default_persona_id").in("default_persona_id", ids),
    ]);
    if (versions.error || users.error || namespaces.error) return reply.code(500).send({ error: "Unable to load persona usage." });
    const current = new Map();
    for (const v of versions.data) if (!current.has(v.persona_id)) current.set(v.persona_id, { version: v.version, created_by: v.created_by, created_at: v.created_at });
    const count = (rows, key) => rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map());
    const userCounts = count(users.data, "persona_id");
    const namespaceCounts = count(namespaces.data, "default_persona_id");
    return {
      personas: personas.map(p => ({
        ...publicPersona(p),
        current_version: current.get(p.id) || null,
        users: userCounts.get(p.id) || 0,
        namespaces: namespaceCounts.get(p.id) || 0,
      })),
    };
  });

  // ---------------------------------------------------------------
  // POST /api/settings/personas
  // { key, name, description?, configuration?, shared?, organizationId? }
  // Created in the caller's organization with a validated version 1.
  // Only a super admin may create a shared persona or choose another
  // organization. A configuration that fails validation creates nothing.
  // ---------------------------------------------------------------
  fastify.post("/api/settings/personas", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_personas");
    if (!scope) return;
    const body = req.body || {};
    const key = clean(body.key).toLowerCase();
    const name = clean(body.name);
    const description = clean(body.description) || null;
    if (!KEY.test(key)) return reply.code(400).send({ error: "key must be 2 to 64 characters: lowercase letters, digits and underscores, starting with a letter." });
    if (!name) return reply.code(400).send({ error: "name is required." });

    let organizationId = scope.organizationId;
    if (body.shared === true || body.organizationId) {
      if (!scope.isSuperAdmin) return reply.code(403).send({ error: "Only a super administrator may create a shared persona or choose the organization." });
      if (body.shared === true) organizationId = null;
      else {
        if (!UUID.test(String(body.organizationId))) return reply.code(400).send({ error: "organizationId must be an organization id." });
        const { data: org } = await db().from("organization").select("id").eq("id", body.organizationId).maybeSingle();
        if (!org) return reply.code(404).send({ error: "Organization not found." });
        organizationId = org.id;
      }
    }
    if (!organizationId && !scope.isSuperAdmin) return reply.code(403).send({ error: "Administrator organization is missing." });

    const check = validateConfiguration(body.configuration === undefined ? {} : body.configuration);
    if (!check.ok) return reply.code(400).send({ error: "Configuration is invalid.", errors: check.errors, warnings: check.warnings });

    const { data: persona, error } = await db().from("personas")
      .insert({ key, name, description, organization_id: organizationId })
      .select(`${PERSONA_COLUMNS}, organization:organization_id(id,name)`).single();
    if (error) {
      if (error.code === "23505") return reply.code(409).send({ error: organizationId ? "That key is already used in this organization." : "That key is already used by a shared persona." });
      if (error.code === "23514") return reply.code(400).send({ error: "key is not in the accepted format." });
      return reply.code(500).send({ error: "Unable to create persona." });
    }
    const { data: version, error: versionError } = await db().from("pcl")
      .insert({ persona_id: persona.id, version: 1, configuration: check.normalized, created_by: req.user?.userId || null })
      .select(VERSION_COLUMNS).single();
    if (versionError) {
      await db().from("personas").delete().eq("id", persona.id);
      return reply.code(500).send({ error: "Unable to save the first version." });
    }
    logEvent(req, "persona_created", { personaId: persona.id, personaKey: persona.key, organizationId });
    return reply.code(201).send({ persona: publicPersona(persona), version, warnings: check.warnings });
  });

  // ---------------------------------------------------------------
  // PATCH /api/settings/personas/:id   { name?, description? }
  // ---------------------------------------------------------------
  fastify.patch("/api/settings/personas/:id", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_personas");
    if (!scope) return;
    const persona = await editablePersona(scope, req.params.id, reply);
    if (!persona) return;
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) { const name = clean(body.name); if (!name) return reply.code(400).send({ error: "name cannot be empty." }); patch.name = name; }
    if (body.description !== undefined) patch.description = clean(body.description) || null;
    const unknown = Object.keys(body).filter(k => !["name", "description"].includes(k));
    if (unknown.length) return reply.code(400).send({ error: `Only name and description can be changed here (not ${unknown.join(", ")}).` });
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "Provide a name or description." });
    const { data, error } = await db().from("personas").update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", persona.id).select(`${PERSONA_COLUMNS}, organization:organization_id(id,name)`).single();
    if (error) return reply.code(500).send({ error: "Unable to update persona." });
    logEvent(req, "persona_updated", { personaId: persona.id, personaKey: persona.key, fields: Object.keys(patch) });
    return { persona: publicPersona(data) };
  });

  // ---------------------------------------------------------------
  // GET /api/settings/personas/:id/versions
  // Every version, newest first, with creator and time. With the pcl
  // field on rag_queries this is the audit of what was in force when.
  // ---------------------------------------------------------------
  fastify.get("/api/settings/personas/:id/versions", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_pcl");
    if (!scope) return;
    const persona = await visiblePersona(scope, req.params.id, reply);
    if (!persona) return;
    const { data, error } = await db().from("pcl").select(VERSION_COLUMNS).eq("persona_id", persona.id).order("version", { ascending: false });
    if (error) return reply.code(500).send({ error: "Unable to load versions." });
    return { persona: publicPersona(persona), versions: data };
  });

  // ---------------------------------------------------------------
  // POST /api/settings/personas/:id/versions
  // Body: a configuration object (or { configuration }). Validated; on
  // pass inserts version + 1 and returns it; on fail returns the errors
  // and inserts nothing, so the previous version stays in force.
  // ---------------------------------------------------------------
  fastify.post("/api/settings/personas/:id/versions", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_pcl");
    if (!scope) return;
    const persona = await editablePersona(scope, req.params.id, reply);
    if (!persona) return;
    const body = req.body;
    const configuration = body && typeof body === "object" && !Array.isArray(body) && body.configuration !== undefined && Object.keys(body).length === 1
      ? body.configuration : body;
    const check = validateConfiguration(configuration);
    if (!check.ok) return reply.code(400).send({ error: "Configuration is invalid; nothing was saved.", errors: check.errors, warnings: check.warnings });
    const { data: newest, error: newestError } = await newestVersion(persona.id);
    if (newestError) return reply.code(500).send({ error: "Unable to load the current version." });
    const version = (newest?.version || 0) + 1;
    const { data, error } = await db().from("pcl")
      .insert({ persona_id: persona.id, version, configuration: check.normalized, created_by: req.user?.userId || null })
      .select(VERSION_COLUMNS).single();
    if (error) {
      if (error.code === "23505") return reply.code(409).send({ error: "Another version was saved at the same moment; reload and try again." });
      return reply.code(500).send({ error: "Unable to save the version." });
    }
    invalidatePcl();
    logEvent(req, "pcl_version_created", { personaId: persona.id, personaKey: persona.key, version, chars: renderConfiguration(check.normalized).chars });
    return reply.code(201).send({ persona: publicPersona(persona), version: data, warnings: check.warnings });
  });

  // ---------------------------------------------------------------
  // POST /api/settings/personas/:id/activate | /deactivate
  // Deactivating a namespace default is refused with the namespaces named.
  // ---------------------------------------------------------------
  for (const action of ["activate", "deactivate"]) {
    fastify.post(`/api/settings/personas/:id/${action}`, async (req, reply) => {
      const scope = requirePersonaManager(req, reply, "manage_personas");
      if (!scope) return;
      const persona = await editablePersona(scope, req.params.id, reply);
      if (!persona) return;
      const active = action === "activate";
      if (!active) {
        const { data: defaults, error } = await db().from("namespace").select("id,name").eq("default_persona_id", persona.id).order("name");
        if (error) return reply.code(500).send({ error: "Unable to check namespace defaults." });
        if (defaults.length) {
          return reply.code(409).send({
            error: `This persona is the default for ${defaults.map(n => n.name).join(", ")}. Choose another default for ${defaults.length === 1 ? "that namespace" : "those namespaces"} first.`,
            namespaces: defaults,
          });
        }
      }
      const { data, error } = await db().from("personas").update({ is_active: active, updated_at: new Date().toISOString() })
        .eq("id", persona.id).select(`${PERSONA_COLUMNS}, organization:organization_id(id,name)`).single();
      if (error) return reply.code(500).send({ error: `Unable to ${action} persona.` });
      invalidatePcl();
      logEvent(req, active ? "persona_activated" : "persona_deactivated", { personaId: persona.id, personaKey: persona.key });
      return { persona: publicPersona(data) };
    });
  }

  // ---------------------------------------------------------------
  // PATCH /api/settings/users/:userId/persona   { persona_id | null }
  // Writes only user_settings.persona_id. The response echoes the
  // user's unchanged role and namespaces.
  // ---------------------------------------------------------------
  fastify.patch("/api/settings/users/:userId/persona", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_personas");
    if (!scope) return;
    const body = req.body || {};
    if (!("persona_id" in body)) return reply.code(400).send({ error: "Provide persona_id (a persona id, or null to clear)." });
    const user = await targetUser(scope, req.params.userId, reply);
    if (!user) return;
    let persona = null;
    if (body.persona_id !== null) {
      persona = await assignablePersona(scope, body.persona_id, user.organization?.id, reply);
      if (!persona) return;
    }
    const { data: existing, error: existingError } = await db().from("user_settings").select("user_id").eq("user_id", user.id).maybeSingle();
    if (existingError) return reply.code(500).send({ error: "Unable to load user settings." });
    const write = existing
      ? db().from("user_settings").update({ persona_id: persona?.id || null, updated_at: new Date().toISOString() }).eq("user_id", user.id)
      : db().from("user_settings").insert({ user_id: user.id, persona_id: persona?.id || null });
    const { error } = await write;
    if (error) return reply.code(500).send({ error: "Unable to assign persona." });
    invalidatePcl(user.id);
    logEvent(req, "user_persona_assigned", { targetUserId: user.id, personaId: persona?.id || null, personaKey: persona?.key || null });
    const { data: memberships } = await membershipsFor(fastify, [user.id]);
    const [withNs] = withNamespaces([user], memberships || []);
    return { user: withNs, persona: persona ? { id: persona.id, key: persona.key, name: persona.name } : null };
  });

  // ---------------------------------------------------------------
  // PATCH /api/settings/namespaces/:id/persona   { persona_id | null }
  // ---------------------------------------------------------------
  fastify.patch("/api/settings/namespaces/:id/persona", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_personas");
    if (!scope) return;
    const body = req.body || {};
    if (!("persona_id" in body)) return reply.code(400).send({ error: "Provide persona_id (a persona id, or null to clear)." });
    if (!UUID.test(String(req.params.id || ""))) return reply.code(404).send({ error: "Namespace not found." });
    const { data: namespace, error: nsError } = await db().from("namespace").select("id,name,organization_id").eq("id", req.params.id).maybeSingle();
    if (nsError) return reply.code(500).send({ error: "Unable to load namespace." });
    if (!namespace) return reply.code(404).send({ error: "Namespace not found." });
    if (!canAccessOrganization(scope, namespace.organization_id)) return reply.code(403).send({ error: "Namespace access denied." });
    let persona = null;
    if (body.persona_id !== null) {
      persona = await assignablePersona(scope, body.persona_id, namespace.organization_id, reply);
      if (!persona) return;
    }
    const { error } = await db().from("namespace").update({ default_persona_id: persona?.id || null }).eq("id", namespace.id);
    if (error) return reply.code(500).send({ error: "Unable to set the namespace default." });
    invalidatePcl();
    logEvent(req, "namespace_persona_assigned", { namespaceId: namespace.id, personaId: persona?.id || null, personaKey: persona?.key || null });
    return { namespace: { ...namespace, default_persona: persona ? { id: persona.id, key: persona.key, name: persona.name } : null } };
  });

  // ---------------------------------------------------------------
  // GET /api/settings/personas/preview?userId=…[&namespaceId=…]
  // What this user would get on their next turn: persona, version,
  // answer length and the rendered blocks. The debugging surface spec 51
  // asks for; the editor's preview uses it.
  // ---------------------------------------------------------------
  fastify.get("/api/settings/personas/preview", async (req, reply) => {
    const scope = requirePersonaManager(req, reply, "manage_pcl");
    if (!scope) return;
    const user = await targetUser(scope, req.query?.userId, reply);
    if (!user) return;
    const { data: memberships, error } = await membershipsFor(fastify, [user.id]);
    if (error) return reply.code(500).send({ error: "Unable to load memberships." });
    const namespaces = (memberships || []).map(m => m.namespace).filter(Boolean);
    const wanted = req.query?.namespaceId ? namespaces.find(n => n.id === req.query.namespaceId) : namespaces[0];
    if (req.query?.namespaceId && !wanted) return reply.code(404).send({ error: "That user is not a member of that namespace." });
    const identity = { userId: user.id, role: user.role?.name || null, organizationId: user.organization?.id || null, namespaceId: wanted?.id || null, namespace: wanted?.name || null };
    invalidatePcl(user.id);   // a preview is always fresh
    const resolved = await resolvePcl(db(), identity, { log: req.log });
    return {
      user: { id: user.id, email: user.email, role: user.role?.name || null, organization: user.organization || null, namespace: wanted || null },
      source: resolved.source,
      reason: resolved.reason,
      persona: resolved.persona ? { id: resolved.persona.id, key: resolved.persona.key, name: resolved.persona.name } : null,
      persona_source: resolved.personaSource,
      version: resolved.version,
      length: resolved.length,
      length_source: resolved.lengthSource,
      personalization: resolved.personalization,
      rendered: resolved.rendered,
      provenance: resolved.provenance,
    };
  });
}
