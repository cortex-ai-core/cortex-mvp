// =============================================================
//  Persona and PCL resolution for one chat turn (plan section 7).
//
//  Given the already-authorized identity, find which persona applies
//  (the user's assignment, else the namespace default, else none), its
//  newest version, the user's own style and note, and render the text
//  the prompt gets. Never throws. Any failure yields the built-in
//  default with a reason, exactly as chat behaved before personas.
//
//  Reads user_settings, namespace.default_persona_id, personas and pcl.
//  Never reads roles, memberships, documents or memories, and nothing
//  it returns is consulted by retrieval, memory, DLP or permissions.
//  Cached for a minute per user and namespace; admin writes call
//  invalidatePcl().
// =============================================================

import { responseStyles } from "../lib/userPreferences.js";
import { validateConfiguration, LIMITS } from "./validate.js";
import { renderConfiguration, renderedText } from "./render.js";
import { sha256Text } from "./integrity.js";

const CACHE_MS = 60_000;
const cache = new Map();            // `${userId}:${namespaceId}` -> { at, loaded }
let tablesMissing = false;          // 0011 not applied yet; noticed once
let tablesMissingLogged = false;

export function pclEnabled() {
  const v = process.env.PCL_ENABLED;
  if (v === undefined || v === "") return true;
  return !["0", "false", "off", "no"].includes(String(v).trim().toLowerCase());
}

/** Forget cached resolutions: one user, or everyone after a persona change. */
export function invalidatePcl(userId = null) {
  if (userId) {
    for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
  } else cache.clear();
  tablesMissing = false;
}

const missingSchema = (error) =>
  /relation .* does not exist|column .* does not exist|42P01|42703|PGRST204|PGRST205/i.test(error?.message || "") ||
  ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code);

function defaultLoaded(reason) {
  return { source: "default", reason, preferences: null, persona: null, personaSource: "none", version: null, configuration: null, rendered: null, hash: null };
}

/** The two-to-four queries behind a cache miss. Returns a `loaded` bundle; never throws. */
async function load(supabase, identity, log) {
  if (!supabase) return defaultLoaded("no database client");
  if (tablesMissing) return defaultLoaded("migration 0011 not applied");
  const userId = identity?.userId || null;
  const namespaceId = identity?.namespaceId || null;

  const [prefRes, nsRes] = await Promise.all([
    userId
      ? supabase.from("user_settings").select("response_style, personalization, persona_id").eq("user_id", userId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    namespaceId
      ? supabase.from("namespace").select("default_persona_id").eq("id", namespaceId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [prefRes, nsRes]) {
    if (r.error) {
      if (missingSchema(r.error)) {
        tablesMissing = true;
        if (!tablesMissingLogged) { tablesMissingLogged = true; log?.info?.("pcl: persona tables not present yet (migration 0011); using the built-in default"); }
        return defaultLoaded("migration 0011 not applied");
      }
      log?.warn?.({ err: r.error.message }, "pcl: settings lookup failed; using the built-in default");
      return defaultLoaded(`settings lookup failed: ${r.error.message}`);
    }
  }

  const row = prefRes.data || null;
  const preferences = {
    hasRow: Boolean(row),
    style: responseStyles.has(row?.response_style) ? row.response_style : "neutral",
    personalization: typeof row?.personalization === "string" ? row.personalization.trim() : "",
    personaId: row?.persona_id || null,
  };

  // Candidates in precedence order; each must exist, be active, and be
  // shared or belong to the user's organization.
  const candidates = [
    { id: preferences.personaId, from: "user" },
    { id: nsRes.data?.default_persona_id || null, from: "namespace" },
  ].filter(c => c.id);

  let persona = null;
  let personaSource = "none";
  if (candidates.length) {
    const { data: rows, error } = await supabase
      .from("personas")
      .select("id, key, name, is_active, organization_id")
      .in("id", [...new Set(candidates.map(c => c.id))]);
    if (error) {
      if (missingSchema(error)) { tablesMissing = true; return defaultLoaded("migration 0011 not applied"); }
      log?.warn?.({ err: error.message }, "pcl: persona lookup failed; using the built-in default");
      return defaultLoaded(`persona lookup failed: ${error.message}`);
    }
    const byId = new Map((rows || []).map(r => [r.id, r]));
    for (const c of candidates) {
      const p = byId.get(c.id);
      if (!p) { log?.info?.({ personaId: c.id, from: c.from }, "pcl: assigned persona does not exist; skipped"); continue; }
      if (!p.is_active) { log?.info?.({ personaKey: p.key, from: c.from }, "pcl: assigned persona is deactivated; skipped"); continue; }
      if (p.organization_id && p.organization_id !== identity?.organizationId) {
        log?.warn?.({ personaKey: p.key, from: c.from }, "pcl: assigned persona belongs to another organization; skipped");
        continue;
      }
      persona = p; personaSource = c.from; break;
    }
  }

  if (!persona) {
    return { source: "resolved", reason: null, preferences, persona: null, personaSource: "none", version: null, configuration: null, rendered: null, hash: null };
  }

  const { data: ver, error: verError } = await supabase
    .from("pcl")
    .select("version, configuration")
    .eq("persona_id", persona.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (verError) {
    if (missingSchema(verError)) { tablesMissing = true; return defaultLoaded("migration 0011 not applied"); }
    log?.warn?.({ err: verError.message, personaKey: persona.key }, "pcl: version lookup failed; using the built-in default");
    return defaultLoaded(`version lookup failed: ${verError.message}`);
  }
  const version = ver?.version ?? 0;
  const stored = ver?.configuration ?? {};

  // A stored row is validated again on read: what reaches the prompt is
  // always something the validator accepts today.
  const check = validateConfiguration(stored);
  if (!check.ok) {
    log?.warn?.({ personaKey: persona.key, version, errors: check.errors.slice(0, 3) }, "pcl: stored configuration no longer validates; using the built-in default");
    return { ...defaultLoaded(`stored configuration invalid: ${check.errors[0]}`), preferences };
  }
  const rendered = renderConfiguration(check.normalized, { personaName: persona.name, version });
  if (rendered.chars > LIMITS.rendered) {
    log?.warn?.({ personaKey: persona.key, version, chars: rendered.chars }, "pcl: rendered text over the size cap; using the built-in default");
    return { ...defaultLoaded(`rendered text over ${LIMITS.rendered} characters`), preferences };
  }

  return {
    source: "resolved", reason: null, preferences, persona, personaSource, version,
    configuration: check.normalized, rendered, hash: sha256Text(renderedText(rendered)),
  };
}

/**
 * Resolve the persona, rules and user layer for this turn.
 *
 *   requestStyle   the client's toneMode; may only pick a response style,
 *                  and only when the persona has not locked it (D-4)
 *
 * Returns { source, reason, persona, personaSource, version, configuration,
 * style, styleSource, personalization, rendered, provenance }. `rendered`
 * is what synthesizeFinalAnswer takes as `pcl`, or null for the default.
 */
export async function resolvePcl(supabase, identity, { requestStyle = null, log = null } = {}) {
  let loaded;
  if (!pclEnabled()) {
    loaded = defaultLoaded("PCL_ENABLED=0");
  } else {
    const key = `${identity?.userId || "anon"}:${identity?.namespaceId || "none"}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) loaded = hit.loaded;
    else {
      try { loaded = await load(supabase, identity, log); }
      catch (err) {
        log?.warn?.({ err: err?.message }, "pcl: resolution failed; using the built-in default");
        loaded = defaultLoaded(`resolution failed: ${err?.message || err}`);
      }
      cache.set(key, { at: Date.now(), loaded });
    }
  }

  const prefs = loaded.preferences;
  const configured = loaded.configuration?.response?.style || null;
  const locked = Boolean(loaded.configuration?.lock_style);
  let style = "neutral";
  let styleSource = "default";
  if (loaded.source === "resolved") {
    if (requestStyle && responseStyles.has(requestStyle) && !locked) { style = requestStyle; styleSource = "request"; }
    else if (prefs?.hasRow && prefs.style !== "neutral") { style = prefs.style; styleSource = "user"; }
    else if (configured) { style = configured; styleSource = "persona"; }
  }
  const personalization = loaded.source === "resolved" ? (prefs?.personalization || "") : "";

  const rendered = loaded.source === "resolved" && (loaded.rendered || personalization)
    ? { ...(loaded.rendered || {}), personalization: personalization || null }
    : null;

  const provenance = {
    persona_id: loaded.persona?.id || null,
    persona_key: loaded.persona?.key || null,
    persona_source: loaded.personaSource || "none",
    version: loaded.version ?? null,
    style,
    style_source: styleSource,
    personalization_chars: personalization.length,
    hash: loaded.hash || null,
    source: loaded.source,
    reason: loaded.reason || null,
  };

  return {
    source: loaded.source, reason: loaded.reason || null,
    persona: loaded.persona, personaSource: loaded.personaSource, version: loaded.version,
    configuration: loaded.configuration, style, styleSource, personalization, rendered, provenance,
  };
}
