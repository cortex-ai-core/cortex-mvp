// core/normalize.js
// CORTÉX NORMALIZATION ENGINE — SAFE MODE v5.1
// Only removes invisible characters + dangerous artifacts.
// DOES NOT touch word boundaries. DOES NOT collapse spacing.
// All token repair is delegated to tokenRepair.js.

export function normalizeCortexOutput(text) {
  if (!text || typeof text !== "string") return "";

  let out = text;

  // ------------------------------------------------------------
  // 1) Remove invisible / zero-width / NBSP characters
  // ------------------------------------------------------------
  out = out
    .replace(/\u00A0/g, " ")      // nbsp
    .replace(/\u2007/g, " ")      // figure space
    .replace(/\u202F/g, " ")      // narrow no-break space
    .replace(/[\u200B-\u200D\uFEFF]/g, ""); // ZWSP / BOM

  // ------------------------------------------------------------
  // 2) Remove SSE artifacts if any slipped through
  // ------------------------------------------------------------
  out = out
    .replace(/(^|\n)\s*data:\s*/gi, "")
    .replace(/\[DONE\]/gi, "");

  // ------------------------------------------------------------
  // 3) DO NOT COLLAPSE SPACES ANYMORE
  //    (This was the root cause of fused words)
  // ------------------------------------------------------------
  // ❌ REMOVE THIS ENTIRE LINE:
  // out = out.replace(/ {3,}/g, "  ");

  // ------------------------------------------------------------
  // 4) Normalize excessive newlines
  // ------------------------------------------------------------
  out = out.replace(/\n{3,}/g, "\n\n");

  // ------------------------------------------------------------
  // 5) Clean markdown artifacts
  // ------------------------------------------------------------
  out = out.replace(/\* \* \*/g, "***");
  out = out.replace(/` ` `/g, "```");

  // ------------------------------------------------------------
  // 6) Remove leaked literals
  // ------------------------------------------------------------
  out = out.replace(/undefined/g, "");

  // ------------------------------------------------------------
  // 7) Final trim — BUT preserve word spacing internally
  // ------------------------------------------------------------
  return out.trimStart();
}

