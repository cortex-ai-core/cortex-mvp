#!/usr/bin/env node
// =============================================================
//  End-to-end smoke test for Phase 1 through the running backend:
//  real login (EVAL_EMAIL / EVAL_PASSWORD in .env), two chat turns on
//  one thread, the conversation routes, private mode, streaming, and
//  a wrong-namespace request. Cleans up the thread it created.
//
//    node scripts/smoke-chat.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const EMAIL = process.env.EVAL_EMAIL, PASSWORD = process.env.EVAL_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token, headers = {} } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
};

// ---- login
const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("login", login.status === 200 && login.body.token, `role=${login.body.user?.role} ns=${login.body.user?.namespace}`);
const token = login.body.token;
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
check("token carries namespaceId and organizationId", Boolean(claims.namespaceId && claims.organizationId));
const NS = claims.namespaceId;

// ---- turn 1: new thread
const t1 = await json("/api/chat", { method: "POST", token, body: { message: "What does the LEE 3311 document cover?", namespaceId: NS, privateMode: false } });
check("chat turn 1 answers", t1.status === 200 && typeof t1.body.finalAnswer === "string" && t1.body.finalAnswer.length > 20, `mode=${t1.body.mode} citations=${t1.body.citations?.length ?? "?"}`);
const convId = t1.body.conversationId;
check("reply carries a conversationId", typeof convId === "string", convId);

// ---- turn 2: same thread
const t2 = await json("/api/chat", { method: "POST", token, body: { message: "Who is the audience for that program?", namespaceId: NS, conversationId: convId } });
check("chat turn 2 keeps the thread", t2.status === 200 && t2.body.conversationId === convId);

// ---- conversation routes
const list = await json("/api/conversations", { token });
check("GET /api/conversations lists it", list.status === 200 && list.body.conversations?.some((c) => c.conversation_id === convId));
const detail = await json(`/api/conversations/${convId}`, { token });
const roles = (detail.body.messages || []).map((m) => m.role).join(",");
check("thread has user,assistant,user,assistant", roles === "user,assistant,user,assistant", roles);
check("assistant message stores mode and sources", detail.body.messages?.[1]?.mode && Array.isArray(detail.body.messages?.[1]?.sources), `mode=${detail.body.messages?.[1]?.mode}`);
check("title comes from the first message", (detail.body.title || "").startsWith("What does the LEE"), detail.body.title);

// ---- private mode saves nothing
const before = list.body.conversations.length;
const priv = await json("/api/chat", { method: "POST", token, body: { message: "Summarise this attached note about budgets and timelines.", namespaceId: NS, privateMode: true, ephemeralContext: "Budget is 40k. Timeline is six weeks." } });
check("private turn answers without a conversationId", priv.status === 200 && !("conversationId" in priv.body), `mode=${priv.body.mode}`);
const after = await json("/api/conversations", { token });
check("private turn created no thread", after.body.conversations.length === before);

// ---- streaming: first event names the thread
const sres = await fetch(BASE + "/api/chat/stream", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ message: "List the key points again briefly.", namespaceId: NS, conversationId: convId }) });
const text = await sres.text();
const firstEvent = (text.match(/event: (\w+)/) || [])[1];
check("stream's first event is conversation", firstEvent === "conversation", firstEvent);
check("stream ends with done carrying the same id", text.includes("event: done") && text.includes(convId));

// ---- wrong namespace and someone else's id
const wrong = await json("/api/retrieve", { method: "POST", token, body: { query: "budget", namespaceId: "00000000-0000-0000-0000-000000000000" } });
check("retrieve with another namespaceId is 403", wrong.status === 403, String(wrong.status));
const other = await json("/api/conversations/00000000-0000-0000-0000-000000000000", { token });
check("unknown conversation is 404", other.status === 404, String(other.status));

// ---- trace row carries the thread
const del = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
check("DELETE removes the thread", del.status === 200 && del.body.deleted);
const gone = await json(`/api/conversations/${convId}`, { token });
check("deleted thread is 404", gone.status === 404);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
