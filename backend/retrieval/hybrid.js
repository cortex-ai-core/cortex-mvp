// =============================================================
//  Hybrid retrieval (Phase 2)
//  One SQL call: vector + full-text with reciprocal rank fusion,
//  per-document cap, optional restriction to named documents.
//  Returns the same result shape the chat route already consumes.
//
//  Named documents come in two strengths (see findNamedDocuments in
//  routes/retrieve.js): a *filter* match (a code such as LEE_3311)
//  restricts both search legs to that document; a *boost* match (a
//  partial name, or any name in a comparison question) guarantees the
//  document is represented and lifts its chunks, without excluding
//  anything else.
// =============================================================

const DEFAULTS = {
  matchCount: Number(process.env.HYBRID_MATCH_COUNT || 14),
  perDocumentCap: Number(process.env.HYBRID_PER_DOC_CAP || 5),
  // One RRF rank-1 is worth 1/(60+1) ≈ 0.0164. A heading that repeats several of
  // the question's words names the answer ("Core Education Requirements: 13
  // credits"), so the boost grows with distinct whole-word hits up to ~2 rank-1s.
  sectionBoost: Number(process.env.HYBRID_SECTION_BOOST || 0.006),
  sectionBoostMaxHits: Number(process.env.HYBRID_SECTION_BOOST_MAX_HITS || 5),
  perDocumentCapNamed: Number(process.env.HYBRID_PER_DOC_CAP_NAMED || 8),   // a document the question names may fill more slots
  // A code in the question ("FG", "ED 277", "K252984") is a precise handle that
  // full-text ranking treats as an ordinary word; a chunk that contains it as a
  // whole word gets about one rank-1 per distinct code (capped).
  codeBoost: Number(process.env.HYBRID_CODE_BOOST || 0.012),
  codeBoostMaxHits: Number(process.env.HYBRID_CODE_BOOST_MAX_HITS || 2),
  // A boost-named document is guaranteed a presence in the candidates (see the
  // second search below) but gets no score bonus by default: "the executive
  // internship" must not outrank the file that actually answers the question.
  namedBoost: Number(process.env.HYBRID_NAMED_BOOST ?? 0),
  namedBoostCount: Number(process.env.HYBRID_NAMED_BOOST_COUNT || 6),        // chunks fetched per boost-named document
  namedReserve: Number(process.env.HYBRID_NAMED_RESERVE || 3),               // chunks guaranteed a place in the final cut
  // Document prior: chunks of the documents whose profile is closest to the
  // question rise by up to one rank-1; strays from unrelated documents do not.
  docPriorWeight: Number(process.env.HYBRID_DOC_PRIOR || 0.0164),
  // Focus: once the question is about particular documents (named, or the
  // clear semantic leader), any other document keeps at most this many chunks.
  focusOtherCap: Number(process.env.HYBRID_FOCUS_OTHER_CAP || 2),
  neighborAnchors: Number(process.env.HYBRID_NEIGHBOR_ANCHORS || 3),         // expand the top N hits
  neighborRadiusTop: Number(process.env.HYBRID_NEIGHBOR_RADIUS_TOP || 2),    // ±2 around the best hit (lists run long)
  neighborRadius: Number(process.env.HYBRID_NEIGHBOR_RADIUS || 1),           // ±1 around the others
  neighborScoreFactor: Number(process.env.HYBRID_NEIGHBOR_FACTOR || 0.9),
  listRunMax: Number(process.env.HYBRID_LIST_RUN_MAX || 6),                  // follow a list/table run this far
  contextBudget: Number(process.env.HYBRID_CONTEXT_CHARS || 16000),
  // Fused score below which a candidate is noise: a chunk found by one leg only at
  // rank 20 scores 1/(60+20) = 0.0125; the tail of the pool sits near 0.008 and
  // only adds unrelated text to the prompt.
  minScore: Number(process.env.HYBRID_MIN_SCORE || 0.011),
  namedMatchCount: Number(process.env.HYBRID_NAMED_MATCH_COUNT || 24),
  namedContextBudget: Number(process.env.HYBRID_NAMED_CONTEXT_CHARS || 16000),
  semanticWeight: Number(process.env.HYBRID_SEMANTIC_WEIGHT || 1.0),
  keywordWeight: Number(process.env.HYBRID_KEYWORD_WEIGHT || 1.0),
  rrfK: Number(process.env.HYBRID_RRF_K || 60),
};

const CHUNK_SELECT =
  "id, document_id, chunk_index, item_kind, chunk_text, page_start, page_end, section_label, documents(file_name, display_name)";

// websearch_to_tsquery ANDs plain words, so a whole question never matches a chunk.
// Send the content words joined with "or" instead; ts_rank_cd still rewards chunks
// that match more of them. Quoted phrases in the question are kept as phrases.
const KEYWORD_STOP = new Set(["the","and","for","with","from","that","this","what","which","who","how","does","did","are","was","were","can","could","would","should","into","about","between","there","their","them","they","have","has","had","not","but","any","all","its","our","you","your","when","where","why","will","than","then","also","much","many","more","most","some","such","just","like","make","made","list","describe","summarize","summary","overview","document","documents","file","files","program","please","tell","give","show","explain","or","if","is"]);

export function keywordTerms(question = "") {
  const phrases = [...String(question).matchAll(/"([^"]{3,})"/g)].map(m => `"${m[1].trim()}"`);
  // keep 2-letter uppercase codes ("FG", "ED", "DA") and anything with a digit ("ED 277", "K252984")
  const raw = String(question)
    .replace(/"[^"]*"/g, " ")
    .split(/[^A-Za-z0-9_-]+/)
    .map(w => w.replace(/^[-_]+|[-_]+$/g, ""))            // a leading "-" would negate the term
    .filter(w => w.length >= 3 || (w.length === 2 && /^[A-Z0-9]{2}$/.test(w)));
  const words = [];
  for (const w of raw) {
    const lower = w.toLowerCase();
    if (KEYWORD_STOP.has(lower)) continue;
    // A code such as LEE_3311 or SW-CORE-03 is indexed as adjacent words, so it is
    // searched as a phrase, and its parts are added so a partial mention still counts.
    if (/[_-]/.test(lower)) {
      const parts = lower.split(/[_-]+/).filter(p => p.length >= 2);
      if (parts.length > 1) words.push(`"${parts.join(" ")}"`);
      for (const p of parts) if (p.length >= 3 || /\d/.test(p)) words.push(p);
    } else {
      words.push(lower);
    }
  }
  return [...new Set([...phrases, ...words])];
}

export function keywordQuery(question = "") {
  return keywordTerms(question).join(" or ");
}

function toResult(row, extra = {}) {
  return {
    content: (row.chunk_text || "").replace(/\s+/g, " ").trim(),
    similarity: row.similarity ?? null,          // cosine, when the semantic leg found it
    score: row.score ?? null,                    // fused RRF score
    semantic_rank: row.semantic_rank ?? null,
    keyword_rank: row.keyword_rank ?? null,
    filename: row.file_name || null,
    display_name: row.display_name || null,
    document_id: row.document_id,
    chunk_id: row.chunk_id || row.id,
    chunk_index: row.chunk_index ?? null,
    page_start: row.page_start ?? null,
    page_end: row.page_end ?? null,
    section_label: row.section_label || null,
    item_kind: row.item_kind ?? null,
    ...extra,
  };
}

function fromChunkRow(c, score, extra) {
  return toResult(
    { ...c, chunk_id: c.id, file_name: c.documents?.file_name, display_name: c.documents?.display_name, score, similarity: null },
    extra
  );
}

const byScoreDesc = (a, b) => (b.score || 0) - (a.score || 0);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {object} args
 * @param {import("@supabase/supabase-js").SupabaseClient} args.supabase
 * @param {string} args.query            raw user question (normalized lightly)
 * @param {number[]} args.embedding      query embedding
 * @param {string} args.namespaceId    namespace uuid (the only namespace key)
 * @param {{id:string,file_name:string,filter?:boolean}[]} args.namedDocs  documents the question names, if any
 * @param {object} [args.log]
 */
export async function hybridRetrieve({ supabase, query, embedding, namespaceId, namedDocs = [], docScores = [], log }) {
  const filterDocs = namedDocs.filter((d) => d.filter === true);
  const boostDocs = namedDocs.filter((d) => d.filter !== true);
  const named = filterDocs.length > 0;
  const matchCount = named ? DEFAULTS.namedMatchCount : DEFAULTS.matchCount;
  const budget = named ? DEFAULTS.namedContextBudget : DEFAULTS.contextBudget;
  const terms = keywordTerms(query);
  const queryText = terms.join(" or ") || query;

  const search = (params) =>
    supabase.rpc("hybrid_search", {
      query_text: queryText,
      query_embedding: embedding,
      query_namespace_id: namespaceId,
      semantic_weight: DEFAULTS.semanticWeight,
      keyword_weight: DEFAULTS.keywordWeight,
      rrf_k: DEFAULTS.rrfK,
      ...params,
    });

  // Main search, plus (in parallel) a small search restricted to boost-named
  // documents so each of them is represented even when the question's wording
  // favours another file.
  const calls = [
    search({
      match_count: named ? matchCount : Math.max(matchCount * 3, 40),
      per_document_cap: named ? 1000 : Math.max(DEFAULTS.perDocumentCap * 4, 20),
      filter_document_ids: named ? filterDocs.map((d) => d.id) : null,
    }),
  ];
  if (!named && boostDocs.length) {
    calls.push(
      search({
        match_count: DEFAULTS.namedBoostCount * boostDocs.length,
        per_document_cap: DEFAULTS.namedBoostCount,
        filter_document_ids: boostDocs.map((d) => d.id),
      })
    );
  }
  const [main, boosted] = await Promise.all(calls);
  if (main.error) throw new Error(`hybrid_search failed: ${main.error.message}`);

  let results = (main.data || []).map((r) => toResult(r));

  if (boosted) {
    if (boosted.error) log?.warn?.({ route: "/api/retrieve", error: boosted.error.message }, "hybrid: named-document boost search failed");
    const have = new Set(results.map((r) => r.chunk_id));
    for (const row of boosted.data || []) {
      const id = row.chunk_id || row.id;
      if (have.has(id)) continue;
      have.add(id);
      results.push(toResult(row, { named_boost: true }));
    }
  }
  if (boostDocs.length && DEFAULTS.namedBoost > 0) {
    const ids = new Set(boostDocs.map((d) => d.id));
    for (const r of results) if (ids.has(r.document_id)) r.score = (r.score || 0) + DEFAULTS.namedBoost;
  }

  // Field weighting the SQL cannot do yet: a query term that appears as a whole
  // word in the chunk's section heading is a strong signal (the heading names the
  // topic). Capped so it re-ranks rather than dominates the fused score.
  const headingTerms = terms
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length >= 3)
    .map((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, "i"));
  if (headingTerms.length && DEFAULTS.sectionBoost > 0) {
    for (const r of results) {
      const label = r.section_label || "";
      if (!label) continue;
      const hits = Math.min(headingTerms.filter((re) => re.test(label)).length, DEFAULTS.sectionBoostMaxHits);
      if (hits) r.score = (r.score || 0) + DEFAULTS.sectionBoost * hits;
    }
  }
  const codeTerms = [...new Set(
    String(query).split(/[^A-Za-z0-9_-]+/)
      .map(w => w.replace(/^[-_]+|[-_]+$/g, ""))
      .filter(w => w.length >= 2 && w.length <= 12 && (/^[A-Z]{2,5}$/.test(w) || (/\d/.test(w) && /[A-Za-z]/.test(w))))
      .filter(w => !KEYWORD_STOP.has(w.toLowerCase()))
  )].map(w => new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(w)}(?![A-Za-z0-9])`, "i"));
  if (codeTerms.length && DEFAULTS.codeBoost > 0 && results.length) {
    // A code that appears in most candidates ("AST" throughout an AST program
    // review) does not discriminate; only rare codes boost.
    const perTerm = codeTerms.map((re) => results.filter((r) => re.test(r.content)));
    const rare = codeTerms.filter((re, i) => perTerm[i].length && perTerm[i].length <= Math.max(3, results.length * 0.3));
    for (const r of results) {
      const hits = Math.min(rare.filter((re) => re.test(r.content)).length, DEFAULTS.codeBoostMaxHits);
      if (hits) r.score = (r.score || 0) + DEFAULTS.codeBoost * hits;
    }
  }
  if (docScores.length && DEFAULTS.docPriorWeight > 0) {
    const sims = docScores.map((d) => Number(d.similarity) || 0);
    const max = Math.max(...sims), min = Math.min(...sims);
    const prior = new Map(docScores.map((d) => [d.id, max > min ? ((Number(d.similarity) || 0) - min) / (max - min) : 1]));
    for (const r of results) {
      const p = prior.get(r.document_id);
      if (p) r.score = (r.score || 0) + DEFAULTS.docPriorWeight * p;
    }
  }
  results.sort(byScoreDesc);

  // Per-document cap and final cut, applied after the re-rank so a boosted
  // section is never squeezed out by its own document's generic chunks.
  let core = results;
  if (!named) {
    if (DEFAULTS.minScore > 0 && results.filter((r) => (r.score || 0) >= DEFAULTS.minScore).length >= 3) {
      results = results.filter((r) => (r.score || 0) >= DEFAULTS.minScore);
    }
    const boostIds = new Set(boostDocs.map((d) => d.id));
    const perDoc = new Map();
    core = results.filter((r) => {
      const n = (perDoc.get(r.document_id) || 0) + 1;
      perDoc.set(r.document_id, n);
      const cap = boostIds.has(r.document_id)
        ? DEFAULTS.perDocumentCapNamed
        : boostIds.size ? DEFAULTS.focusOtherCap : DEFAULTS.perDocumentCap;
      return n <= cap;
    }).slice(0, matchCount);

    // A document the question names by name keeps a few slots even when the
    // question's wording favours other files (the other side of a comparison).
    if (boostIds.size && DEFAULTS.namedReserve > 0) {
      const inCore = new Set(core.map((r) => r.chunk_id));
      for (const id of boostIds) {
        const present = core.filter((r) => r.document_id === id).length;
        if (present >= DEFAULTS.namedReserve) continue;
        const extra = results
          .filter((r) => r.document_id === id && !inCore.has(r.chunk_id))
          .slice(0, DEFAULTS.namedReserve - present);
        for (const r of extra) { inCore.add(r.chunk_id); core.push({ ...r, named_reserve: true }); }
      }
    }
  }

  // Overview questions about a named document score low on similarity; make sure
  // the document's opening sections are present, in reading order.
  if (named && core.length < 6) {
    const have = new Set(core.map((r) => r.chunk_id));
    const { data: lead } = await supabase
      .from("document_chunks")
      .select(CHUNK_SELECT)
      .in("document_id", filterDocs.map((d) => d.id))
      .order("chunk_index", { ascending: true })
      .limit(matchCount);
    for (const c of lead || []) {
      if (have.has(c.id)) continue;
      core.push(fromChunkRow(c, 0, { topped_up: true }));
    }
  }

  // Context expansion around the top hits, one range query per anchor, all in
  // parallel (one round trip instead of four):
  //  - neighbors: lists and tables often straddle a chunk boundary, so the chunks
  //    immediately before and after each anchor come along, scored just below it;
  //  - list run: a requirements list or table the chunker cut into several list
  //    chunks is followed forward while the chunks stay list/table.
  // Skipped for filter-named documents, which already get a wide cut.
  const extras = [];
  if (!named && core.length && (DEFAULTS.neighborAnchors > 0)) {
    const anchors = core.slice(0, DEFAULTS.neighborAnchors).filter((r) => r.chunk_index != null);
    const have = new Set(core.map((r) => r.chunk_id));
    const radiusOf = (i) => (i === 0 ? DEFAULTS.neighborRadiusTop : DEFAULTS.neighborRadius);
    const ranges = await Promise.all(
      anchors.map((a, i) =>
        supabase
          .from("document_chunks")
          .select(CHUNK_SELECT)
          .eq("document_id", a.document_id)
          .gte("chunk_index", Math.max(0, a.chunk_index - radiusOf(i)))
          .lte("chunk_index", a.chunk_index + Math.max(radiusOf(i), DEFAULTS.listRunMax))
          .order("chunk_index", { ascending: true })
      )
    );
    anchors.forEach((a, i) => {
      const rows = ranges[i]?.data || [];
      if (ranges[i]?.error) log?.warn?.({ route: "/api/retrieve", error: ranges[i].error.message }, "hybrid: expansion query failed");
      const byIdx = new Map(rows.map((c) => [c.chunk_index, c]));
      const radius = radiusOf(i);
      for (let d = -radius; d <= radius; d++) {
        if (d === 0) continue;
        const c = byIdx.get(a.chunk_index + d);
        if (!c || have.has(c.id)) continue;
        have.add(c.id);
        // farther neighbors score a little lower than nearer ones
        extras.push(fromChunkRow(c, (a.score || 0) * Math.pow(DEFAULTS.neighborScoreFactor, Math.abs(d)), { neighbor_of: a.chunk_index }));
      }
      if (DEFAULTS.listRunMax > 0) {
        let step = 0;
        for (let idx = a.chunk_index + 1; idx <= a.chunk_index + DEFAULTS.listRunMax; idx++) {
          const c = byIdx.get(idx);
          if (!c || !["list", "table"].includes(c.item_kind)) break;   // the run ended
          step += 1;
          if (have.has(c.id)) continue;
          have.add(c.id);
          extras.push(fromChunkRow(c, (a.score || 0) * Math.pow(DEFAULTS.neighborScoreFactor, step), { list_run_of: a.chunk_index }));
        }
      }
    });
    extras.sort(byScoreDesc);
  }

  // Context budget: the real hits are kept first (so context around the best hit
  // never displaces another document's best chunk), then expansions fill what is
  // left. Score order within each group.
  let chars = 0;
  const kept = [];
  for (const r of core) {
    if (!r.content) continue;
    if (chars + r.content.length > budget && kept.length >= 3) break;
    chars += r.content.length;
    kept.push(r);
  }
  for (const r of extras) {
    if (!r.content) continue;
    if (chars + r.content.length > budget) continue;
    chars += r.content.length;
    kept.push(r);
  }

  // Results stay in rank order here (the API contract); the chat route arranges
  // them in reading order when it builds the prompt.

  log?.info?.({
    route: "/api/retrieve",
    mode: "hybrid",
    namespaceId,
    named: filterDocs.map((d) => d.file_name),
    boosted: boostDocs.map((d) => d.file_name),
    candidates: results.length + extras.length,
    kept: kept.length,
    chars,
  });

  return { results: kept, candidates: results.length + extras.length };
}
