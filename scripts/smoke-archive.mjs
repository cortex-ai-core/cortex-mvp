#!/usr/bin/env node
// =============================================================
//  Retention Phase 2 smoke: an archived thread through the routes.
//
//  Through the running backend (EVAL_EMAIL / EVAL_PASSWORD): two turns
//  on a new thread with a marker, then archiveConversation() with the
//  service key and OpenAI (a dry run first, then the real one). Then:
//    - the thread detail is state "archived" with the archive record
//      and no messages; the list hides it by default and shows it under
//      state=archived
//    - a chat turn sent with the archived id lands on a fresh thread;
//      the archived one gains no message
//    - the marker survives only in the archive (the summary keeps the
//      business content by design)
//    - a second archive call is a no-op; a held thread is refused
//    - DELETE removes the archived thread with receipt.archive = true
//  Cleans up. Needs migration 0013 and a backend with memory on.
//
//    node scripts/smoke-archive.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { archiveConversation } from "../backend/retention/archive.js";
import { PROMPT_VERSION } from "../backend/retention/summarize.js";
import { newUsage, usageSummary } from "../backend/lib/usage.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const EMAIL = process.env.EVAL_EMAIL, PASSWORD = process.env.EVAL_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
};
const marker = `zq${randomBytes(3).toString("hex")}`;
console.log(`marker: ${marker}`);

const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("login", login.status === 200 && login.body.token, `role=${login.body.user?.role}`);
const token = login.body.token;
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const NS = claims.namespaceId, USER = claims.userId;
const startedAt = new Date().toISOString();   // notes extracted from this run's threads are removed at the end

let convId = null, strayId = null, heldId = null;
try {
  // ---- two turns on a new thread
  const t1 = await json("/api/chat", { method: "POST", token, body: { message: `What does the LEE 3311 document cover? We call this project ${marker}.`, namespaceId: NS, privateMode: false } });
  convId = t1.body.conversationId;
  check("turn 1 answers on a new thread", t1.status === 200 && typeof convId === "string", `mode=${t1.body.mode}`);
  const t2 = await json("/api/chat", { method: "POST", token, body: { message: `Decision for ${marker}: we adopt that program's structure for our own review. Who is its audience?`, namespaceId: NS, conversationId: convId } });
  check("turn 2 keeps the thread", t2.status === 200 && t2.body.conversationId === convId);
  await new Promise((r) => setTimeout(r, 1500));

  // ---- dry run writes nothing
  const usage = newUsage();
  const dry = await archiveConversation(db, openai, convId, { dryRun: true, usage, log: null });
  check("dry run returns the record without writing", dry.status === "dry_run" && dry.archive?.topic && dry.summaryText.length > 0 && dry.fallback === false, `topic="${dry.archive?.topic}" $${(usageSummary(usage)?.usd ?? 0).toFixed(4)}`);
  const { count: msgAfterDry } = await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
  const { count: archAfterDry } = await db.from("conversation_archives").select("conversation_id", { count: "exact", head: true }).eq("conversation_id", convId);
  check("dry run left messages and wrote no archive", msgAfterDry === 4 && archAfterDry === 0, `${msgAfterDry} msgs, ${archAfterDry} archives`);

  // ---- the real archive
  const real = await archiveConversation(db, openai, convId, { usage, log: null, actor: "script:smoke-archive" });
  check("archive succeeds", real.status === "archived" && real.messages === 4 && real.fallback === false, `${real.status} removed=${real.messages} traces=${real.tracesScrubbed}`);
  check("summary keeps the marker as business context", JSON.stringify(real.archive).includes(marker), real.archive?.topic);
  check("documents used come from the sources", Array.isArray(real.archive?.documents_used) && real.archive.documents_used.length >= 1, JSON.stringify(real.archive?.documents_used?.[0]));

  // ---- routes
  const detail = await json(`/api/conversations/${convId}`, { token });
  check("detail is state archived with the archive and no messages",
    detail.status === 200 && detail.body.state === "archived" && detail.body.archived_at && detail.body.purged_at && detail.body.archive?.summary_text === real.summaryText && detail.body.messages.length === 0 && detail.body.summary === null,
    `state=${detail.body.state} msgs=${detail.body.messages?.length}`);
  check("archive record carries summary, counts and provenance", detail.body.archive?.message_count === 4 && detail.body.archive?.model === real.model && detail.body.archive?.prompt_version === PROMPT_VERSION && detail.body.archive?.fallback === false, `prompt=${detail.body.archive?.prompt_version}`);
  const active = await json("/api/conversations", { token });
  check("default list hides it", active.status === 200 && !active.body.conversations.some((c) => c.conversation_id === convId));
  const archived = await json("/api/conversations?state=archived", { token });
  check("state=archived lists it", archived.status === 200 && archived.body.conversations.some((c) => c.conversation_id === convId && c.state === "archived"));
  const all = await json("/api/conversations?state=all", { token });
  check("state=all includes it", all.body.conversations.some((c) => c.conversation_id === convId));

  // ---- no new messages on an archived thread
  const t3 = await json("/api/chat", { method: "POST", token, body: { message: "And one more question about that program?", namespaceId: NS, conversationId: convId } });
  strayId = t3.body.conversationId;
  check("a turn sent to the archived thread lands on a fresh one", t3.status === 200 && strayId && strayId !== convId, strayId);
  const { count: msgLater } = await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", convId);
  check("the archived thread gained no message", msgLater === 0);

  // ---- where the marker lives now
  const { count: inMsgs } = await db.from("messages").select("id", { count: "exact", head: true }).ilike("content", `%${marker}%`).eq("conversation_id", convId);
  const { data: traces } = await db.from("rag_queries").select("query, text_purged_at").eq("conversation_id", convId);
  check("marker gone from the thread's messages and trace text", inMsgs === 0 && traces.every((t) => t.query === null && t.text_purged_at), `${traces.length} trace rows`);
  const { data: ev } = await db.from("memory_events").select("event, actor, detail").eq("conversation_id", convId).eq("event", "conversation_archived");
  check("one conversation_archived event with counts", ev?.length === 1 && ev[0].actor === "script:smoke-archive" && ev[0].detail?.messages === 4 && ev[0].detail?.fallback === false);

  // ---- second call and a held thread
  const again = await archiveConversation(db, openai, convId, { log: null });
  check("second archive call is already_archived", again.status === "already_archived");
  const { data: held } = await db.from("conversations").insert([{ organization_id: (await db.from("conversations").select("organization_id").eq("id", strayId).single()).data.organization_id, namespace_id: NS, user_id: (await db.from("conversations").select("user_id").eq("id", strayId).single()).data.user_id, title: `${marker} held`, legal_hold: true, legal_hold_reason: "smoke" }]).select("id").single();
  heldId = held?.id || null;
  await db.from("messages").insert([{ conversation_id: heldId, organization_id: (await db.from("conversations").select("organization_id").eq("id", heldId).single()).data.organization_id, namespace_id: NS, user_id: (await db.from("conversations").select("user_id").eq("id", heldId).single()).data.user_id, seq: 1, role: "user", content: "held" }]);
  const heldRes = await archiveConversation(db, openai, heldId, { log: null });
  check("a held thread is refused", heldRes.status === "held" && heldRes.hold?.scope === "conversation");

  // ---- one-turn thread: metadata only, no model call
  const short = await archiveConversation(db, openai, strayId, { dryRun: true, log: null });
  check("a one-turn thread gets the metadata-only record without a model call", short.status === "dry_run" && short.fallback === true && /too short/.test(short.reason) && short.model === null, short.reason);


  // ---- "Archive now" through the route (R-9): the owner archives a thread early
  const t4 = await json("/api/chat", { method: "POST", token, body: { message: `Note for ${marker}: what is in the Operations Playbook?`, namespaceId: NS, privateMode: false } });
  const earlyId = t4.body.conversationId;
  check("a thread exists to archive early", t4.status === 200 && typeof earlyId === "string");
  const early = await json(`/api/conversations/${earlyId}/archive`, { method: "POST", token, body: { archived: true } });
  check("POST /archive archives it and returns the record (one turn: metadata only)", early.status === 200 && early.body.archived === true && early.body.archive?.fallback === true && early.body.archive?.message_count === 2, JSON.stringify(early.body).slice(0, 120));
  const earlyAgain = await json(`/api/conversations/${earlyId}/archive`, { method: "POST", token, body: { archived: true } });
  check("archiving it again is 409", earlyAgain.status === 409);
  const reopen = await json(`/api/conversations/${earlyId}/archive`, { method: "POST", token, body: { archived: false } });
  check("reopening is refused (410)", reopen.status === 410);
  const list2 = await json("/api/conversations?state=all", { token });
  check("the list carries the retention policy for the web app", list2.status === 200 && list2.body.retention && typeof list2.body.retention.days === "number" && typeof list2.body.retention.hold === "boolean", JSON.stringify(list2.body.retention));
  const delEarly = await json(`/api/conversations/${earlyId}`, { method: "DELETE", token });
  check("the early-archived thread deletes with its archive", delEarly.status === 200 && delEarly.body.receipt?.archive === true);

  // ---- delete the archived thread
  const del = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  check("DELETE removes the archived thread, receipt says archive", del.status === 200 && del.body.receipt?.archive === true && del.body.receipt?.messages === 0, JSON.stringify(del.body.receipt));
  const { count: archLeft } = await db.from("conversation_archives").select("conversation_id", { count: "exact", head: true }).eq("conversation_id", convId);
  check("archive row gone", archLeft === 0);
  convId = null;
} finally {
  if (convId) await db.from("conversations").delete().eq("id", convId);
  if (strayId) await json(`/api/conversations/${strayId}`, { method: "DELETE", token });
  if (heldId) { await db.from("conversations").update({ legal_hold: false }).eq("id", heldId); await db.from("conversations").delete().eq("id", heldId); }
  await db.from("memories").delete().ilike("content", `%${marker}%`);
  // notes Cortéx extracted from this run's threads (the marker is not always in them)
  await db.from("memories").delete().eq("namespace_id", NS).eq("user_id", USER).gte("created_at", startedAt);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
