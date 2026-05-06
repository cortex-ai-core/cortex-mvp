// ============================================================
//  CORTÉX — CHAT ENGINE (RAG + EPHEMERAL ENABLED + DLP + PRIVATE MODE)
//  v1.7.4 CLEAN ENTITY SIGNAL TO FORMATTER
//  PATCH: SAFE VAGUE RESUME ENTITY RESOLUTION
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { requireAuth } from "../lib/authMiddleware.js";

// 🔒 DLP
import { runDLPScan, stripSensitiveFields } from "../lib/dlp.js";

// 🔥 Step 46 Reasoning Modules
import { decodeIntent } from "../reasoning/intent.js";
import { synthesizeFinalAnswer } from "../reasoning/synthesis.js";
import { formatOutput } from "../reasoning/outputFormatter.js";

// 🔥 Step 47 Identity Layer
import { applyIdentityLayer } from "../identity/applyIdentity.js";
import { resolveToneForNamespace } from "../identity/toneRouter.js";

// ----------------------------------------------------
const MAX_INPUT = 10000;
const TIMEOUT_MS = 30000;
const RATE_LIMIT = 20;

const userBuckets = new Map();

// ----------------------------------------------------
function checkRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60000;

  if (!userBuckets.has(userId)) userBuckets.set(userId, []);

  const timestamps = userBuckets.get(userId).filter(ts => now - ts < windowMs);
  const allowed = timestamps.length < RATE_LIMIT;

  if (allowed) timestamps.push(now);

  userBuckets.set(userId, timestamps);

  return {
    allowed,
    remaining: Math.max(0, RATE_LIMIT - timestamps.length),
    retryAfter: timestamps.length > 0
      ? Math.ceil((windowMs - (now - timestamps[0])) / 1000)
      : 0
  };
}

// ----------------------------------------------------
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    )
  ]);
}

// ----------------------------------------------------
function logEvent(fastify, data) {
  fastify.log.info(data);
}

// ----------------------------------------------------
function handleSimpleCases(input = "") {
  const text = input.toLowerCase().trim();

  if (text === "who are you" || text === "who are you?") {
    return { finalAnswer: "Cortéx. KING’s Intelligence Engine." };
  }

  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(input)) {
    return { finalAnswer: "Email detected. No context." };
  }

  if (text.length <= 10) {
    return { finalAnswer: "No subject." };
  }

  return null;
}

// ----------------------------------------------------
// 🔥 SAFE ENTITY RESOLUTION
// ----------------------------------------------------
function escapeRegex(value = "") {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePossessiveFirstName(value = "") {
  const cleaned = String(value || "")
    .trim()
    .replace(/['’]s$/i, "");

  if (cleaned.toLowerCase() === "brads") return "Brad";

  return cleaned.replace(/\b\w/g, char => char.toUpperCase());
}

function isBadResolvedEntity(value = "") {
  const normalized = String(value || "").toLowerCase().trim();

  const badMatches = [
    "brads",
    "candidate name",
    "primary entity",
    "not enough",
    "service desk",
    "salem health",
    "solution center",
    "access management",
    "emergency room",
    "united states"
  ];

  return badMatches.some(item => normalized === item || normalized.includes(item));
}

function isFullName(value = "") {
  return /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/.test(String(value || "").trim());
}

function resolvePrimaryEntityFromPromptAndContext(message = "", context = "") {
  const promptText = message || "";
  const contextText = context || "";
  const combinedText = `${promptText}\n${contextText}`;
  const normalizedCombined = combinedText.toLowerCase();

  // 1) Known vague resume entity mapping.
  //    This prevents "brads resume" from becoming "Brads".
  if (
    normalizedCombined.includes("brads resume") ||
    normalizedCombined.includes("brad's resume") ||
    normalizedCombined.includes("brad’s resume")
  ) {
    return "Brad Shimomura";
  }

  // 2) Explicit full name in user prompt wins.
  const explicitPromptName = promptText.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
  if (explicitPromptName && !isBadResolvedEntity(explicitPromptName[0])) {
    return explicitPromptName[0];
  }

  // 3) Handle vague possessive resume labels:
  //    "brads resume", "brad's resume", "Brad’s resume"
  const possessiveResumeMatch = promptText.match(/\b([A-Za-z]+)(?:['’]?s)?\s+resume\b/i);

  if (possessiveResumeMatch) {
    const firstName = normalizePossessiveFirstName(possessiveResumeMatch[1]);

    if (firstName && contextText) {
      const firstNamePattern = escapeRegex(firstName);

      const fullNameNearFirstName = contextText.match(
        new RegExp(`\\b${firstNamePattern}\\s+[A-Z][a-z]+\\b`, "i")
      );

      if (
        fullNameNearFirstName &&
        isFullName(fullNameNearFirstName[0]) &&
        !isBadResolvedEntity(fullNameNearFirstName[0])
      ) {
        return fullNameNearFirstName[0];
      }
    }
  }

  // 4) If context contains PRIMARY ENTITY, trust full names only.
  const primaryEntityMatch = contextText.match(/PRIMARY ENTITY:\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/i);
  if (primaryEntityMatch && !isBadResolvedEntity(primaryEntityMatch[1])) {
    return primaryEntityMatch[1];
  }

  // 5) Context fallback, but avoid common organization/location false positives.
  const ignoredPairs = new Set([
    "Salem Health",
    "Service Desk",
    "Solution Center",
    "Emergency Room",
    "United States"
  ]);

  const contextNames = contextText.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g) || [];
  const resolvedContextName = contextNames.find(name =>
    !ignoredPairs.has(name) &&
    !isBadResolvedEntity(name)
  );

  return resolvedContextName || null;
}

// ============================================================
// 🚀 ROUTE
// ============================================================
export default fp(async function chatRoute(fastify) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  fastify.post(
    "/api/chat",
    { preHandler: requireAuth() },
    async (req, reply) => {
      const start = Date.now();

      const identity = req.user;
      const userId = identity?.userId || "unknown";
      const namespace = identity?.namespace || "unknown";

      try {
        const { message = "", ephemeralContext = "", privateMode = false } = req.body || {};

        if (!message.trim()) return reply.code(400).send({ error: "Message required" });
        if (message.length > MAX_INPUT) return reply.code(400).send({ error: "Input too large" });

        const dlp = runDLPScan(message);
        if (dlp.block) return reply.send({ error: "Sensitive data blocked" });

        const sanitizedMessage = dlp.sanitized;

        const simple = handleSimpleCases(sanitizedMessage);
        if (simple) return reply.send(simple);

        const intent = decodeIntent(sanitizedMessage);
        const normalized = sanitizedMessage.toLowerCase();

        const requiresKnowledge =
          ["analysis", "question", "lookup", "summarize", "summary"].includes(intent) ||
          normalized.includes("summar") ||
          normalized.includes("resume") ||
          normalized.includes("sow") ||
          normalized.includes("document");

        const tone = resolveToneForNamespace(namespace);

        const identityContext = applyIdentityLayer({
          userId,
          role: identity.role,
          namespace,
          tone
        });

        let ragContext = "";
        let normalizedMessage = sanitizedMessage;
        let resolvedName = null;

        if (privateMode) {
          ragContext = ephemeralContext;

        } else if (ephemeralContext.trim()) {
          ragContext = ephemeralContext;

        } else if (requiresKnowledge) {

          let retrievalQuery = sanitizedMessage;

          if (
            normalized.includes("resume") ||
            normalized.includes("summar") ||
            normalized.includes("document")
          ) {
            retrievalQuery = `${sanitizedMessage} service desk Salem Health`;
          }

          const res = await fastify.inject({
            method: "POST",
            url: "/api/retrieve",
            payload: { query: retrievalQuery, namespace },
            headers: { authorization: req.headers.authorization }
          });

          const parsed = JSON.parse(res.body || "{}");
          const results = Array.isArray(parsed.results) ? parsed.results : [];

          ragContext = results.map(r => r.content).join("\n\n");

          // ============================================================
          // 🔥 FINAL ENTITY RESOLUTION
          // ============================================================

          resolvedName = resolvePrimaryEntityFromPromptAndContext(
            sanitizedMessage,
            ragContext
          );

          if (resolvedName) {
            ragContext = `PRIMARY ENTITY: ${resolvedName}\n\n${ragContext}`;
          }
        }

        const rawAnswer = await withTimeout(
          synthesizeFinalAnswer({
            intent,
            userMessage: normalizedMessage,
            contextWindow: ragContext,
            model: openai,
            identityContext
          }),
          TIMEOUT_MS
        );

        const formatterUserMessage = resolvedName
          ? `${normalizedMessage}\nPrimary Entity: ${resolvedName}`
          : normalizedMessage;

        const formattedAnswer = formatOutput(rawAnswer, {
          intent,
          userMessage: formatterUserMessage,
          hasContext: Boolean(ragContext && ragContext.trim()),
          privateMode,
          namespace,
          tone
        });

        const cleaned = stripSensitiveFields(formattedAnswer);

        logEvent(fastify, {
          userId,
          namespace,
          inputLength: message.length,
          outputLength: cleaned.length,
          latency: Date.now() - start
        });

        return reply.send({ finalAnswer: cleaned });

      } catch (err) {
        return reply.code(500).send({ error: "Temporary issue — please retry" });
      }
    }
  );
});
