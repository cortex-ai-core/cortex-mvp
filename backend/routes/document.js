// ============================================================
//  DOCUMENT ROUTES
//  list · upload · status · retry · original file · delete
// ============================================================

import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import { hasPermission, identityFrom } from "../lib/permissions.js";
import { originalPath, documentPrefix, uploadObject, deletePrefix, signedUrl } from "../ingest/storage.js";
import { searchTitle } from "../ingest/worker.js";   // pure helper; worker.js has no import-time side effects

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

const ALLOWED_EXT = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".md", ".txt", ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".tif", ".tiff",
]);

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown", ".txt": "text/plain", ".html": "text/html", ".htm": "text/html",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff",
};

const LIST_FIELDS =
  "id, file_name, display_name, document_type, description, namespace, status, stage_progress, stage_detail, error, page_count, parser, byte_size, mime_type, storage_path, rendition_path, created_at, updated_at";

function publicDoc(doc, chunkCount) {
  return {
    document_id: doc.id,
    file_name: doc.file_name,
    display_name: doc.display_name || null,
    document_type: doc.document_type || null,
    description: doc.description || null,
    has_rendition: Boolean(doc.rendition_path),
    namespace: doc.namespace,
    status: doc.status,
    stage_progress: doc.stage_progress,
    stage_detail: doc.stage_detail,
    error: doc.error,
    page_count: doc.page_count,
    parser: doc.parser,
    byte_size: doc.byte_size,
    has_original: Boolean(doc.storage_path),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    chunk_count: chunkCount ?? undefined,
  };
}

export default async function documentRoutes(fastify) {

  // ==========================================================
  // GET /api/documents
  // ==========================================================
  fastify.get("/api/documents", async (request, reply) => {
    const identity = identityFrom(request);
    if (!identity.namespace) return reply.code(401).send({ error: "Unauthorized" });

    const { data: docs, error: docsError } = await fastify.supabase
      .from("documents")
      .select(LIST_FIELDS)
      .eq("namespace", identity.namespace)
      .order("created_at", { ascending: false });

    if (docsError) {
      fastify.log.error({ err: docsError.message }, "documents: list failed");
      return reply.code(500).send({ error: "Failed to fetch documents" });
    }

    const { data: chunks, error: chunkError } = await fastify.supabase
      .from("document_chunks")
      .select("document_id")
      .eq("namespace", identity.namespace)
      .not("document_id", "is", null);

    if (chunkError) {
      fastify.log.error({ err: chunkError.message }, "documents: chunk count failed");
      return reply.code(500).send({ error: "Failed to fetch chunks" });
    }

    const countMap = {};
    for (const row of chunks) countMap[row.document_id] = (countMap[row.document_id] || 0) + 1;

    return reply.send({
      documents: docs.map((d) => publicDoc(d, countMap[d.id] || 0)),
      parser: await fastify.parserStatus(),
    });
  });

  // ==========================================================
  // POST /api/documents/upload   (multipart: file)
  // ==========================================================
  fastify.post("/api/documents/upload", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "upload")) {
      return reply.code(403).send({ error: "Your role can't upload documents to this workspace." });
    }

    // Walk every multipart part: text fields (display_name, document_type,
    // description) plus exactly one file, buffered and hashed in one pass.
    const fields = {};
    let part = null;
    let pieces = [];
    let size = 0;
    let truncated = false;
    const hash = createHash("sha256");

    for await (const p of request.parts()) {
      if (p.type !== "file") {
        fields[p.fieldname] = String(p.value ?? "").trim();
        continue;
      }
      if (part) { p.file.resume(); continue; } // only the first file counts
      part = p;
      const ext = extname((p.filename || "").trim()).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        p.file.resume();
        return reply.code(415).send({
          error: `"${ext || "no extension"}" files aren't supported. Use PDF, Word, PowerPoint, Excel, Markdown, text, HTML, or images.`,
        });
      }
      for await (const piece of p.file) {
        hash.update(piece);
        pieces.push(piece);
        size += piece.length;
      }
      truncated = Boolean(p.file.truncated);
    }

    if (!part) return reply.code(400).send({ error: "No file was attached." });
    if (truncated) return reply.code(413).send({ error: `That file is larger than the ${MAX_UPLOAD_MB} MB limit.` });
    if (size === 0) return reply.code(400).send({ error: "That file is empty." });

    const fileName = (part.filename || "upload").trim();
    const ext = extname(fileName).toLowerCase();
    const buffer = Buffer.concat(pieces);
    const sha256 = hash.digest("hex");
    const namespace = identity.namespace;
    const supabase = fastify.supabase;

    const displayName = (fields.display_name || "").slice(0, 160) || null;
    const description = (fields.description || "").slice(0, 1000) || null;
    let documentType = (fields.document_type || "").slice(0, 60) || null;
    if (documentType) {
      const { data: t } = await supabase
        .from("document_types").select("name").eq("namespace", namespace).eq("name", documentType).maybeSingle();
      if (!t) return reply.code(400).send({ error: `"${documentType}" isn't a document type in this workspace.` });
      documentType = t.name;
    }

    // exact duplicate in this workspace → no-op
    const { data: dup } = await supabase
      .from("documents")
      .select("id, file_name, status")
      .eq("namespace", namespace)
      .eq("sha256", sha256)
      .maybeSingle();

    if (dup) {
      return reply.send({
        document_id: dup.id,
        file_name: dup.file_name,
        status: dup.status,
        duplicate: true,
        message: `Already in this workspace as "${dup.file_name}". Nothing was changed.`,
      });
    }

    // same name as a text-only legacy document → replace it, keep its id
    const { data: legacy } = await supabase
      .from("documents")
      .select("id")
      .eq("namespace", namespace)
      .eq("file_name", fileName)
      .eq("parser", "legacy")
      .maybeSingle();

    const documentId = legacy?.id || randomUUID();
    const storagePath = originalPath(namespace, documentId, ext);

    try {
      await uploadObject(supabase, storagePath, buffer, part.mimetype || MIME_BY_EXT[ext] || "application/octet-stream");
    } catch (err) {
      fastify.log.error({ err: err.message }, "documents: storage upload failed");
      return reply.code(502).send({ error: "Couldn't store the file. Please try again." });
    }

    const row = {
      id: documentId,
      file_name: fileName,
      display_name: displayName,
      document_type: documentType,
      description,
      rendition_path: null,
      namespace,
      status: "queued",
      stage_progress: 0,
      stage_detail: "Waiting to be read",
      error: null,
      sha256,
      byte_size: size,
      // browsers send a real type; curl and some clients send octet-stream, so trust the extension then
      mime_type:
        part.mimetype && part.mimetype !== "application/octet-stream"
          ? part.mimetype
          : MIME_BY_EXT[ext] || part.mimetype || null,
      storage_path: storagePath,
      parser: "docling",
      uploaded_by: identity.userId,
      attempts: 0,
    };

    const { error: upsertErr } = await supabase.from("documents").upsert(row, { onConflict: "id" });
    if (upsertErr) {
      fastify.log.error({ err: upsertErr.message }, "documents: row upsert failed");
      await deletePrefix(supabase, documentPrefix(namespace, documentId)).catch(() => {});
      return reply.code(500).send({ error: "Couldn't record the upload. Please try again." });
    }

    supabase.from("ingest_events").insert([{ document_id: documentId, stage: "queued", message: `Uploaded by ${identity.userId} (${Math.round(size / 1024)} KB)` }]).then(() => {});
    fastify.ingestWorker?.nudge();

    return reply.code(202).send({
      document_id: documentId,
      file_name: fileName,
      status: "queued",
      duplicate: false,
      replaced_legacy: Boolean(legacy),
      byte_size: size,
    });
  });

  // ==========================================================
  // GET /api/documents/:document_id/status
  // ==========================================================
  fastify.get("/api/documents/:document_id/status", async (request, reply) => {
    const identity = identityFrom(request);
    const { document_id } = request.params;

    const { data: doc, error } = await fastify.supabase
      .from("documents")
      .select(LIST_FIELDS)
      .eq("id", document_id)
      .eq("namespace", identity.namespace)
      .maybeSingle();

    if (error) return reply.code(500).send({ error: "Failed to read status" });
    if (!doc) return reply.code(404).send({ error: "Document not found" });

    const { data: events } = await fastify.supabase
      .from("ingest_events")
      .select("stage, message, created_at")
      .eq("document_id", document_id)
      .order("created_at", { ascending: false })
      .limit(3);

    return reply.send({ ...publicDoc(doc), events: events || [] });
  });

  // ==========================================================
  // POST /api/documents/:document_id/retry
  // ==========================================================
  fastify.post("/api/documents/:document_id/retry", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "upload")) return reply.code(403).send({ error: "Forbidden" });
    const { document_id } = request.params;

    const { data: doc } = await fastify.supabase
      .from("documents")
      .select("id, status, attempts, storage_path")
      .eq("id", document_id)
      .eq("namespace", identity.namespace)
      .maybeSingle();

    if (!doc) return reply.code(404).send({ error: "Document not found" });
    // failed → try again; ready → re-read with the current parser. Anything in flight is left alone.
    if (!["failed", "ready"].includes(doc.status)) {
      return reply.code(409).send({ error: `Document is ${doc.status}; wait for it to finish before re-reading it.` });
    }
    if (!doc.storage_path) return reply.code(409).send({ error: "No original file is stored, so it can't be re-read. Upload it again." });

    await fastify.supabase
      .from("documents")
      .update({ status: "queued", error: null, stage_progress: 0, stage_detail: "Waiting to be read", attempts: 0 })
      .eq("id", document_id);

    fastify.supabase.from("ingest_events").insert([{ document_id, stage: "queued", message: `Retry requested by ${identity.userId}` }]).then(() => {});
    fastify.ingestWorker?.nudge();
    return reply.send({ document_id, status: "queued" });
  });

  // ==========================================================
  // PATCH /api/documents/:document_id  (display_name, document_type, description)
  // ==========================================================
  fastify.patch("/api/documents/:document_id", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "upload")) return reply.code(403).send({ error: "Forbidden" });
    const { document_id } = request.params;
    const body = request.body || {};
    const patch = {};

    if (body.display_name !== undefined) patch.display_name = String(body.display_name || "").trim().slice(0, 160) || null;
    if (body.description !== undefined) patch.description = String(body.description || "").trim().slice(0, 1000) || null;
    if (body.document_type !== undefined) {
      const name = String(body.document_type || "").trim().slice(0, 60);
      if (name) {
        const { data: t } = await fastify.supabase
          .from("document_types").select("name").eq("namespace", identity.namespace).eq("name", name).maybeSingle();
        if (!t) return reply.code(400).send({ error: `"${name}" isn't a document type in this workspace.` });
      }
      patch.document_type = name || null;
    }
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "Nothing to update." });

    const { data, error } = await fastify.supabase
      .from("documents")
      .update(patch)
      .eq("id", document_id)
      .eq("namespace", identity.namespace)
      .select(LIST_FIELDS)
      .maybeSingle();
    if (error) return reply.code(500).send({ error: "Couldn't update the document." });
    if (!data) return reply.code(404).send({ error: "Document not found" });

    // The chunks carry the title for the keyword index (document_chunks.tsv); keep it in step.
    if (patch.display_name !== undefined) {
      const { error: titleErr } = await fastify.supabase
        .from("document_chunks")
        .update({ title: searchTitle(data) })
        .eq("document_id", document_id)
        .eq("namespace", identity.namespace);
      if (titleErr) fastify.log.warn({ err: titleErr.message, document_id }, "documents: chunk title update failed");
    }

    return reply.send(publicDoc(data));
  });

  // ==========================================================
  // GET /api/documents/:document_id/file  → short-lived signed URL
  // Serves the PDF rendition for Office files (browser-viewable);
  // ?original=1 returns the uploaded file itself.
  // ==========================================================
  fastify.get("/api/documents/:document_id/file", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "chat")) return reply.code(403).send({ error: "Forbidden" });
    const { document_id } = request.params;
    const wantOriginal = request.query?.original === "1" || request.query?.original === "true";

    const { data: doc } = await fastify.supabase
      .from("documents")
      .select("id, file_name, display_name, storage_path, rendition_path, mime_type")
      .eq("id", document_id)
      .eq("namespace", identity.namespace)
      .maybeSingle();

    if (!doc) return reply.code(404).send({ error: "Document not found" });
    if (!doc.storage_path) return reply.code(404).send({ error: "No original file is stored for this document." });

    const useRendition = !wantOriginal && Boolean(doc.rendition_path);
    const path = useRendition ? doc.rendition_path : doc.storage_path;

    try {
      const url = await signedUrl(fastify.supabase, path, 300);
      return reply.send({
        url,
        file_name: doc.file_name,
        display_name: doc.display_name || null,
        mime_type: useRendition ? "application/pdf" : doc.mime_type,
        rendition: useRendition,
        expires_in: 300,
      });
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  // ==========================================================
  // DELETE /api/documents/:document_id
  // ==========================================================
  fastify.delete("/api/documents/:document_id", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "delete")) {
      return reply.code(403).send({ success: false, error: "Forbidden — insufficient permissions" });
    }
    const { document_id } = request.params;
    if (!document_id) return reply.code(400).send({ success: false, error: "Missing document_id" });

    const supabase = fastify.supabase;

    // storage first (best effort), then the row; chunks go by cascade,
    // with an explicit delete as belt-and-braces for older schemas
    let removedObjects = 0;
    try {
      removedObjects = await deletePrefix(supabase, documentPrefix(identity.namespace, document_id));
    } catch (err) {
      fastify.log.warn({ err: err.message, document_id }, "documents: storage cleanup failed");
    }

    const { error: chunkError } = await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", document_id)
      .eq("namespace", identity.namespace);
    if (chunkError) return reply.code(500).send({ success: false, error: "Failed to delete chunks" });

    const { data: docData, error: docError } = await supabase
      .from("documents")
      .delete()
      .eq("id", document_id)
      .eq("namespace", identity.namespace)
      .select("id, file_name");
    if (docError) return reply.code(500).send({ success: false, error: "Failed to delete document" });

    return reply.send({
      success: true,
      deleted: true,
      deletedDocument: docData?.[0] || null,
      removedObjects,
    });
  });
}
