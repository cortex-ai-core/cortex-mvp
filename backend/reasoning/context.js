// ============================================================
//  CORTÉX — CONTEXT ASSEMBLER
//  v1.8.1 — ABSTRACTION-AWARE ENTITY CONTINUITY
// ============================================================
//
// Compatible with chat.js:
//
// assembleContext(intent, standardizedEvidence, message)
//
// MUST:
// - accept 3 positional args
// - return STRING
// - preserve generalized reasoning
// - avoid hardcoded domains
// - preserve source boundaries
// - support safe multi-document synthesis
// - preserve abstraction continuity
// - reinforce entity continuity probabilistically
// ============================================================

// ------------------------------------------------------------
// 🔥 Safe Source Resolver
// ------------------------------------------------------------
function resolveSourceLabel(e = {}) {
  return (
    e.source ||
    e.filename ||
    e.documentName ||
    e.documentId ||
    e.id ||
    "UNKNOWN_SOURCE"
  );
}

// ------------------------------------------------------------
// 🔥 Normalize Content
// ------------------------------------------------------------
function normalizeContent(text = "") {
  return String(text)
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------
// 🔥 Lightweight Entity Resolver
// ------------------------------------------------------------
//
// PURPOSE:
// Soft semantic anchoring ONLY.
//
// This is NOT deterministic identity logic.
// This is NOT recruiting-specific.
// This is NOT graph-based persistence.
//
// Goal:
// strengthen entity salience during abstraction.
//
// Priority:
// explicit entity fields first
// source-derived fallback second
// ------------------------------------------------------------
function resolvePrimaryEntity(e = {}) {

  const explicitEntity =
    e.primaryEntity ||
    e.entity ||
    e.owner ||
    e.subject ||
    e.name;

  if (
    explicitEntity &&
    typeof explicitEntity === "string"
  ) {
    return normalizeContent(explicitEntity);
  }

  const source = resolveSourceLabel(e);

  // ----------------------------------------------------------
  // Soft source-derived fallback
  // ----------------------------------------------------------
  //
  // Converts:
  // Brad_Shimo_Resume.pdf
  // -> Brad Shimo Resume
  //
  // Avoids:
  // hardcoded candidate logic
  // deterministic enforcement
  // ----------------------------------------------------------
  return normalizeContent(
    source
      .replace(/\.[^/.]+$/, "")
      .replace(/[_-]+/g, " ")
  );
}

// ------------------------------------------------------------
// 🔥 Group Evidence By Source
// ------------------------------------------------------------
function groupEvidenceBySource(evidence = []) {

  const grouped = new Map();

  for (const e of evidence) {

    const source =
      resolveSourceLabel(e);

    const entity =
      resolvePrimaryEntity(e);

    const content =
      normalizeContent(e.content || "");

    if (!content) continue;

    if (!grouped.has(source)) {

      grouped.set(source, {
        source,
        entity,
        entries: [],
        totalWeight: 0,
      });

    }

    const group =
      grouped.get(source);

    const weight =
      typeof e.weight === "number"
        ? e.weight
        : 0.5;

    group.entries.push({
      content,
      weight,
    });

    group.totalWeight += weight;
  }

  return grouped;
}

// ------------------------------------------------------------
// 🔥 Sort Evidence By Weight
// ------------------------------------------------------------
function sortEvidence(entries = []) {
  return [...entries].sort(
    (a, b) => b.weight - a.weight
  );
}

// ------------------------------------------------------------
// 🔥 Build Semantic Evidence Block
// ------------------------------------------------------------
//
// PURPOSE:
// Preserve:
// - source continuity
// - entity continuity
// - abstraction-safe lineage
// - semantic provenance
//
// WITHOUT:
// - rigid templates
// - ATS behavior
// - formatter logic
// - deterministic orchestration
// ------------------------------------------------------------
function buildEvidenceSection(
  sourceData = {}
) {

  const {
    source,
    entity,
    entries,
    totalWeight,
  } = sourceData;

  const sortedEntries =
    sortEvidence(entries);

  // ----------------------------------------------------------
  // Soft continuity reinforcement
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // We intentionally repeat the entity
  // lightly within the semantic block.
  //
  // This increases:
  // - semantic survival
  // - abstraction provenance
  // - identity continuity
  //
  // WITHOUT:
  // - hardcoding
  // - forcing output structure
  // - deterministic behavior
  // ----------------------------------------------------------

  return [
    `PRIMARY ENTITY: ${entity}`,
    `SOURCE: ${source}`,
    `SOURCE CONTINUITY WEIGHT: ${totalWeight.toFixed(2)}`,
    `ENTITY CONTEXT:`,

    ...sortedEntries.map(
      (e) =>
        `- (${entity}) ${e.content}`
    ),

  ].join("\n");
}

// ============================================================
// 🔥 MAIN CONTEXT ASSEMBLER
// ============================================================
export function assembleContext(
  intent = "general",
  evidence = [],
  userMessage = ""
) {

  // ----------------------------------------------------------
  // Safety
  // ----------------------------------------------------------
  if (!Array.isArray(evidence)) {
    evidence = [];
  }

  // ----------------------------------------------------------
  // Group evidence dynamically
  // ----------------------------------------------------------
  const groupedEvidence =
    groupEvidenceBySource(evidence);

  // ----------------------------------------------------------
  // Build structured context
  // ----------------------------------------------------------
  const evidenceSections = [];

  for (const sourceData of groupedEvidence.values()) {

    const section =
      buildEvidenceSection(sourceData);

    evidenceSections.push(section);
  }

  // ----------------------------------------------------------
  // Final assembled evidence text
  // ----------------------------------------------------------
  const evidenceText =
    evidenceSections.length > 0
      ? evidenceSections.join("\n\n")
      : "No evidence available.";

  // ==========================================================
  // Final Context Window
  // ==========================================================
  return `
INTENT:
${intent}

USER MESSAGE:
${userMessage}

EVIDENCE CONTEXT:
${evidenceText}
`.trim();
}
