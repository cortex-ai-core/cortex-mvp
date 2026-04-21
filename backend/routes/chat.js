// ============================================================
//  CORTÉX — CHAT ENGINE (RAG + EPHEMERAL ENABLED + DLP)
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { requireAuth } from "../lib/authMiddleware.js";

// 🔒 DLP
import { runDLPScan } from "../lib/dlp.js";

// 🔥 Step 46 Reasoning Modules
import { decodeIntent } from "../reasoning/intent.js";
import { assembleContext } from "../reasoning/context.js";
import { inferPaths } from "../reasoning/inference.js";
import { synthesizeFinalAnswer } from "../reasoning/synthesis.js";

// 🔥 Step 47 Identity Layer
import { applyIdentityLayer } from "../identity/applyIdentity.js";
import { resolveToneForNamespace } from "../identity/toneRouter.js";

// ----------------------------------------------------
// 🔒 CONFIG
// ----------------------------------------------------
const MAX_INPUT = 10000;
const TIMEOUT_MS = 12000;
const RATE_LIMIT = 20;

const userBuckets = new Map();

// ----------------------------------------------------
// 🚦 RATE LIMIT
// ----------------------------------------------------
function checkRateLimit(userId) {
  const now = Date.now();
  const windowMs = 60000;

  if (!userBuckets.has(userId)) {
    userBuckets.set(userId, []);
  }

  const timestamps = userBuckets.get(userId).filter(ts => now - ts < windowMs);
  timestamps.push(now);

  userBuckets.set(userId, timestamps);

  return timestamps.length <= RATE_LIMIT;
}

// ----------------------------------------------------
// ⚡ TIMEOUT WRAPPER
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
// 📊 STRUCTURED LOGGER (UPGRADED)
// ----------------------------------------------------
function logEvent(fastify, data) {
  fastify.log.info({
    requestId: data.requestId,
    userId: data.userId,
    namespace: data.namespace,
    inputLength: data.inputLength,
    outputLength: data.outputLength,
    latency: data.latency,
    errorType: data.errorType || null
  });
}

// ----------------------------------------------------
// 🔥 PRE-ROUTER
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
// 🔥 OUTPUT DLP
// ----------------------------------------------------
function stripSensitiveFields(text = "") {
  if (!text || typeof text !== "string") return text;

  let output = text;

  output = output.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[REDACTED_EMAIL]"
  );

  const phonePatterns = [
    /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
    /\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g
  ];

  phonePatterns.forEach((pattern) => {
    output = output.replace(pattern, "[REDACTED_PHONE]");
  });

  return output;
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
      const requestId = Math.random().toString(36).substring(2, 10);

      const identity = req.user;
      const userId = identity?.userId || "unknown";
      const namespace = identity?.namespace || "unknown";

      try {
        const { message = "", ephemeralContext } = req.body || {};

        // ---------------- VALIDATION ----------------
        if (!identity) {
          logEvent(fastify, { requestId, userId, namespace, inputLength: 0, outputLength: 0, latency: Date.now() - start, errorType: "unauthorized" });
          return reply.code(401).send({ error: "Unauthorized" });
        }

        if (!checkRateLimit(userId)) {
          logEvent(fastify, { requestId, userId, namespace, inputLength: message.length, outputLength: 0, latency: Date.now() - start, errorType: "rate_limit" });
          return reply.code(429).send({ error: "Rate limit exceeded" });
        }

        if (!message.trim()) {
          logEvent(fastify, { requestId, userId, namespace, inputLength: 0, outputLength: 0, latency: Date.now() - start, errorType: "empty_input" });
          return reply.code(400).send({ error: "Message required" });
        }

        if (message.length > MAX_INPUT) {
          logEvent(fastify, { requestId, userId, namespace, inputLength: message.length, outputLength: 0, latency: Date.now() - start, errorType: "input_too_large" });
          return reply.code(400).send({ error: "Input too large" });
        }

        const initialDLP = runDLPScan(message);

        if (initialDLP.block) {
          logEvent(fastify, { requestId, userId, namespace, inputLength: message.length, outputLength: 0, latency: Date.now() - start, errorType: "dlp_block" });
          return reply.send({ error: "Sensitive data blocked" });
        }

        let sanitizedMessage = initialDLP.sanitized;

        const simpleResponse = handleSimpleCases(sanitizedMessage);
        if (simpleResponse) {
          logEvent(fastify, {
            requestId,
            userId,
            namespace,
            inputLength: sanitizedMessage.length,
            outputLength: simpleResponse.finalAnswer.length,
            latency: Date.now() - start
          });

          return reply.send(simpleResponse);
        }

        // ---------------- RAG ----------------
        let ragContext = "";

        if (ephemeralContext?.trim()) {
          ragContext = ephemeralContext;
        } else {
          const retrieveRes = await fastify.inject({
            method: "POST",
            url: "/api/retrieve",
            payload: { query: sanitizedMessage, namespace, topK: 5 },
            headers: { authorization: req.headers.authorization }
          });

          let parsed = JSON.parse(retrieveRes.body || "{}");
          ragContext = (parsed.results || []).map(r => r.content).join("\n\n");
        }

        // ---------------- MODEL ----------------
        let finalAnswer = await withTimeout(
          synthesizeFinalAnswer({
            userMessage: sanitizedMessage,
            contextWindow: ragContext,
            model: openai
          }),
          TIMEOUT_MS
        );

        finalAnswer = stripSensitiveFields(finalAnswer);

        // ---------------- LOG SUCCESS ----------------
        logEvent(fastify, {
          requestId,
          userId,
          namespace,
          inputLength: sanitizedMessage.length,
          outputLength: finalAnswer.length,
          latency: Date.now() - start
        });

        return reply.send({ finalAnswer });

      } catch (err) {

        logEvent(fastify, {
          requestId,
          userId,
          namespace,
          inputLength: 0,
          outputLength: 0,
          latency: Date.now() - start,
          errorType: err.message
        });

        return reply.code(500).send({ error: "Temporary issue — please retry" });
      }
    }
  );
});
