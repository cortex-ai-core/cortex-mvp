#!/usr/bin/env node
// =============================================================
//  Decision benchmark (docs/KEV_PROTOTYPE.md §4.1): today's way of
//  making each decision against the System One decision model (Kev, or
//  Jev at SYSTEMONE_URL), on labelled sets in eval/decisions/.
//
//    node scripts/bench-decisions.mjs [--task intent|named_doc|relation|extract_gate|doctype|all]
//                                     [--backends openai,kev,rules,hybrid] [--repeat 1]
//                                     [--gpu-usd-hour 1.95] [--jev-usd-mtok 0.042] [--ids a,b]
//
//  No server needed. Reads Cortex-Dev2 (named_doc, doctype) and calls
//  OpenAI (openai backend, embeddings). Items run one at a time, so the
//  latencies are single-request latencies; the first item of each
//  backend runs once untimed to warm up.
//
//  Per backend: accuracy per field; for intent, route accuracy (does the
//  answer mode come out the same, computed as chat.js does); latency
//  p50/p95/mean; cost per 1,000 decisions. For the decision model also
//  calibration (Brier, ECE) and an escalation curve: how much it would
//  decide on its own at each confidence threshold, and the blended
//  accuracy, latency and cost when the rest go to the chat model.
//  Writes eval/runs/<time>-decisions-<task>.json.
// =============================================================

import "../backend/lib/env.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { classifyWithChatModel, classifyWithDecisionModel, decodeIntentByRules } from "../backend/reasoning/intent.js";
import { kevIntent } from "../backend/decisions/intent.js";
import { kevNamedDocument } from "../backend/decisions/namedDoc.js";
import { kevRelation, kevExtractGate } from "../backend/decisions/memory.js";
import { kevDocType, docTypeState } from "../backend/decisions/docType.js";
import { findNamedDocuments, normalizeRetrievalQuery } from "../backend/routes/retrieve.js";
import { SYSTEM as EXTRACT_SYSTEM, SCHEMA as EXTRACT_SCHEMA, RELATION_SYSTEM, RELATION_SCHEMA, groundedInUserMessage, statementsOf } from "../backend/memory/extract.js";
import { costOf } from "../backend/lib/usage.js";

// ------------------------------------------------------------ args
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);
const TASKS = ["intent", "named_doc", "relation", "extract_gate", "doctype"];
const task = args.task || "intent";
const REPEAT = Math.max(1, Number(args.repeat || 1));
const GPU_USD_HOUR = Number(args["gpu-usd-hour"] || 1.95);   // L40S list price, Kev's README
const JEV_USD_MTOK = Number(args["jev-usd-mtok"] || 0.042);
const IDS = args.ids ? new Set(String(args.ids).split(",")) : null;
// the bench waits for Kev; production gives up after DECISIONS_TIMEOUT_MS
const PROD_TIMEOUT = Number(process.env.DECISIONS_TIMEOUT_MS || 800);
process.env.DECISIONS_TIMEOUT_MS = "30000";
const KEV_TIMEOUT = 30000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const CHAT_MODEL = process.env.INTENT_MODEL || "gpt-5-mini";
const EXTRACT_MODEL = process.env.MEMORY_EXTRACT_MODEL || "gpt-5-mini";
const gpt5 = (m) => /^gpt-5/.test(m);

// ------------------------------------------------------------ stats
const quantile = (xs, q) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
};
const mean = (xs) => { const s = xs.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const pct = (x) => (x == null ? "  –  " : `${(x * 100).toFixed(1)}%`.padStart(6));
const ms = (x) => (x == null ? "–" : `${Math.round(x)}`);
const usd = (x) => (x == null ? "–" : `$${x.toFixed(4)}`);
const rate = (rows, f) => { const r = rows.filter((x) => f(x) !== null && f(x) !== undefined); return r.length ? r.filter((x) => f(x) === true).length / r.length : null; };

function latencyOf(rows) {
  const xs = rows.map((r) => r.ms);
  return { p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), mean: mean(xs) };
}

/** Cost per 1,000 decisions, three ways for the decision model. */
function costPer1k(rows, backend) {
  if (backend === "rules" || backend === "lead_rule") return { usd: 0 };
  const chat = mean(rows.map((r) => r.usd ?? 0));
  if (backend === "openai") return { usd: chat == null ? null : chat * 1000 };
  const kevSec = mean(rows.map((r) => (r.kevMs ?? r.ms) / 1000));
  const tokens = mean(rows.map((r) => r.tokens || 0));
  return {
    usd: chat == null ? null : chat * 1000,                                           // chat-model calls a hybrid still makes
    gpu: kevSec == null ? null : (GPU_USD_HOUR * kevSec * 1000) / 3600,               // self-hosted, GPU fully busy
    jev: tokens == null ? null : (tokens * JEV_USD_MTOK * 1000) / 1e6,                // hosted Jev at list price
  };
}

/** Brier score (multi-class) and 10-bin ECE on the top choice's probability. */
function calibration(rows) {
  const scored = rows.filter((r) => r.probs && r.label != null);
  if (!scored.length) return null;
  const brier = mean(scored.map((r) => Object.entries(r.probs).reduce((a, [k, p]) => a + (p - (k === r.label ? 1 : 0)) ** 2, 0)));
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));
  for (const r of scored) {
    const top = Math.max(...Object.values(r.probs));
    const b = bins[Math.min(9, Math.floor(top * 10))];
    b.n++; b.conf += top; b.hit += r.ok ? 1 : 0;
  }
  const ece = bins.reduce((a, b) => a + (b.n ? (b.n / scored.length) * Math.abs(b.hit / b.n - b.conf / b.n) : 0), 0);
  return { brier: round(brier), ece: round(ece), n: scored.length };
}
const round = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/**
 * The decision model decides when its confidence reaches t, the chat
 * model otherwise: coverage, accuracy on what it kept, blended accuracy,
 * mean latency and chat-model cost per 1,000, from the two backends'
 * per-item results (same items, same order).
 */
function escalationCurve(kevRows, llmRows, okKey = "ok", confKey = "conf") {
  const llmById = new Map(llmRows.map((r) => [r.id, r]));
  return [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => {
    let kept = 0, keptOk = 0, ok = 0, lat = 0, cost = 0, n = 0;
    for (const k of kevRows) {
      const l = llmById.get(k.id);
      if (!l) continue;
      n++;
      if ((k[confKey] ?? 0) >= t) { kept++; keptOk += k[okKey] ? 1 : 0; ok += k[okKey] ? 1 : 0; lat += k.ms; }
      else { ok += l[okKey] ? 1 : 0; lat += k.ms + l.ms; cost += l.usd || 0; }
    }
    return { threshold: t, coverage: n ? kept / n : null, keptAccuracy: kept ? keptOk / kept : null, blendedAccuracy: n ? ok / n : null, meanMs: n ? lat / n : null, chatUsdPer1k: n ? (cost / n) * 1000 : null };
  });
}

function printCurve(curve, label) {
  console.log(`\n  escalation curve (${label}): decision model keeps an item when its confidence ≥ threshold`);
  console.log("  threshold  kept   acc(kept)  blended acc  mean ms  chat $/1k");
  for (const c of curve) {
    console.log(`  ${c.threshold.toFixed(1).padStart(9)}  ${pct(c.coverage)}  ${pct(c.keptAccuracy).padStart(9)}  ${pct(c.blendedAccuracy).padStart(11)}  ${ms(c.meanMs).padStart(7)}  ${usd(c.chatUsdPer1k).padStart(9)}`);
  }
}

/** Run fn over items with a warm-up call, REPEAT times; one row per item per pass. */
async function runBackend(name, items, fn) {
  const rows = [];
  if (items.length) { try { await fn(items[0]); } catch { /* warm-up only */ } }
  for (let pass = 0; pass < REPEAT; pass++) {
    for (const item of items) {
      const t0 = Date.now();
      let row;
      try { row = await fn(item); } catch (err) { row = { error: err?.message }; }
      rows.push({ id: item.id, pass, ms: row?.ms ?? Date.now() - t0, ...row });
    }
    process.stdout.write(`  ${name}: pass ${pass + 1}/${REPEAT} done\n`);
  }
  return rows;
}

function summaryTable(results, fields) {
  const head = ["backend".padEnd(10), ...fields.map((f) => f.label.padStart(9)), "p50 ms".padStart(7), "p95 ms".padStart(7), "mean ms".padStart(8), "$/1k".padStart(9), "GPU $/1k".padStart(9), "Jev $/1k".padStart(9)];
  console.log("\n" + head.join(" "));
  for (const [name, r] of Object.entries(results)) {
    const lat = r.latency, c = r.cost || {};
    console.log([name.padEnd(10), ...fields.map((f) => pct(r.accuracy[f.key]).padStart(9)), ms(lat.p50).padStart(7), ms(lat.p95).padStart(7), ms(lat.mean).padStart(8), usd(c.usd).padStart(9), usd(c.gpu).padStart(9), usd(c.jev).padStart(9)].join(" "));
  }
}

const loadSet = (file) => JSON.parse(readFileSync(new URL(`../eval/decisions/${file}`, import.meta.url), "utf8"));
const pick = (items) => (IDS ? items.filter((i) => IDS.has(i.id)) : items);

// ============================================================ intent
// The answer mode chat.js takes (priorityFromIntent plus the knowledge-
// base and whole-document modes): what a wrong label actually costs.
function routeOf(type, scope, ev, att = false) {
  if (type === "remember") return "MEMORY";
  if (type === "literal") return "NONE";
  switch (scope) {
    case "knowledge_base": return "KB";
    case "document": return "DOC";
    case "documents": return "HIGH";
    case "attached": return ev ? "LOW" : "NONE";
    case "none": return "NONE";
    default: return ev ? (["question", "lookup", "summary", "analysis", "compare"].includes(type) ? "HIGH" : "MEDIUM") : (att ? "NONE" : "LOW");
  }
}
function goldRoutes(it) {
  const types = [it.type, ...(it.alt?.type || [])];
  const scopes = [it.scope, ...(it.alt?.scope || [])];
  const evs = it.ev === undefined ? [true, false] : [it.ev];
  const out = new Set();
  for (const t of types) for (const s of scopes) for (const e of evs) out.add(routeOf(t, s, e, it.att));
  return out;
}
function scoreIntent(it, got) {
  const types = [it.type, ...(it.alt?.type || [])];
  const scopes = [it.scope, ...(it.alt?.scope || [])];
  return {
    typeOk: types.includes(got.type),
    scopeOk: scopes.includes(got.scope),
    evOk: it.ev === undefined ? null : got.ev === it.ev,
    routeOk: goldRoutes(it).has(routeOf(got.type, got.scope, got.ev, it.att)),
    followOk: it.follow === undefined || got.follow === null || got.follow === undefined ? null : got.follow === it.follow,
    got: `${got.type}/${got.scope}${got.ev ? "*" : ""}`,
  };
}
const contextOf = (it) => (it.ctx ? { lastUser: it.ctx.lastUser, lastAssistant: "", lastAssistantDocs: it.ctx.docs || [] } : null);

async function benchIntent() {
  const set = pick(loadSet("intent.json").items);
  const backends = (args.backends || "openai,kev,rules,hybrid").split(",");
  const results = {};
  const rows = {};

  if (backends.includes("rules")) {
    rows.rules = await runBackend("rules", set, async (it) => {
      const t0 = performance.now();
      const r = decodeIntentByRules(it.m, { hasAttachment: Boolean(it.att) });
      const t = performance.now() - t0;
      return { ms: t, ...scoreIntent(it, { type: r.type, scope: r.scope, ev: r.needsEvidence, follow: null }) };
    });
  }
  if (backends.includes("openai")) {
    rows.openai = await runBackend("openai", set, async (it) => {
      const t0 = Date.now();
      const r = await classifyWithChatModel(it.m, { openai, hasAttachment: Boolean(it.att), context: contextOf(it), rules: decodeIntentByRules(it.m, { hasAttachment: Boolean(it.att) }) });
      const t = Date.now() - t0;
      const cost = (r.usage || []).reduce((a, u) => a + (costOf(u.model, u.prompt_tokens, u.completion_tokens, u.prompt_tokens_details?.cached_tokens) || 0), 0);
      const follow = it.ctx ? r.standaloneQuery.trim() !== it.m.trim() : null;
      return { ms: t, usd: cost, source: r.source, ...scoreIntent(it, { type: r.type, scope: r.scope, ev: r.needsEvidence, follow }) };
    });
  }
  if (backends.includes("kev")) {
    rows.kev = await runBackend("kev", set, async (it) => {
      const t0 = Date.now();
      const r = await kevIntent(it.m, { hasAttachment: Boolean(it.att), context: contextOf(it), timeoutMs: KEV_TIMEOUT });
      if (!r) return { ms: Date.now() - t0, error: "kev unavailable", typeOk: false, scopeOk: false, routeOk: false };
      const s = scoreIntent(it, { type: r.fields.type, scope: r.fields.scope, ev: r.fields.needs_evidence, follow: r.followUp == null ? null : r.followUp >= 0.5 });
      return {
        ms: r.ms, kevMs: r.modelMs, tokens: r.inputTokens, usd: 0, ...s,
        conf: Math.min(r.confidence.type ?? 0, r.confidence.scope ?? 0),
        typeConf: r.confidence.type, scopeConf: r.confidence.scope,
        overProdTimeout: r.ms > PROD_TIMEOUT,
        remember: r.fields.type === "remember",
      };
    });
  }
  if (backends.includes("hybrid")) {
    // the "on" path for real: Kev, the rewrite when it says follow-up, the
    // chat model on escalation (DECISIONS_INTENT_MIN_CONF, default 0.5)
    rows.hybrid = await runBackend("hybrid", set, async (it) => {
      const t0 = Date.now();
      const hasAttachment = Boolean(it.att);
      const d = await classifyWithDecisionModel(it.m, { openai, hasAttachment, context: contextOf(it) });
      let r = d.intent;
      if (!r) r = await classifyWithChatModel(it.m, { openai, hasAttachment, context: contextOf(it), rules: decodeIntentByRules(it.m, { hasAttachment }) });
      const t = Date.now() - t0;
      const usage = [...(d.intent ? [] : (r.usage || [])), ...(d.intent?.usage || [])];
      const cost = usage.reduce((a, u) => a + (costOf(u.model, u.prompt_tokens ?? u.input_tokens, u.completion_tokens ?? 0, u.prompt_tokens_details?.cached_tokens) || 0), 0);
      const follow = it.ctx ? r.standaloneQuery.trim() !== it.m.trim() : null;
      return { ms: t, usd: cost, tokens: d.kev?.inputTokens, escalated: d.escalated, ...scoreIntent(it, { type: r.type, scope: r.scope, ev: r.needsEvidence, follow }) };
    });
  }

  for (const [name, r] of Object.entries(rows)) {
    results[name] = {
      accuracy: { type: rate(r, (x) => x.typeOk), scope: rate(r, (x) => x.scopeOk), ev: rate(r, (x) => x.evOk), route: rate(r, (x) => x.routeOk), follow: rate(r, (x) => x.followOk) },
      latency: latencyOf(r),
      cost: costPer1k(r, name === "hybrid" ? "kev" : name),
      ...(name === "hybrid" ? { escalated: rate(r, (x) => (x.escalated ? true : false)), escalatedWhy: countBy(r, (x) => x.escalated || "kept") } : {}),
      ...(name === "kev" ? { overProdTimeout: rate(r, (x) => x.overProdTimeout), unavailable: r.filter((x) => x.error).length } : {}),
    };
  }
  console.log(`\nintent: ${set.length} messages × ${REPEAT} pass(es); route = the answer mode chat.js would take`);
  summaryTable(results, [{ key: "type", label: "type" }, { key: "scope", label: "scope" }, { key: "ev", label: "evidence" }, { key: "route", label: "route" }, { key: "follow", label: "follow-up" }]);
  if (results.kev) console.log(`\n  Kev calls over the production timeout (${PROD_TIMEOUT} ms): ${pct(results.kev.overProdTimeout)}`);
  if (results.hybrid) console.log(`  hybrid escalations: ${JSON.stringify(results.hybrid.escalatedWhy)}`);

  if (rows.kev && rows.openai) {
    const curveRoute = escalationCurve(rows.kev.filter((r) => r.pass === 0 && !r.remember), rows.openai.filter((r) => r.pass === 0), "routeOk");
    printCurve(curveRoute, "route accuracy, remember turns excluded: they always escalate");
    results.kev.escalationCurve = curveRoute;
    results.kev.agreementWithOpenai = agreement(rows.kev, rows.openai);
    console.log(`\n  Kev agrees with ${CHAT_MODEL} on route: ${pct(results.kev.agreementWithOpenai)}`);
    // calibration of the confidence Kev states for the route it picks
    results.kev.calibration = calibration(rows.kev.filter((r) => r.pass === 0).map((r) => ({ probs: { yes: r.conf, no: 1 - r.conf }, label: r.routeOk ? "yes" : "no", ok: r.routeOk })));
    console.log(`  calibration of min(type, scope) confidence against route correctness: ${JSON.stringify(results.kev.calibration)}`);
  }
  misses(rows, set, (x) => !x.routeOk, (it) => `${it.type}/${it.scope}${it.ev ? "*" : ""}`);
  return { task: "intent", n: set.length, results, rows };
}

function agreement(a, b) {
  const byId = new Map(b.filter((r) => r.pass === 0).map((r) => [r.id, r]));
  const pairs = a.filter((r) => r.pass === 0 && byId.has(r.id));
  return pairs.length ? pairs.filter((r) => r.got === byId.get(r.id).got || (r.routeOk === byId.get(r.id).routeOk && r.routeOk)).length / pairs.length : null;
}

function countBy(rows, f) {
  const out = {};
  for (const r of rows) { const k = f(r); out[k] = (out[k] || 0) + 1; }
  return out;
}

function misses(rows, set, isMiss, gold) {
  const byId = new Map(set.map((it) => [it.id, it]));
  console.log("\n  misses (first pass):");
  for (const [name, r] of Object.entries(rows)) {
    const m = r.filter((x) => x.pass === 0 && isMiss(x));
    if (!m.length) continue;
    console.log(`  ${name}: ${m.map((x) => `${x.id} ${x.got ?? "?"} (want ${gold(byId.get(x.id))})`).join("; ")}`);
  }
}

// ============================================================ named_doc
async function benchNamedDoc() {
  const setFile = loadSet("named-doc.json");
  const set = pick(setFile.items);
  const ns = setFile.namespaceId;
  const { data: docs } = await supabase.from("documents").select("id, file_name, display_name, status").eq("namespace_id", ns);
  const ready = (docs || []).filter((d) => !d.status || d.status === "ready");
  const LEAD_MIN = Number(process.env.DOC_LEAD_MIN || 0.45), LEAD_MARGIN = Number(process.env.DOC_LEAD_MARGIN || 0.06);
  const minP = Number(process.env.DECISIONS_NAMED_DOC_MIN_P || 0.6);

  // shared inputs, computed once: what retrieval has before the decision
  const inputs = new Map();
  for (const it of set) {
    const q = normalizeRetrievalQuery(it.q);
    const e = await openai.embeddings.create({ model: "text-embedding-3-small", input: q });
    const { data: scores } = await supabase.rpc("match_document_profiles", { query_embedding: e.data[0].embedding, query_namespace_id: ns, match_count: 10 });
    inputs.set(it.id, { scores: scores || [], regex: findNamedDocuments(ready, it.q) });
  }
  const verdict = (named) => (named.length === 0 ? "none" : named.length === 1 ? named[0] : "several");
  const okFor = (it, v) => {
    const accept = [it.doc, ...(it.alt || [])];
    return accept.some((a) => (a === "none" || a === "several" ? v === a : typeof v === "object" && v && String(v.file_name).toLowerCase().includes(a.toLowerCase())));
  };
  const show = (v) => (typeof v === "string" ? v : v?.file_name || "?");
  const unionOf = (regex, extra) => { const out = [...regex]; if (extra && !out.some((d) => d.id === extra.id)) out.push(extra); return out; };

  const rows = {};
  rows.lead_rule = await runBackend("lead_rule", set, async (it) => {
    const t0 = performance.now();
    const { scores, regex } = inputs.get(it.id);
    const [lead, run] = scores;
    const semantic = lead && lead.similarity >= LEAD_MIN && (!run || lead.similarity - run.similarity >= LEAD_MARGIN) ? lead : null;
    const v = verdict(unionOf(regex, semantic));
    return { ms: performance.now() - t0, ok: okFor(it, v), got: show(v), semanticOnly: okFor(it, semantic ? semantic : "none") };
  });
  rows.kev = await runBackend("kev", set, async (it) => {
    const { scores, regex } = inputs.get(it.id);
    const k = await kevNamedDocument(it.q, scores, { timeoutMs: KEV_TIMEOUT });
    if (!k) return { ms: 0, ok: false, got: "error", error: "kev unavailable" };
    const pick = k.kind === "doc" && (k.p ?? 0) >= minP ? k.doc : null;
    const v = verdict(unionOf(regex, pick));
    const alone = k.kind === "doc" ? k.doc : k.kind;
    return { ms: k.ms, tokens: k.inputTokens, ok: okFor(it, v), got: show(v), conf: k.confidence, aloneOk: okFor(it, alone), aloneGot: show(alone), semanticOnly: okFor(it, pick || (k.kind === "several" ? "several" : "none")) };
  });
  const results = {};
  for (const [name, r] of Object.entries(rows)) {
    results[name] = { accuracy: { named: rate(r, (x) => x.ok), semantic: rate(r, (x) => x.semanticOnly), ...(name === "kev" ? { alone: rate(r, (x) => x.aloneOk) } : {}) }, latency: latencyOf(r), cost: costPer1k(r, name) };
  }
  console.log(`\nnamed document: ${set.length} questions, ${ready.length} documents. named = regex matcher + the semantic pick, as retrieval uses them; semantic = the pick alone; alone = Kev's answer with no regex (incl. none/several)`);
  summaryTable(results, [{ key: "named", label: "named" }, { key: "semantic", label: "semantic" }, { key: "alone", label: "kev alone" }]);
  console.log("  (lead_rule costs nothing extra: it reads the similarities retrieval already has. Kev's latency is added to retrieval.)");
  misses(rows, set, (x) => !x.ok, (it) => it.doc);
  return { task: "named_doc", n: set.length, results, rows };
}

// ============================================================ relation
async function benchRelation() {
  const set = pick(loadSet("relation.json").items);
  const asMemories = (it) => it.existing.map((c, i) => ({ id: `m${i + 1}`, content: c }));
  const okFor = (it, relation, targetIdx) => {
    const accept = [[it.label, it.target], ...(it.alt || [])];
    return accept.some(([l, t]) => l === relation && (l === "unrelated" || t === targetIdx));
  };
  const idx = (id) => (id ? Number(String(id).replace(/^m/, "")) : null);
  const rows = {};
  rows.openai = await runBackend("openai", set, async (it) => {
    const t0 = Date.now();
    const mems = asMemories(it);
    const res = await openai.chat.completions.create({
      model: EXTRACT_MODEL,
      messages: [{ role: "system", content: RELATION_SYSTEM }, { role: "user", content: `NEW NOTE:\n${it.note}\n\nEXISTING MEMORIES (id · content):\n${mems.map((m) => `- ${m.id} · ${m.content}`).join("\n")}` }],
      response_format: { type: "json_schema", json_schema: RELATION_SCHEMA },
      ...(gpt5(EXTRACT_MODEL) ? { reasoning_effort: process.env.MEMORY_EXTRACT_EFFORT || "low", verbosity: "low" } : { temperature: 0 }),
    });
    const t = Date.now() - t0;
    const p = JSON.parse(res.choices[0].message.content || "{}");
    const target = mems.some((m) => m.id === p.target) ? p.target : null;
    const relation = ["same", "different_value"].includes(p.relation) && target ? p.relation : "unrelated";
    return { ms: t, usd: costOf(EXTRACT_MODEL, res.usage?.prompt_tokens, res.usage?.completion_tokens, res.usage?.prompt_tokens_details?.cached_tokens), ok: okFor(it, relation, idx(target)), got: `${relation}${target ? ":" + idx(target) : ""}` };
  });
  rows.kev = await runBackend("kev", set, async (it) => {
    const k = await kevRelation(it.note, asMemories(it), { timeoutMs: KEV_TIMEOUT });
    if (!k) return { ms: 0, ok: false, got: "error", error: "kev unavailable" };
    return { ms: k.ms, tokens: k.inputTokens, usd: 0, ok: okFor(it, k.relation, idx(k.targetId)), got: `${k.relation}${k.targetId ? ":" + idx(k.targetId) : ""}`, conf: k.confidence };
  });
  const results = {};
  for (const [name, r] of Object.entries(rows)) results[name] = { accuracy: { relation: rate(r, (x) => x.ok) }, latency: latencyOf(r), cost: costPer1k(r, name) };
  console.log(`\nmemory relation: ${set.length} cases (relation and target must both be right)`);
  summaryTable(results, [{ key: "relation", label: "relation" }]);
  const curve = escalationCurve(rows.kev.filter((r) => r.pass === 0), rows.openai.filter((r) => r.pass === 0));
  printCurve(curve, "relation accuracy");
  results.kev.escalationCurve = curve;
  misses(rows, set, (x) => !x.ok, (it) => `${it.label}${it.target ? ":" + it.target : ""}`);
  return { task: "relation", n: set.length, results, rows };
}

// ============================================================ extract_gate
const EPHEMERAL = /\b(this (morning|afternoon|evening)|today|tonight|right now|at the moment|for now|just now)\b/i;
async function benchExtractGate() {
  const set = pick(loadSet("extract-gate.json").items);
  const minP = Number(process.env.DECISIONS_EXTRACT_GATE_MIN_P || 0.25);
  const okFor = (it, keep) => [it.keep, ...(it.alt || [])].includes(keep);
  const rows = {};
  // today: every message that is not only questions goes to the extraction
  // call; what it keeps after the code's own filters is the outcome
  rows.openai = await runBackend("openai", set, async (it) => {
    const t0 = Date.now();
    const res = await openai.chat.completions.create({
      model: EXTRACT_MODEL,
      messages: [{ role: "system", content: EXTRACT_SYSTEM }, { role: "user", content: `EXISTING MEMORIES (id · content):\n(none)\n\nUSER MESSAGE:\n${it.m}\n\nASSISTANT ANSWER (context only; never a source of notes):\n(none)` }],
      response_format: { type: "json_schema", json_schema: EXTRACT_SCHEMA },
      ...(gpt5(EXTRACT_MODEL) ? { reasoning_effort: process.env.MEMORY_EXTRACT_EFFORT || "low", verbosity: "low" } : { temperature: 0 }),
    });
    const t = Date.now() - t0;
    const items = JSON.parse(res.choices[0].message.content || "{}").memories || [];
    const said = statementsOf(it.m);
    const kept = items.filter((m) => Math.round(Number(m.importance) || 0) >= 3 && groundedInUserMessage(m.content, said) && !EPHEMERAL.test(m.content));
    const keep = kept.length > 0;
    return { ms: t, usd: costOf(EXTRACT_MODEL, res.usage?.prompt_tokens, res.usage?.completion_tokens, res.usage?.prompt_tokens_details?.cached_tokens), keep, ok: okFor(it, keep), got: String(keep) };
  });
  rows.kev = await runBackend("kev", set, async (it) => {
    const g = await kevExtractGate(it.m, { timeoutMs: KEV_TIMEOUT });
    if (!g) return { ms: 0, ok: false, got: "error", error: "kev unavailable" };
    const keep = g.p >= minP;
    return { ms: g.ms, tokens: g.inputTokens, usd: 0, p: g.p, keep, ok: okFor(it, keep), got: `${keep} (p=${g.p.toFixed(2)})` };
  });
  const results = {};
  for (const [name, r] of Object.entries(rows)) {
    results[name] = {
      accuracy: {
        agree: rate(r, (x) => x.ok),
        recall: rate(r.filter((x) => set.find((i) => i.id === x.id).keep), (x) => x.keep),
        skip: rate(r.filter((x) => !set.find((i) => i.id === x.id).keep), (x) => !x.keep),
      },
      latency: latencyOf(r),
      cost: costPer1k(r, name),
    };
  }
  console.log(`\nextraction gate: ${set.length} messages. recall = share of worth-keeping messages let through (must stay ~100%); skip = share of the rest that the extraction call would no longer see. The openai row is today's extraction call itself: its latency and cost are what the gate saves on each skip.`);
  summaryTable(results, [{ key: "agree", label: "correct" }, { key: "recall", label: "recall" }, { key: "skip", label: "skip" }]);
  // threshold sweep for the gate
  const kev = rows.kev.filter((r) => r.pass === 0 && Number.isFinite(r.p));
  const extractUsd = mean(rows.openai.map((r) => r.usd)), extractMs = mean(rows.openai.map((r) => r.ms));
  console.log("\n  gate threshold sweep: min p   recall   skip   extraction calls saved per 1,000 turns that reach extraction ($ at today's extraction cost)");
  results.kev.sweep = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5].map((t) => {
    const pos = kev.filter((r) => set.find((i) => i.id === r.id).keep);
    const neg = kev.filter((r) => !set.find((i) => i.id === r.id).keep);
    const recall = pos.length ? pos.filter((r) => r.p >= t).length / pos.length : null;
    const skipped = kev.filter((r) => r.p < t).length / kev.length;
    const row = { threshold: t, recall, skip: neg.length ? neg.filter((r) => r.p < t).length / neg.length : null, savedPer1k: skipped * 1000, savedUsdPer1k: skipped * 1000 * (extractUsd || 0), savedSecPer1k: skipped * 1000 * (extractMs || 0) / 1000 };
    console.log(`  ${t.toFixed(2).padStart(28)}  ${pct(row.recall)}  ${pct(row.skip)}  ${Math.round(row.savedPer1k)} calls, ${usd(row.savedUsdPer1k)}, ${Math.round(row.savedSecPer1k)} s of model time`);
    return row;
  });
  misses(rows, set, (x) => !x.ok, (it) => String(it.keep));
  return { task: "extract_gate", n: set.length, results, rows };
}

// ============================================================ doctype
async function benchDocType() {
  const setFile = loadSet("doctype.json");
  const set = pick(setFile.items.map((it, i) => ({ ...it, id: it.id || `dt${String(i + 1).padStart(2, "0")}` })));
  const { data: types } = await supabase.from("document_types").select("name, description").eq("organization_id", setFile.organizationId);
  const autoP = Number(process.env.DECISIONS_DOCTYPE_AUTO_P || 0.85);
  // each document's state, once: name, ingest summary, first sections
  const states = new Map();
  for (const it of set) {
    const { data: docs } = await supabase.from("documents").select("id, file_name, metadata, namespace_id").eq("file_name", it.file).in("namespace_id", it.namespace ? [it.namespace] : setFile.namespaces).limit(1);
    const d = docs?.[0];
    if (!d) { states.set(it.id, null); continue; }
    const { data: chunks } = await supabase.from("document_chunks").select("content").eq("document_id", d.id).order("chunk_index").limit(3);
    states.set(it.id, docTypeState({ fileName: d.file_name, summary: d.metadata?.ingest?.summary || null, markdown: (chunks || []).map((c) => c.content).join("\n") }));
  }
  const present = set.filter((it) => states.get(it.id));
  const okFor = (it, name) => [it.type, ...(it.alt || [])].includes(name || "General");
  const rows = {};
  rows.majority = await runBackend("majority", present, async (it) => ({ ms: 0, ok: okFor(it, "General"), got: "General" }));
  rows.openai = await runBackend("openai", present, async (it) => {
    const t0 = Date.now();
    const names = [...types.map((t) => t.name), "other"];
    const res = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: `Classify the document into one of the organization's document types. Types:\n${types.map((t) => `- ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")}\n- other: none of these fits\nReturn JSON only.` },
        { role: "user", content: JSON.stringify(states.get(it.id)) },
      ],
      response_format: { type: "json_schema", json_schema: { name: "doc_type", strict: true, schema: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", enum: names } } } } },
      ...(gpt5(CHAT_MODEL) ? { reasoning_effort: "minimal", verbosity: "low" } : { temperature: 0 }),
    });
    const t = Date.now() - t0;
    const name = JSON.parse(res.choices[0].message.content || "{}").type;
    const got = name === "other" ? null : name;
    return { ms: t, usd: costOf(CHAT_MODEL, res.usage?.prompt_tokens, res.usage?.completion_tokens, res.usage?.prompt_tokens_details?.cached_tokens), ok: okFor(it, got), got: got || "other" };
  });
  rows.kev = await runBackend("kev", present, async (it) => {
    const k = await kevDocType(states.get(it.id), types, { timeoutMs: KEV_TIMEOUT });
    if (!k) return { ms: 0, ok: false, got: "error", error: "kev unavailable" };
    return { ms: k.ms, tokens: k.inputTokens, usd: 0, ok: okFor(it, k.name), got: `${k.name || "other"} (p=${(k.p ?? 0).toFixed(2)})`, p: k.p, conf: k.confidence, auto: (k.p ?? 0) >= autoP && Boolean(k.name) };
  });
  const results = {};
  for (const [name, r] of Object.entries(rows)) results[name] = { accuracy: { type: rate(r, (x) => x.ok) }, latency: latencyOf(r), cost: costPer1k(r, name) };
  const auto = rows.kev.filter((r) => r.pass === 0 && r.auto);
  results.kev.autoApply = { threshold: autoP, coverage: auto.length / present.length, precision: auto.length ? auto.filter((r) => r.ok).length / auto.length : null };
  console.log(`\ndocument type: ${present.length} documents (${set.length - present.length} not found), types: ${types.map((t) => t.name).join(", ")} + other (= General)`);
  summaryTable(results, [{ key: "type", label: "type" }]);
  console.log(`\n  auto-apply at p ≥ ${autoP}: ${pct(results.kev.autoApply.coverage)} of documents, ${pct(results.kev.autoApply.precision)} of them right`);
  misses(rows, present, (x) => !x.ok, (it) => it.type);
  return { task: "doctype", n: present.length, results, rows };
}

// ============================================================ main
const RUNNERS = { intent: benchIntent, named_doc: benchNamedDoc, relation: benchRelation, extract_gate: benchExtractGate, doctype: benchDocType };
const tasks = task === "all" ? TASKS : [task];
if (!tasks.every((t) => RUNNERS[t])) { console.error(`unknown task: ${task} (one of ${TASKS.join(", ")}, all)`); process.exit(1); }

let models = null;
try { models = await (await fetch(`${String(process.env.SYSTEMONE_URL || "https://api.typesafe.ai").replace(/\/+$/, "")}/v1/models`)).json(); } catch { /* reported below */ }
console.log(`decision model: ${process.env.SYSTEMONE_URL || "https://api.typesafe.ai"} ${models ? JSON.stringify(models.data?.map?.((m) => m.id) || models).slice(0, 200) : "(unreachable)"}; chat model ${CHAT_MODEL}; GPU $${GPU_USD_HOUR}/h; Jev $${JEV_USD_MTOK}/MTok`);

mkdirSync(new URL("../eval/runs/", import.meta.url), { recursive: true });
for (const t of tasks) {
  const out = await RUNNERS[t]();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = new URL(`../eval/runs/${stamp}-decisions-${t}.json`, import.meta.url);
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), repeat: REPEAT, gpuUsdHour: GPU_USD_HOUR, jevUsdMtok: JEV_USD_MTOK, systemone: process.env.SYSTEMONE_URL || "https://api.typesafe.ai", chatModel: CHAT_MODEL, ...out }, null, 2));
  console.log(`\n  → ${file.pathname.replace(/^\/([A-Z]:)/, "$1")}\n`);
}
