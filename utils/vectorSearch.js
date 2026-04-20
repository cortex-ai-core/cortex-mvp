// utils/vectorSearch.js
// STEP 26C — Local Vector Search Engine (Cosine Similarity)

import fs from "fs";
import path from "path";

// Define memory storage path
const MEMORY_FOLDER = path.join(process.cwd(), "memory");

// Ensure memory folder exists
if (!fs.existsSync(MEMORY_FOLDER)) {
  fs.mkdirSync(MEMORY_FOLDER, { recursive: true });
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;

  let dot = 0,
    magA = 0,
    magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Load all stored documents from /memory folder
 */
function loadDocuments() {
  const files = fs.readdirSync(MEMORY_FOLDER);

  return files
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(MEMORY_FOLDER, f), "utf8");
      return JSON.parse(raw);
    });
}

/**
 * Perform vector similarity search against stored documents
 */
export async function vectorSearch(queryEmbedding, topK = 3) {
  const docs = loadDocuments();

  const scored = docs
    .map((doc) => ({
      docId: doc.docId,
      filename: doc.filename,
      text: doc.text.slice(0, 300), // preview only
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

