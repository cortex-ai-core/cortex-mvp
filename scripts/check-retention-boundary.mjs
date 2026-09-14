#!/usr/bin/env node
// =============================================================
//  Structural check (retention plan section 9, requirement 3):
//    - backend/retention never imports memory extraction, the memory
//      store's writes, recall, personas or reasoning: archiving a chat
//      can never promote anything into persistent memory or touch how
//      answers are made
//    - backend/retention (schema.js aside, which is a read-only probe
//      anyone may use) is imported only by server.js, the conversation
//      routes, the settings routes, retention itself and scripts
//  Exits 1 and names the offenders otherwise.
//
//    node scripts/check-retention-boundary.mjs
// =============================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const scan = [join(root, "backend"), join(root, "server.js"), join(root, "scripts")];
const importers = (rel) =>
  rel === "server.js" ||
  rel === join("backend", "routes", "conversations.js") ||
  rel.startsWith(join("backend", "routes", "settings") + sep) ||
  rel.startsWith(join("backend", "retention") + sep) ||
  rel.startsWith("scripts" + sep);

const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); }
  else if (/\.(m?js)$/.test(p) && !p.includes(".bak") && !p.includes(".tmp.")) files.push(p);
};
for (const p of scan) { try { walk(p); } catch { /* absent */ } }

const offenders = [];
for (const file of files) {
  const rel = relative(root, file);
  const src = readFileSync(file, "utf8");
  const re = /(?:import[^'"]*from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    const inRetention = rel.startsWith(join("backend", "retention") + sep);
    if (inRetention && /(^|\/)(memory\/(extract|store|recall)|pcl\/[^/]+|reasoning\/[^/]+)\.js$/.test(spec)) {
      offenders.push(`${rel} imports ${spec} (retention must not reach memory writes, personas or reasoning)`);
    }
    if (/(^|\/)retention\/(?!schema\.js)[A-Za-z0-9_.-]+\.js$/.test(spec) && !importers(rel)) {
      offenders.push(`${rel} imports ${spec} (retention is used only by server.js, the conversation and settings routes, and scripts)`);
    }
  }
}

if (offenders.length) {
  console.log("FAIL  retention boundary:");
  for (const o of offenders) console.log("      " + o);
  process.exit(1);
}
console.log(`PASS  ${files.length} files scanned; backend/retention stays inside its boundary`);
