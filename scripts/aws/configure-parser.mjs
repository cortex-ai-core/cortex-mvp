// Write only the parser's shared secret into its ignored Docker env file.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";

const appFile = new URL("../../.env.aws", import.meta.url);
const local = new URL("./.local/", import.meta.url);
let text = await readFile(appFile, "utf8");
const env = dotenv.parse(text);
if (env.BACKEND_PROVIDER !== "aws") throw new Error("Expected AWS configuration.");
if (env.PARSER_URL !== "http://localhost:8090" && env.PARSER_URL !== "http://127.0.0.1:8090") {
  throw new Error("The local parser launcher requires PARSER_URL on localhost:8090.");
}
const secret = env.PARSER_SECRET || randomBytes(32).toString("hex");
if (/[\r\n]/.test(secret)) throw new Error("The parser secret must be a single line.");
if (!env.PARSER_SECRET) {
  if (/^PARSER_SECRET=/m.test(text)) text = text.replace(/^PARSER_SECRET=[^\r\n]*/m, `PARSER_SECRET="${secret}"`);
  else text += `\nPARSER_SECRET="${secret}"\n`;
  await writeFile(appFile, text, { mode: 0o600 });
}
await mkdir(local, { recursive: true });
await writeFile(new URL("parser.env", local), `PARSER_SECRET=${secret}\n`, { mode: 0o600 });
console.log("Prepared ignored parser configuration. No secrets were printed.");
