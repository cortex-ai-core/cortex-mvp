// =============================================================
//  System One client: typed decisions from a decision model rather
//  than a chat model. Kev (self-hosted, kev/ sidecar) and TypeSafe's
//  Jev serve the same API, so the provider is a URL and a key:
//
//    SYSTEMONE_URL      https://api.typesafe.ai (Jev, the default) or a Kev sidecar (kev/)
//    SYSTEMONE_API_KEY  bearer key; JEV_API_KEY is used for TypeSafe when this is empty
//    SYSTEMONE_MODEL    jev-latest (default) | kev-latest
//
//  A request carries one "state" (the text being judged) and any number
//  of questions, each choice (one of up to 255 named options), noul
//  (yes/no) or score. Every answer comes back with probabilities and a
//  calibrated confidence. See docs/KEV_PROTOTYPE.md.
//
//  Never throws: a failure returns null and the caller keeps its own
//  path. The call is recorded in the turn's usage tally when one is given.
// =============================================================

import { recordUsage } from "../lib/usage.js";

const URL_BASE = () => String(process.env.SYSTEMONE_URL || "https://api.typesafe.ai").replace(/\/+$/, "");
export const SYSTEMONE_MODEL = () => process.env.SYSTEMONE_MODEL || "jev-latest";
const TIMEOUT_MS = () => Number(process.env.DECISIONS_TIMEOUT_MS || 800);

/**
 * Ask a set of typed questions about one state.
 *
 * @param {string|object} state
 * @param {Record<string, {type: "choice"|"noul"|"score", instructions?: string, criteria?: any}>} questions
 * @param {{ stage?: string, usage?: object, log?: object, timeoutMs?: number }} opts
 * @returns {Promise<null | { answers: Record<string, object>, ms: number, modelMs: number|null, inputTokens: number, model: string }>}
 */
export async function systemOne(state, questions, { stage = "decision", usage = null, log = null, timeoutMs = null } = {}) {
  const model = SYSTEMONE_MODEL();
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? TIMEOUT_MS());
  try {
    // JEV_API_KEY is sent only to TypeSafe's own endpoint, never to a local Kev
    const key = process.env.SYSTEMONE_API_KEY || (/\.typesafe\.ai$/i.test(new URL(URL_BASE()).hostname) ? process.env.JEV_API_KEY : "");
    const res = await fetch(`${URL_BASE()}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, state, questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const ms = Date.now() - t0;
    const inputTokens = Number(body?.usage?.input_tokens) || 0;
    recordUsage(usage, stage, model, { input_tokens: inputTokens, output_tokens: 0 }, { ms });
    return { answers: body?.answers || {}, ms, modelMs: Number.isFinite(body?.latency_ms) ? body.latency_ms : null, inputTokens, model };
  } catch (err) {
    log?.warn?.({ stage, err: err?.name === "AbortError" ? `timed out after ${Date.now() - t0} ms` : err?.message }, "decision: System One call failed; keeping the existing path");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The chosen option of a choice answer, its probability and confidence; null when absent. */
export function choiceOf(answer) {
  if (!answer || typeof answer.choice !== "string") return null;
  const p = answer.probabilities?.[answer.choice];
  return { value: answer.choice, p: Number.isFinite(p) ? p : null, confidence: Number.isFinite(answer.confidence) ? answer.confidence : null, probabilities: answer.probabilities || {} };
}

/** Probability of "yes" for a noul answer; null when absent. */
export function noulOf(answer) {
  const p = Number(answer?.noul);
  return Number.isFinite(p) ? p : null;
}

// ------------------------------------------------------------ flags
//  DECISIONS_<NAME> = off | shadow | on (docs/KEV_PROTOTYPE.md §2)
//    off     the existing path only; no call is made
//    shadow  the existing path decides; the decision model runs beside it and is logged
//    on      the decision model decides, escalating below its threshold

const MODES = new Set(["off", "shadow", "on"]);

/** Mode of one decision, read on every call so a test can change it. */
export function decisionMode(name) {
  const v = String(process.env[`DECISIONS_${name}`] || "off").toLowerCase();
  return MODES.has(v) ? v : "off";
}

/** A numeric threshold from the environment, with a default. */
export function threshold(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
