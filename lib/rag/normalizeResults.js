// ===============================================
//  CORTÉX — normalizeResults.js
//  Standardizes RAG search output (JS version)
// ===============================================

/**
 * Normalize raw RAG rows into a stable structure.
 *
 * @param {Array} rows - raw rows returned from Supabase.
 * @returns {Array} standardized objects:
 *   { snippet, relevance, metadata }
 */
export function normalizeResults(rows = []) {
  if (!Array.isArray(rows)) return [];

  return rows.map(r => ({
    snippet: r.chunk ? String(r.chunk).slice(0, 300) : "",
    relevance: typeof r.score === "number" ? r.score : 0,
    metadata: r.metadata || {}
  }));
}

