// ----------------------------------------------------
// 🔐 INPUT DLP (SAFE — DO NOT CORRUPT CONTEXT)
// ----------------------------------------------------
export function runDLPScan(text = "") {
  let sanitized = text;

  const ssnRegex = /\b\d{3}-\d{2}-\d{4}\b/i;
  const ssnContextRegex = /(ssn|social security)/i;

  const emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const phoneRegex = /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

  // 🚨 BLOCK ONLY (HIGH RISK)
  if (ssnRegex.test(text) && ssnContextRegex.test(text)) {
    return {
      sanitized: text,
      block: true,
      reason: "SSN detected"
    };
  }

  // ✂️ LIGHT REDACTION (SAFE)
  sanitized = sanitized
    .replace(emailRegex, "[REDACTED_EMAIL]")
    .replace(phoneRegex, "[REDACTED_PHONE]");

  return {
    sanitized,
    block: false,
    reason: "redacted"
  };
}

// ----------------------------------------------------
// 🔐 OUTPUT DLP (STABLE — NO OVERMATCH)
// ----------------------------------------------------
export function stripSensitiveFields(text) {
  if (!text || typeof text !== "string") return text;

  let output = text;

  // -------------------------------
  // EMAIL
  // -------------------------------
  output = output.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]"
  );

  // -------------------------------
  // PHONE
  // -------------------------------
  const phonePatterns = [
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g
  ];

  phonePatterns.forEach((pattern) => {
    output = output.replace(pattern, "[REDACTED_PHONE]");
  });

  // -------------------------------
  // ADDRESS (PRIMARY REDACTION)
  // -------------------------------
  const addressPatterns = [
    /\b\d{1,5}\s+\d{1,3}(?:st|nd|rd|th)\s+[A-Za-z]+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Wy|Place|Pl)\b/gi,

    /\b\d{1,5}\s+[A-Za-z0-9.\s]+?\s(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Wy|Place|Pl)\b/gi
  ];

  addressPatterns.forEach((pattern) => {
    output = output.replace(pattern, "[REDACTED_ADDRESS]");
  });

  // -------------------------------
  // 🔥 FINAL FIX (MULTI-LINE SAFE)
  // -------------------------------
  // Removes ANY trailing fragments (including next lines) after a redacted address
  output = output.replace(
    /\[REDACTED_ADDRESS\](?:\s*\n?\s*[^\n]*)*/gi,
    "[REDACTED_ADDRESS]"
  );

  // -------------------------------
  // SSN BLOCK
  // -------------------------------
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(output)) {
    return "[BLOCKED: SENSITIVE CONTENT]";
  }

  return output;
}
