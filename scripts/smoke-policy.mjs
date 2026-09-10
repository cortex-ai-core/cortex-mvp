#!/usr/bin/env node
// =============================================================
//  The policy step at store level (design doc section 9, 9.5 flow)
//  against the configured Supabase project, without the chat route:
//  duplicates strengthen, a same-person update supersedes, a rival
//  value from someone else goes to the vote and lands contested, the
//  block renders both sides, a person resolves it, a retraction hides
//  a note, a denial from someone else votes, and the state history
//  answers "as of". Cleans up after itself. Needs migration 0010.
//
//    node scripts/smoke-policy.mjs <user_id> <organization_id> <namespace_id>
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { saveMemory, getMemory, deleteMemory, memoryStates, stateAsOf, resolveContested, attestMemory, listContested, currentState, liveAttestations } from "../backend/memory/store.js";
import { recallMemories } from "../backend/memory/recall.js";
import { envDefaults } from "../backend/memory/settings.js";

const [userId, organizationId, namespaceId] = process.argv.slice(2);
if (!userId || !organizationId || !namespaceId) { console.error("usage: node scripts/smoke-policy.mjs <user_id> <organization_id> <namespace_id>"); process.exit(1); }
const me = { userId, organizationId, namespaceId, role: "super_admin" };
// a second person in the same namespace: attestations carry the actor as text, so no user row is needed
const colleague = { userId: randomUUID(), organizationId, namespaceId, role: "admin" };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const settings = envDefaults();
const marker = `ZQX${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const created = new Set();
const keep = (r) => { if (r?.memory?.id) created.add(r.memory.id); return r; };
const cleanup = async () => { for (const id of created) await supabase.from("memories").delete().eq("id", id).eq("namespace_id", namespaceId); };
const conv = () => ({ sourceConversationId: null });

try {
  // ---- 1. duplicates strengthen one proposition (a shared note, so a second person can say it too)
  const a = keep(await saveMemory(supabase, openai, me, { content: `The ${marker} audit is due on October 9.`, kind: "fact", scope: "namespace" }, { settings }));
  check("first save: created, accepted", a.action === "created" && a.truthStatus === "accepted" && a.memory.truth_status === "accepted");
  const s1 = await currentState(supabase, a.memory.id);
  check("a state row was written with the policy version", s1?.truth_status === "accepted" && s1?.policy_version === "cortex-v1", s1?.reason);
  const a2 = await saveMemory(supabase, openai, me, { content: `The ${marker} audit is due on October 9.`, kind: "fact", scope: "namespace" }, { settings });
  check("same text from the same source: duplicate, not attested again", a2.action === "duplicate" && !a2.attested);
  const a3b = await saveMemory(supabase, openai, colleague, { content: `The ${marker} audit is due on October 9.`, kind: "fact", scope: "namespace" }, { settings });
  check("same text from another person: attested, still one memory", a3b.action === "duplicate" && a3b.attested && (await liveAttestations(supabase, a.memory.id)).length === 2, `${(await liveAttestations(supabase, a.memory.id)).length} attestations`);

  // ---- 2. a different value from the same person supersedes (UPDATE)
  const b = keep(await saveMemory(supabase, openai, me, { content: `The ${marker} audit is due on October 16.`, kind: "fact", scope: "namespace", relation: "different_value", targetId: a.memory.id }, { settings }));
  check("same person, new value: superseded", b.action === "superseded" && b.memory.truth_status === "accepted" && b.memory.supersedes_id === a.memory.id);
  const aNow = await getMemory(supabase, me, a.memory.id);
  check("the earlier note is superseded in status and truth", aNow.status === "superseded" && aNow.truth_status === "superseded" && aNow.superseded_at);
  const hist = await memoryStates(supabase, me, a.memory.id);
  // three windows: accepted on the first save, accepted again with a wider basis when the colleague attested, then superseded
  check("the earlier note's history has three closed-then-open windows", hist.states.length === 3 && hist.states[0].truth_status === "superseded" && hist.states[1].truth_status === "accepted" && hist.states[2].truth_status === "accepted" && hist.states[1].basis_hash !== hist.states[2].basis_hash, hist.states.map((s) => `${s.truth_status} ${s.effective_range}`).join(" | "));
  const before = stateAsOf(hist.states, new Date(Date.parse(hist.states[2].computed_at) + 50));
  check("as-of just after the first save: accepted", before?.truth_status === "accepted");
  check("as-of now: superseded", stateAsOf(hist.states, new Date())?.truth_status === "superseded");

  // ---- 3. a rival value from someone else: the vote, contested
  const shared = keep(await saveMemory(supabase, openai, colleague, { content: `The ${marker} RFP vendor is Vendor Alpha.`, kind: "fact", scope: "namespace", subject: `${marker} RFP`, predicate: "vendor" }, { settings }));
  check("an admin's shared note: created, admin layer", shared.action === "created" && (await liveAttestations(supabase, shared.memory.id))[0]?.source_layer === "admin");
  // the user says otherwise, in a shared note too (a private note cannot rival a shared one: different owners)
  const mine = keep(await saveMemory(supabase, openai, me, { content: `The ${marker} RFP vendor is Vendor Beta.`, kind: "fact", scope: "namespace", subject: `${marker} RFP`, predicate: "vendor", relation: "different_value", targetId: shared.memory.id }, { settings }));
  check("rival value from another person: contested", mine.action === "contested" && mine.counterpart?.id === shared.memory.id, `action=${mine.action}`);
  const sShared = await currentState(supabase, shared.memory.id), sMine = await currentState(supabase, mine.memory.id);
  check("both propositions are contested and point at each other", sShared?.truth_status === "contested" && sMine?.truth_status === "contested" && sShared.counterpart_id === mine.memory.id && sMine.counterpart_id === shared.memory.id);
  check("dimensions recorded from each side's view", sMine?.dimensions?.tally && sShared?.dimensions?.tally && sMine.dimensions.tally.this === sShared.dimensions.tally.other, JSON.stringify(sMine?.dimensions));
  const contested = await listContested(supabase, me);
  check("contested list shows the pair", contested.some((c) => c.memory.id === mine.memory.id && c.counterpart?.id === shared.memory.id));

  // ---- 4. the block renders both sides with a basis
  const hit = await recallMemories(supabase, openai, me, { message: `Who is the ${marker} RFP vendor?`, settings });
  const block = hit.block;
  check("recall shows the contested pair once", block.includes("CONTESTED") && block.split("CONTESTED").length === 2, block.split("\n").filter((l) => /CONTESTED|says|Basis/.test(l)).join(" / ").slice(0, 300));
  check("both values and a basis line appear", /Vendor Alpha/.test(block) && /Vendor Beta/.test(block) && /Basis:/.test(block));
  check("the sides name who said it", /you \(/.test(block) && /an admin/.test(block));

  // ---- 5. a person resolves it
  const res = await resolveContested(supabase, me, mine.memory.id, { winnerId: shared.memory.id, note: "confirmed with procurement" });
  check("resolve: the chosen side is accepted, the other denied, both overridden", res.memory.truth_status === "denied" && res.counterpart.truth_status === "accepted" && (await currentState(supabase, shared.memory.id))?.review_status === "overridden");
  const after = await recallMemories(supabase, openai, me, { message: `Who is the ${marker} RFP vendor?`, settings });
  check("after resolve: only the accepted value is recalled", /Vendor Alpha/.test(after.block) && !/Vendor Beta/.test(after.block) && !/CONTESTED/.test(after.block));
  const late = keep(await saveMemory(supabase, openai, { ...colleague, userId: randomUUID() }, { content: `The ${marker} RFP vendor is Vendor Gamma.`, kind: "fact", scope: "namespace", relation: "different_value", targetId: shared.memory.id }, { settings }));
  check("an override stands against a new rival: denied without a vote", late.action === "denied" && (await currentState(supabase, late.memory.id))?.reason?.includes("admin"), late.action);

  // ---- 6. retraction by the person who said it
  const c = keep(await saveMemory(supabase, openai, me, { content: `The ${marker} kickoff is in the Lanai room.`, kind: "fact" }, { settings }));
  const ret = await saveMemory(supabase, openai, me, { content: `The ${marker} kickoff is in the Lanai room.`, kind: "fact", stance: "denies", relation: "same", targetId: c.memory.id }, { settings });
  check("own denial retracts", ret.action === "retracted" && (await getMemory(supabase, me, c.memory.id)).truth_status === "retracted");
  const gone = await recallMemories(supabase, openai, me, { message: `Where is the ${marker} kickoff?`, settings });
  check("a retracted note is not recalled", !/Lanai/.test(gone.block));

  // ---- 7. a denial from someone else runs the single-proposition vote
  const d = keep(await saveMemory(supabase, openai, me, { content: `The ${marker} budget is 40,000 dollars.`, kind: "fact", scope: "namespace" }, { settings }));
  const deny = await attestMemory(supabase, colleague, d.memory.id, { stance: "denies", note: "the approved figure differs" });
  check("a colleague's denial: assertion vs denial vote (user first-party only: contested)", deny.truthStatus === "contested", deny.truthStatus);
  const confirm = await attestMemory(supabase, { ...colleague, userId: randomUUID(), role: "admin" }, d.memory.id, { stance: "asserts" });
  const dState = await currentState(supabase, d.memory.id);
  check("a second independent assertion wins independence, one dimension: still contested (three of five needed)", confirm.truthStatus === "contested" && dState?.dimensions?.independent === "this" && dState?.dimensions?.tally?.this === 1, `${confirm.truthStatus} ${JSON.stringify(dState?.dimensions)}`);
  const own = await resolveContested(supabase, me, d.memory.id, { winnerId: d.memory.id, note: "figure confirmed by finance" });
  check("a single-proposition contest can be resolved by a person", own.memory.truth_status === "accepted" && (await currentState(supabase, d.memory.id))?.review_status === "overridden");

  // ---- 8. reported stance
  const rep = keep(await saveMemory(supabase, openai, me, { content: `The ${marker} service desk RFP closes on the 15th.`, kind: "fact", stance: "reports" }, { settings }));
  check("a report is 'reported'", rep.truthStatus === "reported" && rep.memory.truth_status === "reported");
  const repBlock = await recallMemories(supabase, openai, me, { message: `When does the ${marker} service desk RFP close?`, settings });
  check("reported notes render as 'reported by you'", /reported by you/.test(repBlock.block), repBlock.block.split("\n").find((l) => l.includes("15th")));
} catch (err) {
  console.error("smoke-policy crashed:", err);
  failures++;
} finally {
  await cleanup();
}
console.log(`\n${failures ? `${failures} FAILED` : "ALL PASSED"}`);
process.exitCode = failures ? 1 : 0;
await new Promise((r) => setTimeout(r, 200));
process.exit(process.exitCode);
