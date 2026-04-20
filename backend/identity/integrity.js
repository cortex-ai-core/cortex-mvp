// ============================================================
//  CORTÉX — IDENTITY INTEGRITY HASHING (47.6F)
// ============================================================

import crypto from "crypto";

export function computeIdentityHash(payload = {}) {
  const json = JSON.stringify(payload);
  return crypto.createHash("sha256").update(json).digest("hex");
}
