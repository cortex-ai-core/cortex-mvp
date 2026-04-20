// utils/embed.js
// STEP 26A — Embedding engine for Cortéx RAG v1

import OpenAI from "openai";

// Initialize OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Produce an embedding vector from raw text
 * Returns a Float32Array (OpenAI standard)
 */
export async function getEmbedding(text) {
  if (!text || text.trim().length === 0) {
    return [];
  }

  try {
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });

    // Return the embedding vector
    return response.data[0].embedding;
  } catch (err) {
    console.error("Embedding error:", err);
    return [];
  }
}

