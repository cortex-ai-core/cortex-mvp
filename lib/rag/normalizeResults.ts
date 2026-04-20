// lib/rag/normalizeResults.ts
// Step 32F-4 — Standard Result Normalizer
// Ensures Cortéx returns a stable shape for all RAG search results.

export interface RawSearchResult {
  documentId: string;
  chunk: string;
  score?: number | null;
}

export interface NormalizedSearchResult {
  documentId: string;
  snippet: string;
  relevance: number;
}

/**
 * Normalize search results so the UI + chat logic never break.
 */
export function normalizeResults(
  results: RawSearchResult[]
): NormalizedSearchResult[] {
  if (!Array.isArray(results)) return [];

  return results.map((r) => ({
    documentId: r.documentId,
    snippet: r.chunk?.slice(0, 300) ?? "",
    relevance: typeof r.score === "number" ? r.score : 0
  }));
}

