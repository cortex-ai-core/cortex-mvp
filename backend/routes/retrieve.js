// ============================================================
//  CORTÉX — RAG RETRIEVE ROUTE
//  v1.8.8
//  ECOSYSTEM FILENAME CONTINUITY STABILIZATION
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

  const cleaned =
    text
      .toLowerCase()
      .replace(/\s+/g, " ");

  const start =
    cleaned.slice(0, 120);

  const middle =
    cleaned.slice(
      Math.floor(cleaned.length / 2),
      Math.floor(cleaned.length / 2) + 120
    );

  const end =
    cleaned.slice(-120);

  return `${start}|${middle}|${end}`;
}

function generateSyntheticEcosystemId(text = "") {

  const fingerprint =
    contentFingerprint(text);

  const hash =
    fingerprint
      .split("")
      .reduce(
        (acc, char) =>
          acc + char.charCodeAt(0),
        0
      );

  return `ecosystem_${Math.abs(hash)}`;
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
// 🔥 RETRIEVAL PRESSURE MODEL
// ============================================================

function calculateRetrievalPressure(results = []) {

  if (!results.length) {
    return {
      pressure: 0,
      highPressure: false
    };
  }

  const uniqueFiles =
    new Set(results.map(r => r.filename)).size;

  const averageSimilarity =
    results.reduce(
      (sum, r) => sum + (r.similarity || 0),
      0
    ) / results.length;

  const pressure =
    (
      (results.length * 0.45) +
      (uniqueFiles * 0.35) +
      (averageSimilarity * 10)
    );

  return {
    pressure,
    highPressure: pressure >= 12
  };
}

function calculateAdaptiveFileCap(
  retrievalPressure,
  baseCap = MAX_RESULTS_PER_FILE
) {

  if (!retrievalPressure.highPressure) {
    return baseCap;
  }

  return Math.min(
    baseCap + 1,
    3
  );
}

// ============================================================
// 🔥 ECOSYSTEM SURVIVABILITY
// ============================================================

function applyEcosystemContextAllocation(
  results = [],
  contextBudget = 10000
) {

  if (!results.length) return results;

  const ecosystems = {};

  for (const result of results) {

    if (!ecosystems[result.filename]) {
      ecosystems[result.filename] = [];
    }

    ecosystems[result.filename].push(result);
  }

  const sortedEcosystems =
    Object.values(ecosystems)
      .sort((a, b) => {

        const aScore =
          a.reduce(
            (sum, r) => sum + r.finalScore,
            0
          );

        const bScore =
          b.reduce(
            (sum, r) => sum + r.finalScore,
            0
          );

        return bScore - aScore;
      });

  const surviving = [];
  const includedFingerprints = new Set();

  let totalChars = 0;

  // ==========================================================
  // 🔥 PASS 1 — DIVERSITY FLOOR
  // ==========================================================

  for (const ecosystem of sortedEcosystems) {

    const candidate = ecosystem[0];

    if (!candidate) continue;

    const fingerprint =
      contentFingerprint(candidate.content);

    if (includedFingerprints.has(fingerprint)) {
      continue;
    }

    if (
      totalChars + candidate.content.length >
      contextBudget
    ) {
      continue;
    }

    surviving.push(candidate);

    includedFingerprints.add(fingerprint);

    totalChars += candidate.content.length;
  }

  // ==========================================================
  // 🔥 PASS 2 — CONTROLLED SATURATION EXPANSION
  // ==========================================================

  const MAX_ROUNDS = 2;

  let round = 1;

  while (round <= MAX_ROUNDS) {

    let addedThisRound = false;

    for (const ecosystem of sortedEcosystems) {

      if (!ecosystem[round]) continue;

      const candidate =
        ecosystem[round];

      const fingerprint =
        contentFingerprint(candidate.content);

      if (includedFingerprints.has(fingerprint)) {
        continue;
      }

      if (
        totalChars + candidate.content.length >
        contextBudget
      ) {
        continue;
      }

      surviving.push(candidate);

      includedFingerprints.add(fingerprint);

      totalChars += candidate.content.length;

      addedThisRound = true;
    }

    if (!addedThisRound) break;

    round++;
  }

  return surviving;
}

// ============================================================
// 🔥 RELATIONSHIP-AWARE SEMANTIC LAYER
// ============================================================

function calculateSemanticOverlap(a = "", b = "") {

  const aWords = new Set(
    a.toLowerCase().split(/\s+/).filter(Boolean)
  );

  const bWords = new Set(
    b.toLowerCase().split(/\s+/).filter(Boolean)
  );

  let overlap = 0;

  for (const word of aWords) {
    if (
      bWords.has(word) &&
      word.length > 4 &&
      !STOPWORDS.has(word)
    ) {
      overlap++;
    }
  }

  const denominator =
    Math.max(aWords.size, bWords.size) || 1;

  return overlap / denominator;
}

function buildSemanticNeighborhoods(results = []) {

  return results.map((result, idx) => {

    let neighborhoodStrength = 0;
    let relationshipCount = 0;

    for (let i = 0; i < results.length; i++) {

      if (i === idx) continue;

      const other = results[i];

      const overlap =
        calculateSemanticOverlap(
          result.content,
          other.content
        );

      if (overlap >= 0.12) {

        neighborhoodStrength += overlap;
        relationshipCount++;
      }
    }

    return {
      ...result,
      neighborhoodStrength,
      relationshipCount
    };
  });
}

// ============================================================
// 🔥 PHASE 5 — DISTRIBUTION STABILIZATION
// ============================================================

function applyRelationshipAwareScoring(results = []) {

  if (!results.length) return results;

  const strongestNeighborhood =
    Math.max(
      ...results.map(
        r => r.neighborhoodStrength || 0
      ),
      0.01
    );

  return results.map(result => {

    const neighborhoodRatio =
      (result.neighborhoodStrength || 0) /
      strongestNeighborhood;

    const saturationCurve =
      Math.sqrt(neighborhoodRatio);

    const relationshipBoost =
      saturationCurve * 0.04;

    const continuityBoost =
      Math.min(
        Math.log1p(
          result.relationshipCount || 0
        ) * 0.012,
        0.03
      );

    const confidenceGapPenalty =
      (
        neighborhoodRatio < 0.18 &&
        result.boostedScore < 0.46
      )
        ? 0.05
        : 0;

    const filePressurePenalty =
      Math.min(
        (
          (result.fileOccurrenceCount || 1) - 1
        ) * 0.012,
        0.05
      );

    const finalScore =
      result.boostedScore +
      relationshipBoost +
      continuityBoost -
      confidenceGapPenalty -
      filePressurePenalty;

    return {
      ...result,
      saturationCurve,
      relationshipBoost,
      continuityBoost,
      confidenceGapPenalty,
      filePressurePenalty,
      finalScore
    };
  });
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

        if (!hasPermission(identity, "chat")) {
          return reply.code(403).send({
            error: "Forbidden: No permission to retrieve data"
          });
        }

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

        const normalizedQuery =
          normalizeRetrievalQuery(query);

        const queryTerms = normalizedQuery
          .split(" ")
          .filter(
            term =>
              term.length > 3 &&
              !STOPWORDS.has(term)
          );

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

        // ======================================================
        // 🧠 FORMAT + ECOSYSTEM IDENTITY STABILIZATION
        // ======================================================

        let formatted = (data || []).map((row) => {

          const content =
            (row.chunk_text || "")
              .replace(/\s+/g, " ")
              .trim();

          // ==================================================
          // 🔥 FULL FILENAME CONTINUITY FIX
          // ==================================================

          const extractedFilename =
            row.filename ||
            row.chunk_text.match(
              /SOURCE FILE:\s*([^\n\r]+)/i
            )?.[1]?.trim();

          return {

            content,

            similarity: row.similarity,

            filename:
              extractedFilename ||
              generateSyntheticEcosystemId(content)
          };
        });

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

        formatted = formatted.map(r => {

          const content =
            r.content.toLowerCase();

          let keywordBoost = 0;
          let coverageBoost = 0;

          for (const term of queryTerms) {

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
            semanticDensity * 0.03;

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

        const fileOccurrenceMap = {};

        for (const item of formatted) {

          fileOccurrenceMap[item.filename] =
            (fileOccurrenceMap[item.filename] || 0) + 1;
        }

        formatted = formatted.map(item => ({
          ...item,
          fileOccurrenceCount:
            fileOccurrenceMap[item.filename] || 1
        }));

        formatted =
          buildSemanticNeighborhoods(formatted);

        formatted =
          applyRelationshipAwareScoring(formatted);

        const retrievalPressure =
          calculateRetrievalPressure(formatted);

        formatted.sort(
          (a, b) =>
            b.finalScore - a.finalScore
        );

        const adaptiveFileCap =
          calculateAdaptiveFileCap(
            retrievalPressure
          );

        const fileCounts = {};

        formatted = formatted.filter(r => {

          const key = r.filename;

          fileCounts[key] =
            (fileCounts[key] || 0) + 1;

          return (
            fileCounts[key] <=
            adaptiveFileCap
          );
        });

        const adaptiveContextBudget =
          retrievalPressure.highPressure
            ? retrievalProfile.contextBudget + 4000
            : retrievalProfile.contextBudget;

        formatted =
          applyEcosystemContextAllocation(
            formatted,
            adaptiveContextBudget
          );

        const adaptiveTopK =
          retrievalPressure.highPressure
            ? retrievalProfile.topK + 4
            : retrievalProfile.topK;

        formatted =
          formatted.slice(
            0,
            adaptiveTopK
          );

        fastify.log.info({
          route: "/api/retrieve",
          namespace,
          normalizedQuery,
          queryTerms,
          queryType: retrievalProfile.type,
          retrievalPressure:
            retrievalPressure.pressure,
          highPressure:
            retrievalPressure.highPressure,
          adaptiveTopK,
          adaptiveFileCap,
          matchCount: formatted.length,
          ragUsed: formatted.length > 0
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
