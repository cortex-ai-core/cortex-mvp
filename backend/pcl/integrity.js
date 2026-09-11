// ============================================================
//  Integrity hashing. Kept from the identity layer (47.6F) so the
//  hash the customer's spec asks for survives the move: a persona
//  version's rendered text hashes to one value, and the trace carries
//  it, so "which rules produced this answer" is checkable later.
// ============================================================

import crypto from "node:crypto";

export function computeIdentityHash(payload = {}) {
  const json = JSON.stringify(payload);
  return crypto.createHash("sha256").update(json).digest("hex");
}

export function sha256Text(text = "") {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}
