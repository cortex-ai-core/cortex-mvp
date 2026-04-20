// core/transportError.js
// STEP 34G — Cortéx Transport Error Normalizer (Option B)

export function formatTransportError(err) {
  try {
    const message =
      typeof err === "string"
        ? err
        : err?.message || "Unknown error";

    return `
[CORTEX ERROR]
type: CHAT_STREAM_ERROR
message: ${message.trim()}
`;
  } catch (_) {
    return `
[CORTEX ERROR]
type: CHAT_STREAM_ERROR
message: Unhandled exception occurred.
`;
  }
}

