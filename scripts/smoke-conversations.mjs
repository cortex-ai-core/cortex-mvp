#!/usr/bin/env node
// =============================================================
//  Smoke test for backend/memory/conversations.js against the
//  configured Supabase project (.env). Creates a conversation for a
//  real user, appends two turns, checks ownership isolation, then
//  deletes what it made. Prints PASS/FAIL per step.
//
//    node scripts/smoke-conversations.mjs <user_id> <organization_id> <namespace_id>
//    node scripts/smoke-conversations.mjs --email <user email>   (looks the ids up)
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import {
  createConversation, getOrCreateConversation, appendMessage, listConversations,
  getMessages, renameConversation, archiveConversation, deleteConversation, getConversation,
} from "../backend/memory/conversations.js";
import { effectiveSettings } from "../backend/memory/settings.js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const args = process.argv.slice(2);
let identity;

if (args[0] === "--email") {
  const { data: u, error } = await supabase.from("user").select("id, organization_id, namespace_users(namespace_id)").eq("email", args[1]).maybeSingle();
  if (error || !u) { console.error("user not found:", error?.message || args[1]); process.exit(1); }
  identity = { userId: u.id, organizationId: u.organization_id, namespaceId: u.namespace_users?.[0]?.namespace_id };
} else {
  identity = { userId: args[0], organizationId: args[1], namespaceId: args[2] };
}
if (!identity.userId || !identity.organizationId || !identity.namespaceId) { console.error("need user, organization and namespace ids"); process.exit(1); }

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };

// leftovers from an earlier interrupted run
for (const title of ["smoke test", "renamed"]) {
  await supabase.from("conversations").delete().eq("user_id", identity.userId).eq("title", title);
}

// another real user in the same organization stands in for "someone else";
// the user table's foreign key rejects made-up ids before ownership is even checked
const { data: others } = await supabase.from("user").select("id").eq("organization_id", identity.organizationId).neq("id", identity.userId).limit(1);
if (!others?.length) { console.error("need a second user in the organization for the isolation checks"); process.exit(1); }

const settings = await effectiveSettings(supabase, identity.namespaceId, console);
console.log("settings:", JSON.stringify({ memory_enabled: settings.memory_enabled, source: settings.source }));

const { conversation: c, created } = await getOrCreateConversation(supabase, identity, null, { title: "smoke test" });
check("create conversation", created && c?.id, c?.id);

const m1 = await appendMessage(supabase, identity, c.id, { role: "user", content: "hello there" });
const m2 = await appendMessage(supabase, identity, c.id, { role: "assistant", content: "hi", mode: "simple", citations: [], sources: [] });
check("append allocates seq 1, 2", m1?.seq === 1 && m2?.seq === 2, `${m1?.seq},${m2?.seq}`);

const again = await getConversation(supabase, identity, c.id);
check("message_count bumped", again?.message_count === 2, String(again?.message_count));

const reuse = await getOrCreateConversation(supabase, identity, c.id);
check("getOrCreate reuses the caller's id", !reuse.created && reuse.conversation.id === c.id);

const detail = await getMessages(supabase, identity, c.id);
check("getMessages returns both in order", detail?.messages?.length === 2 && detail.messages[0].role === "user");

const listed = await listConversations(supabase, identity);
check("list includes it", listed.some((r) => r.id === c.id));

// another owner: same organization and namespace, different user
const stranger = { ...identity, userId: others[0].id };
check("stranger cannot fetch it", (await getConversation(supabase, stranger, c.id)) === null);
check("stranger getMessages is null", (await getMessages(supabase, stranger, c.id)) === null);
let strangerAppend = null;
try { await appendMessage(supabase, stranger, c.id, { role: "user", content: "x" }); } catch (err) { strangerAppend = err.message; }
check("stranger append is refused by the database", Boolean(strangerAppend), strangerAppend?.slice(0, 60));
const { conversation: fresh, created: created2 } = await getOrCreateConversation(supabase, stranger, c.id);
check("stranger asking for it gets a new one instead", created2 && fresh.id !== c.id);
await deleteConversation(supabase, stranger, fresh.id);

check("rename", (await renameConversation(supabase, identity, c.id, "renamed"))?.title === "renamed");
check("archive", Boolean((await archiveConversation(supabase, identity, c.id))?.archived_at));
check("archived one is not reused", (await getOrCreateConversation(supabase, identity, c.id)).created);
// clean the extra one that call created
const extra = (await listConversations(supabase, identity)).find((r) => r.id !== c.id && r.title === null && r.message_count === 0);
if (extra) await deleteConversation(supabase, identity, extra.id);

check("delete", await deleteConversation(supabase, identity, c.id));
const { count } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", c.id);
check("messages cascaded", count === 0, String(count));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
