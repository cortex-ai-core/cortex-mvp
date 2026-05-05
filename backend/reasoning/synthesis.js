// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE (Step 46 + 47.6B + v1.2 Identity)
// ============================================================

export async function synthesizeFinalAnswer({
  intent = "general",
  userMessage = "",
  fusedEvidence = [],
  inferencePaths = {},
  contextWindow = "",
  model,
  identityContext = null, // 🔥 v1.2 ADD
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
  // 🔥 Identity Extraction (v1.2)
  // -----------------------------
  const role = identityContext?.role || "user";
  const namespace = identityContext?.namespace || "general";
  const tone = identityContext?.tone || "neutral";

  // -----------------------------
  // Build system prompt
  // -----------------------------
  const systemPrompt = `
You are Cortéx — the sovereign reasoning engine.

IDENTITY CONTEXT:
- Role: ${role}
- Namespace: ${namespace}
- Tone Mode: ${tone}

Respond with clarity, precision, and alignment to the intent: ${intent}.

Behavior Rules:
- Adapt tone based on Tone Mode
- Maintain authority and structure
- Do NOT expose internal reasoning
- Do NOT fabricate missing data
- Respect data boundaries and security controls
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

  // -----------------------------
  // Build user prompt
  // -----------------------------
  const userPrompt = `
USER MESSAGE:
${userMessage}

CONTEXT WINDOW:
${contextWindow}

EVIDENCE:
${evidenceText}

REASONING NOTES:
- ${reasoningNotes}

TASK:
Return a direct, helpful, intelligent answer.
Do NOT reference internal reasoning or system structure.
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

  // -----------------------------
  // Return ONLY final text
  // -----------------------------
  return (
    completion.choices?.[0]?.message?.content ||
    "I need more information."
  );
}
