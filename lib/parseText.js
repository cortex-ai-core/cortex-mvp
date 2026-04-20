// lib/parseText.js
// ============================================================
//  CORTÉX — TEXT PARSER (STEP 40B)
//  Extracts text from uploaded file buffers
//  NEW: Sanitization layer (PII + clinician masking)
// ============================================================

import { maskPII } from "../utils/sanitizers.js";

// ------------------------------------------------------------
//  TXT PARSER
// ------------------------------------------------------------
function parseTXT(buffer) {
  return buffer.toString("utf-8");
}

// ------------------------------------------------------------
//  MARKDOWN PARSER
// ------------------------------------------------------------
function parseMD(buffer) {
  return buffer.toString("utf-8");
}

// ------------------------------------------------------------
//  PDF PARSER (placeholder — can be upgraded later)
// ------------------------------------------------------------
function parsePDF(buffer) {
  return "PDF parsing not implemented yet.";
}

// ------------------------------------------------------------
//  DOCX PARSER (placeholder)
// ------------------------------------------------------------
function parseDOCX(buffer) {
  return "DOCX parsing not implemented yet.";
}

// ============================================================
//  MAIN ROUTER — APPLY SANITIZATION
// ============================================================
export function parseText(buffer, mimeType) {
  if (!buffer) return "";

  let raw = "";

  // -------------------------------
  // MIME Routing
  // -------------------------------
  if (mimeType === "text/plain") {
    raw = parseTXT(buffer);
  } else if (
    mimeType === "text/markdown" ||
    mimeType === "text/x-markdown"
  ) {
    raw = parseMD(buffer);
  } else if (mimeType === "application/pdf") {
    raw = parsePDF(buffer);
  } else if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    raw = parseDOCX(buffer);
  } else {
    raw = buffer.toString("utf-8");
  }

  // ============================================================
  //  🔥 APPLY SANITIZATION TO OUTPUT
  //  - masks phone numbers
  //  - masks emails
  //  - masks clinician/patient identifiers
  //  - scrubs HIPAA-sensitive patterns
  // ============================================================
  const cleaned = maskPII(raw);

  return cleaned.trim();
}

