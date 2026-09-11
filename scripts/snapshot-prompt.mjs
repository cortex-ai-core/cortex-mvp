#!/usr/bin/env node
// =============================================================
//  Prompt snapshot: renders the synthesis prompt for a fixed input
//  without calling OpenAI, so a change to synthesis.js can be diffed
//  byte for byte (PCL plan, Phase 0 gate and 12.2).
//
//    node scripts/snapshot-prompt.mjs [--out file] [--note "text"] [--tone advisory]
//
//  Prints the system prompt and the user prompt with a divider; with
//  --out writes them to a file instead.
// =============================================================

import { writeFileSync } from "node:fs";
import { synthesizeFinalAnswer } from "../backend/reasoning/synthesis.js";
import { newUsage } from "../backend/lib/usage.js";

const args = process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc[a.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true";
  return acc;
}, {});

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

const pcl = args.note ? { personalization: args.note } : null;

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
  console.log(`wrote ${args.out} (${text.length} chars, ${messages.length} messages)`);
} else {
  process.stdout.write(text);
}
