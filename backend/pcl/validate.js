// =============================================================
//  Persona configuration validation (customer spec section 4.4;
//  plan section 6). Deterministic, no model call, runs on every save
//  and again on every read, so a stored row that no longer validates
//  falls back to the built-in default instead of reaching the prompt.
//
//  The platform defines the container; the content is the client's.
//  Section names follow the spec's own vocabulary (section 43).
// =============================================================

import { renderConfiguration } from "./render.js";

export const SCHEMA_VERSION = 1;

/** List sections, in the order they render. */
export const LIST_SECTIONS = Object.freeze([
  "operating_instructions",
  "evaluation_rules",
  "evidence_requirements",
  "decision_rules",
  "formatting",
  "output_structure",
  "workflow",
  "domain_instructions",
  "required",
  "prohibited",
]);

export const ALLOWED_KEYS = Object.freeze(new Set([
  "schema", "identity", "response", "terminology", ...LIST_SECTIONS,
]));

// Keys from before response style was retired (migration 0012). A stored
// or pasted configuration that still carries them is accepted with a
// warning and the key dropped, so an old row never blocks a persona.
const LEGACY_KEYS = Object.freeze(new Set(["lock_style"]));

export const LENGTHS = Object.freeze(new Set(["concise", "standard", "detailed"]));

export const LIMITS = Object.freeze({
  item: 400,          // characters per list item
  section: 2000,      // characters per list section
  identity: 2000,     // characters of identity text
  protect: 60,        // characters per protect pattern
  prefer: 100,        // characters per prefer key or value
  rendered: 6000,     // characters of everything the persona adds to the prompt
});

// Phrases that try to cross the boundary between presentation and
// evidence (plan 6). A courtesy check for authors, named in the error;
// the real boundary is that CORE outranks the block regardless.
export const BOUNDARY_PHRASES = Object.freeze([
  "ignore the sources",
  "outside knowledge",
  "general knowledge",
  "even if the documents",
  "grant",
  "namespace",
  "role",
]);
const BOUNDARY_RE = new RegExp(`\\b(${BOUNDARY_PHRASES.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A protect pattern is a plain phrase or a small bounded regex: at most
 * LIMITS.protect characters, compiles, no back-references, no lookaround,
 * no quantifier applied to a quantified group (the shapes that can run
 * away on long input).
 */
export function safePattern(p) {
  if (typeof p !== "string") return "must be a string";
  const s = p.trim();
  if (!s) return "is empty";
  if (s.length > LIMITS.protect) return `is longer than ${LIMITS.protect} characters`;
  if (/\\[1-9]/.test(s)) return "uses a back-reference";
  if (/\(\?(?!:)/.test(s)) return "uses lookaround or a named group";
  if (/[+*?}]\)?[+*{]/.test(s)) return "nests one quantifier inside another";
  try { new RegExp(s, "i"); } catch { return "does not compile as a pattern"; }
  return null;
}

function boundaryHit(text) {
  const m = BOUNDARY_RE.exec(String(text || ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Validate a configuration object. Returns { ok, errors, warnings,
 * normalized }. `normalized` is what gets stored: trimmed strings, empty
 * items and sections dropped, schema set. Never throws.
 */
export function validateConfiguration(input) {
  const errors = [];
  const warnings = [];
  const out = { schema: SCHEMA_VERSION };

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["configuration must be a JSON object"], warnings, normalized: null };
  }
  for (const key of Object.keys(input)) {
    if (LEGACY_KEYS.has(key)) warnings.push(`"${key}" is no longer used and was dropped`);
    else if (!ALLOWED_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }
  if (input.schema !== undefined && input.schema !== SCHEMA_VERSION) {
    errors.push(`schema must be ${SCHEMA_VERSION}`);
  }

  // identity
  if (input.identity !== undefined) {
    if (!isPlainObject(input.identity)) errors.push("identity must be an object with a text field");
    else {
      for (const k of Object.keys(input.identity)) if (k !== "text") errors.push(`unknown key "identity.${k}"`);
      const text = input.identity.text;
      if (text !== undefined) {
        if (typeof text !== "string") errors.push("identity.text must be a string");
        else {
          const t = text.trim();
          if (t.length > LIMITS.identity) errors.push(`identity.text is longer than ${LIMITS.identity} characters`);
          const hit = boundaryHit(t);
          if (hit) errors.push(`identity.text contains "${hit}", which crosses the boundary between presentation and evidence`);
          if (t) out.identity = { text: t };
        }
      }
    }
  }

  // response
  if (input.response !== undefined) {
    if (!isPlainObject(input.response)) errors.push("response must be an object");
    else {
      const r = {};
      for (const k of Object.keys(input.response)) {
        if (k === "style") {
          warnings.push(`"response.style" is no longer used and was dropped; the identity text says how the persona sounds`);
        } else if (k === "length") {
          if (!LENGTHS.has(input.response.length)) errors.push(`response.length must be one of ${[...LENGTHS].join(", ")}`);
          else r.length = input.response.length;
        } else errors.push(`unknown key "response.${k}"`);
      }
      if (Object.keys(r).length) out.response = r;
    }
  }

  // list sections
  for (const section of LIST_SECTIONS) {
    const v = input[section];
    if (v === undefined) continue;
    if (!Array.isArray(v)) { errors.push(`${section} must be a list of strings`); continue; }
    const items = [];
    let total = 0;
    v.forEach((item, i) => {
      if (typeof item !== "string") { errors.push(`${section}[${i}] must be a string`); return; }
      const t = item.trim();
      if (!t) return;
      if (t.length > LIMITS.item) errors.push(`${section}[${i}] is longer than ${LIMITS.item} characters`);
      const hit = boundaryHit(t);
      if (hit) errors.push(`${section}[${i}] contains "${hit}", which crosses the boundary between presentation and evidence`);
      total += t.length;
      items.push(t);
    });
    if (total > LIMITS.section) errors.push(`${section} is longer than ${LIMITS.section} characters in total`);
    if (items.length) out[section] = items;
  }

  // terminology
  if (input.terminology !== undefined) {
    if (!isPlainObject(input.terminology)) errors.push("terminology must be an object");
    else {
      const term = {};
      for (const k of Object.keys(input.terminology)) {
        if (k === "prefer") {
          const prefer = input.terminology.prefer;
          if (!isPlainObject(prefer)) { errors.push("terminology.prefer must be an object of term: preferred term"); continue; }
          const map = {};
          for (const [from, to] of Object.entries(prefer)) {
            const f = String(from).trim();
            if (typeof to !== "string" || !to.trim()) { errors.push(`terminology.prefer["${f}"] must be a non-empty string`); continue; }
            const t = to.trim();
            if (f.length > LIMITS.prefer || t.length > LIMITS.prefer) errors.push(`terminology.prefer["${f}"] is longer than ${LIMITS.prefer} characters`);
            const hit = boundaryHit(`${f} ${t}`);
            if (hit) errors.push(`terminology.prefer["${f}"] contains "${hit}", which crosses the boundary between presentation and evidence`);
            if (f) map[f] = t;
          }
          if (Object.keys(map).length) term.prefer = map;
        } else if (k === "protect") {
          const protect = input.terminology.protect;
          if (!Array.isArray(protect)) { errors.push("terminology.protect must be a list of phrases or bounded patterns"); continue; }
          const list = [];
          protect.forEach((p, i) => {
            const why = safePattern(p);
            if (why) errors.push(`terminology.protect[${i}] ${why}`);
            else list.push(String(p).trim());
          });
          if (list.length) term.protect = list;
        } else errors.push(`unknown key "terminology.${k}"`);
      }
      if (Object.keys(term).length) out.terminology = term;
    }
  }

  // required repeating prohibited: a warning for the editor, not a failure
  if (out.required && out.prohibited) {
    const banned = new Set(out.prohibited.map(s => s.toLowerCase()));
    for (const r of out.required) if (banned.has(r.toLowerCase())) warnings.push(`"${r}" is both required and prohibited`);
  }

  // size of everything the persona adds to the prompt
  if (!errors.length) {
    const rendered = renderConfiguration(out, { personaName: "persona", version: 1 });
    if (rendered.chars > LIMITS.rendered) errors.push(`rendered text is ${rendered.chars} characters; the limit is ${LIMITS.rendered}`);
  }

  return { ok: errors.length === 0, errors, warnings, normalized: errors.length ? null : out };
}
