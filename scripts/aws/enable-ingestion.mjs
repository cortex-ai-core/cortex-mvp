// Enable the existing worker only after its AWS storage, parser and RDS are reachable.
import { readFile, writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { createDatabaseClient } from "../../backend/lib/services/database.js";

const file = new URL("../../.env.aws", import.meta.url);
const text = await readFile(file, "utf8");
const env = dotenv.parse(text);
if (env.BACKEND_PROVIDER !== "aws" || env.S3_DOCUMENTS_BUCKET !== "cortex-documents-dev-909762691423" ||
    env.RDS_REST_URL !== "http://127.0.0.1:3001" || !env.AWS_PROFILE || !env.OPENAI_API_KEY) {
  throw new Error("Complete the Cortex dev AWS configuration first.");
}
const parserUrl = new URL(env.PARSER_URL);
if (!["localhost", "127.0.0.1"].includes(parserUrl.hostname) || parserUrl.port !== "8090" || !env.PARSER_SECRET) {
  throw new Error("Configure the local parser and its shared secret first.");
}
process.env.AWS_PROFILE = env.AWS_PROFILE;
const s3 = new S3Client({ region: env.AWS_REGION });
try {
  await s3.send(new HeadBucketCommand({ Bucket: env.S3_DOCUMENTS_BUCKET, ExpectedBucketOwner: "909762691423" }));
} catch {
  throw new Error("S3 access failed. Renew the cortex-dev SSO session and run configure-s3.mjs.");
} finally { s3.destroy(); }
const healthResponse = await fetch(new URL("/health", parserUrl), { signal: AbortSignal.timeout(10000) });
const health = await healthResponse.json();
if (!healthResponse.ok || health.status !== "ok" || health.parser !== "docling") {
  throw new Error("The Docling parser is not ready.");
}
const db = createDatabaseClient(env);
const pending = await db.from("documents").select("id", { count: "exact", head: true })
  .in("status", ["queued", "parsing", "structuring", "learning"]).is("storage_path", null);
if (pending.error) throw new Error("RDS document access failed. Check the PostgREST terminal.");
if (pending.count) throw new Error("Unfinished copied documents have no original files. Resolve them before starting the worker.");
if (!/^INGEST_WORKER=/m.test(text)) throw new Error("Expected the existing INGEST_WORKER setting.");
await writeFile(file, text.replace(/^INGEST_WORKER=[^\r\n]*/m, 'INGEST_WORKER="on"'), { mode: 0o600 });
console.log(`AWS ingestion enabled in ignored .env.aws. Parser ${health.version}, S3 and RDS are reachable. Start or restart npm run start:aws to apply it.`);
