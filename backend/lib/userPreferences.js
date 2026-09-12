// =============================================================
//  A user's own preferences on user_settings. How Cortéx sounds and
//  works comes from the persona (section 4.4); the user keeps two things
//  of their own: a personalization note, and an answer length that
//  overrides the persona's default when set. The old one-word
//  "response style" was retired in favour of personas (migration 0012).
// =============================================================

export const MAX_PERSONALIZATION = 4000;
export const responseLengths = new Set(["concise", "standard", "detailed"]);

export function normalizePreferences(data) {
  return {
    response_length: responseLengths.has(data?.response_length) ? data.response_length : null,
    personalization: typeof data?.personalization === "string"
      ? data.personalization.slice(0, MAX_PERSONALIZATION) : "",
    persona_id: typeof data?.persona_id === "string" ? data.persona_id : null,
  };
}

export function validPreferencesPatch(body, personalizationOnly = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every(key => {
    if (key === "personalization") return typeof body[key] === "string" && body[key].length <= MAX_PERSONALIZATION;
    return !personalizationOnly && key === "response_length" && (body[key] === null || responseLengths.has(body[key]));
  });
}

export async function readPreferences(fastify, userId) {
  const { data, error } = await fastify.supabase.from("user_settings")
    .select("response_length,personalization,persona_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Unable to load preferences.");
  return normalizePreferences(data);
}

export async function writePreferences(fastify, userId, patch) {
  // Only supplied columns are updated on conflict; other settings are preserved.
  const { data, error } = await fastify.supabase.from("user_settings")
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id", defaultToNull: false })
    .select("response_length,personalization,persona_id").single();
  if (error) throw new Error("Unable to save preferences.");
  return normalizePreferences(data);
}
