// =============================================================
//  Memory settings: environment defaults, overridden per namespace
//  by a row in memory_settings (migration 0008). The one place every
//  memory switch is read. Cached for a minute per namespace.
//
//  Until 0008 is applied the table does not exist; the loader notices
//  once, logs it, and serves the environment defaults.
// =============================================================

const flag = (name, dflt) => {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return !["0", "false", "off", "no"].includes(String(v).trim().toLowerCase());
};
const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
};

export function envDefaults() {
  const allow = String(process.env.MEMORY_NAMESPACES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    memory_enabled:      flag("MEMORY_ENABLED", false),
    history_enabled:     flag("MEMORY_HISTORY_ENABLED", true),
    recall_enabled:      flag("MEMORY_RECALL_ENABLED", true),
    extract_enabled:     flag("MEMORY_EXTRACT_ENABLED", false),
    retention_days:      num("MEMORY_RETENTION_DAYS", 0),
    max_active_per_user: num("MEMORY_MAX_ACTIVE_PER_USER", 500),
    history_turns:       num("MEMORY_HISTORY_TURNS", 10),
    history_tokens:      num("MEMORY_HISTORY_TOKENS", 2000),
    summary_trigger_tokens: num("MEMORY_SUMMARY_TRIGGER_TOKENS", 3000),
    recall_k:            num("MEMORY_RECALL_K", 8),
    recall_min_sim:      num("MEMORY_RECALL_MIN_SIM", 0.35),
    block_tokens:        num("MEMORY_BLOCK_TOKENS", 600),
    near_dup_sim:        num("MEMORY_NEAR_DUP_SIM", 0.92),
    extract_model:       process.env.MEMORY_EXTRACT_MODEL || "gpt-5-mini",
    namespace_allowlist: allow,          // empty = every namespace
  };
}

const CACHE_MS = 60_000;
const cache = new Map();          // namespaceId -> { at, settings }
let tableMissing = false;         // set once 0008 has not been applied yet
let tableMissingLogged = false;

/**
 * Effective settings for one namespace: env defaults, then the row's
 * non-null fields on top, then the allowlist. Never throws.
 */
export async function effectiveSettings(supabase, namespaceId, log) {
  const hit = cache.get(namespaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.settings;

  const base = envDefaults();
  let row = null;
  if (supabase && namespaceId && !tableMissing) {
    const { data, error } = await supabase
      .from("memory_settings")
      .select("memory_enabled, history_enabled, recall_enabled, extract_enabled, retention_days, max_active_per_user")
      .eq("namespace_id", namespaceId)
      .maybeSingle();
    if (error) {
      if (/relation .*memory_settings.* does not exist|42P01|PGRST205/i.test(error.message || "") || error.code === "42P01" || error.code === "PGRST205") {
        tableMissing = true;
        if (!tableMissingLogged) { tableMissingLogged = true; log?.info?.("memory: memory_settings table not present yet (migration 0008); using environment defaults"); }
      } else {
        log?.warn?.({ err: error.message }, "memory: settings lookup failed; using environment defaults");
      }
    } else {
      row = data;
    }
  }

  const settings = { ...base };
  for (const k of ["memory_enabled", "history_enabled", "recall_enabled", "extract_enabled", "retention_days", "max_active_per_user"]) {
    if (row && row[k] !== null && row[k] !== undefined) settings[k] = row[k];
  }
  if (base.namespace_allowlist.length && !base.namespace_allowlist.includes(namespaceId)) {
    settings.memory_enabled = false;
  }
  settings.source = row ? "namespace row" : "environment";

  cache.set(namespaceId, { at: Date.now(), settings });
  return settings;
}

/** Forget cached settings (after an admin change). */
export function invalidateSettings(namespaceId) {
  if (namespaceId) cache.delete(namespaceId); else cache.clear();
  tableMissing = false;
}

/** One line for the boot log. */
export function describeDefaults() {
  const d = envDefaults();
  return {
    enabled: d.memory_enabled,
    history: d.history_enabled,
    recall: d.recall_enabled,
    extract: d.extract_enabled,
    history_turns: d.history_turns,
    history_tokens: d.history_tokens,
    recall_k: d.recall_k,
    block_tokens: d.block_tokens,
    namespaces: d.namespace_allowlist.length ? d.namespace_allowlist : "all",
  };
}
