#!/usr/bin/env node
// =============================================================
//  Cortéx retrieval + answer eval
//
//  npm run eval -- --mode legacy|hybrid [--only retrieve] [--ids lee-001,phd-002] [--base http://localhost:8080]
//
//  Runs eval/golden.json against a running backend, prints a table,
//  and writes eval/runs/<timestamp>-<mode>.json. The mode is sent as
//  X-Retrieval-Mode, which the backend honours when
//  ALLOW_RETRIEVAL_MODE_OVERRIDE=1.
// =============================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);

const BASE = args.base || process.env.EVAL_BASE || "http://localhost:8080";
const MODE = (args.mode || process.env.RETRIEVAL_MODE || "legacy").toLowerCase();
const ONLY = args.only || "all";
const K = Number(args.k || 6);
const IDS = args.ids ? new Set(args.ids.split(",")) : null;

const env = readFileSync(join(here, "..", ".env"), "utf8");
const envVal = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim().replace(/^"|"$/g, "");
// Login is Supabase Auth (email + password) since the dev-branch auth route.
// Put EVAL_EMAIL / EVAL_PASSWORD in .env, or pass --user / --password.
const EMAIL = args.user || envVal("EVAL_EMAIL");
const PASSWORD = args.password || envVal("EVAL_PASSWORD");

const golden = JSON.parse(readFileSync(join(here, "golden.json"), "utf8"));
const questions = golden.questions.filter((q) => !IDS || IDS.has(q.id));

// ------------------------------------------------------------ helpers
const norm = (s) => String(s || "").toLowerCase();
// a result may carry a user-facing display name and the original file name; match either
const docNames = (x) => [x?.display_name, x?.filename, x?.file_name].filter(Boolean).map(norm);
const matchesDoc = (x, expected) => expected.some((e) => docNames(typeof x === "string" ? { filename: x } : x).some((n) => n.includes(norm(e))));
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "–");
const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
// note: the model writes curly apostrophes (don’t), so both forms are accepted
const ABSTAIN = /documents? (?:don['’]?t|do not|does not|doesn['’]?t) \w+|don['’]?t (?:cover|have)|do not (?:cover|have)|no matching documents|not (?:contain|include|cover|mention|identify|state|specify|provide|address)|not (?:identified|stated|specified|provided|mentioned|covered|found)|not found in|no (?:information|data|financial|revenue|record|reference)|contains? no|isn'?t (?:covered|mentioned|in the)|does not (?:appear|address|identify|state|specify|contain|include|mention)|cannot (?:be (?:answered|determined) from|reliably)|outside (?:the|these) (?:documents|materials|sources)/i;

async function loginWith(email, password, namespaceId) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, namespaceId }),
  });
  const j = await res.json();
  if (!j.token) throw new Error(`login failed for ${email}: ${j.error || res.status} (set EVAL_EMAIL / EVAL_PASSWORD in .env)`);
  return j.token;
}

function login() {
  return loginWith(EMAIL, PASSWORD, golden.namespaceId);
}

async function post(path, token, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Retrieval-Mode": MODE },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, body: j, ms: Date.now() - t0 };
}

// ------------------------------------------------------------ run
const token = await login();

// ------------------------------------------------------------ memory scenarios
//   npm run eval -- --memory            multi-turn scenarios from eval/memory-golden.json
if (args.memory === "true") {
  const mg = JSON.parse(readFileSync(join(here, "memory-golden.json"), "utf8"));
  const scenarios = mg.scenarios.filter((s) => !IDS || IDS.has(s.id));
  console.log(`\nCortéx memory eval · ${scenarios.length} scenarios · ${BASE}\n`);
  // Logins a turn can run as (design doc 5.11 isolation): the primary
  // account, a second account in the same namespace, and the primary
  // account signed into another namespace. Fetched once, on first use.
  const EMAIL_2 = envVal("EVAL_EMAIL_2");
  const PASSWORD_2 = envVal("EVAL_PASSWORD_2");
  const tokens = { primary: token };
  const loginAs = async (who) => {
    if (tokens[who] !== undefined) return tokens[who];
    tokens[who] = null;
    try {
      if (who === "second" && EMAIL_2 && PASSWORD_2) tokens.second = await loginWith(EMAIL_2, PASSWORD_2, mg.namespaceId);
      else if (who === "other_namespace" && mg.otherNamespaceId) tokens.other_namespace = await loginWith(EMAIL, PASSWORD, mg.otherNamespaceId);
    } catch (err) {
      console.log(`login as "${who}" failed: ${err.message}`);   // the scenario is skipped, not failed
    }
    return tokens[who];
  };
  const del = (path, tok) => fetch(`${BASE}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } }).catch(() => {});

  const results = [];
  let passedScenarios = 0;
  let skippedScenarios = 0;
  for (const s of scenarios) {
    const needs = [...new Set(s.turns.map((t) => t.as || "primary"))];
    const missing = [];
    for (const who of needs) if (!(await loginAs(who))) missing.push(who);
    if (missing.length) {
      skippedScenarios++;
      console.log(`${s.id.padEnd(11)} SKIP  needs login "${missing.join(", ")}" (set EVAL_EMAIL_2 / EVAL_PASSWORD_2 in .env, or otherNamespaceId in memory-golden.json)`);
      results.push({ id: s.id, family: s.family, skipped: true, missing });
      continue;
    }
    const marker = `ZQX${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const fill = (str) => String(str || "").replace(/\{\{marker\}\}/g, marker);
    const conversations = {};        // per login: the current conversation id
    const openedThreads = [];        // [{ who, id }] to delete afterwards
    const savedMemories = [];        // [{ who, id }] to delete afterwards
    const turns = [];
    let ok = true;
    for (const [i, t] of s.turns.entries()) {
      const who = t.as || "primary";
      const tok = tokens[who];
      if (t.new_conversation) conversations[who] = null;
      const c = await post("/api/chat", tok, { message: fill(t.message), conversationId: conversations[who] || null });
      if (c.body?.conversationId && c.body.conversationId !== conversations[who]) {
        conversations[who] = c.body.conversationId;
        openedThreads.push({ who, id: c.body.conversationId });
      }
      const answer = c.body?.finalAnswer || "";
      const cites = Array.isArray(c.body?.citations) ? c.body.citations : [];
      const used = Array.isArray(c.body?.memoriesUsed) ? c.body.memoriesUsed : [];
      if (c.body?.memorySaved?.id && c.body.memorySaved.action !== "duplicate") savedMemories.push({ who, id: c.body.memorySaved.id });
      const e = t.expect || {};
      const checks = {};
      if (e.cites_any) checks.cites_any = cites.some((x) => matchesDoc(x, e.cites_any));
      if (e.answer_must_include) checks.answer_must_include = e.answer_must_include.every((m) => norm(answer).includes(norm(fill(m))));
      if (e.answer_must_not_include) checks.answer_must_not_include = e.answer_must_not_include.every((m) => !norm(answer).includes(norm(fill(m))));
      if (e.mode_in) checks.mode_in = e.mode_in.includes(c.body?.mode);
      if (e.not_abstain) checks.not_abstain = !ABSTAIN.test(answer) && answer.length > 40;
      if (e.abstain) checks.abstain = ABSTAIN.test(answer);
      if (e.memory_saved !== undefined) checks.memory_saved = Boolean(c.body?.memorySaved?.id) === Boolean(e.memory_saved);
      if (e.memories_used_min !== undefined) checks.memories_used_min = used.length >= e.memories_used_min;
      if (e.memories_used_max !== undefined) checks.memories_used_max = used.length <= e.memories_used_max;
      if (e.saved_memory_fetch) {
        const target = savedMemories[savedMemories.length - 1];
        if (!target) checks.saved_memory_fetch = false;
        else {
          const r = await fetch(`${BASE}/api/memory/${target.id}`, { headers: { Authorization: `Bearer ${tok}` } }).catch(() => ({ status: 0 }));
          checks.saved_memory_fetch = e.saved_memory_fetch === "ok" ? r.status === 200 : r.status === 404;
        }
      }
      const turnOk = c.status === 200 && Object.values(checks).every(Boolean);
      ok = ok && turnOk;
      turns.push({ message: fill(t.message), as: who, status: c.status, ms: c.ms, mode: c.body?.mode, intent: c.body?.intent, citations: cites.length, memoriesUsed: used.length, memorySaved: c.body?.memorySaved || null, checks, ok: turnOk, answer: answer.slice(0, 300) });
      const flag = (v) => (v === true ? "✓" : v === false ? "✗" : "·");
      console.log(`${s.id.padEnd(11)} turn ${i + 1}${who === "primary" ? "" : ` as ${who}`}  ${turnOk ? "PASS" : "FAIL"}  mode=${String(c.body?.mode || "-").padEnd(14)} intent=${String(c.body?.intent?.type || "-")}/${String(c.body?.intent?.scope || "-")}  cites=${String(cites.length).padEnd(3)} mem=${String(used.length).padEnd(2)} ${Object.entries(checks).map(([k, v]) => `${k} ${flag(v)}`).join("  ")}  ${c.ms}ms`);
    }
    if (ok) passedScenarios++;
    results.push({ id: s.id, family: s.family, ok, marker, turns });
    for (const m of savedMemories) await del(`/api/memory/${m.id}`, tokens[m.who]);
    for (const th of openedThreads) await del(`/api/conversations/${th.id}`, tokens[th.who]);
  }
  const ran = scenarios.length - skippedScenarios;
  console.log(`\n=== memory summary ===\nscenarios passed     ${passedScenarios} / ${ran}${skippedScenarios ? `   (${skippedScenarios} skipped)` : ""}`);
  mkdirSync(join(here, "runs"), { recursive: true });
  const stampM = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outM = join(here, "runs", `${stampM}-memory.json`);
  writeFileSync(outM, JSON.stringify({ summary: { passed: passedScenarios, ran, skipped: skippedScenarios, total: scenarios.length }, results }, null, 2));
  console.log(`saved ${outM}`);
  process.exitCode = passedScenarios === ran ? 0 : 1;
  await new Promise((r) => setTimeout(r, 200));
  process.exit(process.exitCode);
}

const rows = [];
console.log(`\nCortéx eval · mode=${MODE} · ${questions.length} questions · k=${K} · ${BASE}\n`);

for (const q of questions) {
  const row = { id: q.id, kind: q.kind, question: q.question };

  // ---- retrieval
  if (ONLY !== "chat") {
    const r = await post("/api/retrieve", token, { query: q.question, namespaceId: golden.namespaceId });
    const results = Array.isArray(r.body?.results) ? r.body.results : [];
    const top = results.slice(0, K);
    const names = top;
    row.retrieve = {
      ms: r.ms,
      status: r.status,
      mode: r.body?.mode || null,
      count: results.length,
      top: top.map((x) => ({ file: (x.display_name || x.filename || "").slice(0, 40), page: x.page_start ?? null, section: (x.section_label || "").slice(0, 40), sim: x.similarity, score: x.score })),
    };
    if (q.kind !== "out_of_scope") {
      const exp = q.expected_documents || [];
      const firstRank = names.findIndex((n) => matchesDoc(n, exp));
      row.docRecall = firstRank >= 0;
      row.rr = firstRank >= 0 ? 1 / (firstRank + 1) : 0;
      row.allExpectedFound = exp.every((e) => names.some((n) => matchesDoc(n, [e])));
      if (q.expected_pages?.length) {
        const pages = top.filter((x) => matchesDoc(x, exp)).map((x) => x.page_start);
        row.pageRecall = q.expected_pages.some((p) => pages.includes(p));
      }
    }
  }

  // ---- answer
  if (ONLY !== "retrieve") {
    const c = await post("/api/chat", token, { message: q.question });
    // with memory on, every question starts a saved thread; the eval cleans up after itself
    if (c.body?.conversationId) await fetch(`${BASE}/api/conversations/${c.body.conversationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    const answer = c.body?.finalAnswer || "";
    const cites = Array.isArray(c.body?.citations) ? c.body.citations : [];
    row.chat = { ms: c.ms, status: c.status, mode: c.body?.mode || null, chars: answer.length, citations: cites.length, answer: answer.slice(0, 400) };
    if (q.kind === "out_of_scope") {
      row.abstained = ABSTAIN.test(answer) || (cites.length === 0 && answer.length < 400);
    } else {
      const exp = q.expected_documents || [];
      const must = q.answer_must_include || [];
      row.mustInclude = must.length ? must.every((m) => norm(answer).includes(norm(m))) : null;
      row.missing = must.filter((m) => !norm(answer).includes(norm(m)));
      if (cites.length) {
        const good = cites.filter((x) => matchesDoc(x, exp)).length;
        row.citationPrecision = good / cites.length;
      } else {
        row.citationPrecision = null;
      }
    }
  }

  rows.push(row);
  const flag = (v) => (v === true ? "✓" : v === false ? "✗" : "·");
  console.log(
    `${q.id.padEnd(11)} ${q.kind.padEnd(12)} doc ${flag(row.docRecall)}  page ${flag(row.pageRecall)}  must ${flag(row.mustInclude)}  cite ${row.citationPrecision == null ? "·" : pct(row.citationPrecision, 1)}  abstain ${flag(row.abstained)}  r=${row.retrieve?.ms ?? "-"}ms c=${row.chat?.ms ?? "-"}ms${row.missing?.length ? `  missing: ${row.missing.join(",")}` : ""}`
  );
}

// ------------------------------------------------------------ summary
const scored = rows.filter((r) => r.kind !== "out_of_scope");
const withPages = rows.filter((r) => r.pageRecall !== undefined);
const withCites = rows.filter((r) => typeof r.citationPrecision === "number");
const oos = rows.filter((r) => r.kind === "out_of_scope");
const summary = {
  mode: MODE,
  questions: rows.length,
  docRecallAtK: scored.length ? scored.filter((r) => r.docRecall).length / scored.length : null,
  allExpectedFound: scored.length ? scored.filter((r) => r.allExpectedFound).length / scored.length : null,
  mrr: scored.length ? scored.reduce((a, r) => a + (r.rr || 0), 0) / scored.length : null,
  pageRecallAtK: withPages.length ? withPages.filter((r) => r.pageRecall).length / withPages.length : null,
  mustInclude: ONLY !== "retrieve" && scored.length ? scored.filter((r) => r.mustInclude).length / scored.filter((r) => r.mustInclude !== null).length : null,
  citationPrecision: withCites.length ? withCites.reduce((a, r) => a + r.citationPrecision, 0) / withCites.length : null,
  answersWithCitations: ONLY !== "retrieve" && scored.length ? scored.filter((r) => r.chat?.citations > 0).length / scored.length : null,
  abstainAccuracy: ONLY !== "retrieve" && oos.length ? oos.filter((r) => r.abstained).length / oos.length : null,
  retrieveMs: { p50: quantile(rows.map((r) => r.retrieve?.ms).filter(Boolean), 0.5), p95: quantile(rows.map((r) => r.retrieve?.ms).filter(Boolean), 0.95) },
  chatMs: { p50: quantile(rows.map((r) => r.chat?.ms).filter(Boolean), 0.5), p95: quantile(rows.map((r) => r.chat?.ms).filter(Boolean), 0.95) },
};

console.log("\n=== summary ===");
console.log(`mode                 ${MODE}`);
console.log(`document recall@${K}    ${pct(summary.docRecallAtK, 1)}   (all expected docs: ${pct(summary.allExpectedFound, 1)})`);
console.log(`MRR                  ${summary.mrr == null ? "–" : summary.mrr.toFixed(2)}`);
console.log(`page recall@${K}        ${pct(summary.pageRecallAtK, 1)}   (${withPages.length} questions specify a page)`);
if (ONLY !== "retrieve") {
  console.log(`answer must-include  ${pct(summary.mustInclude, 1)}`);
  console.log(`citation precision   ${pct(summary.citationPrecision, 1)}   (answers with citations: ${pct(summary.answersWithCitations, 1)})`);
  console.log(`abstain accuracy     ${pct(summary.abstainAccuracy, 1)}   (${oos.length} out-of-scope questions)`);
}
console.log(`retrieve p50/p95     ${summary.retrieveMs.p50 ?? "–"} / ${summary.retrieveMs.p95 ?? "–"} ms`);
if (ONLY !== "retrieve") console.log(`chat p50/p95         ${summary.chatMs.p50 ?? "–"} / ${summary.chatMs.p95 ?? "–"} ms`);

mkdirSync(join(here, "runs"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(here, "runs", `${stamp}-${MODE}${ONLY !== "all" ? `-${ONLY}` : ""}.json`);
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
console.log(`\nsaved ${out}`);
