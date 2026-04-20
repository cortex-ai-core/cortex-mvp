// lib/memory/internalMemoryTest.ts

// IMPORTANT: Add .js so ESM module resolution works after compilation
import { queryMemory } from "./queryMemory.js";

export async function runInternalMemoryTest() {
  const testQueries = [
    "Who am I?",
    "What is the King's doctrine?",
    "Explain the memory architecture.",
  ];

  const results: Record<string, any> = {};

  for (const q of testQueries) {
    const r = await queryMemory({ query: q, topK: 2 });
    results[q] = r;
  }

  return {
    status: "ok",
    timestamp: Date.now(),
    results,
  };
}

