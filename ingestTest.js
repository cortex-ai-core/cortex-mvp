// ingestTest.js
// Step 32F — Full RAG Ingestion Test Runner (JavaScript Version)

import "dotenv/config";
import { ingestDocument } from "./lib/rag/ingestDocument.js";

async function main() {
  console.log("\n=== Cortéx Ingestion Test ===");

  const filePath = "./sample.txt"; // change if testing PDF or DOCX

  try {
    const result = await ingestDocument(filePath);

    console.log("\n=== Ingestion Result ===");
    console.log(JSON.stringify(result, null, 2));
    console.log("\n=== Ingestion Test Complete ===\n");
  } catch (err) {
    console.error("\n❌ Ingestion Test Failed");
    console.error(err);
    console.log("\n=============================\n");
  }
}

main();

