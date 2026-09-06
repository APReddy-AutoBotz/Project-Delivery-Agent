# EXEC-002: Secured local platform foundation

Status: In Progress (local preparation; remote acceptance gates pending)
Owner: Implementation controller
Requirement IDs: TR-STACK-001, TR-STACK-002, TR-STACK-003, TR-STACK-004, TR-STACK-005, NFR-MNT-004, NFR-MNT-005, FR-ADM-001, FR-ADM-002, FR-ADM-003, TR-AUTH-001, TR-AUTH-003, NFR-SEC-001, NFR-SEC-004, FR-APP-010
GitHub issue: Pending public publication authorization; grouped EPIC-01 issue prepared from STORY-001..005
Target release: R0
Last updated: 2026-09-06

## Objective

Build and verify the first local development increment: web/API/worker, database,
synthetic seed, production identity boundary, scoped access, encrypted secrets,
outbound guard, health, logs and CI. Do not enable live customer actions.

## In scope

STORY-001..005 and their acceptance criteria, subject to explicit evidence of
which portions are implemented and which remain pending. Produce a runnable
synthetic foundation and meaningful negative security/database/browser tests.

## Out of scope

Production release, live Jira/AI/email, full evidence ingestion, reminder execution,
source write-back, leadership AI and report generation. Public publishing is
blocked until the user explicitly approves that destination.

## Current state

Documentation-only repo; corrected baseline has separate local review approval.
Node 24.19.0 and pnpm 11.19.0 are available through bundled runtimes. Docker engine
29.6.1 is reachable with the task's authorized local execution permissions.

## Proposed design

React/Vite with accessible native UI primitives and TanStack Query; NestJS API
with validated bearer identity, server-side scoped project queries and OpenAPI;
PostgreSQL through Prisma repository interfaces; Graphile Worker heartbeat process.
Use explicit OIDC configuration and signed fixtures for negative tests. Local
synthetic login is opt-in and production-rejected. Secrets use authenticated
encryption with context binding and external key configuration. Central outbound
guard defaults to shadow mode. Domain code has no infrastructure SDK dependencies.

## Files and modules expected to change

Root workspace/config/CI; apps/web, apps/api, apps/worker; packages/domain,
packages/platform, packages/data; deployment/dev scripts; tests and requirement evidence.

## Data model or migration impact

Initial customer, portfolio/project, scope grants, encrypted connector credential,
append-only audit and service heartbeat tables. Synthetic seed is explicit and
refuses production. Migrations are versioned and clean/repeat deployment is tested.

## Security and privacy impact

Deny cross-project reads, invalid identities and production dev login; operational
admins have no implicit business reads. Validate schemas, encrypt credentials,
minimize safe error/log fields and prohibit outbound actions by default.

## Connector and permission impact

No customer connector scopes or live calls. Configured OIDC metadata is a customer
admin input; tests use controlled signing keys and synthetic subjects.

## Open-source dependency impact

Use current verified permissive versions with compatible peers: Node24/pnpm11,
React19, Vite7, Nest11, Prisma7, Graphile Worker0.17, Zod4, JOSE6 and TypeScript5.9.
Pin exact versions and retain notices; dependency/container scanning is a release gate.

## Implementation stages

1. Add workspace, exact dependency records and build/type/lint scripts.
2. Add schema/migration, synthetic seed and repository boundaries.
3. Add validated config, identity, scopes, encryption and outbound denial.
4. Add API/worker and an accessible synthetic UI.
5. Run unit/API, real PostgreSQL migration/recovery and Playwright verification.
6. Inspect diff and obtain separate non-author review of final candidate.
7. Publish only after destination approval and predecessor remote gates complete.

## Test and evaluation plan

Vitest deterministic rule/security/API tests; real PostgreSQL migration and grant/
audit tests; Playwright local synthetic login, scoped project view and logout;
lint/typecheck/build/docs and relevant container startup checks. No product AI
evaluation is applicable before AI exists. Report unrun live tests explicitly.

## Rollback and recovery

Local preparation uses isolated database/container names. Preserve user data and
the supplied bundle. Revert via Git, recreate only disposable synthetic databases,
and rehearse restore into a separate database. No production schema is modified.

## Progress log

- 2026-09-06: Prepared plan after local baseline review approval; remote publication pending.

## Decisions made

Local preparation continues under the user's request to start implementation.
Accepted/merged completion stays zero until remote gates pass. No assertion of
production OIDC integration or customer readiness follows from fixture tests.

## Risks and mitigations

Public destination approval and customer integrations remain external gates.
Keep synthetic labels and deny-by-default settings visible and enforce them on
the server. Pin compatible versions rather than blindly installing latest tags.

## Validation evidence

Pending implementation.

## Completion summary

In progress; no R0 story is yet accepted as complete.
