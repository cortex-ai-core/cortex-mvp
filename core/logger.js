// core/logger.js
// STEP 34H — Dual-Channel Logging Engine (DLE)

// ENV flag: controls whether logs appear on the server
const DEV_MODE = process.env.CORTEX_DEV_LOGS === "true";

// -----------------------------
// INTERNAL ENGINE LOGS
// -----------------------------
export function devLog(...args) {
  if (DEV_MODE) {
    console.log("🟦 DEV:", ...args);
  }
}

// -----------------------------
// UI-SAFE LOG MESSAGES
// (Never expose internal stack traces)
// -----------------------------
export function uiLog(message) {
  return {
    type: "log",
    message: String(message || "").trim(),
    timestamp: Date.now(),
  };
}

