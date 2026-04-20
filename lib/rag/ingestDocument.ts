// lib/rag/ingestDocument.ts
// Step 32E — Document ingestion pipeline (mock embedding stage)

import { supabase } from "../supabaseClient.js";
import { extractTextFromFile } from "./extractText.js";
import { embedText } from "../embedding.js"; // still imported but NOT inserted yet

/**
 * Split long text into smaller chunks
 */
function chunkText(text: string, maxLength = 800): string[] {
  const words = text.split(" ");
  const chunks: string[] = [];
  let current = [];

  for (const w of words) {
    if (current.join(" ").length + w.length > maxLength) {
      chunks.push(current.join(" "));
      current = [];
    }
    current.push(w);
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }

  return chunks;
}

/**
 * Ingest document into Supabase
 */
export async function ingestDocument(filePath: string) {
  // 1. Extract text
  const text = await extractTextFromFile(filePath);
  console.log(`📄 Extracted text from: ${filePath}`);
  console.log(`📄 Document length: ${text.length} chars`);

  // 2. Insert document row
  const { data: docData, error: docErr } = await supabase
    .from("documents")
    .insert({
      file_name: filePath,
      content: text
    })
    .select()
    .single();

  if (docErr) {
    console.error("❌ Document Insert Error:", docErr);
    throw docErr;
  }

  const docId = docData.id;
  console.log(`✅ Document stored: ${docId}`);

  // 3. Chunk text
  const chunks = chunkText(text);
  console.log(`🧩 Generated ${chunks.length} chunks`);

  // 4. Insert chunks (NO embeddings yet)
  for (let i = 0; i < chunks.length; i++) {
    const chunkTextStr = chunks[i];

    // embedding generated but NOT used due to dimensional mismatch
    const mockEmbedding = await embedText(chunkTextStr);

    const { error: chunkErr } = await supabase
      .from("document_chunks")
      .insert({
        document_id: docId,
        chunk_index: i,
        chunk_text: chunkTextStr,
        // embedding: mockEmbedding,   <-- REMOVED FOR NOW (1536 required)
      });

    if (chunkErr) {
      console.error("❌ Chunk Insert Error:", chunkErr);
      throw chunkErr;
    }
  }

  console.log("✅ All chunks inserted successfully.");
  return { success: true, documentId: docId };
}

