// ============================================================
//  CORTÉX — DOCTRINE KERNEL (Step 47.5A)
//  Central registry for KING linguistic + behavioral doctrine
// ============================================================

// --------------------------------------
// Priority-ordered transformation rules
// --------------------------------------
export const doctrineMatrix = [
  // 1. Remove weak uncertainty language
  {
    pattern: /\bi think\b/gi,
    replacement: "I conclude"
  },
  {
    pattern: /\bmaybe\b/gi,
    replacement: "with certainty"
  },
  {
    pattern: /\bprobably\b/gi,
    replacement: "with precision"
  },

  // 2. Strengthen passive language
  {
    pattern: /\bit seems\b/gi,
    replacement: "I determine"
  },
  {
    pattern: /\bI guess\b/gi,
    replacement: "I assert"
  },

  // 3. Remove self-diminishing qualifiers
  {
    pattern: /\bjust\b/gi,
    replacement: ""
  },
  {
    pattern: /\bsort of\b/gi,
    replacement: ""
  },
  {
    pattern: /\bkinda\b/gi,
    replacement: ""
  },

  // 4. KING authority reinforcement
  {
    pattern: /\bI believe\b/gi,
    replacement: "I conclude with certainty"
  },
  {
    pattern: /\bI feel\b/gi,
    replacement: "I assess"
  },

  // 5. Clean double spaces after replacements
  {
    pattern: /  +/g,
    replacement: " "
  }
];

// --------------------------------------
// Apply doctrine matrix to text
// --------------------------------------
export function applyDoctrine(text = "") {
  let output = text;

  for (const rule of doctrineMatrix) {
    output = output.replace(rule.pattern, rule.replacement);
  }

  return output.trim();
}
