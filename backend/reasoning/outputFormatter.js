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
// Only removes obvious duplicate adjacent lines.
// Does NOT reinterpret reasoning.
// ------------------------------------------------------------
function removeDuplicateLines(text = "") {
  const lines = text.split("\n");

  const cleaned = [];
  const seen = new Set();

  for (const line of lines) {
    const normalized =
      line.trim().toLowerCase();

    // preserve empty spacing
    if (!normalized) {
      cleaned.push(line);
      continue;
    }

    // skip obvious duplicates
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    cleaned.push(line);
  }

  return cleaned.join("\n");
}

// ------------------------------------------------------------
// 🔥 Minimal Operational Compression
//
// Used ONLY when synthesis returns large
// unstructured blobs.
//
// DOES NOT rebuild structure.
// ------------------------------------------------------------
function lightlyCompress(text = "") {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);

  // preserve concise outputs
  if (sentences.length <= 10) {
    return text;
  }

  return sentences
    .slice(0, 10)
    .join(" ")
    .trim();
}

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
  // Preserve already-structured outputs
  // ----------------------------------------------------------
  if (hasExistingStructure(text)) {
    return text;
  }

  // ----------------------------------------------------------
  // Light compression ONLY if needed
  // ----------------------------------------------------------
  text = lightlyCompress(text);

  // ----------------------------------------------------------
  // Preserve synthesis intelligence
  // ----------------------------------------------------------
  return text;
}
