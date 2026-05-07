// ============================================================
//  CORTÉX — INTENT DECODER
//  Step 46A + 47.6A LITERAL MODE
//  v1.5 — TASK-ORIENTED INTENT ROUTING
// ============================================================

export function decodeIntent(message = "") {
  const msg = message.toLowerCase().trim();

  // ============================================================
  //  EMPTY MESSAGE
  // ============================================================
  if (!msg) {
    return "general";
  }

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
  //  REWRITE / ENHANCEMENT
  // ============================================================
  if (
    msg.includes("rewrite") ||
    msg.includes("restructure") ||
    msg.includes("redraft") ||
    msg.includes("revise") ||
    msg.includes("enhance") ||
    msg.includes("improve") ||
    msg.includes("optimize") ||
    msg.includes("tailor") ||
    msg.includes("clean this up") ||
    msg.includes("make this professional") ||
    msg.includes("rework") ||
    msg.includes("polish")
  ) {
    return "rewrite";
  }

  // ============================================================
  //  EMAIL / COMMUNICATION
  // ============================================================
  if (
    msg.includes("email") ||
    msg.includes("draft a response") ||
    msg.includes("respond to") ||
    msg.includes("write a response") ||
    msg.includes("compose")
  ) {
    return "communication";
  }

  // ============================================================
  //  BUSINESS DOCUMENTS / SOW
  // ============================================================
  if (
    msg.includes("sow") ||
    msg.includes("statement of work") ||
    msg.includes("scope of work") ||
    msg.includes("proposal") ||
    msg.includes("msa") ||
    msg.includes("sla")
  ) {
    return "business_document";
  }

  // ============================================================
  //  INCIDENT / OPERATIONS
  // ============================================================
  if (
    msg.includes("incident") ||
    msg.includes("outage") ||
    msg.includes("root cause") ||
    msg.includes("remediation") ||
    msg.includes("sev") ||
    msg.includes("severity") ||
    msg.includes("operational issue") ||
    msg.includes("downtime")
  ) {
    return "incident";
  }

  // ============================================================
  //  CANDIDATE / RESUME
  // ============================================================
  if (
    msg.includes("resume") ||
    msg.includes("candidate") ||
    msg.includes("alignment score") ||
    msg.includes("technical match") ||
    msg.includes("culture fit") ||
    msg.includes("submittal") ||
    msg.includes("job fit") ||
    msg.includes("role fit")
  ) {
    return "candidate";
  }

  // ============================================================
  //  SUMMARY
  // ============================================================
  if (
    msg.startsWith("summarize") ||
    msg.includes("summary") ||
    msg.includes("tl;dr")
  ) {
    return "summary";
  }

  // ============================================================
  //  ANALYSIS
  // ============================================================
  if (
    msg.includes("analysis") ||
    msg.startsWith("analyze") ||
    msg.includes("assess") ||
    msg.includes("evaluate") ||
    msg.includes("compare")
  ) {
    return "analysis";
  }

  // ============================================================
  //  QUESTIONS
  // ============================================================
  if (
    msg.startsWith("what") ||
    msg.startsWith("why") ||
    msg.startsWith("when") ||
    msg.startsWith("where") ||
    msg.includes("?") ||
    msg.includes("explain")
  ) {
    return "question";
  }

  // ============================================================
  //  INSTRUCTIONAL
  // ============================================================
  if (
    msg.startsWith("how") ||
    msg.includes("help me")
  ) {
    return "instruction";
  }

  // ============================================================
  //  DEFAULT
  // ============================================================
  return "general";
}
