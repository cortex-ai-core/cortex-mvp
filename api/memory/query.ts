// api/memory/query.ts
// Corrected for Node backend (NOT Next.js)

import { queryMemory } from "../../lib/memory/queryMemory";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query, topK } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({
        error: "Missing or invalid 'query'"
      });
    }

    const results = await queryMemory({ query, topK });

    return res.status(200).json({ results });
  } catch (err) {
    console.error("Memory API Error:", err);
    return res.status(500).json({
      error: "Memory query failed"
    });
  }
}

