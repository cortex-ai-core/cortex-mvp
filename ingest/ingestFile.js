// ingest/ingestFile.js
// ============================================================
//  CORTÉX — DOCUMENT INGESTION PIPELINE (Step 40C + 40D)
// ============================================================

import fs from "fs";
import path from "path";
// FINAL FIX FOR NODE 22 + ESM
import pdfParse from "pdf-parse-fixed";
import mammoth from "mammoth";


import crypto from "crypto";
import { OpenAI } from "openai";
import { upsertVectors } from "../lib/vectorClient.js";

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------------------------------------------------
// 1. LOAD + EXTRACT TEXT
// ------------------------------------------------------------
async function loadFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".txt") {
    return fs.readFileSync(filePath, "utf8");
  }

  if (ext === ".pdf") {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);  // ← WORKS WITH CURRENT PACKAGE EXPORTS
    return data.text;
  }

  if (ext === ".docx") {
    const buffer = fs.readFileSync(filePath);
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ------------------------------------------------------------
// 2. CHUNKER
// ------------------------------------------------------------
function chunkText(text, chunkSize = 750, overlap = 100) {
  const words = text.split(/\s+/);
  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize - overlap) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.trim().length > 0) chunks.push(chunk);
  }
  return chunks;
}

// ------------------------------------------------------------
// 3. EMBED + INSERT INTO VECTOR DB
// ------------------------------------------------------------
async function embedAndInsert(chunks) {
  for (const chunk of chunks) {
    const embedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: chunk,
    });

    await upsertVectors([
      {
        id: crypto.randomUUID(),
        values: embedding.data[0].embedding, // exactly 1536-dim
        text: chunk,
        metadata: {
          source: "local_file",
          length: chunk.length,
        },
      },
    ]);
  }
}

// ------------------------------------------------------------
// 4. MAIN EXECUTION
// ------------------------------------------------------------
async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node ingest/ingestFile.js <path-to-file>");
    process.exit(1);
  }

  console.log("📄 Loading file:", filePath);
  const raw = await loadFile(filePath);

  console.log("✂️ Chunking...");
  const chunks = chunkText(raw);

  console.log("🧠 Embedding + inserting", chunks.length, "chunks...");
  await embedAndInsert(chunks);

  console.log("✅ Ingestion complete!");
}

run().catch((err) => {
  console.error("❌ INGEST ERROR:", err);
});

