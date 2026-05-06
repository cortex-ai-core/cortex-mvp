// ============================================================
//  CORTÉX — OUTPUT FORMATTER
//  v1.5 OUTPUT QUALITY LAYER
//  Deterministic post-synthesis formatter
// ============================================================

const SECTION_HEADERS = [
  "Executive Decision",
  "Strategic Recommendation",
  "Recommendation",
  "Summary",
  "Key Findings",
  "Strengths",
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

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
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

function isCompleteThought(line = "") {
  const normalized = line.toLowerCase();

  return (
    normalized.includes(" ") &&
    /[a-z]/i.test(normalized) &&
    (
      normalized.includes(" is ") ||
      normalized.includes(" are ") ||
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
    if (normalized.length < 40) continue;
    if (isWeakLine(normalized)) continue;
    if (!hasSignalTerm(normalized)) continue;
    if (!isCompleteThought(normalized)) continue;
    if (lower === first || first.includes(lower) || lower.includes(first)) continue;
    if (isDuplicateBullet(normalized, bullets)) continue;

    bullets.push(ensureTerminalPeriod(normalized));

    if (bullets.length >= MAX_BULLETS) break;
  }

  // Fallback: if signal filtering was too strict, keep the best non-weak complete thoughts.
  if (!bullets.length) {
    for (const line of lines) {
      const normalized = line.trim();
      const lower = normalized.toLowerCase();

      if (!normalized) continue;
      if (normalized.length < 40) continue;
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

function firstSentence(text = "") {
  const cleaned = cleanMarkdownNoise(text);
  const match = cleaned.match(/[^.!?]+[.!?]/);

  if (match) return match[0].trim();

  return ensureTerminalPeriod(cleaned.slice(0, 240).trim());
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

// ------------------------------------------------------------
// Main formatter
// ------------------------------------------------------------
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

  // Preserve explicit missing-data responses.
  if (isMissingDataResponse(text)) {
    return text;
  }

  // Preserve short direct answers.
  if (isShortAnswer(text)) {
    return text;
  }

  const resumeRequest = isResumeOrCandidateRequest(userMessage);
  const incidentRequest = isIncidentRequest(userMessage);
  const strategyRequest = isStrategyRequest(userMessage, intent);
  const structured = hasExistingStructure(text);
  const overlong = isOverlong(text);

  // Preserve already-structured synthesis output only when it is not bloated.
  if (structured && !overlong) {
    return text;
  }

  // Candidate / resume / submittal formatting.
  if (resumeRequest) {
    return buildCompressedOutput({
      decisionLabel: "Recommendation",
      title: "Candidate Summary",
      raw: text,
      finalLabel: "Final Assessment"
    });
  }

  // Incident / operations formatting.
  if (incidentRequest) {
    return buildCompressedOutput({
      decisionLabel: "Executive Decision",
      title: "Operational Summary",
      raw: text,
      finalLabel: "Remediation Priority"
    });
  }

  // Strategy / advisory formatting.
  if (strategyRequest) {
    return buildCompressedOutput({
      decisionLabel: "Strategic Recommendation",
      title: "Supporting Analysis",
      raw: text,
      finalLabel: "Next Step"
    });
  }

  // Compress long structured/general outputs into Cortéx-style advisory format.
  if (structured || overlong) {
    return buildCompressedOutput({
      decisionLabel: "Summary",
      title: "Key Findings",
      raw: text,
      finalLabel: "Final Assessment"
    });
  }

  // General longer response formatting.
  return buildStructuredOutput({
    decisionLabel: "Summary",
    title: "Details",
    raw: text,
    finalLabel: "Final Assessment"
  });
}
