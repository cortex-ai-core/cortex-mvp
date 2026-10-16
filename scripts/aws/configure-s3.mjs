// Configure the new dev bucket only. Credentials come from the local AWS profile.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import {
  S3Client, HeadBucketCommand, GetBucketLocationCommand,
  GetPublicAccessBlockCommand, GetBucketOwnershipControlsCommand,
  GetBucketEncryptionCommand, GetBucketCorsCommand, PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { createS3Storage } from "../../backend/lib/services/storage.js";

const root = new URL("../../", import.meta.url);
const env = dotenv.parse(await readFile(new URL(".env.aws", root)));
const bucket = "cortex-documents-dev-909762691423";
const owner = "909762691423";
if (env.BACKEND_PROVIDER !== "aws" || env.S3_DOCUMENTS_BUCKET !== bucket || env.AWS_REGION !== "us-east-2") {
  throw new Error("Expected the Cortex dev AWS bucket configuration.");
}
if (!env.AWS_PROFILE) throw new Error("Set the local AWS profile first.");
process.env.AWS_PROFILE = env.AWS_PROFILE;
const client = new S3Client({ region: env.AWS_REGION });
const target = { Bucket: bucket, ExpectedBucketOwner: owner };
let stage = "verify bucket access";
let probe;
let passed = false;
try {
  await client.send(new HeadBucketCommand(target));
  const location = await client.send(new GetBucketLocationCommand(target));
  if (location.LocationConstraint !== env.AWS_REGION) throw new Error("Unexpected bucket region.");
  stage = "verify private bucket settings";
  const access = (await client.send(new GetPublicAccessBlockCommand(target))).PublicAccessBlockConfiguration;
  if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every(key => access?.[key] === true)) {
    throw new Error("Enable all four public-access blocks.");
  }
  const ownership = await client.send(new GetBucketOwnershipControlsCommand(target));
  if (!ownership.OwnershipControls?.Rules?.some(rule => rule.ObjectOwnership === "BucketOwnerEnforced")) {
    throw new Error("Disable bucket ACLs.");
  }
  const encryption = await client.send(new GetBucketEncryptionCommand(target));
  if (!encryption.ServerSideEncryptionConfiguration?.Rules?.some(rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "AES256")) {
    throw new Error("Expected SSE-S3 encryption.");
  }
  stage = "configure browser previews";
  const desired = JSON.parse(await readFile(new URL("s3-documents-cors.json", import.meta.url), "utf8"));
  let existing = [];
  try { existing = (await client.send(new GetBucketCorsCommand(target))).CORSRules || []; }
  catch (error) { if (error.name !== "NoSuchCORSConfiguration") throw error; }
  const rules = [...existing];
  const equivalent = (a, b) => a.MaxAgeSeconds === b.MaxAgeSeconds &&
    ["AllowedOrigins", "AllowedMethods", "AllowedHeaders", "ExposeHeaders"].every(key =>
      JSON.stringify([...(a[key] || [])].sort()) === JSON.stringify([...(b[key] || [])].sort()));
  for (const rule of desired) {
    if (!rules.some(current => equivalent(current, rule))) rules.push(rule);
  }
  if (rules.length !== existing.length) {
    await client.send(new PutBucketCorsCommand({ ...target, CORSConfiguration: { CORSRules: rules } }));
  }
  stage = "test backend storage upload, download, listing, preview and deletion";
  const storage = createS3Storage(env, client).from("documents");
  const prefix = `.cortex-connectivity/${randomUUID()}`;
  probe = `${prefix}/probe.txt`;
  const body = "Cortex AWS storage connection check.\n";
  const check = result => { if (result.error) throw new Error("Storage check failed."); return result.data; };
  check(await storage.upload(probe, body, { contentType: "text/plain" }));
  const downloaded = check(await storage.download(probe));
  if (await downloaded.text() !== body) throw new Error("Storage contents did not match.");
  if (!check(await storage.list(prefix)).some(entry => entry.name === "probe.txt")) throw new Error("Storage listing did not match.");
  const signed = check(await storage.createSignedUrl(probe, 60));
  const preview = await fetch(signed.signedUrl, { headers: { Origin: "http://localhost:3002" }, signal: AbortSignal.timeout(15000) });
  if (!preview.ok || await preview.text() !== body || preview.headers.get("access-control-allow-origin") !== "http://localhost:3002") {
    throw new Error("Browser preview check failed.");
  }
  check(await storage.remove([probe]));
  probe = null;
  passed = true;
} catch (error) {
  console.error(`S3 setup failed at: ${stage} (${error.name}). Credentials and signed URLs were not printed.`);
  process.exitCode = 1;
} finally {
  if (probe) {
    const result = await createS3Storage(env, client).from("documents").remove([probe]);
    if (result.error) { console.error("Could not remove the connectivity probe; check the .cortex-connectivity prefix."); process.exitCode = 1; }
  }
  client.destroy();
}
if (passed) console.log(`S3 setup passed for ${bucket}: private Ohio bucket, encryption, upload/download/list/delete and browser preview verified. The connectivity probe was removed.`);
