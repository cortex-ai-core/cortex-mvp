// =============================================================
//  Retrieval traces → rag_queries. Fire-and-forget; never blocks
//  or fails a request. Lets a bad answer be replayed later.
// =============================================================

const ENABLED = process.env.RETRIEVAL_TRACE !== "off";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Complete the turn's trace row once the answer exists: the memories
 * used, the memory block size, the answer mode and the model's
 * "conflicts noticed" note (design doc 5.11, E1.7). The chat route
 * chooses the id up front and hands it to retrieval, so the same row
 * is updated here; a turn that ran no retrieval (knowledge-base mode,
 * a remembered note, no evidence needed) gets its own row instead.
 * Fire-and-forget for the caller; the returned promise lets the
 * after-reply hooks (extraction, summariser) wait for the row before
 * they add their own usage to it.
 */
let pclColumnMissing = false;      // rag_queries.pcl arrives with migration 0011; noticed once

export function finishTrace(supabase, log, { traceId, hadRetrieval, query, namespaceId, userId, conversationId, historyTurns, memoryIds, memoryBlockTokens, answerMode, conflicts, pcl, latencyMs }) {
  if (!ENABLED || !supabase || !UUID.test(String(traceId || ""))) return Promise.resolve(false);
  const patch = {
    memory_ids: Array.isArray(memoryIds) && memoryIds.length ? memoryIds : null,
    memory_block_tokens: Number.isFinite(memoryBlockTokens) ? memoryBlockTokens : null,
    answer_mode: answerMode || null,
    conflicts: conflicts ?? null,
  };
  // Persona provenance (plan 7.3): which persona, version, style and
  // note shaped the answer. Left out until 0011 has been applied.
  if (pcl && !pclColumnMissing) patch.pcl = pcl;
  const write = (p) => hadRetrieval
    ? supabase.from("rag_queries").update(p).eq("id", traceId)
    : supabase.from("rag_queries").insert([{
        id: traceId,
        query: String(query || "").slice(0, 2000),
        namespace_id: namespaceId || null,
        conversation_id: conversationId || null,
        history_turns: Number.isFinite(historyTurns) ? historyTurns : null,
        mode: "none",
        user_id: userId || null,
        latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
        result_count: 0,
        results: [],
        ...p,
      }]);
  const done = ({ error }) => {
    if (!error) return true;
    if ("pcl" in patch && (/column .*pcl.* does not exist|PGRST204/i.test(error.message || "") || error.code === "PGRST204")) {
      pclColumnMissing = true;
      log?.info?.("trace: rag_queries.pcl not present yet (migration 0011); persona provenance is not stored");
      const { pcl: _omit, ...rest } = patch;
      return write(rest).then(({ error: again }) => { if (again) { log?.warn?.({ err: again.message }, "trace finish failed"); return false; } return true; });
    }
    log?.warn?.({ err: error.message }, "trace finish failed");
    return false;
  };
  return write(patch).then(done);
}

/**
 * After the reply: record the whole turn's usage (the synchronous calls
 * plus extraction and the summariser) and the memories extraction wrote.
 * Columns from migration 0009; a database without them logs once.
 */
let usageColumnsMissing = false;
export async function recordTurnUsage(supabase, log, { traceId, usage, extractedMemoryIds }) {
  if (!ENABLED || !supabase || usageColumnsMissing || !UUID.test(String(traceId || ""))) return false;
  const patch = {
    usage: usage ?? null,
    extracted_memory_ids: Array.isArray(extractedMemoryIds) && extractedMemoryIds.length ? extractedMemoryIds : null,
  };
  const { error } = await supabase.from("rag_queries").update(patch).eq("id", traceId);
  if (error) {
    if (/column .*(usage|extracted_memory_ids).* does not exist|PGRST204/i.test(error.message || "") || error.code === "PGRST204") {
      usageColumnsMissing = true;
      log?.info?.("trace: rag_queries.usage not present yet (migration 0009); turn usage is not stored");
    } else {
      log?.warn?.({ err: error.message }, "trace usage update failed");
    }
    return false;
  }
  return true;
}

/**
 * Retention (plan 5.5 / R-6): the question text and the model's conflicts
 * note are the only chat content a trace holds. Null them for one
 * thread; keep latency, mode, result ids, usage and cost for metrics.
 * Returns how many rows changed. text_purged_at arrives with migration
 * 0013; without it the text is still nulled, just not stamped.
 */
let textPurgedColumnMissing = false;
const columnMissing = (error, name) =>
  Boolean(error) && (error.code === "42703" || error.code === "PGRST204" || new RegExp(`column .*${name}.* does not exist`, "i").test(error.message || ""));

export async function scrubTraces(supabase, log, { conversationId }) {
  if (!supabase || !UUID.test(String(conversationId || ""))) return 0;
  const run = async (stamp) => {
    const patch = { query: null, conflicts: null, ...(stamp ? { text_purged_at: new Date().toISOString() } : {}) };
    let q = supabase.from("rag_queries").update(patch).eq("conversation_id", conversationId);
    q = stamp ? q.is("text_purged_at", null) : q.not("query", "is", null);
    return q.select("id");
  };
  let { data, error } = await run(!textPurgedColumnMissing);
  if (error && !textPurgedColumnMissing && columnMissing(error, "text_purged_at")) {
    textPurgedColumnMissing = true;
    log?.info?.("trace: rag_queries.text_purged_at not present yet (migration 0013); scrubbing without the stamp");
    ({ data, error } = await run(false));
  }
  if (error) { log?.warn?.({ err: error.message, conversationId }, "trace: scrub failed"); return 0; }
  return (data || []).length;
}

/**
 * Same scrub by age, for trace rows that belong to no thread (memory
 * off, private mode, retrieval calls) and so are never reached through
 * a conversation. Rows with a thread are scrubbed when the thread is
 * archived or deleted. Needs 0013 (the stamp is the idempotency mark).
 */
export async function scrubTracesOlderThan(supabase, log, { namespaceId, days, limit = 500 }) {
  if (!supabase || !UUID.test(String(namespaceId || "")) || !(Number(days) > 0) || textPurgedColumnMissing) return 0;
  const cutoff = new Date(Date.now() - Number(days) * 86_400_000).toISOString();
  const { data: rows, error: selErr } = await supabase
    .from("rag_queries").select("id")
    .eq("namespace_id", namespaceId).is("conversation_id", null).is("text_purged_at", null)
    .lt("created_at", cutoff).not("query", "is", null)
    .limit(limit);
  if (selErr) {
    if (columnMissing(selErr, "text_purged_at")) { textPurgedColumnMissing = true; return 0; }
    log?.warn?.({ err: selErr.message }, "trace: aged scrub lookup failed"); return 0;
  }
  const ids = (rows || []).map((r) => r.id);
  if (!ids.length) return 0;
  const { error } = await supabase.from("rag_queries")
    .update({ query: null, conflicts: null, text_purged_at: new Date().toISOString() })
    .in("id", ids);
  if (error) { log?.warn?.({ err: error.message }, "trace: aged scrub failed"); return 0; }
  return ids.length;
}

export function resolveRetrievalMode(req) {
  const override = req?.headers?.["x-retrieval-mode"];
  if (override && process.env.ALLOW_RETRIEVAL_MODE_OVERRIDE === "1") {
    return String(override).toLowerCase() === "hybrid" ? "hybrid" : "legacy";
  }
  return (process.env.RETRIEVAL_MODE || "legacy").toLowerCase() === "hybrid" ? "hybrid" : "legacy";
}

export function logRetrievalTrace(supabase, log, { traceId, query, namespaceId, mode, userId, latencyMs, results, namedDocs, conversationId, historyTurns }) {
  if (!ENABLED || !supabase) return;
  const row = {
    ...(UUID.test(String(traceId || "")) ? { id: traceId } : {}),
    query: String(query || "").slice(0, 2000),
    namespace_id: namespaceId || null,
    conversation_id: conversationId || null,
    history_turns: Number.isFinite(historyTurns) ? historyTurns : null,
    mode: mode || null,
    user_id: userId || null,
    latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
    result_count: Array.isArray(results) ? results.length : null,
    named_documents: Array.isArray(namedDocs) && namedDocs.length ? namedDocs.map((d) => ({ id: d.id, file_name: d.file_name })) : null,
    results: (results || []).slice(0, 40).map((r) => ({
      chunk_id: r.chunk_id || null,
      document_id: r.document_id || null,
      file: r.display_name || r.filename || null,
      page: r.page_start ?? null,
      section: r.section_label || null,
      similarity: r.similarity ?? null,
      score: r.score ?? r.finalScore ?? null,
      semantic_rank: r.semantic_rank ?? null,
      keyword_rank: r.keyword_rank ?? null,
    })),
  };
  supabase
    .from("rag_queries")
    .insert([row])
    .then(({ error }) => {
      if (error) log?.warn?.({ err: error.message }, "retrieval trace insert failed");
    });
}
