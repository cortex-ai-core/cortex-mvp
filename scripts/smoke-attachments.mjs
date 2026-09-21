#!/usr/bin/env node
// =============================================================
//  Smoke test for chat attachments and private mode through the
//  running backend: parse a text file and a PDF with
//  /api/attachments/parse, refuse an unsupported type, answer a
//  private turn from the parsed PDF, and confirm the turn left no
//  thread and no question text in the trace.
//
//    node scripts/smoke-attachments.mjs [--base http://localhost:8080] [--pdf path]
// =============================================================

import "../backend/lib/env.js";
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { createClient } from "@supabase/supabase-js";

const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);
const BASE = arg("--base", "http://localhost:8080");
const PDF = arg("--pdf", "C:/Cortex/exampleData/2025_LEE_3311_Technical-Teacher-Education_1765784712.pdf");
const EMAIL = process.env.EVAL_EMAIL, PASSWORD = process.env.EVAL_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const parse = async (token, name, bytes, type) => {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  const started = Date.now();
  const res = await fetch(BASE + "/api/attachments/parse", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, body: await res.json().catch(() => ({})), ms: Date.now() - started };
};

// ---- login
const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("login", login.status === 200 && login.body.token, `role=${login.body.user?.role}`);
const token = login.body.token;
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const NS = claims.namespaceId;

// ---- no token
const anon = await fetch(BASE + "/api/attachments/parse", { method: "POST", body: new FormData() });
check("parse without a token is 401", anon.status === 401, String(anon.status));

// ---- plain text passes straight through
const note = "Budget is 40k. Timeline is six weeks. The vendor is Northwind.";
const txt = await parse(token, "note.txt", Buffer.from(note), "text/plain");
check("text file parses", txt.status === 200 && txt.body.text === note, `parser=${txt.body.parser}`);

// ---- unsupported type
const bad = await parse(token, "data.csv", Buffer.from("a,b\n1,2"), "text/csv");
check("unsupported type is 415", bad.status === 415, String(bad.status));

// ---- empty file
const empty = await parse(token, "empty.txt", Buffer.alloc(0), "text/plain");
check("empty file is 400", empty.status === 400, String(empty.status));

// ---- a PDF through the Docling parser
let pdfText = "";
if (!existsSync(PDF)) {
  console.log(`SKIP  PDF parse (no file at ${PDF})`);
} else {
  const pdf = await parse(token, basename(PDF), readFileSync(PDF), "application/pdf");
  pdfText = pdf.body.text || "";
  check("PDF parses through Docling", pdf.status === 200 && pdf.body.parser === "docling" && pdfText.length > 500,
    `status=${pdf.status} pages=${pdf.body.page_count} chars=${pdf.body.chars} truncated=${pdf.body.truncated} ${pdf.ms}ms`);
}

// ---- private turn answers from the attachment and leaves nothing behind
const list = await json("/api/conversations", { token });
const before = list.body.conversations.length;
const question = "What is the vendor's name and the timeline?";
const priv = await json("/api/chat", { method: "POST", token, body: { message: question, namespaceId: NS, privateMode: true, ephemeralContext: note } });
const answer = priv.body.finalAnswer || priv.body.message || "";
check("private turn answers from the attachment", priv.status === 200 && /northwind/i.test(answer) && /six weeks/i.test(answer), answer.slice(0, 120));
check("private turn carries no conversationId", !("conversationId" in priv.body));
check("private mode is the answer mode", priv.body.mode === "private", priv.body.mode);
const after = await json("/api/conversations", { token });
check("private turn created no thread", after.body.conversations.length === before);

if (pdfText) {
  const q2 = "In two sentences, what is this document about?";
  const priv2 = await json("/api/chat", { method: "POST", token, body: { message: q2, namespaceId: NS, privateMode: true, ephemeralContext: pdfText } });
  const a2 = priv2.body.finalAnswer || priv2.body.message || "";
  check("private turn answers from the parsed PDF", priv2.status === 200 && a2.length > 40 && !/don.t cover/i.test(a2), a2.slice(0, 140));
}

// ---- the trace rows for those turns carry no question text
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  await new Promise((r) => setTimeout(r, 1500)); // the trace write is fire-and-forget
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: rows, error } = await db.from("rag_queries")
    .select("id, query, conflicts, answer_mode, created_at")
    .eq("user_id", claims.userId).eq("answer_mode", "private").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(5);
  check("private trace rows exist for the turns", !error && rows && rows.length >= 1, error?.message || `rows=${rows?.length}`);
  check("private trace rows carry no question text", !error && (rows || []).every((r) => r.query === null && r.conflicts === null),
    (rows || []).map((r) => r.query === null ? "null" : "TEXT").join(","));
  const leaked = (rows || []).filter((r) => typeof r.query === "string" && r.query.includes(question));
  check("the private question is not in any recent trace row", leaked.length === 0);
} else {
  console.log("SKIP  trace check (no SUPABASE_URL / SUPABASE_SERVICE_KEY)");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
