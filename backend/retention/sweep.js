// =============================================================
//  The retention sweep (plan 5.3): day 31 happens on its own.
//
//  One pass, per namespace with a finite policy and no hold:
//    1. threads past the cutoff by last activity, oldest first, up to
//       the batch: empty ones are deleted, the rest archived
//       (archive.js: summary, transaction, trace scrub, event)
//    2. thread-less trace rows older than the trace cutoff lose their
//       question text
//    3. one retention_sweep event per organization touched
//
//  Runs inside the backend like the ingest worker, every
//  RETENTION_SWEEP_MINUTES (60; 0 disables), and from
//  scripts/retention-sweep.mjs with --dry-run, which reports what it
//  would do and writes nothing. A model failure defers a thread to the
//  next pass; archive.js turns the third failure into a metadata-only
//  record. Idle until migration 0013 is present.
// =============================================================

import { retentionSchemaReady } from "./schema.js";
import { listRetentionPolicies } from "./policy.js";
import { archiveConversation } from "./archive.js";
import { scrubTraces, scrubTracesOlderThan } from "../retrieval/trace.js";
import { newUsage, usageSummary } from "../lib/usage.js";

const num = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : dflt; };
export const SWEEP_MINUTES = num("RETENTION_SWEEP_MINUTES", 60);
export const SWEEP_BATCH = Math.max(1, num("RETENTION_SWEEP_BATCH", 50));
const INITIAL_DELAY_MS = num("RETENTION_SWEEP_INITIAL_DELAY_MS", 30_000);
// Daily mode: one pass a day at this wall-clock time in this zone,
// looping in batches until the queue is empty. Unset = the interval above.
export const SWEEP_AT = String(process.env.RETENTION_SWEEP_AT || "").trim();
export const SWEEP_TZ = String(process.env.RETENTION_SWEEP_TZ || "UTC").trim() || "UTC";
const MAX_DAILY_LOOPS = num("RETENTION_SWEEP_MAX_LOOPS", 100);

/** Milliseconds this zone is ahead of UTC at the given instant. */
function tzOffsetMs(instant, tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const p = Object.fromEntries(parts.filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of a wall-clock date and time in a zone (DST-aware, one correction pass). */
function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffsetMs(new Date(guess), tz);
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

/**
 * The next instant at which it is `at` ("HH:MM") in `tz`, strictly after
 * `now`. Returns null for an invalid time or zone.
 */
export function nextRunAt(at, tz = "UTC", now = new Date()) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(at || "").trim());
  if (!m) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return null; }
  const [h, mi] = [Number(m[1]), Number(m[2])];
  const local = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const p = Object.fromEntries(local.filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  let candidate = zonedToUtc(p.year, p.month, p.day, h, mi, tz);
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    candidate = zonedToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), h, mi, tz);
  }
  return candidate;
}

/** Threads of one namespace past its cutoff, oldest first. */
async function candidates(supabase, policy, limit) {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, organization_id, namespace_id, user_id, title, message_count, last_message_at, created_at, metadata")
    .eq("namespace_id", policy.namespaceId)
    .is("archived_at", null)
    .eq("legal_hold", false)
    .or(`last_message_at.lt.${policy.cutoff},and(last_message_at.is.null,created_at.lt.${policy.cutoff})`)
    .order("last_message_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`retention: candidates failed: ${error.message}`);
  return data || [];
}

/** An empty thread has nothing to summarise: it goes, with any stray trace text. */
async function deleteEmpty(supabase, thread, { dryRun, log, actor }) {
  if (dryRun) return true;
  const traces = await scrubTraces(supabase, log, { conversationId: thread.id });
  const { error } = await supabase.from("conversations").delete().eq("id", thread.id).is("archived_at", null).eq("legal_hold", false);
  if (error) { log?.warn?.({ err: error.message, conversationId: thread.id }, "retention: empty thread delete failed"); return false; }
  await supabase.from("memory_events").insert([{
    event: "conversation_purged", actor,
    actor_organization_id: thread.organization_id, target_organization_id: thread.organization_id, target_user_id: thread.user_id,
    conversation_id: thread.id, detail: { empty: true, messages: 0, traces_scrubbed: traces },
  }]).then(({ error: e }) => { if (e) log?.warn?.({ err: e.message }, "retention: event log failed"); });
  return true;
}

/**
 * One pass. Returns a report; never throws for one thread's failure.
 * @param {{ dryRun?, organizationId?, limit?, log?, actor?, show? }} opts
 */
export async function runRetentionSweep(supabase, openai, { dryRun = false, organizationId = null, limit = SWEEP_BATCH, log = null, actor = "system:retention", show = false } = {}) {
  const t0 = Date.now();
  const report = { ran_at: new Date().toISOString(), dry_run: dryRun, ready: true, namespaces: [], totals: { candidates: 0, archived: 0, fallback: 0, deferred: 0, deleted_empty: 0, held: 0, traces_scrubbed: 0, usd: 0 }, samples: [], ms: 0 };
  if (!(await retentionSchemaReady(supabase, log))) { report.ready = false; report.ms = Date.now() - t0; return report; }

  const policies = await listRetentionPolicies(supabase, { organizationId, log });
  let remaining = Math.max(1, limit);
  const perOrg = new Map();
  const bump = (orgId, k, n = 1) => { const o = perOrg.get(orgId) || { archived: 0, fallback: 0, deferred: 0, deleted_empty: 0, held: 0, traces_scrubbed: 0, usd: 0 }; o[k] += n; perOrg.set(orgId, o); };

  for (const policy of policies) {
    const row = { namespace_id: policy.namespaceId, namespace: policy.namespaceName, organization_id: policy.organizationId, days: policy.days, source: policy.source, cutoff: policy.cutoff, hold: policy.hold, candidates: 0, archived: 0, fallback: 0, deferred: 0, deleted_empty: 0, held: 0, traces_scrubbed: 0, usd: 0, skipped: null };
    report.namespaces.push(row);
    if (policy.hold) { row.skipped = "organization on hold"; continue; }
    if (policy.keepForever) { row.skipped = "keep forever"; continue; }
    if (remaining <= 0) { row.skipped = "batch full"; continue; }

    let threads;
    try { threads = await candidates(supabase, policy, remaining); }
    catch (err) { row.skipped = err.message; log?.warn?.({ err: err.message, namespaceId: policy.namespaceId }, "retention: candidate lookup failed"); continue; }
    row.candidates = threads.length;
    remaining -= threads.length;

    for (const thread of threads) {
      if (!thread.message_count) {
        if (await deleteEmpty(supabase, thread, { dryRun, log, actor })) { row.deleted_empty++; bump(policy.organizationId, "deleted_empty"); }
        continue;
      }
      const usage = newUsage();
      let result;
      try { result = await archiveConversation(supabase, openai, thread.id, { dryRun, usage, log, actor }); }
      catch (err) { result = { status: "error", error: err?.message }; log?.warn?.({ err: err?.message, conversationId: thread.id }, "retention: archive threw"); }
      const usd = usageSummary(usage)?.usd || 0;
      row.usd += usd; bump(policy.organizationId, "usd", usd);
      switch (result.status) {
        case "archived": case "dry_run":
          row.archived++; bump(policy.organizationId, "archived");
          if (result.fallback) { row.fallback++; bump(policy.organizationId, "fallback"); }
          if (show && report.samples.length < 5) report.samples.push({ conversation_id: thread.id, title: thread.title, fallback: result.fallback, reason: result.reason, summary_text: result.summaryText });
          break;
        case "deferred": row.deferred++; bump(policy.organizationId, "deferred"); break;
        case "held": row.held++; bump(policy.organizationId, "held"); break;
        case "empty":
          if (await deleteEmpty(supabase, thread, { dryRun, log, actor })) { row.deleted_empty++; bump(policy.organizationId, "deleted_empty"); }
          break;
        default: break;   // already_archived, not_found, error: nothing to count
      }
    }

    if (!dryRun && policy.traceCutoff) {
      const n = await scrubTracesOlderThan(supabase, log, { namespaceId: policy.namespaceId, days: policy.traceDays });
      row.traces_scrubbed = n; bump(policy.organizationId, "traces_scrubbed", n);
    }
  }

  for (const row of report.namespaces) {
    for (const k of ["candidates", "archived", "fallback", "deferred", "deleted_empty", "held", "traces_scrubbed", "usd"]) report.totals[k] += row[k];
  }
  report.totals.usd = Math.round(report.totals.usd * 1e6) / 1e6;

  if (!dryRun) {
    for (const [orgId, totals] of perOrg) {
      if (!Object.entries(totals).some(([k, v]) => k !== "usd" && v > 0)) continue;
      await supabase.from("memory_events").insert([{
        event: "retention_sweep", actor, actor_organization_id: orgId, target_organization_id: orgId,
        detail: { ...totals, usd: Math.round(totals.usd * 1e6) / 1e6, ran_at: report.ran_at },
      }]).then(({ error }) => { if (error) log?.warn?.({ err: error.message }, "retention: sweep event failed"); });
    }
  }
  report.ms = Date.now() - t0;
  log?.info?.({ dry_run: dryRun, ...report.totals, namespaces: report.namespaces.length, ms: report.ms }, "retention: sweep");
  return report;
}

/**
 * A daily pass: batches until one comes back short of the batch size
 * (the queue is empty) or the loop cap is hit. Returns the summed totals.
 */
export async function runRetentionSweepUntilDone(supabase, openai, { log = null, limit = SWEEP_BATCH, maxLoops = MAX_DAILY_LOOPS, ...rest } = {}) {
  const sum = { passes: 0, candidates: 0, archived: 0, fallback: 0, deferred: 0, deleted_empty: 0, held: 0, traces_scrubbed: 0, usd: 0 };
  for (let i = 0; i < Math.max(1, maxLoops); i++) {
    const report = await runRetentionSweep(supabase, openai, { log, limit, ...rest });
    sum.passes++;
    for (const k of Object.keys(sum)) if (k !== "passes") sum[k] += report.totals[k] || 0;
    if (!report.ready || report.totals.candidates < limit) break;
    // every candidate this pass was deferred or held: the next pass would see the same rows
    if (report.totals.archived + report.totals.deleted_empty === 0) break;
  }
  sum.usd = Math.round(sum.usd * 1e6) / 1e6;
  log?.info?.(sum, "retention: daily sweep done");
  return sum;
}

/** The in-process worker: start after listen, stop on close. */
export function createRetentionWorker(fastify) {
  const { supabase, openai, log } = fastify;
  let timer = null, inflight = null, running = false;
  const daily = Boolean(SWEEP_AT);

  const scheduleDaily = () => {
    const next = nextRunAt(SWEEP_AT, SWEEP_TZ, new Date(Date.now() + 60_000));
    if (!next) return;
    log.info({ at: SWEEP_AT, tz: SWEEP_TZ, next_run: next.toISOString(), batch: SWEEP_BATCH }, "retention: daily sweep scheduled");
    timer = setTimeout(tick, Math.max(1_000, next.getTime() - Date.now()));
  };

  const tick = async () => {
    if (inflight) return;
    inflight = (daily
      ? runRetentionSweepUntilDone(supabase, openai, { log })
      : runRetentionSweep(supabase, openai, { log })
    ).catch((err) => log.warn({ err: err?.message }, "retention: sweep failed"));
    try { await inflight; } finally { inflight = null; }
    if (!running) return;
    if (daily) scheduleDaily(); else timer = setTimeout(tick, SWEEP_MINUTES * 60_000);
  };

  return {
    start() {
      if (running) return;
      if (daily) {
        if (!nextRunAt(SWEEP_AT, SWEEP_TZ)) { log.warn({ at: SWEEP_AT, tz: SWEEP_TZ }, "retention: RETENTION_SWEEP_AT or RETENTION_SWEEP_TZ is invalid; sweep disabled"); return; }
        running = true;
        scheduleDaily();
        return;
      }
      if (!(SWEEP_MINUTES > 0)) { log.info("retention: sweep disabled (RETENTION_SWEEP_MINUTES=0)"); retentionSchemaReady(supabase, log).catch(() => {}); return; }
      running = true;
      log.info({ every_minutes: SWEEP_MINUTES, batch: SWEEP_BATCH, first_run_in_ms: INITIAL_DELAY_MS }, "retention: sweep scheduled");
      timer = setTimeout(tick, INITIAL_DELAY_MS);
    },
    async stop() {
      running = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (inflight) await inflight;
    },
    runOnce: (opts = {}) => runRetentionSweep(supabase, openai, { log, ...opts }),
  };
}
