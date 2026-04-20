// lib/embedding.ts
// Temporary mock embedding function until Step 31 (real RAG pipeline)

export async function embedText(text: string): Promise<number[]> {
  // Return a simple deterministic mock embedding for now
  // (Just enough for Step 30 memory-query pipeline to run)
  const length = text.length;

  return [
    (length % 10) / 10,
    (length % 7) / 7,
    (length % 5) / 5
  ];
}

