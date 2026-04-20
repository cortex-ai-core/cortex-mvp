// ============================================================
//  CORTÉX — SEARCH ROUTE (RBAC + NAMESPACE SECURED)
//  Requires permission: view_documents
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export default fp(async function searchRoute(fastify) {

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  fastify.post(
    "/api/search",
   
    async (req, reply) => {
      try {
        const { query = "", topK = 5, namespace } = req.body || {};



        // --------------------------------------------------------
        // 🔒 Namespace Enforcement
        // super_admin bypasses all namespace restrictions
        // --------------------------------------------------------
        if (req.user.role !== "super_admin") {
          if (!namespace || namespace !== req.user.namespace) {
            return reply.code(403).send({
              error: "Namespace mismatch — access denied."
            });
          }
        }

        if (!query.trim()) {
          return reply.code(400).send({ error: "Query required." });
        }

        // --------------------------------------------------------
        // 1️⃣ Embed Query
        // --------------------------------------------------------
        const embedRes = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: query,
        });

        const queryEmbedding = embedRes.data[0].embedding;

        // --------------------------------------------------------
        // 2️⃣ Vector Search via Postgres RPC
        // --------------------------------------------------------
        const { data, error } = await supabase.rpc(
          "match_document_chunks",
          {
            query_embedding: queryEmbedding,
            match_count: topK,
            filter: { namespace }
          }
        );

        if (error) throw error;

        return reply.send({
          status: "success",
          query,
          topK,
          namespace,
          count: data?.length || 0,
          results: data || [],
          vectorSearchEnabled: true
        });

      } catch (err) {
        console.error("❌ SEARCH ERROR:", err);
        return reply.code(500).send({
          error: "Search failed.",
          detail: err.message,
        });
      }
    }
  );
});
