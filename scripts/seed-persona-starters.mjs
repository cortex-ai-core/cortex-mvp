#!/usr/bin/env node
// =============================================================
//  Give every shared persona a filled-in starting point (plan P-5.1).
//
//  Each file in scripts/persona-starters/<key>.json is saved as the
//  persona's next version through the administration API, so it is
//  validated, carries a creator, clears the resolver cache and shows
//  in the version list like any other save. A persona already past
//  version 1 is left alone unless --force is given. Nothing here is
//  Sollucio's framework: it is generic domain sense, meant to be edited.
//
//    node scripts/seed-persona-starters.mjs [--force] [--only advisory,ventures] [--base http://localhost:8080]
//
//  Logs in with EVAL_EMAIL / EVAL_PASSWORD, which must be an administrator.
// =============================================================

import "../backend/lib/env.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfiguration } from "../backend/pcl/validate.js";
import { renderConfiguration } from "../backend/pcl/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const BASE = opt("--base") || "http://localhost:8080";
const FORCE = flag("--force");
const ONLY = opt("--only") ? new Set(opt("--only").split(",").map(s => s.trim())) : null;
const { EVAL_EMAIL, EVAL_PASSWORD } = process.env;
if (!EVAL_EMAIL || !EVAL_PASSWORD) { console.error("set EVAL_EMAIL and EVAL_PASSWORD in .env"); process.exit(1); }

const json = async (path, { method = "GET", body, token } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ---- the files, validated locally first so a bad edit is named before any login
const dir = join(here, "persona-starters");
const starters = readdirSync(dir).filter(f => f.endsWith(".json")).map(f => ({ key: f.replace(/\.json$/, ""), file: join(dir, f) }));
let bad = 0;
for (const s of starters) {
  const config = JSON.parse(readFileSync(s.file, "utf8"));
  const check = validateConfiguration(config);
  if (!check.ok) { bad++; console.log(`INVALID  ${s.key}: ${check.errors.join("; ")}`); continue; }
  s.config = config;
  s.chars = renderConfiguration(check.normalized, { personaName: s.key, version: 2 }).chars;
  if (check.warnings.length) console.log(`warn     ${s.key}: ${check.warnings.join("; ")}`);
}
if (bad) { console.error(`\n${bad} starter file(s) do not validate; nothing was saved.`); process.exit(1); }

// ---- login and the persona list
const login = await json("/api/auth/login", { method: "POST", body: { email: EVAL_EMAIL, password: EVAL_PASSWORD } });
if (login.status !== 200 || !["admin", "super_admin"].includes(login.body.user?.role)) { console.error(`login failed or not an administrator (${login.body.user?.role || login.body.error})`); process.exit(1); }
const token = login.body.token;
const list = await json("/api/settings/personas", { token });
if (list.status !== 200) { console.error(`cannot list personas: ${list.body.error || list.status}`); process.exit(1); }
const byKey = new Map(list.body.personas.filter(p => p.shared).map(p => [p.key, p]));

let saved = 0, skipped = 0, failed = 0;
for (const s of starters) {
  if (ONLY && !ONLY.has(s.key)) continue;
  const persona = byKey.get(s.key);
  if (!persona) { console.log(`missing  ${s.key}: no shared persona with this key`); failed++; continue; }
  const current = persona.current_version?.version ?? 0;
  if (current > 1 && !FORCE) { console.log(`skip     ${s.key}: already at v${current} (use --force to add another version)`); skipped++; continue; }
  const r = await json(`/api/settings/personas/${persona.id}/versions`, { method: "POST", token, body: { configuration: s.config } });
  if (r.status === 201) { saved++; console.log(`saved    ${s.key}: v${r.body.version.version} (${s.chars} chars rendered)${r.body.warnings?.length ? "  warnings: " + r.body.warnings.join("; ") : ""}`); }
  else { failed++; console.log(`FAILED   ${s.key}: ${r.status} ${r.body.error || ""} ${(r.body.errors || []).join("; ")}`); }
}
console.log(`\n${saved} saved, ${skipped} skipped, ${failed} failed`);
process.exit(failed ? 1 : 0);
