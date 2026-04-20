// ============================================================
//  CORTÉX — INTENT DECODER (Step 46A + 47.6A LITERAL MODE)
// ============================================================

export function decodeIntent(message = "") {
  const msg = message.toLowerCase().trim();
  if (!msg) return "general";

  // ============================================================
  //  LITERAL MODE DETECTION (Step 47.6A)
  // ============================================================
  const literalTriggers = [
    /^repeat exactly:/i,
    /^repeat this exactly:/i,
    /^do not change:/i,
    /^say this verbatim:/i,
  ];

  for (const trigger of literalTriggers) {
    if (msg.match(trigger)) {
      return "literal";
    }
  }

  // ============================================================
  //  STANDARD INTENT DETECTION
  // ============================================================
  if (msg.startsWith("what") || msg.includes("explain") || msg.includes("?"))
    return "question";

  if (msg.startsWith("how") || msg.includes("help me"))
    return "instruction";

  if (msg.startsWith("summarize") || msg.includes("summary") || msg.includes("tl;dr"))
    return "summary";

  if (msg.includes("analysis") || msg.startsWith("analyze"))
    return "analysis";

  return "general";
}
