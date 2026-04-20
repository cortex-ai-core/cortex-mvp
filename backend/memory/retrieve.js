// backend/memory/retrieve.js
// ------------------------------------------------------
// STEP 30I — Memory Semantic Search Engine
// ------------------------------------------------------

import { loadMemory } from "./memory.js";
import { embedMemoryText } from "./embed.js";

// Cosine similarity between two vectors
function cosineSim(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ------------------------------------------------------
// Retrieve memories relevant to a query
// ------------------------------------------------------
export async function searchMemory(query, topK = 5) {
  const memories = loadMemory();
  if (!memories || memories.length === 0) return [];

  // 1. Embed the query
  const queryEmbedding = await embedMemoryText(query);

  // 2. Score each memory by similarity
  const scored = memories
    .filter(m => m.embedding) // safety check
    .map(m => ({
      ...m,
      score: cosineSim(queryEmbedding, m.embedding)
    }));

  // 3. Sort by descending similarity
  scored.sort((a, b) => b.score - a.score);

  // 4. Return topK
  return scored.slice(0, topK);
}

