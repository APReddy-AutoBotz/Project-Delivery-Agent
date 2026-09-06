# Production foundation boundary evidence

Date: 2026-09-06. Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5).
Scope: the next partial EPIC-01 increment under EXEC-003; no complete story or
customer/commercial release is accepted by this document.

## Changes and requirement mapping

| Requirements | Implemented change and executable evidence |
|---|---|
| TR-STACK-002, NFR-ACC-001/002 | Native React buttons, labelled fields and messages with Tailwind 4.3.3; `tests/e2e/foundation.spec.ts` checks keyboard submit/revoke, visible focus, accessible controls and mobile layout |
| TR-DEP-003, NFR-SEC-003/005 | `packages/platform/src/config.ts` separates file secrets from production settings, validates migration configuration before connection, and binds TLS certificate identity to the configured DNS name/IP; `tests/production-config.test.ts` |
| TR-AUTH-001/002/003, FR-ADM-001/002/003 | Configured API scope/resource, distinct API audience and browser client, in-memory tokens and provider logout hint; real Keycloak code/PKCE, remote JWKS, ID-token denial, replay/state denial, scoped reads and audited operator grant/revoke in `scripts/acceptance/run.mjs` |
| TR-DEP-001, TR-STACK-004/005, NFR-PORT-001/002/004, NFR-MNT-005 | API/worker/web OCI targets; two isolated TLS PostgreSQL services with vector extension, initial/repeat migration and restricted roles; `scripts/acceptance/initialize.mjs` and `run.mjs` |
| NFR-MNT-004, TR-TEST-001/002, NFR-SEC-010 | Frozen modern pnpm deployment; physical runtime-package/containment guard; reviewed direct/override dependency gate and negative tests; foundation CI now also runs container acceptance |

## Execution and artifact contract

The native suite passes 20 unit/security/policy tests, seven real database/API
tests and seven Chromium workflows. Lint, typecheck, all workspace builds,
dependency audit and the guarded forward/repeat migration and complete restore
rehearsals pass. Documentation validation covers 245 requirements, 91 criteria,
38 stories and 135 specifications; all 13 documentation regression tests pass.

Production acceptance runs eight grouped checks covering both runtime database
drivers, external database configuration, wrong CA/hostname/plaintext denial,
strict migration TLS, real OIDC login/logout and negative identity paths,
administrative grant/revoke, and the restricted worker heartbeat. Initial and
repeat migrations and pgvector availability are prerequisites in both databases.
The run must finish every check and successful teardown before it can publish
`artifacts/production-acceptance.json`. CI uploads only that successful report.

Each run records its unique ID, Git source revision, dirty-worktree indicator,
immutable image IDs and final status in `artifacts/<run-id>/run.json`. Failed runs
retain their own diagnostics and cannot leave their old canonical success file.
Local precommit runs are explicitly identified as dirty; the PR checks provide
the immutable reviewed-source validation. Raw build/runtime diagnostics and
fixture secrets are not published.

Precommit production run `pdaa-acceptance-1788695641714-3b0f561b` passed all eight
groups and teardown. Its recorded source is explicitly dirty; it does not assert
that the parent main revision alone contained these changes. The final runner
uses verification code from its immutable test image, with no source-code bind
mount. Exact-candidate remote checks and independent review remain the merge gate.

## Verified merge evidence

[PR #16](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/16) merged
on 2026-09-06 as `7ea6452c936d3b629bc3e4ff2914f81d73a99978`. Independent non-author
review approved exact head `9e7ed74e5d9f7a42f9b3d20e4d60293ed51d3e07` after the
override drift correction. [Foundation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34033085773)
passed both application and production jobs; [documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34033085720)
also passed.

The successful CI artifact records run `pdaa-acceptance-1788697574948-7efa4e9c`,
all eight groups, teardown, immutable image IDs and `distributionAccepted: false`.
Its clean source `b5ca8bc6aa090da7b8c655b201fe534cc6c62403` is GitHub's merge
snapshot. Its tree and the reviewed head's tree are identical:
`be04c4cdb9d2783701a9de090c6efa564f40d0f8`. This equality was verified from Git,
not inferred from a green status alone. The corrected local precommit run
`pdaa-acceptance-1788697125105-f00a3d37` also passed all groups and teardown.

An earlier immutable-image run failed worker startup. Its original root cause was
not established; the corrected runs passed with database CREATE revoked. Explicit
schema selection, fixed diagnostic categories and a post-revocation migration/
startup check provide further evidence without widening runtime permissions.

## Defects fixed during validation

- Preserve literal percent-encoded-looking password text across runtime and
  migration drivers; reject malformed hosts that otherwise fell back to localhost.
- Explicitly verify IP certificate identities rather than allowing Node's socket
  fallback to verify localhost. Correct IP SAN acceptance is unit-tested; a real
  database IP connection with a trusted localhost/DNS-only certificate is denied.
- Reject missing migration settings before datasource selection; a generation-only
  placeholder cannot be used by the migration command.
- Provision schema CREATE permission only for migration work. The worker's
  temporary database CREATE grant is revoked before normal startup; API and worker
  cannot alter/truncate audit tables or own the business schema.
- Remove Caddy's unused privileged-port file capability so the nonroot, read-only
  gateway starts with all capabilities dropped. Bound readiness waits and exclude
  HTTP error records that could contain OIDC callback query strings.
- Use unique image tags, resolve immutable image IDs, invalidate old success and
  publish evidence atomically after teardown. Isolate the browser certificate
  failure page from the later invalid-state navigation.
- Parse actual workspace overrides before comparing approved dependency records;
  reject independent version, addition and removal drift. The reviewed MIT YAML
  parser is development-only; the register now covers 35 direct/override records.

## Data, security, connector and recovery impact

No schema migration or business model change is introduced. Role provisioning and
synthetic seed mutations target only explicitly guarded ephemeral test services.
The existing local database and preview are preserved. Runtime DB connections now
require verified TLS in customer mode; production uses mounted password/key files
and cannot enable development identities. No customer credentials or host trust
changes are needed. No connector scopes, external writes, AI or messaging are added.

Revert the code/configuration increment to roll back application behavior. The
test runner removes only its generated Compose project; its databases use tmpfs.
Existing guarded restore rehearsal still compares all project, grant, audit and
encrypted credential rows and verifies audit immutability after restoration.

## Remaining acceptance work

EXEC-003 and Issue #5 remain open. PR #18 subsequently completed registered
architecture/OpenAPI and database evidence and accepted STORY-001/002; see
FOUNDATION_CONTRACT_VALIDATION.md. Remaining work: release migration/backup/
provisioning artifact, full transitive
and OS license/notices/SBOM/image-scan gates, expired-certificate and wrong-PKCE
negative coverage, and customer-specific IdP/operations validation. The controlled
fixture is not an approved customer installation. See the image register for the
unadopted migration-package license question and unchanged commercial-release gate.
