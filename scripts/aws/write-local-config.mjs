import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPath = resolve(root, ".env.aws");
const restPath = resolve(root, "scripts/aws/.local/postgrest.env");
const caPath = resolve(root, "scripts/migration/.local/us-east-2-bundle.pem");
try {
  let input = "";
  for await (const part of process.stdin) input += part;
  const settings = JSON.parse(input.replace(/^\uFEFF/, ""));
  if (!settings.databasePassword || !settings.clientSecret) throw new Error("Both local passwords are required.");
  await access(caPath);
  let previous = {};
  try { previous = dotenv.parse(await readFile(resolve(root, ".env"))); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const restSecret = randomBytes(48).toString("hex");
  const appSecret = randomBytes(48).toString("hex");
  const app = {
    BACKEND_PROVIDER: "aws", PORT: "8081", AWS_REGION: "us-east-2",
    RDS_REST_URL: "http://127.0.0.1:3001", RDS_REST_JWT_SECRET: restSecret, AWS_CORTEX_JWT_SECRET: appSecret,
    COGNITO_USER_POOL_ID: "us-east-2_gfKKl0wNa", COGNITO_CLIENT_ID: "ll59facs76vf9e6rk8m9ma4ob",
    COGNITO_CLIENT_SECRET: settings.clientSecret, S3_DOCUMENTS_BUCKET: "",
    OPENAI_API_KEY: previous.OPENAI_API_KEY || "", PARSER_URL: previous.PARSER_URL || "http://localhost:8090",
    PARSER_SECRET: previous.PARSER_SECRET || "", INGEST_WORKER: "off", RETENTION_SWEEP_MINUTES: "0", RETENTION_SWEEP_AT: "",
  };
  // Double-quoted dotenv values support embedded \n, but not arbitrary quotes.
  for (const value of Object.values(app)) if (/["\r\n]/.test(value)) throw new Error("A configuration value contains unsupported characters. Configure it manually.");
  const appText = Object.entries(app).map(([key, value]) => `${key}="${value}"`).join("\n") + "\n";
  const uri = `postgresql://cortex_postgrest:${encodeURIComponent(settings.databasePassword)}@cortex-rds.cvcm2qq6u67z.us-east-2.rds.amazonaws.com:5432/cortex?sslmode=verify-full&sslrootcert=/rds-ca.pem`;
  const restText = [
    `PGRST_DB_URI=${uri}`, "PGRST_DB_SCHEMAS=public", "PGRST_DB_EXTRA_SEARCH_PATH=extensions",
    "PGRST_DB_CONFIG=false", "PGRST_DB_POOL=5", "PGRST_SERVER_PORT=3000",
    `PGRST_JWT_SECRET=${restSecret}`, "PGRST_JWT_AUD=cortex:database", "PGRST_JWT_ROLE_CLAIM_KEY=$.role",
    "PGRST_OPENAPI_MODE=disabled", "PGRST_LOG_LEVEL=error",
  ].join("\n") + "\n";
  await mkdir(dirname(restPath), { recursive: true });
  // Refuse to overwrite either config, including after a partially completed setup.
  try { await access(restPath); throw new Error("PostgREST configuration already exists; no files were overwritten."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(appPath, appText, { flag: "wx", mode: 0o600 });
  await writeFile(restPath, restText, { flag: "wx", mode: 0o600 });
  console.log("Local .env.aws and scripts/aws/.local/postgrest.env created. No credentials were printed.");
  if (!app.OPENAI_API_KEY) console.log("Set OPENAI_API_KEY in .env.aws before starting the full backend.");
} catch (error) {
  // Never log parser errors or configuration values, which may contain secrets.
  console.error("Local configuration failed. Check that the certificate exists, both secrets were supplied, and neither config file already exists.");
  process.exitCode = 1;
}
