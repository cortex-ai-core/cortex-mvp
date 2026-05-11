// ============================================================
//  CORTÉX — EVIDENCE FUSION ENGINE
//  v1.8 PHASE 2B — RELATIONSHIP PRESERVATION STABILIZATION
// ============================================================
//
// GOAL:
// Preserve generalized reasoning while improving:
// - evidence prioritization
// - confidence preservation
// - signal hierarchy
// - contamination resistance
// - relationship continuity preservation
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
// ------------------------------------------------------------
function calculateSpecificityScore(content = "") {

  let score = 0;

  const text = content.toLowerCase();

  if (/\b\d+\b/.test(text)) score += 0.10;

  if (/\b\d+\+?\s*(year|yr)s?\b/.test(text)) {
    score += 0.15;
  }

  if (
    /\b(implemented|led|designed|managed|deployed|architected|owned|administered|built)\b/.test(
      text
    )
  ) {
    score += 0.20;
  }

  if (
    /\b(certified|certification|cissp|security\+|aws|azure|epic|ccna|pmp)\b/.test(
      text
    )
  ) {
    score += 0.10;
  }

  if (content.length > 250) score += 0.10;

  return clamp(score, 0, 0.40);
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Density
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
// ------------------------------------------------------------
function calculateDirectnessScore(content = "", intent = "") {

  const text = content.toLowerCase();

  let score = 0;

  if (intent && text.includes(intent.toLowerCase())) {
    score += 0.10;
  }

  if (content.length > 0 && content.length < 400) {
    score += 0.05;
  }

  return clamp(score, 0, 0.15);
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Redundancy Dampening
// ------------------------------------------------------------
function applyRedundancyPenalty(content = "", seen = new Set()) {

  const normalized = normalize(content);

  if (seen.has(normalized)) {
    return 0.15;
  }

  seen.add(normalized);

  return 0;
}

// ------------------------------------------------------------
// 🔥 SIGNAL: Relationship Preservation
//
// Preserves upstream retrieval topology intelligence
// without introducing orchestration coupling.
// ------------------------------------------------------------
function calculateRelationshipScore(evidence = {}) {

  const neighborhoodStrength =
    typeof evidence.neighborhoodStrength === "number"
      ? evidence.neighborhoodStrength
      : 0;

  const relationshipBoost =
    typeof evidence.relationshipBoost === "number"
      ? evidence.relationshipBoost
      : 0;

  const continuityBoost =
    typeof evidence.continuityBoost === "number"
      ? evidence.continuityBoost
      : 0;

  const relationshipCount =
    typeof evidence.relationshipCount === "number"
      ? evidence.relationshipCount
      : 0;

  const topologyScore =
    (neighborhoodStrength * 0.04) +
    (relationshipBoost * 0.60) +
    continuityBoost +
    Math.min(relationshipCount * 0.01, 0.04);

  return clamp(topologyScore, 0, 0.15);
}

// ============================================================
// 🔥 MAIN FUSION ENGINE
// ============================================================

export function fuseEvidence(evidence = [], intent = "general") {

  if (!Array.isArray(evidence)) return [];

  const seenContent = new Set();

  const fused = evidence.map((e) => {

    const content = e.content || "";

    // --------------------------------------------------------
    // 🔥 Preserve upstream retrieval weighting
    // --------------------------------------------------------

    const baseWeight =
      typeof e.finalScore === "number"
        ? e.finalScore
        : typeof e.weight === "number"
        ? e.weight
        : typeof e.similarity === "number"
        ? e.similarity
        : 0.5;

    // --------------------------------------------------------
    // 🔥 Fusion Signals
    // --------------------------------------------------------

    const specificityScore =
      calculateSpecificityScore(content);

    const densityScore =
      calculateDensityScore(content);

    const directnessScore =
      calculateDirectnessScore(content, intent);

    const relationshipScore =
      calculateRelationshipScore(e);

    const redundancyPenalty =
      applyRedundancyPenalty(content, seenContent);

    // --------------------------------------------------------
    // 🔥 Final Weighted Score
    // --------------------------------------------------------

    const finalWeight =
      baseWeight +
      specificityScore +
      densityScore +
      directnessScore +
      relationshipScore -
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
