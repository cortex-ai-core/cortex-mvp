// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  v1.8.6 — EXECUTIVE CONTINUITY HARDENING
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

  const primaryEntity =
    identityContext?.primaryEntity || null;

  // ============================================================
  // 🔥 CONTEXT DETECTION
  // ============================================================
  const hasContext =
    typeof contextWindow === "string" &&
    contextWindow.trim().length > 0;

  // ============================================================
  // 🔥 INLINE CONTEXT SUFFICIENCY DETECTION
  // ============================================================
  const hasInlineSourceText =
    userMessage.includes(":") &&
    userMessage.split(":")[1]?.trim().length > 10;

  const inlineContextRich =
    typeof userMessage === "string" &&
    userMessage.trim().length >= 120;

  // ============================================================
  // 🔥 RETRIEVAL-DEPENDENT SIGNALS
  // ============================================================
  const retrievalDependentSignals = [
    "resume",
    "candidate",
    "uploaded file",
    "uploaded document",
    "analyze this document",
    "summarize this resume",
    "compare candidates",
    "compare resumes",
  ];

  const requiresExternalEvidence =
    retrievalDependentSignals.some(signal =>
      userMessage.toLowerCase().includes(signal)
    );

  // ============================================================
  // 🔥 SYNTHESIS ELIGIBILITY
  // ============================================================
  const synthesisEligible =
    hasContext ||
    (
      inlineContextRich &&
      !requiresExternalEvidence
    );

  // ============================================================
  // 🔥 TRUE MISSING CONTEXT
  // ============================================================
  if (!synthesisEligible) {
    return "No matching documents found in the system.";
  }

  // ============================================================
  // 🔥 INLINE REWRITE SAFETY
  // ============================================================
  if (
    !hasContext &&
    requiresExternalEvidence &&
    !hasInlineSourceText
  ) {
    return "Please provide the source text or upload the document you'd like Cortéx to analyze or enhance.";
  }

  // ============================================================
  // 🔥 EVIDENCE NORMALIZATION
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
  // 🔥 ECOSYSTEM CONTINUITY BALANCING
  // ============================================================
  const MAX_EVIDENCE = 8;
  const MAX_PER_SOURCE = 2;

  const compressedEvidence = [];
  const sourceCounts = new Map();

  let strategicPresence = 0;
  let operationalPresence = 0;

  for (const evidence of uniqueEvidence) {

    if (compressedEvidence.length >= MAX_EVIDENCE) {
      break;
    }

    const sourceKey =
      evidence.documentId ||
      evidence.source ||
      evidence.metadata?.documentId ||
      evidence.metadata?.source ||
      "unknown";

    const currentCount =
      sourceCounts.get(sourceKey) || 0;

    if (currentCount >= MAX_PER_SOURCE) {
      continue;
    }

    const lower =
      (evidence.content || "").toLowerCase();

    const strategicSignals = [
      "strategy",
      "roadmap",
      "initiative",
      "governance",
      "vision",
      "objective",
      "leadership",
      "transformation",
      "scalability",
    ];

    const operationalSignals = [
      "workflow",
      "deployment",
      "ticket",
      "incident",
      "support",
      "implementation",
      "integration",
    ];

    const strategicMatches =
      strategicSignals.filter(s => lower.includes(s)).length;

    const operationalMatches =
      operationalSignals.filter(s => lower.includes(s)).length;

    if (strategicMatches > operationalMatches) {
      strategicPresence++;
    }

    if (operationalMatches > strategicMatches) {
      operationalPresence++;
    }

    // ------------------------------------------------------------
    // SOFT ANTI-MONOPOLIZATION
    // ------------------------------------------------------------
    if (
      operationalPresence > 5 &&
      strategicPresence === 0 &&
      strategicMatches > 0
    ) {
      strategicPresence++;
    }

    compressedEvidence.push(evidence);

    sourceCounts.set(
      sourceKey,
      currentCount + 1
    );
  }

  // ============================================================
  // 🔥 FALLBACK CONTINUITY SAFETY
  // ============================================================
  if (compressedEvidence.length < 5) {

    for (const evidence of uniqueEvidence) {

      if (compressedEvidence.length >= MAX_EVIDENCE) {
        break;
      }

      if (compressedEvidence.includes(evidence)) {
        continue;
      }

      compressedEvidence.push(evidence);
    }
  }

  // ============================================================
  // 🔥 EVIDENCE QUALITY ANALYSIS
  // ============================================================
  const totalEvidenceLength = compressedEvidence.reduce(
    (sum, e) => sum + (e.content || "").length,
    0
  );

  const uniqueSources =
    new Set(
      compressedEvidence.map(
        e =>
          e.documentId ||
          e.source ||
          e.metadata?.documentId ||
          e.metadata?.source
      )
    ).size;

  const lowEvidence =
    (
      compressedEvidence.length <= 2 &&
      uniqueSources <= 1
    ) ||
    totalEvidenceLength < 900;

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
  // 🔥 ABSTRACTION STRATIFICATION
  // ============================================================
  const abstractionBuckets = {
    strategic: [],
    governance: [],
    operational: [],
    ecosystem: [],
    contextual: [],
  };

  const weightedSignals = {

    strategic: {
      signals: [
        "strategy",
        "roadmap",
        "initiative",
        "objective",
        "vision",
        "modernization",
        "future-state",
        "transformation",
        "scalability",
      ],
      threshold: 2,
    },

    governance: {
      signals: [
        "governance",
        "policy",
        "compliance",
        "audit",
        "leadership",
        "oversight",
        "risk",
        "controls",
      ],
      threshold: 2,
    },

    operational: {
      signals: [
        "workflow",
        "incident",
        "integration",
        "implementation",
        "operations",
        "monitoring",
        "support",
      ],
      threshold: 3,
    },

    ecosystem: {
      signals: [
        "ecosystem",
        "stakeholder",
        "dependency",
        "coordination",
        "cross-functional",
        "continuity",
      ],
      threshold: 2,
    },
  };

  for (const e of compressedEvidence) {

    const content =
      (e.content || "").trim();

    if (!content) continue;

    const lower =
      content.toLowerCase();

    let matchedAny = false;

    for (const [bucket, config] of Object.entries(weightedSignals)) {

      const matches =
        config.signals.filter(
          signal => lower.includes(signal)
        ).length;

      if (matches >= config.threshold) {

        abstractionBuckets[bucket].push(content);

        matchedAny = true;
      }
    }

    if (!matchedAny) {
      abstractionBuckets.contextual.push(content);
    }
  }

  // ============================================================
  // 🔥 HIERARCHICAL EVIDENCE ASSEMBLY
  // ============================================================
  const buildSection = (
    title,
    items,
    limit = 4
  ) => {

    const unique =
      [...new Set(items)].slice(0, limit);

    if (!unique.length) return "";

    return `
${title}:
${unique.map(i => `- ${i}`).join("\n")}
`.trim();
  };

  const weightedSections = [];

  for (const [bucket, items] of Object.entries(abstractionBuckets)) {

    if (!items.length) continue;

    weightedSections.push(
      buildSection(
        `${bucket.toUpperCase()} SIGNALS`,
        items,
        bucket === "operational" ? 5 : 4
      )
    );
  }

  const evidenceText =
    weightedSections
      .filter(Boolean)
      .join("\n\n");

  // ============================================================
  // 🔥 SYSTEM PROMPT MODULES
  // ============================================================
  const coreBehavior = `
You are Cortéx — the sovereign reasoning engine.

Respond with:
- executive clarity
- strategic precision
- operational sufficiency
- grounded reasoning

Preserve:
- generalized intelligence
- evidence discipline
- abstraction hierarchy
- thematic continuity
- ecosystem-level reasoning

Avoid:
- filler narration
- checklist cadence
- repetitive decomposition
- unsupported extrapolation
- abstraction inflation
`;

  const evidenceRules = `
EVIDENCE RULES:
- preserve source continuity
- avoid evidence monopolization
- preserve independently supported entities
- synthesize overlapping evidence into unified implications
- avoid unsupported enterprise escalation
`;

  const structureRules = `
STRUCTURE RULES:
- use natural executive rhythm
- compress redundancy
- preserve strategic and operational hierarchy
- favor implication-rich synthesis
- preserve deliverable continuity
`;

  const entityRules = primaryEntity
    ? `
ENTITY RULES:
- primary entity is "${primaryEntity}"
- preserve exact spelling
- reference naturally where operationally relevant
`
    : `
ENTITY RULES:
- avoid unsupported entity attribution
`;

  const lowEvidenceRules = lowEvidence
    ? `
LOW EVIDENCE MODE:
- remain conservative
- compress uncertainty
- avoid speculative escalation
`
    : "";

  const systemPrompt = `
${coreBehavior}

IDENTITY CONTEXT:
- Role: ${role}
- Namespace: ${namespace}
- Tone: ${tone}

${evidenceRules}

${structureRules}

${entityRules}

${lowEvidenceRules}
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
- strategic implications
- operational leverage
- governance significance
- continuity preservation
- systems-level interpretation
- abstraction coherence

Avoid:
- verbose narration
- repetitive structure
- disconnected observations
- unsupported abstraction escalation

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
