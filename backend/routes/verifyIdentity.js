// ============================================================
//  CORTÉX — IDENTITY VERIFICATION ENDPOINT (47.6G)
// ============================================================

import fp from "fastify-plugin";
import { computeIdentityHash } from "../identity/integrity.js";

export default fp(async function verifyIdentityRoute(fastify) {
  fastify.post("/api/verify-identity", async (req, reply) => {
    try {
      const { finalAnswer, persona, integrity, reasoning } = req.body || {};

      if (!finalAnswer || !persona || !integrity) {
        return reply.code(400).send({
          valid: false,
          error: "Missing required fields for verification."
        });
      }

      // ------------------------------------------------------------
      // Rebuild integrity payload exactly as Cortéx originally did
      // ------------------------------------------------------------
      const integrityPayload = {
        finalAnswer,
        persona: persona.corePersona,
        tone: persona.toneMode,
        namespace: integrity.namespace,
        intent: reasoning?.intent || "",
        timestamp: integrity.timestamp
      };

      // Compute fresh hash
      const recomputedHash = computeIdentityHash(integrityPayload);

      // Compare
      const isValid = recomputedHash === integrity.identityIntegrityHash;

      return reply.send({
        valid: isValid,
        recomputedHash,
        originalHash: integrity.identityIntegrityHash,
        namespace: integrity.namespace,
        timestamp: integrity.timestamp
      });

    } catch (err) {
      console.error("IDENTITY VERIFY ERROR:", err);
      return reply.code(500).send({
        valid: false,
        error: "Internal verification failure.",
        detail: err.message
      });
    }
  });
});
