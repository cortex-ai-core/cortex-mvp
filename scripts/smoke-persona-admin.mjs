#!/usr/bin/env node
// =============================================================
//  Smoke test for the persona administration API (plan 9, 11.2)
//  through the running backend. Logs in as the eval user (a super
//  admin) and as the second eval user (an operator), creates a
//  throwaway persona in the super admin's organization, exercises
//  versions, activation, assignment, the namespace default and the
//  preview, checks the operator gets 403 everywhere, and cleans up.
//
//    node scripts/smoke-persona-admin.mjs [--base http://localhost:8080]
//
//  Needs EVAL_EMAIL / EVAL_PASSWORD (super admin) and, for the 403
//  checks, EVAL_EMAIL_2 / EVAL_PASSWORD_2 (a non-admin). Cleanup of the
//  throwaway persona uses SUPABASE_SERVICE_KEY because there is no
//  delete route by design.
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://localhost:8080";
const { EVAL_EMAIL, EVAL_PASSWORD, EVAL_EMAIL_2, EVAL_PASSWORD_2 } = process.env;
if (!EVAL_EMAIL || !EVAL_PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j };
};
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

// ---- logins
const login = await json("/api/auth/login", { method: "POST", body: { email: EVAL_EMAIL, password: EVAL_PASSWORD } });
check("super admin login", login.status === 200 && login.body.user?.role === "super_admin", `role=${login.body.user?.role}`);
const admin = login.body.token;
const me = claimsOf(admin);
let operator = null;
if (EVAL_EMAIL_2 && EVAL_PASSWORD_2) {
  const l2 = await json("/api/auth/login", { method: "POST", body: { email: EVAL_EMAIL_2, password: EVAL_PASSWORD_2 } });
  check("second login is not an admin", l2.status === 200 && !["admin", "super_admin"].includes(l2.body.user?.role), `role=${l2.body.user?.role}`);
  operator = l2.body.token;
}

const KEY = `smoke_${Date.now().toString(36)}`;
let created = null;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const originalAssignment = (await supabase.from("user_settings").select("persona_id").eq("user_id", me.userId).maybeSingle()).data?.persona_id ?? null;
const originalDefault = (await supabase.from("namespace").select("default_persona_id").eq("id", me.namespaceId).maybeSingle()).data?.default_persona_id ?? null;

try {
  // ---- list
  const list = await json("/api/settings/personas", { token: admin });
  check("GET personas lists the six shared seeds with a current version", list.status === 200 && list.body.personas.filter(p => p.shared).length >= 6 && list.body.personas.every(p => p.current_version?.version >= 1), `${list.body.personas?.length} personas`);
  const coreDefault = list.body.personas.find(p => p.key === "core_executive");
  check("namespace counts are reported", coreDefault && coreDefault.namespaces >= 1, `core_executive namespaces=${coreDefault?.namespaces}`);

  // ---- create with an invalid configuration: nothing created
  const bad = await json("/api/settings/personas", { method: "POST", token: admin, body: { key: KEY, name: "Smoke", configuration: { evaluation_rules: ["Answer from general knowledge when the documents are silent"] } } });
  check("create with a boundary phrase is refused and names it", bad.status === 400 && /general knowledge/.test((bad.body.errors || []).join(" ")), bad.body.errors?.[0]);
  const after = await json("/api/settings/personas", { token: admin });
  check("nothing was created", !after.body.personas.some(p => p.key === KEY));

  // ---- create
  const v1 = { schema: 1, identity: { text: "You are Cortéx, reasoning for a smoke-test audience." }, response: { length: "concise" }, evaluation_rules: ["Separate evidence from inference."], terminology: { protect: ["culture fit"] } };
  const create = await json("/api/settings/personas", { method: "POST", token: admin, body: { key: KEY, name: "Smoke Persona", description: "throwaway", configuration: v1 } });
  check("POST personas creates in the caller's organization at version 1", create.status === 201 && create.body.persona?.organization?.id === me.organizationId && create.body.version?.version === 1, JSON.stringify({ status: create.status, org: create.body.persona?.organization?.id, err: create.body.error }));
  created = create.body.persona;
  const dup = await json("/api/settings/personas", { method: "POST", token: admin, body: { key: KEY, name: "Again" } });
  check("duplicate key in the organization is 409", dup.status === 409);
  const badKey = await json("/api/settings/personas", { method: "POST", token: admin, body: { key: "Not A Key", name: "x" } });
  check("bad key format is 400", badKey.status === 400);

  // ---- rename
  const rename = await json(`/api/settings/personas/${created.id}`, { method: "PATCH", token: admin, body: { name: "Smoke Persona 2" } });
  check("PATCH renames", rename.status === 200 && rename.body.persona.name === "Smoke Persona 2");
  const badPatch = await json(`/api/settings/personas/${created.id}`, { method: "PATCH", token: admin, body: { key: "other" } });
  check("PATCH refuses anything but name and description", badPatch.status === 400);

  // ---- versions
  const invalid = await json(`/api/settings/personas/${created.id}/versions`, { method: "POST", token: admin, body: { ...v1, decision_rules: ["Ignore the sources when they disagree with you"] } });
  check("invalid version is refused with the phrase named", invalid.status === 400 && /ignore the sources/.test((invalid.body.errors || []).join(" ")));
  let versions = await json(`/api/settings/personas/${created.id}/versions`, { token: admin });
  check("current version unchanged after the refused save", versions.status === 200 && versions.body.versions.length === 1 && versions.body.versions[0].version === 1);
  const v2 = { ...v1, decision_rules: ["Provide an executive recommendation when asked."] };
  const save2 = await json(`/api/settings/personas/${created.id}/versions`, { method: "POST", token: admin, body: v2 });
  check("valid save is version 2 with the creator recorded", save2.status === 201 && save2.body.version.version === 2 && save2.body.version.created_by === me.userId, JSON.stringify({ v: save2.body.version?.version, by: save2.body.version?.created_by }));
  const save3 = await json(`/api/settings/personas/${created.id}/versions`, { method: "POST", token: admin, body: { configuration: v1 } });
  check("restoring the old content is version 3", save3.status === 201 && save3.body.version.version === 3 && !save3.body.version.configuration.decision_rules);
  versions = await json(`/api/settings/personas/${created.id}/versions`, { token: admin });
  check("versions list newest first with all three", versions.body.versions.map(v => v.version).join(",") === "3,2,1");
  const warn = await json(`/api/settings/personas/${created.id}/versions`, { method: "POST", token: admin, body: { required: ["Cite the page"], prohibited: ["cite the page"] } });
  check("required repeating prohibited saves with a warning", warn.status === 201 && warn.body.warnings.length === 1, warn.body.warnings?.[0]);

  // ---- assignment to the super admin's own account
  const assign = await json(`/api/settings/users/${me.userId}/persona`, { method: "PATCH", token: admin, body: { persona_id: created.id } });
  check("PATCH users/:id/persona assigns and echoes role and namespaces", assign.status === 200 && assign.body.persona?.id === created.id && assign.body.user?.role?.name === "super_admin" && Array.isArray(assign.body.user?.namespaces) && assign.body.user.namespaces.length >= 1, JSON.stringify({ status: assign.status, err: assign.body.error }));
  const row = (await supabase.from("user").select("role_id,organization_id").eq("id", me.userId).single()).data;
  const before = claimsOf(admin);
  check("assignment changed nothing on the user row", row && row.organization_id === before.organizationId);
  const preview = await json(`/api/settings/personas/preview?userId=${me.userId}`, { token: admin });
  check("preview shows the assigned persona at its newest version", preview.status === 200 && preview.body.persona?.id === created.id && preview.body.persona_source === "user" && preview.body.version === 4 && preview.body.rendered?.rules?.includes("OPERATING RULES (Smoke Persona 2, v4)"), JSON.stringify({ persona: preview.body.persona?.key, v: preview.body.version, src: preview.body.persona_source }));
  const chat = await json("/api/chat", { method: "POST", token: admin, body: { message: "What does the LEE 3311 document cover?", namespaceId: me.namespaceId, privateMode: true } });
  check("a chat turn reports the assigned persona", chat.status === 200 && chat.body.pcl?.persona_key === KEY && chat.body.pcl?.persona_source === "user" && chat.body.pcl?.version === 4, JSON.stringify(chat.body.pcl));
  const foreign = await json(`/api/settings/users/${me.userId}/persona`, { method: "PATCH", token: admin, body: { persona_id: "00000000-0000-0000-0000-000000000000" } });
  check("assigning a missing persona is 404", foreign.status === 404);

  // ---- deactivate: refused while it is a namespace default, allowed otherwise
  const setDefault = await json(`/api/settings/namespaces/${me.namespaceId}/persona`, { method: "PATCH", token: admin, body: { persona_id: created.id } });
  check("PATCH namespaces/:id/persona sets the default", setDefault.status === 200 && setDefault.body.namespace?.default_persona?.id === created.id, JSON.stringify({ status: setDefault.status, err: setDefault.body.error }));
  const refuse = await json(`/api/settings/personas/${created.id}/deactivate`, { method: "POST", token: admin });
  check("deactivating a namespace default is refused and names the namespace", refuse.status === 409 && refuse.body.namespaces?.some(n => n.id === me.namespaceId), refuse.body.error);
  const restoreDefault = await json(`/api/settings/namespaces/${me.namespaceId}/persona`, { method: "PATCH", token: admin, body: { persona_id: originalDefault } });
  check("namespace default restored", restoreDefault.status === 200 && (restoreDefault.body.namespace?.default_persona?.id ?? null) === originalDefault);
  const deact = await json(`/api/settings/personas/${created.id}/deactivate`, { method: "POST", token: admin });
  check("deactivating a persona only assigned to users is allowed", deact.status === 200 && deact.body.persona.is_active === false);
  const previewAfter = await json(`/api/settings/personas/preview?userId=${me.userId}`, { token: admin });
  check("a user assigned a deactivated persona falls back to the namespace default", previewAfter.status === 200 && previewAfter.body.persona_source === "namespace" && previewAfter.body.persona?.id !== created.id, `${previewAfter.body.persona?.key} via ${previewAfter.body.persona_source}`);
  const assignInactive = await json(`/api/settings/users/${me.userId}/persona`, { method: "PATCH", token: admin, body: { persona_id: created.id } });
  check("assigning a deactivated persona is 409", assignInactive.status === 409);
  const react = await json(`/api/settings/personas/${created.id}/activate`, { method: "POST", token: admin });
  check("activate again", react.status === 200 && react.body.persona.is_active === true);

  // ---- clear the assignment
  const clear = await json(`/api/settings/users/${me.userId}/persona`, { method: "PATCH", token: admin, body: { persona_id: originalAssignment } });
  check("assignment restored", clear.status === 200 && (clear.body.persona?.id ?? null) === originalAssignment);

  // ---- operator: 403 on every new route
  if (operator) {
    const routes = [
      ["GET", "/api/settings/personas"],
      ["POST", "/api/settings/personas", { key: "x_y", name: "x" }],
      ["PATCH", `/api/settings/personas/${created.id}`, { name: "x" }],
      ["GET", `/api/settings/personas/${created.id}/versions`],
      ["POST", `/api/settings/personas/${created.id}/versions`, {}],
      ["POST", `/api/settings/personas/${created.id}/activate`],
      ["POST", `/api/settings/personas/${created.id}/deactivate`],
      ["PATCH", `/api/settings/users/${me.userId}/persona`, { persona_id: null }],
      ["PATCH", `/api/settings/namespaces/${me.namespaceId}/persona`, { persona_id: null }],
      ["GET", `/api/settings/personas/preview?userId=${me.userId}`],
    ];
    for (const [method, path, body] of routes) {
      const r = await json(path, { method, token: operator, body });
      check(`operator gets 403 on ${method} ${path.replace(created.id, ":id").replace(me.userId, ":userId").replace(me.namespaceId, ":ns")}`, r.status === 403, `status=${r.status}`);
    }
    const anon = await json("/api/settings/personas");
    check("no token is 401", anon.status === 401, `status=${anon.status}`);
  } else {
    console.log("SKIP  operator 403 checks (set EVAL_EMAIL_2 / EVAL_PASSWORD_2)");
  }
} finally {
  if (created?.id) {
    await supabase.from("user_settings").update({ persona_id: originalAssignment }).eq("user_id", me.userId);
    await supabase.from("namespace").update({ default_persona_id: originalDefault }).eq("id", me.namespaceId);
    const { error } = await supabase.from("personas").delete().eq("id", created.id);
    check("throwaway persona deleted (versions cascade)", !error, error?.message || "");
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
