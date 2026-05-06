// =============================================================
//  CORTÉX — INGEST ROUTE (RBAC + NAMESPACE SECURED)
// =============================================================

import fp from "fastify-plugin";
import { requireAuth } from "../lib/authMiddleware.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

// -------------------------------------------------------------
// ENV + CLIENTS
// -------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------------------------------------------------------------
// PERMISSION ENGINE (UNCHANGED)
// -------------------------------------------------------------
const PERMISSION_MAP = {
  super_admin: { namespaces: ["*"], actions: ["chat", "upload", "admin", "delete"] },
  advisor: { namespaces: ["advisory"], actions: ["chat", "upload"] },
  cyber: { namespaces: ["cybersecurity"], actions: ["chat"] },
  datamanagement: { namespaces: ["datamanagement"], actions: ["chat", "upload"] },
  recruiting: { namespaces: ["recruiting"], actions: ["chat", "upload"] },
  ventures: { namespaces: ["ventures"], actions: ["chat", "upload"] }
};

function hasPermission(identity, action) {
  const { role, namespace } = identity;
  const rolePermissions = PERMISSION_MAP[role];
  if (!rolePermissions) return false;

  const namespaceAllowed =
    rolePermissions.namespaces.includes("*") ||
    rolePermissions.namespaces.includes(namespace);

  if (!namespaceAllowed) return false;
  return rolePermissions.actions.includes(action);
}

// -------------------------------------------------------------
// v1.6 — ENTITY EXTRACTION (DETERMINISTIC, NO LLM, SAFE FILTER)
// -------------------------------------------------------------
function extractPrimaryEntity({ fileName, text }) {
  if (!fileName) return null;

  const baseName = fileName.replace(/\.[^/.]+$/, "");

  const cleanedFileName = baseName
    .replace(/\b(resume|cv|profile|candidate|bio)\b/gi, "")
    .replace(/[-_()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const nameRegex = /\b[A-Z][a-z]+(?:\s[A-Z]\.)?\s[A-Z][a-z]+\b/;

  const isLikelyPerson = (str) => {
    if (!str) return false;

    const words = str.split(" ");
    if (words.length < 2 || words.length > 3) return false;

    const banned = [
      "Playbook", "Guide", "Report", "Document", "Policy",
      "Procedure", "Plan", "Workflow", "System", "Strategy"
    ];

    for (const word of words) {
      if (banned.includes(word)) return false;
    }

    return true;
  };

  const fileNameMatch = cleanedFileName.match(nameRegex);
  if (fileNameMatch && isLikelyPerson(fileNameMatch[0])) {
    return fileNameMatch[0].trim();
  }

  if (text) {
    const firstBlock = text.slice(0, 300);

    const textMatch = firstBlock.match(nameRegex);
    if (textMatch && isLikelyPerson(textMatch[0])) {
      return textMatch[0].trim();
    }
  }

  return null;
}

// -------------------------------------------------------------
// CHUNKER
// -------------------------------------------------------------
function chunkText(text, chunkSize = 500, overlap = 50) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }

  return chunks;
}

// -------------------------------------------------------------
// ROUTE
// -------------------------------------------------------------
async function ingestRoute(fastify, opts) {

  fastify.post(
    "/ingest",
    { preHandler: requireAuth() },
    async (req, reply) => {
      try {

        const user = req.user?.user || req.user;
        const namespace = user.namespace;

        const { text, file_name, filename } = req.body;

        const resolvedFileName =
          file_name ||
          filename ||
          "Uploaded Document";

        const identity = {
          userId: user?.userId,
          role: user?.role,
          namespace: user?.namespace
        };

        if (!hasPermission(identity, "upload")) {
          return reply.code(403).send({ error: "Forbidden: No permission to upload" });
        }

        if (!text) {
          return reply.code(400).send({ error: "Missing required field: text." });
        }

        // -----------------------------------------------------
        // STEP 1 — CREATE DOCUMENT RECORD
        // -----------------------------------------------------
        const documentId = uuidv4();

        const { error: docError } = await supabase
          .from("documents")
          .insert([
            {
              id: documentId,
              file_name: resolvedFileName,
              namespace: namespace,
              created_at: new Date().toISOString()
            }
          ]);

        if (docError) {
          console.error("❌ DOCUMENT INSERT ERROR:", docError);
          return reply.code(500).send({ error: "Failed to create document." });
        }

        // -----------------------------------------------------
        // STEP 2 — CHUNK + EMBED
        // -----------------------------------------------------
        const rawChunks = chunkText(text);

        const primaryEntity = extractPrimaryEntity({
          fileName: resolvedFileName,
          text
        });

        const chunkHeader = primaryEntity
          ? `PRIMARY ENTITY: ${primaryEntity}\nSOURCE FILE: ${resolvedFileName}\n\n`
          : `SOURCE FILE: ${resolvedFileName}\n\n`;

        const chunks = rawChunks.map(chunk => `${chunkHeader}${chunk}`);
        const insertedChunks = [];

        let index = 0;

        for (const chunk of chunks) {

          const embeddingRes = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: chunk,
          });

          const embedding = embeddingRes.data[0].embedding;

          const { data, error } = await supabase
            .from("document_chunks")
            .insert([
              {
                document_id: documentId,
                namespace,
                chunk_text: chunk,
                chunk_index: index++,
                embedding
              }
            ])
            .select();

          if (error) {
            console.error("❌ SUPABASE INSERT ERROR:", error);
            return reply.code(500).send({ error: "Failed to store chunk." });
          }

          insertedChunks.push(data[0].id);
        }

        return reply.send({
          success: true,
          document_id: documentId,
          file_name: resolvedFileName,
          primary_entity: primaryEntity,
          namespace,
          chunksStored: insertedChunks.length,
          chunkIds: insertedChunks,
          message: "Ingest completed successfully.",
        });

      } catch (err) {
        console.error("❌ INGEST ERROR:", err);
        return reply.code(500).send({ error: err.message });
      }
    }
  );
}

export default fp(ingestRoute);
