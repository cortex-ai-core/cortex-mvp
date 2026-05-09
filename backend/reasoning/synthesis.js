// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  v1.7.6 — STRUCTURAL INTELLIGENCE STABILIZATION
// ============================================================

export async function synthesizeFinalAnswer({
  intent = "general",
  userMessage = "",
  fusedEvidence = [],
  inferencePaths = {},
  contextWindow = "",
  model,
  identityContext = null,
}) {

  // ============================================================
  // 🔥 LITERAL MODE SHORT-CIRCUIT
  // ============================================================
  if (intent === "literal") {
    return userMessage
      .replace(/^repeat exactly:/i, "")
      .replace(/^repeat this exactly:/i, "")
      .replace(/^do not change:/i, "")
      .replace(/^say this verbatim:/i, "")
      .trim();
  }

  // ============================================================
  // 🔥 IDENTITY CONTEXT
  // ============================================================
  const role = identityContext?.role || "user";
  const namespace = identityContext?.namespace || "general";
  const tone = identityContext?.tone || "neutral";

  // ============================================================
  // 🔥 CONTEXT DETECTION
  // ============================================================
  const hasContext =
    typeof contextWindow === "string" &&
    contextWindow.trim().length > 0;

  // ============================================================
  // 🔥 INLINE SOURCE DETECTION
  // ============================================================
  const hasInlineSourceText =
    userMessage.includes(":") &&
    userMessage.split(":")[1]?.trim().length > 10;

  // ============================================================
  // 🔥 INTENT-AWARE GROUNDING POLICY
  // ============================================================
  const generativeIntents = [
    "rewrite",
    "communication",
    "business_document",
    "analysis",
    "question",
    "general",
  ];

  const requiresGrounding =
    !generativeIntents.includes(intent);

  // ============================================================
  // 🔥 EARLY EXIT — NO CONTEXT
  // ============================================================
  if (!hasContext && requiresGrounding) {
    return "No matching documents found in the system.";
  }

  // ============================================================
  // 🔥 EARLY EXIT — GENERATIVE TASKS
  // ============================================================
  if (
    !hasContext &&
    !requiresGrounding &&
    (
      intent === "rewrite" ||
      intent === "communication" ||
      intent === "business_document"
    ) &&
    !hasInlineSourceText
  ) {
    return "Please provide the source text or upload the document you'd like Cortéx to rewrite or enhance.";
  }

  // ============================================================
  // 🔥 ENTITY DETECTION
  //
  // IMPORTANT:
  // Only trust explicit source-of-truth injection.
  // Do NOT force unsafe fallback guessing.
  // ============================================================
  let primaryEntity = null;

  if (hasContext) {

    const injected = contextWindow.match(
      /PRIMARY ENTITY \(SOURCE OF TRUTH\):\s*(.+)/i
    );

    if (injected?.[1]) {
      const cleaned = injected[1].trim();

      // basic sanity protection
      if (
        cleaned.length > 2 &&
        cleaned.length < 120 &&
        !cleaned.toLowerCase().includes("not enough evidence")
      ) {
        primaryEntity = cleaned;
      }
    }
  }

  // ============================================================
  // 🔥 EVIDENCE SIGNAL ANALYSIS
  // ============================================================
  const totalEvidenceLength = fusedEvidence.reduce(
    (sum, e) => sum + (e.content || "").length,
    0
  );

  const lowEvidence =
    fusedEvidence.length <= 2 ||
    totalEvidenceLength < 1200;

  // ============================================================
  // 🔥 SYSTEM PROMPT
  // ============================================================
  const systemPrompt = `
You are Cortéx — the sovereign reasoning engine.

IDENTITY CONTEXT:
- Role: ${role}
- Namespace: ${namespace}
- Tone Mode: ${tone}

Respond with clarity, precision, and operational usefulness.

GLOBAL BEHAVIOR RULES:
- Maintain grounded reasoning
- Do NOT fabricate missing evidence
- Do NOT expose internal reasoning
- Preserve generalized intelligence
- Avoid hardcoded assumptions
- Prioritize signal over verbosity

EVIDENCE DISCIPLINE:
- Treat evidence sources independently unless relationships are clearly supported
- Use corroborating evidence carefully
- Preserve source integrity
- Prioritize high-confidence evidence
- Avoid unsupported extrapolation
- Avoid narrative inflation
- Avoid repetitive phrasing
- Compress overlapping evidence into unified insights

STRUCTURE RULES:
- Each section must contribute unique informational value
- Do NOT restate summaries inside strengths/recommendations
- Avoid filler bullets
- Prefer fewer high-value insights over exhaustive enumeration
- Avoid resume narrator tone unless explicitly requested
- Maintain concise executive-level synthesis

ENTITY RULES:
${
  primaryEntity
    ? `
- The primary entity is "${primaryEntity}"
- Use exact spelling
- Include naturally if relevant
`
    : `
- Do NOT invent or guess entity names
- If no verified entity exists, omit identity-specific labeling
`
}

CONTEXT RULES:
- CONTEXT is authoritative
- Use only supported evidence
- Do NOT claim context is missing if evidence exists

${
  lowEvidence
    ? `
LOW EVIDENCE MODE:
- Be conservative
- Acknowledge uncertainty carefully
- Avoid overstating capability or risk
`
    : ""
}
`.trim();

  // ============================================================
  // 🔥 EVIDENCE + REASONING TEXT
  // ============================================================
  const evidenceText = fusedEvidence
    .map((e) => `- ${e.content || ""}`)
    .join("\n");

  const reasoningNotes = Array.isArray(
    inferencePaths.reasoningNotes
  )
    ? inferencePaths.reasoningNotes.join("\n- ")
    : "None";

  // ============================================================
  // 🔥 USER PROMPT
  // ============================================================
  const userPrompt = `
CONTEXT WINDOW:
${contextWindow}

USER MESSAGE:
${userMessage}

EVIDENCE:
${evidenceText}

REASONING NOTES:
- ${reasoningNotes}

TASK:
Return a structured, concise, evidence-grounded response.

Prioritize:
1. Evidence quality
2. Operational relevance
3. Precision
4. Clarity
5. Signal density

Avoid:
- repeating conclusions
- duplicating sections
- overstating weak evidence
- narrating obvious details
- template filler
- unsupported assumptions

If evidence is strong:
- synthesize confidently

If evidence is weak:
- remain appropriately conservative

Do NOT reference system structure.
`.trim();

  // ============================================================
  // 🔥 OPENAI RESPONSE
  // ============================================================
  const completion =
    await model.chat.completions.create({
      model: "gpt-5.1",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      temperature: 0.2,
    });

  let output =
    completion.choices?.[0]?.message?.content ||
    "I need more information.";

  // ============================================================
  // 🔥 FINAL ENTITY SAFETY
  // ============================================================
  if (
    primaryEntity &&
    !output.includes(primaryEntity)
  ) {
    output = `${primaryEntity} — ${output}`;
  }

  return output;
}
