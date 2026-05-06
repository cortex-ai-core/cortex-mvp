// ============================================================
//  CORTÉX — CHAT ENGINE (RAG + EPHEMERAL ENABLED + DLP + PRIVATE MODE)
//  v1.5 OUTPUT LAYER — MINIMAL INTEGRATION ONLY
// ============================================================

import fp from "fastify-plugin";
import OpenAI from "openai";
import { requireAuth } from "../lib/authMiddleware.js";

// 🔒 DLP
import { runDLPScan, stripSensitiveFields } from "../lib/dlp.js";

// 🔥 Step 46 Reasoning Modules
import { decodeIntent } from "../reasoning/intent.js";
import { assembleContext } from "../reasoning/context.js";
import { inferPaths } from "../reasoning/inference.js";
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
          // 🔥 FINAL ENTITY RESOLUTION (HARD GUARANTEE — FIXED)
          // ============================================================
          let resolvedName = null;

          // 1️⃣ Try context first
          if (ragContext) {
            const match = ragContext.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
            if (match) resolvedName = match[0];
          }

          // 2️⃣ Fallback to user input
          if (!resolvedName) {
            const userMatch = sanitizedMessage.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);
            if (userMatch) resolvedName = userMatch[0];
          }

          // 3️⃣ ALWAYS inject if found
          if (resolvedName) {
            ragContext = `PRIMARY ENTITY (SOURCE OF TRUTH): ${resolvedName}\n\n${ragContext}`;

            const userMatch = sanitizedMessage.match(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/);

            if (userMatch) {
              const userName = userMatch[0];

              if (userName !== resolvedName) {
                normalizedMessage = sanitizedMessage.replace(userName, resolvedName);
              }
            }
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

        const formattedAnswer = formatOutput(rawAnswer, {
          intent,
          userMessage: normalizedMessage,
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
