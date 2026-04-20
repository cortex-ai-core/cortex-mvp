// lib/session/sessionFinalize.ts
// Step 31D — Convert session + injected context → model-ready payload

import { SessionState } from "./sessionTypes.js";

export function finalizeSessionContext(
  session: SessionState,
  injected: {
    instructions: string;
    sessionMessages: { role: string; content: string }[];
    memorySummary: string;
  },
  memoryResults?: any[]
) {
  return {
    system: injected.instructions,

    messages: injected.sessionMessages,

    memory: injected.memorySummary,

    sessionMeta: {
      messageCount: session.messageCount,
      updatedAt: session.updatedAt
    }
  };
}

