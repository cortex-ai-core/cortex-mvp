// ============================================================
//  CORTÉX — OUTPUT FORMATTER
//  v1.7.15 STABILIZATION PATCH
//  Lightweight post-synthesis formatter
// ============================================================

const SECTION_HEADERS = [
  "Executive Decision",
  "Strategic Recommendation",
  "Recommendation",
  "Summary",
  "Key Findings",
  "Strengths",
  "Key Strengths",
  "Watch Areas",
  "Gaps",
  "Risks",
  "Action Plan",
  "Next Steps",
  "Final Assessment",
  "Root Cause",
  "Impact",
  "Remediation",
  "Supporting Analysis",
  "Operational Summary",
  "Candidate Summary",
  "Candidate Name",
  "Interview Focus",
  "Remediation Priority",
  "Executive Summary",
  "Operational Analysis"
];

const MAX_BULLETS = 6;

const SIGNAL_TERMS = [
  "risk",
  "governance",
  "audit",
  "workflow",
  "compliance",
  "quality",
  "operational",
  "operations",
  "executive",
  "enterprise",
  "analytics",
  "analysis",
  "reporting",
  "dashboard",
  "data",
  "epic",
  "ehr"
];

function normalizeText(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasExistingStructure(text = "") {
  const normalized = text.toLowerCase();

  return SECTION_HEADERS.some(header =>
    normalized.includes(header.toLowerCase())
  );
}

function isMissingDataResponse(text = "") {
  const normalized = text.toLowerCase();

  return (
    normalized.includes("no matching documents found") ||
    normalized.includes("i need more information") ||
    normalized.includes("not enough information") ||
    normalized.includes("insufficient information") ||
    normalized.includes("missing information") ||
    normalized.includes("unable to determine")
  );
}

function isRewriteRequest(userMessage = "") {
  const normalized = userMessage.toLowerCase();

  return (
    normalized.includes("rewrite") ||
    normalized.includes("restructure") ||
    normalized.includes("redraft") ||
    normalized.includes("revise") ||
    normalized.includes("clean this up") ||
    normalized.includes("make this professional") ||
    normalized.includes("improve this") ||
    normalized.includes("refine this") ||
    normalized.includes("update this") ||
    normalized.includes("rework this") ||
    normalized.includes("edit this") ||
    normalized.includes("polish this")
  );
}

function isResumeOrCandidateRequest(userMessage = "") {
  const normalized = userMessage.toLowerCase();

  return (
    normalized.includes("resume") ||
    normalized.includes("candidate") ||
    normalized.includes("interview") ||
    normalized.includes("alignment score") ||
    normalized.includes("technical match") ||
    normalized.includes("culture fit") ||
    normalized.includes("submittal") ||
    normalized.includes("job fit") ||
    normalized.includes("role fit") ||
    normalized.includes("hire") ||
    normalized.includes("hiring")
  );
}

function isIncidentRequest(userMessage = "") {
  const normalized = userMessage.toLowerCase();

  return (
    normalized.includes("incident") ||
    normalized.includes("outage") ||
    normalized.includes("root cause") ||
    normalized.includes("remediation") ||
    normalized.includes("impacted systems") ||
    normalized.includes("network issue") ||
    normalized.includes("escalation") ||
    normalized.includes("sev") ||
    normalized.includes("severity") ||
    normalized.includes("disruption")
  );
}

function ensureTerminalPeriod(text = "") {
  if (!text) return text;

  if (/[.!?]$/.test(text.trim())) {
    return text.trim();
  }

  return `${text.trim()}.`;
}

function cleanMarkdownNoise(text = "") {
  return normalizeText(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/---+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanSectionText(text = "") {
  return cleanMarkdownNoise(text)
    .replace(/^summary:\s*/i, "")
    .trim();
}

function normalizeBulletLine(line = "") {
  return line
    .replace(/^[-•*\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text = "") {
  const cleaned = cleanMarkdownNoise(text);

  const match = cleaned.match(/[^.!?]+[.!?]/);

  if (match) {
    return cleanSectionText(match[0].trim());
  }

  return ensureTerminalPeriod(
    cleanSectionText(cleaned.slice(0, 240).trim())
  );
}

function sentenceList(text = "") {
  return cleanMarkdownNoise(text)
    .split(/(?<=[.!?])\s+/)
    .map(sentence => cleanSectionText(sentence))
    .filter(Boolean);
}

function hasSignalTerm(text = "") {
  const normalized = text.toLowerCase();

  return SIGNAL_TERMS.some(term =>
    normalized.includes(term)
  );
}

function extractUsefulBullets(text = "") {
  const cleaned = cleanMarkdownNoise(text);

  const lines = cleaned
    .split("\n")
    .map(line => normalizeBulletLine(line))
    .filter(Boolean);

  const bullets = [];

  for (const line of lines) {
    if (line.length < 25) continue;

    if (
      hasSignalTerm(line) ||
      line.includes("supported") ||
      line.includes("managed") ||
      line.includes("resolved") ||
      line.includes("implemented") ||
      line.includes("experience")
    ) {
      bullets.push(
        ensureTerminalPeriod(line)
      );
    }

    if (bullets.length >= MAX_BULLETS) {
      break;
    }
  }

  if (!bullets.length) {
    const sentences = sentenceList(cleaned);

    for (const sentence of sentences) {
      if (sentence.length < 25) continue;

      bullets.push(
        ensureTerminalPeriod(sentence)
      );

      if (bullets.length >= 4) {
        break;
      }
    }
  }

  return bullets;
}

function extractSection(text = "", labels = []) {
  const cleaned = cleanMarkdownNoise(text);

  const escapedLabels = labels.map(label =>
    label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );

  const escapedSectionHeaders = SECTION_HEADERS.map(header =>
    header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );

  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:${escapedLabels.join("|")})\\s*:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${escapedSectionHeaders.join("|")})\\s*:?\\s*\\n|$)`,
    "i"
  );

  const match = cleaned.match(pattern);

  if (!match || !match[1]) {
    return "";
  }

  return cleanSectionText(match[1]);
}

function cleanCandidateName(name = "") {
  return String(name || "")
    .replace(/\b(and|for|with|the|a|an)\b.*$/i, "")
    .trim();
}

function isBadNameMatch(value = "") {
  const normalized = value.toLowerCase().trim();

  const badMatches = [
    "candidate name",
    "primary entity",
    "not enough",
    "service desk",
    "salem health",
    "access management"
  ];

  return badMatches.some(item =>
    normalized.includes(item)
  );
}

function extractCandidateName(userMessage = "", raw = "") {
  const combined = `${userMessage}\n${raw}`;

  const patterns = [
    /summarize\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /candidate name\s*:\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /^([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:is|has)\b/m
  ];

  for (const pattern of patterns) {
    const match = combined.match(pattern);

    if (match && match[1]) {
      const candidate = cleanCandidateName(match[1]);

      if (!isBadNameMatch(candidate)) {
        return candidate;
      }
    }
  }

  const fallback =
    String(userMessage || "")
      .match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/);

  if (fallback && fallback[1]) {
    const candidate = cleanCandidateName(fallback[1]);

    if (!isBadNameMatch(candidate)) {
      return candidate;
    }
  }

  return "Not enough evidence provided.";
}

function toBullets(
  value = "",
  fallback = "Not enough evidence provided."
) {
  const cleaned = cleanMarkdownNoise(value);

  if (!cleaned) {
    return `- ${fallback}`;
  }

  const lines = cleaned
    .split("\n")
    .map(line => normalizeBulletLine(line))
    .filter(Boolean);

  if (!lines.length) {
    return `- ${fallback}`;
  }

  return lines
    .slice(0, 6)
    .map(line => `- ${ensureTerminalPeriod(line)}`)
    .join("\n");
}

function buildCandidateDecisionOutput(
  raw = "",
  userMessage = ""
) {
  const cleaned = cleanMarkdownNoise(raw);

  const candidateName =
    extractCandidateName(
      userMessage,
      cleaned
    );

  // ========================================================
  // 🔥 MISSING CONTEXT HANDLING
  // ========================================================
  const normalized = cleaned.toLowerCase();

  const missingContext =
    normalized.includes("i don’t have") ||
    normalized.includes("i don't have") ||
    normalized.includes("i don’t see") ||
    normalized.includes("i don't see") ||
    normalized.includes("no resume content") ||
    normalized.includes("unable to summarize") ||
    normalized.includes("can't generate an accurate summary") ||
    normalized.includes("cannot generate an accurate summary");

  if (missingContext) {
    return `## Candidate Name
${candidateName}

## Status
No resume content was found in the available context.

Please provide:
- Resume text
- Uploaded resume
- Supporting candidate documents

Then Cortéx can:
- Summarize experience
- Identify strengths
- Assess alignment
- Professionally enhance the resume`;
  }

  const summary =
    extractSection(cleaned, [
      "Summary",
      "Candidate Summary"
    ]) ||
    firstSentence(cleaned) ||
    "Not enough evidence provided.";

  const strengths =
    extractUsefulBullets(cleaned)
      .slice(0, 5)
      .join("\n") ||
    "Not enough evidence provided.";

  const watchAreas =
    extractSection(cleaned, [
      "Watch Areas",
      "Gaps",
      "Risks"
    ]) ||
    "No major watch areas identified from available context.";

  const recommendation =
    extractSection(cleaned, [
      "Recommendation",
      "Executive Decision",
      "Final Assessment"
    ]) ||
    firstSentence(cleaned) ||
    "Not enough evidence provided.";

  return `## Candidate Name
${candidateName}

## Summary
${ensureTerminalPeriod(cleanSectionText(summary))}

## Key Strengths
${toBullets(strengths)}

## Watch Areas
${toBullets(
  watchAreas,
  "No major watch areas identified from available context."
)}

## Recommendation
${ensureTerminalPeriod(cleanSectionText(recommendation))}`;
}

function buildCompressedOutput({
  decisionLabel = "Executive Summary",
  title = "Analysis",
  raw = "",
  finalLabel = "Next Step"
}) {
  const decision = firstSentence(raw);

  const bullets = extractUsefulBullets(raw);

  const bulletText = bullets.length
    ? bullets.map(item => `- ${item}`).join("\n")
    : `- ${firstSentence(raw)}`;

  return `## ${decisionLabel}
${ensureTerminalPeriod(decision)}

## ${title}
${bulletText}

## ${finalLabel}
Use this as the current operational understanding.`;
}

export function formatOutput(rawAnswer = "", options = {}) {
  const {
    intent = "general",
    userMessage = ""
  } = options || {};

  const text = normalizeText(rawAnswer);

  // ------------------------------------------------
  // Empty response guard
  // ------------------------------------------------
  if (!text) {
    return "I need more information.";
  }

  // ------------------------------------------------
  // Preserve missing-data responses
  // ------------------------------------------------
  if (isMissingDataResponse(text)) {
    return text;
  }

  // ------------------------------------------------
  // Preserve rewrites EXACTLY
  // ------------------------------------------------
  if (isRewriteRequest(userMessage)) {
    return text;
  }

  // ------------------------------------------------
  // Candidate mode
  // ONLY from explicit USER intent
  // ------------------------------------------------
  if (isResumeOrCandidateRequest(userMessage)) {
    return buildCandidateDecisionOutput(
      text,
      userMessage
    );
  }

  // ------------------------------------------------
  // Incident mode
  // ------------------------------------------------
  if (isIncidentRequest(userMessage)) {
    return buildCompressedOutput({
      decisionLabel: "Executive Summary",
      title: "Operational Analysis",
      raw: text,
      finalLabel: "Recommended Next Step"
    });
  }

  // ------------------------------------------------
  // Analysis mode
  // ------------------------------------------------
  const analysisRequest =
    intent === "analysis" ||
    /analyze|analysis|assess|evaluate|compare|review|breakdown|explain why/i.test(
      userMessage
    );

  if (analysisRequest) {
    return buildCompressedOutput({
      decisionLabel: "Summary",
      title: "Analysis",
      raw: text,
      finalLabel: "Next Step"
    });
  }

  // ------------------------------------------------
  // Preserve already-structured responses
  // ------------------------------------------------
  if (hasExistingStructure(text)) {
    return text;
  }

  // ------------------------------------------------
  // DEFAULT:
  // preserve raw model intelligence
  // ------------------------------------------------
  return text;
}
