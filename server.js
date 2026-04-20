// =============================================================
//  CORTÉX — SERVER ENGINE (FULL STAGE-46 RESTORE + 47.6G READY)
// =============================================================

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

console.log("ENV JWT_SECRET:", process.env.JWT_SECRET);

import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

import authPlugin from "./backend/lib/authMiddleware.js";

const fastify = Fastify({ logger: true });

// -------------------------------------------------------------
// CORS
// -------------------------------------------------------------
await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// -------------------------------------------------------------
// AUTH
// -------------------------------------------------------------
await fastify.register(authPlugin);

// -------------------------------------------------------------
// SUPABASE
// -------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

fastify.decorate("supabase", supabase);

// -------------------------------------------------------------
// OPENAI
// -------------------------------------------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

fastify.decorate("openai", openai);

// -------------------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------------------
fastify.get("/api/health", async () => ({
  status: "ok",
  cortex: "stage-46-restored"
}));

// =============================================================
//  LOAD ROUTES (🔥 HARDENED FILTER — NO DRIFT)
// =============================================================
const routesDir = path.join(process.cwd(), "backend", "routes");

// 🔒 OPTIONAL: STRICT WHITELIST (SAFEST)
// Comment this out if you want dynamic expansion later
const allowedRoutes = new Set([
  "auth.js",
  "chat.js",
  "document.js",
  "ingest.js",
  "retrieve.js" 
]);

for (const file of fs.readdirSync(routesDir)) {

  // ----------------------------------------------------------
  // FILTER: Only valid route files
  // ----------------------------------------------------------
  if (!file.endsWith(".js")) continue;
  if (file.includes(".bak")) continue;

  // 🔥 Skip middleware / utilities explicitly
  if (file.toLowerCase().includes("middleware")) continue;

  // 🔥 Enforce whitelist (prevents accidental route overrides)
  if (!allowedRoutes.has(file)) {
    console.warn(`⚠️ Skipping ${file} — not in allowed route list`);
    continue;
  }

  console.log(`📡 Loading route: ${file}`);

  const routePath = path.join(routesDir, file);
  const module = await import(routePath);

  if (typeof module.default === "function") {
    await fastify.register(module.default);
  } else {
    console.warn(`⚠️ Skipping ${file} — no default export`);
  }
}

// =============================================================
//  START SERVER
// =============================================================
try {
  await fastify.listen({ port: 8080 });
  console.log("🔥 CORTÉX SERVER RUNNING — PORT 8080 [STAGE-46 + 47.6G]");
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
