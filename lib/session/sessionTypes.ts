// lib/session/sessionTypes.ts

export interface MessageEntry {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface SessionState {
  history: MessageEntry[];
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

