// ============================================================
//  CORTÉX — INTENT DECODER
//  v1.8.4 — OPERATIONAL MATURITY PATCH
//  Generalized Completion-Aware Intent Inference
// ============================================================

export function decodeIntent(message = "") {
  const msg = message.toLowerCase().trim();

  // ============================================================
  //  EMPTY MESSAGE
  // ============================================================
  if (!msg) {
    return {
      type: "general",
      maturity: "general",
    };
  }

  // ============================================================
  //  LITERAL MODE DETECTION
  // ============================================================
  const literalTriggers = [
    /^repeat exactly:/i,
    /^repeat this exactly:/i,
    /^do not change:/i,
    /^say this verbatim:/i,
  ];

  for (const trigger of literalTriggers) {
    if (msg.match(trigger)) {
      return {
        type: "literal",
        maturity: "locked",
      };
    }
  }

  // ============================================================
  //  MATURITY INFERENCE
  // ============================================================

  let maturity = "general";

  // ------------------------------------------------------------
  //  EXPLORATORY / IDEATION
  // ------------------------------------------------------------
  if (
    msg.includes("brainstorm") ||
    msg.includes("ideas") ||
    msg.includes("outline") ||
    msg.includes("framework") ||
    msg.includes("example") ||
    msg.includes("concept")
  ) {
    maturity = "exploratory";
  }

  // ------------------------------------------------------------
  //  REFINEMENT / REVISION
  // ------------------------------------------------------------
  else if (
    msg.includes("rewrite") ||
    msg.includes("revise") ||
    msg.includes("enhance") ||
    msg.includes("improve") ||
    msg.includes("optimize") ||
    msg.includes("clean this up") ||
    msg.includes("polish") ||
    msg.includes("refine")
  ) {
    maturity = "refinement";
  }

  // ------------------------------------------------------------
  //  FINALIZATION / DEPLOYMENT
  // ------------------------------------------------------------
  else if (
    msg.includes("finalize") ||
    msg.includes("final version") ||
    msg.includes("ready to send") ||
    msg.includes("cut and paste") ||
    msg.includes("production ready") ||
    msg.includes("deployable") ||
    msg.includes("employee ready") ||
    msg.includes("customer ready") ||
    msg.includes("send this") ||
    msg.includes("operationalize") ||
    msg.includes("complete this")
  ) {
    maturity = "deployable";
  }

  // ============================================================
  //  TYPE DETECTION
  // ============================================================

  let type = "general";

  // ------------------------------------------------------------
  //  REWRITE / ENHANCEMENT
  // ------------------------------------------------------------
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
    type = "rewrite";
  }

  // ------------------------------------------------------------
  //  EMAIL / COMMUNICATION
  // ------------------------------------------------------------
  else if (
    msg.includes("email") ||
    msg.includes("draft a response") ||
    msg.includes("respond to") ||
    msg.includes("write a response") ||
    msg.includes("compose")
  ) {
    type = "communication";
  }

  // ------------------------------------------------------------
  //  BUSINESS DOCUMENTS
  // ------------------------------------------------------------
  else if (
    msg.includes("sow") ||
    msg.includes("statement of work") ||
    msg.includes("scope of work") ||
    msg.includes("proposal") ||
    msg.includes("msa") ||
    msg.includes("sla") ||
    msg.includes("agreement") ||
    msg.includes("contract") ||
    msg.includes("ltip")
  ) {
    type = "business_document";
  }

  // ------------------------------------------------------------
  //  INCIDENT / OPERATIONS
  // ------------------------------------------------------------
  else if (
    msg.includes("incident") ||
    msg.includes("outage") ||
    msg.includes("root cause") ||
    msg.includes("remediation") ||
    msg.includes("sev") ||
    msg.includes("severity") ||
    msg.includes("operational issue") ||
    msg.includes("downtime")
  ) {
    type = "incident";
  }

  // ------------------------------------------------------------
  //  CANDIDATE / RESUME
  // ------------------------------------------------------------
  else if (
    msg.includes("resume") ||
    msg.includes("candidate") ||
    msg.includes("alignment score") ||
    msg.includes("technical match") ||
    msg.includes("culture fit") ||
    msg.includes("submittal") ||
    msg.includes("job fit") ||
    msg.includes("role fit")
  ) {
    type = "candidate";
  }

  // ------------------------------------------------------------
  //  SUMMARY
  // ------------------------------------------------------------
  else if (
    msg.startsWith("summarize") ||
    msg.includes("summary") ||
    msg.includes("tl;dr")
  ) {
    type = "summary";
  }

  // ------------------------------------------------------------
  //  ANALYSIS
  // ------------------------------------------------------------
  else if (
    msg.includes("analysis") ||
    msg.startsWith("analyze") ||
    msg.includes("assess") ||
    msg.includes("evaluate") ||
    msg.includes("compare")
  ) {
    type = "analysis";
  }

  // ------------------------------------------------------------
  //  QUESTIONS
  // ------------------------------------------------------------
  else if (
    msg.startsWith("what") ||
    msg.startsWith("why") ||
    msg.startsWith("when") ||
    msg.startsWith("where") ||
    msg.includes("?") ||
    msg.includes("explain")
  ) {
    type = "question";
  }

  // ------------------------------------------------------------
  //  INSTRUCTIONAL
  // ------------------------------------------------------------
  else if (
    msg.startsWith("how") ||
    msg.includes("help me")
  ) {
    type = "instruction";
  }

  // ============================================================
  //  RETURN
  // ============================================================

  return {
    type,
    maturity,
  };
}
