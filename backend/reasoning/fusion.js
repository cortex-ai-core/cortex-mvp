// ============================================================
//  CORTÉX — EVIDENCE FUSION ENGINE
//  v1.8 PHASE 3 — CONCEPTUAL ECOSYSTEM CONTINUITY
// ============================================================
//
// GOAL:
// Preserve generalized reasoning while improving:
// - evidence prioritization
// - confidence preservation
// - signal hierarchy
// - contamination resistance
// - relationship continuity preservation
// - conceptual ecosystem continuity
// - abstraction reinforcement
// - strategic thematic propagation
//
// DO NOT:
// - hardcode domains
// - introduce recruiting logic
// - redesign orchestration
// - change output contract
// - introduce symbolic graph reasoning
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
// 🔥 Utility — Tokenize Conceptual Terms
//
// Lightweight probabilistic abstraction extraction.
// Avoids symbolic reasoning or hardcoded ontologies.
// ------------------------------------------------------------
function extractConceptualTerms(content = "") {

  const normalized = normalize(content);

  const tokens = normalized
    .split(" ")
    .filter((token) => {
      return (
        token.length >= 5 &&
        !/^\d+$/.test(token)
      );
    });

  return [...new Set(tokens)];
}

// ------------------------------------------------------------
// 🔥 Utility — Shared Concept Ratio
// ------------------------------------------------------------
function calculateSharedConceptRatio(a = [], b = []) {

  if (!a.length || !b.length) return 0;

  const setB = new Set(b);

  let shared = 0;

  for (const token of a) {
    if (setB.has(token)) shared++;
  }

  return shared / Math.max(a.length, b.length);
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

// ------------------------------------------------------------
// 🔥 SIGNAL: Conceptual Ecosystem Continuity
//
// Reinforces recurring abstraction ecosystems
// across evidence neighborhoods without
// deterministic graph behavior.
// ------------------------------------------------------------
function calculateConceptualContinuityScore(
  currentEvidence = {},
  allEvidence = []
) {

  const currentContent =
    currentEvidence.content || "";

  const currentConcepts =
    extractConceptualTerms(currentContent);

  if (!currentConcepts.length) {
    return 0;
  }

  let continuityStrength = 0;
  let continuityMatches = 0;

  for (const candidate of allEvidence) {

    if (candidate === currentEvidence) continue;

    const candidateContent =
      candidate.content || "";

    const candidateConcepts =
      extractConceptualTerms(candidateContent);

    if (!candidateConcepts.length) continue;

    const sharedRatio =
      calculateSharedConceptRatio(
        currentConcepts,
        candidateConcepts
      );

    // --------------------------------------------------------
    // Reinforce meaningful conceptual neighborhoods
    // while preserving generalized probabilistic behavior.
    // --------------------------------------------------------

    if (sharedRatio >= 0.12) {

      continuityMatches++;

      continuityStrength +=
        sharedRatio * 0.08;
    }
  }

  // ----------------------------------------------------------
  // Reinforce stable thematic ecosystems
  // without over-locking conceptual topology.
  // ----------------------------------------------------------

  continuityStrength +=
    Math.min(continuityMatches * 0.01, 0.04);

  return clamp(continuityStrength, 0, 0.12);
}

// ============================================================
// 🔥 MAIN FUSION ENGINE
// ============================================================

export function fuseEvidence(
  evidence = [],
  intent = "general"
) {

  if (!Array.isArray(evidence)) return [];

  const seenContent = new Set();

  // ----------------------------------------------------------
  // 🔥 PASS 1 — Base Fusion Scoring
  // ----------------------------------------------------------

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
    // 🔥 Preliminary Weight
    // --------------------------------------------------------

    const preliminaryWeight =
      baseWeight +
      specificityScore +
      densityScore +
      directnessScore +
      relationshipScore -
      redundancyPenalty;

    return {
      ...e,
      content,
      source: e.source || "unknown",
      preliminaryWeight: clamp(
        preliminaryWeight,
        MIN_WEIGHT,
        MAX_WEIGHT
      ),
      intent,
    };
  });

  // ----------------------------------------------------------
  // 🔥 PASS 2 — Conceptual Ecosystem Reinforcement
  // ----------------------------------------------------------

  const ecosystemReinforced = fused.map((e) => {

    const conceptualContinuityScore =
      calculateConceptualContinuityScore(
        e,
        fused
      );

    const finalWeight =
      e.preliminaryWeight +
      conceptualContinuityScore;

    return {
      content: e.content,
      source: e.source,
      weight: clamp(
        finalWeight,
        MIN_WEIGHT,
        MAX_WEIGHT
      ),
      intent: e.intent,
    };
  });

  // ----------------------------------------------------------
  // 🔥 Prioritize strongest conceptual ecosystems first
  // ----------------------------------------------------------

  ecosystemReinforced.sort(
    (a, b) => b.weight - a.weight
  );

  return ecosystemReinforced;
}
