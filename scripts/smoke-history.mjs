#!/usr/bin/env node
// =============================================================
//  Thread window and summariser (design doc P2.1, P2.3) against the
//  configured Supabase project, without the chat route: builds a
//  40-message thread, checks the window stays inside its caps, runs
//  the summariser, checks the summary row, then deletes the thread.
//
//    node scripts/smoke-history.mjs <user_id> <organization_id> <namespace_id>
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { createConversation, appendMessage, deleteConversation } from "../backend/memory/conversations.js";
import { loadWindow, maybeSummarize } from "../backend/memory/window.js";
import { envDefaults } from "../backend/memory/settings.js";

const [userId, organizationId, namespaceId] = process.argv.slice(2);
if (!userId || !organizationId || !namespaceId) { console.error("usage: node scripts/smoke-history.mjs <user_id> <organization_id> <namespace_id>"); process.exit(1); }
const identity = { userId, organizationId, namespaceId };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const settings = envDefaults();

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };

const c = await createConversation(supabase, identity, { title: "smoke history" });
// long enough that 40 messages clearly exceed the 3,000-token summary trigger
const filler = "The quarterly review covered vendor contracts, the service desk rollout, staffing for the Hawaii office, and the July 1 fiscal year change. ".repeat(3);
for (let i = 1; i <= 20; i++) {
  await appendMessage(supabase, identity, c.id, { role: "user", content: `Turn ${i}: what about item ${i}? Marker M${i}. ${filler}` });
  await appendMessage(supabase, identity, c.id, { role: "assistant", content: `Answer ${i}: item ${i} was decided on day ${i}; the owner is Person${i}. ${filler}` });
}

const w1 = await loadWindow(supabase, identity, c.id, settings);
check("40 messages stored", w1.totalMessages === 40, String(w1.totalMessages));
check(`window holds at most ${settings.history_turns * 2} messages`, w1.messages.length <= settings.history_turns * 2, String(w1.messages.length));
check(`window within ${settings.history_tokens} tokens`, w1.tokens <= settings.history_tokens, String(w1.tokens));
check("window ends with the newest message", w1.messages[w1.messages.length - 1]?.seq === 40, String(w1.messages[w1.messages.length - 1]?.seq));
check("no summary yet", w1.summary === null);
check("unsummarised part exceeds the trigger", w1.unsummarizedTokens > settings.summary_trigger_tokens, `${w1.unsummarizedTokens} > ${settings.summary_trigger_tokens}`);

const r = await maybeSummarize(supabase, openai, identity, c.id, settings, console);
check("summariser ran", r.ran === true, JSON.stringify(r));
check("folded everything older than the verbatim window", r.throughSeq === 40 - settings.history_turns * 2, String(r.throughSeq));

const w2 = await loadWindow(supabase, identity, c.id, settings);
check("summary present and under 300 tokens", w2.summary && w2.summary.text.length <= 300 * 4 + 2, String(w2.summary?.text.length));
check("summary keeps a marker from the folded turns", /M1\b|item 1\b|Person1\b|July 1/.test(w2.summary?.text || ""), (w2.summary?.text || "").slice(0, 160));
check("window now starts after the summary (and within the token cap)", w2.messages[0]?.seq > r.throughSeq && w2.tokens <= settings.history_tokens + 300, `first seq ${w2.messages[0]?.seq}, ${w2.tokens} tokens`);
check("second run is a no-op", (await maybeSummarize(supabase, openai, identity, c.id, settings, console)).ran === false);

const beforeSeq = 40;
const w3 = await loadWindow(supabase, identity, c.id, settings, { beforeSeq });
check("beforeSeq excludes the current turn", w3.messages.every((m) => m.seq < beforeSeq));

await deleteConversation(supabase, identity, c.id);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
