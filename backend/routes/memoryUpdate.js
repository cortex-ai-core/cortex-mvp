// ============================================================
//  CORTÉX — MEMORY UPDATE ROUTE (NAMESPACE SECURED)
//  Legacy RBAC removed — Identity Layer (Step 47) will handle auth
// ============================================================

import fp from "fastify-plugin";
import { storeMemory } from "../memory/memory.js";
import { upsertVectors } from "../../lib/vectorClient.js";

// NOTE: requirePermission is deprecated and removed in Step 44+
// import { requirePermission } from "../lib/authMiddleware.js";

export default fp(async function memoryUpdateRoute(fastify, opts) {

  fastify.post(
    "/api/memory/update",
    {
      // ❌ Removed: requirePermission("upload_ephemeral")
      // RBAC will be handled via identity in Step 47
    },
    async (req, reply) => {
      try {
        const body = req.body;

        if (!body || typeof body !== "object") {
          return reply.code(400).send({ error: "Invalid memory update payload" });
        }

        const { namespace } = body;

        // -----------------------------------------------------
        // 🔒 NAMESPACE ENFORCEMENT
        // super_admin bypasses all namespace restrictions
        // -----------------------------------------------------
        if (req.user?.role !== "super_admin") {
          if (!namespace || namespace !== req.user?.namespace) {
            return reply.code(403).send({
              error: "Namespace mismatch — access denied."
            });
          }
        }

        // -----------------------------------------------------
        // 1️⃣ STORE MEMORY LOCALLY
        // -----------------------------------------------------
        const saved = await storeMemory(body);
        // saved = { id, text, embedding, metadata }

        // -----------------------------------------------------
        // 2️⃣ UPSERT VECTOR INTO RAG MEMORY PIPELINE
        // -----------------------------------------------------
        if (saved.embedding && Array.isArray(saved.embedding)) {
          const vectorPayload = [
            {
              id: saved.id,
              text: saved.text,
              values: saved.embedding,
              metadata: {
                ...saved.metadata,
                namespace: namespace || req.user?.namespace,
              },
            }
          ];

          try {
            await upsertVectors(vectorPayload);
            console.log("🧠 Vector memory upserted:", saved.id);
          } catch (vecErr) {
            console.error("❌ Vector upsert failed:", vecErr);
          }
        } else {
          console.warn("⚠️ No embedding provided — skipping vector upsert.");
        }

        // -----------------------------------------------------
        // 3️⃣ SUCCESS RESPONSE
        // -----------------------------------------------------
        return reply.send({
          status: "stored",
          id: saved.id,
          embeddingLength: saved.embedding?.length || 0,
          vectorized: !!saved.embedding
        });

      } catch (err) {
        console.error("❌ Memory update error:", err);
        return reply.code(500).send({
          error: "Memory update failed",
          details: err.message
        });
      }
    }
  );

});
