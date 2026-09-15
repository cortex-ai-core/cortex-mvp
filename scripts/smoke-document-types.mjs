#!/usr/bin/env node
// =============================================================
//  Document types at the organization level (migration 0014), through
//  the running backend:
//    - the list is the same from two namespaces of the organization
//    - an operator (EVAL_EMAIL_2) can read but not create
//    - a super admin creates, a case variant is 409, rename follows onto
//      documents across namespaces, delete clears the label, and a
//      document PATCH accepts the type by name in any case
//  Needs EVAL_EMAIL (super admin) with at least two namespaces, and a
//  document in the organization. Cleans up.
//
//    node scripts/smoke-document-types.mjs [--base http://localhost:8080]
// =============================================================

import "../backend/lib/env.js";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

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
const marker = `Zq${randomBytes(2).toString("hex")}`;
const login = async (email, password, namespaceId) => json("/api/auth/login", { method: "POST", body: { email, password, ...(namespaceId ? { namespaceId } : {}) } });

const a = await login(EMAIL, PASSWORD);
check("super admin login", a.status === 200 && a.body.user?.role === "super_admin");
const tokenA = a.body.token;
const claims = JSON.parse(Buffer.from(tokenA.split(".")[1], "base64url").toString());
const ORG = claims.organizationId, NS_A = claims.namespaceId;
const NS_B = (claims.namespaces || []).find((id) => id !== NS_A) || null;
let tokenB = null;
if (NS_B) { const b = await login(EMAIL, PASSWORD, NS_B); tokenB = b.body.token; check("login into a second namespace", b.status === 200 && JSON.parse(Buffer.from(tokenB.split(".")[1], "base64url").toString()).namespaceId === NS_B); }
else console.log("SKIP  second namespace (the eval user has only one)");

let typeId = null, docId = null, docPrior = null;
try {
  const list = await json("/api/document-types", { token: tokenA });
  check("list is organization-scoped", list.status === 200 && list.body.scope === "organization" && list.body.types.every((t) => t.organization_id === ORG), `${list.body.types?.length} types`);

  if (EMAIL2 && PASSWORD2) {
    const op = await login(EMAIL2, PASSWORD2);
    const opList = await json("/api/document-types", { token: op.body.token });
    const opCreate = await json("/api/document-types", { method: "POST", token: op.body.token, body: { name: `${marker} op` } });
    check("operator can read the list but not create", opList.status === 200 && opCreate.status === 403, `${opList.status}/${opCreate.status}`);
  } else console.log("SKIP  operator checks (EVAL_EMAIL_2 unset)");

  const created = await json("/api/document-types", { method: "POST", token: tokenA, body: { name: `${marker} Contract`, description: "smoke" } });
  typeId = created.body.type?.id || null;
  check("super admin creates a type in the organization", created.status === 201 && created.body.type?.organization_id === ORG, created.body.error);
  const dupe = await json("/api/document-types", { method: "POST", token: tokenA, body: { name: `${marker.toUpperCase()} CONTRACT` } });
  check("a case variant of the name is 409", dupe.status === 409);
  if (tokenB) {
    const fromB = await json("/api/document-types", { token: tokenB });
    check("the second namespace sees the same type", fromB.body.types?.some((t) => t.id === typeId));
  }

  // a document takes the type by name, any case
  const { data: doc } = await db.from("documents").select("id, document_type, namespace_id").eq("namespace_id", NS_A).eq("status", "ready").limit(1).maybeSingle();
  if (doc) {
    docId = doc.id; docPrior = doc.document_type;
    const set = await json(`/api/documents/${docId}`, { method: "PATCH", token: tokenA, body: { document_type: `${marker.toLowerCase()} contract` } });
    const storedType = set.body.document_type ?? set.body.document?.document_type;
    check("document PATCH accepts the type by name in another case and stores the canonical spelling", set.status === 200 && storedType === `${marker} Contract`, `stored=${storedType}`);
    const unknown = await json(`/api/documents/${docId}`, { method: "PATCH", token: tokenA, body: { document_type: `${marker} Nope` } });
    check("an unknown type is 400", unknown.status === 400);
    const renamed = await json(`/api/document-types/${typeId}`, { method: "PATCH", token: tokenA, body: { name: `${marker} Agreement` } });
    const { data: after } = await db.from("documents").select("document_type").eq("id", docId).single();
    check("rename follows onto the document", renamed.status === 200 && after.document_type === `${marker} Agreement`, after.document_type);
    const del = await json(`/api/document-types/${typeId}`, { method: "DELETE", token: tokenA });
    const { data: cleared } = await db.from("documents").select("document_type").eq("id", docId).single();
    check("delete clears the label on the document", del.status === 200 && cleared.document_type === null);
    typeId = null;
  } else {
    console.log("SKIP  document checks (no ready document in the namespace)");
  }
} finally {
  if (typeId) await db.from("document_types").delete().eq("id", typeId);
  if (docId) await db.from("documents").update({ document_type: docPrior }).eq("id", docId);
  await db.from("document_types").delete().ilike("name", `${marker}%`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
