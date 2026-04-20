import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

// Debug
console.log("🔑 Env Loaded:", {
  OPENAI: process.env.OPENAI_API_KEY ? "ok" : "missing",
  SUPABASE_URL: process.env.SUPABASE_URL ? "ok" : "missing",
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? "ok" : "missing",
});

