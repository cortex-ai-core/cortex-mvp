// ============================================================
//  CORTÉX — IDENTITY INJECTION LAYER 
//  (47.2 + 47.5A + 47.6C + 47.6D + 47.6F FINAL VERSION)
// ============================================================

import { identitySchema, validateIdentity } from "./schema.js";
import { applyDoctrine } from "./doctrine.js";
import { toneContracts } from "./toneContracts.js";
import { computeIdentityHash } from "./integrity.js";

// ============================================================
//  APPLY IDENTITY TO REASONING OUTPUT
// ============================================================

export function applyIdentityLayer(reasoningOutput = {}, identityInput = {}, meta = {}) {
  // Final merged persona
  const persona = validateIdentity(identityInput);

  // Extract reasoning chain values
  const {
    intent = "",
    fusedEvidence = {},
    inferencePaths = [],
    userMessage = "",
    finalAnswer = ""
  } = reasoningOutput;

  // ============================================================
  //  PRIMARY DOCTRINE PASS (47.5A)
  // ============================================================

  let transformedAnswer = applyDoctrine(finalAnswer);

  // ============================================================
  //  APPLY TONE LOGIC (AFTER PRIMARY DOCTRINE)
  // ============================================================

  if (persona.toneMode === "king") {
    transformedAnswer = enforceKingTone(transformedAnswer);
  } else if (persona.toneMode === "ceo") {
    transformedAnswer = enforceCEOTone(transformedAnswer);
  } else if (persona.toneMode === "advisory") {
    transformedAnswer = enforceAdvisoryTone(transformedAnswer);
  } else if (persona.toneMode === "cybersecurity") {
    transformedAnswer = enforceCyberTone(transformedAnswer);
  } else if (persona.toneMode === "recruiting") {
    transformedAnswer = enforceRecruitingTone(transformedAnswer);
  } else if (persona.toneMode === "dataManagement") {
    transformedAnswer = enforceDataManagementTone(transformedAnswer);
  } else if (persona.toneMode === "ventures") {
    transformedAnswer = enforceVenturesTone(transformedAnswer);
  }

  // ============================================================
  //  DOCTRINE REINFORCEMENT PASS (47.6C)
  // ============================================================
  transformedAnswer = applyDoctrine(transformedAnswer);

  // ============================================================
  //  TONE CONTRACT PROTECTION (47.6D)
  // ============================================================
  const contract = toneContracts[persona.toneMode] || {};

  if (contract.protect && Array.isArray(contract.protect)) {
    for (const pattern of contract.protect) {
      const original = reasoningOutput.finalAnswer.match(pattern);
      if (original) {
        transformedAnswer = transformedAnswer.replace(pattern, original[0]);
      }
    }
  }

  // ============================================================
  //  47.6F — IDENTITY INTEGRITY HASH
  // ============================================================

  const timestamp = new Date().toISOString();
  const namespace = meta.namespace || "unknown";

  const integrityPayload = {
    finalAnswer: transformedAnswer,
    persona: persona.corePersona,
    tone: persona.toneMode,
    namespace,
    intent,
    timestamp
  };

  const identityIntegrityHash = computeIdentityHash(integrityPayload);

  // ============================================================
  //  BUILD FINGERPRINT
  // ============================================================

  const fingerprints = {
    persona: persona.corePersona,
    tone: persona.toneMode,
    authority: persona.responseFingerprint.authority,
    structure: persona.responseFingerprint.structure
  };

  // ============================================================
  //  RETURN FINAL OUTPUT (IDENTITY INJECTED + SIGNED)
// ============================================================

  return {
    finalAnswer: transformedAnswer,
    persona,
    fingerprints,
    integrity: {
      timestamp,
      namespace,
      identityIntegrityHash
    },
    reasoning: {
      intent,
      fusedEvidence,
      inferencePaths,
      userMessage
    }
  };
}

// ============================================================
//  TONE ENFORCEMENT UTILITIES
// ============================================================

// KING mode — sovereign, concise, authoritative
function enforceKingTone(text) {
  return text
    .replace(/\bi think\b/gi, "I conclude")
    .replace(/\bmaybe\b/gi, "with certainty")
    .replace(/\bprobably\b/gi, "with precision")
    .trim();
}

// CEO mode — identical to KING
function enforceCEOTone(text) {
  return enforceKingTone(text);
}

// Advisory — structured, analytical
function enforceAdvisoryTone(text) {
  return `Advisory Insight:\n${text}`;
}

// Cybersecurity — threat-focused, direct
function enforceCyberTone(text) {
  return `Cybersecurity Analysis:\n${text}`;
}

// Recruiting — people, fit, alignment
function enforceRecruitingTone(text) {
  return `Recruiting Insight:\n${text}`;
}

// Data Management — structured, metadata-focused
function enforceDataManagementTone(text) {
  return `Data Management Perspective:\n${text}`;
}

// Ventures — opportunity-focused, strategic
function enforceVenturesTone(text) {
  return `Ventures Analysis:\n${text}`;
}
