export const MAX_PERSONALIZATION = 4000;
export const responseStyles = new Set([
  "neutral", "ceo", "king", "advisory", "recruiting",
  "cybersecurity", "datamanagement", "ventures",
]);

export function normalizePreferences(data) {
  return {
    response_style: responseStyles.has(data?.response_style) ? data.response_style : "neutral",
    personalization: typeof data?.personalization === "string"
      ? data.personalization.slice(0, MAX_PERSONALIZATION) : "",
  };
}

export function validPreferencesPatch(body, personalizationOnly = false) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every(key => {
    if (key === "personalization") return typeof body[key] === "string" && body[key].length <= MAX_PERSONALIZATION;
    return !personalizationOnly && key === "response_style" && responseStyles.has(body[key]);
  });
}

export async function readPreferences(fastify, userId) {
  const { data, error } = await fastify.supabase.from("user_settings")
    .select("response_style,personalization").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Unable to load preferences.");
  return normalizePreferences(data);
}

export async function writePreferences(fastify, userId, patch) {
  // Only supplied columns are updated on conflict; other settings are preserved.
  const { data, error } = await fastify.supabase.from("user_settings")
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id", defaultToNull: false })
    .select("response_style,personalization").single();
  if (error) throw new Error("Unable to save preferences.");
  return normalizePreferences(data);
}
