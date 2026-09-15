# Chat retention acceptance record

Verified 2026-09-14 against Cortex-Dev2 with migrations 0013 and 0014
applied, backend `ian` branch, web app `ian` branch, eval user
`imclane@phasemargin.com` (super admin) and `mclane.ian@gmail.com`
(operator). Design: the Cortéx Chat Retention Plan (Draft 1 with phase
status, C:/Cortex/design/cortex-retention-plan.html). Operator notes:
`docs/RETENTION.md`. Run files are in `eval/runs` and are not committed.

## Checks and their artifacts

| Check | Result | Artifact |
|---|---|---|
| Docker harness `test-0013.sh` (retention schema, `archive_conversation`) | passes on two consecutive runs; 24 functional asserts | C:/Cortex/design/migrations |
| Docker harness `test-0014.sh` (document types by organization) | passes on two consecutive runs | C:/Cortex/design/migrations |
| `scripts/test-archive-summary.mjs` (minimisation and caps; one real gpt-5-mini call) | 30 of 30 | console |
| `scripts/test-retention-schedule.mjs` (daily sweep clock incl. DST) | 11 of 11 | console |
| `scripts/smoke-purge.mjs` (delete is a complete purge) | 26 of 26 | console |
| `scripts/smoke-archive.mjs` (archived thread through the routes, archive now) | all pass | console |
| `scripts/smoke-retention.mjs` (sweep, policy, override, holds) | 25 of 25 | console |
| `scripts/smoke-retention-admin.mjs` (admin routes, preview, both hold scopes) | all pass | console |
| `scripts/smoke-document-types.mjs` (organization-level types) | all pass; second-namespace check skipped (eval user has one namespace) | console |
| `scripts/check-retention-boundary.mjs` | clean, 85 files | console |
| `scripts/check-pcl-boundary.mjs` | clean, 58 files | console |
| Chat, conversations, memory, persona-admin and PCL smokes; `test-pcl-validate`, `test-policy` | all pass | console |
| Hybrid chat eval, 30 questions | must-include 96% (the same comparison question that was flaky in the PCL record), citation precision 100%, abstain 100%, intent 93% | `2026-09-14T21-40-34-hybrid.json` |
| Memory eval, 14 scenarios | 11 of 11 passed on the rerun, 3 skipped for the second-namespace login as before (first run 9 of 11: residue, see "Memory eval") | `2026-09-14T21-43-49-memory.json`, `2026-09-14T21-50-32-memory.json` |
| Persona eval | 6 of 6, `unavailable-001` skipped by design | `2026-09-14T21-45-55-pcl.json` |
| Web app `tsc --noEmit` | clean | console |
| Five real Dev2 threads dry-run through the summariser, reviewed by Ian | accepted (prompt archive-v2) | C:/Cortex/design/retention-archive-review-2026-09-14.md |
| Retention sweep dry run on the real Dev2 data | eleven namespaces at 30 days, zero candidates (every thread under a month old) | console |

## Acceptance map (the customer's six sections)

| Requirement | Satisfied by | Shown by |
|---|---|---|
| 1. Active chat, days 0–30; continuity; user delete; configurable period | Thread window and recall unchanged; complete purge on delete; policy resolution namespace → organization → environment | smoke-history, smoke-purge, smoke-retention |
| 2. Day 31: summary → archive → purge; listed fields; minimise sensitive detail | `backend/retention/summarize.js` (topic, purpose, decisions, conclusions, action items, participants, open questions, documents used, period, counts, source id, generation); four minimisation layers; metadata-only fallback | test-archive-summary, the five reviewed archives, smoke-retention |
| 3. Persistent memory separate; archiving never promotes | Retention never imports extraction or memory writes; the sweep calls no memory code; memories from a purged chat survive, stamped | check-retention-boundary, memory eval unchanged, smoke-purge (kept memory named in the receipt) |
| 4. Four domains, none in `document_chunks` | `messages`, `conversation_archives`, `memories`, `document_chunks`: four tables, no cross-writes; archives are not embedded (R-5) | schema; check-retention-boundary |
| 5. User purge; inventory of copies and derived data | Plan section 4 inventory; receipt naming kept memories; trace text nulled; browser cache follows the server; logs carry no chat text | smoke-purge's marker grep across every table that can hold chat text |
| 6. Tenant policy 30/60/90/365/custom; room for legal hold | `organization.chat_retention_days`, namespace override, Edit-org UI with a numbered warning before shortening; organization-wide and per-thread holds honoured by the sweep, the archive step and delete | smoke-retention-admin, smoke-retention hold path |

## Where chat text can live (as shipped)

| Place | Cleared by |
|---|---|
| `messages`, `conversation_summaries` | sweep and delete |
| `conversation_archives` | delete (the sweep writes it) |
| `rag_queries.query`, `.conflicts` | sweep and delete; rows kept for metrics, `text_purged_at` stamped; thread-less rows by age |
| `memories` | never by retention; stamped `source_purged_at`; deleted from the memory routes |
| Browser local storage | the web app on delete and on sync |
| Server logs | lengths only |
| OpenAI | every turn's prompt and the summariser input reach the provider; outside this system's control and covered by the customer's data processing agreement with the provider |

## Memory eval

The first run in the Phase 6 sequence passed 9 of 11 (3 skipped, as in the
PCL record, for the second-namespace login). The two misses were residue,
not retention behaviour: `carry-002` got an empty answer on one turn
(transient) and left its marker note behind; `forget-001` then recalled a
note a smoke thread had produced by extraction. The residue was removed,
every retention smoke now deletes the notes extracted from its own threads,
and the eval was rerun alone: 11 of 11 passed, 3 skipped (`2026-09-14T21-50-32-memory.json`).

## Notes

- **Admin-role scope.** Dev2 has no user with the plain `admin` role, so
  the rules that keep an admin inside their organization are covered by
  code review, not by a live login, as with personas.
- **Second namespace.** The eval user belongs to one namespace on Dev2, so
  the document-types check that reads the list from a second namespace is
  skipped; the organization scope is proven by the route's own filter and
  the harness.
- **Delete in the sidebar.** At Ian's request an active chat is archived
  from the sidebar and deleted once archived; "Delete all my chats" in
  User Settings still purges everything at once.
- **Node on Windows.** Some scripts print a libuv assertion after
  "ALL PASSED" as the process exits; it is a known Node teardown quirk
  and not a test failure.
- **Known pre-existing failure.** `smoke-policy` fails one as-of timing
  check; it fails identically on the code before this work and is
  unrelated to retention.
