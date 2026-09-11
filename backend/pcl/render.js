// =============================================================
//  Persona configuration → prompt blocks (plan 8.2). Pure text; no
//  model, no database. Each slot is null when the configuration says
//  nothing about it, and synthesis.js then uses its built-in default,
//  so an empty configuration renders exactly today's prompt.
//
//    persona          identity text (replaces DEFAULT_PCL.persona)
//    structureRules   from output_structure, in DEFAULT_PCL's format
//    task             from operating_instructions
//    rules            OPERATING RULES: the other list sections and length
//    terminology      TERMINOLOGY: prefer and protect
//    chars            total characters the persona adds to the prompt
// =============================================================

const RULE_SECTIONS = [
  ["evaluation_rules",      "Evaluation rules:"],
  ["evidence_requirements", "Evidence requirements:"],
  ["decision_rules",        "Decision rules:"],
  ["workflow",              "Workflow:"],
  ["domain_instructions",   "Domain instructions:"],
  ["formatting",            "Formatting:"],
  ["required",              "Include in every answer:"],
  ["prohibited",            "Never:"],
];

const LENGTH_TEXT = {
  concise:  "Length: concise. Keep the answer as short as the question allows.",
  standard: null,
  detailed: "Length: detailed. Give a full answer with its supporting detail.",
};

const bullets = (items) => items.map(i => `- ${i}`).join("\n");

export function renderConfiguration(config, { personaName = "persona", version = null } = {}) {
  const c = config && typeof config === "object" ? config : {};

  const persona = c.identity?.text ? String(c.identity.text).trim() : null;

  // Same shape as DEFAULT_PCL.structureRules: leading and trailing newline.
  const structureRules = Array.isArray(c.output_structure) && c.output_structure.length
    ? `\nSTRUCTURE RULES:\n${bullets(c.output_structure)}\n`
    : null;

  const task = Array.isArray(c.operating_instructions) && c.operating_instructions.length
    ? `TASK:\n${c.operating_instructions.join("\n")}`
    : null;

  const ruleLines = [];
  const lengthLine = c.response?.length ? LENGTH_TEXT[c.response.length] : null;
  if (lengthLine) ruleLines.push(lengthLine);
  for (const [key, heading] of RULE_SECTIONS) {
    if (Array.isArray(c[key]) && c[key].length) ruleLines.push(`${heading}\n${bullets(c[key])}`);
  }
  const label = version ? `${personaName}, v${version}` : personaName;
  const rules = ruleLines.length ? `OPERATING RULES (${label}):\n${ruleLines.join("\n")}` : null;

  const termLines = [];
  if (c.terminology?.prefer && typeof c.terminology.prefer === "object") {
    for (const [from, to] of Object.entries(c.terminology.prefer)) termLines.push(`- Say "${to}" rather than "${from}".`);
  }
  if (Array.isArray(c.terminology?.protect) && c.terminology.protect.length) {
    termLines.push(`- Keep these terms exactly as the sources write them: ${c.terminology.protect.join(", ")}.`);
  }
  const terminology = termLines.length ? `TERMINOLOGY:\n${termLines.join("\n")}` : null;

  const chars = [persona, structureRules, task, rules, terminology].reduce((n, s) => n + (s ? s.length : 0), 0);

  return { persona, structureRules, task, rules, terminology, chars };
}

/** The persona-derived text as one string, for hashing and size checks. */
export function renderedText(rendered) {
  if (!rendered) return "";
  return [rendered.persona, rendered.structureRules, rendered.task, rendered.rules, rendered.terminology]
    .filter(Boolean).join("\n");
}
