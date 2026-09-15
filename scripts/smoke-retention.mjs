#!/usr/bin/env node
// =============================================================
//  Retention Phase 3 smoke: the sweep and the policy, end to end.
//
//  Through the running backend (EVAL_EMAIL / EVAL_PASSWORD) it creates
//  real threads, then backdates them with the service key so a sweep
//  pass sees them as past the 30-day policy:
//    A  two turns, 40 days old              -> archived with a summary
//    B  one turn, 40 days old, legal hold   -> skipped; delete refused;
//                                             archived (metadata only)
//                                             once the hold is cleared
//    C  empty, 40 days old                  -> deleted
//    D  one turn, today                     -> untouched
//    E  one turn, 40 days old, namespace override retention_days = 0
//                                           -> untouched (keep forever)
//  A dry run first, which must write nothing. Checks the per-namespace
//  report, the retention_sweep event, and the trace scrub. Restores the
//  namespace settings row and deletes what it created.
//
//    node scripts/smoke-retention.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { runRetentionSweep } from "../backend/retention/sweep.js";
import { retentionPolicyFor, invalidateRetentionPolicy } from "../backend/retention/policy.js";

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
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
console.log(`marker: ${marker}`);

const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("login", login.status === 200 && login.body.token, `role=${login.body.user?.role}`);
const token = login.body.token;
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const NS = claims.namespaceId, ORG = claims.organizationId, USER = claims.userId;
const startedAt = new Date().toISOString();   // notes extracted from this run's threads are removed at the end

const chat = async (message, conversationId = null) => {
  const r = await json("/api/chat", { method: "POST", token, body: { message, namespaceId: NS, privateMode: false, ...(conversationId ? { conversationId } : {}) } });
  if (r.status !== 200 || !r.body.conversationId) throw new Error(`chat failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.conversationId;
};
const backdate = (id, days) => db.from("conversations").update({ last_message_at: daysAgo(days), created_at: daysAgo(days + 1) }).eq("id", id);
const thread = (id) => db.from("conversations").select("id, archived_at, purged_at, message_count, legal_hold").eq("id", id).maybeSingle().then((r) => r.data);
const msgs = (id) => db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", id).then((r) => r.count);

const ids = {};
const { data: priorSettings } = await db.from("memory_settings").select("namespace_id, retention_days").eq("namespace_id", NS).maybeSingle();
const restoreSettings = async () => {
  if (priorSettings) await db.from("memory_settings").update({ retention_days: priorSettings.retention_days }).eq("namespace_id", NS);
  else await db.from("memory_settings").delete().eq("namespace_id", NS);
  invalidateRetentionPolicy();
};

try {
  // ---- policy as it stands
  const p0 = await retentionPolicyFor(db, NS, null);
  check("policy resolves to 30 days from the organization", p0.days === 30 && p0.source === "organization" && p0.ready && !p0.hold, `${p0.days} via ${p0.source}`);

  // ---- threads
  ids.A = await chat(`What does the LEE 3311 document cover? Project ${marker}.`);
  await chat(`Decision for ${marker}: adopt that program's structure. Who is its audience?`, ids.A);
  ids.B = await chat(`Who is the audience of the Operations Playbook? (${marker} hold)`);
  ids.D = await chat(`What is in the Operations Playbook? (${marker} recent)`);
  ids.E = await chat(`Summarize the Operations Playbook briefly. (${marker} forever)`);
  const { data: c } = await db.from("conversations").insert([{ organization_id: ORG, namespace_id: NS, user_id: USER, title: `${marker} empty` }]).select("id").single();
  ids.C = c.id;
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.all([backdate(ids.A, 40), backdate(ids.B, 40), backdate(ids.C, 40), backdate(ids.E, 40)]);
  await db.from("conversations").update({ legal_hold: true, legal_hold_reason: "smoke", legal_hold_by: USER, legal_hold_at: new Date().toISOString() }).eq("id", ids.B);
  check("threads created and backdated", (await msgs(ids.A)) === 4 && (await msgs(ids.B)) === 2 && (await thread(ids.C)).message_count === 0 && (await msgs(ids.D)) === 2);

  // ---- dry run writes nothing
  const dry = await runRetentionSweep(db, openai, { dryRun: true, organizationId: ORG, limit: 50, show: true, actor: "script:smoke-retention" });
  const nsDry = dry.namespaces.find((r) => r.namespace_id === NS);
  check("dry run reports the namespace at 30 days", dry.ready && dry.dry_run && nsDry?.days === 30 && nsDry.source === "organization", JSON.stringify({ candidates: nsDry?.candidates, archived: nsDry?.archived, empty: nsDry?.deleted_empty }));
  check("dry run counts A and E as archived, C as empty, B and D not candidates", nsDry.candidates === 3 && nsDry.archived === 2 && nsDry.deleted_empty === 1 && nsDry.held === 0, `candidates=${nsDry.candidates} archived=${nsDry.archived} empty=${nsDry.deleted_empty}`);
  check("dry run shows a sample summary", dry.samples.some((s) => s.conversation_id === ids.A && s.summary_text.length > 0));
  check("dry run wrote nothing", (await msgs(ids.A)) === 4 && (await thread(ids.C)) && !(await thread(ids.A)).archived_at);
  const { count: evDry } = await db.from("memory_events").select("id", { count: "exact", head: true }).eq("event", "retention_sweep").eq("actor", "script:smoke-retention").gte("created_at", dry.ran_at);
  check("dry run logged no sweep event", evDry === 0);

  // ---- namespace override: keep forever for E
  await db.from("memory_settings").upsert({ namespace_id: NS, organization_id: ORG, retention_days: 0 }, { onConflict: "namespace_id" });
  invalidateRetentionPolicy();
  const p1 = await retentionPolicyFor(db, NS, null);
  check("namespace override wins: keep forever", p1.days === 0 && p1.source === "namespace" && p1.keepForever);
  const keep = await runRetentionSweep(db, openai, { organizationId: ORG, limit: 50, actor: "script:smoke-retention" });
  const nsKeep = keep.namespaces.find((r) => r.namespace_id === NS);
  check("sweep skips the namespace while it keeps forever", nsKeep?.skipped === "keep forever" && nsKeep.candidates === 0 && (await msgs(ids.A)) === 4);
  await restoreSettings();
  const p2 = await retentionPolicyFor(db, NS, null);
  check("settings restored: 30 days from the organization again", p2.days === 30 && p2.source === "organization");

  // ---- the real pass
  const real = await runRetentionSweep(db, openai, { organizationId: ORG, limit: 50, actor: "script:smoke-retention" });
  const nsReal = real.namespaces.find((r) => r.namespace_id === NS);
  check("real pass archives A and E and deletes C", nsReal.archived === 2 && nsReal.deleted_empty === 1 && nsReal.deferred === 0, `archived=${nsReal.archived} fallback=${nsReal.fallback} empty=${nsReal.deleted_empty} $${nsReal.usd.toFixed(4)}`);
  const A = await thread(ids.A);
  check("A is archived and purged", A?.archived_at && A.purged_at && (await msgs(ids.A)) === 0);
  const { data: archA } = await db.from("conversation_archives").select("summary, summary_text, fallback, prompt_version").eq("conversation_id", ids.A).maybeSingle();
  check("A's archive has a real summary", archA && archA.fallback === false && archA.prompt_version === "archive-v2" && JSON.stringify(archA.summary).includes(marker), archA?.summary?.topic);
  const { data: archE } = await db.from("conversation_archives").select("fallback, summary").eq("conversation_id", ids.E).maybeSingle();
  check("E (one turn) got the metadata-only record", archE?.fallback === true && /too short/.test(archE.summary?.generation?.reason || ""));
  check("C (empty) is gone", (await thread(ids.C)) === null);
  const { data: evC } = await db.from("memory_events").select("event, detail").eq("conversation_id", ids.C).eq("event", "conversation_purged");
  check("C's deletion is logged as an empty purge", evC?.length === 1 && evC[0].detail?.empty === true);
  const B = await thread(ids.B);
  check("B (held) untouched", B && !B.archived_at && (await msgs(ids.B)) === 2);
  check("B's owner delete is refused", (await json(`/api/conversations/${ids.B}`, { method: "DELETE", token })).status === 409);
  const D = await thread(ids.D);
  check("D (recent) untouched", D && !D.archived_at && (await msgs(ids.D)) === 2);
  const { data: tracesA } = await db.from("rag_queries").select("query, text_purged_at").eq("conversation_id", ids.A);
  check("A's trace text scrubbed", tracesA.length >= 2 && tracesA.every((t) => t.query === null && t.text_purged_at));
  const { data: ev } = await db.from("memory_events").select("detail").eq("event", "retention_sweep").eq("actor", "script:smoke-retention").eq("target_organization_id", ORG).order("created_at", { ascending: false }).limit(1);
  check("one retention_sweep event per organization with totals", ev?.length === 1 && ev[0].detail?.archived === 2 && ev[0].detail?.deleted_empty === 1, JSON.stringify(ev?.[0]?.detail));

  // ---- clear the hold: B archives on the next pass, metadata only
  await db.from("conversations").update({ legal_hold: false, legal_hold_reason: null, legal_hold_by: null, legal_hold_at: null }).eq("id", ids.B);
  const next = await runRetentionSweep(db, openai, { organizationId: ORG, limit: 50, actor: "script:smoke-retention" });
  const nsNext = next.namespaces.find((r) => r.namespace_id === NS);
  const B2 = await thread(ids.B);
  check("B archives once the hold is cleared (metadata only: one user turn)", nsNext.archived === 1 && nsNext.fallback === 1 && B2?.archived_at, `archived=${nsNext.archived} fallback=${nsNext.fallback}`);
  const idle = await runRetentionSweep(db, openai, { organizationId: ORG, limit: 50, actor: "script:smoke-retention" });
  check("a further pass finds nothing", idle.totals.candidates === 0);

  // ---- archived threads read back and delete through the routes
  const detail = await json(`/api/conversations/${ids.A}`, { token });
  check("A's detail shows the archive", detail.status === 200 && detail.body.state === "archived" && detail.body.archive?.summary_text === archA.summary_text);
} finally {
  await restoreSettings();
  for (const id of Object.values(ids)) {
    await db.from("conversations").update({ legal_hold: false }).eq("id", id);
    await json(`/api/conversations/${id}`, { method: "DELETE", token });
    await db.from("conversations").delete().eq("id", id);
  }
  await db.from("memories").delete().ilike("content", `%${marker}%`);
  // notes Cortéx extracted from this run's threads (the marker is not always in them)
  await db.from("memories").delete().eq("namespace_id", NS).eq("user_id", USER).gte("created_at", startedAt);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
