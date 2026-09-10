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
import { describeVote, VISIBLE_TRUTH } from "./policy.js";

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

// Design doc 9.6: the line shows the proposition's truth state. Accepted
// notes read as before, with the date they were noted so the later of two
// wins. Reported notes say who reported them. Contested notes show both
// sides and the basis of the vote. Denied, retracted and superseded rows
// never reach here (the search functions leave them out).
function lineFor(m) {
  const who = m.scope === "namespace" ? "workspace" : "user";
  const day = m.created_at ? String(m.created_at).slice(0, 10) : null;
  const truth = m.truth_status || "accepted";
  if (truth === "contested" && m.contest) return contestedLines(m, who);
  if (truth === "reported") return `- (${m.kind} · ${who} · reported${m.reporter ? ` by ${m.reporter}` : ""}${day ? `, ${day}` : ""}) ${m.content}`;
  return `- (${m.kind} · ${who} · ${truth}${day ? ` · noted ${day}` : ""}) ${m.content}`;
}

function contestedLines(m, who) {
  const c = m.contest;
  const topic = m.subject && m.predicate ? `${m.subject}: ${m.predicate}` : "two notes disagree";
  const side = (s, verb) => `    ${s.who} (${s.how}${s.date ? `, ${s.date}` : ""}) ${verb} ${s.content}`;
  const lines = [`- (${m.kind} · ${who} · CONTESTED) ${topic}:`, side(c.this, "says") + ";", side(c.other, "says") + "."];
  if (c.basis) lines.push(`    Basis: ${c.basis}.`);
  return lines.join("\n");
}

/** Appendix E. Empty string when there is nothing to say. */
export function formatMemoryBlock(memories = []) {
  if (!memories.length) return "";
  return `${MEMORY_BLOCK_HEADING}\n${memories.map(lineFor).join("\n")}`;
}

/**
 * For contested and reported memories, fetch what the block needs: the
 * open state (counterpart, dimensions), the live attestations of both
 * sides (who said it, how, when) and the counterpart's text. Nothing is
 * fetched for plain accepted notes. Quiet until migration 0010 exists.
 */
async function decorate(supabase, identity, memories) {
  const special = memories.filter((m) => m.truth_status === "contested" || m.truth_status === "reported");
  if (!special.length) return memories;
  const ids = special.map((m) => m.id);
  const { data: states, error } = await supabase.from("memory_states").select("memory_id, counterpart_id, dimensions, reason, effective_range, computed_at").in("memory_id", ids).order("computed_at", { ascending: false });
  if (error) return memories;
  const open = new Map();
  for (const s of states || []) if (!open.has(s.memory_id) && /,\s*\)$/.test(String(s.effective_range))) open.set(s.memory_id, s);
  const counterpartIds = [...new Set([...open.values()].map((s) => s.counterpart_id).filter(Boolean))];
  const allIds = [...new Set([...ids, ...counterpartIds])];
  // subject and predicate for the topic line, and the counterpart's text
  const { data: rows } = await supabase.from("memories").select("id, content, kind, scope, subject, predicate, created_at").in("id", allIds).eq("namespace_id", identity.namespaceId);
  const counterparts = (rows || []).filter((r) => counterpartIds.includes(r.id));
  const detail = new Map((rows || []).map((r) => [r.id, r]));
  const { data: atts } = await supabase.from("attestations").select("memory_id, actor, source_layer, source_ref, asserted_at, stance").in("memory_id", allIds).eq("status", "accepted").is("invalidated_at", null).order("asserted_at", { ascending: true });
  const actorIds = [...new Set((atts || []).map((a) => a.actor).filter((a) => /^[0-9a-f-]{36}$/i.test(a || "")))].filter((a) => a !== identity.userId);
  const { data: users } = actorIds.length ? await supabase.from("user").select("id, email").in("id", actorIds) : { data: [] };
  const nameOf = (actor) => (users || []).find((u) => u.id === actor)?.email?.split("@")[0] || null;

  const describeSide = (memoryId, text, isSelf) => {
    const rows = (atts || []).filter((a) => a.memory_id === memoryId && a.stance === "asserts");
    const first = rows[0];
    const who = !first ? "someone"
      : first.actor === identity.userId ? "you"
      : first.source_layer === "knowledge" ? "knowledge"
      : first.source_layer === "admin" ? `an admin${nameOf(first.actor) ? ` (${nameOf(first.actor)})` : ""}`
      : nameOf(first.actor) || "a colleague";
    const ref = first?.source_ref || {};
    const how = ref.document_id ? "document" : ref.conversation_id ? "conversation" : first?.source_layer === "admin" && who !== "you" ? "import" : "note";
    const count = new Set(rows.map((a) => a.source_ref?.document_id || a.source_ref?.conversation_id || a.actor)).size;
    return { who, how: count > 1 ? `${how}, ${count} sources` : how, date: first?.asserted_at ? String(first.asserted_at).slice(0, 10) : null, content: text, isSelf };
  };

  return memories.map((m) => {
    if (m.truth_status === "reported") {
      const first = (atts || []).find((a) => a.memory_id === m.id && a.stance === "reports");
      return { ...m, reporter: first ? (first.actor === identity.userId ? "you" : nameOf(first.actor) || "a colleague") : null };
    }
    if (m.truth_status !== "contested") return m;
    const s = open.get(m.id);
    const other = s?.counterpart_id ? (counterparts || []).find((c) => c.id === s.counterpart_id) : null;
    if (!s || !other) return m;                          // a single-proposition contest renders as a plain line
    const thisSide = describeSide(m.id, m.content, true);
    const otherSide = describeSide(other.id, other.content, false);
    const d = detail.get(m.id) || {};
    const subject = m.subject || d.subject || other.subject || null;
    const predicate = m.predicate || d.predicate || other.predicate || null;
    let basis = null;
    if (s.dimensions) {
      const asVote = { dimensions: Object.fromEntries(["authority", "independent", "confidence", "direct", "first_party"].map((k) => [k, s.dimensions[k] === "this" ? "a" : s.dimensions[k] === "other" ? "b" : "tie"])), winner: null, tally: { a: s.dimensions.tally?.this ?? 0, b: s.dimensions.tally?.other ?? 0 } };
      basis = describeVote(asVote, thisSide.who, otherSide.who);
    }
    return { ...m, subject, predicate, contest: { this: thisSide, other: otherSide, counterpartId: other.id, basis } };
  });
}

/**
 * Recall for one turn.
 *
 * @param {object} supabase
 * @param {object} openai
 * @param {{organizationId,namespaceId,userId}} identity
 * @param {{message, previousUserMessage?, settings?, embedding?, usage?, log?}} opts
 *   embedding: a query embedding to reuse (same model as documents) instead of embedding again
 *   usage: the turn's usage tally (lib/usage.js) to record the embedding call on
 * @returns {{ memories: object[], memoryIds: string[], block: string, tokens: number, query: string, candidates: number, ms: number }}
 */
export async function recallMemories(supabase, openai, identity, { message, previousUserMessage = null, settings = null, embedding = null, usage = null, log = null } = {}) {
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

  const vec = embedding || (await embedText(openai, query, { usage, stage: "recall_embed" }));
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
      .select("id, scope, kind, content, importance, access_count, last_accessed_at, created_at, truth_status, subject, predicate")
      .in("id", keywordOnly.map((r) => r.id))
      .eq("organization_id", identity.organizationId)
      .eq("namespace_id", identity.namespaceId)
      .eq("status", "active");
    for (const row of rows || []) byId.set(row.id, { ...row, similarity: null, keyword_rank: keywordOnly.find((r) => r.id === row.id)?.rank ?? null });
  }

  const candidates = [...byId.values()];
  const now = Date.now();
  const ranked = candidates
    .filter((r) => !r.truth_status || VISIBLE_TRUTH.includes(r.truth_status))            // denied, retracted, superseded: never shown (9.6)
    // a keyword match passes regardless of similarity: "Who is Tom?" sits at
    // 0.27 against "Tom Greer is the COO" yet the name is exactly what matters
    .filter((r) => r.keyword_rank != null || !Number.isFinite(r.similarity) || r.similarity >= floor)
    .map((r) => (r.keyword_rank != null && (!Number.isFinite(r.similarity) || r.similarity < floor) ? { ...r, similarity: floor } : r))
    .map((r) => ({ ...r, score: scoreMemory(r, { now, floor }) }))
    .sort((a, b) => b.score - a.score);

  // Trim: best first until the block reaches its token cap, never more than k.
  let chosen = [];
  let tokens = estimateTokens(MEMORY_BLOCK_HEADING);
  for (const r of ranked) {
    if (chosen.length >= k) break;
    const t = estimateTokens(lineFor(r)) + 1;
    if (tokens + t > blockTokens) continue;
    chosen.push(r);
    tokens += t;
  }

  // Contested and reported notes need their sides and reporters (9.6). A
  // contested pair renders once, and the block is re-measured afterwards
  // since a contested entry is several lines.
  chosen = await decorate(supabase, identity, chosen);
  const shown = new Set(chosen.map((m) => m.id));
  chosen = chosen.filter((m) => !(m.contest && shown.has(m.contest.counterpartId) && chosen.findIndex((x) => x.id === m.contest.counterpartId) < chosen.indexOf(m)));
  tokens = estimateTokens(MEMORY_BLOCK_HEADING) + chosen.reduce((sum, m) => sum + estimateTokens(lineFor(m)) + 1, 0);
  while (chosen.length > 1 && tokens > blockTokens) { const dropped = chosen.pop(); tokens -= estimateTokens(lineFor(dropped)) + 1; }

  const block = formatMemoryBlock(chosen);
  const result = {
    memories: chosen.map((r) => ({
      id: r.id, scope: r.scope, kind: r.kind, content: r.content, importance: r.importance, created_at: r.created_at || null,
      truth_status: r.truth_status || "accepted", counterpart_id: r.contest?.counterpartId || null,
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
