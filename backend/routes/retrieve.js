// ============================================================
//  CORTÉX — RAG RETRIEVE ROUTE
//  v1.8 PHASE 1 — ADAPTIVE RETRIEVAL INTELLIGENCE
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
// 🔥 BASE RETRIEVAL CONTROL
// ============================================================

const BASE_SIMILARITY_THRESHOLD = 0.22;
const BASE_TOP_K = 6;
const BASE_CONTEXT_CHARS = 10000;
const MAX_RESULTS_PER_FILE = 2;

// ============================================================
// 🔧 QUERY NORMALIZATION
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
// 🔧 STOPWORDS
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
  "analyze",
  "provide",
  "identify",
  "determine",
  "available",
  "materials"
]);

// ============================================================
// 🔧 QUERY INTELLIGENCE
// ============================================================

function determineQueryProfile(query = "") {

  const lower = query.toLowerCase();

  const abstractSignals = [
    "strategy",
    "governance",
    "leadership",
    "system",
    "systems",
    "risk",
    "architecture",
    "executive",
    "organizational",
    "operational",
    "analysis",
    "synthesis"
  ];

  let abstractMatches = 0;

  for (const signal of abstractSignals) {
    if (lower.includes(signal)) {
      abstractMatches++;
    }
  }

  if (abstractMatches >= 4) {
    return {
      type: "abstract",
      topK: 10,
      matchCount: 20,
      similarityThreshold: 0.18,
      contextBudget: 16000
    };
  }

  if (abstractMatches >= 2) {
    return {
      type: "analytical",
      topK: 8,
      matchCount: 16,
      similarityThreshold: 0.20,
      contextBudget: 14000
    };
  }

  return {
    type: "direct",
    topK: BASE_TOP_K,
    matchCount: 12,
    similarityThreshold: BASE_SIMILARITY_THRESHOLD,
    contextBudget: BASE_CONTEXT_CHARS
  };
}

// ============================================================
// 🔧 SEMANTIC HELPERS
// ============================================================

function contentFingerprint(text = "") {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

function countTermMatches(content = "", terms = []) {

  const lower = content.toLowerCase();

  let count = 0;

  for (const term of terms) {
    if (lower.includes(term)) count++;
  }

  return count;
}

function calculateSemanticDensity(content = "") {

  const words = content
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const uniqueWords = new Set(words);

  if (!words.length) return 0;

  return uniqueWords.size / words.length;
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

        const retrievalProfile =
          determineQueryProfile(query);

        const supabase = createClient(
          process.env.SUPABASE_URL,
          process.env.SUPABASE_SERVICE_KEY
        );

        // -----------------------------------------------------
        // 🔧 NORMALIZED QUERY
        // -----------------------------------------------------

        const normalizedQuery =
          normalizeRetrievalQuery(query);

        const queryTerms = normalizedQuery
          .split(" ")
          .filter(
            term =>
              term.length > 3 &&
              !STOPWORDS.has(term)
          );

        // -----------------------------------------------------
        // 1️⃣ EMBEDDING
        // -----------------------------------------------------

        const embedRes =
          await fastify.openai.embeddings.create({
            model: "text-embedding-3-small",
            input: normalizedQuery,
          });

        const embedding =
          embedRes.data?.[0]?.embedding;

        if (!embedding) {
          return reply.code(500).send({
            error: "Failed to generate embedding."
          });
        }

        // -----------------------------------------------------
        // 2️⃣ VECTOR SEARCH
        // -----------------------------------------------------

        const { data, error } =
          await supabase.rpc("match_documents", {
            query_embedding: embedding,
            match_threshold: 0.10,
            match_count: retrievalProfile.matchCount,
            query_namespace: namespace,
          });

        if (error) {

          console.error(
            "❌ retrieve error:",
            error
          );

          return reply.code(500).send({
            error: error.message
          });
        }

        // -----------------------------------------------------
        // 🧠 FORMAT
        // -----------------------------------------------------

        let formatted = (data || []).map((row) => ({

          content: (row.chunk_text || "")
            .replace(/\s+/g, " ")
            .trim(),

          similarity: row.similarity,

          filename:
            row.filename ||
            (
              row.chunk_text.match(
                /SOURCE FILE:\s*(.+)/i
              )?.[1] || "unknown"
            )
        }));

        // -----------------------------------------------------
        // 🔥 CLEANING PIPELINE
        // -----------------------------------------------------

        formatted =
          formatted.filter(r => r.content);

        formatted =
          formatted.filter(
            r =>
              r.similarity >=
              retrievalProfile.similarityThreshold
          );

        const seen = new Set();

        formatted = formatted.filter(r => {

          const key =
            contentFingerprint(r.content);

          if (seen.has(key)) {
            return false;
          }

          seen.add(key);

          return true;
        });

        // -----------------------------------------------------
        // 🔥 SIGNAL SCORING
        // -----------------------------------------------------

        formatted = formatted.map(r => {

          const filename =
            r.filename.toLowerCase();

          const content =
            r.content.toLowerCase();

          let keywordBoost = 0;
          let coverageBoost = 0;

          for (const term of queryTerms) {

            if (filename.includes(term)) {
              keywordBoost += 0.15;
            }

            if (content.includes(term)) {
              keywordBoost += 0.03;
            }
          }

          const matchedTerms =
            countTermMatches(
              content,
              queryTerms
            );

          coverageBoost =
            Math.min(
              matchedTerms * 0.015,
              0.08
            );

          const semanticDensity =
            calculateSemanticDensity(content);

          const densityBoost =
            semanticDensity * 0.08;

          const confidenceScore =
            (
              r.similarity +
              keywordBoost +
              coverageBoost +
              densityBoost
            );

          return {
            ...r,
            semanticDensity,
            confidenceScore,
            boostedScore: confidenceScore
          };
        });

        // -----------------------------------------------------
        // 🔥 SORT
        // -----------------------------------------------------

        formatted.sort(
          (a, b) =>
            b.boostedScore - a.boostedScore
        );

        // -----------------------------------------------------
        // 🔥 FILE DIVERSITY CONTROL
        // -----------------------------------------------------

        const fileCounts = {};

        formatted = formatted.filter(r => {

          const key = r.filename;

          fileCounts[key] =
            (fileCounts[key] || 0) + 1;

          return (
            fileCounts[key] <=
            MAX_RESULTS_PER_FILE
          );
        });

        // -----------------------------------------------------
        // 🔥 TOP-K
        // -----------------------------------------------------

        formatted =
          formatted.slice(
            0,
            retrievalProfile.topK
          );

        // -----------------------------------------------------
        // 🔥 CONTEXT PROTECTION
        // -----------------------------------------------------

        let totalChars = 0;

        formatted = formatted.filter(r => {

          if (
            totalChars + r.content.length >
            retrievalProfile.contextBudget
          ) {
            return false;
          }

          totalChars += r.content.length;

          return true;
        });

        // -----------------------------------------------------
        // 📊 LOGGING
        // -----------------------------------------------------

        fastify.log.info({
          route: "/api/retrieve",
          namespace,
          normalizedQuery,
          queryTerms,
          queryType: retrievalProfile.type,
          matchCount: formatted.length,
          ragUsed: formatted.length > 0,
          totalChars
        });

        return reply.send({
          results: formatted
        });

      } catch (err) {

        console.error(
          "❌ /api/retrieve FAILURE:",
          err
        );

        return reply.code(500).send({
          error: "RAG retrieve failure",
          detail: err.message,
        });
      }
    }
  );
});
