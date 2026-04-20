// ============================================================
//  CORTÉX — RAG RETRIEVAL ROUTE
//  Deprecated RBAC removed — Step 47 Identity Layer will enforce access
// ============================================================

import fp from "fastify-plugin";
import { searchVectors } from "../../lib/vectorClient.js";

export default fp(async function ragRoute(fastify, opts) {

  fastify.post(
    "/api/rag",
    {
      // ❌ Removed: requirePermission("rag_query")
      // Identity enforcement will be added in Step 47
    },
    async (req, reply) => {
      try {
        const { query, namespace } = req.body || {};

        if (!query || typeof query !== "string") {
          return reply.code(400).send({ error: "Invalid or missing 'query' field" });
        }

        // 🔒 Namespace enforcement (super_admin bypass)
        if (req.user?.role !== "super_admin") {
          if (!namespace || namespace !== req.user?.namespace) {
            return reply.code(403).send({
              error: "Namespace mismatch — access denied."
            });
          }
        }

        // Execute vector search
        const results = await searchVectors({
          text: query,
          namespace: namespace || req.user?.namespace
        });

        return reply.send({
          results: results || [],
          count: results?.length || 0
        });

      } catch (err) {
        console.error("❌ RAG route error:", err);
        return reply.code(500).send({
          error: "RAG retrieval failed",
          details: err.message
        });
      }
    }
  );

});
