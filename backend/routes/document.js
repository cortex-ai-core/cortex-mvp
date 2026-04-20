// ============================================================
// DOCUMENT ROUTES
// ============================================================

export default async function (fastify, opts) {

  // ==========================================================
  // GET /api/documents (🔥 FIXED — REAL FILE NAMES + COUNTS)
  // ==========================================================
  fastify.get("/api/documents", async (request, reply) => {
    try {
      const user = request.user?.user || request.user;

      if (!user) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      // ------------------------------------------------------
      // STEP 1 — GET DOCUMENT METADATA
      // ------------------------------------------------------
      const { data: docs, error: docsError } = await fastify.supabase
        .from("documents")
        .select("id, file_name, namespace")
        .eq("namespace", user.namespace);

      if (docsError) {
        console.error("GET DOCUMENT METADATA ERROR:", docsError);
        return reply.code(500).send({ error: "Failed to fetch documents" });
      }

      // ------------------------------------------------------
      // STEP 2 — GET CHUNK DATA
      // ------------------------------------------------------
      const { data: chunks, error: chunkError } = await fastify.supabase
        .from("document_chunks")
        .select("document_id")
        .eq("namespace", user.namespace)
        .not("document_id", "is", null);

      if (chunkError) {
        console.error("GET DOCUMENT CHUNKS ERROR:", chunkError);
        return reply.code(500).send({ error: "Failed to fetch chunks" });
      }

      // ------------------------------------------------------
      // STEP 3 — BUILD CHUNK COUNT MAP
      // ------------------------------------------------------
      const countMap = {};

      for (const row of chunks) {
        countMap[row.document_id] = (countMap[row.document_id] || 0) + 1;
      }

      // ------------------------------------------------------
      // STEP 4 — MERGE DOCUMENT + COUNT
      // ------------------------------------------------------
      const documents = docs.map(doc => ({
        document_id: doc.id,
        file_name: doc.file_name,
        namespace: doc.namespace,
        chunk_count: countMap[doc.id] || 0,
      }));

      return reply.send({ documents });

    } catch (err) {
      console.error("GET DOCUMENTS FAILURE:", err);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  // ==========================================================
  // DELETE /api/documents/:document_id (🔥 FULL FIX — BOTH TABLES)
  // ==========================================================
  fastify.delete("/api/documents/:document_id", async (request, reply) => {
    try {
      const { document_id } = request.params;
      const user = request.user?.user || request.user;

      if (!user || user.role !== "super_admin") {
        return reply.code(403).send({
          success: false,
          error: "Forbidden — insufficient permissions",
        });
      }

      if (!document_id) {
        return reply.code(400).send({
          success: false,
          error: "Missing document_id",
        });
      }

      console.log("🧠 DELETE INPUT:", {
        document_id,
        namespace: user.namespace,
      });

      // ------------------------------------------------------
      // STEP 1 — DELETE CHUNKS (cleanup layer)
      // ------------------------------------------------------
      const { error: chunkError } = await fastify.supabase
        .from("document_chunks")
        .delete()
        .eq("document_id", document_id)
        .eq("namespace", user.namespace);

      if (chunkError) {
        console.error("DELETE CHUNKS ERROR:", chunkError);
        return reply.code(500).send({
          success: false,
          error: "Failed to delete chunks",
        });
      }

      // ------------------------------------------------------
      // STEP 2 — DELETE DOCUMENT (source of truth)
      // ------------------------------------------------------
      const { data: docData, error: docError } = await fastify.supabase
        .from("documents")
        .delete()
        .eq("id", document_id)
        .eq("namespace", user.namespace)
        .select();

      if (docError) {
        console.error("DELETE DOCUMENT ERROR:", docError);
        return reply.code(500).send({
          success: false,
          error: "Failed to delete document",
        });
      }

      // ------------------------------------------------------
      // STEP 3 — IDEMPOTENT RESPONSE (🔥 NO MORE 404 NOISE)
      // ------------------------------------------------------
      return reply.send({
        success: true,
        deleted: true,
        deletedDocument: docData?.[0] || null,
      });

    } catch (err) {
      console.error("DELETE ROUTE FAILURE:", err);
      return reply.code(500).send({
        success: false,
        error: "Internal server error",
      });
    }
  });

}
