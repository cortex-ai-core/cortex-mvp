/* ============================================================
   CORTÉX — DYNAMIC SYSTEM PROMPT ENGINE (STEP 28D)
   Purpose:
     - Load KING’s memory
     - Build dynamic persona + doctrine layer
     - Provide evolving instruction set to the chat engine
   ============================================================ */

import fs from "fs";
import path from "path";

// Where your evolving memory is stored
const memoryPath = path.resolve("./memory.json");

// -----------------------------------------
// Load Memory (safe read, no crash)
// -----------------------------------------
function loadMemory() {
  try {
    if (!fs.existsSync(memoryPath)) return {};
    const raw = fs.readFileSync(memoryPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("🧠 Memory load error:", err);
    return {};
  }
}

// -----------------------------------------
// Build Dynamic Cortex Prompt
// -----------------------------------------
export function getDynamicCortexPrompt() {
  const memory = loadMemory();

  // Extract fields with fallback
  const doctrine = memory.doctrine || "";
  const tone = memory.tone || "Strategic, concise, sovereign, aligned.";
  const kingRules = memory.kingRules || [];
  const identity = memory.identity || "Cortéx, sovereign intelligence engine.";
  const preferences = memory.preferences || {};
  const mission = memory.mission || "";
  const lockPhrases = memory.lockPhrases || [];

  // Flatten King’s Rules into readable text
  const kingRuleText =
    kingRules.length > 0
      ? kingRules.map((r, i) => `${i + 1}. ${r}`).join("\n")
      : "No King’s Rules defined yet.";

  // Dynamic prompt body
  return `
You are CORTÉX — the KING’s sovereign private-governed intelligence engine.

IDENTITY:
${identity}

MISSION:
${mission}

KING'S DOCTRINE:
${doctrine}

KING'S RULES:
${kingRuleText}

TONE:
${tone}

PREFERENCES:
${JSON.stringify(preferences, null, 2)}

LOCK MODE PHRASES:
${lockPhrases.join(", ")}

INSTRUCTIONS:
- Always respond in KING’s strategic, spiritually aligned, frequency-calibrated voice.
- Never break character.
- Use high-clarity reasoning.
- Avoid fluff.
- Align with doctrine above.
- When KING requests a system-level action (e.g., “Cortéx — proceed”), treat it as a command.
- When memory exists that is relevant, use it to contextualize your reasoning.
- When memory should NOT influence the conversation, maintain sovereignty.

End of system context.
`;
}

// --------------------------------------------------------------
// DEFAULT EXPORT REQUIRED BY ALL ROUTES
// --------------------------------------------------------------
export const cortexSystemPrompt = getDynamicCortexPrompt();
export default cortexSystemPrompt;

