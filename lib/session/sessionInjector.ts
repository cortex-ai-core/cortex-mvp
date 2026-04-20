// lib/session/sessionInjector.ts
// Step 31C — Build injected context for Cortéx

import { SessionState } from "./sessionTypes.js";

export function buildInjectedContext(session: SessionState, memory: any[]) {
  // Format session history into messages for the model
  const formattedMessages = session.history.map(msg => ({
    role: msg.role,
    content: msg.content
  }));

  // Build memory summary block
  const memoryBlock = memory.length
    ? memory.map(m => `• ${m.text}`).join("\n")
    : "No relevant memory retrieved.";

  return {
    instructions: "This is the contextual payload for Cortéx.",
    sessionMessages: formattedMessages,
    memorySummary: memoryBlock
  };
}

