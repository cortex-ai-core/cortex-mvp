// backend/lib/vectorClient.js
// =============================================================
//  CORTÉX VECTOR CLIENT — unified search + upsert + query
//  Full Stage-46 compatibility with restored backend routes
// =============================================================

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

export const VECTOR_ENV_OK = !!(url && key);

let supabase = null;

if (VECTOR_ENV_OK) {
  supabase = createClient(url, key, {
    auth: { persistSession: false },
  });
}

// -------------------------------------------------------------
// 1️⃣ SEARCH FUNCTION (Your original implementation)
// -------------------------------------------------------------
export async function searchVectors(queryEmbedding, topK = 5, filter = {}) {
  if (!VECTOR_ENV_OK || !supabase) {
    console.warn("⚠️ Vector search skipped — missing Supabase env.");
    return [];
  }

  const { data, error } = await supabase.rpc("match_document_chunks", {
    query_embedding: queryEmbedding,
    match_count: topK,
    filter: filter || {},
  });

  if (error) {
    console.error("VECTOR SEARCH ERROR:", error);
    return [];
  }

  return data || [];
}

// -------------------------------------------------------------
// 2️⃣ UPSERT FUNCTION (Required by memoryUpdate.js & ingest.js)
// -------------------------------------------------------------
export async function upsertVectors(chunks = []) {
  if (!VECTOR_ENV_OK || !supabase) {
    console.warn("⚠️ Vector upsert skipped — missing Supabase env.");
    return { error: "Supabase not configured." };
  }

  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { error: "No chunks provided." };
  }

  const { data, error } = await supabase
    .from("document_chunks")
    .upsert(chunks, { onConflict: "id" });

  return { data, error };
}

// -------------------------------------------------------------
// 3️⃣ QUERY FUNCTION (Required by rag.js, memoryQuery.js)
// -------------------------------------------------------------
export async function queryVectors(namespace, embedding, matchCount = 5) {
  if (!VECTOR_ENV_OK || !supabase) {
    console.warn("⚠️ Vector query skipped — missing Supabase env.");
    return { error: "Supabase not configured." };
  }

  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: embedding,
    query_namespace: namespace,
    match_count: matchCount,
  });

  return { data, error };
}
