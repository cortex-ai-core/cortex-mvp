// backend/routes/memorySearch.js
// ============================================================
//  CORTÉX — MEMORY VECTOR SEARCH (MVP)
// ============================================================

import fp from "fastify-plugin";
import { searchVectors as _searchVectors } from "../../lib/vectorClient.js";
import OpenAI from "openai";

// ============================================================
// SAFE LAZY LOAD FLAGS
// ============================================================
let searchVectors = null;
let vectorEnvOK = false;

try {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (url && key) {
    vectorEnvOK = true;
    searchVectors = _searchVectors;
  } else {
    console.warn("⚠️ MEMORY SEARCH: Supabase env missing — vector search disabled.");
  }
} catch (err) {
  console.warn("⚠️ MEMORY SEARCH: Failed to initialize vectorClient.js — disabling search.", err);
  vectorEnvOK = false;
}

const EMBEDDING_MODEL = "text-embedding-3-small";

export default fp(async function memorySearchRoute(fastify) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ============================================================
  // POST /api/memory/search   ← FIXED
  // ============================================================
  fastify.post("/api/memory/search", async (req, reply) => {
    try {
      const { query = "", topK = 5, metadata = {} } = req.body || {};

      if (!query.trim()) {
        return reply.code(400).send({ error: "Query text is required." });
      }

      // 1️⃣ Embed text
      const embedRes = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: query,
      });

      const queryEmbedding = embedRes.data?.[0]?.embedding;
      if (!queryEmbedding) throw new Error("Failed to generate memory search embedding.");

      // 2️⃣ Vector DB disabled → fallback
      if (!vectorEnvOK || typeof searchVectors !== "function") {
        return reply.send({
          status: "vector_db_disabled",
          query,
          topK,
          count: 0,
          results: [],
          warning: "Supabase vector search unavailable.",
        });
      }

      // 3️⃣ Perform similarity search
      const results = await searchVectors(queryEmbedding, topK, metadata);

      const formatted = results.map((r) => ({
        id: r.id,
        text: r.text,
        metadata: r.metadata,
        similarity: r.similarity,
      }));

      return reply.send({
        status: "success",
        query,
        topK,
        count: formatted.length,
        results: formatted,
      });

    } catch (err) {
      console.error("MEMORY SEARCH ERROR:", err);
      return reply.code(500).send({
        error: "Memory search failed.",
        detail: err.message,
      });
    }
  });
});
