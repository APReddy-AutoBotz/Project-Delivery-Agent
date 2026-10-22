# Ingestion assurance handoff validation

Date: 2026-10-22
Plan: [EXEC-019](../04-delivery/exec-plans/EXEC-019-ingestion-assurance-handoff.md)
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7
Requirements: FR-CON-004, FR-CON-010, FR-HLT-001, FR-HLT-002, FR-UPD-001,
NFR-REL-001, NFR-SEC-001
Criterion: AC-CON-004; supporting AC-HLT-001/002

## Implemented boundary under validation

Only real CONNECTOR_SYNC changed-page receipts create durable per-project causes.
Enabled reporting policy and configured service are required. The signed existing
scan consumes a fixed available cohort of at most 25, with a two-minute claim,
durable five-attempt budget, five-minute failure fence and 60-minute success timer.
Known Source/grant contention refunds the provisional charge, retains monotonic
total attempts and defers 60 seconds. Canonical evidence alone supplies source
authority, freshness and satisfaction. Incoming connector values remain proposals.

Cause completion binds its claim audit/correlation, assessment and actual optional
obligation/preview, including reused obligations and active CURRENT-fallback
engagements. Completed rows remain immutable. Cross-table final-state guards use
a shared Project lock and policy-head tuple version fence, closing stale RR
snapshot races without changing policy semantics or assessor isolation.

Status and optimistic retry require current PMO project administration and current
source-reader permission. Retry cannot alter lineage, reset completed work or
bypass failure backoff. Worker has no business-table access; backup reads history;
API has finite controls and pure-validator execution only. There is no new source
scope, dependency, public OAuth activation, dispatch or user-interface styling.
Original19/20 research capture remains stopped. Accepted totals stay 5/38 and all
five release holds remain open until separate full acceptance gates are met.

## Executable coverage

`tests/ingestion-reassessment.integration.test.ts` uses real repositories and
signed webhook, connector task and project-scan middleware with stubbed provider
transport. It covers duplicate receipts through total obligation count, exact
reused lineage, scheduled changed/unchanged reconciliation, current trusted
canonical evidence and unchanged canonical versions/evidence timestamps.

Additional cases cover page/cause and assessment/acknowledgement rollback,
postcommit response loss, actual child-process death, stale-generation no-ops,
five crashed claims and reordered exhaustion, fixed available batches, late
arrivals, fair periodic work, repeated Source and grant contention, current scope
revocation, retry revision/backoff/authorization, mixed-source pagination beyond
25, reader revocation races, API-role configuration denials and populated recovery
states. For conflicting completion/preview races, one transaction commits and the
other fails, including serialization rejection for a stale RR snapshot. Policy
disablement and ingestion serialize successfully in either ordering. Runtime
hash/effective-time/payload mutation denials preserve the first
observation; existing HUMAN-path tests retain strict clock denial.

`scripts/acceptance/ingestion-assurance-upgrade.mjs` migrates populated released
24 to 25 and challenges its retained failure fence with genuinely available work
and a positive control. `scripts/acceptance/ingestion-reassessment.mjs` seeds
COMPLETED, BLOCKED, claimed READY and unclaimed READY through real repositories.
Native and packaged recovery compare exact cause/scheduler rows and validate
lineage, immutable completion and API/worker/backup permissions. No restored
runtime is started automatically.

## Executed checks and remaining gates

- The corrected released-24 fence probe passed locally, including available-cause
  denial, positive completion control and all 24 retained migration checksums.
- A separate byte comparison against verified main 7f70063 confirms all 24
  released migration sources remain exactly unchanged.
- Earlier full units passed 1,827 tests/106 files. These precede the last SQL and
  API-role corrections and do not replace final candidate validation.
- Build eight passed all eight packages. Required lint and explicit changed-test
  lint pass at the current WIP checkpoint.
- Native run eight passed 189/191, with two retained failures. Earlier failed
  attempts include conservative SQL formatting, Windows temporary-file permission,
  fixture grants, runtime unchanged-read handling and real API-role permission
  failures. They receive no passing full-suite credit. No threshold/deadline or
  production assertion was weakened.
- The subsequent 30-case focused suite passed, followed by native run nine with
  198/200 passing. Its two failures were immediate connector-job claims returning
  null before availability; the focused rerun passed both, without full-suite
  credit. Acceptance helpers now wait at most five actual claim ticks, failing
  unexpected job IDs and retaining the original exact-job assertion, production
  availability/backoff, attempts and test deadlines. Null ticks charge no attempt.
- Final build, required/changed-test lint, typecheck and all 1,827 units/106 files
  pass (118.09 seconds). Architecture verifies eight packages/100 source files;
  all 42 direct/override records and documentation checks pass. The unchanged
  high-severity audit threshold passes with zero high/critical and six moderate
  findings at this execution checkpoint; no dependency graph change is included.
- Corrected full native run ten passes **200 tests/15 files in 334.31 seconds**,
  including all 31 reassessment cases, five actual child exits, both RC/RR conflict
  orderings, API-role populated recovery and genuine scheduled reconciliation.
  Clean/repeat migration25, populated prefix-nine/released-24 upgrades, exact
  85-table inventory and health-retention checks pass on
  `pdaa_test_1792640436985`.
- Native dump/restore passes on `pdaa_restore_1792640939903`: all 85 business tables
  and the migration ledger match exact rows. All 14 proof families pass, including
  116 reassessment rows; immutable history mutation denials pass. API/worker CONNECT
  is denied and no application starts. The first local adapter run omitted its
  quarantine command and failed that assertion before row validation; its retained
  target was quarantined and the corrected adapter repeated the complete proof in
  a fresh target, denying CONNECT before and after restore. No default database or
  unrelated container was used.
- All three existing project-update browser journeys pass in **23.7 seconds** on
  separate fresh `pdaa_test_1792641076884`. The first sandbox browser launch failed
  because that sandbox cache had no executable; the unchanged suite then used the
  already installed browser outside that sandbox. Root visually checked the saved
  screenshot: existing Antigravity layout, UNCONFIRMED classification, zero confirmed
  facts and unsent preview remain, with no private proposal value shown.
- Final OpenAPI snapshot check passes. Independent source and bounded coverage
  reviews approve candidate `3bccb373`, tree `0041f487`, after the full 43-path review and
  five-path fixture correction. The evidence-only checkpoint still requires exact
  review and complete hosted packaged/customer/distribution gates before merge.

Local execution uses the task-owned PostgreSQL 17.11 server at loopback 51258.
An exclusive loopback 55432 bridge satisfies the unchanged synthetic guard and
fails if occupied. Test/upgrade/restore databases have unique synthetic names;
the server has no default pdaa database. No existing default database, unrelated
container, volume, worktree or stopped research capture resource is modified.

The historical pure validator proves receipt scope and exact completed assessment/
claim/preview lineage. READY/BLOCKED control fields additionally rely on guarded
birth/transitions and authenticated backup with exact row correspondence; it does
not reconstruct every prior control counter from the whole audit history. Stronger
historical control-event reconstruction is a nonblocking review follow-up, not a
claim about sanitizing arbitrary imported database rows.

## Traceability and recovery

### Hosted bootstrap corrections (PR #112)

The first hosted candidate `3805568a835686066842b97928991a544f33c550`
passed Documentation 39719592130, but Foundation 39719592164 failed both jobs:

- Native migration25 referenced `pdaa_api` before role bootstrap. Earlier local
  prefix-upgrade helpers had already created cluster-global roles and masked this
  fresh-cluster ordering. Migration25 now always revokes PUBLIC privileges and
  independently guards each named-role ACL operation with `to_regrole`; existing
  role privileges remain finite and unchanged. All 24 released migrations remain
  untouched.
- Packaged recovery's unqualified first-credential lookup selected the newly
  retained webhook credential rather than its restore fixture. It now requires
  exactly the original fixture UUID, customer, name and key ID before applying
  the unchanged decryption and generated-secret equality assertions. Complete
  credential-row projection comparison remains unchanged.

Both correction designs received independent approval. Dedicated genuinely fresh
clusters prove role absence before any helper, API-only partial roles, clean and
repeat migration25, independent exact 85-table inventory/ledger, PUBLIC denial,
immediate finite API ACLs and finite privileges after later role bootstrap.
`scripts/test-ingestion-role-bootstrap.mjs` runs that proof on its own pinned,
loopback-only disposable server, verifies container ownership before cleanup and
produces `artifacts/ingestion-role-bootstrap.json`. The normal Foundation workflow
runs this gate before its regular migrate/seed step. The exact orchestrator passes
locally and disposes only its verified owned container.

Fresh build/lint/types, 1,828 units/106 files, architecture, registration,
documentation and unchanged high-severity audit gates pass. Fresh native,
quarantined recovery, exact-candidate review and complete hosted packaged/customer/
distribution validation remain required. The prior 200-test run does not prove
this corrected migration. The new native run has timed out in several existing
cases; the full outcome and cause remain under investigation, with no passing
credit or changed test deadlines. Native11 was stopped after four existing-case
timeouts; Native12 was also stopped after four timeouts, including the populated
reassessment recovery probe. Their targets and logs are retained.

Independent review found that the recovery privilege probe made 320 sequential
queries per call and runs twice inside that test. One measured call on the same
retained synthetic database took 7,196 ms; its corrected complete matrix takes
five queries and 563 ms. This is evidence of avoidable fixture cost, not proof of
the cause of every earlier timeout. The correction preserves every owner, table,
grant-option, column and function expectation, requires exact cardinality/unique
keys and explicitly looks up each expected tuple. Both pre/post checks and the
original test deadlines remain. Mutation denial now acquires one client for
BEGIN/SET LOCAL ROLE/current-user verification/UPDATE rejection/ROLLBACK and
always releases it. All 27 new probe regression tests pass, including missing,
duplicate, substituted, extra, NULL and wrong permissions, grant-option denial,
metadata failures and client release on denial/role/rollback failures. Fresh full
units/native/recovery and hosted gates remain required; a new task-owned server
will isolate the next native run from the retained earlier test cluster.
Research capture remains stopped.

FR-CON-004/010 -> AC-CON-004 -> INT-CON-004 -> signed native suite and production
receipt/recovery fixtures -> Issue #7 -> draft PR #112. Supporting health,
update, permission and reliability contracts are listed above. Planned or local
WIP checks alone do not mark a complete criterion/story accepted.

Migration 25 adds one business table (85 total) and three policy control columns.
Rollback is an application revert retaining the compatible schema and immutable
history; do not drop the cause table. Quarantined restore denies runtime CONNECT,
preserves exact claims/counters/lineage and requires current permission rechecks
after lease expiry. It does not enable scanning, engagement or external delivery.
