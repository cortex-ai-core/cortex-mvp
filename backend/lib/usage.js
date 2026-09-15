// =============================================================
//  Token usage and cost per turn (design doc P4.4: cost per turn in
//  the eval report).
//
//  A tally is a plain object every model call of one chat turn adds
//  itself to: which stage made the call, which model, how many tokens
//  in and out, and what that cost at list price. The chat route sends
//  the synchronous part back with the answer and writes the whole
//  thing, including the calls made after the reply (extraction, the
//  summariser), to the turn's trace row.
//
//  Prices are USD per million tokens at list price. Input tokens the
//  API reports as served from its prompt cache are priced at the
//  cached rate (plan 8.4). No batch discounts. Override or extend with
//  MODEL_PRICES_JSON, e.g. {"gpt-5.1":{"input":1.25,"cached":0.125,"output":10}}.
// =============================================================

const DEFAULT_PRICES = {
  "gpt-5.1":                { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5":                  { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5-mini":             { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5-nano":             { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-4.1":                { input: 2, cached: 0.5, output: 8 },
  "gpt-4.1-mini":           { input: 0.4, cached: 0.1, output: 1.6 },
  "gpt-4.1-nano":           { input: 0.1, cached: 0.025, output: 0.4 },
  "gpt-4o":                 { input: 2.5, cached: 1.25, output: 10 },
  "gpt-4o-mini":            { input: 0.15, cached: 0.075, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

let prices = null;
function priceTable() {
  if (prices) return prices;
  prices = { ...DEFAULT_PRICES };
  const raw = process.env.MODEL_PRICES_JSON;
  if (raw) {
    try {
      for (const [model, p] of Object.entries(JSON.parse(raw))) {
        if (p && Number.isFinite(Number(p.input))) prices[model] = { input: Number(p.input), output: Number(p.output) || 0, ...(Number.isFinite(Number(p.cached)) ? { cached: Number(p.cached) } : {}) };
      }
    } catch { /* a bad override keeps the defaults */ }
  }
  return prices;
}

/** Price row for a model id; dated snapshots ("gpt-5.1-2026-01-01") fall back to their base id. */
export function priceFor(model) {
  const table = priceTable();
  const id = String(model || "");
  if (table[id]) return table[id];
  const base = Object.keys(table).filter((k) => id.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return base ? table[base] : null;
}

/**
 * USD for one call, or null when the model's price is unknown.
 * `cachedTokens` is the part of the input the API served from its
 * prompt cache; it is priced at the cached rate (or full price when
 * the model has no cached rate listed).
 */
export function costOf(model, inputTokens = 0, outputTokens = 0, cachedTokens = 0) {
  const p = priceFor(model);
  if (!p) return null;
  const input = Number(inputTokens) || 0;
  const cached = Math.min(Math.max(Number(cachedTokens) || 0, 0), input);
  const cachedRate = Number.isFinite(p.cached) ? p.cached : p.input;
  return ((input - cached) * p.input + cached * cachedRate + (Number(outputTokens) || 0) * p.output) / 1_000_000;
}

/** A fresh tally for one turn. */
export function newUsage() {
  return { calls: [], input: 0, cached: 0, output: 0, usd: 0, unpriced: 0 };
}

/**
 * Add one model call. `usage` is the SDK's usage object
 * ({prompt_tokens, completion_tokens} or {input_tokens, output_tokens}),
 * whose prompt_tokens_details.cached_tokens (Chat Completions) or
 * input_tokens_details.cached_tokens (Responses) says how much of the
 * input the prompt cache served. Never throws; a missing usage object
 * records a call with zero tokens.
 */
export function recordUsage(tally, stage, model, usage = null, extra = {}) {
  if (!tally || typeof tally !== "object") return null;
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  const cached = Math.min(Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? 0) || 0, input);
  const usd = costOf(model, input, output, cached);
  const call = { stage, model: String(model || ""), input, cached, output, usd: usd == null ? null : round(usd), ...extra };
  tally.calls.push(call);
  tally.input += input;
  tally.cached = (tally.cached || 0) + cached;
  tally.output += output;
  if (usd == null) tally.unpriced += 1; else tally.usd = round(tally.usd + usd);
  return call;
}

/** Fold another tally's calls into this one (extraction, summariser). */
export function mergeUsage(into, from) {
  if (!into || !from) return into;
  for (const c of from.calls || []) recordUsage(into, c.stage, c.model, { prompt_tokens: c.input, completion_tokens: c.output, prompt_tokens_details: { cached_tokens: c.cached || 0 } });
  return into;
}

/** The shape stored on the trace and sent to the client. */
export function usageSummary(tally, extra = {}) {
  if (!tally) return null;
  return {
    calls: tally.calls.map((c) => ({ ...c })),     // a snapshot: the tally keeps growing after the reply
    input: tally.input,
    cached: tally.cached || 0,
    output: tally.output,
    usd: round(tally.usd),
    ...(tally.unpriced ? { unpriced_calls: tally.unpriced } : {}),
    ...extra,
  };
}

function round(usd) {
  return Math.round(usd * 1e6) / 1e6;
}
