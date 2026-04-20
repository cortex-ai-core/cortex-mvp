// ============================================================
//  CORTÉX — MEMORY INTEGRITY CHECK ENDPOINT (MVP)
// ============================================================

import fp from "fastify-plugin";
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
    console.warn("⚠️ MEMORY INTEGRITY: Missing SUPABASE config — vector checks disabled.");
  }
} catch (err) {
  console.warn("⚠️ MEMORY INTEGRITY: Failed to initialize vector client:", err);
  vectorEnvOK = false;
}

// ============================================================
// EXPORT ROUTE
// ============================================================
export default fp(async function memoryIntegrityRoute(fastify) {

  fastify.get("/api/memory/integrity", async (req, reply) => {
    try {
      const integrityReport = {
        status: "ok",
        vector_env: vectorEnvOK ? "loaded" : "missing",
        vector_search: "skipped",
        sample_test: null,
        warnings: [],
      };

      if (!vectorEnvOK || !searchVectors) {
        integrityReport.status = "degraded";
        integrityReport.warnings.push(
          "Vector DB disabled — SUPABASE_URL or SUPABASE_SERVICE_KEY missing."
        );
        return reply.send(integrityReport);
      }

      const testEmbedding = Array(1536).fill(0.001);

      try {
        const testResults = await searchVectors(testEmbedding, 1);
        integrityReport.vector_search = "ok";
        integrityReport.sample_test = {
          received: testResults.length,
          sample: testResults[0] || null,
        };
      } catch (err) {
        integrityReport.status = "error";
        integrityReport.vector_search = "failed";
        integrityReport.warnings.push("Vector search RPC failed.");
        integrityReport.warnings.push(err.message);
      }

      return reply.send(integrityReport);

    } catch (err) {
      console.error("MEMORY INTEGRITY ERROR:", err);
      return reply.code(500).send({
        error: "Memory integrity check failed.",
        detail: err.message,
      });
    }
  });
});
