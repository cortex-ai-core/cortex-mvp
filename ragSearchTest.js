import "./utils/env.js"; // Ensure .env loads
import { ragSearch } from "./lib/rag/search.js";

const run = async () => {
  console.log("=== RAG SEARCH TEST ===");

  try {
    const result = await ragSearch("test query");

    console.log("\n📄 Query:", result.query);
    console.log("📏 Embedding length:", result.embedding_length);
    console.log("🧩 Results returned:", result.results.length);

    console.log("\n==== RAW ROWS ====");
    console.dir(result.raw_rows, { depth: 5 });

  } catch (err) {
    console.error("❌ RAG Search Error:", err);
  }
};

run();

