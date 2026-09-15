#!/usr/bin/env node
// =============================================================
//  Archive summary minimisation and caps (retention plan P2.5).
//  No database. Three fixed transcripts:
//    1. a business thread with planted contact details, an address,
//       a credential and an SSN, plus decisions and figures that must
//       survive — one real model call
//    2. a model that returns oversized, over-long and tainted output —
//       fake model, exercises the caps and the drop rules
//    3. a thread longer than the input budget — checks truncation keeps
//       the newest turns and says how many were omitted
//
//    node scripts/test-archive-summary.mjs [--offline]   (offline skips the real call)
// =============================================================

import "../backend/lib/env.js";
import OpenAI from "openai";
import {
  summarizeForArchive, buildArchive, buildArchiveInput, minimiseArchive, renderArchive, metadataOnlyArchive, documentsUsed, CAPS, PROMPT_VERSION,
} from "../backend/retention/summarize.js";
import { newUsage, usageSummary } from "../backend/lib/usage.js";

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const offline = process.argv.includes("--offline");
const at = (i) => new Date(Date.UTC(2026, 7, 12, 15, i, 0)).toISOString();

const conversation = { id: "11111111-1111-4111-8111-111111111111", organization_id: "o", namespace_id: "n", user_id: "u", title: "Perin patch cybersecurity sign-off", created_at: at(0), last_message_at: at(9) };
const src = (n) => [{ n: 1, document_id: `d${n}`, file_name: `doc${n}.pdf`, display_name: `Perin Patch Release Notes v${n}`, page_start: 3 }];
const planted = {
  email: "tom.greer@sollucio.example",
  phone: "808-555-0142",
  address: "1420 Ala Moana Boulevard",
  password: "hunter2-Q9!",
  ssn: "123-45-6789",
};
const messages = [
  { seq: 1, role: "user", content: `Who signed off the cybersecurity review for the Perin patch? Tom's email is ${planted.email} and his mobile is ${planted.phone} if you need it.`, created_at: at(0) },
  { seq: 2, role: "assistant", content: "The release notes say the cybersecurity review for the Perin patch was completed by Tom Greer, COO, on 2 August 2026.", sources: src(1), created_at: at(1) },
  { seq: 3, role: "user", content: `Good. Decision: Tom's review stands as the formal sign-off for the patch. The patch budget is $42,500. File it under the patch record at ${planted.address}.`, created_at: at(2) },
  { seq: 4, role: "assistant", content: "Noted: Tom Greer's review stands as the formal sign-off. The release notes list the patch budget as $42,500.", sources: src(2), created_at: at(3) },
  { seq: 5, role: "user", content: `Also the staging server password is ${planted.password} and my SSN is ${planted.ssn}, don't lose those. Ian will file the review under the patch record by 20 August.`, created_at: at(4) },
  { seq: 6, role: "assistant", content: "I can't keep credentials or personal identifiers. Action noted: Ian files the review under the patch record by 20 August 2026.", created_at: at(5) },
  { seq: 7, role: "user", content: "One open point: has the vendor confirmed the rollback plan?", created_at: at(6) },
  { seq: 8, role: "assistant", content: "The documents don't cover a vendor rollback confirmation.", created_at: at(7) },
];

// ---- 1. the real thing
if (!offline) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const usage = newUsage();
  const out = await summarizeForArchive({ openai, conversation, messages, usage });
  const archive = buildArchive({ conversation, messages, fields: out.fields, model: out.model });
  const text = renderArchive(archive);
  const all = JSON.stringify(archive);
  console.log(`--- rendered (${text.length} chars) ---\n${text}\n---`);
  check("no email survives", !/@/.test(all) && !all.includes(planted.email));
  check("no phone survives", !all.includes(planted.phone) && !/\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/.test(all));
  check("no postal address survives", !all.includes(planted.address));
  check("no password survives", !all.includes(planted.password) && !/hunter2/i.test(all));
  check("no SSN survives", !all.includes(planted.ssn) && !/\b\d{3}-\d{2}-\d{4}\b/.test(all));
  check("the decision survives", /sign-?off/i.test(all) && /Tom Greer/.test(all), archive.decisions.join(" | "));
  check("the figure survives", /42,?500/.test(all));
  check("the action item survives with its owner", archive.action_items.some((a) => /file/i.test(a.item)) && archive.action_items.some((a) => /ian/i.test(a.owner) || /ian/i.test(a.item)), JSON.stringify(archive.action_items));
  check("the open question survives", archive.open_questions.some((q) => /rollback/i.test(q)), archive.open_questions.join(" | "));
  check("participants are name and role only", archive.participants.length >= 1 && archive.participants.every((p) => p.name && !/@|\d{3}/.test(p.name + p.role)), JSON.stringify(archive.participants));
  check("documents used come from the sources, not the model", archive.documents_used.length === 2 && archive.documents_used[0].document_id === "d1");
  check("period and counts come from the rows", archive.period.started_at === at(0) && archive.period.ended_at === at(7) && archive.counts.messages === 8 && archive.counts.turns === 4);
  check("generation names the model and prompt version", archive.generation.model === out.model && archive.generation.prompt_version === PROMPT_VERSION && archive.generation.fallback === false);
  check("rendered text within the cap", text.length <= CAPS.render, String(text.length));
  const cost = usageSummary(usage);
  check("usage recorded for the call", cost?.calls?.length === 1 && cost.calls[0].stage === "archive_summary", `$${(cost?.usd ?? 0).toFixed(4)}`);
} else {
  console.log("SKIP  real model call (--offline)");
}

// ---- 2. caps and drop rules on a hostile model output
const tainted = {
  topic: "T".repeat(500),
  purpose: `Contact ${planted.email} or ${planted.phone}. ` + "P".repeat(400),
  decisions: Array.from({ length: 20 }, (_, i) => `Decision ${i + 1} ` + "x".repeat(300)),
  conclusions: [`The password is ${planted.password}`, `SSN ${planted.ssn} on file`, "A clean conclusion", "", "   "],
  action_items: [{ item: `Call ${planted.phone}`, owner: planted.email, due: "Friday" }, { item: "", owner: "x", due: "" }, { item: "Ship it", owner: "Ian, CTO", due: "2026-08-20" }],
  participants: [{ name: `Tom ${planted.email}`, role: "COO" }, { name: "", role: "nobody" }, { name: "Ian", role: "" }],
  open_questions: Array.from({ length: 9 }, (_, i) => `Q${i + 1}?`),
};
const min = minimiseArchive(tainted);
check("topic capped", min.topic.length <= CAPS.topic && min.topic.endsWith("…"), String(min.topic.length));
check("purpose capped and redacted", min.purpose.length <= CAPS.purpose && !min.purpose.includes(planted.email) && !min.purpose.includes(planted.phone), min.purpose.slice(0, 60));
check(`decisions capped at ${CAPS.items}, each at ${CAPS.item} chars`, min.decisions.length === CAPS.items && min.decisions.every((d) => d.length <= CAPS.item));
check("credential and SSN lines dropped, clean one kept, blanks dropped", min.conclusions.length === 1 && min.conclusions[0] === "A clean conclusion", JSON.stringify(min.conclusions));
check("action item with contact details redacted, empty item dropped, clean one kept", min.action_items.length === 2 && !JSON.stringify(min.action_items).includes(planted.phone) && !JSON.stringify(min.action_items).includes(planted.email) && min.action_items[1].item === "Ship it" && min.action_items[1].owner === "Ian, CTO", JSON.stringify(min.action_items));
check("participant with an email redacted, nameless one dropped", min.participants.length === 2 && !JSON.stringify(min.participants).includes("@") && min.participants[1].name === "Ian", JSON.stringify(min.participants));
check(`open questions capped at ${CAPS.items}`, min.open_questions.length === CAPS.items);
const big = buildArchive({ conversation, messages, fields: min, model: "fake" });
check("rendered text of a maximal record within the cap", renderArchive(big).length <= CAPS.render, String(renderArchive(big).length));

// ---- 3. a thread longer than the input budget
const long = Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, role: i % 2 ? "assistant" : "user", content: `Turn ${i + 1}: ` + "y".repeat(900), created_at: at(i % 60) }));
const input = buildArchiveInput({ summary: { summary: "Earlier: budget agreed." }, messages: long });
check("input within the budget", input.text.length <= CAPS.input, String(input.text.length));
check("newest turns kept, oldest omitted, count reported", input.omitted > 0 && input.text.includes("Turn 200:") && !input.text.includes("Turn 1:") && input.text.includes(`${input.omitted} earlier turns omitted`), `omitted=${input.omitted}`);
check("running summary leads the input", input.text.startsWith("SUMMARY OF EARLIER TURNS:\nEarlier: budget agreed."));
const oneTurn = buildArchiveInput({ messages: [{ role: "user", content: "z".repeat(10_000) }] });
check(`one turn capped at ${CAPS.turn} chars`, oneTurn.text.length < CAPS.turn + 40);

// ---- 4. the fallback
const fb = metadataOnlyArchive({ conversation, messages, reason: "too short for a summary" });
check("fallback keeps title, period, counts and documents, no model text", fb.topic === conversation.title && fb.decisions.length === 0 && fb.documents_used.length === 2 && fb.counts.messages === 8 && fb.generation.fallback === true && fb.generation.model === null && fb.generation.reason === "too short for a summary");
check("fallback renders with the metadata-only note", /summary unavailable, metadata only/.test(renderArchive(fb)));
check("documentsUsed ignores user messages and repeats", documentsUsed([{ role: "user", sources: src(9) }, { role: "assistant", sources: [...src(1), ...src(1)] }]).length === 1);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
