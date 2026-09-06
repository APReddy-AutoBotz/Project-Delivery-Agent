# Foundation implementation evidence

Date: 2026-09-06. Scope: synthetic foundation on `feature/platform-foundation`.
PR #4 merged candidate `6cec7f0` after independent review and passing remote checks.
This is partial EPIC-01/STORY-001..005 delivery, with no complete story acceptance.

## Implemented behavior

React/Vite web, NestJS REST/OpenAPI, Graphile Worker heartbeat, PostgreSQL/Prisma
schema and synthetic seed; OIDC signature/issuer/audience/claim validation and
group mapping; development identities constrained to synthetic local data;
server-side project/portfolio grants and revocation; no implicit business read
for operational admins; transactional access audit, immutable audit triggers;
AES-256-GCM credential primitives and encrypted persistence fixture; default
shadow guard; safe structured logs, readiness and service health. Fact assessment
keeps provenance, freshness and conflict independent under ADR-009.

The browser supports synthetic sign-in, project list/detail, sign-out, service
health, access administration and audit history. Source ingestion, AI, reminders,
write-back and reports remain future increments; the interface labels them clearly.

## Requirement and test mapping

| Requirements / acceptance | Implemented evidence | Remaining acceptance boundary |
|---|---|---|
| TR-STACK-001..005, NFR-MNT-001/002/005, TR-API-001; AC-FND-001, AC-DATA-001 | Workspace build; initial SQL migration; `tests/database.integration.test.ts`; `OPENAPI_FOUNDATION.json` | Complete release packaging and downstream domain schema remain later work |
| TR-AUTH-001/002/003, FR-ADM-001/002; AC-AUTH-001 / SEC-AUTH-001 | `tests/security.test.ts`, `tests/identity-boundary.test.ts`: valid OIDC fixture, group mapping, invalid signature/issuer/audience/expiry/missing claims, dev production denial | Real customer IdP/browser interoperability and provider-specific API token scopes have not been tested |
| FR-ADM-003, NFR-SEC-001, TR-DATA-003; AC-AUTH-002 / SEC-AUTH-002 | Real API/repository tests: project and portfolio grant/revoke, cross-project/customer denial, unauthorized administration, operational admin without grants | Business mutation routes will need the same scoped enforcement when implemented |
| NFR-SEC-004/005, TR-DEP-003; AC-SEC-001 (partial) | Randomized context-bound encryption, wrong key/tamper/shortened-tag denial, stored ciphertext; secret-safe malformed configuration and startup errors | Customer secret manager, rotation, separated deployment secrets and complete configuration/export review pending |
| FR-APP-010; AC-SEC-003 (partial) | Outbound callback never executes for shadow, missing permissions/approval or malformed policy | Connector and messaging integration of the guard is pending |
| NFR-MNT-004, TR-TEST-001/002; AC-MNT-002/004 (partial) | Local validation commands; documentation and foundation workflow definitions | Remote execution passed; complete license/notices/SBOM and image-scan enforcement remains pending |
| TR-DEP-001, NFR-AVL-001, NFR-PORT-001/002/004; AC-DEP-001/002, AC-SEC-002 (partial) | Pinned local PostgreSQL container, health, seed and restore rehearsal | Application containers, production ingress/TLS, operating-system image scans and customer-hosted acceptance remain pending |

## Observed local results

- Build: all six workspace packages/apps compiled.
- Unit/security/health: **13 passed** across three test files.
- Real database/API: **7 passed** on fresh `pdaa_test_1788682481770`.
- Initial migration applied; repeat deployment reported no pending migrations.
- Restore: `pdaa_restore_1788682493346`; complete project, grant, audit and encrypted
  credential rows matched; decryption, project scope and UPDATE/DELETE/TRUNCATE
  audit protection passed. No application or outbound work started on the restore.
- Chromium: **5 passed** — project manager journey, operator grant/revoke/audit,
  390px mobile layout, removal of revoked cached project data, and expired-session
  sign-in recovery. Desktop/detail/platform/mobile screenshots inspected.
- Locked dependency audit, including development tooling: **0 known advisories**.
- Lint, typecheck and build passed. Documentation validation passed with 245
  requirements, 91 criteria, 38 stories and 135 test specifications; its 13
  regression tests passed. Frozen-lockfile installation passed with a clean tree.
- Independent review disposition is recorded in the task against the immutable
  candidate SHA; remote checks and merge remain separate gates.

Screenshots are local ignored artifacts: `artifacts/projects-desktop.png`,
`project-detail.png`, `platform-desktop.png`, `projects-mobile.png`.
They contain synthetic data. Browser traces stay local and are not publication
artifacts because they can include session material.

## Review fixes and execution lessons

Independent partial reviews found and resolved malformed outbound-policy allowance,
truncated GCM tag acceptance, database URL driver-option overrides, Docker routing
inheritance and malformed URL error disclosure. Regression checks cover the fixes.
The safety reviewer rechecked the three target/error findings and reported no
remaining P1 finding. Complete review of `aca4a2e` identified stale cached protected
UI data after denial. The fix hides errored query data, clears the session/cache
on a current-token 401, and refreshes the project list after detail denial.
Its live regression also exposed an empty-grant detail-query edge case. The
repository now returns an explicit denial before querying when an account has no
grants. Tests cover direct administrator detail access and final-grant revocation.

Docker Desktop crashed during a browser rerun with a daemon-validation
segmentation fault. That run was recorded as failed. Its processes were recovered
without changing daemon configuration, and all five browser tests then passed
against the restarted application. Recovery tooling now pins Docker Desktop's
local Linux engine pipe on Windows and verifies the database cluster identity.

One initial migration command inherited a generic host `DATABASE_URL` and failed
while attempting a remote connection; no migration was reported applied. The app
now uses `PDAA_DATABASE_URL`; local wrappers read the explicit synthetic config,
validate the driver-effective target and reject options/alternate destinations.
Successful migration evidence above is from the guarded local database.

The dependency scan found Prisma tooling advisories and was rerun after pinned
patch overrides. Disposition: `deepmerge-ts` 8.0.0 and `mysql2` 3.23.1; generation,
build, migration and tests passed with these versions. See the recorded
[deepmerge advisory](https://github.com/advisories/GHSA-ggr8-5vv4-36mx),
[MySQL authentication advisory](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr),
and [MySQL decompression advisory](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3).

## Security, data and recovery impact

No customer connector permissions were added and no Jira/email/AI actions run.
The new schema is confined to synthetic development databases. Local PostgreSQL
uses an owner account for migration/recovery tests; production must separate
migration and runtime roles. Audit triggers protect application operations, not
a malicious database superuser. Encrypted envelopes require a separately retained
key; backup alone cannot recover credentials. See the local development runbook
for startup/stop and restoration instructions. No destructive down migration exists.

## Pending gates

Full foundation story acceptance; required Tailwind/component layer and contract
evidence; pgvector availability; production IdP/TLS/containers,
key rotation, vulnerability scans of distribution images, notices and customer
deployment testing. R0 accepted **0/5**, R1 accepted **0/33**. No percentage of a
release is claimed complete from a merged partial increment alone.

## Verified remote execution and merge

Public publication was explicitly approved on 2026-09-06. Baseline PR #2 and
master-plan PR #3 merged first. Separate non-author review approved exact
foundation `6cec7f05ab5f6d4b14b4c24460985791c5863160` for its partial synthetic
scope. [Foundation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025145071) and
[documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025145004) both passed before
[PR #4](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/4) merged as `e29b9842b9d4d8db8ec32bf91409a71e869e160a`.

The Ubuntu runner log confirms 13 unit/security tests, seven integration tests,
five Chromium workflows, clean/repeat migration, seed and recovery. Restore used
`pdaa_restore_1788687471558` and retained six audit events with immutability active.
Frozen installation, six workspace builds, lint/types and dependency audit passed.
The PR review approved implementation/tests; these local and remote executions
are separately observed evidence, not an additional human GitHub approval.

STORY-001..005 remain in progress under Issue #5. The complete acceptance gaps
are listed in IMPLEMENTATION_STATUS.md. No production or R1 acceptance is implied.
