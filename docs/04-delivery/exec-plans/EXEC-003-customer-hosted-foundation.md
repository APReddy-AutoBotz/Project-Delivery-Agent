# EXEC-003: Complete the customer-hosted foundation boundary

Status: In Progress
Owner: Implementation controller
Requirement IDs: TR-STACK-001, TR-STACK-002, TR-STACK-004, TR-DEP-001, TR-DEP-003, TR-AUTH-001, TR-AUTH-002, TR-AUTH-003, FR-ADM-001, FR-ADM-002, FR-ADM-003, NFR-SEC-001, NFR-SEC-003, NFR-SEC-004, NFR-SEC-005, NFR-SEC-010, NFR-MNT-004, NFR-MNT-005, NFR-PORT-001, NFR-PORT-002, NFR-PORT-004
GitHub issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5
Target release: R0
Last updated: 2026-09-06

## Objective

Complete the remaining platform deployment and security acceptance with the same
application build, controlled identity provider and synthetic data. Preserve the
existing local workflow and do not activate customer integrations.

## In scope

Required Tailwind/component layer; executable workspace/OpenAPI contracts;
separate API/worker/web/migration OCI targets; TLS ingress and PostgreSQL;
bundled pgvector availability and external database configuration; production
file secrets, scoped OIDC code/PKCE login and provider logout; restricted database
roles; backup/recovery; dependency/license/notices/SBOM and image-scan gates.

## Out of scope

Jira/AI/email, source writes, customer deployment activation, commercial release
and customer-specific identity registration. Generic production paths use a
controlled provider in an isolated test deployment.

## Current state

Main `2d854d2` contains the reviewed production boundary, executable foundation
contracts and release operations increment. STORY-001/002 are accepted after exact review, current CI and PR #18
merge; STORY-003/004/005 remain in progress. The user authorized continued
implementation and public branch/PR publication. Earlier TLS, scope and logout
findings were resolved in PR #16.

## Proposed design

Use exact published dependencies and immutable image digests. Approve a small
native HTML React component layer styled with Tailwind. Share validated database
transport configuration across Prisma and Graphile; migration tooling receives
an independently validated TLS connection. Nonsecret deployment settings are
separate from mounted password/encryption files. API, worker and migration roles
have distinct credentials. A controlled Keycloak realm exercises real discovery,
code/PKCE, token exchange, remote JWKS and logout behind trusted test TLS.

## Files and modules expected to change

Web controls/config, platform identity/configuration, database/worker bootstrap,
deployment Dockerfiles/Compose/config/fixtures, acceptance harness, tests and CI,
dependency records and implementation/requirement evidence.

## Data model or migration impact

No delivery-domain expansion. Provision restricted deployment roles and verify
initial schema migration/repeat deployment. pgvector is available for approved
future semantic retrieval; structured facts remain independent. Isolated fixtures
and restore destinations must be explicitly checked before any data mutation.

## Security and privacy impact

Require verified TLS for production DB and identity connections, reject transport
overrides, disable development identity in production, keep tokens in memory and
secrets out of outputs/assets/logs. Preserve every existing synthetic target guard.
Ingress omits callback query strings from logs. Application roles cannot own or
alter business/audit tables. Outbound remains in shadow mode.

## Connector and permission impact

No customer connector scopes. Test identities and certificates exist only in the
isolated acceptance deployment; no machine-wide certificate trust is modified.

## Open-source dependency impact

Tailwind and Vite adapter 4.3.3 are MIT. Node, PostgreSQL/pgvector, Caddy, Keycloak
and scan tooling require exact publisher/digest/license records before use.
Collect complete shipped-package notices and scan final images; never equate an
SBOM or inventory with a successful vulnerability check.

## Implementation stages

1. Record choices and verify package/image metadata.
2. Implement production configuration, shared TLS and scoped OIDC browser changes.
3. Add required component stack and contract checks.
4. Build isolated OCI deployment, migration/role/backup tooling and identity fixtures.
5. Execute positive and negative identity/TLS/permission/database/browser workflows.
6. Enforce dependency/distribution gates and document evidence and remaining gaps.
7. Review immutable candidate independently, push/PR, wait for CI, merge only with
   passing gates, then update issue/story acceptance from actual evidence.

## Test and evaluation plan

Maintain existing 25 application tests and 13 documentation regressions. Add
meaningful production configuration and disclosure failures, API contract/boundary
checks, real provider login/logout, TLS trust/hostname failures for each driver,
external DB reconfiguration, restricted-role denial, migration/restore and license
gate negative fixtures. No AI evaluation applies before AI exists.

## Rollback and recovery

Preserve the current development database/preview. Use a separate Compose project
and fixture directory. Never remove its volumes until resolved names and ownership
are verified. Revert code through review; restore backups into a separate target
with outbound disabled and the separately retained encryption key.

## Progress log

- 2026-09-06: PR #20 merged as `2d854d2` after independent approval of exact
  `6cd425e` and all three CI jobs. The clean matching-tree artifact records 11
  production groups; native checks cover 49 tests, seven builds and 13 documentation
  regressions. Actual operations jobs now replace fixture-only provisioning.
  Backup/restore, quarantine denials, migration interoperability and sustained-outage
  automatic worker recovery pass. See FOUNDATION_OPERATIONS_VALIDATION.md.
  Continue direct customer-reference composition acceptance, then distribution and
  identity gates. STORY-003/004/005 remain open; R0 2/5, R1 0/33.

- 2026-09-06: Operations increment starts from clean merged `e1e8680` on
  `feature/foundation-operations`. Implement ADR-013's operations package,
  customer reference configuration and isolated migration/backup/restore and
  connection-loss tests. Preserve the existing local database and preview.
  Root owns edits/Git; specialists review requirements/tooling and exact candidate.
  Existing OS/distribution gates and STORY-036 action reconciliation are not waived.

- 2026-09-06: PR #18 merged exact reviewed `56e4fbd` as `5829e23` after all
  three CI jobs passed. Registered CI-FND-001/INT-DATA-001 have complete evidence;
  accept STORY-001/002 (R0 2/5, R1 0/33). Review's missing parser 413/415 errors
  were fixed with safe error normalization and real HTTP regressions. Next:
  release provisioning/migration/backup/restore package and isolated recovery tests.

- 2026-09-06: Next increment starts from merged `fabec98`. Implement ADR-012's
  complete runtime/OpenAPI contracts, drift and module-boundary checks, narrow
  worker heartbeat repository and explicit database-integrity evidence. Register
  CI-FND-001/INT-DATA-001, then assess STORY-001/002 only after review, CI and merge.
  No new schema or live connector is needed. Release tooling, distribution and
  the remaining identity/deployment story gates continue separately.

- 2026-09-06: Reconciled main/Issue #5; delegated read-only component, distribution
  and identity/security research; root retains implementation and Git ownership.
- 2026-09-06: Implemented native Tailwind controls, shared verified TLS/file-secret
  configuration and configured OIDC scope/logout. Preliminary review found and
  root fixed percent-password, malformed-host, IP identity and migration-fallback
  defects. Native checks and documentation regressions pass.
- 2026-09-06: Added API/worker/web images and isolated Keycloak/PostgreSQL acceptance.
  Corrected restricted migration provisioning, gateway capabilities and browser
  certificate-error navigation. Runtime packaging rejects build-only dependencies;
  direct dependency policy is gated, while complete distribution approval remains
  open. Unique immutable image IDs and post-teardown evidence prevent stale results.

## Decisions made

Independent candidate review identified an override-register drift bypass. The
gate now parses actual workspace YAML and tests independent changes, additions
and removals. The immutable-image rerun also exposed a worker startup failure;
fixed diagnostic categories and a post-revocation schema/startup check retain
least privilege. Corrected local and immutable CI runs passed all eight groups
and teardown. The original startup failure did not recur and its root cause was
not established. PR #16 merged as `7ea6452` after independent approval of exact
`9e7ed74` and passing documentation, application and production checks.

Customer credentials are not needed to test generic production code against a
controlled provider. Customer-specific activation remains a separate gate. No
story closes merely because one test or partial implementation has merged.

## Risks and mitigations

Container resource use and vulnerability findings may require narrower fixes.
Pin images and scan actual build outputs; keep all failures visible. Keep native
controls and existing UX stable while introducing the required CSS toolchain.

## Validation evidence

See PRODUCTION_BOUNDARY_VALIDATION.md for this increment's native results and the
production acceptance artifact contract. Prior evidence remains in
FOUNDATION_VALIDATION.md. Exact-candidate review and required remote checks passed;
the production evidence document records the CI source tree and run identity.

## Completion summary

Production boundary and executable contracts are implemented, validated,
independently reviewed and merged. STORY-001/002 are accepted with evidence in
FOUNDATION_CONTRACT_VALIDATION.md. Release operations and isolated recovery are
merged with evidence in FOUNDATION_OPERATIONS_VALIDATION.md. Direct customer
composition acceptance, full distribution gates and remaining identity/deployment
validation stay in this ExecPlan. R0 release and Issue #5 remain open.
