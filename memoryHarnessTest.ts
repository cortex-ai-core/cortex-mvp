// memoryHarnessTest.ts
// Cortéx Internal Memory Harness Runner (Step 30L)

// IMPORTANT: explicit .js extension so Node can resolve compiled output
import { runInternalMemoryTest } from "./lib/memory/internalMemoryTest.js";

async function main() {
  console.log("\n=== Cortéx Internal Memory Harness ===\n");

  try {
    const output = await runInternalMemoryTest();
    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.error("Memory Harness Error:", err);
  }

  console.log("\n======================================\n");
}

main();

