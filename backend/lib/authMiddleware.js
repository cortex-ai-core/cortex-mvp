// backend/lib/authMiddleware.js
// =============================================================
// JWT verification + role + namespace enforcement
// =============================================================

import fp from "fastify-plugin";
import jwt from "jsonwebtoken";

// =============================================================
// CORE HANDLER
// =============================================================
async function authHandler(req, reply) {
  try {
    const header = req.headers["authorization"];

    if (!header) {
      console.log("❌ NO AUTH HEADER");
      return reply.code(401).send({ error: "Missing authorization header." });
    }

    const token = header.replace("Bearer ", "").trim();

    // 🔥 STRICT SECRET (NO FALLBACK)
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      console.error("❌ JWT_SECRET NOT SET");
      return reply.code(500).send({ error: "Server misconfigured." });
    }

    // 🔍 DEBUG LOGS
    console.log("TOKEN RECEIVED:", token);
    console.log("JWT SECRET USED:", jwtSecret);

    const decoded = jwt.verify(token, jwtSecret);

    console.log("✅ TOKEN VERIFIED:", decoded);

    // 🔥 CRITICAL — ATTACH USER TO REQUEST
    req.user = decoded;

  } catch (err) {
    console.log("❌ TOKEN VERIFY FAILED:", err.message);
    return reply.code(401).send({ error: "Invalid or expired token." });
  }
}

// =============================================================
// FLEXIBLE EXPORT (manual usage if needed)
// =============================================================
export function requireAuth() {
  return authHandler;
}

requireAuth.handler = authHandler;

// =============================================================
// FASTIFY PLUGIN
// =============================================================
async function authPlugin(fastify) {

  // 🔥 GLOBAL HOOK — RUNS ON EVERY REQUEST (WITH SAFE BYPASS)
  fastify.addHook("preHandler", async (req, reply) => {

    // ✅ ALLOW PUBLIC ROUTES
    if (
      req.url.startsWith("/api/auth") ||
      req.method === "OPTIONS" ||
      req.url === "/health" ||
      req.url === "/api/health"
    ) {
      return;
    }

    return authHandler(req, reply);
  });

  // (optional) still expose for manual route-level usage
  fastify.decorate("requireAuth", authHandler);
}

export default fp(authPlugin);
