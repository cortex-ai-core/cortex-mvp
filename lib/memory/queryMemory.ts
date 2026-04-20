// lib/memory/queryMemory.ts
import { embedText } from "../embedding.js";
import { vectorStore } from "../vectorStore.js";


interface QueryMemoryInput {
  query: string;
  topK?: number;
}

export async function queryMemory({ query, topK = 5 }: QueryMemoryInput) {
  // 1. Convert query text → embedding vector
  const queryEmbedding = await embedText(query);

  // 2. Preliminary vector search (raw results)
  //    We fetch extra results (topK * 3) so weighting can refine them later
  const rawMatches = await vectorStore.search(queryEmbedding, topK * 3);

  // 3. Weighting is implemented in 30J-3
  //    For now return only the top raw results
  return rawMatches.slice(0, topK);
}

