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
| Web transfer-tool removal | [#31](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/31) | `92f184d` | `d546e14` |
| Compiled Go source notices | [#32](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/32) | `50ffbc1` | `7c85993` |
| Npm original notice attribution | [#33](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/33) | `ff1c301` | `6ff5c63` |
| Node binary metadata and source coverage | [#34](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/34) | `b0a9bd2` | `5071962` |
| Node supplemental original notices | [#35](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/35) | `174bd8d` | `43b59f8` |
| Observed Node resource evidence | [#36](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/36) | `d107997` | `889716b` |

Issue #1 is closed with evidence. Four milestones and ten implementation issues
are published; no implementation issue is closed. Full immutable references and
backlog links are in [PUBLICATION_RECORD.md](PUBLICATION_RECORD.md).

## Implemented and verified

The current NFR-SEC-010 / AC-MNT-004 increment retains seven authenticated
JavaScript originals and derives exact selected-source/resource size-hash
correspondence in all six Node scopes. A reviewed policy plus canonical
original-byte bundle extends the required manifest to schema 8 / 82 files.
Separate bounded preparation precedes offline collection/replay. Complete
source files remain outside customer images. All 24 residual identities,
unresolved full-membership/applicability questions and ncrypto remain explicit.

Focused validation passes 284 tests, including 63 new source-policy, original-byte,
deadline, physical-binding and forged-archive tests. Independent precheck passes
34 checks, including recheck of the scanner-install ordering correction. Six
diagnostic replays against retained accepted PR #36 images verify all seven pairs
and 78,421 original bytes. Native lint, type checking, 372 unit tests across 22
files, seven builds, thirteen documentation regressions and traceability pass.
Separate immutable candidate review, fresh CI and downloaded evidence verification
remain merge gates for this change.

PR #36's candidate CI and all 80 downloaded files passed before its verified
merge, including 309 unit, ten integration/eight browser tests, 17 packaged groups
and both profiles. All ten native comparisons and six resource replays passed.
Its duplicate merged-main foundation and documentation jobs also passed at
`889716b`. No story or acceptance percentage changes; Issue #5 stays 11/12 with
AC-MNT-004 unchecked. Source correspondence is followed by actual vulnerability
disposition and remaining release-review work.

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

PR #31 removed unused curl and its orphan libraries from
the web image while preserving Caddy, BusyBox health checks and shared native
dependencies. Both scanner scopes must reject removed packages and payloads.
Detailed applicability assessment stays private; this is dependency minimization,
not acceptance of the remaining security or distribution gates. Independent
review, all required candidate checks, downloaded evidence verification and
merged-main CI passed.

PR #32 collects and verifies original notices for the
existing 144 compiled non-stdlib Go modules. The pinned module-and-notice inventory
binds 197 original source files to compiled h1 values and the unchanged Caddy
binary; both image scopes must reconcile their actual bytes and layers. It adds
no runtime dependency and grants no license approval. Independent review, all
candidate checks, all 64 downloaded evidence hashes and merged-main CI passed.

PR #33 captures original README attribution for three existing
packages and uses the verified parent LICENSE for five RxJS entrypoint manifests.
It preserves package versions and original package contents, runs application/notice
reconciliation in both image scopes and requires source-bound original bytes and
separate physical occurrences. Schema 4 retains the npm policy and replays its
checks from downloaded evidence. Local lint/types, all 135 unit tests, seven
builds, documentation checks and all six diagnostic image-scope scans passed.
Independent candidate review, all required CI and 65-file downloaded evidence
verification passed before merge. It does not accept AC-MNT-004 or waive any
release-review gate.

PR #34 binds the unchanged executable, complete original
notice and all 44 source sections to reviewed metadata and source pins. Direct
metadata is collected from each accepted image under bounded isolated execution;
schema 5 retains the policy and six raw/receipt files and replays both scopes.
All 29 metadata keys remain distinct from application npm packages, with explicit
ABI/data/disabled classifications and unresolved source attribution. Local lint,
type checking, 187 unit tests, seven builds, thirteen documentation regressions,
traceability validation, three diagnostic probes and six scope replays passed.
Separate candidate review, all required CI, 72-file downloaded evidence checks
and merged-main CI passed. No runtime dependency, database, permission or
connector-scope change was included.

PR #35 authenticates four original source files and
packages nbytes's complete LICENSE plus 149 original SQLite attribution comments
and their source index into the three existing Node images. Shared collection and
retained replay bind all 150 notices to exact source pins, Node binary, image and
supplying layers. Schema 6 retains the supplemental policy. All 68 new focused
tests pass, including fixes from an independent precheck. Native lint, type
checking, all 255 unit tests, seven builds, thirteen documentation regressions and
traceability checks passed. All six diagnostic replays, separate candidate review,
required CI, 73-file downloaded verification and merged-main CI passed.
ncrypto and complete licensing/composition review remain unresolved. No runtime
dependency version, database, permission or connector scope changes.

The current resource increment observes 371 strings and one undefined `configs`
entry through the pinned binary's native resource interface. Three bounded probes
and six image/scope replays agree; an independent descriptor traversal reproduced
every pin. Retained schema-7 evidence requires 80 files and independent checkout
policy anchoring. The 24 residual notice sections are derived from original
validated tuples; six path/name relationships have seven candidate resources.
All source-membership and ncrypto uncertainty remains explicit. A precheck UTF-8
lossiness defect was fixed. Final required native checks, immutable review, fresh
CI and downloaded verification remain merge gates. No runtime, database,
permission or connector-scope change is included.

Native lint/typecheck, 309 unit tests including 54 new resource tests, seven
builds, thirteen documentation regressions and traceability pass. The encoding
fix was independently rechecked, and all six diagnostic resource replays passed
with unchanged pins. Candidate review, CI and downloaded checks remain required.

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
