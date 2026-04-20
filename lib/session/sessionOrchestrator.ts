// lib/session/sessionOrchestrator.ts
// Step 31F — Unified Session Engine

import { getSession, saveSession } from "./sessionStore.js";
import { updateSessionState } from "./sessionUpdater.js";
import { buildInjectedContext } from "./sessionInjector.js";
import { finalizeSessionContext } from "./sessionFinalize.js";
import { queryMemory } from "../memory/queryMemory.js";

export async function prepareCortexSession(userMessage: string) {
  // 1. Load session
  const session = getSession();

  // 2. Update session with new user message
  const updatedSession = updateSessionState(session, userMessage);

  // 3. Query memory
  const memoryResults = await queryMemory({ query: userMessage, topK: 5 });

  // 4. Build injected context
  const injected = buildInjectedContext(updatedSession, memoryResults);

  // 5. Finalize payload
  const payload = finalizeSessionContext(updatedSession, injected);

  // 6. Persist updated session
  saveSession(updatedSession);

  // 7. Return payload to chat route
  return payload;
}

