#!/usr/bin/env node
// =============================================================
//  The customer spec's section 60 master test, walked against Dev2
//  (plan P-5.4): a user working in the Recruiting namespace, where the
//  namespace default is the Talent Intelligence persona, asks a hiring
//  question and the answer carries that persona, cites the resumes, and
//  says nothing that the persona could not have changed.
//
//  Dev2 has no operator account in the Recruiting namespace, so the walk
//  uses the eval user (an administrator), adds them to Recruiting for the
//  duration, signs in with that namespace, and removes the membership
//  afterwards. The persona resolution, provenance and answer are the
//  same for any role: role is never an input to the persona.
//
//    node scripts/walk-section-60.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const { EVAL_EMAIL, EVAL_PASSWORD } = process.env;
if (!EVAL_EMAIL || !EVAL_PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }
const RECRUITING_NAME = "recruiting";

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

const home = await json("/api/auth/login", { method: "POST", body: { email: EVAL_EMAIL, password: EVAL_PASSWORD } });
check("login in the home namespace", home.status === 200, `role=${home.body.user?.role} ns=${home.body.user?.namespace}`);
const adminToken = home.body.token;
const me = claimsOf(adminToken);

const orgs = await json("/api/settings/organizations", { token: adminToken });
const recruiting = (orgs.body.organizations || []).flatMap((o) => o.namespaces).find((n) => n.name.toLowerCase() === RECRUITING_NAME);
check("the Recruiting namespace exists", Boolean(recruiting), recruiting?.id);
const personas = (await json("/api/settings/personas", { token: adminToken })).body.personas || [];
const talent = personas.find((p) => p.key === "talent_intelligence");
check("Recruiting's default persona is Talent Intelligence", recruiting?.default_persona_id === talent?.id, `v${talent?.current_version?.version}`);

const wasMember = (home.body.user?.namespaces || []).some((n) => n.id === recruiting?.id);
let added = false;
const threads = [];
try {
  if (!wasMember) {
    const add = await json(`/api/settings/namespaces/${recruiting.id}/users`, { method: "POST", token: adminToken, body: { userId: me.userId } });
    added = add.status === 201 || add.status === 200;
    check("added to Recruiting for the walk", added, `status=${add.status}`);
  }
  const rec = await json("/api/auth/login", { method: "POST", body: { email: EVAL_EMAIL, password: EVAL_PASSWORD, namespaceId: recruiting.id } });
  check("sign in to Recruiting", rec.status === 200 && claimsOf(rec.body.token).namespaceId === recruiting.id);
  const token = rec.body.token;

  const preview = await json(`/api/settings/personas/preview?userId=${me.userId}&namespaceId=${recruiting.id}`, { token: adminToken });
  check("preview: Talent Intelligence via the namespace default", preview.body.persona?.key === "talent_intelligence" && preview.body.persona_source === "namespace", `v${preview.body.version}`);
  check("preview renders the recruiting rules", /Separate evidence from inference/.test(preview.body.rendered?.rules || ""));

  const ask = async (message) => {
    const r = await json("/api/chat", { method: "POST", token, body: { message, namespaceId: recruiting.id, privateMode: false } });
    if (r.body?.conversationId) threads.push(r.body.conversationId);
    return r;
  };
  const q1 = await ask("Compare the candidates whose resumes are on file for a support engineer opening. Who should advance, and what is the gap for each?");
  check("the answer carries the Talent Intelligence persona from the namespace", q1.body.pcl?.persona_key === "talent_intelligence" && q1.body.pcl?.persona_source === "namespace", JSON.stringify({ persona: q1.body.pcl?.persona_key, source: q1.body.pcl?.persona_source, version: q1.body.pcl?.version, mode: q1.body.mode }));
  const answer = q1.body.finalAnswer || "";
  const cited = Array.isArray(q1.body.citations) && q1.body.citations.length > 0;
  const declined = /don't cover|do not cover|no matching documents/i.test(answer);
  check("the answer is grounded: cites resumes, or says the namespace has none", cited || declined, `citations=${q1.body.citations?.length ?? 0} chars=${answer.length}`);
  if (cited) check("the answer separates evidence from inference or names a gap", /gap|evidence|infer|demonstrat|stated|resume/i.test(answer));
  console.log("\n--- answer (first 600 chars) ---\n" + answer.slice(0, 600) + "\n---");

  const q2 = await ask("Who is the current CEO of MultiCare Health System?");
  check("out of scope still declines under the recruiting persona", /don't cover|do not cover|no matching documents|not (?:covered|mentioned|found)/i.test(q2.body.finalAnswer || "") && q2.body.pcl?.persona_key === "talent_intelligence", (q2.body.finalAnswer || "").slice(0, 80));

  const trace = await (async () => { for (let i = 0; i < 10; i++) { const t = await json(`/api/memory/traces/${q1.body.traceId}`, { token }); if (t.status === 200 && t.body?.pcl) return t.body; await new Promise((r) => setTimeout(r, 500)); } return null; })();
  check("the trace records the persona and version that answered", trace?.pcl?.persona_key === "talent_intelligence" && trace?.pcl?.version === q1.body.pcl?.version);
  for (const id of threads) await json(`/api/conversations/${id}`, { method: "DELETE", token });
} finally {
  if (added) {
    const rm = await json(`/api/settings/namespaces/${recruiting.id}/users/${me.userId}`, { method: "DELETE", token: adminToken });
    check("membership removed again", rm.status === 204, `status=${rm.status}`);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
