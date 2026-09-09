// =============================================================
//  Environment loader. Import this FIRST in server.js.
//  ES module imports are evaluated before any code in the importing
//  file runs, so calling dotenv inline in server.js is too late for
//  modules that read process.env at import time.
//
//  CORTEX_ENV=production → .env.production, otherwise .env
// =============================================================

import dotenv from "dotenv";

const file = process.env.CORTEX_ENV === "production" ? "./.env.production" : "./.env";
dotenv.config({ path: file });

export const ENV_FILE = file;
