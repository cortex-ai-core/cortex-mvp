// lib/rag/embedChunks.js
// Step 32D-2 — Embedding Generator for Chunked Text

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function embedChunks(chunks) {
  const embeddings = [];

  for (const chunk of chunks) {
    const res = await client.embeddings.create({
      model: "text-embedding-3-large",
      input: chunk
    });

    embeddings.push(res.data[0].embedding);
  }

  return embeddings;
}

