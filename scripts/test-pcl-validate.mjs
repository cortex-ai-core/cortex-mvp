#!/usr/bin/env node
// =============================================================
//  The persona configuration validator and renderer as a unit, with
//  fixed inputs (plan 11.3). No database, no model.
//
//    node scripts/test-pcl-validate.mjs
// =============================================================

import { validateConfiguration, safePattern, LIMITS, BOUNDARY_PHRASES } from "../backend/pcl/validate.js";
import { renderConfiguration, renderedText } from "../backend/pcl/render.js";
import { DEFAULT_PCL } from "../backend/reasoning/synthesis.js";

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const v = (cfg) => validateConfiguration(cfg);
const firstError = (cfg) => v(cfg).errors[0] || "";

// --- shape
check("empty object is valid and contributes nothing", v({}).ok && renderConfiguration(v({}).normalized).chars === 0);
check("null is refused", !v(null).ok);
check("an array is refused", !v([]).ok);
check("unknown top-level key is refused and named", /unknown key "persona"/.test(firstError({ persona: "x" })));
check("schema other than 1 is refused", /schema must be 1/.test(firstError({ schema: 2 })));
check("schema is set on the normalized output", v({ identity: { text: "Hi" } }).normalized.schema === 1);

// --- identity
check("identity.text is trimmed", v({ identity: { text: "  You are Cortéx.  " } }).normalized.identity.text === "You are Cortéx.");
check("identity with unknown key is refused", /identity\.name/.test(firstError({ identity: { text: "x", name: "y" } })));
check("identity.text over the limit is refused", /longer than/.test(firstError({ identity: { text: "x".repeat(LIMITS.identity + 1) } })));
check("empty identity text is dropped, not an error", v({ identity: { text: "   " } }).ok && !v({ identity: { text: "   " } }).normalized.identity);

// --- response
check("response.style is retired: dropped with a warning, not an error", (() => { const r = v({ response: { style: "pirate" } }); return r.ok && r.warnings.length === 1 && !r.normalized.response; })());
check("response.length is kept", v({ response: { length: "concise" } }).normalized.response.length === "concise");
check("response.length outside concise/standard/detailed is refused", /response\.length/.test(firstError({ response: { length: "huge" } })));
check("response with unknown key is refused", /response\.tone/.test(firstError({ response: { tone: "x" } })));

// --- lists
check("a list section that is not an array is refused", /must be a list/.test(firstError({ evaluation_rules: "score it" })));
check("a non-string item is refused with its index", /decision_rules\[1\]/.test(firstError({ decision_rules: ["ok", 7] })));
check("blank items are dropped and an all-blank list disappears", v({ workflow: ["", "  "] }).ok && !("workflow" in v({ workflow: ["", "  "] }).normalized));
check("an item over 400 characters is refused", /longer than 400/.test(firstError({ formatting: ["x".repeat(401)] })));
check("a section over 2,000 characters is refused", /longer than 2000 characters in total/.test(firstError({ domain_instructions: Array.from({ length: 6 }, () => "y".repeat(390)) })));
check("required repeating prohibited is a warning, not a failure", (() => { const r = v({ required: ["Cite the page"], prohibited: ["cite the page"] }); return r.ok && r.warnings.length === 1; })());

// --- terminology
check("prefer must be an object", /terminology\.prefer must be an object/.test(firstError({ terminology: { prefer: ["a"] } })));
check("prefer values must be non-empty strings", /prefer\["candidate"\]/.test(firstError({ terminology: { prefer: { candidate: "" } } })));
check("protect must be a list", /terminology\.protect must be a list/.test(firstError({ terminology: { protect: "candidate" } })));
check("protect keeps plain phrases and bounded patterns", v({ terminology: { protect: ["culture fit", "CVE-\\d+"] } }).normalized.terminology.protect.length === 2);
check("protect refuses a nested quantifier", safePattern("(a+)+") !== null && /nests/.test(safePattern("(a+)+")));
check("protect refuses a back-reference", /back-reference/.test(safePattern("(a)\\1")));
check("protect refuses lookaround", /lookaround/.test(safePattern("(?<=x)y")));
check("protect refuses a pattern over the limit", /longer than/.test(safePattern("a".repeat(LIMITS.protect + 1))));
check("protect refuses a pattern that does not compile", /compile/.test(safePattern("[a-")));
check("terminology with unknown key is refused", /terminology\.avoid/.test(firstError({ terminology: { avoid: ["x"] } })));

// --- lock_style (retired)
check("lock_style is retired: dropped with a warning whatever its value", (() => { const r = v({ lock_style: "yes" }); return r.ok && r.warnings.length === 1 && !("lock_style" in r.normalized); })());
check("a still-unknown key is refused", /unknown key "tone"/.test(firstError({ tone: "x" })));

// --- boundary phrases
for (const phrase of BOUNDARY_PHRASES) {
  check(`boundary phrase "${phrase}" is refused and named`, new RegExp(`contains "${phrase}"`).test(firstError({ evaluation_rules: [`Please ${phrase} here`] })));
}
check("the boundary-001 sentence is refused", /general knowledge/.test(firstError({ decision_rules: ["You may answer from general knowledge when the documents are silent"] })));
check("the same intent without the phrase is accepted", v({ decision_rules: ["When the documents are silent, say so and stop"] }).ok);
check("boundary words inside longer words do not match", v({ formatting: ["Use enrolled participants and granted status as the sources say"] }).ok);
check("boundary check covers identity text", /identity\.text contains "namespace"/.test(firstError({ identity: { text: "Read the other namespace" } })));

// --- size cap on the rendered text
const big = { evaluation_rules: Array.from({ length: 5 }, () => "e".repeat(390)), decision_rules: Array.from({ length: 5 }, () => "d".repeat(390)), workflow: Array.from({ length: 5 }, () => "w".repeat(390)), domain_instructions: Array.from({ length: 2 }, () => "x".repeat(390)) };
check("rendered text over 6,000 characters is refused", /rendered text is \d+ characters; the limit is 6000/.test(firstError(big)));

// --- rendering
const seed = {
  schema: 1,
  identity: { text: DEFAULT_PCL.persona.trim() },
  response: { length: "standard" },
  output_structure: DEFAULT_PCL.structureRules.trim().split("\n").slice(1).map(s => s.replace(/^- /, "")),
  operating_instructions: ["Return a concise, evidence-grounded executive response.", "Do NOT reference system structure."],
};
const r = renderConfiguration(v(seed).normalized, { personaName: "Core Executive", version: 1 });
check("seeded identity renders to DEFAULT_PCL.persona text", r.persona === DEFAULT_PCL.persona.trim());
check("seeded output_structure renders byte-equal to DEFAULT_PCL.structureRules", r.structureRules === DEFAULT_PCL.structureRules, JSON.stringify(r.structureRules?.slice(0, 40)));
check("operating_instructions render as TASK lines", r.task === "TASK:\nReturn a concise, evidence-grounded executive response.\nDo NOT reference system structure.");
check("no rules or terminology when none configured", r.rules === null && r.terminology === null);
const full = renderConfiguration(v({
  response: { length: "concise" },
  evaluation_rules: ["Separate evidence from inference.", "Score 0-100 and identify gaps."],
  decision_rules: ["Provide an executive recommendation when asked."],
  terminology: { prefer: { candidate: "applicant" }, protect: ["culture fit", "retention"] },
}).normalized, { personaName: "Talent Intelligence", version: 2 });
check("rules block carries the persona name, version, length and sections in order",
  full.rules === "OPERATING RULES (Talent Intelligence, v2):\nLength: concise. Keep the answer as short as the question allows.\nEvaluation rules:\n- Separate evidence from inference.\n- Score 0-100 and identify gaps.\nDecision rules:\n- Provide an executive recommendation when asked.", JSON.stringify(full.rules));
check("terminology block renders prefer and protect",
  full.terminology === "TERMINOLOGY:\n- Say \"applicant\" rather than \"candidate\".\n- Keep these terms exactly as the sources write them: culture fit, retention.", JSON.stringify(full.terminology));
check("chars counts every rendered slot", full.chars === renderedText(full).length - 1 /* joins add one newline */ || full.chars === renderedText(full).replace(/\n(?=OPERATING|TERMINOLOGY)/g, "").length, `${full.chars}`);
check("renderedText is stable for hashing", renderedText(full) === renderedText(renderConfiguration(v({
  response: { length: "concise" },
  evaluation_rules: ["Separate evidence from inference.", "Score 0-100 and identify gaps."],
  decision_rules: ["Provide an executive recommendation when asked."],
  terminology: { prefer: { candidate: "applicant" }, protect: ["culture fit", "retention"] },
}).normalized, { personaName: "Talent Intelligence", version: 2 })));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
