// ============================================================
//  CORTÉX — INTENT MODULE
//
//  One classification per message, up front, that every later stage
//  reads instead of matching phrases itself:
//
//    type      what the user wants done
//    scope     what material the answer should draw on — this is
//              what selects the answer mode (one document, the whole
//              knowledge base, a topic search, attached files, nothing)
//    maturity  how finished the output should be
//
//  The classification comes from a small model with a strict JSON
//  schema (INTENT_MODEL). If the call fails, times out, or INTENT_MODE
//  is "rules", the keyword decoder below answers instead, so chat
//  never waits on or breaks because of this step. Results are cached
//  briefly per message.
//
//  Design doc 8.8 (E5): the decoder starts working, retrieval priority
//  consults it first, and the vocabulary lists become defaults that
//  the Persona/PCL work can later make configurable.
// ============================================================

export const INTENT_TYPES = [
  "question", "lookup", "summary", "analysis", "compare", "draft",
  "rewrite", "communication", "instruction", "remember", "general", "literal",
];
export const INTENT_SCOPES = ["none", "attached", "document", "documents", "topic", "knowledge_base"];
export const INTENT_MATURITY = ["exploratory", "refinement", "deployable", "general", "locked"];

const INTENT_MODEL = process.env.INTENT_MODEL || "gpt-5-mini";
const INTENT_MODE = (process.env.INTENT_MODE || "model").toLowerCase();   // model | rules
const INTENT_TIMEOUT_MS = Number(process.env.INTENT_TIMEOUT_MS || 4000);
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;
const cache = new Map();   // key -> { at, intent }

const SCHEMA = {
  name: "cortex_intent",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["type", "scope", "maturity", "needs_evidence", "literal", "document_hints", "standalone_query", "remember_content", "remember_kind"],
    properties: {
      standalone_query: { type: "string" },
      remember_content: { type: "string" },
      remember_kind: { type: "string", enum: ["fact", "preference", "decision", "entity", "task", "note", "none"] },
      type: { type: "string", enum: INTENT_TYPES },
      scope: { type: "string", enum: INTENT_SCOPES },
      maturity: { type: "string", enum: ["exploratory", "refinement", "deployable", "general"] },
      needs_evidence: { type: "boolean" },
      literal: { type: "boolean" },
      document_hints: { type: "array", items: { type: "string" }, maxItems: 5 },
    },
  },
};

const SYSTEM = `You classify one user message sent to Cortéx, an assistant that answers from an organization's uploaded documents (its "knowledge base"), from files the user attaches to the message, and from earlier conversation. Return JSON only.

standalone_query — the message rewritten so it can be understood with no conversation history: resolve pronouns and references ("it", "its", "that program", "the second one", "why?") using the PREVIOUS TURN and the DOCUMENTS CITED that may be supplied. Name the document when the reference is to one. Keep the user's wording otherwise. When the message already stands alone, or there is no context, return it unchanged. Classify type and scope for this standalone form.

type — what the user wants done:
- question: asks about a fact, detail, or explanation
- lookup: asks to find or locate something specific (a number, a name, a date, a code)
- summary: asks for a summary, overview, key points, or table of contents
- analysis: asks for assessment, evaluation, implications, risks, recommendations
- compare: asks to compare or contrast two or more things
- draft: asks to write new material (brief, memo, report, plan, proposal, outline)
- rewrite: asks to revise, polish, shorten, or restructure text the user supplies
- communication: asks to write an email, message, or reply to someone
- instruction: asks how to do something, step by step
- remember: asks the assistant to remember or note a fact or preference for later
- general: greeting, small talk, meta questions about the assistant, anything else
- literal: asks for text to be repeated exactly as given

scope — what material the answer should draw on:
- document: one particular document as a whole (its overview, summary, structure, what it covers). Also use this when the message names one specific file and asks about it broadly.
- documents: two or more particular, named documents
- knowledge_base: only when the user explicitly refers to the collection as a whole ("the knowledge base", "all our documents", "everything we have", "across the corpus", "what have we uploaded") or asks for a deliverable that must survey the whole collection (an executive brief "from the knowledge base", an inventory of what exists). A specific factual question is never knowledge_base, even when it names no document.
- topic: a specific subject, fact, figure, program, person or event to be found by searching the documents. This is the default for factual questions and lookups.
- attached: only the text the user attached or pasted with this message
- none: no documents needed (greeting, small talk, a question about the assistant, a rewrite of supplied text)

maturity: exploratory (ideas, outline, brainstorm), refinement (revise, improve), deployable (final, ready to send), general (unspecified).
needs_evidence: true when a good answer must be grounded in documents rather than general knowledge.
literal: true only when the user asks for text to be repeated verbatim.
document_hints: file names or document titles the message mentions, verbatim, at most five, else [].
remember_content: only when type is "remember": the fact, preference or decision to keep, rewritten as one standalone note in the third person about the user or their workspace, at most 300 characters, without "remember that". Otherwise "".
remember_kind: only when type is "remember": fact, preference, decision, entity, task or note. Otherwise "none".

Examples:
"How many credits does the teacher education program require?" → lookup / topic
"What do we have on the internship program?" → question / topic
"Summarize the Operations Playbook" → summary / document
"Compare Brad's resume against the internship job description" → compare / documents
"Draft a one-page executive brief from the current knowledge base" → draft / knowledge_base
"Give me an overview of everything we have uploaded" → summary / knowledge_base
"Rewrite this to sound more formal: ..." → rewrite / none
"thanks, that's all" → general / none
"Remember that our fiscal year starts July 1" → remember / none, remember_content "The user's organization's fiscal year starts July 1.", remember_kind fact
"Please keep answers short, bullets only" → remember / none, remember_content "Prefers short answers as bullet lists.", remember_kind preference
With PREVIOUS TURN "What does the Operations Playbook cover?" and DOCUMENTS CITED "Operations Playbook.docx": "Give me its three most important points as bullets" → standalone_query "Give me the three most important points of the Operations Playbook as bullets", summary / document
With PREVIOUS TURN "Give me the three most important points of the Operations Playbook": "why?" → standalone_query "Why are those the three most important points of the Operations Playbook?", question / document`;

function keyFor(message, hasAttachment, context) {
  const ctx = context?.lastUser ? "|" + String(context.lastUser).toLowerCase().slice(0, 120) : "";
  return (hasAttachment ? "a|" : "n|") + String(message || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 500) + ctx;
}

function remember(key, intent) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), intent });
  return intent;
}

/**
 * Classify a message. Never throws; falls back to rules.
 * @param {string} message
 * @param {{ openai?: object, hasAttachment?: boolean, log?: object, context?: {lastUser?: string, lastAssistant?: string, lastAssistantDocs?: string[]} }} opts
 *   context: the previous exchange in this thread, so references in a follow-up can be resolved
 */
export async function classifyIntent(message = "", { openai = null, hasAttachment = false, log = null, context = null } = {}) {
  const key = keyFor(message, hasAttachment, context);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.intent;

  const rules = decodeIntentByRules(message, { hasAttachment });
  if (INTENT_MODE === "rules" || !openai || !String(message || "").trim()) return remember(key, rules);
  if (rules.literal) return remember(key, rules);       // cheap and certain; no model call

  const t0 = Date.now();
  try {
    const ctxLines = [];
    if (context?.lastUser) ctxLines.push(`PREVIOUS TURN (user): ${String(context.lastUser).slice(0, 600)}`);
    if (context?.lastAssistant) ctxLines.push(`PREVIOUS ANSWER (assistant, start): ${String(context.lastAssistant).slice(0, 400)}`);
    if (context?.lastAssistantDocs?.length) ctxLines.push(`DOCUMENTS CITED in the previous answer: ${context.lastAssistantDocs.join(" | ")}`);
    const user =
      `${hasAttachment ? "The user attached or pasted material with this message.\n" : ""}` +
      `${ctxLines.length ? ctxLines.join("\n") + "\n\n" : ""}` +
      `MESSAGE:\n${String(message).slice(0, 4000)}`;
    const res = await withTimeout(
      openai.chat.completions.create({
        model: INTENT_MODEL,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        // a classification needs no deliberation: the reasoning models
        // otherwise spend seconds thinking before a 40-token answer
        ...(/^gpt-5/.test(INTENT_MODEL) ? { reasoning_effort: "minimal", verbosity: "low" } : { temperature: 0 }),
      }),
      INTENT_TIMEOUT_MS
    );
    const raw = res.choices?.[0]?.message?.content || "";
    const parsed = JSON.parse(raw);
    const intent = normalize(parsed, "model", Date.now() - t0, message);
    log?.info?.({ intent: intent.type, scope: intent.scope, maturity: intent.maturity, evidence: intent.needsEvidence, rewritten: intent.standaloneQuery !== String(message).trim(), ms: intent.ms, model: INTENT_MODEL }, "intent: classified");
    return remember(key, intent);
  } catch (err) {
    log?.warn?.({ err: err?.message, ms: Date.now() - t0 }, "intent: model classification failed; using rules");
    return remember(key, rules);
  }
}

function normalize(p, source, ms, message = "") {
  const type = INTENT_TYPES.includes(p?.type) ? p.type : "general";
  let scope = INTENT_SCOPES.includes(p?.scope) ? p.scope : "topic";
  const literal = Boolean(p?.literal) || type === "literal";
  if (literal) scope = "none";
  const original = String(message || "").trim();
  const rewritten = typeof p?.standalone_query === "string" ? p.standalone_query.trim() : "";
  // a rewrite is only used when it is a real sentence and not wildly longer than the message
  const standaloneQuery = !literal && rewritten && rewritten.length <= Math.max(200, original.length * 4) ? rewritten : original;
  // "remember that …": what to keep, and as what kind (design doc 5.7)
  const rememberKinds = ["fact", "preference", "decision", "entity", "task", "note"];
  const rememberContent = type === "remember"
    ? String(p?.remember_content || "").replace(/\s+/g, " ").trim().slice(0, 300) || rememberFallback(original)
    : "";
  return {
    standaloneQuery,
    type: literal ? "literal" : type,
    rememberContent,
    rememberKind: type === "remember" ? (rememberKinds.includes(p?.remember_kind) ? p.remember_kind : "note") : null,
    scope,
    maturity: literal ? "locked" : (INTENT_MATURITY.includes(p?.maturity) ? p.maturity : "general"),
    needsEvidence: literal ? false : Boolean(p?.needs_evidence),
    literal,
    documentHints: Array.isArray(p?.document_hints) ? p.document_hints.filter((s) => typeof s === "string" && s.trim()).slice(0, 5) : [],
    source,
    ms: ms ?? null,
  };
}

/** The note to keep when the model gave none: the message without its "remember that" opener. */
function rememberFallback(message = "") {
  return String(message || "")
    .replace(/^\s*(please\s+)?(remember|note|keep in mind|for future reference)(\s+that|\s+this)?[:,\s]*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`intent: timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** The one-word form older consumers compare against ("literal", "summary", ...). */
export function intentLabel(intent) {
  if (!intent) return "general";
  if (typeof intent === "string") return intent;
  return intent.literal ? "literal" : intent.type || "general";
}

// ============================================================
//  Rules fallback — the original keyword decoder, extended with a
//  scope guess. Vocabulary here is a default, not a policy.
// ============================================================
const KNOWLEDGE_BASE_PATTERN =
  /\b(knowledge base|entire (corpus|collection|library)|all (of )?(our|the|your) (documents|files|materials)|every document|everything (we|you) have|across (all|the) documents|whole (corpus|collection|knowledge base))\b/i;
const OVERVIEW_PATTERN =
  /\b(summari[sz]e|summary|overview|what(?:'s| is) in|what does .{0,60}(?:contain|cover)|outline|walk me through|tl;?dr|main points|key points|list (?:all|every|each)|complete list|full list|enumerate|extract all|table of contents)\b/i;

export function decodeIntentByRules(message = "", { hasAttachment = false } = {}) {
  const msg = String(message || "").toLowerCase().trim();
  if (!msg) return normalize({ type: "general", scope: "none", maturity: "general", needs_evidence: false, literal: false, document_hints: [] }, "rules", 0, message);

  if (/^(repeat exactly:|repeat this exactly:|do not change:|say this verbatim:)/i.test(msg)) {
    return normalize({ type: "literal", scope: "none", maturity: "general", needs_evidence: false, literal: true, document_hints: [] }, "rules", 0, message);
  }

  let maturity = "general";
  if (/\b(brainstorm|ideas|outline|framework|example|concept)\b/.test(msg)) maturity = "exploratory";
  else if (/\b(rewrite|revise|enhance|improve|optimize|clean this up|polish|refine)\b/.test(msg)) maturity = "refinement";
  else if (/\b(finalize|final version|ready to send|cut and paste|production ready|deployable|employee ready|customer ready|send this|operationalize|complete this)\b/.test(msg)) maturity = "deployable";

  let type = "general";
  if (/\b(rewrite|restructure|redraft|revise|enhance|improve|optimize|tailor|clean this up|make this professional|rework|polish)\b/.test(msg)) type = "rewrite";
  else if (/\b(email|draft a response|respond to|write a response|compose)\b/.test(msg)) type = "communication";
  else if (/\b(remember that|remember this|note that|keep in mind|for future reference)\b/.test(msg)) type = "remember";
  else if (/\b(draft|write|prepare|create)\b.*\b(brief|memo|report|plan|proposal|sow|statement of work|agreement|contract|one-pager|one pager)\b/.test(msg)) type = "draft";
  else if (/^summari[sz]e|\bsummary\b|tl;?dr/.test(msg)) type = "summary";
  else if (/\b(compare|versus|vs\.?|contrast)\b/.test(msg)) type = "compare";
  else if (/\b(analysis|analy[sz]e|assess|evaluate|implications|risks?)\b/.test(msg)) type = "analysis";
  else if (/^(what|why|when|where|who|which)\b|\?|\bexplain\b/.test(msg)) type = "question";
  else if (/^how\b|\bhelp me\b/.test(msg)) type = "instruction";

  let scope = "topic";
  if (type === "rewrite" || type === "literal") scope = hasAttachment ? "attached" : "none";
  else if (KNOWLEDGE_BASE_PATTERN.test(msg)) scope = "knowledge_base";
  else if (OVERVIEW_PATTERN.test(msg)) scope = "document";          // confirmed later against the documents the question names
  else if (hasAttachment && type !== "question") scope = "attached";
  else if (type === "general" || type === "remember") scope = "none";

  const needsEvidence = ["question", "lookup", "summary", "analysis", "compare"].includes(type) || scope === "knowledge_base" || scope === "document";
  const remember = type === "remember";
  return normalize({
    type, scope, maturity, needs_evidence: needsEvidence, literal: false, document_hints: [],
    remember_content: remember ? rememberFallback(message) : "",
    remember_kind: remember ? (/\b(prefer|like|want|always|never|please use)\b/.test(msg) ? "preference" : /\b(decided|decision|chose|agreed)\b/.test(msg) ? "decision" : "fact") : "none",
  }, "rules", 0, message);
}

/** Old name kept for any caller that still imports it; synchronous, rules only. */
export function decodeIntent(message = "") {
  return decodeIntentByRules(message);
}
