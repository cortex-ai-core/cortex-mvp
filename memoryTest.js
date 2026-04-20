// memoryTest.js
// Runs against the compiled JS in /dist after TypeScript build

import { queryMemory } from "./dist/lib/memory/queryMemory.js";

async function run() {
  try {
    const result = await queryMemory({
      query: "What does the King say about discipline?",
      topK: 3,
    });

    console.log("\n=== Cortéx Memory Test Output ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("=================================\n");
  } catch (err) {
    console.error("\n❌ Cortéx Memory Test Failed");
    console.error(err);
    console.log("\nCheck if TypeScript compiled correctly and verify file paths.");
  }
}

run();

