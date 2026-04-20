// lib/rag/storeChunks.ts
// Step 32D-3 — Store Document + Embeddings into Supabase

import { supabase } from "../supabaseClient";

export async function storeDocumentWithChunks(
  docTitle: string,
  chunks: string[],
  embeddings: number[][]
) {
  // 1. Insert document row
  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .insert({ title: docTitle })
    .select()
    .single();

  if (docErr) throw docErr;

  const documentId = doc.id;

  // 2. Build chunk rows
  const rows = chunks.map((text, i) => ({
    document_id: documentId,
    chunk_index: i,
    content: text,
    embedding: embeddings[i]
  }));

  // 3. Insert chunk embeddings
  const { error: chunkErr } = await supabase
    .from("document_chunks")
    .insert(rows);

  if (chunkErr) throw chunkErr;

  return {
    documentId,
    chunksStored: rows.length
  };
}

