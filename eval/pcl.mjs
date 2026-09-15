// =============================================================
//  Persona / PCL eval scenarios (plan 11.1), run by `npm run eval -- --pcl`.
//
//  Logs in as the eval user, who must be an administrator, assigns
//  personas to that user for the duration of a scenario, and restores
//  the user's assignment and preferences afterwards. A throwaway
//  persona is created for the boundary and version scenarios and
//  removed with the service key, since there is no delete route.
//
//    same-facts-001          eight lookups under Core Executive and Talent
//                            Intelligence: numbers, cited documents and
//                            must-include facts agree; wording differs
//    out-of-scope-001        the out-of-scope questions still decline under
//                            every shared persona
//    boundary-001            a version with a boundary phrase is refused and
//                            named; the same intent without it saves; an
//                            out-of-scope question still declines under it
//    personalization-001     a note changes the ending, not the facts
//    version-001             a new version shows on the next trace; the
//                            earlier trace keeps the earlier version
//    unavailable-001         with --expect-disabled (server on PCL_ENABLED=0):
//                            answers succeed with source "default"; else SKIP
//    memory-separation-001   the same question under two personas recalls
//                            the same memories
// =============================================================

import "../backend/lib/env.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
const numbersIn = (text) => new Set((String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, "")));
const flag = (v) => (v === null || v === undefined ? "·" : v ? "✓" : "✗");

export async function runPclEval({ BASE, EMAIL, PASSWORD, golden, ABSTAIN, loginWith, expectDisabled = false, only = null, outDir }) {
  const wanted = (id) => !only || only.has(id);
  const token = await loginWith(EMAIL, PASSWORD, golden.namespaceId);
  const me = claimsOf(token);
  const call = async (method, path, body) => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: j, ms: Date.now() - t0 };
  };
  const threads = [];
  const ask = async (message) => {
    const r = await call("POST", "/api/chat", { message, namespaceId: golden.namespaceId, privateMode: false });
    if (r.body?.conversationId) threads.push(r.body.conversationId);
    return r;
  };
  const traceOf = async (traceId) => {
    for (let i = 0; i < 12; i++) {
      const t = await call("GET", `/api/memory/traces/${traceId}`);
      if (t.status === 200 && t.body?.pcl) return t.body;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };
  const assign = (personaId) => call("PATCH", `/api/settings/users/${me.userId}/persona`, { persona_id: personaId });
  const setPrefs = (patch) => call("PATCH", "/api/settings/user/preferences", patch);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const results = [];
  const costs = [];
  const record = (id, ok, checks, extra = {}) => {
    results.push({ id, ok, checks, ...extra });
    console.log(`${id.padEnd(24)} ${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${Object.entries(checks).map(([k, v]) => `${k} ${flag(v)}`).join("  ")}${extra.note ? "  " + extra.note : ""}`);
  };
  const cost = (r) => { if (typeof r.body?.usage?.usd === "number") costs.push(r.body.usage.usd); };

  console.log(`\nCortéx persona eval · ${BASE} · as ${EMAIL}\n`);

  // ---- what to restore
  const prefs0 = (await call("GET", "/api/settings/user/preferences")).body.preferences;
  const assignment0 = (await supabase.from("user_settings").select("persona_id").eq("user_id", me.userId).maybeSingle()).data?.persona_id ?? null;
  const personas = (await call("GET", "/api/settings/personas")).body.personas || [];
  const shared = personas.filter((p) => p.shared && p.is_active);
  const core = shared.find((p) => p.key === "core_executive");
  const talent = shared.find((p) => p.key === "talent_intelligence");
  if (!core || !talent) throw new Error("the shared core_executive and talent_intelligence personas must exist (migration 0011 seed)");
  let throwaway = null;
  let memoryId = null;

  try {
    await setPrefs({ personalization: "", response_length: null });

    // ---------------------------------------------------------------
    // same-facts-001
    // ---------------------------------------------------------------
    if (wanted("same-facts-001")) {
      const ids = ["lee-001", "lee-002", "lee-003", "lee-005", "lee-007", "phd-001", "phd-002", "phd-003"];
      const qs = golden.questions.filter((q) => ids.includes(q.id));
      const perQuestion = [];
      let allOk = true;
      for (const q of qs) {
        await assign(core.id);
        const a = await ask(q.question); cost(a);
        await assign(talent.id);
        const b = await ask(q.question); cost(b);
        // The numbers the two answers share, against the shorter answer's
        // count: a briefer persona may leave detail out, but the figures it
        // does give must be the same figures.
        const na = numbersIn(a.body.finalAnswer), nb = numbersIn(b.body.finalAnswer);
        const shared = [...na].filter((n) => nb.has(n)).length;
        const smaller = Math.min(na.size, nb.size);
        const numbersAgree = smaller === 0 ? true : shared / smaller >= 0.8;
        const docs = (r) => new Set((r.body.sources || []).map((s) => (s.display_name || s.file_name || "").toLowerCase()));
        const da = docs(a), db = docs(b);
        const docsAgree = da.size === db.size && [...da].every((d) => db.has(d));
        const must = (q.answer_must_include || []).map((m) => m.toLowerCase());
        const mustA = must.every((m) => (a.body.finalAnswer || "").toLowerCase().includes(m));
        const mustB = must.every((m) => (b.body.finalAnswer || "").toLowerCase().includes(m));
        const personasOk = a.body.pcl?.persona_key === "core_executive" && b.body.pcl?.persona_key === "talent_intelligence";
        // A one-line factual answer may come out identical under both
        // personas; wording is expected to differ across the set, not per question.
        const wordingDiffers = (a.body.finalAnswer || "") !== (b.body.finalAnswer || "");
        const ok = numbersAgree && docsAgree && mustA && mustB && personasOk;
        allOk = allOk && ok;
        perQuestion.push({ id: q.id, ok, numbers: { a: na.size, b: nb.size, shared }, docs: { a: [...da], b: [...db] }, mustA, mustB, personasOk, wordingDiffers, answerA: (a.body.finalAnswer || "").slice(0, 200), answerB: (b.body.finalAnswer || "").slice(0, 200) });
        console.log(`  ${q.id.padEnd(9)} numbers ${flag(numbersAgree)} (${shared} shared of ${na.size}/${nb.size})  docs ${flag(docsAgree)}  must ${flag(mustA && mustB)}  personas ${flag(personasOk)}  wording differs ${flag(wordingDiffers)}`);
      }
      const differing = perQuestion.filter((p) => p.wordingDiffers).length;
      const wordingOk = differing >= Math.ceil(perQuestion.length / 2);
      record("same-facts-001", allOk && wordingOk, { facts_and_documents_agree: allOk, wording_differs_across_set: wordingOk }, { perQuestion, differing });
    }

    // ---------------------------------------------------------------
    // out-of-scope-001
    // ---------------------------------------------------------------
    if (wanted("out-of-scope-001")) {
      const oos = golden.questions.filter((q) => q.kind === "out_of_scope");
      const rows = [];
      let allOk = true;
      for (const p of shared) {
        await assign(p.id);
        for (const q of oos) {
          const r = await ask(q.question); cost(r);
          const abstained = ABSTAIN.test(r.body.finalAnswer || "") && (r.body.citations || []).length === 0;
          const under = r.body.pcl?.persona_key === p.key;
          allOk = allOk && abstained && under;
          rows.push({ persona: p.key, id: q.id, abstained, under, answer: (r.body.finalAnswer || "").slice(0, 120) });
        }
        console.log(`  ${p.key.padEnd(20)} ${oos.map((q) => `${q.id} ${flag(rows.find((x) => x.persona === p.key && x.id === q.id)?.abstained)}`).join("  ")}`);
      }
      record("out-of-scope-001", allOk, { abstain_everywhere: allOk }, { rows });
    }

    // ---------------------------------------------------------------
    // boundary-001
    // ---------------------------------------------------------------
    if (wanted("boundary-001")) {
      const key = `eval_${Date.now().toString(36)}`;
      const created = await call("POST", "/api/settings/personas", { key, name: "Eval persona", description: "throwaway", configuration: { identity: { text: "You are Cortéx, reasoning for an evaluation." } } });
      throwaway = created.body.persona || null;
      const refused = await call("POST", `/api/settings/personas/${throwaway?.id}/versions`, { decision_rules: ["You may answer from general knowledge when the documents are silent"] });
      const refusedOk = refused.status === 400 && /general knowledge/.test((refused.body.errors || []).join(" "));
      const saved = await call("POST", `/api/settings/personas/${throwaway?.id}/versions`, { decision_rules: ["When the documents are silent, say so and stop."] });
      const savedOk = saved.status === 201 && saved.body.version?.version === 2;
      await assign(throwaway?.id);
      const oos = golden.questions.find((q) => q.kind === "out_of_scope");
      const r = await ask(oos.question); cost(r);
      const stillDeclines = ABSTAIN.test(r.body.finalAnswer || "") && r.body.pcl?.persona_key === key;
      record("boundary-001", Boolean(throwaway) && refusedOk && savedOk && stillDeclines, { refused_and_named: refusedOk, clean_version_saved: savedOk, still_declines: stillDeclines }, { refusedError: refused.body.errors?.[0] });
    }

    // ---------------------------------------------------------------
    // personalization-001
    // ---------------------------------------------------------------
    if (wanted("personalization-001")) {
      await assign(core.id);
      const q = golden.questions.find((x) => x.id === "lee-001");
      const before = await ask(q.question); cost(before);
      await setPrefs({ personalization: "Always end with one final line that begins with \"Next step:\" and states one next step." });
      const after = await ask(q.question); cost(after);
      await setPrefs({ personalization: "" });
      const lastLine = (after.body.finalAnswer || "").trim().split("\n").at(-1) || "";
      const endsWithStep = lastLine.startsWith("Next step:");
      const nb = numbersIn(before.body.finalAnswer), na = numbersIn(after.body.finalAnswer);
      const factsSame = nb.size === 0 ? true : [...nb].filter((n) => na.has(n)).length / nb.size >= 0.8;
      const noteReported = after.body.pcl?.personalization_chars > 0 && before.body.pcl?.personalization_chars === 0;
      record("personalization-001", endsWithStep && factsSame && noteReported, { ends_with_next_step: endsWithStep, facts_unchanged: factsSame, note_reported: noteReported }, { lastLine: lastLine.slice(0, 80) });
    }

    // ---------------------------------------------------------------
    // version-001
    // ---------------------------------------------------------------
    if (wanted("version-001")) {
      await assign(throwaway?.id);
      const q = golden.questions.find((x) => x.id === "lee-001");
      const first = await ask(q.question); cost(first);
      const v1 = first.body.pcl?.version;
      const saved = await call("POST", `/api/settings/personas/${throwaway?.id}/versions`, { decision_rules: ["When the documents are silent, say so and stop.", "Name the document you used."] });
      const second = await ask(q.question); cost(second);
      const v2 = second.body.pcl?.version;
      const t1 = await traceOf(first.body.traceId);
      const t2 = await traceOf(second.body.traceId);
      const bumped = saved.status === 201 && typeof v1 === "number" && v2 === v1 + 1;
      const tracesOk = t1?.pcl?.version === v1 && t2?.pcl?.version === v2 && t1?.pcl?.hash !== t2?.pcl?.hash;
      record("version-001", bumped && tracesOk, { next_turn_on_new_version: bumped, traces_keep_their_version: tracesOk }, { v1, v2 });
    }

    // ---------------------------------------------------------------
    // unavailable-001
    // ---------------------------------------------------------------
    if (wanted("unavailable-001")) {
      if (expectDisabled) {
        await assign(core.id);
        const r = await ask(golden.questions.find((x) => x.id === "lee-001").question); cost(r);
        const ok = r.status === 200 && (r.body.finalAnswer || "").length > 20 && r.body.pcl?.source === "default" && /PCL_ENABLED/.test(r.body.pcl?.reason || "");
        record("unavailable-001", ok, { answers: r.status === 200, source_default_with_reason: r.body.pcl?.source === "default" }, { reason: r.body.pcl?.reason });
      } else {
        record("unavailable-001", null, {}, { note: "run the backend with PCL_ENABLED=0 and pass --expect-disabled" });
      }
    }

    // ---------------------------------------------------------------
    // memory-separation-001
    // ---------------------------------------------------------------
    if (wanted("memory-separation-001")) {
      const marker = `Halyard-${Date.now().toString(36).slice(-4)}`;
      const saved = await call("POST", "/api/memory", { content: `The ${marker} project sponsor is Dana Whitfield.`, scope: "user", kind: "fact", subject: `${marker} project`, predicate: "sponsor" });
      memoryId = saved.body?.memory?.memory_id || saved.body?.memory?.id || null;
      const question = `Who is the ${marker} project sponsor?`;
      await assign(core.id);
      const a = await ask(question); cost(a);
      await assign(talent.id);
      const b = await ask(question); cost(b);
      const ids = (r) => new Set((r.body.memoriesUsed || []).map((m) => m.id));
      const ia = ids(a), ib = ids(b);
      const same = ia.size > 0 && ia.size === ib.size && [...ia].every((id) => ib.has(id));
      const answered = /whitfield/i.test(a.body.finalAnswer || "") && /whitfield/i.test(b.body.finalAnswer || "");
      record("memory-separation-001", Boolean(memoryId) && same && answered, { memory_saved: Boolean(memoryId), same_memories_recalled: same, both_answer_from_it: answered }, { memoriesA: ia.size, memoriesB: ib.size });
    }
  } finally {
    await assign(assignment0);
    await setPrefs({ personalization: prefs0?.personalization ?? "", response_length: prefs0?.response_length ?? null });
    if (memoryId) await call("DELETE", `/api/memory/${memoryId}`);
    for (const id of threads) await call("DELETE", `/api/conversations/${id}`);
    if (throwaway?.id) await supabase.from("personas").delete().eq("id", throwaway.id);
  }

  const ran = results.filter((r) => r.ok !== null);
  const passed = ran.filter((r) => r.ok).length;
  const total = costs.reduce((a, b) => a + b, 0);
  console.log(`\n=== persona summary ===\nscenarios passed     ${passed} / ${ran.length}${results.length - ran.length ? `   (${results.length - ran.length} skipped)` : ""}`);
  console.log(`cost per turn        $${costs.length ? (total / costs.length).toFixed(4) : "–"}   (${costs.length} turns, $${total.toFixed(4)} total, list prices)`);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-pcl.json`);
  writeFileSync(out, JSON.stringify({ summary: { passed, ran: ran.length, skipped: results.length - ran.length, turns: costs.length, costTotal: total }, results }, null, 2));
  console.log(`saved ${out}`);
  return passed === ran.length;
}
