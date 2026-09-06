# Foundation contract validation

Date: 2026-09-06. Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5).
Accepted story scope: STORY-001 / AC-FND-001 / CI-FND-001 and
STORY-002 / AC-DATA-001 / INT-DATA-001, under ADR-012 and EXEC-003.
Exact non-author review, passing CI and verified PR #18 merge support acceptance
of these two stories. The remaining R0 stories and release remain open.

## Requirements and executable evidence

| Requirements | Change and evidence |
|---|---|
| TR-STACK-001/002/003, NFR-MNT-001/002, TR-API-001 | The six workspace packages build React/Vite/Tailwind web, Nest API and Graphile Worker. `scripts/check-architecture.mjs` parses TypeScript imports, public package boundaries, source/package cycles and alias configuration. `tests/architecture.test.ts` exercises forbidden imports and independent bypass fixtures. |
| TR-API-001, NFR-MNT-002 | Shared request/response Zod schemas generate all 11 controller operations in `OPENAPI_FOUNDATION.json`. The response interceptor validates successful payloads and statuses before serialization. The exception filter emits fixed, schema-valid error messages. `scripts/validate-openapi.mjs` independently compiles schemas with Ajv; `tests/api-contract.test.ts` validates actual HTTP bodies. `pnpm check:contracts` detects committed-export drift without rewriting the export. |
| TR-STACK-004/005, NFR-MNT-005 | `scripts/test-database.mjs` creates a guarded fresh PostgreSQL database, verifies all seven foundation tables and the migration ledger/checksum, repeats deployment with no ledger change, then runs `tests/database.integration.test.ts`. New cases enforce customer/portfolio consistency, per-customer uniqueness and scoped isolation. |
| TR-STACK-005 | Worker tasks receive `WorkerHeartbeatRepository`; the data package owns the ORM adapter and the worker composition root wires it. Real database tests verify one heartbeat row is updated across repeated calls. |

Identity foundation is the external OIDC subject plus scoped `AccessGrant` model;
connector foundation is the encrypted `ConnectorCredential` model. These satisfy
the initial foundation criterion without claiming the future canonical delivery
model or a working customer connector.

## Local results

- 28 unit/security/policy/architecture/HTTP contract tests passed.
- Nine real database/API tests and seven Chromium workflows passed (44 native tests).
- Lint, typecheck, all workspace builds, architecture/contract drift checks,
  the 37-record exact dependency gate and dependency audit passed.
- Clean migration and repeat deployment passed in synthetic database
  `pdaa_test_1788700967613`. Migration `202609060001_foundation` has checksum
  `9738bed726d754be02fb157ce2ee787def280d5e6e4c5319d778080d8b040aca`.
  The successful `artifacts/database-validation.json` is invalidated before a new
  database run; CI publishes this report only after the native workflow succeeds.
- Recovery into separate database `pdaa_restore_1788700984491` passed: project,
  grant, audit and encrypted credential rows matched; six audit records,
  restored scope enforcement, decryption and audit immutability were verified.

These local results came from the precommit working tree. Current CI independently
reran native validation and the eight TLS/OIDC/packaged-runtime groups, including
initial/repeat migrations, pgvector and restricted worker persistence.

## Immutable review, CI and acceptance

[PR #18](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/18) merged on
2026-09-06 as `5829e23629d24250f4d53534c779739f2ffedd38`. Independent non-author
agent `review_baseline_candidate` approved exact head
`56e4fbd9381b6c6b334b808f7a125b024a1bb38c`, with no unresolved P0/P1/P2 finding,
and supported acceptance of STORY-001/002 after matching checks and merge.
[Foundation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34036868766)
and [documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34036868619)
passed all three jobs. CI logs confirm the same 28 + 9 + 7 native test counts,
all eight production groups, clean/repeat migration and recovery, six builds,
lint/types/contract/dependency gates and all 13 documentation regressions.

The downloaded production artifact records run
`pdaa-acceptance-1788702109134-e5620678`, clean source
`b7460266b6e3a73eaca3f81ccf8653dd4bbc27e9`, immutable image IDs, all eight passing
groups and `distributionAccepted: false`. The runner publishes only after
successful teardown. Git confirms the CI merge snapshot and reviewed head share
tree `0b890a1cc5083bf53e420a1a4eb137b6d2fc0692`.

The CI database artifact records `pdaa_test_1788702161417`, seven foundation
tables, the unchanged migration checksum above and `repeatUnchanged: true`.
CI recovery passed into `pdaa_restore_1788702166268` with six audit records and
matching rows/protections. These artifacts are attached to the linked run.
The controller therefore accepts STORY-001 / AC-FND-001 / CI-FND-001 and
STORY-002 / AC-DATA-001 / INT-DATA-001. R0 is 2/5 (40%); R1 is 0/33 (0%).

## Review corrections and negative cases

The preliminary reviewer found missing HTTP 413/415 responses. Real requests now
verify oversized JSON, unsupported charset and malformed JSON. The API documents
these transport statuses and returns fixed error bodies without reflecting request
content. An arbitrary SDK error with a `statusCode` property remains a generic 500.
Malformed repository output, undocumented statuses, broken schema references,
extra/missing operations, empty-body 204 handling and a trimmed 200-character
subject boundary are exercised. Express automatic HEAD behavior is also checked.

The architecture gate rejects undeclared SDKs, deep/relative cross-package imports,
source and package cycles, require/import-type paths, computed loaders, aliases,
symlinks and first-party JavaScript runtime files. Generated Prisma internals are
explicitly outside that source check. This enforces repository conventions; it is
not a security sandbox for arbitrary hostile source code.

## Impact, recovery and remaining gates

No schema migration, customer connector scope, AI call, messaging or external
write is added. Server-side identity, project scopes and outbound denial remain
active. Invalid API responses fail closed and API errors disclose fixed messages.
Ajv 8.20.0 and ajv-formats 3.0.1 are exact, reviewed MIT development dependencies;
they are not added to production application packages.

Revert this application increment through review to restore prior behavior; no
data rollback is needed. The guarded restore rehearsal preserves source data and
starts no application against the restore target. Existing production acceptance
tears down only its isolated generated Compose project.

STORY-003/004/005 remain open for release provisioning/backup/operations tooling,
complete transitive and OS license/notices review, SBOM/image vulnerability gates,
remaining identity negatives and customer-specific validation. Issue #5, R0
release acceptance and commercial distribution remain open after acceptance of
these first two story contracts.
