import OpenAI from "openai";
import { supabase } from "../lib/vectorClient.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function run() {
  console.log("Generating embedding...");

  const e = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: "This is a test document chunk for Cortéx RAG."
  });

  const embedding = e.data[0].embedding;

  console.log("Inserting into Supabase...");

  const { data, error } = await supabase
    .from("cortex_vectors")
    .insert({
      id: Date.now(),
      content: "This is a test document chunk for Cortéx RAG.",
      embedding,
      metadata: { source: "test", chunk: 1 }
    });

  if (error) {
    console.error("INSERT ERROR:", error);
  } else {
    console.log("SUCCESS:", data);
  }
}

run();

