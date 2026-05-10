// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  v1.7.8 — EXECUTIVE COMPRESSION REFINEMENT
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
  // ============================================================
  let primaryEntity = null;

  if (hasContext) {

    const injected = contextWindow.match(
      /PRIMARY ENTITY \(SOURCE OF TRUTH\):\s*(.+)/i
    );

    if (injected?.[1]) {

      const cleaned = injected[1].trim();

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
  // 🔥 EVIDENCE COMPRESSION
  // ============================================================
  const uniqueEvidence = [];
  const seenEvidence = new Set();

  for (const e of fusedEvidence) {

    const content =
      (e.content || "")
        .replace(/\s+/g, " ")
        .trim();

    if (!content) continue;

    const fingerprint =
      content.toLowerCase().slice(0, 240);

    if (seenEvidence.has(fingerprint)) {
      continue;
    }

    seenEvidence.add(fingerprint);

    uniqueEvidence.push({
      ...e,
      content,
    });
  }

  // ============================================================
  // 🔥 EVIDENCE PRIORITIZATION
  // ============================================================
  uniqueEvidence.sort((a, b) => {
    return (b.score || 0) - (a.score || 0);
  });

  // ============================================================
  // 🔥 EVIDENCE BUDGET
  // ============================================================
  const compressedEvidence =
    uniqueEvidence.slice(0, 10);

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
- Prefer strategic compression over exhaustive explanation

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
- Compress overlapping observations into unified insights
- Avoid recursive recommendations
- Avoid section expansion from minor evidence variations
- Prefer strategic density over exhaustive coverage
- If two insights are materially similar, merge them
- Prefer dense executive synthesis over explanatory decomposition
- Compress uncertainty into concise confidence statements
- Avoid enumerating multiple variations of the same limitation
- Minimize section fragmentation
- Favor implication-rich summaries over analytical narration
- Use fewer sections when possible

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
- Compress uncertainty into concise executive language
- Avoid overstating capability or risk
- Avoid speculative recommendations
- Avoid excessive explanation of missing evidence
`
    : ""
}
`.trim();

  // ============================================================
  // 🔥 EVIDENCE TEXT
  // ============================================================
  const evidenceText = compressedEvidence
    .map((e) => `- ${e.content || ""}`)
    .join("\n");

  // ============================================================
  // 🔥 REASONING NOTE COMPRESSION
  // ============================================================
  const reasoningNotes = Array.isArray(
    inferencePaths.reasoningNotes
  )
    ? [...new Set(
        inferencePaths.reasoningNotes
          .map(r => r.trim())
          .filter(Boolean)
      )]
        .slice(0, 6)
        .join("\n- ")
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
6. Executive compression

Avoid:
- repeating conclusions
- duplicating sections
- overstating weak evidence
- narrating obvious details
- template filler
- unsupported assumptions
- recursive recommendations
- section bloat
- repeating equivalent observations
- excessive decomposition
- analytical narration
- fragmented sectioning
- verbose uncertainty explanation

If evidence is strong:
- synthesize confidently
- compress insights strategically
- prioritize implications over explanation

If evidence is weak:
- remain appropriately conservative
- compress limitations into concise confidence statements

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
      temperature: 0.15,
    });

  const output =
    completion.choices?.[0]?.message?.content?.trim() ||
    "I need more information.";

  return output;
}
