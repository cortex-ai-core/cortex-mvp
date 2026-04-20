// utils/memory.js
// STEP 26C — Cortéx Memory Vault (Local JSON Storage)

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEMORY_DIR = path.join(__dirname, "../backend/memory");
const MEMORY_PATH = path.join(MEMORY_DIR, "memory.json");

// -------------------------------------------------------------
// Ensure memory directory + file exist
// -------------------------------------------------------------
async function ensureMemoryFile() {
  try {
    await fs.mkdir(MEMORY_DIR, { recursive: true });

    try {
      await fs.access(MEMORY_PATH);
    } catch {
      // File doesn't exist → create empty array
      await fs.writeFile(MEMORY_PATH, "[]", "utf8");
    }
  } catch (err) {
    console.error("❌ Error ensuring memory vault:", err);
  }
}

// -------------------------------------------------------------
// Load all stored documents (always returns an array)
// -------------------------------------------------------------
export async function loadMemory() {
  await ensureMemoryFile();

  try {
    const data = await fs.readFile(MEMORY_PATH, "utf8");
    const parsed = JSON.parse(data);

    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("❌ Error reading memory.json:", err);
    return [];
  }
}

// -------------------------------------------------------------
// Save updated memory list
// -------------------------------------------------------------
export async function saveMemory(memory) {
  await ensureMemoryFile();

  try {
    await fs.writeFile(
      MEMORY_PATH,
      JSON.stringify(memory, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("❌ Error writing memory.json:", err);
  }
}

// -------------------------------------------------------------
// Add new document to memory
// -------------------------------------------------------------
export async function addDocument(doc) {
  const memory = await loadMemory();

  // Guarantee memory is always an array
  const safeMemory = Array.isArray(memory) ? memory : [];

  safeMemory.push(doc);

  await saveMemory(safeMemory);
}

