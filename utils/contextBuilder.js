// ============================================================
//  CORTÉX — CONTEXT BUILDER
//  Step 40B — Structured Retrieval Layer
// ============================================================

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------
// ENV + CLIENTS
// ----------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ----------------------------------------
// CONFIG
// ----------------------------------------
const EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_TOP_K = 5;

// ----------------------------------------
// BUILD CONTEXT
// ----------------------------------------
export async function buildContext(query, options = {}) {
  const { topK = DEFAULT_TOP_K, filters = null } = options;

  if (!query || typeof query !== "string") {
    throw new Error("ContextBuilder: Query required.");
  }

  // 1️⃣ Embed the query
  const embeddingRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: query,
  });

  const queryVector = embeddingRes.data[0].embedding;

  // 2️⃣ Call vector search RPC
  const rpcParams = {
    query_embedding: queryVector,
    match_count: topK,
  };

  // Only include filter if provided
  if (filters && Object.keys(filters).length > 0) {
    rpcParams.filter = filters;
  }

  const { data, error } = await supabase.rpc(
    "match_document_chunks",
    rpcParams
  );

  if (error) {
    console.error("ContextBuilder Search Error:", error);
    throw new Error("Vector search failed.");
  }

  if (!data || data.length === 0) {
    return {
      context: "",
      matches: [],
      matchCount: 0,
    };
  }

  // 3️⃣ Format context cleanly
  const formattedContext = data
    .map((item, index) => {
      return `SOURCE ${index + 1}:\n${item.chunk_text}`;
    })
    .join("\n\n----------------------\n\n");

  return {
    context: formattedContext,
    matches: data,
    matchCount: data.length,
  };
}

