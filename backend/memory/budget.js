// =============================================================
//  Token budgets for the prompt. Estimates only: about four
//  characters per token for English prose, which is close enough to
//  keep the history and memory blocks under their caps (design doc
//  ground rule 8). Nothing here calls a tokenizer.
// =============================================================

export function estimateTokens(text = "") {
  return Math.ceil(String(text ?? "").length / 4);
}

export function messageTokens(m) {
  // a few tokens of framing per turn on top of the content
  return estimateTokens(m?.content) + 4;
}

/**
 * Keep the newest messages that fit: at most `maxMessages`, and at most
 * `maxTokens` in total. Whole messages only. Returns them in original
 * (oldest-first) order with the number dropped.
 */
export function fitNewest(messages = [], { maxMessages = Infinity, maxTokens = Infinity } = {}) {
  const kept = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const t = messageTokens(m);
    if (kept.length >= maxMessages) break;
    if (tokens + t > maxTokens && kept.length) break;
    if (tokens + t > maxTokens) break;          // even a single message over the cap is left out
    kept.push(m);
    tokens += t;
  }
  kept.reverse();
  return { messages: kept, tokens, dropped: messages.length - kept.length };
}

/** Cut text to roughly `maxTokens`, at a sentence or line boundary when one is near the end. */
export function clipToTokens(text = "", maxTokens = 300) {
  const s = String(text ?? "");
  const maxChars = maxTokens * 4;
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"));
  return (cut > maxChars * 0.6 ? head.slice(0, cut + 1) : head).trimEnd() + " …";
}
