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
- Fresh expanded native, exact 85-table recovery, relevant browser journeys,
  packaged/customer profiles, final full gates, immutable candidate reviews and
  exact-head hosted CI/merge remain pending at this checkpoint.

Local execution uses the task-owned PostgreSQL 17.11 server at loopback 51258.
An exclusive loopback 55432 bridge satisfies the unchanged synthetic guard and
fails if occupied. Test/upgrade/restore databases have unique synthetic names;
the server has no default pdaa database. No existing default database, unrelated
container, volume, worktree or stopped research capture resource is modified.

## Traceability and recovery

FR-CON-004/010 -> AC-CON-004 -> INT-CON-004 -> signed native suite and production
receipt/recovery fixtures -> Issue #7 -> pending EXEC-019 PR. Supporting health,
update, permission and reliability contracts are listed above. Planned or local
WIP checks alone do not mark a complete criterion/story accepted.

Migration 25 adds one business table (85 total) and three policy control columns.
Rollback is an application revert retaining the compatible schema and immutable
history; do not drop the cause table. Quarantined restore denies runtime CONNECT,
preserves exact claims/counters/lineage and requires current permission rechecks
after lease expiry. It does not enable scanning, engagement or external delivery.
