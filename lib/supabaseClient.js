// ===============================================
//  CORTÉX — Supabase Client (JavaScript Version)
//  Required for RAG, Document Storage & Embeddings
// ===============================================

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// Use the variables you actually have in `.env`
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;  // ← correct variable


// Safety checks
if (!url) {
  console.error("❌ Missing SUPABASE_URL in environment.");
  process.exit(1);
}

if (!key) {
  console.error("❌ Missing SUPABASE_SERVICE_ROLE_KEY in environment.");
  process.exit(1);
}

// Create the Supabase client with the service role key
export const supabase = createClient(url, key, {
  auth: {
    persistSession: false,
  },
});

// Optional diagnostic
console.log("🟢 Supabase client initialized (JS)");

