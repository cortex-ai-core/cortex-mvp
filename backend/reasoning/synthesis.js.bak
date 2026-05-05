// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE (Step 46 + 47.6B)
// ============================================================

export async function synthesizeFinalAnswer({
  intent = "general",
  userMessage = "",
  fusedEvidence = [],
  inferencePaths = {},
  contextWindow = "",
  model, // <- full OpenAI client
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
  // Build system prompt
  // -----------------------------
  const systemPrompt = `
You are Cortéx — the sovereign reasoning engine.
Respond with clarity, precision, and alignment to the intent: ${intent}.
Do NOT mention internal reasoning steps.
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
