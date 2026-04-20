// ============================================================
//  CORTÉX — MEMORY UPDATE ROUTE (Modern Store Engine)
//  Removes deprecated file-based temp memory logic
// ============================================================

import fp from "fastify-plugin";
import { storeMemory } from "./storeMemory.js";


export default fp(async function memoryUpdateRoute(fastify, opts) {

  fastify.post(
    "/api/memory/update",
    async (req, reply) => {
      try {
        const body = req.body;

        if (!body || typeof body !== "object") {
          return reply.code(400).send({ error: "Invalid memory update payload" });
        }

        const saved = await storeMemory(body);

        return reply.send({
          status: "updated",
          id: saved.id,
          metadata: saved.metadata || {},
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
