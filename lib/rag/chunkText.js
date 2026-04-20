// ===============================================
//  CORTÉX — chunkText.js
//  Intelligent text chunking for RAG (JS version)
// ===============================================

export function chunkText(
  text,
  chunkSize = 800,
  chunkOverlap = 200
) {
  if (!text || typeof text !== "string") return [];

  const cleaned = text
    .replace(/\s+/g, " ")
    .trim();

  let chunks = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = start + chunkSize;

    chunks.push(cleaned.slice(start, end));

    start += chunkSize - chunkOverlap;
  }

  return chunks;
}

