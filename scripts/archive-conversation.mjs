#!/usr/bin/env node
// =============================================================
//  Archive one conversation by hand, or see what the archive would
//  say (retention plan P2.4). Service key + OpenAI, no login.
//
//    node scripts/archive-conversation.mjs --list [n]          newest n threads (default 15)
//    node scripts/archive-conversation.mjs <id> --dry-run      print the record, write nothing
//    node scripts/archive-conversation.mjs <id>                archive for real
//    node scripts/archive-conversation.mjs <id> --json         machine-readable output
//
//  A real run summarises the thread, inserts the archive, deletes the
//  messages and running summary, stamps its memories, scrubs its trace
//  text and logs a conversation_archived event. It refuses held and
//  already-archived threads. Needs migration 0013.
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { archiveConversation } from "../backend/retention/archive.js";
import { newUsage, usageSummary } from "../backend/lib/usage.js";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

if (flag("--list")) {
  const n = Number(args[args.indexOf("--list") + 1]) || 15;
  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, message_count, last_message_at, archived_at, legal_hold, namespace:namespace_id(name), owner:user_id(email)")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(n);
  if (error) { console.error(error.message); process.exit(1); }
  for (const c of data) {
    const state = c.archived_at ? "archived" : c.legal_hold ? "held" : "active";
    console.log(`${c.id}  ${String(c.last_message_at || "").slice(0, 10)}  ${String(c.message_count).padStart(3)} msgs  ${state.padEnd(8)}  ${c.namespace?.name || ""} / ${c.owner?.email || ""}  ${(c.title || "").slice(0, 60)}`);
  }
  process.exit(0);
}

const id = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));
if (!id) { console.error("usage: node scripts/archive-conversation.mjs <conversation id> [--dry-run] [--json] | --list [n]"); process.exit(1); }

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const usage = newUsage();
const dryRun = flag("--dry-run");
const t0 = Date.now();
const result = await archiveConversation(supabase, openai, id, { dryRun, usage, log: flag("--json") ? null : console, actor: "script:archive-conversation" });
const cost = usageSummary(usage);

if (flag("--json")) {
  console.log(JSON.stringify({ ...result, usage: cost, ms: Date.now() - t0 }, null, 2));
  process.exit(["archived", "dry_run"].includes(result.status) ? 0 : 2);
}

console.log(`\n${dryRun ? "DRY RUN" : "RESULT"}: ${result.status}${result.fallback ? ` (metadata only: ${result.reason})` : ""}`);
if (result.status === "held") console.log(`hold: ${result.hold.scope}${result.hold.reason ? ` — ${result.hold.reason}` : ""}`);
if (result.status === "deferred") console.log(`attempt ${result.attempts}: ${result.error}`);
if (result.archive) {
  console.log(`\n--- summary_text (${result.summaryText.length} chars) ---\n${result.summaryText}`);
  console.log(`\n--- record ---\n${JSON.stringify(result.archive, null, 2)}`);
  if (result.input) console.log(`\ninput: ${result.input.turns} turns, ${result.input.chars} chars${result.input.omitted ? `, ${result.input.omitted} omitted` : ""}`);
}
if (result.status === "archived") console.log(`\nremoved ${result.messages} messages, scrubbed ${result.tracesScrubbed} trace rows`);
console.log(`model: ${result.model || "(none)"}  cost: $${(cost?.usd ?? 0).toFixed(4)}  ${Date.now() - t0} ms`);
process.exit(["archived", "dry_run"].includes(result.status) ? 0 : 2);
