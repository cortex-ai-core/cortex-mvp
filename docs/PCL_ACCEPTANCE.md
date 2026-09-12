# Persona and PCL acceptance record

Verified 2026-09-11/12 against Cortex-Dev2 with migrations 0011 and 0012
applied, backend `ian` branch, eval user `imclane@phasemargin.com`
(super admin) and `mclane.ian@gmail.com` (operator). Run files are in
`eval/runs` and are not committed; the names below are the ones produced
for this record.

## Checks and their artifacts

| Check | Result | Artifact |
|---|---|---|
| Hybrid chat eval, 30 questions | must-include 96% (one flaky comparison question, passes on rerun), citation precision 100% with 100% of answers cited, abstain 100% | `2026-09-12T00-41-21-hybrid.json` |
| Memory eval, 14 scenarios | 11 of 11 passed, 3 skipped for the missing second-namespace login as before | `2026-09-12T00-36-07-memory.json` |
| Persona eval, `npm run eval -- --pcl` | 6 of 6 passed, `unavailable-001` skipped by design | `2026-09-12T00-48-47-pcl.json` |
| Persona eval with `PCL_ENABLED=0`, `--scenarios unavailable-001 --expect-disabled` | 1 of 1 passed | `2026-09-12T00-46-22-pcl.json` |
| `scripts/smoke-pcl.mjs` | 25 of 25 | console |
| `scripts/smoke-persona-admin.mjs` | 43 of 43 | console |
| `scripts/smoke-chat.mjs`, `smoke-memory.mjs`, `smoke-policy.mjs` | all passed | console |
| `scripts/test-pcl-validate.mjs` | 53 of 53 | console |
| `scripts/check-pcl-boundary.mjs` | clean, 50 files scanned | console |
| `scripts/walk-section-60.mjs` | 12 of 12 | console, see note below |
| Docker harnesses `test-0011.sh`, `test-0012.sh` | each passes on two consecutive runs | C:/Cortex/design/migrations |

## Acceptance map

| Criterion | Satisfied by |
|---|---|
| AC-PCL-01 Persona independent of role and namespace | Persona is `user_settings.persona_id`; role is `user.role_id`; namespaces are `namespace_users`. `smoke-persona-admin`: assignment changes nothing on the user row and echoes role and namespaces. |
| AC-PCL-02, -03 Cannot increase permissions or grant a namespace | `check-pcl-boundary` (only chat.js and settings/* import `backend/pcl`); the resolver reads `user_settings`, `namespace.default_persona_id`, `personas`, `pcl` only; `walk-section-60` shows a persona in a namespace with no documents retrieves nothing. |
| AC-PCL-04 Configurable without source changes | Every seeded persona is at version 2 or later with content saved through the versions route; `seed-persona-starters.mjs`. |
| AC-PCL-05, -06 Admins assign personas; PCL associates with persona or scope | `smoke-persona-admin`: user assignment and namespace default; `walk-section-60`: Recruiting resolves Talent Intelligence via the namespace default. |
| AC-PCL-07 Participates in chat | `same-facts-001`, `personalization-001`, `smoke-pcl` (note and length take effect on the next turn). |
| AC-PCL-08 No unsupported certainty | Boundary sentence in CORE; doctrine rewrites deleted; `same-facts-001` (same figures and documents under two personas), `out-of-scope-001` (declines under every persona), `boundary-001` (boundary phrase refused and named). |
| AC-PCL-09, -10 Separate from knowledge and memory | `memory-separation-001` (same memories recalled under two personas); import boundary. |
| AC-PCL-11 Safe default | `unavailable-001` with `PCL_ENABLED=0`; the resolver's default path for missing tables, failed queries, invalid rows and oversize renders (`resolve.js`). |
| AC-PCL-12 Active configuration identifiable | `version-001`: reply and trace carry persona, version and hash; the earlier trace keeps the earlier version. |
| AC-PCL-13 Admin management | `smoke-persona-admin`; Settings → Personas in the web app. |
| AC-PCL-14 Identity layer preserved or migrated | Seeds in 0011 carry every persona name, tone and protect list forward; the integrity hash lives on as `backend/pcl/integrity.js` and `pcl.hash` on every trace. |
| AC-PCL-15 Everything else still works | Chat and memory evals and the three older smokes unchanged. |

## Notes

- **Section 60 walk.** Dev2 has no operator account with access to the
  Recruiting namespace, so the walk added the eval user (a super admin) to
  Recruiting for its duration, signed in there, and removed the membership
  afterwards. Persona resolution never reads the role, so the result is the
  same for an operator. The Recruiting namespace holds no documents on
  Dev2, so the hiring question was answered with "No matching documents
  found in the system." under the Talent Intelligence persona; the
  comparison of resumes was exercised in `same-facts-001` and the chat
  eval in the core namespace instead.
- **Admin-role scope.** Dev2 has no user with the plain `admin` role, so
  the rules that keep an admin inside their organization are covered by
  code review, not by a live login.
- **Answer length.** The length instruction is rendered as its own block
  with a word cap. It holds on lookup answers (103 words under "concise");
  whole-document overviews stay long, which is expected for that mode.
- **Starter content.** Core Executive is at version 3: version 2 dropped
  citations from some one-line answers; version 3 restates the citation
  rule and asks for full names, and the boundary sentence now names the
  citation rules explicitly.
