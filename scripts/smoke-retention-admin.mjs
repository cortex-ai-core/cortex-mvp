#!/usr/bin/env node
// =============================================================
//  Retention Phase 4 smoke: the admin routes.
//
//  Super admin (EVAL_EMAIL) and operator (EVAL_EMAIL_2, skipped when
//  unset) against the running backend:
//    - operator is refused (403) on every retention route
//    - GET shows 30 days from the organization with counts
//    - PATCH days to 90 -> the organization list and the policy resolver
//      agree; a bad value is 400; back to 30
//    - organization hold without a reason is 400; with a reason the
//      owner's delete of a fresh thread is 409; clearing it logs an event
//      and the delete works
//    - per-thread hold: 400 without reason, 200 with, the holds list
//      shows it, the owner's delete is 409, release, delete works
//    - namespace override to 365 then back to inherit; the resolver
//      follows within the request (cache invalidated)
//  Restores everything it changed. Needs migration 0013.
//
//    node scripts/smoke-retention-admin.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { retentionPolicyFor, invalidateRetentionPolicy } from "../backend/retention/policy.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const EMAIL = process.env.EVAL_EMAIL, PASSWORD = process.env.EVAL_PASSWORD;
const EMAIL2 = process.env.EVAL_EMAIL_2, PASSWORD2 = process.env.EVAL_PASSWORD_2;
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

const login = await json("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
check("super admin login", login.status === 200 && login.body.user?.role === "super_admin", `role=${login.body.user?.role}`);
const token = login.body.token;
const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const NS = claims.namespaceId, ORG = claims.organizationId, USER = claims.userId;
const startedAt = new Date().toISOString();   // notes extracted from this run's threads are removed at the end

const { data: priorOrg } = await db.from("organization").select("chat_retention_days, retention_hold, retention_hold_reason").eq("id", ORG).single();
const { data: priorSettings } = await db.from("memory_settings").select("namespace_id, retention_days").eq("namespace_id", NS).maybeSingle();
let convId = null;
const restore = async () => {
  await db.from("organization").update(priorOrg).eq("id", ORG);
  if (priorSettings) await db.from("memory_settings").update({ retention_days: priorSettings.retention_days }).eq("namespace_id", NS);
  else await db.from("memory_settings").delete().eq("namespace_id", NS);
  if (convId) { await db.from("conversations").update({ legal_hold: false }).eq("id", convId); await db.from("conversations").delete().eq("id", convId); }
  invalidateRetentionPolicy();
};

try {
  // ---- operator: refused everywhere
  if (EMAIL2 && PASSWORD2) {
    const op = await json("/api/auth/login", { method: "POST", body: { email: EMAIL2, password: PASSWORD2 } });
    check("operator login", op.status === 200, `role=${op.body.user?.role}`);
    const t2 = op.body.token;
    const refused = await Promise.all([
      json(`/api/settings/organizations/${ORG}/retention`, { token: t2 }),
      json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token: t2, body: { chat_retention_days: 5 } }),
      json(`/api/settings/organizations/${ORG}/holds`, { token: t2 }),
      json(`/api/settings/conversations/00000000-0000-4000-8000-000000000000/hold`, { method: "POST", token: t2, body: { hold: true, reason: "x" } }),
      json(`/api/settings/namespaces/${NS}/retention`, { method: "PATCH", token: t2, body: { retention_days: 1 } }),
    ]);
    check("operator is 403 on all five retention routes", refused.every((r) => r.status === 403), refused.map((r) => r.status).join(","));
  } else {
    console.log("SKIP  operator checks (EVAL_EMAIL_2 unset)");
  }

  // ---- read
  const get = await json(`/api/settings/organizations/${ORG}/retention`, { token });
  check("GET shows the policy and counts", get.status === 200 && get.body.organization?.chat_retention_days === 30 && get.body.organization.retention_hold === false && get.body.default_days === 30 && Array.isArray(get.body.namespaces) && typeof get.body.counts?.active === "number", JSON.stringify(get.body.counts));
  const nsRow = get.body.namespaces?.find((n) => n.id === NS);
  check("the namespace inherits 30 from the organization", nsRow?.effective_days === 30 && nsRow.source === "organization" && nsRow.retention_days === null);

  // ---- preview of a shorter value
  const preview = await json(`/api/settings/organizations/${ORG}/retention?days=1`, { token });
  check("GET ?days=1 previews how many chats a shorter period would reach", preview.status === 200 && preview.body.preview?.days === 1 && typeof preview.body.preview?.due === "number" && preview.body.preview.due >= preview.body.counts.due, JSON.stringify(preview.body.preview));
  const badPreview = await json(`/api/settings/organizations/${ORG}/retention?days=x`, { token });
  check("a bad preview value is 400", badPreview.status === 400);

  // ---- days
  const bad = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { chat_retention_days: -3 } });
  check("negative days is 400", bad.status === 400);
  const bad2 = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { chat_retention_days: 2.5 } });
  check("fractional days is 400", bad2.status === 400);
  const set90 = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { chat_retention_days: 90 } });
  check("PATCH days to 90", set90.status === 200 && set90.body.organization?.chat_retention_days === 90 && set90.body.namespaces.find((n) => n.id === NS)?.effective_days === 90);
  const list = await json("/api/settings/organizations", { token });
  check("organization list carries the new days", list.status === 200 && list.body.organizations?.find((o) => o.id === ORG)?.chat_retention_days === 90);
  invalidateRetentionPolicy();
  const p90 = await retentionPolicyFor(db, NS, null);
  check("policy resolver sees 90 from the organization", p90.days === 90 && p90.source === "organization");
  const keep = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { chat_retention_days: 0 } });
  check("0 (keep forever) is accepted and due drops to 0", keep.status === 200 && keep.body.organization.chat_retention_days === 0 && keep.body.counts.due === 0);
  const back = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { chat_retention_days: 30 } });
  check("back to 30", back.status === 200 && back.body.organization.chat_retention_days === 30);

  // ---- a thread to hold
  const t1 = await json("/api/chat", { method: "POST", token, body: { message: `Remember that the ${marker} invoice is due on the 14th.`, namespaceId: NS, privateMode: false } });
  convId = t1.body.conversationId;
  check("a thread exists to hold", t1.status === 200 && typeof convId === "string");

  // ---- organization hold
  const noReason = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { retention_hold: true } });
  check("organization hold without a reason is 400", noReason.status === 400);
  const orgHold = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { retention_hold: true, retention_hold_reason: `smoke ${marker}` } });
  check("organization hold placed", orgHold.status === 200 && orgHold.body.organization.retention_hold === true && orgHold.body.organization.retention_hold_reason === `smoke ${marker}`);
  const delHeld = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  check("owner delete is 409 under the organization hold", delHeld.status === 409 && delHeld.body.hold?.scope === "organization");
  const orgRelease = await json(`/api/settings/organizations/${ORG}/retention`, { method: "PATCH", token, body: { retention_hold: false } });
  check("organization hold released, reason cleared", orgRelease.status === 200 && orgRelease.body.organization.retention_hold === false && orgRelease.body.organization.retention_hold_reason === null);
  const { data: orgEvents } = await db.from("memory_events").select("event, reason, detail").eq("target_organization_id", ORG).in("event", ["legal_hold_set", "legal_hold_cleared"]).is("conversation_id", null).eq("actor", USER).order("created_at", { ascending: false }).limit(2);
  check("organization hold set and cleared are logged", orgEvents?.length === 2 && orgEvents[0].event === "legal_hold_cleared" && orgEvents[1].event === "legal_hold_set" && orgEvents[1].reason === `smoke ${marker}` && orgEvents[1].detail?.scope === "organization");

  // ---- per-thread hold
  const noReason2 = await json(`/api/settings/conversations/${convId}/hold`, { method: "POST", token, body: { hold: true } });
  check("thread hold without a reason is 400", noReason2.status === 400);
  const hold = await json(`/api/settings/conversations/${convId}/hold`, { method: "POST", token, body: { hold: true, reason: `records request ${marker}` } });
  check("thread hold placed", hold.status === 200 && hold.body.conversation?.legal_hold === true && hold.body.conversation.legal_hold_by === USER && hold.body.conversation.legal_hold_at, JSON.stringify(hold.body.conversation?.legal_hold_reason));
  const holds = await json(`/api/settings/organizations/${ORG}/holds`, { token });
  check("holds list shows it with owner and reason", holds.status === 200 && holds.body.holds?.some((h) => h.conversation_id === convId && h.owner_email === EMAIL && h.legal_hold_reason === `records request ${marker}` && h.state === "active"));
  const counts = await json(`/api/settings/organizations/${ORG}/retention`, { token });
  check("held count includes it", counts.body.counts?.held >= 1);
  const delHeld2 = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  check("owner delete is 409 under the thread hold", delHeld2.status === 409 && delHeld2.body.hold?.scope === "conversation" && delHeld2.body.hold.reason === `records request ${marker}`);
  const unknown = await json(`/api/settings/conversations/00000000-0000-4000-8000-000000000000/hold`, { method: "POST", token, body: { hold: true, reason: "x" } });
  check("unknown thread is 404", unknown.status === 404);
  const release = await json(`/api/settings/conversations/${convId}/hold`, { method: "POST", token, body: { hold: false } });
  check("thread hold released", release.status === 200 && release.body.conversation.legal_hold === false && release.body.conversation.legal_hold_reason === null);
  const { data: convEvents } = await db.from("memory_events").select("event, reason, detail").eq("conversation_id", convId).in("event", ["legal_hold_set", "legal_hold_cleared"]).order("created_at", { ascending: true });
  check("thread hold set and cleared are logged", convEvents?.length === 2 && convEvents[0].event === "legal_hold_set" && convEvents[0].detail?.scope === "conversation" && convEvents[1].event === "legal_hold_cleared");
  const del = await json(`/api/conversations/${convId}`, { method: "DELETE", token });
  check("owner delete works once released", del.status === 200 && del.body.receipt);
  if (del.status === 200) convId = null;

  // ---- namespace override
  const ns365 = await json(`/api/settings/namespaces/${NS}/retention`, { method: "PATCH", token, body: { retention_days: 365 } });
  check("namespace override to 365", ns365.status === 200 && ns365.body.namespace?.retention_days === 365 && ns365.body.namespace.effective_days === 365 && ns365.body.namespace.source === "namespace");
  invalidateRetentionPolicy();   // this script's own cache, not the server's
  const p365 = await retentionPolicyFor(db, NS, null);
  check("policy resolver sees 365 from the namespace", p365.days === 365 && p365.source === "namespace");
  const get2 = await json(`/api/settings/organizations/${ORG}/retention`, { token });
  check("GET shows the override on the namespace row", get2.body.namespaces?.find((n) => n.id === NS)?.retention_days === 365);
  const nsBad = await json(`/api/settings/namespaces/${NS}/retention`, { method: "PATCH", token, body: { retention_days: "soon" } });
  check("bad override is 400", nsBad.status === 400);
  const nsInherit = await json(`/api/settings/namespaces/${NS}/retention`, { method: "PATCH", token, body: { retention_days: null } });
  check("override cleared: inherits 30 again", nsInherit.status === 200 && nsInherit.body.namespace.retention_days === null && nsInherit.body.namespace.effective_days === 30 && nsInherit.body.namespace.source === "organization");
  invalidateRetentionPolicy();
  const p30 = await retentionPolicyFor(db, NS, null);
  check("policy resolver back to 30 from the organization", p30.days === 30 && p30.source === "organization");
} finally {
  await restore();
  await db.from("memories").delete().ilike("content", `%${marker}%`);
  // notes Cortéx extracted from this run's threads (the marker is not always in them)
  await db.from("memories").delete().eq("namespace_id", NS).eq("user_id", USER).gte("created_at", startedAt);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
