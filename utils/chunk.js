// ============================================================
// Cortéx Chunking Engine — Step 15D
// Breaks large text into embedding-ready segments
// Target chunk size: 500–1000 chars (tunable later)
// ============================================================

// Normalize whitespace, remove weird characters, etc.
export function cleanText(text) {
  return text
    .replace(/\r/g, "")          // remove Windows line breaks
    .replace(/\t/g, " ")         // remove tabs
    .replace(/ +/g, " ")         // collapse multiple spaces
    .replace(/\n{3,}/g, "\n\n")  // max double line breaks
    .trim();
}

// Main chunking function
export function chunkText(text, maxLength = 800) {
  text = cleanText(text);

  const paragraphs = text.split("\n");
  const chunks = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    // If adding the new paragraph exceeds limit → push chunk
    if ((currentChunk + para).length > maxLength) {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
    }

    // Add paragraph to the chunk
    currentChunk += para + "\n";
  }

  // Push final chunk
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// Utility to chunk documents with metadata
export function prepareChunks(text, sourceName = "unknown") {
  const rawChunks = chunkText(text);

  return rawChunks.map((chunk, idx) => ({
    id: `${sourceName}-${idx + 1}`,
    content: chunk,
    source: sourceName,
  }));
}

