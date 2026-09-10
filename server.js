// =============================================================
//  CORTÉX — SERVER ENGINE (FULL STAGE-46 RESTORE + 47.6G READY)
// =============================================================

// Must be the first import: loads .env (or .env.production) before any other module reads process.env
import "./backend/lib/env.js";

// 🔥 NEW — ENV DEBUG (NO DRIFT)
console.log("ENV CHECK:", {
  JWT_SECRET: process.env.JWT_SECRET ? "SET" : "MISSING",
  SUPABASE_URL: process.env.SUPABASE_URL,
  HAS_SUPABASE: !!process.env.SUPABASE_URL,
  OPENAI_KEY: process.env.OPENAI_API_KEY ? "SET" : "MISSING"
});

import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

import multipart from "@fastify/multipart";
import authPlugin from "./backend/lib/authMiddleware.js";
import { createIngestWorker } from "./backend/ingest/worker.js";
import { parserHealth } from "./backend/ingest/parserClient.js";
import { describeDefaults } from "./backend/memory/settings.js";

// ✅ FIX APPLIED — bodyLimit added (NO OTHER CHANGES)
const fastify = Fastify({
  logger: true,
  bodyLimit: 1048576 // 1MB
});

// -------------------------------------------------------------
// CORS
// -------------------------------------------------------------
await fastify.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// -------------------------------------------------------------
// AUTH
// -------------------------------------------------------------
await fastify.register(multipart, {
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024,
    files: 1,
  },
});

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
// INGEST WORKER + PARSER STATUS (started after listen)
// -------------------------------------------------------------
const ingestWorker = createIngestWorker(fastify);
fastify.decorate("ingestWorker", ingestWorker);

// Memory switches at boot (design doc 5.12). Namespace rows override these at runtime.
fastify.log.info({ memory: describeDefaults() }, "memory: defaults loaded");

let parserStatusCache = { at: 0, value: null };
fastify.decorate("parserStatus", async () => {
  if (Date.now() - parserStatusCache.at > 15000) {
    parserStatusCache = { at: Date.now(), value: await parserHealth() };
  }
  return parserStatusCache.value ? { online: true, ...parserStatusCache.value } : { online: false };
});

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

const allowedRoutes = new Set([
  "auth.js",
  "chat.js",
  "document.js",
  "documentTypes.js",
  "ingest.js",
  "retrieve.js",
  "settings.js",
  "conversations.js"
]);

for (const file of fs.readdirSync(routesDir)) {
  if (!file.endsWith(".js")) continue;
  if (file.includes(".bak")) continue;
  if (file.toLowerCase().includes("middleware")) continue;

  if (!allowedRoutes.has(file)) {
    console.warn(`⚠️ Skipping ${file} — not in allowed route list`);
    continue;
  }

  console.log(`📡 Loading route: ${file}`);

  const routePath = path.join(routesDir, file);
  const module = await import(pathToFileURL(routePath).href);

  if (typeof module.default === "function") {
    await fastify.register(module.default);
  } else {
    console.warn(`⚠️ Skipping ${file} — no default export`);
  }
}

// =============================================================
//  START SERVER (✅ FIXED FOR RAILWAY)
// =============================================================
try {
  const PORT = process.env.PORT || 8080;

  await fastify.listen({
    port: PORT,
    host: "0.0.0.0"
  });

  console.log(`🔥 CORTÉX SERVER RUNNING — PORT ${PORT} [STAGE-46 + 47.6G]`);

  if (process.env.INGEST_WORKER !== "off") {
    ingestWorker.start();
  }

} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
