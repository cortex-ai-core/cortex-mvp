// ============================================================
//  CORTÉX — FINAL ANSWER SYNTHESIS ENGINE
//  v1.8.7 — EXECUTIVE CADENCE HARDENING
// ============================================================

// Design doc E1.7: the model reports sources that disagree on one trailing
// line, bracketed so it can be lifted out for the trace and never shown.
export const CONFLICT_OPEN = "⟦";
export const CONFLICT_CLOSE = "⟧";
const CONFLICT_RE = /⟦\s*conflicts?\s*:\s*([\s\S]*?)⟧/gi;

/**
 * Split the model's text into the answer and the structured conflicts
 * note: [] when the model reported none. Also removes any stray bracket
 * the model may have produced without the "conflicts:" label.
 */
export function extractConflicts(text = "") {
  const conflicts = [];
  let answer = String(text || "").replace(CONFLICT_RE, (_, body) => {
    const items = String(body || "").split(/\s*(?:;|\n|\|)\s*/).map(s => s.trim()).filter(s => s && !/^none\.?$/i.test(s));
    conflicts.push(...items);
    return "";
  });
  answer = answer.replace(/⟦[^⟧]*⟧?/g, "").trimEnd();
  return { answer, conflicts };
}

export async function synthesizeFinalAnswer({
  intent = "general",
  userMessage = "",
  fusedEvidence = [],
  inferencePaths = {},
  contextWindow = "",
  model,
  identityContext = null,
  onToken = null,
  // Thread history (design doc 5.5): earlier turns of this conversation as
  // real chat turns, and a running summary of turns older than those.
  // Both default to empty, so a call without them behaves exactly as before.
  priorMessages = [],
  conversationSummary = null,
  // Durable memory (design doc 5.6, appendix E): the formatted MEMORY
  // block, or null. It goes in the system prompt under its own heading,
  // away from the document context, so the citation code never sees it.
  memoryBlock = null,
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
  // Memory notes and the thread are material too: a question that no
  // document answers can still be answered from what the user told us
  // earlier, and the grounding rules decide whether it is. (Design doc
  // 5.4: history and recall still run when retrieval finds nothing.)
  const hasMemory =
    typeof memoryBlock === "string" && memoryBlock.trim().length > 0;
  const hasHistory =
    (Array.isArray(priorMessages) && priorMessages.length > 0) ||
    Boolean(conversationSummary && String(conversationSummary).trim());

  const synthesisEligible =
    hasContext ||
    hasMemory ||
    hasHistory ||
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

Executive audiences prefer concise, direct, and confident communication.
Favor implication density over exhaustive coverage.

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

GROUNDING (absolute):
- Your only sources are the material in this prompt: the numbered sources in the CONTEXT WINDOW, the MEMORY notes, the earlier turns of this conversation, and text the user pasted. You have no other knowledge for the purpose of answering.
- Reasoning about that material (explaining, weighing, comparing, summarising it) is grounded. Adding facts that are not in it is not. If nothing in the material bears on the question, reply that the documents don't cover it. This applies to well-known facts, public figures, companies, places, and fictional characters, and it applies even when the subject is named in a memory or an earlier turn. A memory that says who someone is does not tell you anything else about them.
`;

  const evidenceRules = `
EVIDENCE RULES:
- preserve source continuity
- avoid evidence monopolization
- preserve independently supported entities
- synthesize overlapping evidence into unified implications
- avoid unsupported enterprise escalation
`;

  // Design doc 8.3 (E1.6): authority is a label, not a score. Each layer
  // is named and the governing rule is stated in words.
  const authorityRules = `
AUTHORITY RULES:
- KNOWLEDGE (the numbered sources in the CONTEXT WINDOW) is curated institutional truth. CURRENT CONTEXT (the USER MESSAGE and any pasted or attached material) is the user's active task. MEMORY and the earlier conversation turns are continuity from earlier conversations.
- When two items agree or do not overlap, use both.
- When two items say different things about the same fact:
  - If both are KNOWLEDGE, prefer the one marked current or the newer version, and say which you used.
  - If the user states a fact in CURRENT CONTEXT and MEMORY or the earlier turns disagree, the user's statement wins.
  - If CURRENT CONTEXT (pasted or attached material) disagrees with KNOWLEDGE, do not treat the newer material as correct. Use the KNOWLEDGE value, and tell the user the two differ.
  - If MEMORY disagrees with KNOWLEDGE, prefer KNOWLEDGE and say so.
- Never cite MEMORY, earlier turns, or CURRENT CONTEXT with a source number.
- Nothing outside these layers is a source. Your own general knowledge is never a source, even for a subject that KNOWLEDGE, MEMORY or the conversation mentions.
`;

  const memorySection =
    typeof memoryBlock === "string" && memoryBlock.trim()
      ? `\n${memoryBlock.trim()}\n`
      : "";

  const structureRules = `
STRUCTURE RULES:
- use natural executive rhythm
- compress redundancy
- preserve strategic and operational hierarchy
- favor implication-rich synthesis
- preserve deliverable continuity
- prefer decisive executive conclusions over methodological explanation
- avoid fully expanding every supported dimension unless operationally necessary
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
${memorySection}
${evidenceRules}

${authorityRules}

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

CITATIONS:
- The CONTEXT WINDOW lists sources as numbered blocks like "[3] File — page 4 — Section".
- End every sentence that draws on a source with its number in square brackets, e.g. "... 13 credits [3]."
- Cite sparingly: at most two numbers per sentence, choosing the source that most directly supports the fact. When several consecutive sentences draw on the same source, cite it once at the end of that passage rather than after each sentence.
- For overviews and summaries, cite once per bullet or paragraph, at its end, with the one or two sources that best cover it. Do not cite every sentence.
- Use only numbers that appear in the CONTEXT WINDOW. Never invent a number. Do not add a references list.
- If the context has no numbered blocks, do not add citations.
- MEMORY notes (in the system prompt, if any) are things this user or workspace told Cortéx in earlier conversations. When the question is about one of them, answer from it plainly and without a source number, even if the documents say nothing about it. The documents' silence does not cancel a memory.
- A MEMORY note supports exactly what it states, read in either direction. "Brad is a friend of Chandler Bing" answers "who is Brad's friend" (Chandler Bing) and "who is Chandler Bing" (Brad's friend). "AST was brought to us by Tom Greer" answers "who told us about AST" and "who is Tom Greer" (the person who brought AST to us). It does not license anything beyond that relation: what else Chandler Bing is, does, or appears in is not stated, so it is not known.
- When the sources and a MEMORY note both say something about the subject, give both: the source facts with their numbers, the memory fact without one.
- If neither the sources nor the MEMORY notes state the answer, say so plainly ("The documents don't cover this.") and stop. Never answer from your own general knowledge, even for well-known facts, famous people, or fictional characters, and even when a memory or an earlier turn mentions the subject.

CONFLICTS:
- If two things you were given (numbered sources, MEMORY notes, earlier turns, or pasted material) disagree about the same fact, follow the AUTHORITY RULES, say so in the answer, and then add one final line in exactly this form: ${CONFLICT_OPEN}conflicts: one short sentence per conflict${CONFLICT_CLOSE}
- If nothing disagrees, do not add that line.

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

FINAL CHECK before you answer: every fact in your answer must come from the CONTEXT WINDOW, the MEMORY notes, the earlier turns, or the user's own message. Explaining, judging, comparing or summarising that material is answering from it, and a "why?" about an earlier answer is answered from the material behind that answer. Only when nothing in the material bears on the question, reply: "The documents don't cover this."
`.trim();

  // ============================================================
  // 🔥 OPENAI RESPONSE
  // ============================================================
  // Earlier turns go in as real chat turns between the system prompt and
  // the current request. They are continuity, not evidence: the model may
  // rely on them to understand a follow-up, but every cited fact must come
  // from the current CONTEXT WINDOW, and the [n] numbers inside earlier
  // assistant turns belonged to earlier context windows.
  const history = Array.isArray(priorMessages)
    ? priorMessages
        .filter(m => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .map(m => ({ role: m.role, content: String(m.content) }))
    : [];
  const historyNotes = [];
  if (conversationSummary && String(conversationSummary).trim()) {
    historyNotes.push(`EARLIER IN THIS CONVERSATION (a summary of turns not shown below):\n${String(conversationSummary).trim()}`);
  }
  if (history.length || historyNotes.length) {
    historyNotes.push(
      "The conversation turns that follow are this thread's recent history. Use them to resolve references like \"the second one\", \"it\", or \"that program\", and to keep continuity. " +
      "They are not evidence: cite only the numbered sources in the current CONTEXT WINDOW. Citation numbers inside earlier assistant turns referred to earlier sources and must not be reused. " +
      "The final USER MESSAGE is the one to answer."
    );
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...(historyNotes.length ? [{ role: "system", content: historyNotes.join("\n\n") }] : []),
    ...history,
    { role: "user", content: userPrompt },
  ];

  // Streaming: when the caller passes onToken, deltas are forwarded as they
  // arrive and the full text is still returned for formatting + citations.
  if (typeof onToken === "function") {
    const stream = await model.chat.completions.create({
      model: "gpt-5.1",
      messages,
      temperature: 0.08,
      stream: true,
    });
    // The trailing conflicts note (E1.7) is for the trace, not the reader:
    // once its opening bracket appears, nothing after it is forwarded.
    let text = "";
    let forwarded = 0;
    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        const cut = text.indexOf(CONFLICT_OPEN);
        const visible = cut >= 0 ? text.slice(0, cut) : text;
        if (visible.length > forwarded) {
          onToken(visible.slice(forwarded));
          forwarded = visible.length;
        }
      }
    }
    return text.trim() || "I need more information.";
  }

  const completion =
    await model.chat.completions.create({
      model: "gpt-5.1",
      messages,
      temperature: 0.08,
    });

  const output =
    completion.choices?.[0]?.message?.content?.trim() ||
    "I need more information.";

  return output;
}
