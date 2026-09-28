#!/usr/bin/env node
// =============================================================
//  Prompt-cache benchmark for the answer model (gpt-5.1).
//
//  Two tests, each answering one question about the cache:
//
//  --threads   Does a conversation's history get cached? Runs scripted
//              five-turn conversations through /api/chat on a running
//              server and reports, per turn, how much of the answer
//              call's input OpenAI served from cache. Run it against two
//              servers (before and after a change) and compare.
//                node scripts/bench-cache.mjs --threads --base http://localhost:8081 --label before
//
//  --idle      Does the cached prefix survive quiet periods? Warms the
//              real answer prompt, waits, then asks a new question, with
//              and without prompt_cache_retention. Each variant and gap
//              gets its own prefix (a nonce line first), so no request
//              warms another's cache.
//                node scripts/bench-cache.mjs --idle [--minutes 15,30] [--reps 3]
//
//  Writes eval/runs/<time>-cache-<test>[-label].json.
// =============================================================

import "../backend/lib/env.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { synthesizeFinalAnswer } from "../backend/reasoning/synthesis.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);
const MODEL = process.env.SYNTHESIS_MODEL || "gpt-5.1";
const PRICE = { input: 1.25, cached: 0.125, output: 10 };   // gpt-5.1 list, per million
const usd = (c) => ((c.input - c.cached) * PRICE.input + c.cached * PRICE.cached + c.output * PRICE.output) / 1e6;
const noCacheUsd = (c) => (c.input * PRICE.input + c.output * PRICE.output) / 1e6;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function save(test, data) {
  mkdirSync(new URL("../eval/runs/", import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = new URL(`../eval/runs/${stamp}-cache-${test}${args.label ? `-${args.label}` : ""}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), model: MODEL, ...data }, null, 2));
  console.log(`\nsaved ${file.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

// ============================================================ threads
// Each conversation opens with a note to remember, so recall has
// something to put in the MEMORY block on later turns, then asks
// follow-ups that lean on the history.
const THREADS = [
  ["Remember that the board reviews the teacher education program on November 12.",
    "What does the Teacher Education program review at Leeward cover?",
    "What are its main findings?",
    "Which of those should the board hear first on November 12?",
    "Summarize that in three bullets."],
  ["Remember that I'm preparing a vendor briefing on the Perin Health Patch.",
    "What does the Perin Health Patch measure?",
    "How accurate is it for blood pressure?",
    "What should I stress in my vendor briefing?",
    "Turn that into a short talking-points list."],
  ["Remember that we are hiring a Tier 2 service desk analyst.",
    "What experience does Brad Shimomura have?",
    "And Ariel Wilson?",
    "Which of them fits the Tier 2 analyst role better?",
    "What would you ask each of them in an interview?"],
  ["Remember that our grant deadlines are tracked by the OWDB team.",
    "What does the Empowering Foster Youth proposal ask for?",
    "How long does the project run?",
    "What risks would the OWDB team see in it?",
    "Draft two sentences for our internal grant tracker."],
];

async function threads() {
  const BASE = args.base || "http://localhost:8080";
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const envVal = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim().replace(/^"|"$/g, "");
  const golden = JSON.parse(readFileSync(new URL("../eval/golden.json", import.meta.url), "utf8"));
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: envVal("EVAL_EMAIL"), password: envVal("EVAL_PASSWORD"), namespaceId: golden.namespaceId }),
  })).json();
  if (!login.token) throw new Error(`login failed: ${login.error}`);
  const auth = { Authorization: `Bearer ${login.token}` };

  const turns = [];
  for (const [ti, script] of THREADS.entries()) {
    let conversationId = null;
    const memoryIds = [];
    for (const [i, message] of script.entries()) {
      const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ message, conversationId }) });
      const body = await res.json().catch(() => ({}));
      conversationId = body.conversationId || conversationId;
      if (body.memorySaved?.id) memoryIds.push(body.memorySaved.id);
      const syn = (body.usage?.calls || []).find((c) => c.stage === "synthesis");
      turns.push({ thread: ti + 1, turn: i + 1, mode: body.mode, memoriesUsed: body.memoriesUsed?.length ?? 0, synthesis: syn ? { input: syn.input, cached: syn.cached, output: syn.output } : null });
      console.log(`thread ${ti + 1} turn ${i + 1}  mode=${String(body.mode).padEnd(10)} mem=${body.memoriesUsed?.length ?? 0}  ${syn ? `input ${syn.input}  cached ${syn.cached} (${pct(syn.cached / syn.input)})` : "(no answer call)"}`);
    }
    // leave nothing behind
    if (conversationId) await fetch(`${BASE}/api/conversations/${conversationId}`, { method: "DELETE", headers: auth }).catch(() => {});
    for (const id of memoryIds) await fetch(`${BASE}/api/memory/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
  }

  console.log("\nturn  answer calls  cached share  $ actual   $ no cache");
  const byTurn = [];
  for (let t = 1; t <= 5; t++) {
    const calls = turns.filter((x) => x.turn === t && x.synthesis).map((x) => x.synthesis);
    if (!calls.length) continue;
    const row = { turn: t, calls: calls.length, cachedShare: sum(calls.map((c) => c.cached)) / sum(calls.map((c) => c.input)), usd: sum(calls.map(usd)), noCacheUsd: sum(calls.map(noCacheUsd)) };
    byTurn.push(row);
    console.log(`${String(t).padStart(4)}  ${String(row.calls).padStart(12)}  ${pct(row.cachedShare).padStart(12)}  $${row.usd.toFixed(4)}  $${row.noCacheUsd.toFixed(4)}`);
  }
  const later = turns.filter((x) => x.turn >= 2 && x.synthesis).map((x) => x.synthesis);
  const summary = { laterTurnsCachedShare: sum(later.map((c) => c.cached)) / sum(later.map((c) => c.input)), laterTurnsUsd: sum(later.map(usd)), laterTurnsNoCacheUsd: sum(later.map(noCacheUsd)) };
  console.log(`\nturns 2-5: ${pct(summary.laterTurnsCachedShare)} of input cached; answer cost $${summary.laterTurnsUsd.toFixed(4)} vs $${summary.laterTurnsNoCacheUsd.toFixed(4)} with no caching`);
  save("threads", { base: BASE, summary, byTurn, turns });
}

// ============================================================ idle
async function idle() {
  const minutes = String(args.minutes || "15,30").split(",").map(Number);
  const reps = Number(args.reps || 3);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // the real answer prompt, rendered without calling OpenAI
  let systemPrompt = null;
  await synthesizeFinalAnswer({
    userMessage: "x", contextWindow: "[1] placeholder", intent: "question",
    model: { chat: { completions: { create: async (req) => { systemPrompt = req.messages[0].content; return { choices: [{ message: { content: "x" } }] }; } } } },
  });
  const context = "CONTEXT WINDOW:\n[1] Leeward Community College's AST in Teacher Education requires 62 credits, including 13 credits of core education courses.\n\n";
  const ask = async (prefix, question, retention) => {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: `${prefix}\n${systemPrompt}` }, { role: "user", content: `${context}USER MESSAGE:\n${question}\nAnswer in one sentence.` }],
      temperature: 0.08,
      prompt_cache_key: `cortex-cache-bench-${prefix}`,
      ...(retention ? { prompt_cache_retention: retention } : {}),
    });
    return { input: res.usage.prompt_tokens, cached: res.usage.prompt_tokens_details?.cached_tokens || 0 };
  };

  const plan = [];
  for (const gap of minutes) for (const retention of [null, "24h"]) for (let r = 0; r < reps; r++) plan.push({ gap, retention, prefix: `run ${randomUUID()}` });
  console.log(`idle test: ${plan.length} prefixes; gaps ${minutes.join(", ")} min; ${reps} per variant; system prompt ${systemPrompt.length} chars`);
  const t0 = Date.now();
  for (const p of plan) p.warm = await ask(p.prefix, "How many credits is the AST degree?", p.retention);
  const results = [];
  for (const gap of [...minutes].sort((a, b) => a - b)) {
    const wait = t0 + gap * 60_000 - Date.now();
    if (wait > 0) { console.log(`waiting ${Math.round(wait / 60000)} min for the ${gap}-min check…`); await new Promise((r) => setTimeout(r, wait)); }
    for (const p of plan.filter((x) => x.gap === gap)) {
      p.after = await ask(p.prefix, "How many credits of core education courses are required?", p.retention);
      results.push(p);
      console.log(`  ${gap} min  retention ${String(p.retention || "default").padEnd(7)}  warm cached ${p.warm.cached}  →  after cached ${p.after.cached} of ${p.after.input}`);
    }
  }
  console.log("\ngap   retention  hits after the gap  mean cached tokens");
  const summary = [];
  for (const gap of minutes) for (const retention of [null, "24h"]) {
    const rs = results.filter((p) => p.gap === gap && p.retention === retention);
    const row = { gap, retention: retention || "default", hits: rs.filter((p) => p.after.cached > 0).length, n: rs.length, meanCached: Math.round(sum(rs.map((p) => p.after.cached)) / rs.length) };
    summary.push(row);
    console.log(`${String(gap).padStart(3)}m  ${row.retention.padEnd(9)}  ${row.hits}/${row.n}${" ".repeat(16)}${row.meanCached}`);
  }
  save("idle", { summary, results: results.map(({ prefix, ...r }) => r) });
}

if (args.threads === "true") await threads();
else if (args.idle === "true") await idle();
else { console.error("usage: node scripts/bench-cache.mjs --threads --base URL [--label x] | --idle [--minutes 15,30] [--reps 3]"); process.exit(1); }
