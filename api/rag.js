/* ============================================================
   CORTÉX — RAG ENGINE (STEP 29A)
   Adds:
     - Cosine similarity scoring
     - Confidence normalization
     - Ranked match set
   ============================================================ */

import { loadMemory } from "../utils/memory.js";
import { getEmbedding } from "../utils/embed.js";

/* ---------------------------------------------
   Cosine Similarity
--------------------------------------------- */
function cosineSimilarity(a, b) {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/* ---------------------------------------------
   Softmax Confidence (0–1 normalized)
--------------------------------------------- */
function softmax(scores) {
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((x) => x / sum);
}

/* ---------------------------------------------
   RAG SEARCH ENGINE
--------------------------------------------- */
export async function ragSearch(query) {
  const memory = await loadMemory();

  if (!memory || memory.length === 0) {
    return {
      found: false,
      matches: [],
      context: "",
    };
  }

  // Generate embedding for the query text
  const queryEmbedding = await getEmbedding(query);

  // Score all stored docs
  const scores = memory.map((doc) =>
    cosineSimilarity(queryEmbedding, doc.embedding)
  );

  // Softmax → confidence weighting
  const confidence = softmax(scores);

  // Pair results
  let results = memory.map((doc, i) => ({
    docId: doc.docId,
    filename: doc.filename,
    text: doc.text,
    score: scores[i],
    confidence: confidence[i],
  }));

  // Sort highest → lowest relevance
  results.sort((a, b) => b.score - a.score);

  // Top match
  const top = results[0];

  // If top score is extremely weak, treat as “no meaningful match”
  if (!top || top.score < 0.05) {
    return {
      found: false,
      matches: [],
      context: "",
    };
  }

  return {
    found: true,
    matches: results.slice(0, 5), // top 5 for debugging/expansion
    context: top.text,
  };
}

