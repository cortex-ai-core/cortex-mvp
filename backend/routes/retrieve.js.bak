// ============================================================
//  CORTÉX — RAG RETRIEVE ROUTE (48A.5 + SECURED + NAMESPACE SAFE)
// ============================================================

import fp from "fastify-plugin";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/authMiddleware.js";

// ============================================================
// 🔐 PERMISSION ENGINE (FULL DIVISION COVERAGE)
// ============================================================

const PERMISSION_MAP = {
  super_admin: {
    namespaces: ["*"],
    actions: ["chat", "upload", "admin", "delete"]
  },

  advisor: {
    namespaces: ["advisory"],
    actions: ["chat", "upload"]
  },

  cyber: {
    namespaces: ["cybersecurity"],
    actions: ["chat"]
  },

  datamanagement: {
    namespaces: ["datamanagement"],
    actions: ["chat", "upload"]
  },

  recruiting: {
    namespaces: ["recruiting"],
    actions: ["chat", "upload"]
  },

  ventures: {
    namespaces: ["ventures"],
    actions: ["chat", "upload"]
  }
};

function hasPermission(identity, action) {
  const { role, namespace } = identity;

  const rolePermissions = PERMISSION_MAP[role];
  if (!rolePermissions) return false;

  const namespaceAllowed =
    rolePermissions.namespaces.includes("*") ||
    rolePermissions.namespaces.includes(namespace);

  if (!namespaceAllowed) return false;

  return rolePermissions.actions.includes(action);
}

// ============================================================
// ROUTE
// ============================================================

export default fp(async function retrieveRoute(fastify, opts) {

  fastify.post(
    "/api/retrieve",
    { preHandler: requireAuth() },
    async (req, reply) => {
      try {
        const { query, namespace = "default", topK = 5 } = req.body || {};

        const identity = {
          userId: req.user?.id,
          role: req.user?.role,
          namespace: req.user?.namespace
        };

        // -----------------------------------------------------
        // 🔐 PERMISSION CHECK
        // -----------------------------------------------------
        if (!hasPermission(identity, "chat")) {
          return reply.code(403).send({
            error: "Forbidden: No permission to retrieve data"
          });
        }

        // -----------------------------------------------------
        // 🔐 NAMESPACE ENFORCEMENT
        // -----------------------------------------------------
        if (namespace !== identity.namespace) {
          return reply.code(403).send({
            error: "Namespace mismatch. Access denied."
          });
        }

        if (!query || !query.trim()) {
          return reply.code(400).send({ error: "Query text is required." });
        }

        // Supabase client
        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );

        // -----------------------------------------------------
        // 1️⃣ EMBEDDING
        // -----------------------------------------------------
        const embedRes = await fastify.openai.embeddings.create({
          model: "text-embedding-3-small",
          input: query,
        });

        const embedding = embedRes.data?.[0]?.embedding;

        if (!embedding) {
          return reply.code(500).send({ error: "Failed to generate embedding." });
        }

        // -----------------------------------------------------
        // 2️⃣ VECTOR SEARCH
        // -----------------------------------------------------
        const { data, error } = await supabase.rpc("match_documents", {
          query_embedding: embedding,
          match_threshold: 0.1,
          match_count: topK,
          query_namespace: namespace,
        });

        if (error) {
          console.error("❌ retrieve error:", error);
          return reply.code(500).send({ error: error.message });
        }

        // -----------------------------------------------------
        // 🧠 FORMAT (FIXED COLUMN)
        // -----------------------------------------------------
        const formatted = (data || []).map((row) => ({
          content: row.chunk_text,   // ✅ FIXED
          similarity: row.similarity,
          filename: row.filename
        }));

        return reply.send({ results: formatted });

      } catch (err) {
        console.error("❌ /api/retrieve FAILURE:", err);
        return reply.code(500).send({
          error: "RAG retrieve failure",
          detail: err.message,
        });
      }
    }
  );
});
