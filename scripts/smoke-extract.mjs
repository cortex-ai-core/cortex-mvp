#!/usr/bin/env node
// =============================================================
//  Automatic extraction and the per-user cap (design doc P4.1, P4.3)
//  against the configured Supabase project, without the chat route:
//  a stated preference becomes a memory, a document answer does not,
//  a correction supersedes, an explicit "remember" correction is found,
//  the cap archives the least-used memories, and every call's cost is
//  tallied. Cleans up after itself. Needs migration 0008.
//
//    node scripts/smoke-extract.mjs <user_id> <organization_id> <namespace_id>
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { saveMemory, getMemory, enforceUserCap, countActiveUserMemories } from "../backend/memory/store.js";
import { extractMemories, findCorrectedMemory, groundedInUserMessage, isOnlyQuestions } from "../backend/memory/extract.js";
import { envDefaults } from "../backend/memory/settings.js";
import { newUsage, usageSummary } from "../backend/lib/usage.js";

const [userId, organizationId, namespaceId] = process.argv.slice(2);
if (!userId || !organizationId || !namespaceId) { console.error("usage: node scripts/smoke-extract.mjs <user_id> <organization_id> <namespace_id>"); process.exit(1); }
const identity = { userId, organizationId, namespaceId, role: "super_admin" };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const settings = { ...envDefaults(), extract_enabled: true };
const marker = `ZQX${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const usage = newUsage();

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const created = new Set();
const track = (r) => { for (const s of r?.saved || []) created.add(s.id); return r; };
const cleanup = async () => {
  for (const id of created) await supabase.from("memories").delete().eq("id", id).eq("namespace_id", namespaceId);
};

try {
  // ---- the grounding heuristic on its own
  check("grounded: a preference the user stated", groundedInUserMessage("The user prefers answers as short bullet lists.", "Can you keep answers as short bullet lists from now on?"));
  check("not grounded: a fact copied from the answer", !groundedInUserMessage("The AST degree at Leeward is 62 credits.", "How many credits is the AST degree at Leeward?"));
  check("not grounded: a number the user never said", !groundedInUserMessage("The board meets on October 14.", "When does the board meet?"));
  check("a question-only message is skipped without a call", isOnlyQuestions("What is the project code for our board presentation? Which document covers it?") && !isOnlyQuestions("Our code is ZQX1. What does the playbook cover?"));
  const skipped = await extractMemories(supabase, openai, identity, { question: "What is the project code for our board presentation on the internship program?", answer: "The project code is ZQX1.", settings, usage });
  check("question-only exchange: no call, nothing saved", !skipped.ran && skipped.reason === "question only" && skipped.saved.length === 0, skipped.reason);

  // ---- a stated preference creates a memory
  const pref = track(await extractMemories(supabase, openai, identity, {
    question: `I prefer answers as short bullet lists. Also, our ${marker} project lead is Monica Geller. What does the internship document say about eligibility?`,
    answer: "Eligibility requires enrolment in a degree program and a GPA of 2.5 or higher [1].",
    settings, usage,
  }));
  check("extraction ran", pref.ran, pref.reason || "");
  check("a stated preference or fact was saved (1-3)", pref.saved.length >= 1 && pref.saved.length <= 3, `${pref.saved.length} saved: ${pref.saved.map((s) => s.content).join(" | ")}`);
  check("nothing from the answer was saved", !pref.saved.some((s) => /gpa|2\.5|enrol/i.test(s.content)), pref.saved.map((s) => s.content).join(" | "));
  check("saved rows are extracted, user scope", (await Promise.all(pref.saved.map((s) => getMemory(supabase, identity, s.id)))).every((m) => m?.source_type === "extracted" && m?.scope === "user"));

  // ---- a document answer creates nothing
  const doc = track(await extractMemories(supabase, openai, identity, {
    question: "I'm going through the LEE catalog this afternoon. How many credits is the AST degree at Leeward Community College?",
    answer: "The AST degree at Leeward Community College requires 62 credits [1].",
    settings, usage,
  }));
  check("document answer: nothing from the document saved", doc.ran && !doc.saved.some((s) => /62|credit/i.test(s.content)), `${doc.candidates.length} candidates, saved: ${doc.saved.map((s) => s.content).join(" | ") || "none"}, dropped: ${doc.dropped.map((d) => d.reason).join(", ") || "none"}`);

  // ---- a correction supersedes the memory it was shown
  const lead = pref.saved.find((s) => /monica/i.test(s.content));
  if (lead) {
    const corr = track(await extractMemories(supabase, openai, identity, {
      question: `Correction: the ${marker} project lead is now Rachel Green, not Monica. Anything in the playbook about handovers?`,
      answer: "The Operations Playbook does not cover handovers.",
      relatedMemories: [{ id: lead.id, content: lead.content }],
      settings, usage,
    }));
    const fix = corr.saved.find((s) => /rachel/i.test(s.content));
    check("correction saved", Boolean(fix), corr.saved.map((s) => s.content).join(" | "));
    check("correction supersedes the earlier note", fix?.supersedes === lead.id && (await getMemory(supabase, identity, lead.id))?.status === "superseded", `supersedes=${fix?.supersedes}`);
  } else {
    check("correction supersedes the earlier note", false, "no project-lead memory to correct (extraction did not save one)");
  }

  // ---- explicit remember: a rewording the near-duplicate rule misses
  const a = await saveMemory(supabase, openai, identity, { content: `The ${marker} account's liaison is Chandler Bing.`, kind: "entity", importance: 4 }, { settings, usage });
  created.add(a.memory.id);
  const found = await findCorrectedMemory(supabase, openai, identity, { content: `Joey Tribbiani has taken over as the liaison for the ${marker} account.`, settings, usage });
  check("remember correction finds the note it replaces", found.supersedesId === a.memory.id, `related=${found.related.length} supersedes=${found.supersedesId} reason=${found.reason || "-"}`);
  const unrelated = await findCorrectedMemory(supabase, openai, identity, { content: `The ${marker} account's fiscal year starts in April.`, settings, usage });
  check("an unrelated note supersedes nothing", unrelated.supersedesId === null, `related=${unrelated.related.length}`);
  check("the check returns an embedding the save can reuse", Array.isArray(found.embedding) && found.embedding.length === 1536);

  // ---- the per-user cap
  const before = await countActiveUserMemories(supabase, identity);
  // three unrelated notes, so the near-duplicate rule does not fold them into one
  const fillers = [
    `${marker}: the parking garage code is 4471.`,
    `${marker}: quarterly reviews are held in the Lanai room.`,
    `${marker}: the vendor newsletter goes out on Thursdays.`,
  ];
  const extra = [];
  for (const [i, content] of fillers.entries()) {
    const r = await saveMemory(supabase, openai, identity, { content, kind: "note", importance: 1 }, { settings, usage });
    created.add(r.memory.id); extra.push(r.memory.id);
    // backdate the fillers so the sweep picks them and never the user's real memories
    await supabase.from("memories").update({ created_at: new Date(Date.UTC(2000, 0, 1 + i)).toISOString() }).eq("id", r.memory.id);
  }
  const cap = before + 1;   // one over: the two oldest never-used fillers should go
  const archived = await enforceUserCap(supabase, identity, cap);
  const after = await countActiveUserMemories(supabase, identity);
  check(`cap ${cap}: archived the excess`, archived === before + 3 - cap && after === cap, `archived ${archived}, active ${after}`);
  const states = await Promise.all(extra.map((id) => getMemory(supabase, identity, id)));
  check("the two oldest fillers archived, the newest survived", states[2]?.status === "active" && states[0]?.status === "archived" && states[1]?.status === "archived", states.map((m) => m?.status).join(","));
  check("nothing archived when under the cap", (await enforceUserCap(supabase, identity, 100000)) === 0);
  const { data: ev } = await supabase.from("memory_events").select("event, actor, detail").eq("memory_id", extra[0]).eq("event", "archived").maybeSingle();
  check("cap sweep logged an archived event", ev?.actor === "system:cap" && ev?.detail?.reason);

  // ---- cost
  const u = usageSummary(usage);
  check("every model call was tallied with a price", u.calls.length >= 6 && u.calls.every((c) => c.usd !== null), `${u.calls.length} calls, $${u.usd}`);
  console.log(`\ncalls: ${u.calls.map((c) => `${c.stage}(${c.model} ${c.input}/${c.output})`).join(", ")}\ntotal $${u.usd.toFixed(5)}`);
} catch (err) {
  console.error("smoke-extract crashed:", err);
  failures++;
} finally {
  await cleanup();
}
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exitCode = failures ? 1 : 0;
await new Promise((r) => setTimeout(r, 200));
process.exit(process.exitCode);
