// cortex/core/normalize.ts

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")          // normalize CRLF -> LF
    .replace(/\n{3,}/g, "\n\n")      // max double newline
    .replace(/[ \t]+/g, " ")         // collapse whitespace
    .trim();
}

export function normalizeBullets(text: string): string {
  return text
    .replace(/[•*–]/g, "-")          // unify bullet symbols
    .replace(/-\s{0,}/g, "- ")       // enforce "- " spacing
    .replace(/- -\s+/g, "- ");       // remove double bullets
}

export function repairSentenceBoundaries(text: string): string {
  return text
    .replace(/([a-zA-Z])\n([a-zA-Z])/g, "$1 $2")    // fix mid-word splits
    .replace(/([.?!])([A-Z])/g, "$1 $2");           // missing spaces after punctuation
}

export function normalizeMarkdown(text: string): string {
  return text
    .replace(/```\s*$/g, "```")      // restore closing code blocks
    .replace(/\*\*\s+(.*?)\s+\*\*/g, "**$1**")  // fix bold markers
    .replace(/`{3,}/g, "```");       // normalize code fence size
}

export function sanitizeUnicode(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, "")     // remove control chars
    .replace(/[“”]/g, '"')                     // normalize quotes
    .replace(/[‘’]/g, "'");                    // normalize apostrophes
}

export function enforceDoctrineTone(text: string): string {
  // Remove apologies
  text = text.replace(/\bI(?:'m| am) sorry\b.*?(?=\.)/gi, "");

  // Remove disclaimers
  text = text.replace(/\bAs an AI\b.*?(?=\.)/gi, "");

  // Remove hedging
  text = text.replace(/\bmaybe\b/gi, "possibly");
  text = text.replace(/\bI think\b/gi, "It appears");
  text = text.replace(/\bI guess\b/gi, "It suggests");

  return text.trim();
}

export function normalizeCortexOutput(text: string): string {
  text = normalizeWhitespace(text);
  text = normalizeBullets(text);
  text = repairSentenceBoundaries(text);
  text = normalizeMarkdown(text);
  text = sanitizeUnicode(text);
  text = enforceDoctrineTone(text);
  return text;
}

