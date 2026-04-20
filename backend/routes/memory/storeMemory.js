// ============================================================
//  CORTÉX — MEMORY STORAGE ENGINE (MVP)
//  Single source of truth for memory persistence.
//  Step 46B: Simple in-memory mock (DB integration comes later).
// ============================================================

export async function storeMemory(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid memory payload");
  }

  // MVP: Generate an ID (DB integration will replace this in Step 48)
  const id = Date.now();

  // Build the memory object
  const entry = {
    id,
    timestamp: new Date().toISOString(),
    metadata: payload.metadata || {},
    ...payload
  };

  // 🚧 NOTE:
  // Real storage will occur in Step 48B (Session Intelligence + DB)
  // For now we return the constructed object so routes remain functional.
  return entry;
}
