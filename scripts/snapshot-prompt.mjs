#!/usr/bin/env node
// =============================================================
//  Prompt snapshot: renders the synthesis prompt for a fixed input
//  without calling OpenAI, so a change to synthesis.js or to a persona
//  can be diffed byte for byte (plan 11.3, Phase 2 gate).
//
//    node scripts/snapshot-prompt.mjs [--out file] [--note "text"] [--tone advisory]
//                                     [--config file.json | --persona core_executive]
//
//  --config renders a configuration file through backend/pcl/render.js;
//  --persona loads the newest version of a shared persona from the
//  database in .env (SUPABASE_URL / SUPABASE_SERVICE_KEY). Without either
//  the prompt uses the built-in default. Prints the system prompt and
//  the user prompt with dividers; with --out writes them to a file.
// =============================================================

import "../backend/lib/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { synthesizeFinalAnswer } from "../backend/reasoning/synthesis.js";
import { newUsage } from "../backend/lib/usage.js";
import { validateConfiguration } from "../backend/pcl/validate.js";
import { renderConfiguration } from "../backend/pcl/render.js";

const args = process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc[a.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true";
  return acc;
}, {});

let pcl = null;
let label = "built-in default";
if (args.config || args.persona) {
  let configuration, personaName = args.persona || "config", version = 1;
  if (args.config) {
    configuration = JSON.parse(readFileSync(args.config, "utf8"));
  } else {
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: p, error } = await supabase.from("personas").select("id, name").is("organization_id", null).eq("key", args.persona).maybeSingle();
    if (error || !p) { console.error(`persona "${args.persona}" not found: ${error?.message || "no row"}`); process.exit(1); }
    const { data: ver } = await supabase.from("pcl").select("version, configuration").eq("persona_id", p.id).order("version", { ascending: false }).limit(1).maybeSingle();
    configuration = ver?.configuration || {};
    personaName = p.name; version = ver?.version || 0;
  }
  const check = validateConfiguration(configuration);
  if (!check.ok) { console.error("configuration does not validate:\n  " + check.errors.join("\n  ")); process.exit(1); }
  pcl = renderConfiguration(check.normalized, { personaName, version });
  label = `${personaName} v${version} (${pcl.chars} chars)`;
}
if (args.note) pcl = { ...(pcl || {}), personalization: args.note };

const captured = [];
const fakeModel = {
  chat: {
    completions: {
      async create({ messages }) {
        captured.push(messages);
        return { choices: [{ message: { content: "snapshot" } }], usage: { prompt_tokens: 0, completion_tokens: 0 } };
      },
    },
  },
};

await synthesizeFinalAnswer({
  intent: "general",
  userMessage: "What does the LEE 3311 document cover?",
  contextWindow: "[1] LEE 3311 syllabus — page 1 — Overview\nLEE 3311 is a three-credit course on leadership in engineering teams.",
  model: fakeModel,
  identityContext: { role: "admin", namespace: "core", tone: args.tone || "neutral" },
  priorMessages: [],
  conversationSummary: null,
  memoryBlock: null,
  pcl,
  usage: newUsage(),
});

const messages = captured[0] || [];
const text = messages.map(m => `===== ${m.role.toUpperCase()} =====\n${m.content}`).join("\n\n") + "\n";

if (args.out) {
  writeFileSync(args.out, text, "utf8");
  console.log(`wrote ${args.out} (${text.length} chars, ${messages.length} messages) · ${label}`);
} else {
  process.stdout.write(text);
}
