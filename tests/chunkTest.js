// =============================================================
//  CORTÉX — FASTIFY CHUNK INSPECTION TEST
//  PURPOSE:
//    Prove whether your Fastify/Node HTTP layer is merging,
//    buffering, or altering streamed chunks.
// =============================================================

import Fastify from "fastify";

const fastify = Fastify({
  logger: true
});

// -------------------------------------------------------------
//  TEST ROUTE — emits MANY micro-chunks
// -------------------------------------------------------------
fastify.get("/chunk-test", async (req, reply) => {
  reply.raw.setHeader("Content-Type", "text/plain; charset=utf-8");

  // OPTIONAL: Toggle these to observe behavior:
  // reply.raw.setHeader("X-Accel-Buffering", "no");
  // reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  // reply.raw.setHeader("Connection", "keep-alive");

  reply.raw.flushHeaders();

  // Emit intentionally tiny chunks
  const chunks = [
    "I",
    "am",
    " ",
    "CORT",
    "É",
    "X",
    " ",
    "—",
    " ",
    "the",
    " ",
    "KING",
    "’",
    "s",
    " ",
    "engine."
  ];

  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    reply.raw.write(part);

    console.log(`[SERVER SENT CHUNK]: "${part}"`);

    // tiny delay to simulate OpenAI token timing
    await new Promise(r => setTimeout(r, 15));
  }

  reply.raw.end();
});

// -------------------------------------------------------------
fastify.listen({ port: 8090 }, err => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log("🚀 Chunk test running on http://localhost:8090/chunk-test");
});

