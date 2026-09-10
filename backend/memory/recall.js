// =============================================================
//  Memory recall: what do we already know that bears on this message
//  (design doc 5.6, appendix D and E).
//
//    buildRecallQuery   the message, plus the previous user message
//                       when this one is short
//    recallMemories     embed once, vector + keyword candidates, score,
//                       floor, trim to budget, format the block
//    formatMemoryBlock  the MEMORY block for the system prompt
//
//  Recall never writes. Access counts are bumped in hook H5, after the
//  answer actually used the memories. Every query passes organization,
//  namespace and user to the database, which filters inside the
//  functions (0008), so the caller cannot widen the scope.
// =============================================================

import { estimateTokens } from "./budget.js";
import { embedText } from "./store.js";

const SHORT_MESSAGE_WORDS = 12;
const VECTOR_K = 20;
const KEYWORD_K = 10;

export const MEMORY_BLOCK_HEADING =
  "MEMORY (notes this user and workspace gave Cortéx in earlier conversations. Use them to answer questions about the people, terms, decisions and preferences they describe, even when the documents are silent. They are not document evidence: never cite them with [n]):";

/** The recall query: this message, plus the previous user message if this one is under twelve words. */
export function buildRecallQuery(message = "", previousUserMessage = null) {
  const m = String(message || "").trim();
  const words = m.split(/\s+/).filter(Boolean).length;
  const prev = String(previousUserMessage || "").trim();
  if (words < SHORT_MESSAGE_WORDS && prev) return `${prev}\n${m}`.slice(0, 2000);
  return m.slice(0, 2000);
}

/** Appendix D: mostly similarity; importance, recency and use break ties. */
export function scoreMemory(r, { now = Date.now(), floor = 0.35 } = {}) {
  const sim = Number.isFinite(r.similarity) ? r.similarity : floor;     // keyword-only hits get the floor
  const importance = ((Number(r.importance) || 3) - 1) / 4;             // 1..5 → 0..1
  const last = r.last_accessed_at || r.created_at;
  const ageDays = last ? Math.max(0, (now - new Date(last).getTime()) / 86_400_000) : 30;
  const recency = Math.exp(-ageDays / 30);
  const usage = Math.min(1, Math.log10(1 + (Number(r.access_count) || 0)) / 2);
  return 0.60 * sim + 0.20 * importance + 0.15 * recency + 0.05 * usage;
}

function lineFor(m) {
  const who = m.scope === "namespace" ? "workspace" : "user";
  return `- (${m.kind} · ${who}) ${m.content}`;
}

/** Appendix E. Empty string when there is nothing to say. */
export function formatMemoryBlock(memories = []) {
  if (!memories.length) return "";
  return `${MEMORY_BLOCK_HEADING}\n${memories.map(lineFor).join("\n")}`;
}

/**
 * Recall for one turn.
 *
 * @param {object} supabase
 * @param {object} openai
 * @param {{organizationId,namespaceId,userId}} identity
 * @param {{message, previousUserMessage?, settings?, embedding?, log?}} opts
 *   embedding: a query embedding to reuse (same model as documents) instead of embedding again
 * @returns {{ memories: object[], memoryIds: string[], block: string, tokens: number, query: string, candidates: number, ms: number }}
 */
export async function recallMemories(supabase, openai, identity, { message, previousUserMessage = null, settings = null, embedding = null, log = null } = {}) {
  const t0 = Date.now();
  const empty = { memories: [], memoryIds: [], block: "", tokens: 0, query: "", candidates: 0, ms: 0 };
  if (!identity?.organizationId || !identity?.namespaceId || !identity?.userId) return empty;

  const query = buildRecallQuery(message, previousUserMessage);
  if (!query) return empty;

  const k = Math.max(0, Number(settings?.recall_k ?? 8));
  const floor = Number(settings?.recall_min_sim ?? 0.35);
  const blockTokens = Math.max(0, Number(settings?.block_tokens ?? 600));
  if (!k || !blockTokens) return { ...empty, query };

  const scope = {
    query_organization_id: identity.organizationId,
    query_namespace_id: identity.namespaceId,
    query_user_id: identity.userId,
    include_shared: true,
  };

  const vec = embedding || (await embedText(openai, query));
  const [semantic, keyword] = await Promise.all([
    supabase.rpc("match_memories", { query_embedding: vec, match_count: VECTOR_K, ...scope }),
    supabase.rpc("search_memories_keyword", { query_text: query.slice(0, 500), match_count: KEYWORD_K, ...scope }),
  ]);
  if (semantic.error) throw new Error(`recall: match_memories failed: ${semantic.error.message}`);
  if (keyword.error) log?.warn?.({ err: keyword.error.message }, "recall: keyword search failed; vector only");

  // Merge by id. Keyword-only hits have no similarity; fetch their rows so
  // they can be scored and rendered.
  const byId = new Map();
  for (const r of semantic.data || []) byId.set(r.id, { ...r, keyword_rank: null });
  const keywordOnly = [];
  for (const r of keyword.data || []) {
    if (byId.has(r.id)) byId.get(r.id).keyword_rank = r.rank;
    else keywordOnly.push(r);
  }
  if (keywordOnly.length) {
    const { data: rows } = await supabase
      .from("memories")
      .select("id, scope, kind, content, importance, access_count, last_accessed_at, created_at")
      .in("id", keywordOnly.map((r) => r.id))
      .eq("organization_id", identity.organizationId)
      .eq("namespace_id", identity.namespaceId)
      .eq("status", "active");
    for (const row of rows || []) byId.set(row.id, { ...row, similarity: null, keyword_rank: keywordOnly.find((r) => r.id === row.id)?.rank ?? null });
  }

  const candidates = [...byId.values()];
  const now = Date.now();
  const ranked = candidates
    .filter((r) => (Number.isFinite(r.similarity) ? r.similarity >= floor : true))     // keyword-only hits sit at the floor and pass
    .map((r) => ({ ...r, score: scoreMemory(r, { now, floor }) }))
    .sort((a, b) => b.score - a.score);

  // Trim: best first until the block reaches its token cap, never more than k.
  const chosen = [];
  let tokens = estimateTokens(MEMORY_BLOCK_HEADING);
  for (const r of ranked) {
    if (chosen.length >= k) break;
    const t = estimateTokens(lineFor(r)) + 1;
    if (tokens + t > blockTokens) continue;
    chosen.push(r);
    tokens += t;
  }

  const block = formatMemoryBlock(chosen);
  const result = {
    memories: chosen.map((r) => ({
      id: r.id, scope: r.scope, kind: r.kind, content: r.content, importance: r.importance,
      similarity: Number.isFinite(r.similarity) ? Number(r.similarity.toFixed(3)) : null, score: Number(r.score.toFixed(3)),
    })),
    memoryIds: chosen.map((r) => r.id),
    block,
    tokens: block ? tokens : 0,
    query,
    candidates: candidates.length,
    ms: Date.now() - t0,
  };
  log?.info?.({ used: result.memories.length, candidates: candidates.length, tokens: result.tokens, ms: result.ms }, "memory: recall");
  return result;
}
