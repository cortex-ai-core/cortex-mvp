// lib/rag/chunkText.ts
// Step 32D-1 — Intelligent Text Chunking for RAG

export function chunkText(
  text: string,
  chunkSize: number = 800,
  chunkOverlap: number = 200
): string[] {
  const cleaned = text
    .replace(/\s+/g, " ")
    .trim();

  let chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = start + chunkSize;

    chunks.push(cleaned.slice(start, end));

    start += chunkSize - chunkOverlap;
  }

  return chunks;
}

