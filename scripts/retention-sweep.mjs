#!/usr/bin/env node
// =============================================================
//  Run the retention sweep by hand (plan P3.3). Service key + OpenAI.
//
//    node scripts/retention-sweep.mjs --dry-run [--org id] [--limit n] [--show]
//    node scripts/retention-sweep.mjs [--org id] [--limit n] [--json]
//
//  --dry-run  report the candidates per namespace and what would happen;
//             write nothing (--show adds up to five summaries)
//  --org      one organization only
//  --limit    threads per pass (default RETENTION_SWEEP_BATCH, 50)
//  --json     machine-readable report
//
//  Rehearse on a customer database with --dry-run before the first live
//  pass. Needs migration 0013.
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { runRetentionSweep, SWEEP_BATCH } from "../backend/retention/sweep.js";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const dryRun = flag("--dry-run");
const report = await runRetentionSweep(supabase, openai, {
  dryRun, organizationId: val("--org"), limit: Number(val("--limit")) || SWEEP_BATCH, show: flag("--show"), log: null, actor: "script:retention-sweep",
});

if (flag("--json")) { console.log(JSON.stringify(report, null, 2)); process.exit(report.ready ? 0 : 2); }

if (!report.ready) { console.log("retention schema not present (migration 0013); nothing to do"); process.exit(2); }
console.log(`${dryRun ? "DRY RUN" : "SWEEP"} at ${report.ran_at}  (${report.ms} ms)\n`);
console.log("namespace".padEnd(22) + "days".padStart(5) + "  source        " + "cand".padStart(5) + "arch".padStart(5) + "fall".padStart(5) + "defer".padStart(6) + "empty".padStart(6) + "held".padStart(5) + "traces".padStart(7) + "  note");
for (const r of report.namespaces) {
  console.log(`${String(r.namespace || r.namespace_id).slice(0, 21).padEnd(22)}${String(r.days).padStart(5)}  ${r.source.padEnd(14)}${String(r.candidates).padStart(5)}${String(r.archived).padStart(5)}${String(r.fallback).padStart(5)}${String(r.deferred).padStart(6)}${String(r.deleted_empty).padStart(6)}${String(r.held).padStart(5)}${String(r.traces_scrubbed).padStart(7)}  ${r.skipped || ""}`);
}
const t = report.totals;
console.log(`\ntotals: ${t.candidates} candidates, ${t.archived} archived (${t.fallback} metadata-only), ${t.deferred} deferred, ${t.deleted_empty} empty deleted, ${t.held} held, ${t.traces_scrubbed} trace rows scrubbed, $${t.usd.toFixed(4)}`);
for (const s of report.samples) {
  console.log(`\n--- ${s.conversation_id}  ${s.title || ""}${s.fallback ? `  (metadata only: ${s.reason})` : ""}\n${s.summary_text}`);
}
