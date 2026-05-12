// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  v1.8.5 — ADAPTIVE SYNTHESIS ELIGIBILITY
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
  // 🔥 SYNTHESIS ELIGIBILITY ARBITRATION
  // ============================================================
  const synthesisEligible =
    hasContext ||
    (
      inlineContextRich &&
      !requiresExternalEvidence
    );

  // ============================================================
  // 🔥 EARLY EXIT — TRUE MISSING EVIDENCE
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
  // 🔥 CONTINUITY-AWARE COMPRESSION
  // ============================================================
  const MAX_EVIDENCE = 7;
  const MAX_PER_SOURCE = 2;

  const compressedEvidence = [];
  const sourceCounts = new Map();

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

    // ============================================================
    // SOFT SOURCE DIVERSITY MODERATION
    // ============================================================
    if (currentCount >= MAX_PER_SOURCE) {
      continue;
    }

    compressedEvidence.push(evidence);

    sourceCounts.set(
      sourceKey,
      currentCount + 1
    );
  }

  // ============================================================
  // 🔥 FALLBACK SAFETY
  // ============================================================
  if (compressedEvidence.length < 4) {

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

  const abstractionScores = {
    strategic: 0,
    governance: 0,
    operational: 0,
    ecosystem: 0,
  };

  const signalGroups = {

    strategic: [
      "strategy",
      "roadmap",
      "initiative",
      "objective",
      "vision",
      "priority",
      "future-state",
      "optimization",
      "expansion",
      "modernization",
      "scalability",
    ],

    governance: [
      "governance",
      "compliance",
      "policy",
      "leadership",
      "accountability",
      "audit",
      "risk",
      "standards",
      "oversight",
      "regulatory",
      "controls",
    ],

    operational: [
      "workflow",
      "incident",
      "deployment",
      "integration",
      "implementation",
      "operations",
      "ticket",
      "infrastructure",
      "monitoring",
      "stability",
      "support",
    ],

    ecosystem: [
      "dependency",
      "ecosystem",
      "organizational",
      "continuity",
      "coordination",
      "interconnected",
      "topology",
      "stakeholder",
      "cross-functional",
      "multi-team",
    ],
  };

  for (const e of compressedEvidence) {

    const content =
      (e.content || "").trim();

    if (!content) continue;

    const lower =
      content.toLowerCase();

    const matches = {
      strategic: false,
      governance: false,
      operational: false,
      ecosystem: false,
    };

    for (const [bucket, signals] of Object.entries(signalGroups)) {

      const matched =
        signals.some(signal => lower.includes(signal));

      matches[bucket] = matched;

      if (matched) {

        abstractionBuckets[bucket].push(content);

        abstractionScores[bucket]++;
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

  if (abstractionScores.strategic >= 2) {

    weightedSections.push(
      buildSection(
        "STRATEGIC SIGNALS",
        abstractionBuckets.strategic,
        4
      )
    );
  }

  if (abstractionScores.governance >= 2) {

    weightedSections.push(
      buildSection(
        "GOVERNANCE SIGNALS",
        abstractionBuckets.governance,
        4
      )
    );
  }

  if (abstractionScores.operational >= 2) {

    weightedSections.push(
      buildSection(
        "OPERATIONAL SIGNALS",
        abstractionBuckets.operational,
        5
      )
    );
  }

  if (abstractionScores.ecosystem >= 2) {

    weightedSections.push(
      buildSection(
        "ECOSYSTEM SIGNALS",
        abstractionBuckets.ecosystem,
        4
      )
    );
  }

  weightedSections.push(
    buildSection(
      "SUPPORTING CONTEXT",
      abstractionBuckets.contextual,
      4
    )
  );

  const evidenceText =
    weightedSections
      .filter(Boolean)
      .join("\n\n");

  // ============================================================
  // 🔥 SYSTEM PROMPT
  // ============================================================
  const systemPrompt = `
You are Cortéx — the sovereign reasoning engine.

IDENTITY CONTEXT:
- Role: ${role}
- Namespace: ${namespace}
- Tone Mode: ${tone}

Respond with precision, operational clarity, and executive-level synthesis.

GLOBAL BEHAVIOR RULES:
- Maintain grounded reasoning
- Do NOT fabricate unsupported conclusions
- Preserve generalized intelligence
- Avoid hardcoded assumptions
- Prioritize leverage, dependencies, governance, bottlenecks, and sustainability
- Prefer implication-rich synthesis over descriptive narration
- Match abstraction depth to the operational needs of the deliverable

DELIVERABLE CONTINUITY RULES:
- Preserve the intended deliverable class throughout synthesis
- Maintain operational sufficiency under compression
- Compression should reduce redundancy, not remove functional completeness
- Preserve proportional hierarchy between strategic, operational, and supporting layers
- Maintain continuity of the original artifact intent across iterative refinement

REFINEMENT STABILITY:
- Apply corrective feedback locally where possible
- Avoid over-correcting toward compression or expansion extremes

EVIDENCE DISCIPLINE:
- Treat evidence sources independently unless relationships are clearly supported
- Preserve source integrity
- Preserve continuity across independently supported entities
- Avoid allowing a single evidence cluster to dominate synthesis bandwidth
- Prioritize high-confidence evidence
- Avoid unsupported extrapolation
- Compress overlapping evidence into unified strategic insights
- Avoid repetitive implication chains
- Avoid evidence echoing

STRUCTURE RULES:
- Preserve proportional structure appropriate to the deliverable
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
- Match abstraction depth to evidence density
- Preserve domain fidelity
- Avoid projecting enterprise governance, infrastructure, or resilience models onto loosely related business material
- Do not escalate local business terminology into enterprise operational topology unless evidence materially supports those abstractions

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
5. Deliverable continuity
6. Operational sufficiency preservation
7. Proportional completeness
8. Executive compression
9. Conceptual continuity
10. Ecosystem-level reasoning
11. Hierarchical abstraction coherence
12. Continuity preservation across independently supported entities

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
- projecting unsupported enterprise abstractions

If evidence is strong:
- synthesize confidently
- preserve operational sufficiency while synthesizing toward strategic conclusions
- prioritize systems-level interpretation
- preserve thematic continuity across abstraction layers

If evidence is weak:
- remain conservative
- compress uncertainty into concise confidence posture
- preserve domain fidelity
- avoid abstraction escalation

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
