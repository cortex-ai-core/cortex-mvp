// ============================================================
//  CORTÉX — MEMORY QUERY ENDPOINT (MVP)
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { searchVectors as _searchVectors } from "../../lib/vectorClient.js";

// ============================================================
// SAFE VECTOR CLIENT INIT
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
    console.warn("⚠️ MEMORY QUERY: Supabase config missing — vector search disabled.");
  }
} catch (err) {
  console.warn("⚠️ MEMORY QUERY: Failed to initialize vector client:", err);
  vectorEnvOK = false;
}

const EMBEDDING_MODEL = "text-embedding-3-small";

export default fp(async function memoryQueryRoute(fastify) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ============================================================
  // POST /api/memory/query    ← FIXED
  // ============================================================
  fastify.post("/api/memory/query", async (req, reply) => {
    try {
      const { query = "", topK = 5, metadata = {} } = req.body || {};

      if (!query.trim()) {
        return reply.code(400).send({ error: "Query text is required." });
      }

      // 1️⃣ Embed query
      const embedRes = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: query,
      });

      const embedding = embedRes.data?.[0]?.embedding;
      if (!embedding) throw new Error("Failed to generate embedding.");

      // 2️⃣ Vector DB disabled → structured fallback
      if (!vectorEnvOK || typeof searchVectors !== "function") {
        return reply.send({
          status: "vector_db_disabled",
          query,
          topK,
          count: 0,
          results: [],
          warning: "Vector search unavailable.",
        });
      }

      // 3️⃣ Perform similarity search
      const results = await searchVectors(embedding, topK, metadata);

      const formatted = (results || []).map((r) => ({
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
      console.error("MEMORY QUERY ERROR:", err);
      return reply.code(500).send({
        error: "Memory query failed.",
        detail: err.message,
      });
    }
  });
});
