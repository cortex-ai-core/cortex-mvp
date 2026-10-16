// ===============================================
//  CORTÉX — Supabase Client (JavaScript Version)
//  Required for RAG, Document Storage & Embeddings
// ===============================================

import "../backend/lib/env.js";
import { createDatabaseClient } from "../backend/lib/services/database.js";

// Use the variables you actually have in `.env`
export const supabase = createDatabaseClient();

