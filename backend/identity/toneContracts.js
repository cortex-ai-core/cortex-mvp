// ============================================================
//  CORTÉX — TONE CONTRACTS (Step 47.6D)
// ============================================================

export const toneContracts = {
  king: {
    protect: [],  // KING doctrine applies fully
  },

  ceo: {
    protect: [],  // CEO identical to KING
  },

  advisory: {
    protect: [
      /roi/gi,
      /kpi/gi,
      /benchmark/gi,
      /analysis/gi,
      /strategy/gi,
    ],
  },

  cybersecurity: {
    protect: [
      /attack vector/gi,
      /exploit/gi,
      /mitigation/gi,
      /zero[- ]day/gi,
      /cve[- ]\d+/gi,
    ],
  },

  recruiting: {
    protect: [
      /culture fit/gi,
      /candidate/gi,
      /retention/gi,
    ],
  },

  dataManagement: {
    protect: [
      /metadata/gi,
      /schema/gi,
      /normalization/gi,
      /pipeline/gi,
    ],
  },

  ventures: {
    protect: [
      /market cap/gi,
      /valuation/gi,
      /funding round/gi,
    ],
  },
};
