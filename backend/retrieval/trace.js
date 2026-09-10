// =============================================================
//  Retrieval traces → rag_queries. Fire-and-forget; never blocks
//  or fails a request. Lets a bad answer be replayed later.
// =============================================================

const ENABLED = process.env.RETRIEVAL_TRACE !== "off";

export function resolveRetrievalMode(req) {
  const override = req?.headers?.["x-retrieval-mode"];
  if (override && process.env.ALLOW_RETRIEVAL_MODE_OVERRIDE === "1") {
    return String(override).toLowerCase() === "hybrid" ? "hybrid" : "legacy";
  }
  return (process.env.RETRIEVAL_MODE || "legacy").toLowerCase() === "hybrid" ? "hybrid" : "legacy";
}

export function logRetrievalTrace(supabase, log, { query, namespaceId, mode, userId, latencyMs, results, namedDocs, conversationId, historyTurns }) {
  if (!ENABLED || !supabase) return;
  const row = {
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
