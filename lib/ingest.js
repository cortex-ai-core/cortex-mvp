// =============================================================
//  CORTÉX — INGEST ROUTE (PERMISSION + NAMESPACE SECURED)
//  Requires: upload_documents
// =============================================================

import fp from "fastify-plugin";
import { requirePermission } from "../lib/authMiddleware.js";
import { ingest } from "../../lib/ingest.js"; // ⬅ Your ingestion engine

// -------------------------------------------------------------
// ROUTE
// -------------------------------------------------------------
async function ingestRoute(fastify, opts) {

  fastify.post(
    "/ingest",
    {
      preHandler: requirePermission("upload_documents") // 🔥 UI-aligned RBAC
    },
    async (req, reply) => {
      try {
        const { text, file_name, document_id, metadata, namespace } = req.body;

        // -----------------------------------------------------
        // NAMESPACE ENFORCEMENT
        // (super_admin bypasses all namespace restrictions)
        // -----------------------------------------------------
        if (req.user.role !== "super_admin") {
          if (!namespace || namespace !== req.user.namespace) {
            return reply.code(403).send({
              error: "Namespace mismatch — access denied."
            });
          }
        }

        // -----------------------------------------------------
        // ENSURE REQUIRED FIELDS
        // -----------------------------------------------------
        if (!text || typeof text !== "string") {
          return reply.code(400).send({ error: "Missing or invalid text." });
        }

        // -----------------------------------------------------
        // PERFORM INGESTION (CLEAN → PARSE → CHUNK → EMBED → UPSERT)
        // -----------------------------------------------------
        const result = await ingest({
          text,
          file_name,
          document_id,
          metadata: {
            ...metadata,
            namespace: namespace || req.user.namespace
          }
        });

        return reply.send({
          success: true,
          namespace: namespace || req.user.namespace,
          result
        });

      } catch (err) {
        console.error("❌ INGEST ERROR:", err);
        return reply.code(500).send({ error: err.message });
      }
    }
  );
}

export default fp(ingestRoute);
