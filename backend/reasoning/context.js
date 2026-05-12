// ============================================================
//  CORTÉX — CONTEXT ASSEMBLER
//  v1.8.2 — LINEAGE CONTINUITY STABILIZATION
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
//
// IMPORTANT:
//
// We intentionally avoid aggressive flattening.
//
// Prior implementation removed too much
// semantic texture and locality structure.
//
// We now preserve:
// - paragraph cadence
// - semantic density
// - abstraction gradients
//
// WITHOUT:
// - preserving unsafe formatting noise
// ------------------------------------------------------------
function normalizeContent(text = "") {

  return String(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
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
// 🔥 Soft Semantic Tiering
// ------------------------------------------------------------
//
// PURPOSE:
//
// Preserve abstraction hierarchy
// WITHOUT deterministic orchestration.
//
// This is NOT hard grouping.
// This is NOT ATS balancing.
//
// Goal:
// preserve semantic density gradients.
//
// Higher-weight evidence receives:
// - stronger locality preservation
// - earlier survivability
// - richer semantic continuity
// ------------------------------------------------------------
function buildSemanticTiers(entries = []) {

  if (entries.length <= 2) {
    return {
      core: entries,
      supporting: [],
      peripheral: [],
    };
  }

  const sorted =
    sortEvidence(entries);

  const coreCutoff =
    Math.max(1, Math.ceil(sorted.length * 0.25));

  const supportingCutoff =
    Math.max(
      coreCutoff + 1,
      Math.ceil(sorted.length * 0.7)
    );

  return {
    core:
      sorted.slice(0, coreCutoff),

    supporting:
      sorted.slice(
        coreCutoff,
        supportingCutoff
      ),

    peripheral:
      sorted.slice(supportingCutoff),
  };
}

// ------------------------------------------------------------
// 🔥 Render Semantic Cluster
// ------------------------------------------------------------
function renderCluster(
  title,
  entries,
  entity
) {

  if (!entries.length) {
    return [];
  }

  return [
    `${title}:`,

    ...entries.map(
      (e) =>
        `- (${entity}) ${e.content}`
    ),
  ];
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
// - locality gradients
// - abstraction hierarchy
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

  const tiers =
    buildSemanticTiers(entries);

  return [

    `PRIMARY ENTITY: ${entity}`,

    `SOURCE: ${source}`,

    `SOURCE CONTINUITY WEIGHT: ${totalWeight.toFixed(2)}`,

    `ENTITY CONTEXT:`,

    ...renderCluster(
      "CORE SIGNALS",
      tiers.core,
      entity
    ),

    ...renderCluster(
      "SUPPORTING CONTEXT",
      tiers.supporting,
      entity
    ),

    ...renderCluster(
      "PERIPHERAL CONTEXT",
      tiers.peripheral,
      entity
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
  // Preserve probabilistic ordering
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // We intentionally sort by aggregate
  // survivability strength WITHOUT
  // deterministic partitioning.
  // ----------------------------------------------------------
  const orderedGroups =
    [...groupedEvidence.values()]
      .sort(
        (a, b) =>
          b.totalWeight - a.totalWeight
      );

  // ----------------------------------------------------------
  // Build structured context
  // ----------------------------------------------------------
  const evidenceSections = [];

  for (const sourceData of orderedGroups) {

    const section =
      buildEvidenceSection(sourceData);

    evidenceSections.push(section);
  }

  // ----------------------------------------------------------
  // Final assembled evidence text
  // ----------------------------------------------------------
  //
  // IMPORTANT:
  // We preserve stronger locality separation
  // between ecosystems to reduce semantic
  // flattening during synthesis.
  // ----------------------------------------------------------
  const evidenceText =
    evidenceSections.length > 0
      ? evidenceSections.join("\n\n---\n\n")
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
