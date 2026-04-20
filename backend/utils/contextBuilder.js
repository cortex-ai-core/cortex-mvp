// ============================================================
//  CORTÉX — CONTEXT BUILDER (40B)
//  Builds structured RAG context from vector matches
// ============================================================

export function buildContext(results = [], maxChars = 5000) {
  if (!Array.isArray(results) || results.length === 0) return "";

  let combined = results
    .map((r, i) => {
      return `CHUNK ${i + 1}:
${r.chunk_text || r.text || ""}

(similarity: ${r.similarity ?? "?"})`;
    })
    .join("\n\n");

  if (combined.length > maxChars) {
    combined = combined.slice(0, maxChars) + "\n...[trimmed]";
  }

  return `
### RAG CONTEXT BEGIN
${combined}
### RAG CONTEXT END
`.trim();
}

