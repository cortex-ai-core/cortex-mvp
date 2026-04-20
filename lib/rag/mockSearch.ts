// lib/rag/mockSearch.ts
// Step 32F-2 — Temporary mock search engine.
// Replaced in Step 34 with real embeddings + pgvector similarity search.

export async function mockRagSearch(query: string) {
  return [
    {
      documentId: "mock-doc-1",
      chunkText: "This is a mock RAG match for testing.",
      score: 0.82
    },
    {
      documentId: "mock-doc-2",
      chunkText: "Another simulated match to confirm wiring.",
      score: 0.61
    }
  ];
}

