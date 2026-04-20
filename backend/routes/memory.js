// ============================================================
//  CORTÉX — MEMORY STORE ROUTE
//  Purpose: Save a memory entry (no RBAC until Step 47)
// ============================================================

import fp from "fastify-plugin";
import { storeMemory } from "./memory/storeMemory.js";

export default fp(async function memoryStoreRoute(fastify, opts) {

  fastify.post(
    "/api/memory",
    async (req, reply) => {
      try {
        const body = req.body;

        if (!body || typeof body !== "object") {
          return reply.code(400).send({ error: "Invalid memory payload" });
        }

        const saved = await storeMemory(body);

        return reply.send({
          status: "stored",
          id: saved.id,
          metadata: saved.metadata || {},
        });

      } catch (err) {
        console.error("❌ Memory store error:", err);
        return reply.code(500).send({
          error: "Memory storage failed",
          details: err.message
        });
      }
    }
  );

});
