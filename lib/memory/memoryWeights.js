// lib/memory/memoryWeights.js

export function applyWeights(results) {
  const now = Date.now();

  return results
    .map((r) => {
      const ageDays =
        (now - r.metadata.timestamp) / (1000 * 60 * 60 * 24);

      const temporalWeight = 1 / (1 + ageDays); // recency boost

      const finalScore =
        r.score * 0.65 +              // similarity
        r.metadata.priority * 0.25 +  // King priority (1–10)
        temporalWeight * 0.10;        // recency weighting

      return {
        ...r,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}

