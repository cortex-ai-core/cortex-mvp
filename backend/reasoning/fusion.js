// ============================================================
//  CORTÉX — EVIDENCE FUSION ENGINE
//  v1.7.5 — SIGNAL PRIORITIZATION STABILIZATION
// ============================================================
//
// GOAL:
// Preserve generalized reasoning while improving:
// - evidence prioritization
// - confidence preservation
// - signal hierarchy
// - contamination resistance
//
// DO NOT:
// - hardcode domains
// - introduce recruiting logic
// - redesign orchestration
// - change output contract
//
// Output MUST remain a flat fused evidence array.
// ============================================================

const MAX_WEIGHT = 1.0;
const MIN_WEIGHT = 0.05;

// ------------------------------------------------------------
// 🔥 Utility — Safe Clamp
// ------------------------------------------------------------
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ------------------------------------------------------------
// 🔥 Utility — Normalize Text
// ------------------------------------------------------------
function normalize(text = "") {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Specificity
//
// Rewards:
// - metrics
// - years
// - implementations
// - tooling
// - certifications
// - concrete operational language
// ------------------------------------------------------------
function calculateSpecificityScore(content = "") {
  let score = 0;

  const text = content.toLowerCase();

  // numbers / metrics
  if (/\b\d+\b/.test(text)) score += 0.10;

  // years experience
  if (/\b\d+\+?\s*(year|yr)s?\b/.test(text)) score += 0.15;

  // implementation / ownership verbs
  if (
    /\b(implemented|led|designed|managed|deployed|architected|owned|administered|built)\b/.test(
      text
    )
  ) {
    score += 0.20;
  }

  // certifications / credentials
  if (
    /\b(certified|certification|cissp|security\+|aws|azure|epic|ccna|pmp)\b/.test(
      text
    )
  ) {
    score += 0.10;
  }

  // denser content usually carries stronger informational value
  if (content.length > 250) score += 0.10;

  return clamp(score, 0, 0.40);
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Density
//
// Rewards evidence containing multiple meaningful indicators
// rather than isolated vague statements.
// ------------------------------------------------------------
function calculateDensityScore(content = "") {
  const text = content.toLowerCase();

  const indicators = [
    "implemented",
    "managed",
    "supported",
    "led",
    "designed",
    "trained",
    "deployed",
    "analyzed",
    "clinical",
    "security",
    "infrastructure",
    "operations",
    "integration",
    "compliance",
    "workflow",
  ];

  let matches = 0;

  indicators.forEach((term) => {
    if (text.includes(term)) matches++;
  });

  return clamp(matches * 0.02, 0, 0.20);
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Directness
//
// Rewards chunks with stronger lexical alignment
// to the actual user message / intent.
//
// Generalized — NOT domain specific.
// ------------------------------------------------------------
function calculateDirectnessScore(content = "", intent = "") {
  const text = content.toLowerCase();

  let score = 0;

  if (intent && text.includes(intent.toLowerCase())) {
    score += 0.10;
  }

  // shorter, focused statements are often more direct
  if (content.length > 0 && content.length < 400) {
    score += 0.05;
  }

  return clamp(score, 0, 0.15);
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Redundancy Dampening
//
// Prevent repeated weak chunks from overpowering
// strong isolated evidence.
// ------------------------------------------------------------
function applyRedundancyPenalty(content = "", seen = new Set()) {
  const normalized = normalize(content);

  if (seen.has(normalized)) {
    return 0.15;
  }

  seen.add(normalized);

  return 0;
}

// ============================================================
// 🔥 MAIN FUSION ENGINE
// ============================================================
export function fuseEvidence(evidence = [], intent = "general") {
  if (!Array.isArray(evidence)) return [];

  const seenContent = new Set();

  const fused = evidence.map((e) => {
    const content = e.content || "";

    // Preserve upstream retrieval confidence if present
    const baseWeight =
      typeof e.weight === "number"
        ? e.weight
        : typeof e.similarity === "number"
        ? e.similarity
        : 0.5;

    const specificityScore =
      calculateSpecificityScore(content);

    const densityScore =
      calculateDensityScore(content);

    const directnessScore =
      calculateDirectnessScore(content, intent);

    const redundancyPenalty =
      applyRedundancyPenalty(content, seenContent);

    // --------------------------------------------------------
    // 🔥 Final Weighted Score
    // --------------------------------------------------------
    const finalWeight =
      baseWeight +
      specificityScore +
      densityScore +
      directnessScore -
      redundancyPenalty;

    return {
      content,
      source: e.source || "unknown",
      weight: clamp(finalWeight, MIN_WEIGHT, MAX_WEIGHT),
      intent,
    };
  });

  // ----------------------------------------------------------
  // 🔥 Prioritize strongest evidence first
  // ----------------------------------------------------------
  fused.sort((a, b) => b.weight - a.weight);

  return fused;
}
