// ============================================================
//  CORTÉX — INFERENCE ENGINE (Step 46A Compatible with chat.js)
// ============================================================
//
// chat.js calls:
// inferPaths(fusedEvidence, intent)
//
// So we must accept:
//  • evidence = array
//  • intent = string
//
// Output must be a simple structure consumed by synthesis.
// ============================================================

export function inferPaths(evidence = [], intent = "general") {
  const notes = [];

  switch (intent) {
    case "question":
      notes.push("Clarify the topic and provide a direct explanation.");
      break;

    case "instruction":
      notes.push("Provide actionable, step-by-step guidance.");
      break;

    case "summary":
      notes.push("Be concise and highlight essential points.");
      break;

    case "analysis":
      notes.push("Break down concepts logically and examine structure.");
      break;

    default:
      notes.push("General intent — provide a high-quality, aligned response.");
      break;
  }

  // Evidence checks
  if (Array.isArray(evidence) && evidence.length > 0) {
    notes.push("Use provided evidence to enhance accuracy and grounding.");
  }

  return {
    reasoningNotes: notes,
    evidenceCount: Array.isArray(evidence) ? evidence.length : 0,
  };
}
