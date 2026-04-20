// backend/memory/embed.js
// ------------------------------------------------------
// STEP 30G — Embedding Generator for Memory
// ------------------------------------------------------

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Clean text before embedding
function normalizeText(text) {
  if (!text) return "";
  return text.trim().replace(/\s+/g, " ");
}

// Generate embedding vector
export async function embedMemoryText(text) {
  const cleaned = normalizeText(text);

  const response = await client.embeddings.create({
    model: "text-embedding-3-large",
    input: cleaned
  });

  return response.data[0].embedding; // vector array
}

