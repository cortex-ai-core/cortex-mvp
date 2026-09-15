#!/usr/bin/env node
// =============================================================
//  Structural check (plan 4, 11.3): backend/pcl may be imported only by
//  routes/chat.js, routes/settings/*, and files inside backend/pcl
//  itself. Retrieval, memory, DLP and the permission map must never
//  see a persona. Exits 1 and names the offenders otherwise.
//
//    node scripts/check-pcl-boundary.mjs
// =============================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const scan = [join(root, "backend"), join(root, "server.js")];
const allowed = (rel) =>
  rel === join("backend", "routes", "chat.js") ||
  rel.startsWith(join("backend", "routes", "settings") + sep) ||
  rel.startsWith(join("backend", "pcl") + sep);

const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); }
  else if (/\.(m?js)$/.test(p) && !p.includes(".bak")) files.push(p);
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
    if (/(^|\/)pcl\/[A-Za-z0-9_.-]+\.js$/.test(spec) && !allowed(rel)) offenders.push(`${rel} imports ${spec}`);
  }
}

if (offenders.length) {
  console.log("FAIL  backend/pcl is imported outside routes/chat.js and routes/settings/:");
  for (const o of offenders) console.log("      " + o);
  process.exit(1);
}
console.log(`PASS  ${files.length} files scanned; backend/pcl is imported only where allowed`);
