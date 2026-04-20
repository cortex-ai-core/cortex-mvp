// ============================================================
//  CORTÉX — EVIDENCE FUSION ENGINE (Step 46A Compatible)
// ============================================================
//
// chat.js calls:
// fuseEvidence(standardizedEvidence, intent)
//
// Therefore: 
//  • arg1 = evidence array
//  • arg2 = intent string
//
// Output MUST be a flat array of fused evidence objects.
//

export function fuseEvidence(evidence = [], intent = "general") {
  if (!Array.isArray(evidence)) return [];

  // Future: intent weighting can be applied here.
  // For now: return evidence unchanged.
  return evidence.map((e) => ({
    content: e.content || "",
    source: e.source || "unknown",
    weight: e.weight || 0.5,
    intent,
  }));
}
