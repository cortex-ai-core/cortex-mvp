// memoryIntegrityTest.ts
// Cortéx Memory Integrity Snapshot Runner

// IMPORTANT: explicit .js extension so compiled output resolves correctly
import { generateMemoryIntegritySnapshot } from "./lib/memory/memoryIntegrity.js";

async function main() {
  console.log("\n=== Cortéx Memory Integrity Snapshot ===\n");

  try {
    const snapshot = await generateMemoryIntegritySnapshot();
    console.log(JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error("Snapshot Error:", err);
  }

  console.log("\n========================================\n");
}

main();

