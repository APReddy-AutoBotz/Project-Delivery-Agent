# Foundation operations validation

Requirements: TR-DEP-001/003/004, NFR-AVL-001/002, NFR-SEC-003/004/005,
NFR-MNT-005. Issue #5; ADR-013; EXEC-003.

## Increment and boundaries

The separate operations package/image provisions customer roles and schema, applies
release SQL using the shared Prisma ledger, encrypts whole-database backups and
restores only into a fresh quarantined target. The customer reference Compose has
bundled/external PostgreSQL options, separate secrets, process restart policies and
a one-shot backup job. API readiness is bounded; the worker exits on fatal failure
or missing progress, and the local supervisor restarts it independently.

There is no business schema change, dependency version addition, connector scope,
external action, customer activation or restore-promotion command. PostgreSQL 17
and a dedicated cluster are the current operations contract. Distribution approval,
customer-specific operations/IdP validation and STORY-036 reconciliation remain open.
STORY-003 is not accepted solely by merging this supporting increment. R0 remains
2/5 (40%); R1 remains 0/33 (0%).

## Native evidence

During implementation, all seven workspace builds, lint/typecheck, 33 unit tests,
nine database/API integration tests and seven browser workflows passed (49 native
tests). Contract drift and the seven-package architecture gate passed. The 37-record
dependency gate and high-severity audit passed. Documentation validates 245
requirements, 91 acceptance criteria, 38 stories and 135 test specifications;
13 validator regressions pass. Existing guarded recovery preserved six audit rows
and project counts, retained audit immutability and started no restored application.

Operations tests cover complete SQL/history validation, transaction-control escapes,
authenticated encryption/metadata, wrong keys/corruption, producer failure and
collision handling, confirmed target/TLS environment, and fatal diagnostic redaction.

## Packaged acceptance and review

The isolated runner builds immutable API, worker, web, operations and acceptance
images. Both TLS database fixtures are provisioned by the actual operations image.
Additional groups cover bidirectional Prisma interoperability, concurrent migrations,
drift/failure rollback, backup and quarantined restore, encrypted credentials,
audit/queue/ownership preservation, unsafe target/session/key/archive denials, and
independent database-outage, database-restart and worker-failure recovery.

Only `artifacts/production-acceptance.json` published after successful teardown is
acceptance evidence. Its run identity, Git source, dirty flag and immutable image
IDs must match the reviewed candidate tree. Failed local runs are diagnostics, not
successful evidence. Independent non-author review approved exact
`6cd425ed9221ce1b14cba876f154096e843f83bd` with no blocking findings. All jobs in
[application/production CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34043249145)
and [documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34043249162)
passed. [PR #20](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/20)
merged at `2d854d21eb52ce425ce7af2d864808ac4ab66909` on 2026-09-06.

The saved successful run is `pdaa-acceptance-1788709473250-c613ce4e` (11 groups),
completed at 2026-09-06T15:54:02.830Z after teardown. Its clean CI source
`139aec06d8fb2700130e279fe193d3c962926d0b` has the same Git tree
`5584dedb8dc6a2ed8126cd4097649f438c2e2c1d` as the reviewed candidate. It records
five immutable image IDs and `distributionAccepted: false`. The local saved artifact
is `artifacts/pr-20-6cd425e/production-acceptance.json`; GitHub retains the successful
`production-boundary-evidence` artifact. Customer reference compositions passed
Docker configuration validation. The refreshed local preview passed all seven
browser workflows with no error-log output.

Review corrections include transaction-control lexing, target object completeness,
surviving-session quarantine, credential/customer preflight, Graphile type ownership
and snapshot-consistent backup metadata. Packaged runs also exposed Windows shell
line endings and Graphile RLS blocking the backup role. POSIX scripts now retain LF;
the backup account has an explicit SELECT policy and the job rejects filtering RLS
contracts before invoking pg_dump. It has no cluster-wide BYPASSRLS privilege. Final review also corrected PostgreSQL
identifier/comment/literal-continuation handling and requested worker shutdown.
Clean stop asserts exit zero and complete recovery. An in-container SIGKILL did not
terminate PID 1, and the restart-count assertion correctly failed. The final test
instead holds the isolated database unavailable until the actual worker restart
counter increases, then restores connectivity and requires a fresh committed
heartbeat and API readiness. One-shot operations avoid dependency startup, and
clean worker restart targets its verified container ID. No manual worker restart
occurs during the sustained-outage proof.

## Recovery and remaining gates

Use FOUNDATION_OPERATIONS.md for target confirmation, private file secrets, backup
retention, stop/migrate/start and fresh-target restore. Revert this code-only increment
to the preceding reviewed images; retain original databases and separately held
keys. No destructive down migration or automatic queue replay is introduced.
Complete customer composition/operations acceptance, complete OS/transitive notices,
SBOM/signing/image findings and remaining identity tests before foundation release.
