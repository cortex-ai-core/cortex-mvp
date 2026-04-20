// lib/memory/memoryWeights.ts

interface MemoryMatch {
  memoryId: string;
  text: string;
  score: number; // similarity score
  metadata: {
    priority: number;     // King-weighted priority (1–10)
    timestamp: number;    // Unix epoch
  };
}

export function applyWeights(results: MemoryMatch[]) {
  const now = Date.now();

  return results
    .map((r) => {
      const ageDays =
        (now - r.metadata.timestamp) / (1000 * 60 * 60 * 24);

      const temporalWeight = 1 / (1 + ageDays); // recency boost

      const finalScore =
        r.score * 0.65 +                     // similarity
        r.metadata.priority * 0.25 +         // King priority
        temporalWeight * 0.10;               // recency

      return {
        ...r,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

