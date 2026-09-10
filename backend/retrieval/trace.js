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
 * Fire-and-forget.
 */
export function finishTrace(supabase, log, { traceId, hadRetrieval, query, namespaceId, userId, conversationId, historyTurns, memoryIds, memoryBlockTokens, answerMode, conflicts, latencyMs }) {
  if (!ENABLED || !supabase || !UUID.test(String(traceId || ""))) return;
  const patch = {
    memory_ids: Array.isArray(memoryIds) && memoryIds.length ? memoryIds : null,
    memory_block_tokens: Number.isFinite(memoryBlockTokens) ? memoryBlockTokens : null,
    answer_mode: answerMode || null,
    conflicts: conflicts ?? null,
  };
  const done = ({ error }) => { if (error) log?.warn?.({ err: error.message }, "trace finish failed"); };
  if (hadRetrieval) {
    supabase.from("rag_queries").update(patch).eq("id", traceId).then(done);
  } else {
    supabase.from("rag_queries").insert([{
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
      ...patch,
    }]).then(done);
  }
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
