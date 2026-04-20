// tests/testRagSearch.js
// ======================================================
//  CORTÉX — RAG Search Test (Node 22 Safe Version)
// ======================================================

// FORCE dotenv to load (Node 22 does NOT autoload this)
import dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import { OpenAI } from "openai";

// Confirm environment
console.log("SUPABASE_URL:", process.env.SUPABASE_URL ? "loaded" : "MISSING");
console.log("SUPABASE_ANON_KEY:", process.env.SUPABASE_ANON_KEY ? "loaded" : "MISSING");

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Run RAG search test
async function main() {
  try {
    console.log("\nGenerating test embedding…");
    const embed = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "test query about hawaii community data"
    });

    console.log("Embedding length:", embed.data[0].embedding.length);

    const queryEmbedding = embed.data[0].embedding;

    console.log("Running RAG vector search…");

    const { data, error } = await supabase.rpc("cortex_vec_search", {
      query_embedding: queryEmbedding,
      match_count: 5,
      filter_metadata: {}
    });

    if (error) {
      console.error("VECTOR SEARCH ERROR:", error);
      return;
    }

    console.log("\n🔥 RAG RESULTS:");
    console.log(data);
  }
  catch (err) {
    console.error("RAG TEST ERROR:", err);
  }
}

main();

