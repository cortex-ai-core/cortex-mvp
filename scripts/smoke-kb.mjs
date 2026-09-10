#!/usr/bin/env node
// =============================================================
//  Knowledge-base mode through the running backend: logs in with the
//  eval user, asks for a brief from the whole knowledge base, and
//  checks that the answer drew on every ready document rather than a
//  handful of chunks. Also checks a topic question still takes the
//  retrieval path. Cleans up the thread it made.
//
//    node scripts/smoke-kb.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const EMAIL = process.env.EVAL_EMAIL, PASSWORD = process.env.EVAL_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("login", login.status === 200 && login.body.token);
const token = login.body.token;
const NS = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).namespaceId;

const docs = await json("/api/documents", { token });
const ready = (docs.body.documents || []).filter((d) => d.status === "ready").length;
check("document list", docs.status === 200 && ready > 0, `${ready} ready documents`);

const t0 = Date.now();
const kb = await json("/api/chat", { method: "POST", token, body: { message: "Draft a one-page executive brief from the current knowledge base", namespaceId: NS } });
const ms = Date.now() - t0;
check("brief answers", kb.status === 200 && (kb.body.finalAnswer || "").length > 200, `${ms} ms`);
check("intent is draft / knowledge_base from the model", kb.body.intent?.type === "draft" && kb.body.intent?.scope === "knowledge_base" && kb.body.intent?.source === "model", JSON.stringify(kb.body.intent));
check("mode is knowledge_base", kb.body.mode === "knowledge_base", kb.body.mode);
const srcDocs = new Set((kb.body.sources || []).map((s) => s.document_id));
check("one source per ready document", srcDocs.size === ready, `${srcDocs.size} of ${ready}`);
const citedDocs = new Set((kb.body.citations || []).map((c) => c.document_id));
check("brief cites several documents", citedDocs.size >= Math.min(4, ready), `${citedDocs.size} cited`);
console.log("\n--- brief (first 600 chars) ---\n" + (kb.body.finalAnswer || "").slice(0, 600) + "\n---");

const topic = await json("/api/chat", { method: "POST", token, body: { message: "How many credits does the teacher education program require?", namespaceId: NS, conversationId: kb.body.conversationId } });
check("topic question stays on retrieval", topic.status === 200 && topic.body.mode === "retrieval", `mode=${topic.body.mode} intent=${topic.body.intent?.type}/${topic.body.intent?.scope}`);

if (kb.body.conversationId) await json(`/api/conversations/${kb.body.conversationId}`, { method: "DELETE", token });
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
