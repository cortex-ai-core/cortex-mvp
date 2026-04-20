// api/memory/query.js

import { queryMemory } from "../../lib/memory/queryMemory.js";
import { summarizeMemoryResults } from "../../lib/memory/memorySummary.js";

export async function POST(req, reply) {
  try {
    const body = await req.body;

    const { query, topK = 5 } = body;

    const mem = await queryMemory({ query, topK });

    const summary = summarizeMemoryResults(mem.raw);

    return reply.send({
      ok: true,
      query,
      summary,
      raw: mem.raw,
      normalized: mem.normalized
    });
  } catch (err) {
    console.error("❌ Memory Query Error:", err);
    return reply.code(500).send({ ok: false, error: err.message });
  }
}

