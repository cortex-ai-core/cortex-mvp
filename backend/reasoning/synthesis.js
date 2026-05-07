// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  Step 46 + 47.6B + v1.2 Identity
//  v1.7.1 — MODE-AWARE CONTEXT ENFORCEMENT
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
  //  LITERAL MODE SHORT-CIRCUIT (Step 47.6B)
  // ============================================================
  if (intent === "literal") {
    const cleaned = userMessage
      .replace(/^repeat exactly:/i, "")
      .replace(/^repeat this exactly:/i, "")
      .replace(/^do not change:/i, "")
      .replace(/^say this verbatim:/i, "")
      .trim();

    return cleaned;
  }

  // -----------------------------
  // 🔥 Identity Extraction
  // -----------------------------
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
  // 🔥 MODE-AWARE NO-CONTEXT HANDLING
  // ============================================================
  const generativeIntents = [
    "rewrite",
    "communication",
    "business_document",
  ];

  const requiresGrounding =
    !generativeIntents.includes(intent);

  // ============================================================
  // 🔥 EARLY EXIT — NO CONTEXT FOR GROUNDED TASKS
  // ============================================================
  if (!hasContext && requiresGrounding) {
    return "No matching documents found in the system.";
  }

  // ============================================================
  // 🔥 EARLY EXIT — GENERATIVE TASKS NEED SOURCE TEXT
  // ============================================================
  if (
    !hasContext &&
    !requiresGrounding &&
    !hasInlineSourceText
  ) {
    return "Please provide the source text or upload the document you'd like Cortéx to rewrite or enhance.";
  }

  // ============================================================
  // 🔥 ENTITY DETECTION (FINAL — INJECTED + FALLBACK)
  // ============================================================
  let primaryEntity = null;

  if (hasContext) {

    // 1️⃣ Preferred: injected entity
    const injected = contextWindow.match(
      /PRIMARY ENTITY \(SOURCE OF TRUTH\):\s*(.+)/i
    );

    if (injected) {
      primaryEntity = injected[1].trim();
    }

    // 2️⃣ Fallback: extract first valid full name from context
    if (!primaryEntity) {
      const fallback = contextWindow.match(
        /\b[A-Z][a-z]+ [A-Z][a-z]+\b/
      );

      if (fallback) {
        primaryEntity = fallback[0];
      }
    }
  }

  // ============================================================
  // 🔥 SYSTEM PROMPT
  // ============================================================
  const systemPrompt = `
You are Cortéx — the sovereign reasoning engine.

IDENTITY CONTEXT:
- Role: ${role}
- Namespace: ${namespace}
- Tone Mode: ${tone}

Respond with clarity, precision, and alignment to the intent: ${intent}.

Behavior Rules:
- Maintain authority and structure
- Do NOT expose internal reasoning
- Do NOT fabricate missing data

ENTITY RULES:
- If a PRIMARY ENTITY exists, it is the ONLY valid entity reference
- You MUST use it exactly
- You MUST NOT omit it
- You MUST NOT rename it

CONTEXT RULES:
- CONTEXT is the source of truth
- You MUST use it
- Do NOT say context is missing
`.trim();

  // -----------------------------
  // Build evidence + reasoning text
  // -----------------------------
  const evidenceText = fusedEvidence
    .map((e) => `- ${e.content || ""}`)
    .join("\n");

  const reasoningNotes = Array.isArray(inferencePaths.reasoningNotes)
    ? inferencePaths.reasoningNotes.join("\n- ")
    : "None";

  // ============================================================
  // 🔥 TASK-LEVEL ENFORCEMENT
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
Return a direct, helpful answer.

${
  primaryEntity
    ? `
MANDATORY OUTPUT REQUIREMENT:
- The response MUST include "${primaryEntity}"
- Use exact spelling
- Include it naturally in the first paragraph
`
    : ``
}

Do NOT reference system structure.
`.trim();

  // -----------------------------
  // OpenAI Response
  // -----------------------------
  const completion = await model.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
  });

  let output =
    completion.choices?.[0]?.message?.content ||
    "I need more information.";

  // ============================================================
  // 🔥 FINAL SAFETY — ENTITY GUARANTEE
  // ============================================================
  if (primaryEntity && !output.includes(primaryEntity)) {
    output = `${primaryEntity} — ${output}`;
  }

  return output;
}
