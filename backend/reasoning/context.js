// ============================================================
//  CORTÉX — CONTEXT ASSEMBLER (Step 46A — Compatible with chat.js)
// ============================================================
//
// chat.js calls this function as:
// assembleContext(intent, standardizedEvidence, message)
//
// Therefore this module MUST accept 3 positional arguments,
// NOT an object.
//
// Output MUST be a STRING for the synthesis prompt.
//
// ============================================================

export function assembleContext(intent = "general", evidence = [], userMessage = "") {
  const evidenceText = evidence
    .map((e) => `- ${e.content || ""}`)
    .join("\n");

  return `
INTENT: ${intent}

USER MESSAGE:
${userMessage}

EVIDENCE CONTEXT:
${evidenceText}
`.trim();
}
