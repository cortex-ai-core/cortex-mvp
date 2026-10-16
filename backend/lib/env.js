// =============================================================
//  Environment loader. Import this FIRST in server.js.
//  ES module imports are evaluated before any code in the importing
//  file runs, so calling dotenv inline in server.js is too late for
//  modules that read process.env at import time.
//
//  CORTEX_ENV=production → .env.production, otherwise .env
// =============================================================

import dotenv from "dotenv";

if (process.env.CORTEX_ENV === 'local' && process.env.NODE_ENV === 'production') throw new Error('Local mode cannot run in production.');
const file = process.env.CORTEX_ENV === 'local' ? './.local/dev/app.env' : process.env.CORTEX_ENV === "aws" ? "./.env.aws" :
  process.env.CORTEX_ENV === "production" ? "./.env.production" : "./.env";
dotenv.config({ path: file });
if (process.env.CORTEX_ENV === "aws" && process.env.BACKEND_PROVIDER !== "aws") {
  throw new Error("CORTEX_ENV=aws requires BACKEND_PROVIDER=aws in .env.aws.");
}

export const ENV_FILE = file;
