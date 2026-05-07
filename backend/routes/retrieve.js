// ============================================================
//  CORTÉX — RAG RETRIEVE ROUTE (48A.5 + SECURED + NAMESPACE SAFE)
//  v1.7 — RETRIEVAL INTELLIGENCE REFINEMENT (NO DRIFT)
// ============================================================

import fp from "fastify-plugin";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/authMiddleware.js";

// ============================================================
// 🔐 PERMISSION ENGINE
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
// 🔥 v1.7 RETRIEVAL CONTROL
// ============================================================

const SIMILARITY_THRESHOLD = 0.20;
const TOP_K = 5;
const MAX_CONTEXT_CHARS = 12000;

// ============================================================
// 🔧 LIGHTWEIGHT QUERY NORMALIZATION
// ============================================================

const TYPO_MAP = {
  hosptial: "hospital",
  sumarize: "summarize",
  incdidnet: "incident",
  incdient: "incident",
  resum: "resume",
  canddate: "candidate"
};

function normalizeRetrievalQuery(text = "") {

  let cleaned = text.toLowerCase().trim();

  cleaned = cleaned.replace(/[^\w\s]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ");

  const words = cleaned.split(" ").map(word => {
    return TYPO_MAP[word] || word;
  });

  return words.join(" ");
}

// ============================================================
// 🔧 LIGHT STOPWORDS
// ============================================================

const STOPWORDS = new Set([
  "the",
  "and",
  "all",
  "from",
  "with",
  "uploaded",
  "supporting",
  "evidence",
  "notes",
  "document",
  "documents",
  "file",
  "files",
  "summarize",
  "analyze"
]);

// ============================================================
// ROUTE
// ============================================================

export default fp(async function retrieveRoute(fastify, opts) {

  fastify.post(
    "/api/retrieve",
    { preHandler: requireAuth() },
    async (req, reply) => {

      try {

        const { query, namespace = "default" } = req.body || {};

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
          return reply.code(400).send({
            error: "Query text is required."
          });
        }

        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );

        // -----------------------------------------------------
        // 🔧 NORMALIZED RETRIEVAL QUERY
        // -----------------------------------------------------

        const normalizedQuery = normalizeRetrievalQuery(query);

        // -----------------------------------------------------
        // 1️⃣ EMBEDDING
        // -----------------------------------------------------

        const embedRes = await fastify.openai.embeddings.create({
          model: "text-embedding-3-small",
          input: normalizedQuery,
        });

        const embedding = embedRes.data?.[0]?.embedding;

        if (!embedding) {
          return reply.code(500).send({
            error: "Failed to generate embedding."
          });
        }

        // -----------------------------------------------------
        // 2️⃣ VECTOR SEARCH
        // -----------------------------------------------------

        const { data, error } = await supabase.rpc("match_documents", {
          query_embedding: embedding,
          match_threshold: 0.1,
          match_count: 8,
          query_namespace: namespace,
        });

        if (error) {

          console.error("❌ retrieve error:", error);

          return reply.code(500).send({
            error: error.message
          });
        }

        // -----------------------------------------------------
        // 🧠 FORMAT
        // -----------------------------------------------------

        let formatted = (data || []).map((row) => ({

          content: (row.chunk_text || "").trim(),

          similarity: row.similarity,

          filename:
            row.filename ||
            (row.chunk_text.match(/SOURCE FILE:\s*(.+)/i)?.[1] || "")
        }));

        // -----------------------------------------------------
        // 🔥 CLEANING PIPELINE
        // -----------------------------------------------------

        // 1. Remove empty
        formatted = formatted.filter(r => r.content);

        // 2. Similarity threshold
        formatted = formatted.filter(
          r => r.similarity >= SIMILARITY_THRESHOLD
        );

        // 3. Deduplicate by content prefix
        const seen = new Set();

        formatted = formatted.filter(r => {

          const key = r.content
            .slice(0, 250)
            .toLowerCase();

          if (seen.has(key)) return false;

          seen.add(key);

          return true;
        });

        // -----------------------------------------------------
        // 🔥 METADATA-FIRST RERANKING
        // -----------------------------------------------------

        const queryTerms = normalizedQuery
          .split(" ")
          .filter(term =>
            term.length > 3 &&
            !STOPWORDS.has(term)
          );

        formatted = formatted.map(r => {

          const filename = r.filename.toLowerCase();
          const content = r.content.toLowerCase();

          let keywordBoost = 0;

          for (const term of queryTerms) {

            // Higher signal: filename/entity match
            if (filename.includes(term)) {
              keywordBoost += 0.15;
            }

            // Lower signal: body content
            if (content.includes(term)) {
              keywordBoost += 0.03;
            }
          }

          return {
            ...r,
            boostedScore: r.similarity + keywordBoost
          };
        });

        // Sort by boosted relevance
        formatted.sort((a, b) => b.boostedScore - a.boostedScore);

        // 4. Top-K limit
        formatted = formatted.slice(0, TOP_K);

        // 5. Context protection
        let totalChars = 0;

        formatted = formatted.filter(r => {

          totalChars += r.content.length;

          return totalChars <= MAX_CONTEXT_CHARS;
        });

        // -----------------------------------------------------
        // 📊 LIGHT LOGGING
        // -----------------------------------------------------

        fastify.log.info({
          route: "/api/retrieve",
          namespace,
          normalizedQuery,
          matchCount: formatted.length,
          ragUsed: formatted.length > 0,
          totalChars
        });

        return reply.send({
          results: formatted
        });

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
