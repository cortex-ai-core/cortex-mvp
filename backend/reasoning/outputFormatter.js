// ============================================================
//  CORTÉX — OUTPUT FORMATTER
//  v1.7.7 — THIN FORMATTER STABILIZATION
// ============================================================
//
// PURPOSE:
// Lightweight post-synthesis cleanup layer.
//
// FORMATTER SHOULD:
// - preserve synthesis intelligence
// - lightly normalize formatting
// - avoid structural corruption
// - avoid domain assumptions
//
// FORMATTER SHOULD NOT:
// - invent sections
// - infer candidate names
// - rewrite reasoning
// - force templates
// - reconstruct outputs
// ============================================================

const SECTION_HEADERS = [
  "Summary",
  "Recommendation",
  "Key Strengths",
  "Watch Areas",
  "Risks",
  "Next Steps",
  "Executive Summary",
  "Operational Analysis",
  "Root Cause",
  "Impact",
  "Remediation"
];

// ------------------------------------------------------------
// 🔥 Normalize Text
// ------------------------------------------------------------
function normalizeText(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ------------------------------------------------------------
// 🔥 Missing Data Detection
// ------------------------------------------------------------
function isMissingDataResponse(text = "") {
  const normalized = text.toLowerCase();

  return (
    normalized.includes("no matching documents found") ||
    normalized.includes("i need more information") ||
    normalized.includes("not enough information") ||
    normalized.includes("insufficient information")
  );
}

// ------------------------------------------------------------
// 🔥 Rewrite Detection
// ------------------------------------------------------------
function isRewriteRequest(userMessage = "") {
  const normalized = userMessage.toLowerCase();

  return (
    normalized.includes("rewrite") ||
    normalized.includes("restructure") ||
    normalized.includes("revise") ||
    normalized.includes("redraft") ||
    normalized.includes("edit this")
  );
}

// ------------------------------------------------------------
// 🔥 Preserve Existing Structure
// ------------------------------------------------------------
function hasExistingStructure(text = "") {
  const normalized = text.toLowerCase();

  return SECTION_HEADERS.some(header =>
    normalized.includes(header.toLowerCase())
  );
}

// ------------------------------------------------------------
// 🔥 Clean Structural Noise
// ------------------------------------------------------------
function cleanStructuralNoise(text = "") {
  return normalizeText(text)

    // remove markdown corruption
    .replace(/:\./g, ":")
    .replace(/-\s*\/\s*/g, "- ")
    .replace(/\n\d+\.\s*\n/g, "\n")

    // remove duplicated blank bullets
    .replace(/^-+\s*$/gm, "")

    // remove repetitive spacing
    .replace(/\n{3,}/g, "\n\n")

    .trim();
}

// ------------------------------------------------------------
// 🔥 Light Compression
//
// Only removes obvious duplicate ADJACENT lines (a model stutter).
// A line that legitimately repeats later in the answer, such as
// "Any approved course (3)" under two different requirements,
// is kept. Does NOT reinterpret reasoning.
// ------------------------------------------------------------
function removeDuplicateLines(text = "") {
  const lines = text.split("\n");

  const cleaned = [];
  let previous = null;

  for (const line of lines) {
    const normalized =
      line.trim().toLowerCase();

    // preserve empty spacing
    if (!normalized) {
      cleaned.push(line);
      previous = null;
      continue;
    }

    if (normalized === previous) {
      continue;
    }

    previous = normalized;
    cleaned.push(line);
  }

  return cleaned.join("\n");
}

// ------------------------------------------------------------
// (removed) lightlyCompress
//
// Previously cut any answer lacking a recognised section header
// to its first ten "sentences". Numbered lists split at every
// "9." so long, well-structured answers were truncated mid-list.
// The model's length is governed by the prompt, not by this file.
// ------------------------------------------------------------

// ============================================================
// 🔥 MAIN FORMATTER
// ============================================================
export function formatOutput(
  rawAnswer = "",
  options = {}
) {

  const {
    userMessage = ""
  } = options || {};

  // ----------------------------------------------------------
  // Normalize
  // ----------------------------------------------------------
  let text = normalizeText(rawAnswer);

  // ----------------------------------------------------------
  // Empty Guard
  // ----------------------------------------------------------
  if (!text) {
    return "I need more information.";
  }

  // ----------------------------------------------------------
  // Preserve missing-data responses
  // ----------------------------------------------------------
  if (isMissingDataResponse(text)) {
    return text;
  }

  // ----------------------------------------------------------
  // Preserve rewrites EXACTLY
  // ----------------------------------------------------------
  if (isRewriteRequest(userMessage)) {
    return text;
  }

  // ----------------------------------------------------------
  // Clean structural corruption
  // ----------------------------------------------------------
  text = cleanStructuralNoise(text);

  // ----------------------------------------------------------
  // Remove duplicate adjacent lines
  // ----------------------------------------------------------
  text = removeDuplicateLines(text);

  // ----------------------------------------------------------
  // Preserve synthesis intelligence: no length-based trimming.
  // ----------------------------------------------------------
  return text;
}
