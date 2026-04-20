// backend/memory/memory.js
// ------------------------------------------------------
// STEP 30G — Sovereign Memory Engine with Embeddings
// ------------------------------------------------------

import fs from "fs";
import path from "path";
import { embedMemoryText } from "./embed.js";

// Absolute path to memory.json within backend/memory/
const MEMORY_DIR = path.join(process.cwd(), "backend/memory");
const MEMORY_PATH = path.join(MEMORY_DIR, "memory.json");

// Ensure directory exists
function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

// Load memory file
export function loadMemory() {
  ensureMemoryDir();

  try {
    if (!fs.existsSync(MEMORY_PATH)) {
      console.warn("⚠️ memory.json not found. Creating new one.");
      fs.writeFileSync(MEMORY_PATH, JSON.stringify([], null, 2), "utf-8");
      return [];
    }

    const raw = fs.readFileSync(MEMORY_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Error reading memory.json:", err);
    return [];
  }
}

// Save memory file
export function saveMemory(memArray) {
  ensureMemoryDir();

  try {
    fs.writeFileSync(
      MEMORY_PATH,
      JSON.stringify(memArray, null, 2),
      "utf-8"
    );
  } catch (err) {
    console.error("❌ Error saving memory.json:", err);
  }
}

// Store memory entry WITH embedding
export async function storeMemory(updateObj) {
  const memArray = loadMemory();

  // Convert update object into embedding text
  const textForEmbedding = JSON.stringify(updateObj);

  // Get semantic embedding
  const embedding = await embedMemoryText(textForEmbedding);

  // Create stored memory entry
  const entry = {
    id: Date.now(),
    raw: updateObj,     // original memory payload
    embedding,          // numeric vector
    timestamp: Date.now()
  };

  // Save entry
  memArray.push(entry);
  saveMemory(memArray);

  return entry;
}

