# Chat retention: operator notes

Design: the Cortéx Chat Retention Plan (C:/Cortex/design/cortex-retention-plan.html).
Schema: migration 0013. Code: `backend/retention/`.

## What happens

- A conversation is **active** until its last message is older than the
  policy. Its messages, citations and running summary are all there.
- On the next sweep it is **archived**: one model call writes a structured,
  minimised summary into `conversation_archives`, and in the same database
  transaction the messages and running summary are deleted, memories the
  thread produced are stamped `source_purged_at`, and the thread row is
  stamped `archived_at` / `purged_at`. The thread's rows in `rag_queries`
  lose their question text and keep their metrics. One
  `conversation_archived` event is logged. The thread stays in the owner's
  list as read-only with the summary.
- The owner's **delete** removes everything (messages, running summary,
  archive, trace text) and returns a receipt naming the memories it kept.
  One `conversation_deleted` event carries the receipt.
- A **hold** (`conversations.legal_hold`, or `organization.retention_hold`
  for the whole tenant) freezes a thread: the sweep skips it and the owner's
  delete is refused with 409.

Persistent memory and the knowledge base are not touched by any of this.
Private-mode chats never reach the server and have no retention.

## Policy

Days since the last message, resolved in this order:

1. `memory_settings.retention_days` for the namespace, when not null
2. `organization.chat_retention_days` (30 on every row by default)
3. `CHAT_RETENTION_DAYS` in the environment (30)

`0` keeps forever. Trace text without a thread (memory off, private mode)
is nulled after `RETENTION_TRACE_DAYS`, or the same days when blank.

## The sweep

Runs inside the backend. Two modes:

- **Daily** (production): `RETENTION_SWEEP_AT=02:00` and
  `RETENTION_SWEEP_TZ=America/Los_Angeles` run one pass a day at that
  wall-clock time in that zone, looping in batches of `RETENTION_SWEEP_BATCH`
  (50) until nothing is due. A thread is archived on the first nightly pass
  after its retention day. The server logs the next run time at boot and
  after each pass.
- **Interval** (when `RETENTION_SWEEP_AT` is blank): every
  `RETENTION_SWEEP_MINUTES` (60; `0` disables it, which is right for dev
  machines and eval runs), first pass 30 seconds after boot, one batch per
  pass.

Frequency does not change cost: the one paid step is the summariser call,
made once per thread on the day it expires. A pass that finds nothing makes
one small query per namespace and no model call. The sweep is idle until
migration 0013 is present. A model failure defers the thread; the third
failure archives it with a metadata-only record (title, dates, counts,
documents used) so retention never stalls. Threads with fewer than two
user turns get the metadata-only record without a model call. Empty
threads are deleted.

Rehearse before the first live pass on any database:

```
node scripts/retention-sweep.mjs --dry-run --show
node scripts/retention-sweep.mjs --dry-run --org <organization id>
node scripts/retention-sweep.mjs                     # the real pass, once
```

Look at one thread's summary without writing anything:

```
node scripts/archive-conversation.mjs --list 20
node scripts/archive-conversation.mjs <conversation id> --dry-run
```

## Checks

| Script | What it proves |
|---|---|
| `scripts/test-archive-summary.mjs` | Planted email, phone, address, password and SSN never reach the record; decisions and figures do; caps hold. One real model call, ~$0.002. |
| `scripts/smoke-purge.mjs` | Delete is a complete purge: hold refusals, receipt, event, memory stamp, trace scrub, marker grep across every table that can hold chat text. |
| `scripts/smoke-archive.mjs` | An archived thread through the routes: read-only, hidden by default, no new messages, delete receipt. |
| `scripts/smoke-retention.mjs` | The sweep and the policy: backdated threads archived or deleted, held and recent ones untouched, namespace override, sweep event. |
| `scripts/check-retention-boundary.mjs` | Retention never imports memory extraction, memory writes, personas or reasoning; nothing outside the routes, server and scripts imports retention. |

The three smokes need a running backend with memory on and `EVAL_EMAIL` /
`EVAL_PASSWORD` in `.env`; each cleans up what it creates. Migration
harness: `bash C:/Cortex/design/migrations/test-0013.sh`.

## Where chat text can live, and what clears it

| Place | Cleared by |
|---|---|
| `messages`, `conversation_summaries` | sweep and delete |
| `conversation_archives` | delete (the sweep writes it) |
| `rag_queries.query`, `.conflicts` | sweep and delete (rows kept, text nulled, `text_purged_at` stamped) |
| `memories` | never by retention: the note is the user's, stamped `source_purged_at`, deleted from the memory routes |
| Browser local storage | the web app on delete and on sync |
| Server logs | carry no chat text (lengths only) |

## Archive now

An owner can archive one of their own chats ahead of the retention period
(`POST /api/conversations/:id/archive`, the Archive action in the sidebar).
It runs the same step the sweep does: summary, purge, trace scrub, event.
It is not reversible; `{ "archived": false }` answers `410`. A held thread
answers `409`, an empty one `400`.

## Administration

Admins set the period and place or release holds from Settings →
Organization Administration → Edit org. Shortening the period asks first,
with the number of chats it would reach; placing a hold needs a written
reason; releasing confirms. Routes are documented in `SETTINGS_API.md`
under "Chat retention".

## Production rollout

1. Apply migrations 0013 and 0014 in order in the SQL editor.
2. Set `RETENTION_SWEEP_AT` and `RETENTION_SWEEP_TZ` (daily mode) or leave
   them blank for the hourly interval; set `CHAT_RETENTION_DAYS` only if
   the platform default should differ from 30.
3. Deploy; the boot log says "retention: daily sweep scheduled" or
   "retention: sweep scheduled", and "retention: schema ready".
4. Before the first live pass: `node scripts/retention-sweep.mjs --dry-run --show`
   against the production keys, and read what it would archive.
5. Tell each organization's admin where the retention setting is.
