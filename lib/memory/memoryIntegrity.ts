// lib/memory/memoryIntegrity.ts
// Step 30L-3 — Memory Integrity Snapshot Generator

import { queryMemory } from "./queryMemory.js";

export async function generateMemoryIntegritySnapshot() {
  const probe = "integrity check";

  const results = await queryMemory({ query: probe, topK: 2 });

  const snapshot = {
    version: 1,
    generatedAt: Date.now(),
    probe,
    structure: {
      memoryId: typeof results[0]?.memoryId,
      text: typeof results[0]?.text,
      score: typeof results[0]?.score,
      metadata: typeof results[0]?.metadata
    }
  };

  return snapshot;
}

