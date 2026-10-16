// backend/lib/authMiddleware.js
// =============================================================
// JWT verification + role + namespace enforcement
// =============================================================

import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import { backendProvider, sessionConfig } from "./services/config.js";

// =============================================================
// CORE HANDLER
// =============================================================
async function authHandler(req, reply) {
  try {
    const header = req.headers["authorization"];

    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing authorization header." });
    }

    const token = header.replace("Bearer ", "").trim();

    // 🔥 STRICT SECRET (NO FALLBACK)
    const session = sessionConfig();
    const jwtSecret = session.secret;

    if (!jwtSecret) {
      console.error("❌ JWT_SECRET NOT SET");
      return reply.code(500).send({ error: "Server misconfigured." });
    }

    const decoded = jwt.verify(token, jwtSecret, { algorithms: ["HS256"], ...session.options });

    if (backendProvider() === "aws") {
      const { data: profile, error } = await req.server.supabase.from("user")
        .select("active,organization_id,role:role_id(name)").eq("id", decoded.userId).maybeSingle();
      if (error) return reply.code(503).send({ error: "Unable to check account access." });
      if (!profile?.active || !profile.role || profile.organization_id !== decoded.organizationId) {
        return reply.code(403).send({ error: "Account access has changed. Sign in again." });
      }
      decoded.role = profile.role.name;
    }

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
      || (process.env.CORTEX_ENV === 'local' && process.env.NODE_ENV !== 'production' && req.url.startsWith('/api/local-files/'))
    ) {
      return;
    }

    return authHandler(req, reply);
  });

  // (optional) still expose for manual route-level usage
  fastify.decorate("requireAuth", authHandler);
}

export default fp(authPlugin);
