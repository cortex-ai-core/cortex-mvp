// =============================================================
//  Retention schema probe (migration 0013).
//
//  Until 0013 is applied, conversation_archives and the hold/purge
//  columns do not exist. Everything retention-related asks here
//  before it reads or writes them, so the backend runs unchanged on a
//  database without the migration: the sweep stays idle, the delete
//  route falls back to today's cascade, and archived threads simply
//  never appear. Probed once per process; forget with
//  invalidateRetentionSchema() after the migration is run.
// =============================================================

let status = null;        // null = not probed yet; then { ready, checkedAt, reason }
let probe = null;         // in-flight promise so concurrent callers share one query

// 42P01 undefined table, 42703 undefined column, PGRST205 / PGRST204
// the same two as PostgREST reports them from its schema cache.
const MISSING = /relation .* does not exist|42P01|PGRST205|column .* does not exist|42703|PGRST204/i;

/**
 * True when migration 0013 is present. Never throws; a failed probe
 * reports not ready and is retried on the next call.
 */
export async function retentionSchemaReady(supabase, log) {
  if (status?.ready) return true;
  if (status && Date.now() - status.checkedAt < 60_000) return false;
  if (probe) return probe;
  probe = (async () => {
    try {
      if (!supabase) throw new Error("no database client");
      // One row at most from the new table and from a new column on each
      // altered table. Plain selects, not HEAD requests: PostgREST answers
      // a HEAD on a missing table with 204 and on a missing column with an
      // empty message, so only a real select carries the Postgres error.
      const [archives, threads, memories, traces] = await Promise.all([
        supabase.from("conversation_archives").select("conversation_id").limit(1),
        supabase.from("conversations").select("purged_at, legal_hold").limit(1),
        supabase.from("memories").select("source_purged_at").limit(1),
        supabase.from("rag_queries").select("text_purged_at").limit(1),
      ]);
      const failed = [archives, threads, memories, traces].find((r) => r.error);
      if (failed) {
        const code = String(failed.error.code || "");
        const msg = failed.error.message || code || JSON.stringify(failed.error);
        const reason = MISSING.test(msg) || MISSING.test(code) ? `migration 0013 not applied (${msg})` : `probe failed: ${msg}`;
        status = { ready: false, checkedAt: Date.now(), reason };
        log?.info?.({ reason }, "retention: schema not ready; retention features idle");
        return false;
      }
      status = { ready: true, checkedAt: Date.now(), reason: null };
      log?.info?.("retention: schema ready (migration 0013 present)");
      return true;
    } catch (err) {
      status = { ready: false, checkedAt: Date.now(), reason: err?.message || "probe threw" };
      log?.warn?.({ err: err?.message }, "retention: schema probe failed; retention features idle");
      return false;
    } finally {
      probe = null;
    }
  })();
  return probe;
}

/** What the last probe found, for the boot log and a status route. */
export function retentionSchemaStatus() {
  return status ? { ...status } : { ready: false, checkedAt: null, reason: "not probed" };
}

/** Forget the cached answer, e.g. after running the migration without a restart. */
export function invalidateRetentionSchema() {
  status = null;
}
