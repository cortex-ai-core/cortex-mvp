// =============================================================
//  The thread window: what of an earlier conversation reaches the
//  model (design doc 5.5).
//
//    loadWindow      the running summary (if any) plus the most recent
//                    exchanges word for word, trimmed to the caps
//    maybeSummarize  when the unsummarised part of a thread has grown
//                    past the trigger, fold the older turns into the
//                    summary. Runs after an answer is sent; never on
//                    the request path.
//
//  Every query filters on organization, namespace and user, so a
//  window can only ever be built from the caller's own thread.
// =============================================================

import { fitNewest, estimateTokens, clipToTokens } from "./budget.js";
import { recordUsage } from "../lib/usage.js";

const SUMMARY_MAX_TOKENS = 300;

function owned(query, identity) {
  return query
    .eq("organization_id", identity.organizationId)
    .eq("namespace_id", identity.namespaceId)
    .eq("user_id", identity.userId);
}

async function readSummary(supabase, conversationId) {
  const { data } = await supabase
    .from("conversation_summaries")
    .select("summary, through_seq, token_estimate, updated_at")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  return data || null;
}

/**
 * Build the window for one turn.
 *
 * @param {object} supabase
 * @param {{organizationId,namespaceId,userId}} identity
 * @param {string} conversationId
 * @param {object} settings   effective memory settings (history_turns, history_tokens)
 * @param {{beforeSeq?: number}} opts   only messages with seq < beforeSeq (the current user turn is excluded)
 * @returns {{ summary: {text,through_seq}|null, messages: {role,content,seq}[], tokens, turns, unsummarizedTokens, totalMessages }}
 */
export async function loadWindow(supabase, identity, conversationId, settings, { beforeSeq = Infinity } = {}) {
  const summary = await readSummary(supabase, conversationId);
  const afterSeq = summary?.through_seq || 0;

  let q = owned(
    supabase
      .from("messages")
      .select("seq, role, content, token_estimate, sources")
      .eq("conversation_id", conversationId)
      .gt("seq", afterSeq),
    identity
  );
  if (Number.isFinite(beforeSeq)) q = q.lt("seq", beforeSeq);
  const { data, error } = await q.order("seq", { ascending: true });
  if (error) throw new Error(`window: messages failed: ${error.message}`);

  const unsummarized = (data || []).filter((m) => m.role === "user" || m.role === "assistant");
  const unsummarizedTokens = unsummarized.reduce((a, m) => a + (m.token_estimate || estimateTokens(m.content)), 0);

  const maxMessages = Math.max(0, (settings?.history_turns ?? 10) * 2);   // a turn is one exchange
  const maxTokens = Math.max(0, settings?.history_tokens ?? 2000);
  const fitted = fitNewest(unsummarized, { maxMessages, maxTokens });

  // What the previous exchange was about, for resolving "it", "the second
  // one", "that program" in the next message (the intent module reads this).
  const lastUser = [...unsummarized].reverse().find((m) => m.role === "user");
  const lastAssistant = [...unsummarized].reverse().find((m) => m.role === "assistant");
  const lastAssistantDocs = [...new Set(
    (Array.isArray(lastAssistant?.sources) ? lastAssistant.sources : [])
      .map((s) => s?.display_name || s?.file_name)
      .filter(Boolean)
  )].slice(0, 8);

  return {
    summary: summary ? { text: clipToTokens(summary.summary, SUMMARY_MAX_TOKENS), through_seq: summary.through_seq } : null,
    messages: fitted.messages.map((m) => ({ role: m.role, content: m.content, seq: m.seq })),
    tokens: fitted.tokens + (summary ? estimateTokens(summary.summary) : 0),
    turns: Math.ceil(fitted.messages.length / 2),
    dropped: fitted.dropped,
    unsummarizedTokens,
    totalMessages: unsummarized.length,
    context: {
      lastUser: lastUser ? String(lastUser.content).slice(0, 600) : null,
      lastAssistant: lastAssistant ? String(lastAssistant.content).slice(0, 600) : null,
      lastAssistantDocs,
    },
  };
}

const SUMMARY_SYSTEM = `You maintain a running summary of one conversation between a user and Cortéx, an assistant that answers from an organization's documents. You are given the previous summary (possibly empty) and the turns being folded into it. Write the new summary in plain prose, at most 220 words. Keep every name, number, date, code, decision, and correction. Keep open questions the user has not had answered. Drop greetings, pleasantries, and the assistant's phrasing. Never add anything that is not in the input. Output the summary only.`;

/**
 * Fold older turns into the summary once the unsummarised part of the
 * thread exceeds the trigger. The most recent `history_turns` exchanges
 * are always left verbatim, so the window still reads naturally after
 * the fold. Returns what it did, never throws.
 */
export async function maybeSummarize(supabase, openai, identity, conversationId, settings, log, { usage = null } = {}) {
  try {
    const trigger = settings?.summary_trigger_tokens ?? 3000;
    const keepVerbatim = Math.max(0, (settings?.history_turns ?? 10) * 2);
    const summary = await readSummary(supabase, conversationId);
    const afterSeq = summary?.through_seq || 0;

    const { data, error } = await owned(
      supabase
        .from("messages")
        .select("seq, role, content, token_estimate")
        .eq("conversation_id", conversationId)
        .gt("seq", afterSeq),
      identity
    ).order("seq", { ascending: true });
    if (error) throw new Error(error.message);

    const turns = (data || []).filter((m) => m.role === "user" || m.role === "assistant");
    const unsummarizedTokens = turns.reduce((a, m) => a + (m.token_estimate || estimateTokens(m.content)), 0);
    if (unsummarizedTokens < trigger) return { ran: false, reason: "under trigger", unsummarizedTokens };

    const fold = turns.slice(0, Math.max(0, turns.length - keepVerbatim));
    if (!fold.length) return { ran: false, reason: "nothing older than the verbatim window", unsummarizedTokens };

    const transcript = fold.map((m) => `${m.role === "user" ? "User" : "Cortéx"}: ${String(m.content).slice(0, 4000)}`).join("\n\n");
    const user = `PREVIOUS SUMMARY:\n${summary?.summary || "(none)"}\n\nTURNS TO FOLD IN:\n${transcript}`;

    const model = settings?.extract_model || process.env.MEMORY_EXTRACT_MODEL || "gpt-5-mini";
    const t0 = Date.now();
    const res = await openai.chat.completions.create({
      model,
      messages: [{ role: "system", content: SUMMARY_SYSTEM }, { role: "user", content: user }],
      ...(/^gpt-5/.test(model) ? { reasoning_effort: "low", verbosity: "low" } : { temperature: 0.2 }),
    });
    recordUsage(usage, "summary", model, res.usage);
    const text = (res.choices?.[0]?.message?.content || "").trim();
    if (!text) return { ran: false, reason: "empty summary" };

    const throughSeq = fold[fold.length - 1].seq;
    const { error: upsertErr } = await supabase
      .from("conversation_summaries")
      .upsert({ conversation_id: conversationId, summary: text, through_seq: throughSeq, token_estimate: estimateTokens(text), updated_at: new Date().toISOString() }, { onConflict: "conversation_id" });
    if (upsertErr) throw new Error(upsertErr.message);

    log?.info?.({ conversationId, folded: fold.length, throughSeq, tokens: estimateTokens(text), model, ms: Date.now() - t0 }, "memory: conversation summarised");
    return { ran: true, folded: fold.length, throughSeq, tokens: estimateTokens(text) };
  } catch (err) {
    log?.warn?.({ err: err?.message, conversationId }, "memory: summariser failed");
    return { ran: false, reason: err?.message };
  }
}
