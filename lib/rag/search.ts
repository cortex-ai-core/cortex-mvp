// PURE SERVER RAG ENGINE (NO NEXT.JS IMPORTS)

import { supabase } from "../supabaseClient";
import OpenAI from "openai";

const openai = new OpenAI();

export async function ragSearch(query: string) {
  // 1. Generate embedding
  const embeddingRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });

  const embedding = embeddingRes.data[0].embedding;

  // 2. Query Supabase match_documents()
  const { data: rows, error } = await supabase.rpc("match_documents", {
    query_embedding: embedding,
    similarity_threshold: 0.1,
    match_count: 5,
  });

  if (error) throw error;

  // 3. Normalize output
  const results = (rows || []).map((r: any) => ({
    chunk: r.chunk,
    score: r.score,
    metadata: r.metadata,
  }));

  return {
    query,
    embedding_length: embedding.length,
    results,
    raw_rows: rows,
  };
}

