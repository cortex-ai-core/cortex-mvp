// =============================================================
//  D1: the intent labels from a System One decision model
//  (docs/KEV_PROTOTYPE.md §3). One request answers every label field
//  of backend/reasoning/intent.js at once; the two text fields stay
//  with the chat model:
//    standalone_query  only asked for when follow_up says the message
//                      needs the previous turn (reasoning/intent.js)
//    remember_content  a "remember" turn escalates to the full LLM call
//
//  Returns raw fields for reasoning/intent.js to normalize, or null when
//  the call failed. The escalation decision is the caller's.
// =============================================================

import { systemOne, choiceOf, noulOf } from "./systemone.js";

const TYPE_OPTIONS = {
  question: "asks about a fact, detail, or explanation",
  lookup: "asks to find or locate something specific: a number, a name, a date, a code",
  summary: "asks for a summary, overview, key points, or table of contents",
  analysis: "asks for an assessment, evaluation, implications, risks, or recommendations",
  compare: "asks to compare or contrast two or more things",
  draft: "asks to write new material: a brief, memo, report, plan, proposal, or outline",
  rewrite: "asks to revise, polish, shorten, or restructure text the user supplies",
  communication: "asks to write an email, message, or reply to someone",
  instruction: "asks how to do something, step by step",
  remember: "asks the assistant to remember or note a fact or preference for later",
  inform: "tells the assistant a fact, update, or correction without asking for anything, and without asking it to be remembered",
  general: "a greeting, small talk, a question about the assistant itself, or anything else",
  literal: "asks for text to be repeated exactly as given",
};

const SCOPE_OPTIONS = {
  topic: "a specific subject, fact, figure, program, person or event to find by searching the documents; the default for factual questions and lookups",
  document: "one particular document as a whole: its overview, summary, structure, or what it covers",
  documents: "two or more particular, named documents",
  knowledge_base: "the whole collection of documents, referred to explicitly (\"the knowledge base\", \"everything we have\", \"all our documents\"), or a deliverable that must survey all of it",
  attached: "only the text the user attached or pasted with this message",
  none: "no documents needed: a greeting, small talk, a question about the assistant, or a rewrite of supplied text",
};

const MATURITY_OPTIONS = {
  general: "no particular finish asked for",
  exploratory: "ideas, an outline, a brainstorm",
  refinement: "revise or improve something",
  deployable: "final, ready to send or use",
};

/** The state Kev reads: short, since it was trained on states of about 384 tokens. */
export function intentState(message, { hasAttachment = false, context = null } = {}) {
  const state = {
    assistant: "Cortéx answers from an organization's uploaded documents (its knowledge base), from files attached to the message, and from the conversation.",
    message: String(message || "").slice(0, 1500),
  };
  if (hasAttachment) state.attachment = "The user attached or pasted material with this message.";
  if (context?.lastUser) state.previous_user_message = String(context.lastUser).slice(0, 300);
  if (context?.lastAssistantDocs?.length) state.documents_cited_in_previous_answer = context.lastAssistantDocs.slice(0, 5);
  return state;
}

export function intentQuestions({ hasContext = false } = {}) {
  const q = {
    type: { type: "choice", instructions: "What does the user want done with this message?", criteria: TYPE_OPTIONS },
    scope: { type: "choice", instructions: "What material should the answer draw on?", criteria: SCOPE_OPTIONS },
    maturity: { type: "choice", instructions: "How finished should the output be?", criteria: MATURITY_OPTIONS },
    needs_evidence: { type: "noul", instructions: "Must a good answer be grounded in the organization's documents rather than general knowledge?" },
  };
  if (hasContext) {
    q.follow_up = {
      type: "noul",
      instructions: "Does the message depend on the previous user message to be understood, for example through \"it\", \"that\", \"those\", \"the second one\", or a bare \"why?\"",
    };
  }
  return q;
}

/**
 * @returns {Promise<null | { fields: object, confidence: {type,scope}, followUp: number|null, ms: number, modelMs: number|null, inputTokens: number, model: string }>}
 */
export async function kevIntent(message, { hasAttachment = false, context = null, usage = null, log = null, timeoutMs = null } = {}) {
  const hasContext = Boolean(context?.lastUser);
  const res = await systemOne(intentState(message, { hasAttachment, context }), intentQuestions({ hasContext }), { stage: "intent_kev", usage, log, timeoutMs });
  if (!res) return null;
  const a = res.answers;
  const type = choiceOf(a.type);
  const scope = choiceOf(a.scope);
  if (!type || !scope) return null;
  const maturity = choiceOf(a.maturity);
  const evidence = noulOf(a.needs_evidence);
  const followUp = hasContext ? noulOf(a.follow_up) : null;
  return {
    fields: {
      type: type.value,
      scope: scope.value,
      maturity: maturity?.value || "general",
      needs_evidence: evidence == null ? false : evidence >= 0.5,
      literal: type.value === "literal",
      document_hints: [],
    },
    confidence: { type: type.confidence, scope: scope.confidence, typeP: type.p, scopeP: scope.p, evidenceP: evidence },
    followUp,
    ms: res.ms,
    modelMs: res.modelMs,
    inputTokens: res.inputTokens,
    model: res.model,
  };
}
