# Implementation Status

Updated: 2026-09-08

## Accepted implementation completion

| Release | Accepted merged stories | Total approved stories | Completion |
|---|---:|---:|---:|
| R0 | 3 | 5 | 60% |
| R1 | 0 | 33 | 0% |

STORY-001 (TypeScript workspace and runtime/API contracts) and STORY-002
(PostgreSQL foundation and repository interfaces) are accepted under delegated
controller authority. Their full AC-FND-001 / AC-DATA-001 contracts have executable
evidence, independent exact-SHA review, passing remote checks and a verified merge.
STORY-003 (shipped customer composition, TLS and external database support) is
accepted after PR #22; STORY-004/005 remain in progress. [Issue #5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5),
R0 release acceptance and commercial/customer deployment remain open.

## Published and merged increments

Public publication was explicitly approved by the Product Owner on 2026-09-06.

| Increment | PR | Reviewed candidate | Merge commit |
|---|---|---|---|
| Corrected baseline | [#2](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/2) | `5f37c65` | `70378ed` |
| Implementation master plan | [#3](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/3) | `3a7ead5` | `e153d1b` |
| Synthetic foundation | [#4](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/4) | `6cec7f0` | `e29b984` |
| Production foundation boundary | [#16](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/16) | `9e7ed74` | `7ea6452` |
| Executable foundation contracts | [#18](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/18) | `56e4fbd` | `5829e23` |
| Foundation release operations | [#20](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/20) | `6cd425e` | `2d854d2` |
| Customer composition acceptance | [#22](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/22) | `c669e95` | `27bc174` |
| Distribution evidence collection | [#24](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/24) | `a720ec5` | `438cc13` |
| Runtime distribution hardening | [#25](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/25) | `5071cea` | `1d0bcb9` |
| Foundation output and outbound security | [#26](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/26) | `40da638` | `2a9882f` |
| OIDC configuration acceptance | [#27](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/27) | `3b88a84` | `71b4e6d` |
| Real OIDC expiry acceptance | [#28](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/28) | `0c9489f` | `519c192` |
| Portfolio authorization acceptance | [#29](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/29) | `c8d08d0` | `5da7352` |
| Web runtime build toolchain | [#30](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/30) | `c7bbfb6` | `62bcbe6` |

Issue #1 is closed with evidence. Four milestones and ten implementation issues
are published; no implementation issue is closed. Full immutable references and
backlog links are in [PUBLICATION_RECORD.md](PUBLICATION_RECORD.md).

## Implemented and verified

- React/Vite/Tailwind web, NestJS API, Graphile Worker, PostgreSQL/pgvector
  foundation, versioned migrations and synthetic seed.
- OIDC validation, synthetic-only local sign-in, server-side project/portfolio
  scopes, audited grants/revocation, encrypted credentials and append-only audit.
- File secrets, verified production database TLS, separate application images,
  restricted runtime roles and controlled Keycloak code/PKCE/logout acceptance.
- Executable module/import boundaries, complete generated OpenAPI contracts for
  all 11 controller operations, runtime response validation, safe fixed errors
  and independent serialized HTTP tests. Worker persistence uses a domain port.
- Separate provisioning/migration/backup/restore image; verified TLS and restricted
  roles, authenticated encrypted archives, fresh quarantined restore, and customer
  reference configuration. Bounded API readiness and independently supervised worker
  recovery cover short and sustained database outages plus clean shutdown.
- [PR #20 CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34043249145)
  passes 33 unit tests, nine database/API tests and seven browser workflows (49 native
  tests), plus 11 packaged groups, clean/repeat migration, recovery, seven workspace
  builds, lint, typecheck, contract/architecture/dependency gates and dependency audit.
- [Documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34043249162)
  passes validation of 245 requirements, 91 criteria, 38 stories and 135 test
  specifications, with no direct R1 Must coverage gap, and 13 validator tests.
  Seven specifications now have implementation evidence; 128 remain planned.
  DEP-001/002 and SEC-TLS-001 were registered after PR #22.

The successful production artifact is clean, records immutable image IDs and has
an identical Git tree to reviewed `6cd425e`. It explicitly retains
`distributionAccepted: false`. See
[FOUNDATION_OPERATIONS_VALIDATION.md](../05-quality/FOUNDATION_OPERATIONS_VALIDATION.md)
for requirements, exact review/merge, artifact identity, failures corrected and
local/CI evidence. Prior scope remains in FOUNDATION_VALIDATION.md and
PRODUCTION_BOUNDARY_VALIDATION.md and FOUNDATION_CONTRACT_VALIDATION.md.

PR #22 re-runs all 49 native tests and adds two direct customer-composition groups
(13 packaged total), using the unchanged shipped services for bundled/external
PostgreSQL and a separate controlled OIDC issuer. Exact review, matching successful
CI, operator/upgrade/restore evidence and the local host-storage incident are recorded
in [CUSTOMER_COMPOSITION_VALIDATION.md](../05-quality/CUSTOMER_COMPOSITION_VALIDATION.md).

## Remaining work and next coherent increment

PR #24 adds immutable image/browser SBOMs, notices and unfiltered vulnerability
reports after production acceptance. Its 37-file bundle was downloaded and verified
against the reviewed source tree and accepted images. All required checks and
subsequent main CI passed; details are in
[DISTRIBUTION_EVIDENCE_VALIDATION.md](../05-quality/DISTRIBUTION_EVIDENCE_VALIDATION.md).
Scanner findings and attribution gaps remain unresolved. PR #25 removes unused
runtime package managers and adds explicit distributed-layer evidence while
preserving original Node notices. Exact review, all required CI checks and
downloaded evidence verification passed. STORY-004 remains open.

PR #26 binds outbound operations to trusted current
configuration/policy readers and extends secret-disclosure evidence across runtime
logs, real HTTP responses, browser outputs/assets and deployment exports. Separate
security and acceptance reviewers are assigned in
[FOUNDATION_SECURITY_VALIDATION.md](../05-quality/FOUNDATION_SECURITY_VALIDATION.md).
Both exact-candidate reviews, all required CI and downloaded evidence verification
passed before merge. PR #27 implements INT-ADM-001: operator
OIDC metadata and configuration-only role remapping on the same API image. Both
independent reviews, matching CI (97 unit, nine database/API, eight browser tests
and 16 packaged groups), all 63 downloaded evidence files and merged-main CI passed.
Its scope and acceptance limits are in
[OIDC_CONFIGURATION_VALIDATION.md](../05-quality/OIDC_CONFIGURATION_VALIDATION.md).

PR #28 adds real OIDC token expiry through the packaged API and browser. Both
independent reviews and all required checks passed; all 63 downloaded evidence
files match the reviewed tree. CI passed 99 unit, nine database/API, eight browser
tests and 17 packaged groups. See [OIDC_EXPIRY_VALIDATION.md](../05-quality/OIDC_EXPIRY_VALIDATION.md)
and its [final verification record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/28#issuecomment-5572894493).

PR #29 adds the two-portfolio HTTP/repository
boundary matrix: grant A, exclude B, deny unauthorized writes without state changes,
then revoke A while preserving the independent Atlas grant. Its isolated ten-test
database/API suite passed locally. See [PORTFOLIO_AUTHORIZATION_VALIDATION.md](../05-quality/PORTFOLIO_AUTHORIZATION_VALIDATION.md).
Exact-candidate review, matching CI/evidence and merge are verified. The effective
criterion decision is in [FOUNDATION_SECURITY_ACCEPTANCE.md](../05-quality/FOUNDATION_SECURITY_ACCEPTANCE.md).
STORY-005 remains open until the Definition of Done security assessment is resolved.

PR #30 refreshes the Caddy build toolchain, preserves original notices and extends
runtime/layer evidence checks. Independent review, required candidate CI and all
63 artifact hashes passed; merged-main CI also passed. Validation is recorded in
[DISTRIBUTION_EVIDENCE_VALIDATION.md](../05-quality/DISTRIBUTION_EVIDENCE_VALIDATION.md).

The current bounded increment removes unused curl and its orphan libraries from
the web image while preserving Caddy, BusyBox health checks and shared native
dependencies. Both scanner scopes must reject removed packages and payloads.
Detailed applicability assessment stays private; this is dependency minimization,
not acceptance of the remaining security or distribution gates.

| Story | Remaining completion work |
|---|---|
| STORY-004 | Runtime remediation, full adoption/license/notices and layer review, vulnerability dispositions and signing |
| STORY-005 | Assess and resolve remaining security findings against Definition of Done |

Continue [EXEC-003](exec-plans/EXEC-003-customer-hosted-foundation.md) with complete
transitive/OS license and notice inventory, SBOM and final image vulnerability gates,
and complete the STORY-005 security assessment before foundation release acceptance.
Customer-specific IdP and operations validation
needs the customer's registration and policy; generic synthetic checks can continue.
Real Jira/AI/email, write-back, assurance rules and reports remain unimplemented.
Once the foundation gate is accepted, proceed to the canonical model and evidence
ledger in [Issue #6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).

## Security, data and recovery

No schema migration, customer connector scope or outbound action was added by
PR #20. Separate maintenance roles and backup policies are added; restored runtime
connections remain quarantined. Invalid API data fails closed; error responses contain fixed messages.
The operations package reuses existing approved dependency versions. Complete
commercial distribution approval is still required. Revert the application
increment through review to roll back; no data rollback is needed. The guarded
restore rehearsal retains source data and starts no application on the restore
target. Local Docker and the existing database volume recovered after the user freed host
storage. Full database reads, migration/audit-trigger checks, fresh worker progress
and seven browser workflows passed; web/API readiness is healthy. No pre-incident
full database snapshot was available for an exact comparison. Issue #5 records the
recovery evidence and successful merged-main CI.
