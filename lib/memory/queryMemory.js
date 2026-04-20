// lib/memory/queryMemory.js
import { embedText } from "../embedding.js";
import { vectorStore } from "../vectorStore.js";

export async function queryMemory({ query, topK = 5 }) {
  try {
    const queryEmbedding = await embedText(query);

    // Pull extra matches for weighting
    const rawMatches = await vectorStore.search(queryEmbedding, topK * 3);

    return {
      ok: true,
      raw: Array.isArray(rawMatches) ? rawMatches.slice(0, topK) : []
    };

  } catch (err) {
    console.error("❌ queryMemory() error:", err);

    return {
      ok: false,
      raw: []
    };
  }
}

