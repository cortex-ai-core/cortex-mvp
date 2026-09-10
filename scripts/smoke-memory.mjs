#!/usr/bin/env node
// =============================================================
//  Durable memory store and recall (design doc P3.2, P3.3, 5.11)
//  against the configured Supabase project, without the chat route:
//  save, exact and near duplicates, supersede, recall hit and miss,
//  isolation across user, namespace and organization, delete, events.
//  Cleans up after itself. Needs migration 0008.
//
//    node scripts/smoke-memory.mjs <user_id> <organization_id> <namespace_id>
// =============================================================

import "../backend/lib/env.js";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { saveMemory, getMemory, listMemories, deleteMemory, touchMemories, memoryHistory, updateMemory } from "../backend/memory/store.js";
import { recallMemories } from "../backend/memory/recall.js";
import { envDefaults } from "../backend/memory/settings.js";

const [userId, organizationId, namespaceId] = process.argv.slice(2);
if (!userId || !organizationId || !namespaceId) { console.error("usage: node scripts/smoke-memory.mjs <user_id> <organization_id> <namespace_id>"); process.exit(1); }
const identity = { userId, organizationId, namespaceId, role: "super_admin" };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const settings = envDefaults();
const marker = `ZQX${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`); if (!ok) failures++; };
const created = new Set();
const cleanup = async () => {
  for (const id of created) {
    await supabase.from("memories").delete().eq("id", id).eq("namespace_id", namespaceId);
  }
};

try {
  // ---- save, exact duplicate, near duplicate
  const fact = `The ${marker} project's fiscal year starts on July 1.`;
  const a = await saveMemory(supabase, openai, identity, { content: fact, kind: "fact", importance: 4 }, { settings });
  created.add(a.memory?.id);
  check("first save creates", a.action === "created" && a.memory?.status === "active", a.action);

  const b = await saveMemory(supabase, openai, identity, { content: `  the ${marker} project's FISCAL year starts on july 1 ` }, { settings });
  check("same fact again is a duplicate, one row", b.action === "duplicate" && b.memory?.id === a.memory.id, b.action);

  const c = await saveMemory(supabase, openai, identity, { content: `The ${marker} project's fiscal year begins on July 1.`, kind: "fact" }, { settings });
  created.add(c.memory?.id);
  check("near duplicate supersedes the old row", c.action === "superseded" && c.memory?.supersedes_id === a.memory.id, c.action);
  const old = await getMemory(supabase, identity, a.memory.id);
  check("old row marked superseded, not overwritten", old?.status === "superseded" && old?.content === a.memory.content, old?.status);

  const pref = await saveMemory(supabase, openai, identity, { content: `${marker}: prefers answers as short bullet lists with a one-line summary first.`, kind: "preference" }, { settings });
  created.add(pref.memory?.id);
  check("a different fact is created, not superseded", pref.action === "created", pref.action);

  // ---- events and attestation
  const hist = await memoryHistory(supabase, identity, c.memory.id);
  check("created event logged", hist?.events.some((e) => e.event === "created"));
  const histOld = await memoryHistory(supabase, identity, a.memory.id);
  check("superseded event logged on the old row", histOld?.events.some((e) => e.event === "superseded" && e.detail?.superseded_by === c.memory.id));
  const { data: att } = await supabase.from("attestations").select("id, stance, source_layer").eq("memory_id", c.memory.id);
  check("one attestation per write", att?.length === 1 && att[0].stance === "asserts" && att[0].source_layer === "user_explicit", JSON.stringify(att));

  // ---- list
  const listed = await listMemories(supabase, identity, { q: marker });
  check("keyword list finds the active rows", listed.some((m) => m.id === c.memory.id) && listed.some((m) => m.id === pref.memory.id) && !listed.some((m) => m.id === a.memory.id), String(listed.length));

  // ---- recall hit and miss
  const hit = await recallMemories(supabase, openai, identity, { message: `When does the ${marker} project's fiscal year start?`, settings });
  check("related question recalls the memory", hit.memoryIds.includes(c.memory.id), `${hit.memories.length} used, top sim ${hit.memories[0]?.similarity}`);
  check("recall block has the heading and one line per memory", hit.block.startsWith("MEMORY (") && hit.block.split("\n").length === hit.memories.length + 1);
  check(`block within ${settings.block_tokens} tokens and ${settings.recall_k} items`, hit.tokens <= settings.block_tokens && hit.memories.length <= settings.recall_k, `${hit.tokens} tokens`);
  check("superseded row is not recalled", !hit.memoryIds.includes(a.memory.id));

  const miss = await recallMemories(supabase, openai, identity, { message: "What is the boiling point of liquid nitrogen at sea level?", settings });
  check("unrelated question does not recall it", !miss.memoryIds.includes(c.memory.id), `${miss.memories.length} used`);

  const short = await recallMemories(supabase, openai, identity, { message: "and when does it start?", previousUserMessage: `Tell me about the ${marker} project's fiscal year`, settings });
  check("short follow-up uses the previous user message", short.query.includes(marker) && short.memoryIds.includes(c.memory.id));

  // ---- isolation: same question, other user / namespace / organization
  const otherUser = { ...identity, userId: randomUUID() };
  const asOther = await recallMemories(supabase, openai, otherUser, { message: `When does the ${marker} project's fiscal year start?`, settings });
  check("another user in the namespace: miss", !asOther.memoryIds.includes(c.memory.id), `${asOther.memories.length} used`);
  check("another user cannot fetch it by id", (await getMemory(supabase, otherUser, c.memory.id)) === null);

  const otherNs = { ...identity, namespaceId: randomUUID() };
  const asOtherNs = await recallMemories(supabase, openai, otherNs, { message: `When does the ${marker} project's fiscal year start?`, settings });
  check("another namespace: miss", asOtherNs.memories.length === 0);
  check("another namespace cannot fetch it by id", (await getMemory(supabase, otherNs, c.memory.id)) === null);

  const otherOrg = { ...identity, organizationId: randomUUID() };
  const asOtherOrg = await recallMemories(supabase, openai, otherOrg, { message: `When does the ${marker} project's fiscal year start?`, settings });
  check("another organization: miss", asOtherOrg.memories.length === 0);
  check("another organization cannot fetch it by id", (await getMemory(supabase, otherOrg, c.memory.id)) === null);

  // ---- touch (H5)
  const n = await touchMemories(supabase, identity, [c.memory.id, randomUUID()], { conversationId: null, messageId: null });
  const touched = await getMemory(supabase, identity, c.memory.id);
  check("touch bumps access_count for own ids only", n === 1 && touched?.access_count === 1 && touched?.last_accessed_at, `${n} touched`);
  const hist2 = await memoryHistory(supabase, identity, c.memory.id);
  check("recalled event logged", hist2?.events.some((e) => e.event === "recalled" && e.actor === "system:recall"));

  // ---- update
  const upd = await updateMemory(supabase, openai, identity, pref.memory.id, { importance: 5, kind: "preference" });
  check("update changes importance and logs", upd?.importance === 5 && (await memoryHistory(supabase, identity, pref.memory.id)).events.some((e) => e.event === "updated"));

  // ---- DLP
  const blocked = await saveMemory(supabase, openai, identity, { content: `${marker} SSN is 123-45-6789 for social security` }, { settings });
  check("sensitive candidate is blocked and not saved", blocked.action === "blocked" && blocked.memory === null, blocked.action);

  // ---- delete, then recall again
  const del = await deleteMemory(supabase, identity, c.memory.id);
  const gone = await supabase.from("memories").select("status, content, embedding").eq("id", c.memory.id).single();
  check("delete clears content and embedding, marks deleted", del && gone.data?.status === "deleted" && gone.data?.content === "" && gone.data?.embedding === null);
  const afterDelete = await recallMemories(supabase, openai, identity, { message: `When does the ${marker} project's fiscal year start?`, settings });
  check("deleted memory is not recalled", !afterDelete.memoryIds.includes(c.memory.id));
  check("second delete is a no-op", (await deleteMemory(supabase, identity, c.memory.id)) === false);
  const hist3 = await memoryHistory(supabase, identity, c.memory.id);
  check("deleted event logged without content", hist3?.events.some((e) => e.event === "deleted" && !e.detail));
} catch (err) {
  console.error("ERROR", err);
  failures++;
} finally {
  await cleanup();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
