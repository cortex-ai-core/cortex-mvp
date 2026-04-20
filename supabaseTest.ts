// supabaseTest.ts
import "dotenv/config";
import { supabase } from "./lib/supabaseClient.js";

async function main() {
  console.log("\n=== Supabase Connectivity Test ===\n");

  const { data, error } = await supabase.from("documents").select("*").limit(1);

  if (error) {
    console.error("Supabase Error:", error);
  } else {
    console.log("Supabase OK — sample rows:");
    console.log(data);
  }

  console.log("\n=================================\n");
}

main();

