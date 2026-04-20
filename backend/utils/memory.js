/* ============================================================
   CORTÉX — MEMORY ENGINE (Step 30A)
   Provides safe load + write operations for memory.json
   ============================================================ */

import fs from "fs";
import path from "path";

const memoryPath = path.resolve("./backend/memory/memory.json");

// ------------------------------------------------------------
// LOAD MEMORY (safe, never crashes)
// ------------------------------------------------------------
export function loadMemory() {
  try {
    if (!fs.existsSync(memoryPath)) return {};
    const raw = fs.readFileSync(memoryPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("🧠 Memory Load Error:", err);
    return {};
  }
}

// ------------------------------------------------------------
// SAVE MEMORY
// ------------------------------------------------------------
export function saveMemory(data) {
  try {
    fs.writeFileSync(memoryPath, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("🧠 Memory Save Error:", err);
    return false;
  }
}

// ------------------------------------------------------------
// UPDATE MEMORY
// ------------------------------------------------------------
export function updateMemory(fields) {
  const mem = loadMemory();
  const updated = { ...mem, ...fields };
  saveMemory(updated);
  return updated;
}

