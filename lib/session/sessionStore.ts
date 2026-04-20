// lib/session/sessionStore.ts

import { SessionState } from "./sessionTypes.js";

let session: SessionState = {
  history: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messageCount: 0
};

export function getSession(): SessionState {
  return session;
}

export function saveSession(newSession: SessionState): void {
  session = newSession;
}

