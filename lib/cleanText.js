// lib/cleanText.js
// ============================================================
//  CORTÉX — TEXT CLEANING + PII/CLINICIAN MASKING ENGINE (STEP 40A)
//  Prepares raw text for parsing, chunking, and embeddings.
//  HIPAA-adjacent lightweight masking for safer ingestion.
// ============================================================

export function cleanText(raw = "") {
  if (!raw || typeof raw !== "string") return "";

  let text = raw;

  // ------------------------------------------------------------
  // BASIC SANITIZATION
  // ------------------------------------------------------------

  // Remove null bytes, control characters
  text = text.replace(/[\u0000-\u0009\u000B-\u000C\u000E-\u001F]/g, " ");

  // Normalize unicode (quotes, symbols)
  text = text
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\uFFFD/g, " ");

  // Normalize PDF bullets and dashes
  text = text
    .replace(/•/g, "- ")
    .replace(/—/g, "-")
    .replace(/–/g, "-");

  // ------------------------------------------------------------
  // PII MASKING LAYER
  // ------------------------------------------------------------

  // Mask emails
  text = text.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[EMAIL REDACTED]"
  );

  // Mask phone numbers
  text = text.replace(
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    "[PHONE REDACTED]"
  );

  // Mask simple address patterns
  text = text.replace(
    /\b\d{1,5}\s+[A-Za-z0-9\s]+\s+(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln)\b/gi,
    "[ADDRESS REDACTED]"
  );

  // ------------------------------------------------------------
  // CLINICIAN MASKING
  // ------------------------------------------------------------

  // Mask "Dr. Lastname" → "Clinician"
  text = text.replace(/\bDr\.\s+[A-Za-z]+\b/g, "Clinician");

  // Mask variations like Doctor Smith
  text = text.replace(/\bDoctor\s+[A-Za-z]+\b/gi, "Clinician");

  // ------------------------------------------------------------
  // PATIENT NAME MASKING (light pattern-based)
  // ------------------------------------------------------------

  // Strip names following “Patient”, “Pt”, “Mr”, “Ms”, etc.
  text = text.replace(
    /\b(Patient|Pt|Mr|Ms|Mrs)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g,
    "[PATIENT]"
  );

  // ------------------------------------------------------------
  // DIAGNOSIS MASKING (optional anonymization)
  // ------------------------------------------------------------

  // Replace explicit age-diagnosis references
  text = text.replace(
    /\b(\d{1,3})-year-old\s+(male|female)\s+diagnosed\s+with\s+[A-Za-z0-9\s-]+\b/gi,
    "[PATIENT DIAGNOSIS REDACTED]"
  );

  // ------------------------------------------------------------
  // FINAL NORMALIZATION
  // ------------------------------------------------------------

  // Collapse multiple spaces
  text = text.replace(/\s+/g, " ").trim();

  // Normalize line breaks
  text = text.replace(/\r\n|\r/g, "\n");

  return text;
}

