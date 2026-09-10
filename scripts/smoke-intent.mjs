#!/usr/bin/env node
// =============================================================
//  Intent module check: classifies sample messages with the model and
//  with the rules fallback, side by side. No server needed.
//
//    node scripts/smoke-intent.mjs ["a message of your own"]
// =============================================================

import "../backend/lib/env.js";
import OpenAI from "openai";
import { classifyIntent, decodeIntentByRules } from "../backend/reasoning/intent.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const own = process.argv.slice(2).join(" ").trim();

const SAMPLES = own ? [{ m: own, want: "?" }] : [
  { m: "Draft a one-page executive brief from the current knowledge base", want: "draft / knowledge_base" },
  { m: "What do we have on the internship program?", want: "question / topic" },
  { m: "Summarize the Operations Playbook", want: "summary / document" },
  { m: "What does the LEE 3311 document cover?", want: "summary|question / document" },
  { m: "Compare Brad's resume against the internship job description", want: "compare / documents" },
  { m: "How many credits does the teacher education program require?", want: "lookup / topic" },
  { m: "Give me an overview of everything we have uploaded", want: "summary / knowledge_base" },
  { m: "Rewrite this to sound more formal: We regret to inform you that the shipment is late.", want: "rewrite / none" },
  { m: "Write an email to Ariel asking for the revised SOW by Friday", want: "communication / none|topic" },
  { m: "Remember that our fiscal year starts July 1", want: "remember / none" },
  { m: "thanks, that's all for today", want: "general / none" },
  { m: "Repeat exactly: The quick brown fox", want: "literal / none" },
];

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("message", 62), pad("model", 26), pad("rules", 26), "expected");
for (const { m, want } of SAMPLES) {
  const t0 = Date.now();
  const model = await classifyIntent(m, { openai, hasAttachment: false });
  const rules = decodeIntentByRules(m);
  const fmt = (i) => `${i.type}/${i.scope}${i.needsEvidence ? "*" : ""}`;
  console.log(pad(m.slice(0, 60), 62), pad(`${fmt(model)} ${model.source === "model" ? `${Date.now() - t0}ms` : "(rules!)"}`, 26), pad(fmt(rules), 26), want);
}
console.log("\n* = needs evidence");
