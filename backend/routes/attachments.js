// ============================================================
//  ATTACHMENT ROUTES
//  parse a chat attachment with the same Docling parser the
//  knowledge base uses, and hand the text straight back.
//
//  Nothing here is stored: no storage object, no documents row,
//  no trace. The bytes live in request memory for the length of
//  the parser call and are gone when the response is sent.
// ============================================================

import { extname } from "node:path";
import { hasPermission, identityFrom, requireNamespaceMember } from "../lib/permissions.js";
import { parseDocument, ParserError } from "../ingest/parserClient.js";

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);

// The knowledge-base allowlist (document.js), kept in step by hand.
const ALLOWED_EXT = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".md", ".txt", ".html", ".htm",
  ".png", ".jpg", ".jpeg", ".tif", ".tiff",
]);

// Plain text goes straight through; the parser adds nothing for it.
const PLAIN_EXT = new Set([".md", ".txt"]);

// The chat route folds every attachment into one context block; this
// is the most one file may contribute (chat.js MAX_EPHEMERAL_CONTEXT,
// same env, same default: about 100k tokens or 250 pages).
export const MAX_ATTACHMENT_CHARS = Number(process.env.MAX_EPHEMERAL_CONTEXT || 400000);

export default async function attachmentRoutes(fastify) {

  fastify.addHook("preHandler", requireNamespaceMember(fastify));

  // ==========================================================
  // POST /api/attachments/parse   (multipart: file)
  // → { file_name, text, page_count, chars, truncated, parser }
  // ==========================================================
  fastify.post("/api/attachments/parse", async (request, reply) => {
    const identity = identityFrom(request);
    if (!hasPermission(identity, "chat")) {
      return reply.code(403).send({ error: "Your role can't attach files." });
    }

    let part = null;
    const pieces = [];
    let size = 0;
    let truncatedUpload = false;

    for await (const p of request.parts()) {
      if (p.type !== "file") continue;
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
        pieces.push(piece);
        size += piece.length;
      }
      truncatedUpload = Boolean(p.file.truncated);
    }

    if (!part) return reply.code(400).send({ error: "No file was attached." });
    if (truncatedUpload) return reply.code(413).send({ error: `That file is larger than the ${MAX_UPLOAD_MB} MB limit.` });
    if (size === 0) return reply.code(400).send({ error: "That file is empty." });

    const fileName = (part.filename || "attachment").trim();
    const ext = extname(fileName).toLowerCase();
    const buffer = Buffer.concat(pieces);

    let text = "";
    let pageCount = null;
    let parser = "text";

    if (PLAIN_EXT.has(ext)) {
      text = buffer.toString("utf8");
    } else {
      const started = Date.now();
      try {
        const parsed = await parseDocument({ buffer, fileName });
        parser = parsed.parser || "docling";
        pageCount = parsed.page_count ?? null;
        text = typeof parsed.markdown === "string" && parsed.markdown.trim()
          ? parsed.markdown
          : (parsed.chunks || []).map((c) => c.text || "").filter(Boolean).join("\n\n");
      } catch (err) {
        if (err instanceof ParserError) {
          // lengths and timings only: server logs carry no attachment text
          fastify.log.warn({ ext, bytes: size, status: err.status, err: err.message }, "attachments: parse failed");
          const status = err.status === 503 || err.status === 504 ? err.status : 422;
          return reply.code(status).send({
            error: err.status === 503
              ? "The document parser is offline, so this file can't be read right now."
              : err.status === 504
                ? "The parser took too long to read that file."
                : `Couldn't read "${fileName}": ${err.message}`,
          });
        }
        fastify.log.error({ err: err?.message }, "attachments: parse crashed");
        return reply.code(500).send({ error: "Couldn't read that file. Please try again." });
      }
      fastify.log.info({ ext, bytes: size, pages: pageCount, chars: text.length, ms: Date.now() - started }, "attachments: parsed");
    }

    text = text.replace(/\r\n?/g, "\n").trim();
    if (!text) return reply.code(422).send({ error: `"${fileName}" has no readable text.` });

    const truncated = text.length > MAX_ATTACHMENT_CHARS;
    if (truncated) text = text.slice(0, MAX_ATTACHMENT_CHARS);

    return reply.send({
      file_name: fileName,
      text,
      page_count: pageCount,
      chars: text.length,
      truncated,
      parser,
    });
  });
}
