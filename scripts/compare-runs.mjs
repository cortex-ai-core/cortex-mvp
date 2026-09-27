#!/usr/bin/env node
// =============================================================
//  Two eval runs side by side (docs/KEV_PROTOTYPE.md §4.2): answer
//  quality, latency (total, first token, intent, time to synthesis) and
//  cost per turn, then every question whose result changed.
//
//    node scripts/compare-runs.mjs eval/runs/<baseline>.json eval/runs/<candidate>.json
// =============================================================

import { readFileSync } from "node:fs";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) { console.error("usage: node scripts/compare-runs.mjs <baseline.json> <candidate.json>"); process.exit(1); }
const A = JSON.parse(readFileSync(aPath, "utf8"));
const B = JSON.parse(readFileSync(bPath, "utf8"));

const pct = (x) => (x == null ? "–" : `${(x * 100).toFixed(1)}%`);
const num = (x) => (x == null ? "–" : String(Math.round(x)));
const delta = (a, b, kind) => {
  if (a == null || b == null) return "";
  const d = b - a;
  if (kind === "pct") return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)} pts`;
  if (kind === "usd") return `${d >= 0 ? "+" : ""}${((d / a) * 100).toFixed(0)}%`;
  return `${d >= 0 ? "+" : ""}${Math.round(d)} ms (${d >= 0 ? "+" : ""}${((d / a) * 100).toFixed(0)}%)`;
};

const lines = [
  ["document recall", "docRecallAtK", "pct"],
  ["must-include", "mustInclude", "pct"],
  ["citation precision", "citationPrecision", "pct"],
  ["abstain accuracy", "abstainAccuracy", "pct"],
  ["intent accuracy", "intentAccuracy", "pct"],
  ["cost per turn", "costPerTurn", "usd"],
  ["chat p50", (s) => s.chatMs?.p50, "ms"],
  ["chat p95", (s) => s.chatMs?.p95, "ms"],
  ["first token p50", (s) => s.ttftMs?.p50, "ms"],
  ["first token p95", (s) => s.ttftMs?.p95, "ms"],
  ["intent p50", (s) => s.intentMs?.p50, "ms"],
  ["intent p95", (s) => s.intentMs?.p95, "ms"],
  ["to synthesis p50", (s) => s.synthesisStartMs?.p50, "ms"],
  ["retrieve p50", (s) => s.retrieveMs?.p50, "ms"],
];

console.log(`\n${"".padEnd(20)} ${"baseline".padStart(10)} ${"candidate".padStart(10)}   change`);
console.log(`${"".padEnd(20)} ${aPath.split(/[\\/]/).pop().slice(0, 30)}  →  ${bPath.split(/[\\/]/).pop().slice(0, 30)}`);
for (const [label, key, kind] of lines) {
  const get = typeof key === "function" ? key : (s) => s[key];
  const a = get(A.summary), b = get(B.summary);
  const fmt = kind === "pct" ? pct : kind === "usd" ? (x) => (x == null ? "–" : `$${x.toFixed(4)}`) : num;
  console.log(`${label.padEnd(20)} ${fmt(a).padStart(10)} ${fmt(b).padStart(10)}   ${delta(a, b, kind)}`);
}
if (A.summary.intentSources || B.summary.intentSources) {
  console.log(`${"intent sources".padEnd(20)} ${JSON.stringify(A.summary.intentSources || {})}  →  ${JSON.stringify(B.summary.intentSources || {})}`);
}

// per question: what flipped
const byId = new Map(A.rows.map((r) => [r.id, r]));
const checks = ["docRecall", "mustInclude", "abstained", "intentOk"];
const flips = [];
for (const b of B.rows) {
  const a = byId.get(b.id);
  if (!a) continue;
  for (const c of checks) {
    if (a[c] !== undefined && b[c] !== undefined && a[c] !== b[c] && a[c] !== null && b[c] !== null) flips.push(`${b.id.padEnd(10)} ${c.padEnd(12)} ${a[c]} → ${b[c]}   (mode ${a.chat?.mode} → ${b.chat?.mode}, intent ${a.chat?.intent}/${a.chat?.scope} → ${b.chat?.intent}/${b.chat?.scope})`);
  }
  if (a.chat?.mode && b.chat?.mode && a.chat.mode !== b.chat.mode && !flips.some((f) => f.startsWith(b.id))) {
    flips.push(`${b.id.padEnd(10)} ${"mode".padEnd(12)} ${a.chat.mode} → ${b.chat.mode}   (intent ${a.chat?.intent}/${a.chat?.scope} → ${b.chat?.intent}/${b.chat?.scope})`);
  }
}
console.log(`\n${flips.length ? "changed:" : "no question changed result or answer mode"}`);
for (const f of flips) console.log(`  ${f}`);
