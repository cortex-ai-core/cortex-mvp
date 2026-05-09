// ============================================================
//  CORTÉX — CONTEXT ASSEMBLER
//  v1.7.5 — SOURCE-AWARE CONTEXT STABILIZATION
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
  return text
    .replace(/\s+/g, " ")
    .trim();
}

// ------------------------------------------------------------
// 🔥 Group Evidence By Source
// ------------------------------------------------------------
function groupEvidenceBySource(evidence = []) {
  const grouped = new Map();

  for (const e of evidence) {
    const source = resolveSourceLabel(e);
    const content = normalizeContent(e.content || "");

    if (!content) continue;

    if (!grouped.has(source)) {
      grouped.set(source, []);
    }

    grouped.get(source).push({
      content,
      weight:
        typeof e.weight === "number"
          ? e.weight
          : 0.5,
    });
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
  // Group evidence dynamically by source
  // ----------------------------------------------------------
  const groupedEvidence =
    groupEvidenceBySource(evidence);

  // ----------------------------------------------------------
  // Build structured context
  // ----------------------------------------------------------
  let evidenceSections = [];

  for (const [source, entries] of groupedEvidence.entries()) {

    const sortedEntries =
      sortEvidence(entries);

    const section = [
      `SOURCE: ${source}`,
      ...sortedEntries.map(
        (e) => `- ${e.content}`
      ),
    ].join("\n");

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
