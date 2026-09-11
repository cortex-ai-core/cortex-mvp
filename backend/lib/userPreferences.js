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
    persona_id: typeof data?.persona_id === "string" ? data.persona_id : null,
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
    .select("response_style,personalization,persona_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("Unable to load preferences.");
  return normalizePreferences(data);
}

export async function writePreferences(fastify, userId, patch) {
  // Only supplied columns are updated on conflict; other settings are preserved.
  const { data, error } = await fastify.supabase.from("user_settings")
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "user_id", defaultToNull: false })
    .select("response_style,personalization,persona_id").single();
  if (error) throw new Error("Unable to save preferences.");
  return normalizePreferences(data);
}

// How a response_style reads in the prompt's identity block (PCL Phase 0).
// Keys are the stored values; the labels are the words the model sees.
const styleLabels = {
  neutral: "neutral",
  ceo: "CEO",
  king: "King",
  advisory: "advisory",
  recruiting: "recruiting",
  cybersecurity: "cybersecurity",
  datamanagement: "data management",
  ventures: "ventures",
};

export function styleLabel(style) {
  return styleLabels[style] || "neutral";
}
