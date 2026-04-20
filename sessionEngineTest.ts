// sessionEngineTest.ts
// Step 31 Test Harness — Ensures Session Engine Works End-to-End

import { prepareCortexSession } from "./lib/session/sessionOrchestrator.js";
import { getSession } from "./lib/session/sessionStore.js";

async function runTest() {
  console.log("\n=== Cortéx Session Engine Test ===\n");

  const messages = [
    "Who am I?",
    "What is the King's Doctrine?",
    "Explain the memory system.",
    "Summarize my last message."
  ];

  for (const msg of messages) {
    console.log(`\n--- User Message: "${msg}" ---\n`);

    const payload = await prepareCortexSession(msg);

    console.log("Generated Payload:\n", JSON.stringify(payload, null, 2));

    const session = getSession();
    console.log("\nUpdated Session State:\n", JSON.stringify(session, null, 2));
  }

  console.log("\n=== End of Session Engine Test ===\n");
}

runTest();

