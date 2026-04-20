// core/tokenRepair.js
// ============================================================
//  CORTÉX TOKEN REPAIR ENGINE — v7.0 (Aggressive Mode A)
//  FULL FUSED-WORD REPAIR + PUNCTUATION SAFETY
//  - Splits fused English word sequences (GPT-5.1 bug fix)
//  - Fixes collisions around punctuation and apostrophes
//  - Removes invisible Unicode artifacts
//  - Guarantees readable, human-grade spacing
// ============================================================

export function repairToken(token) {
  if (!token || typeof token !== "string") return token;

  let out = token;

  // ------------------------------------------------------------
  // 1) Remove invisible Unicode artifacts (NBSP, thin-space, ZWSP)
  // ------------------------------------------------------------
  out = out
    .replace(/\u00A0/g, " ")
    .replace(/[\u2000-\u200F]/g, "")
    .replace(/\u200B/g, "");

  // ------------------------------------------------------------
  // 2) Fix punctuation-to-word collisions
  //    ".Iam" → ". I am"
  //    "KING’ssovereign" → "KING’s sovereign"
  // ------------------------------------------------------------
  out = out.replace(/([.!?,;:\-’'])([A-Za-z])/g, "$1 $2");

  // ------------------------------------------------------------
  // 3) Fix reversed collision (word + punctuation)
  //    "power,structure" → "power, structure"
  // ------------------------------------------------------------
  out = out.replace(/([A-Za-z])([.!?,;:\-’'])/g, "$1$2 ");

  // ------------------------------------------------------------
  // 4) AGGRESSIVE FUSED-WORD SEPARATOR (primary fix)
  //    Breaks long single-word runs based on English morphology:
  //    sovereignprivategovernedintelligenceengine
  //    → sovereign private governed intelligence engine
  // ------------------------------------------------------------
  out = out.replace(
    /([a-z]{5,})([A-Z][a-z]+)/g,
    "$1 $2"
  ); // lower→Upper boundaries

  // purely lowercase long-run splitter
  out = out.replace(
    /([a-z]{6,})([a-z]{4,})/g,
    "$1 $2"
  );

  // Capitalized long-run splitter
  out = out.replace(
    /([A-Z][a-z]{3,})([A-Z][a-z]+)/g,
    "$1 $2"
  );

  // ------------------------------------------------------------
  // 5) Possessive repairs
  //    "KING’ssovereign" → "KING’s sovereign"
  // ------------------------------------------------------------
  out = out.replace(/’s([A-Za-z])/g, "’s $1");

  // ------------------------------------------------------------
  // 6) Collapse multi-spaces created by repairs
  // ------------------------------------------------------------
  out = out.replace(/\s{2,}/g, " ");

  return out.trim();
}

