// ============================================================
//  CORTÉX — OUTPUT FORMATTER
//  v1.7.4 FINAL CANDIDATE NAME HARD CLEANER
//  Deterministic post-synthesis formatter
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
  "Remediation Priority"
];

const MAX_STRUCTURED_LENGTH = 2500;
const MAX_BULLETS = 6;

const SIGNAL_TERMS = [
  "risk",
  "governance",
  "audit",
  "auditable",
  "consistent",
  "consistency",
  "decision",
  "trust",
  "workflow",
  "compliance",
  "reliable",
  "reliability",
  "quality",
  "policy",
  "standard",
  "standardized",
  "oversight",
  "operational",
  "executive",
  "enterprise",
  "roi",
  "accuracy",
  "explainable",
  "explainability",
  "safe",
  "safety",
  "scalable",
  "scale"
];

function normalizeText(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasExistingStructure(text = "") {
  const normalized = text.toLowerCase();
  return SECTION_HEADERS.some(header => normalized.includes(header.toLowerCase()));
}

function isOverlong(text = "") {
  return text.length > MAX_STRUCTURED_LENGTH;
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

function isShortAnswer(text = "") {
  return text.length < 450;
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
    normalized.includes("submittal")
  );
}

function isCandidateDecisionRequest(userMessage = "", rawAnswer = "") {
  const normalizedMessage = userMessage.toLowerCase();
  const normalizedAnswer = rawAnswer.toLowerCase();

  const candidateSignals = [
    "resume",
    "candidate",
    "interview",
    "alignment score",
    "technical match",
    "culture fit",
    "submittal",
    "submit this person",
    "submit him",
    "submit her",
    "hire",
    "hiring",
    "job fit",
    "role fit",
    "recommendation on this profile",
    "recommend this profile"
  ];

  const recommendationSignals = [
    "recommend",
    "recommendation",
    "should we",
    "would you submit",
    "should i submit",
    "should we submit",
    "good fit",
    "fit for the role"
  ];

  const hasCandidateSignal = candidateSignals.some(term =>
    normalizedMessage.includes(term)
  );

  const hasRecommendationSignal = recommendationSignals.some(term =>
    normalizedMessage.includes(term)
  );

  const answerLooksCandidateRelated =
    normalizedAnswer.includes("candidate") ||
    normalizedAnswer.includes("resume") ||
    normalizedAnswer.includes("interview") ||
    normalizedAnswer.includes("experience") ||
    normalizedAnswer.includes("role") ||
    normalizedAnswer.includes("skills") ||
    normalizedAnswer.includes("service desk") ||
    normalizedAnswer.includes("support") ||
    normalizedAnswer.includes("healthcare");

  return hasCandidateSignal || (hasRecommendationSignal && answerLooksCandidateRelated);
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
    normalized.includes("tier 2")
  );
}

function isStrategyRequest(userMessage = "", intent = "") {
  const normalized = userMessage.toLowerCase();

  return (
    intent === "analysis" ||
    normalized.includes("strategy") ||
    normalized.includes("recommend") ||
    normalized.includes("should we") ||
    normalized.includes("decision") ||
    normalized.includes("roi") ||
    normalized.includes("business case") ||
    normalized.includes("launch")
  );
}

function ensureTerminalPeriod(text = "") {
  if (!text) return text;
  if (/[.!?]$/.test(text.trim())) return text.trim();
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
    .replace(/^of fit:\s*/i, "")
    .replace(/^fit:\s*/i, "")
    .replace(/^candidate summary:\s*/i, "")
    .replace(/^summary:\s*/i, "")
    .trim();
}

function splitFirstParagraph(text = "") {
  const parts = normalizeText(text).split(/\n\s*\n/);
  const first = parts.shift() || "";
  const rest = parts.join("\n\n").trim();

  return {
    first: first.trim(),
    rest
  };
}

function hasSignalTerm(text = "") {
  const normalized = text.toLowerCase();
  return SIGNAL_TERMS.some(term => normalized.includes(term));
}

function isWeakLine(line = "") {
  const normalized = line.toLowerCase().trim();

  return (
    !normalized ||
    normalized === "problem" ||
    normalized === "value of a quality layer" ||
    normalized === "impact on decision-making" ||
    normalized === "of fit" ||
    normalized.startsWith("below is") ||
    normalized.startsWith("for example") ||
    normalized.startsWith("examples include") ||
    normalized.startsWith("this means") ||
    normalized.startsWith("in other words") ||
    normalized.startsWith("base models") ||
    normalized.startsWith("llms") ||
    normalized.startsWith("raw ai") ||
    normalized.endsWith(":") ||
    normalized.endsWith(":.") ||
    normalized.includes("can:.") ||
    normalized.includes("etc.")
  );
}

function normalizeBulletLine(line = "") {
  return line
    .replace(/^[-•*\d.)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateBullet(candidate = "", existing = []) {
  const normalizedCandidate = candidate.toLowerCase();

  return existing.some(item => {
    const normalizedItem = item.toLowerCase();

    return (
      normalizedItem === normalizedCandidate ||
      normalizedItem.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedItem)
    );
  });
}

function isCandidateEvidenceLine(line = "") {
  const normalized = line.toLowerCase();

  return (
    normalized.includes("service desk") ||
    normalized.includes("tier 1") ||
    normalized.includes("tier 2") ||
    normalized.includes("access management") ||
    normalized.includes("healthcare") ||
    normalized.includes("hospital") ||
    normalized.includes("support") ||
    normalized.includes("tickets") ||
    normalized.includes("technical issues") ||
    normalized.includes("escalated") ||
    normalized.includes("lean") ||
    normalized.includes("process")
  );
}

function isCompleteThought(line = "") {
  const normalized = line.toLowerCase();

  return (
    normalized.includes(" ") &&
    /[a-z]/i.test(normalized) &&
    (
      normalized.includes(" is ") ||
      normalized.includes(" are ") ||
      normalized.includes(" has ") ||
      normalized.includes(" have ") ||
      normalized.includes(" worked ") ||
      normalized.includes(" managed ") ||
      normalized.includes(" handled ") ||
      normalized.includes(" resolved ") ||
      normalized.includes(" supported ") ||
      normalized.includes(" provided ") ||
      normalized.includes(" demonstrated ") ||
      normalized.includes(" enables ") ||
      normalized.includes(" ensures ") ||
      normalized.includes(" reduces ") ||
      normalized.includes(" improves ") ||
      normalized.includes(" allows ") ||
      normalized.includes(" provides ") ||
      normalized.includes(" creates ") ||
      normalized.includes(" turns ") ||
      normalized.includes(" supports ") ||
      normalized.includes(" prevents ") ||
      normalized.includes(" validates ") ||
      normalized.includes(" tracks ")
    )
  );
}

function firstSentence(text = "") {
  const cleaned = cleanMarkdownNoise(text);
  const match = cleaned.match(/[^.!?]+[.!?]/);

  if (match) return cleanSectionText(match[0].trim());

  return ensureTerminalPeriod(cleanSectionText(cleaned.slice(0, 240).trim()));
}

function extractUsefulBullets(text = "") {
  const cleaned = cleanMarkdownNoise(text);

  const lines = cleaned
    .split("\n")
    .map(line => normalizeBulletLine(line))
    .filter(Boolean);

  const bullets = [];
  const first = firstSentence(text).toLowerCase();

  for (const line of lines) {
    const normalized = line.trim();
    const lower = normalized.toLowerCase();

    if (!normalized) continue;
    if (normalized.length < 35) continue;
    if (isWeakLine(normalized)) continue;
    if (!hasSignalTerm(normalized) && !isCandidateEvidenceLine(normalized)) continue;
    if (!isCompleteThought(normalized)) continue;
    if (lower === first || first.includes(lower) || lower.includes(first)) continue;
    if (isDuplicateBullet(normalized, bullets)) continue;

    bullets.push(ensureTerminalPeriod(normalized));

    if (bullets.length >= MAX_BULLETS) break;
  }

  if (!bullets.length) {
    for (const line of lines) {
      const normalized = line.trim();
      const lower = normalized.toLowerCase();

      if (!normalized) continue;
      if (normalized.length < 35) continue;
      if (isWeakLine(normalized)) continue;
      if (!isCompleteThought(normalized)) continue;
      if (lower === first || first.includes(lower) || lower.includes(first)) continue;
      if (isDuplicateBullet(normalized, bullets)) continue;

      bullets.push(ensureTerminalPeriod(normalized));

      if (bullets.length >= 3) break;
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

  if (!match || !match[1]) return "";

  return cleanSectionText(match[1]);
}

function cleanCandidateName(name = "") {
  return String(name || "")
    .replace(/\b(and|for|with|the|a|an)\b.*$/i, "")
    .trim();
}

function extractCandidateName(userMessage = "", raw = "") {
  const combined = `${userMessage}\n${raw}`;

  const patterns = [
    /summarize\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /recommend(?:ation)?\s+(?:on|for)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /candidate name\s*:\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i,
    /primary entity\s*:\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i
  ];

  for (const pattern of patterns) {
    const match = combined.match(pattern);

    if (match && match[1]) {
      const candidate = cleanCandidateName(match[1]);

      if (candidate && !isBadNameMatch(candidate)) {
        return candidate;
      }
    }
  }

  const fallback = combined.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/);

  if (fallback && fallback[1]) {
    const candidate = cleanCandidateName(fallback[1]);

    if (candidate && !isBadNameMatch(candidate)) {
      return candidate;
    }
  }

  return "Not enough evidence provided.";
}

function isBadNameMatch(value = "") {
  const normalized = value.toLowerCase().trim();

  const badMatches = [
    "candidate name",
    "primary entity",
    "not enough",
    "service desk",
    "salem health",
    "salem academy",
    "christian school",
    "access management",
    "solution center"
  ];

  return badMatches.some(item => normalized.includes(item));
}

function toBullets(value = "", fallback = "Not enough evidence provided.") {
  const cleaned = cleanMarkdownNoise(value);

  if (!cleaned) return `- ${fallback}`;

  const lines = cleaned
    .split("\n")
    .map(line => normalizeBulletLine(line))
    .filter(Boolean)
    .filter(line => !isWeakLine(line));

  if (!lines.length) return `- ${fallback}`;

  return lines
    .slice(0, 5)
    .map(line => `- ${ensureTerminalPeriod(line)}`)
    .join("\n");
}

function selectStrengthBullets(cleaned = "") {
  const extracted = extractSection(cleaned, ["Key Strengths", "Strengths"]);
  if (extracted) return extracted;

  const filtered = extractUsefulBullets(cleaned)
    .filter(line => {
      const normalized = line.toLowerCase();

      return (
        !normalized.includes("recommend him") &&
        !normalized.includes("recommend her") &&
        !normalized.includes("recommend this") &&
        !normalized.includes("i recommend") &&
        !normalized.includes("should be considered") &&
        !normalized.includes("well-qualified")
      );
    })
    .slice(0, 4);

  if (filtered.length) return filtered.join("\n");

  const fallback = extractUsefulBullets(cleaned).slice(0, 3);
  if (fallback.length) return fallback.join("\n");

  return "Not enough evidence provided.";
}

function selectInterviewFocus(cleaned = "") {
  const extracted = extractSection(cleaned, ["Interview Focus", "Next Steps", "Action Plan"]);
  if (extracted) return extracted;

  const normalized = cleaned.toLowerCase();
  const focus = [];

  if (normalized.includes("access management")) {
    focus.push("Clarify depth of access management experience and systems used.");
  }

  if (normalized.includes("tier 2") || normalized.includes("tier 1")) {
    focus.push("Validate Tier 1 versus Tier 2 ownership and escalation judgment.");
  }

  if (normalized.includes("healthcare") || normalized.includes("hospital")) {
    focus.push("Confirm comfort supporting healthcare users in high-volume environments.");
  }

  if (normalized.includes("lean") || normalized.includes("process")) {
    focus.push("Ask for examples of process improvement or knowledge base contributions.");
  }

  if (!focus.length) return "Not enough evidence provided.";

  return focus.slice(0, 4).join("\n");
}

function buildCandidateDecisionOutput(raw = "", userMessage = "") {
  const cleaned = cleanMarkdownNoise(raw);

  const candidateName = extractCandidateName(userMessage, cleaned);

  const summary =
    extractSection(cleaned, ["Summary", "Candidate Summary"]) ||
    firstSentence(cleaned) ||
    "Not enough evidence provided.";

  const strengths = selectStrengthBullets(cleaned);

  const watchAreas =
    extractSection(cleaned, ["Watch Areas", "Gaps", "Risks"]) ||
    "No major watch areas identified from available context.";

  const recommendation =
    extractSection(cleaned, ["Recommendation", "Executive Decision", "Final Assessment"]) ||
    firstSentence(cleaned) ||
    "Not enough evidence provided.";

  const interviewFocus = selectInterviewFocus(cleaned);

  return `## Candidate Name
${candidateName}

## Summary
${ensureTerminalPeriod(cleanSectionText(summary))}

## Key Strengths
${toBullets(strengths)}

## Watch Areas
${toBullets(watchAreas, "No major watch areas identified from available context.")}

## Recommendation
${ensureTerminalPeriod(cleanSectionText(recommendation))}

## Interview Focus
${toBullets(interviewFocus)}`;
}

function buildCompressedOutput({
  decisionLabel = "Executive Decision",
  title = "Key Findings",
  raw = "",
  finalLabel = "Final Assessment",
  defaultDecision = ""
}) {
  const decision = defaultDecision || firstSentence(raw);
  const bullets = extractUsefulBullets(raw);

  const bulletText = bullets.length
    ? bullets.map(item => `- ${item}`).join("\n")
    : `- ${firstSentence(raw)}`;

  return `## ${decisionLabel}
${ensureTerminalPeriod(decision)}

## ${title}
${bulletText}

## ${finalLabel}
Use this as the current decision basis. Do not treat missing data as confirmed fact.`;
}

function buildStructuredOutput({
  title = "Summary",
  decisionLabel = "Executive Decision",
  raw = "",
  finalLabel = "Final Assessment"
}) {
  const { first, rest } = splitFirstParagraph(raw);

  const decision = ensureTerminalPeriod(first || raw);

  if (!rest) {
    return `## ${decisionLabel}\n${decision}`;
  }

  return `## ${decisionLabel}
${decision}

## ${title}
${rest}

## ${finalLabel}
Use the available information as the current decision basis. Do not treat missing data as confirmed fact.`;
}

export function formatOutput(rawAnswer = "", options = {}) {
  const {
    intent = "general",
    userMessage = "",
    hasContext = false,
    privateMode = false,
    namespace = "general",
    tone = "neutral"
  } = options || {};

  const text = normalizeText(rawAnswer);

  if (!text) {
    return "I need more information.";
  }

  if (isMissingDataResponse(text)) {
    return text;
  }

  const candidateDecisionRequest = isCandidateDecisionRequest(userMessage, text);

  if (candidateDecisionRequest) {
    return buildCandidateDecisionOutput(text, userMessage);
  }

  if (isShortAnswer(text)) {
    return text;
  }

  const resumeRequest = isResumeOrCandidateRequest(userMessage);
  const incidentRequest = isIncidentRequest(userMessage);
  const strategyRequest = isStrategyRequest(userMessage, intent);
  const structured = hasExistingStructure(text);
  const overlong = isOverlong(text);

  if (structured && !overlong) {
    return text;
  }

  if (resumeRequest) {
    return buildCompressedOutput({
      decisionLabel: "Recommendation",
      title: "Candidate Summary",
      raw: text,
      finalLabel: "Final Assessment"
    });
  }

  if (incidentRequest) {
    return buildCompressedOutput({
      decisionLabel: "Executive Decision",
      title: "Operational Summary",
      raw: text,
      finalLabel: "Remediation Priority"
    });
  }

  if (strategyRequest) {
    return buildCompressedOutput({
      decisionLabel: "Strategic Recommendation",
      title: "Supporting Analysis",
      raw: text,
      finalLabel: "Next Step"
    });
  }

  if (structured || overlong) {
    return buildCompressedOutput({
      decisionLabel: "Summary",
      title: "Key Findings",
      raw: text,
      finalLabel: "Final Assessment"
    });
  }

  return buildStructuredOutput({
    decisionLabel: "Summary",
    title: "Details",
    raw: text,
    finalLabel: "Final Assessment"
  });
}
