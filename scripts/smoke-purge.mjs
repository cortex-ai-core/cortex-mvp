#!/usr/bin/env node
// =============================================================
//  Retention Phase 1 smoke: the delete button is a complete purge.
//
//  Through the running backend (real login, EVAL_EMAIL / EVAL_PASSWORD
//  in .env): one "remember" turn and one retrieval turn on a new thread,
//  so the thread has messages, a memory that cites it and trace rows
//  with its question text. Then, with the service key beside it:
//    - a legal hold on the thread and a retention hold on the
//      organization each make DELETE answer 409 and change nothing
//    - DELETE returns a receipt naming the kept memory
//    - messages, thread, trace text are gone; the memory is stamped
//      source_purged_at and listed by GET /api/memory?source=purged;
//      one conversation_deleted event carries the receipt
//    - a marker grep across every table that can hold chat text finds
//      nothing but the kept memory
//    - scrubTracesOlderThan() nulls an aged trace row with no thread
//  Cleans up the memory and the planted trace row. Needs migration 0013.
//
//    node scripts/smoke-purge.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { scrubTracesOlderThan } from "../backend/retrieval/trace.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const EMAIL = process.env.EVAL_EMAIL, PASSWORD = process.env.EVAL_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
};
const marker = `zq${randomBytes(3).toString("hex")}`;
console.log(`marker: ${marker}`);

// ---- login
const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("login", login.status === 200 && login.body.token, `role=${login.body.user?.role}`);
const token = login.body.token;
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const NS = claims.namespaceId, ORG = claims.organizationId, USER = claims.userId;
const startedAt = new Date().toISOString();   // notes extracted from this run's threads are removed at the end

let convId = null, memoryId = null, plantedTraceId = null;
const restore = async () => {
  await db.from("organization").update({ retention_hold: false, retention_hold_reason: null }).eq("id", ORG);
  if (convId) await db.from("conversations").update({ legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null }).eq("id", convId);
  if (plantedTraceId) await db.from("rag_queries").delete().eq("id", plantedTraceId);
};

try {
  // ---- turn 1: an explicit "remember", so a memory cites the thread
  const t1 = await json("/api/chat", { method: "POST", token, body: { message: `Remember that the ${marker} vendor invoice is due on the 14th.`, namespaceId: NS, privateMode: false } });
  convId = t1.body.conversationId;
  check("remember turn answers on a new thread", t1.status === 200 && typeof convId === "string", `mode=${t1.body.mode}`);
  const { data: mem } = await db.from("memories").select("id, content, source_conversation_id, status").ilike("content", `%${marker}%`).eq("status", "active").maybeSingle();
  memoryId = mem?.id || null;
  check("a memory citing the thread was saved", Boolean(memoryId) && mem.source_conversation_id === convId, mem?.content);

  // ---- turn 2: retrieval, so a trace row carries the thread and the question text
  const t2 = await json("/api/chat", { method: "POST", token, body: { message: `What does the LEE 3311 document cover? (${marker})`, namespaceId: NS, conversationId: convId } });
  check("retrieval turn keeps the thread", t2.status === 200 && t2.body.conversationId === convId, `mode=${t2.body.mode}`);
  await new Promise((r) => setTimeout(r, 1500));   // trace and after-reply hooks land asynchronously

  const { count: msgBefore } = await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
  check("thread has four messages", msgBefore === 4, String(msgBefore));
  const { data: tracesBefore } = await db.from("rag_queries").select("id, query, text_purged_at").eq("conversation_id", convId);
  check("trace rows carry the thread and its question text", tracesBefore?.length >= 2 && tracesBefore.every((t) => t.query && !t.text_purged_at), `${tracesBefore?.length} rows`);

  // ---- legal hold on the thread: 409, nothing changes
  await db.from("conversations").update({ legal_hold: true, legal_hold_reason: "smoke hold", legal_hold_by: USER, legal_hold_at: new Date().toISOString() }).eq("id", convId);
  const heldDel = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  check("DELETE on a held thread is 409 naming the thread hold", heldDel.status === 409 && heldDel.body.hold?.scope === "conversation" && heldDel.body.hold?.reason === "smoke hold", `${heldDel.status} ${heldDel.body.error}`);
  await db.from("conversations").update({ legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null }).eq("id", convId);

  // ---- retention hold on the organization: 409, nothing changes
  await db.from("organization").update({ retention_hold: true, retention_hold_reason: "smoke audit" }).eq("id", ORG);
  const orgDel = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  check("DELETE under an organization hold is 409 naming the organization", orgDel.status === 409 && orgDel.body.hold?.scope === "organization", `${orgDel.status} ${orgDel.body.error}`);
  await db.from("organization").update({ retention_hold: false, retention_hold_reason: null }).eq("id", ORG);
  const { count: msgStill } = await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
  const { data: memStill } = await db.from("memories").select("source_purged_at").eq("id", memoryId).maybeSingle();
  check("held deletes changed nothing", msgStill === 4 && memStill?.source_purged_at === null);

  // ---- the purge
  const del = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  const r = del.body.receipt || {};
  check("DELETE succeeds with a receipt", del.status === 200 && del.body.deleted === true && r.schema_ready === true, JSON.stringify(r));
  check("receipt counts the four messages", r.messages === 4, String(r.messages));
  check("receipt counts the scrubbed traces", r.traces_scrubbed >= 2, String(r.traces_scrubbed));
  check("receipt names the kept memory", Array.isArray(r.memories_kept) && r.memories_kept.includes(memoryId));

  // ---- what is left
  const gone = await json(`/api/conversations/${convId}`, { token });
  check("thread is 404 afterwards", gone.status === 404);
  const { count: msgAfter } = await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
  check("messages are gone", msgAfter === 0, String(msgAfter));
  const { data: tracesAfter } = await db.from("rag_queries").select("id, query, conflicts, text_purged_at, latency_ms, mode").eq("conversation_id", convId);
  check("trace rows stay for metrics with their text nulled and stamped",
    tracesAfter?.length === tracesBefore.length && tracesAfter.every((t) => t.query === null && t.conflicts === null && t.text_purged_at && t.mode),
    `${tracesAfter?.length} rows`);
  const { data: memAfter } = await db.from("memories").select("status, content, source_conversation_id, source_purged_at").eq("id", memoryId).maybeSingle();
  check("memory kept, active, stamped source_purged_at, link nulled",
    memAfter?.status === "active" && memAfter.content.includes(marker) && memAfter.source_conversation_id === null && Boolean(memAfter.source_purged_at));
  const { data: ev } = await db.from("memory_events").select("event, actor, detail, conversation_id").eq("conversation_id", convId).eq("event", "conversation_deleted");
  check("one conversation_deleted event carries the receipt", ev?.length === 1 && ev[0].actor === USER && ev[0].detail?.messages === 4 && (ev[0].detail?.memories_kept || []).includes(memoryId));

  // ---- the memory routes show the mark
  const purgedList = await json("/api/memory?source=purged&limit=200", { token });
  check("GET /api/memory?source=purged lists it", purgedList.status === 200 && purgedList.body.memories?.some((m) => m.memory_id === memoryId && m.source_purged_at));
  const linkedList = await json("/api/memory?source=linked&limit=200", { token });
  check("GET /api/memory?source=linked leaves it out", linkedList.status === 200 && !linkedList.body.memories?.some((m) => m.memory_id === memoryId));
  const one = await json(`/api/memory/${memoryId}`, { token });
  check("GET /api/memory/:id shows source_purged_at", one.status === 200 && Boolean(one.body.source_purged_at));

  // ---- marker grep: nothing but the kept memory holds the text
  const holds = [];
  for (const [table, col] of [["messages", "content"], ["conversation_summaries", "summary"], ["rag_queries", "query"], ["conversation_archives", "summary_text"], ["conversations", "title"]]) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).ilike(col, `%${marker}%`);
    if (error) holds.push(`${table}:${error.message}`); else if (count) holds.push(`${table}.${col}=${count}`);
  }
  const { count: memHits } = await db.from("memories").select("id", { count: "exact", head: true }).ilike("content", `%${marker}%`);
  check("marker survives only in the kept memory", holds.length === 0 && memHits === 1, holds.join(", ") || `memories=${memHits}`);

  // ---- aged trace rows with no thread (the sweep's other job)
  const { data: planted } = await db.from("rag_queries").insert([{ query: `aged ${marker}`, namespace_id: NS, mode: "hybrid", created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }]).select("id").single();
  plantedTraceId = planted?.id || null;
  const scrubbed = await scrubTracesOlderThan(db, console, { namespaceId: NS, days: 30 });
  const { data: plantedAfter } = await db.from("rag_queries").select("query, text_purged_at").eq("id", plantedTraceId).maybeSingle();
  check("scrubTracesOlderThan nulls an aged thread-less trace", scrubbed >= 1 && plantedAfter?.query === null && Boolean(plantedAfter?.text_purged_at), `scrubbed=${scrubbed}`);
  check("a second aged scrub finds nothing new", (await scrubTracesOlderThan(db, console, { namespaceId: NS, days: 30 })) === 0);

  // ---- cleanup through the API
  const memDel = await json(`/api/memory/${memoryId}`, { method: "DELETE", token });
  check("memory deleted through the API", memDel.status === 200);
  const { count: memLeft } = await db.from("memories").select("id", { count: "exact", head: true }).ilike("content", `%${marker}%`);
  check("marker text gone everywhere", memLeft === 0);
} finally {
  await restore();
  // notes Cortéx extracted from this run's threads (the marker is not always in them)
  await db.from("memories").delete().eq("namespace_id", NS).eq("user_id", USER).gte("created_at", startedAt);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
