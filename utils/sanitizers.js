// utils/sanitizers.js
// ============================================================
//  CORTÉX — TEXT SANITIZATION LAYER
//  Applies PII masking + OCR cleanup + whitespace normalization
// ============================================================

// ------------------------------------------------------------
// Basic PII masking (placeholder)
// ------------------------------------------------------------
export function maskPII(text = "") {
  if (!text) return "";

  return text
    // emails
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    // phone numbers
    .replace(/\b(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[REDACTED_PHONE]")
    // names (simple example)
    .replace(/\b(Dr\.?\s+[A-Z][a-z]+|Mr\.?\s+[A-Z][a-z]+|Ms\.?\s+[A-Z][a-z]+)\b/g, "[REDACTED_NAME]");
}

// ------------------------------------------------------------
// OCR cleanup helpers
// ------------------------------------------------------------
function normalizeWhitespace(text = "") {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function removeWeirdOCR(text = "") {
  return text.replace(/[^\x00-\x7F]+/g, " "); // remove non-ASCII noise
}

// ------------------------------------------------------------
// MASTER SANITIZER (used by ingestion + memory pipeline)
// ------------------------------------------------------------
export function sanitizeText(text = "") {
  if (!text) return "";

  let cleaned = text;

  cleaned = maskPII(cleaned);
  cleaned = removeWeirdOCR(cleaned);
  cleaned = normalizeWhitespace(cleaned);

  return cleaned;
}

