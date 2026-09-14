// =============================================================
//  The archive summary (retention plan 5.4): one structured,
//  minimised record that outlives a purged conversation.
//
//    buildArchiveInput   the running summary plus the turns after it,
//                        capped per turn and in total
//    summarizeForArchive one strict-schema model call, then four
//                        minimisation layers: the input was already
//                        through input DLP when saved; the prompt
//                        forbids contact details, identifiers,
//                        credentials and personal detail; every
//                        output string passes output DLP; caps cut
//                        what is over
//    buildArchive        the stored record: the model's fields plus
//                        what the rows already know (documents used,
//                        period, counts, source, generation)
//    metadataOnlyArchive the fallback: no model text at all
//    renderArchive       the display text, at most RENDER_MAX chars
//
//  Read by people, not the model (R-5): nothing here is embedded.
// =============================================================

import { stripSensitiveFields } from "../lib/dlp.js";
import { recordUsage } from "../lib/usage.js";

export const PROMPT_VERSION = "archive-v2";   // v2: decisions are choices; stated facts and corrections are conclusions
export const ARCHIVE_MODEL = process.env.RETENTION_SUMMARY_MODEL || "gpt-5-mini";
const TIMEOUT_MS = Number(process.env.RETENTION_ARCHIVE_TIMEOUT_MS || 45_000);

export const CAPS = Object.freeze({
  items: 8,            // per list
  item: 200,           // chars per item
  topic: 200,
  purpose: 300,
  render: 2500,        // chars of rendered text (a long thread's lists need the room; the record itself is never cut)
  turn: 4000,          // chars of one message sent to the model
  input: 60_000,       // chars of transcript sent to the model
});

const LISTS = ["decisions", "conclusions", "open_questions"];

const SCHEMA = {
  name: "cortex_conversation_archive",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["topic", "purpose", "decisions", "conclusions", "action_items", "participants", "open_questions"],
    properties: {
      topic:          { type: "string", description: "What the conversation was about, as a short title" },
      purpose:        { type: "string", description: "Why the user came: one or two sentences" },
      decisions:      { type: "array", items: { type: "string" }, description: "Choices the user made or confirmed about what will be done, used or adopted (\"we will…\", \"use X\", \"X stands as the sign-off\"). Not facts, corrections or answers: those are conclusions. Empty when the user decided nothing." },
      conclusions:    { type: "array", items: { type: "string" }, description: "What was established: answers found in the documents, and facts the user stated or corrected (a person's role, a date, a figure). Keep the figures that matter." },
      action_items:   { type: "array", items: {
        type: "object", additionalProperties: false, required: ["item", "owner", "due"],
        properties: { item: { type: "string" }, owner: { type: "string", description: "Name or role, or empty" }, due: { type: "string", description: "Date or empty" } },
      } },
      participants:   { type: "array", items: {
        type: "object", additionalProperties: false, required: ["name", "role"],
        properties: { name: { type: "string" }, role: { type: "string", description: "Business role, or empty" } },
      }, description: "People named in the conversation who matter to its business context" },
      open_questions: { type: "array", items: { type: "string" }, description: "Asked and not answered" },
    },
  },
};

const SYSTEM = `You write the archive record of one conversation between a user and Cortéx, an assistant that answers from an organization's documents. The raw conversation is about to be deleted; your record is all that will remain. Someone opening it weeks later needs to know what the conversation was about, what was settled, what was concluded, what is still owed, who was involved, and what is still open.

Definitions:
- A DECISION is a choice the user made or confirmed about what will be done, used or adopted. "Tom's review stands as the sign-off" is a decision. "Tom is the COO" is not.
- A CONCLUSION is what was established: an answer found in the documents, or a fact the user stated or corrected, such as a person's role, a date or a figure. When in doubt, it is a conclusion.

Rules:
- Only what the conversation contains. Never add outside knowledge or guesses.
- Keep names of people, organizations, documents, products, figures, dates and codes that carry the business meaning.
- Minimise personal data. Never include email addresses, phone numbers, postal addresses, account or identification numbers, passwords, keys, tokens or other credentials, or personal health, financial or family detail about an individual. Refer to people by name and business role only. Cortéx itself is never a participant.
- Decisions are choices the user made or confirmed ("we will", "use X", "X stands as"). Facts the user stated or corrected, and answers found in the documents, are conclusions. How Cortéx answered, or what it declined to add, is never a decision or a conclusion.
- Do not quote the conversation verbatim except for the wording of a decision.
- Plain prose, no markdown. Empty strings and empty lists are correct when there is nothing to say.
- At most ${CAPS.items} entries per list; each entry one sentence.`;

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`archive summary timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

const modelOptions = (model) => (/^gpt-5/.test(model) ? { reasoning_effort: "low", verbosity: "low" } : { temperature: 0.2 });

/**
 * The transcript for the model: the running summary (if any) and the
 * turns after it, newest kept when the total is over the input cap.
 * @returns {{ text: string, turns: number, omitted: number }}
 */
export function buildArchiveInput({ summary = null, messages = [] } = {}) {
  const turns = (messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  const lines = turns.map((m) => `${m.role === "user" ? "User" : "Cortéx"}: ${String(m.content || "").replace(/\s+/g, " ").trim().slice(0, CAPS.turn)}`);
  const head = summary?.summary ? `SUMMARY OF EARLIER TURNS:\n${String(summary.summary).slice(0, CAPS.turn)}\n\n` : "";
  let budget = CAPS.input - head.length;
  const kept = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 2;
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(lines[i]);
  }
  const omitted = lines.length - kept.length;
  const note = omitted ? `(${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted for length)\n\n` : "";
  return { text: `${head}${note}TURNS:\n${kept.join("\n\n")}`, turns: turns.length, omitted };
}

const CREDENTIAL = /\b(password|passcode|passphrase|api[ -]?key|secret|token|pin)\b\s*(?:is|was|[:=])/i;
const BLOCKED = "[BLOCKED: SENSITIVE CONTENT]";

/** One string through output DLP and the caps; null when it must be dropped. */
function cleanString(value, max) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (CREDENTIAL.test(raw)) return null;
  const out = stripSensitiveFields(raw);
  if (out === BLOCKED) return null;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + "…" : out;
}

function cleanList(list, fn) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const v = fn(item);
    if (v) out.push(v);
    if (out.length >= CAPS.items) break;
  }
  return out;
}

/**
 * The model's fields after minimisation: DLP on every string, credential
 * lines dropped, lists and items capped. Pure.
 */
export function minimiseArchive(parsed = {}) {
  const out = {
    topic: cleanString(parsed.topic, CAPS.topic) || "",
    purpose: cleanString(parsed.purpose, CAPS.purpose) || "",
  };
  for (const key of LISTS) out[key] = cleanList(parsed[key], (s) => cleanString(s, CAPS.item));
  out.action_items = cleanList(parsed.action_items, (a) => {
    const item = cleanString(a?.item, CAPS.item);
    if (!item) return null;
    const owner = cleanString(a?.owner, 80) || "";
    const due = cleanString(a?.due, 40) || "";
    return { item, owner, due };
  });
  out.participants = cleanList(parsed.participants, (p) => {
    const name = cleanString(p?.name, 80);
    if (!name) return null;
    return { name, role: cleanString(p?.role, 80) || "" };
  });
  return out;
}

/** Documents the answers cited, from the assistant messages' sources. */
export function documentsUsed(messages = []) {
  const seen = new Map();
  for (const m of messages || []) {
    if (m.role !== "assistant" || !Array.isArray(m.sources)) continue;
    for (const s of m.sources) {
      const id = s?.document_id;
      if (!id || seen.has(id)) continue;
      seen.set(id, { document_id: id, display_name: s.display_name || s.file_name || null });
      if (seen.size >= 20) break;
    }
  }
  return [...seen.values()];
}

function period(conversation, messages) {
  const first = messages?.[0]?.created_at || conversation?.created_at || null;
  const last = messages?.length ? messages[messages.length - 1].created_at : conversation?.last_message_at || null;
  return { started_at: first, ended_at: last };
}

/**
 * The stored record: minimised model fields plus what the rows know.
 * `fields` is the output of minimiseArchive (or empty for the fallback).
 */
export function buildArchive({ conversation, messages = [], fields = {}, model = null, fallback = false, reason = null }) {
  const turns = (messages || []).filter((m) => m.role === "user").length;
  return {
    topic: fields.topic || (conversation?.title ? cleanString(conversation.title, CAPS.topic) || "" : ""),
    purpose: fields.purpose || "",
    decisions: fields.decisions || [],
    conclusions: fields.conclusions || [],
    action_items: fields.action_items || [],
    participants: fields.participants || [],
    open_questions: fields.open_questions || [],
    documents_used: documentsUsed(messages),
    period: period(conversation, messages),
    counts: { messages: (messages || []).length, turns },
    source: {
      conversation_id: conversation?.id || null,
      organization_id: conversation?.organization_id || null,
      namespace_id: conversation?.namespace_id || null,
      user_id: conversation?.user_id || null,
    },
    generation: {
      model: fallback ? null : model,
      prompt_version: PROMPT_VERSION,
      minimised: true,
      fallback: Boolean(fallback),
      reason: reason || null,
      generated_at: new Date().toISOString(),
    },
  };
}

/** The fallback: title, dates, counts and documents; no model text. */
export function metadataOnlyArchive({ conversation, messages = [], reason = "fallback" }) {
  return buildArchive({ conversation, messages, fields: {}, fallback: true, reason });
}

/** Display text for the record, capped. */
export function renderArchive(a) {
  const parts = [];
  if (a.topic) parts.push(`Topic: ${a.topic}`);
  if (a.purpose) parts.push(`Purpose: ${a.purpose}`);
  const list = (label, items, fmt = (x) => x) => { if (items?.length) parts.push(`${label}:\n${items.map((x) => `- ${fmt(x)}`).join("\n")}`); };
  list("Decisions", a.decisions);
  list("Conclusions", a.conclusions);
  list("Action items", a.action_items, (x) => `${x.item}${x.owner ? ` (${x.owner}${x.due ? `, ${x.due}` : ""})` : x.due ? ` (${x.due})` : ""}`);
  list("Participants", a.participants, (p) => `${p.name}${p.role ? `, ${p.role}` : ""}`);
  list("Open questions", a.open_questions);
  list("Documents used", a.documents_used, (d) => d.display_name || d.document_id);
  const when = a.period?.started_at ? `${String(a.period.started_at).slice(0, 10)}${a.period.ended_at && String(a.period.ended_at).slice(0, 10) !== String(a.period.started_at).slice(0, 10) ? ` to ${String(a.period.ended_at).slice(0, 10)}` : ""}` : "";
  parts.push(`${when ? `${when} · ` : ""}${a.counts?.messages ?? 0} messages${a.generation?.fallback ? " · summary unavailable, metadata only" : ""}`);
  const text = parts.join("\n\n");
  return text.length > CAPS.render ? text.slice(0, CAPS.render - 1).trimEnd() + "…" : text;
}

/**
 * One model call, minimised. Throws when the model fails; the caller
 * decides between retrying later and the metadata-only fallback.
 * @returns {{ fields, model, promptVersion, input: {turns, omitted, chars} }}
 */
export async function summarizeForArchive({ openai, conversation, summary = null, messages = [], usage = null, log = null, model = ARCHIVE_MODEL }) {
  const input = buildArchiveInput({ summary, messages });
  const t0 = Date.now();
  const res = await withTimeout(
    openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `CONVERSATION TITLE: ${String(conversation?.title || "").slice(0, 120) || "(none)"}\n\n${input.text}` },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
      ...modelOptions(model),
    }),
    TIMEOUT_MS
  );
  recordUsage(usage, "archive_summary", model, res.usage);
  const raw = res.choices?.[0]?.message?.content || "";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("archive summary was not valid JSON"); }
  const fields = minimiseArchive(parsed);
  log?.info?.({ conversationId: conversation?.id, model, turns: input.turns, omitted: input.omitted, ms: Date.now() - t0 }, "retention: archive summary written");
  return { fields, model, promptVersion: PROMPT_VERSION, input: { turns: input.turns, omitted: input.omitted, chars: input.text.length } };
}
