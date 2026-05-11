// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  v1.8.1-pre — CONCEPTUAL ECOSYSTEM CONTINUITY
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
  // 🔥 EVIDENCE NORMALIZATION + DEDUPLICATION
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
      content.toLowerCase().slice(0, 200);

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
    uniqueEvidence.slice(0, 7);

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
        .slice(0, 3)
        .join("\n- ")
    : "None";

  // ============================================================
  // 🔥 SOFT ABSTRACTION STRATIFICATION
  // ============================================================
  const abstractionBuckets = {
    strategic: [],
    governance: [],
    operational: [],
    ecosystem: [],
    contextual: [],
  };

  const signalGroups = {
    strategic: [
      "strategy",
      "roadmap",
      "initiative",
      "transformation",
      "objective",
      "scalability",
      "alignment",
      "vision",
      "priority",
      "future-state",
      "long-term",
      "expansion",
      "optimization",
      "modernization",
    ],

    governance: [
      "governance",
      "compliance",
      "policy",
      "leadership",
      "ownership",
      "accountability",
      "audit",
      "risk",
      "standards",
      "escalation",
      "oversight",
      "controls",
      "regulatory",
    ],

    operational: [
      "workflow",
      "incident",
      "support",
      "deployment",
      "integration",
      "implementation",
      "operations",
      "system",
      "ticket",
      "process",
      "infrastructure",
      "monitoring",
      "response",
      "stability",
    ],

    ecosystem: [
      "cross-functional",
      "dependency",
      "ecosystem",
      "organizational",
      "continuity",
      "enablement",
      "coordination",
      "multi-team",
      "interconnected",
      "topology",
      "collaboration",
      "stakeholder",
      "alignment",
      "shared",
    ],
  };

  for (const e of compressedEvidence) {

    const content = (e.content || "").trim();

    if (!content) continue;

    const lower = content.toLowerCase();

    const matches = {
      strategic: false,
      governance: false,
      operational: false,
      ecosystem: false,
    };

    for (const [bucket, signals] of Object.entries(signalGroups)) {

      matches[bucket] =
        signals.some(signal => lower.includes(signal));

      if (matches[bucket]) {
        abstractionBuckets[bucket].push(content);
      }
    }

    const matchedAny =
      Object.values(matches).some(Boolean);

    if (!matchedAny) {
      abstractionBuckets.contextual.push(content);
    }
  }

  // ============================================================
  // 🔥 HIERARCHICAL EVIDENCE ASSEMBLY
  // ============================================================
  const buildSection = (title, items, limit = 4) => {

    const unique =
      [...new Set(items)].slice(0, limit);

    if (!unique.length) return "";

    return `
${title}:
${unique.map(i => `- ${i}`).join("\n")}
`.trim();
  };

  const evidenceSections = [

    buildSection(
      "STRATEGIC SIGNALS",
      abstractionBuckets.strategic,
      4
    ),

    buildSection(
      "GOVERNANCE SIGNALS",
      abstractionBuckets.governance,
      4
    ),

    buildSection(
      "OPERATIONAL SIGNALS",
      abstractionBuckets.operational,
      5
    ),

    buildSection(
      "ECOSYSTEM SIGNALS",
      abstractionBuckets.ecosystem,
      4
    ),

    buildSection(
      "SUPPORTING CONTEXT",
      abstractionBuckets.contextual,
      4
    ),

  ]
    .filter(Boolean)
    .join("\n\n");

  const evidenceText = evidenceSections;

  // ============================================================
  // 🔥 SYSTEM PROMPT
  // ============================================================
  const systemPrompt = `
You are Cortéx — the sovereign reasoning engine.

IDENTITY CONTEXT:
- Role: ${role}
- Namespace: ${namespace}
- Tone Mode: ${tone}

Respond with precision, operational clarity, strategic compression, and executive-level synthesis.

GLOBAL BEHAVIOR RULES:
- Maintain grounded reasoning
- Do NOT fabricate unsupported conclusions
- Preserve generalized intelligence
- Avoid hardcoded assumptions
- Prioritize leverage, dependencies, governance, bottlenecks, and sustainability
- Prefer implication-rich synthesis over descriptive narration
- Favor strategic abstraction over local-detail expansion

EVIDENCE DISCIPLINE:
- Treat evidence sources independently unless relationships are clearly supported
- Preserve source integrity
- Prioritize high-confidence evidence
- Avoid unsupported extrapolation
- Compress overlapping evidence into unified strategic insights
- Avoid repetitive implication chains
- Avoid evidence echoing

STRUCTURE RULES:
- Prefer fewer, denser sections
- Minimize bullet inflation
- Avoid analytical decomposition unless operationally necessary
- Avoid repetitive “what exists / what does not exist” rhythm
- Prefer integrated executive synthesis over checklist narration
- Compress limitations into concise confidence statements
- Favor strategic implications over descriptive walkthroughs
- Reduce explanatory cadence where implications are already clear
- Use natural executive rhythm rather than mechanically balanced sections
- Preserve abstraction hierarchy across evidence layers
- Preserve thematic continuity across operational and strategic signals
- Favor ecosystem-level interpretation when relationships are supported
- Preserve causality continuity between governance, operations, and strategy
- Avoid flattening distinct conceptual layers into disconnected observations

ENTITY RULES:
${
  primaryEntity
    ? `
- The primary entity is "${primaryEntity}"
- Use exact spelling
- Include naturally if operationally relevant
`
    : `
- Do NOT invent or infer entity names
- If no verified entity exists, avoid identity-specific labeling
`
}

CONTEXT RULES:
- CONTEXT is authoritative
- Use only supported evidence
- Do NOT claim evidence is missing if relevant evidence exists

${
  lowEvidence
    ? `
LOW EVIDENCE MODE:
- Remain conservative
- Compress uncertainty into concise executive language
- Avoid speculative expansion
- Avoid excessive explanation of limitations
`
    : ""
}
`.trim();

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
Return a concise, evidence-grounded executive response.

Prioritize:
1. Strategic implications
2. Operational leverage
3. Governance significance
4. Signal density
5. Executive compression
6. Conceptual continuity
7. Ecosystem-level reasoning
8. Hierarchical abstraction coherence

Avoid:
- analytical narration
- repetitive decomposition
- verbose explanation
- checklist-style repetition
- filler observations
- recursive recommendations
- fragmented structural rhythm
- over-expansion of adjacent implications
- disconnected conceptual observations
- flattening strategic and operational signals into isolated summaries

If evidence is strong:
- synthesize confidently
- compress operational observations into strategic conclusions
- prioritize systems-level interpretation
- preserve thematic continuity across abstraction layers

If evidence is weak:
- remain conservative
- compress uncertainty into concise confidence posture

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
      temperature: 0.08,
    });

  const output =
    completion.choices?.[0]?.message?.content?.trim() ||
    "I need more information.";

  return output;
}
