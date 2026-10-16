// Copy the documents bucket without any source writes or database mutations.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { S3Client, HeadBucketCommand, GetBucketLocationCommand, GetPublicAccessBlockCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createReadOnlySupabase } from "./read-only-supabase.mjs";
import { createDatabaseClient } from "../../backend/lib/services/database.js";

const root = new URL("../../", import.meta.url);
const sourceEnv = dotenv.parse(await readFile(new URL(".env", root)));
const awsEnv = dotenv.parse(await readFile(new URL(".env.aws", root)));
const bucket = "cortex-documents-dev-909762691423";
const owner = "909762691423";
if (awsEnv.BACKEND_PROVIDER !== "aws" || awsEnv.S3_DOCUMENTS_BUCKET !== bucket || awsEnv.AWS_REGION !== "us-east-2" ||
    awsEnv.RDS_REST_URL !== "http://127.0.0.1:3001" || !awsEnv.AWS_PROFILE) throw new Error("Unexpected dev AWS configuration.");
process.env.AWS_PROFILE = awsEnv.AWS_PROFILE;
const unavailableSource = new Set();
const source = createReadOnlySupabase(sourceEnv, async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok && (init.method || "GET") === "GET") {
    const error = await response.clone().json().catch(() => null);
    if (error?.code === "NoSuchKey" && String(error.statusCode) === "404") {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      const prefix = ["/storage/v1/object/authenticated/documents/", "/storage/v1/object/documents/"].find(value => path.startsWith(value));
      if (prefix) unavailableSource.add(decodeURIComponent(path.slice(prefix.length)));
    }
  }
  return response;
});
const sourceStorage = source.storage.from("documents");
const db = createDatabaseClient(awsEnv, (input, init = {}) => {
  if ((init.method || "GET").toUpperCase() !== "GET") throw new Error("Database writes are blocked during the storage copy.");
  return fetch(input, init);
});
const s3 = new S3Client({ region: awsEnv.AWS_REGION });
const target = { Bucket: bucket, ExpectedBucketOwner: owner };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const checked = result => { if (result.error) throw new Error("Document read failed."); return result.data; };
const copy = process.argv.includes("--copy");
const report = { startedAt: new Date().toISOString(), sourceBucket: "documents", targetBucket: bucket,
  sourceWrites: 0, databaseWrites: 0, mode: copy ? "copy" : "inspect", files: [], unavailableSourceFiles: [], failures: [] };
let stage = "verify destination";
async function documents(client) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = checked(await client.from("documents").select("id,namespace_id,storage_path,rendition_path,sha256").order("id").range(offset, offset + 999));
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}
async function inventory() {
  const files = [];
  const pending = [""];
  const visited = new Set();
  while (pending.length) {
    const prefix = pending.shift();
    if (visited.has(prefix)) throw new Error("Repeated source folder.");
    visited.add(prefix);
    for (let offset = 0; ; offset += 100) {
      const page = checked(await sourceStorage.list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } }));
      for (const item of page) {
        if (!item.name || /[\\\u0000]/.test(item.name) || [".", ".."].includes(item.name)) throw new Error("Unexpected source object name.");
        const key = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id === null) pending.push(key);
        else files.push({ key, id: item.id, size: item.metadata?.size ?? null, updatedAt: item.updated_at ?? null });
      }
      if (page.length < 100) break;
    }
  }
  return files.sort((a, b) => a.key.localeCompare(b.key));
}
async function targetBytes(key) {
  try {
    const object = await s3.send(new GetObjectCommand({ ...target, Key: key }));
    return Buffer.from(await object.Body.transformToByteArray());
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
try {
  await s3.send(new HeadBucketCommand(target));
  if ((await s3.send(new GetBucketLocationCommand(target))).LocationConstraint !== "us-east-2") throw new Error("Unexpected bucket region.");
  const access = (await s3.send(new GetPublicAccessBlockCommand(target))).PublicAccessBlockConfiguration;
  if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every(key => access?.[key])) throw new Error("Destination must remain private.");
  stage = "inventory source files and restored records";
  const sourceDocuments = await documents(source);
  const rdsDocuments = await documents(db);
  const before = await inventory();
  const sourceById = new Map(sourceDocuments.map(doc => [doc.id, doc]));
  const originalHashes = new Map();
  for (const doc of rdsDocuments) {
    const original = sourceById.get(doc.id);
    if (!original || !doc.storage_path) continue;
    if (original.namespace_id !== doc.namespace_id || original.storage_path !== doc.storage_path || original.rendition_path !== doc.rendition_path || original.sha256 !== doc.sha256) {
      throw new Error("A source document has changed since the database snapshot. Review before copying its files.");
    }
    if (doc.sha256) originalHashes.set(doc.storage_path, doc.sha256.toLowerCase());
  }
  report.sourceFiles = before.length;
  report.sourceBytes = before.reduce((sum, file) => sum + Number(file.size || 0), 0);
  report.rdsOriginals = rdsDocuments.filter(doc => doc.storage_path).length;
  report.sourceOriginalsNotInRds = sourceDocuments.filter(doc => doc.storage_path && !rdsDocuments.some(row => row.id === doc.id)).length;
  console.log(`Source inventory: ${before.length} files, ${report.sourceBytes} bytes. RDS original references: ${report.rdsOriginals}. Additional source documents with originals: ${report.sourceOriginalsNotInRds}.`);
  if (copy) {
    stage = "copy and verify storage objects";
    for (const file of before) {
      try {
        const download = await sourceStorage.download(file.key, {}, { cache: "no-store" });
        if (download.error && unavailableSource.has(file.key)) {
          report.unavailableSourceFiles.push({ key: file.key, listedBytes: file.size, reason: "Supabase returned NoSuchKey" });
          continue;
        }
        const blob = checked(download);
        const bytes = Buffer.from(await blob.arrayBuffer());
        const digest = hash(bytes);
        if (file.size !== null && bytes.length !== Number(file.size)) throw new Error("Source object size changed.");
        if (originalHashes.has(file.key) && digest !== originalHashes.get(file.key)) throw new Error("Original file differs from the restored document hash.");
        let destination = await targetBytes(file.key);
        let action = "already-identical";
        if (destination === null) {
          try {
            await s3.send(new PutObjectCommand({ ...target, Key: file.key, Body: bytes,
              ContentType: blob.type || "application/octet-stream", ServerSideEncryption: "AES256",
              IfNoneMatch: "*", ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
              Metadata: { "source-sha256": digest, "migration-source": "supabase-documents" },
            }));
            action = "copied";
          } catch (error) {
            if (error.$metadata?.httpStatusCode !== 412) throw error;
          }
          destination = await targetBytes(file.key);
        }
        if (!destination || hash(destination) !== digest) throw new Error("Destination conflict or checksum mismatch; no overwrite was attempted.");
        report.files.push({ key: file.key, bytes: bytes.length, sha256: digest, action, verified: true });
      } catch (error) { report.failures.push({ key: file.key, errorType: error.name }); }
    }
    stage = "verify source inventory and database records are unchanged";
    report.sourceInventoryUnchanged = JSON.stringify(before) === JSON.stringify(await inventory());
    report.sourceDocumentRecordsUnchanged = JSON.stringify(sourceDocuments) === JSON.stringify(await documents(source));
    report.rdsDocumentRecordsUnchanged = JSON.stringify(rdsDocuments) === JSON.stringify(await documents(db));
    if (!report.sourceInventoryUnchanged || !report.sourceDocumentRecordsUnchanged || !report.rdsDocumentRecordsUnchanged) throw new Error("Concurrent changes detected during storage copy.");
    const keys = new Set(report.files.map(file => file.key));
    report.rdsOriginalsVerified = rdsDocuments.filter(doc => doc.storage_path && keys.has(doc.storage_path)).length;
    report.rdsPreviewsVerified = rdsDocuments.filter(doc => doc.rendition_path && keys.has(doc.rendition_path)).length;
    const required = rdsDocuments.filter(doc => sourceById.has(doc.id)).flatMap(doc => [doc.storage_path, doc.rendition_path].filter(Boolean));
    report.missingRdsReferences = required.filter(key => !keys.has(key));
    report.copied = report.files.filter(file => file.action === "copied").length;
    report.alreadyIdentical = report.files.filter(file => file.action === "already-identical").length;
    if (report.failures.length) throw new Error("Some objects were not copied or verified. Existing S3 objects were not overwritten.");
    if (report.missingRdsReferences.length) throw new Error("Some restored document references are unavailable in the source.");
    console.log(`Storage copy passed: ${report.copied} copied, ${report.alreadyIdentical} already identical, ${report.files.length} verified. ${report.rdsOriginalsVerified} RDS originals and ${report.rdsPreviewsVerified} previews are present. No source or database writes were made.`);
    if (report.unavailableSourceFiles.length) console.log(`${report.unavailableSourceFiles.length} older listed source objects returned NoSuchKey and could not be downloaded. All required RDS file references were verified.`);
  }
} catch (error) {
  report.failedStage = stage;
  report.errorType = error.name;
  console.error(`Storage migration failed at: ${stage}. See the ignored local report; credentials were not printed.`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const local = new URL(".local/", import.meta.url);
  await mkdir(local, { recursive: true });
  const name = `storage-${copy ? "copy" : "inventory"}-${Date.now()}.json`;
  await writeFile(new URL(name, local), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Report: scripts/aws/.local/${name}`);
  s3.destroy();
}
