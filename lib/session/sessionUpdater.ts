// lib/session/sessionUpdater.ts

import { SessionState, MessageEntry } from "./sessionTypes.js";

export function updateSessionState(
  session: SessionState,
  userMessage: string
): SessionState {
  
  const newEntry: MessageEntry = {
    role: "user",
    content: userMessage,
    timestamp: Date.now()
  };

  return {
    ...session,
    history: [...session.history, newEntry],
    updatedAt: Date.now(),
    messageCount: session.messageCount + 1
  };
}

