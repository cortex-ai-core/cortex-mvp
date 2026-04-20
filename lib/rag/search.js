// ===============================================
//  CORTÉX — Pure JavaScript RAG Search Engine
//  Uses Supabase match_documents() + OpenAI Embeddings
// ===============================================

import { supabase } from "../supabaseClient.js";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --------------------------------------------------
// RAG SEARCH FUNCTION
// --------------------------------------------------
export async function ragSearch(query) {
  if (!query || typeof query !== "string") {
    throw new Error("ragSearch() requires a query string.");
  }

  // 1. Generate embedding for the query text
  const embeddingRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query
  });

  const embedding = embeddingRes.data[0].embedding;

  // 2. Supabase similarity search
  const { data: rows, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    similarity_threshold: 0.1,
    match_count: 5
  });

  if (error) {
    console.error("❌ Supabase RAG error:", error);
    throw error;
  }

  // 3. Normalize rows → stable shape
  const results = (rows || []).map(r => ({
    chunk: r.chunk || "",
    score: r.score || 0,
    metadata: r.metadata || {}
  }));

  return {
    ok: true,
    query,
    embedding_length: embedding.length,
    results
  };
}

