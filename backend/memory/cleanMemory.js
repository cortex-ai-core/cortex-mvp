// backend/memory/cleanMemory.js
// ------------------------------------------------------
// Memory Cleanup Script — Safely remove malformed entries
// ------------------------------------------------------

import fs from "fs";
import path from "path";

const MEMORY_PATH = path.join(process.cwd(), "backend/memory/memory.json");

// 1. Load memory.json
let mem;
try {
  const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
  mem = JSON.parse(raw);
} catch (err) {
  console.error("❌ Could not read memory.json:", err);
  process.exit(1);
}

if (!Array.isArray(mem)) {
  console.error("❌ memory.json is not an array. Aborting.");
  process.exit(1);
}

// 2. Filter valid entries
const valid = [];
const removed = [];

for (const entry of mem) {
  const hasId = typeof entry.id === "number";
  const hasRaw = entry.raw && typeof entry.raw === "object";
  const hasEmbedding =
    entry.embedding && Array.isArray(entry.embedding) && entry.embedding.length > 0;

  if (hasId && hasRaw && hasEmbedding) {
    valid.push(entry);
  } else {
    removed.push(entry);
  }
}

// 3. Save cleaned memory.json
try {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(valid, null, 2));
  console.log("✨ Memory cleanup complete.");
  console.log(`✔ Valid entries kept:   ${valid.length}`);
  console.log(`🗑 Malformed removed:    ${removed.length}`);
} catch (err) {
  console.error("❌ Failed to write cleaned memory.json:", err);
  process.exit(1);
}

