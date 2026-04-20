// lib/session/sessionRetriever.ts

import { getSession } from "./sessionStore.js";

export function retrieveSession() {
  return getSession();
}

