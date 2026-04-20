// backend/middleware/intentClassifier.js
// ============================================================
//  CORTÉX — INTENT CLASSIFIER (STEP 40A)
// ============================================================

export function classifyIntent(msg) {
  const m = msg.toLowerCase();

  if (
    m.includes("analyze") ||
    m.includes("optimize") ||
    m.includes("assessment") ||
    m.includes("alignment")
  ) {
    return "strategic";
  }

  if (
    m.includes("build") ||
    m.includes("code") ||
    m.includes("fix") ||
    m.includes("debug")
  ) {
    return "engineering";
  }

  if (
    m.includes("grade") ||
    m.includes("evaluate") ||
    m.includes("score")
  ) {
    return "evaluation";
  }

  return "general";
}

