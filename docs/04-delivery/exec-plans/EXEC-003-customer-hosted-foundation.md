# EXEC-003: Complete the customer-hosted foundation boundary

Status: In Progress
Owner: Implementation controller
Requirement IDs: TR-STACK-001, TR-STACK-002, TR-STACK-004, TR-DEP-001, TR-DEP-003, TR-AUTH-001, TR-AUTH-002, TR-AUTH-003, FR-ADM-001, FR-ADM-002, FR-ADM-003, NFR-SEC-001, NFR-SEC-003, NFR-SEC-004, NFR-SEC-005, NFR-SEC-010, NFR-MNT-004, NFR-MNT-005, NFR-PORT-001, NFR-PORT-002, NFR-PORT-004
GitHub issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5
Target release: R0
Last updated: 2026-09-09

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

### Current increment: gosu advisory applicability batch

Under NFR-SEC-010 / NFR-MNT-004 / AC-MNT-004, extend the reviewed exact-binary
policy with 22 separately assessed advisories (88 original observations across
database/operations and both scopes). Every affected import, including imports in
multiple Go modules, must be absent from the complete emitted/inline name pool and
source metadata. Keep GO-2026-4970's four observations open: os is present and this
increment does not authorize function-level exclusions. Preserve the four earlier
GO-2026-4337 dispositions, giving 23 rules and 92 separate baseline ledger rows.

Schema 10 retains 85 files and upgrades the policy, analysis and ledger contracts
to version 2. Pin primary advisory bytes and native advisory semantics per rule.
The standard Go reader records affected-package queries and a present os control;
its original subject, full list/section hashes and entrypoint controls must agree
with independent extraction. Policy/analysis reads are bounded at 128 KiB and the
larger occurrence ledger at 512 KiB. No generic version-based exclusion or caller
approval flag is introduced. Original findings/severities stay unchanged.

Require per-observation private validation, independent immutable-candidate review,
native checks, fresh packaged CI and downloaded evidence comparison before merge.
Compare against accepted PR #38 without a new image payload or dependency delta.
Preserve all original notices, source bindings and five release blockers. No runtime,
database, permission or connector change. Recovery is a reviewed policy/schema
revert followed by fresh collection and verification. This batch leaves 734 of
the 826 baseline High/Critical observations without a new disposition; those counts
are scanner observations, not a count of exploitable product defects.

### Completed increment: first gosu dispositions and Multer remediation

PR #38 merged at `24894ba` after independent review of candidate `10ee5eb`,
native checks, fresh CI and downloaded verification. Candidate foundation run
34304924230 and documentation run 34304924234 passed; merged-main foundation
34307208557 and documentation 34307208404 also passed. Schema 9 retained 85 files
and four GO-2026-4337 code-absence dispositions, with original scans unchanged.

The same accepted increment replaced Multer 2.2.0 with reviewed 2.3.0 after fresh
CI exposed dependency advisories. All 418 unit tests, ten integration tests, eight
browser tests, 17 packaged acceptance groups across two profiles, recovery and
audit passed. Exact package/lock/notice changes were independently checked; no
multipart route exists. A finite fieldArrayIndexLimit remains required before
future multipart work. All foundation release blockers remain open.

### Completed increment: selected Node source/resource correspondence

Under NFR-SEC-010 / AC-MNT-004, retain the seven already researched JavaScript
originals spanning six notice sections. The independent source spike matched all
78,421 original bytes by exact size/SHA-256 to observed resources, with no
normalization or source execution. Reuse those source pins and retained originals
for review; do not repeat the same research downloads.

Add a reviewed source policy and deterministic original-byte bundle. Require all
seven fixed section/path/resource triples, including both cp files; derive exact
selected-file correspondence from authenticated original bytes and fresh physical
Node/resource evidence. A separate CI preparation command fetches only the fixed
commit-qualified HTTPS originals with no redirects, 30-second whole-response
deadlines and a 120-second whole-preparation deadline.
Offline preparation from bounded regular files supports diagnostics. The collector
and retained checker consume the bundle without source-network enrichment.

Schema 8 adds these two files to the 80-file manifest. Bind exact archived policy
hashes in the bundle and independently trusted policy content during replay.
Permit only the existing explicit policy-syntax whitespace contract; never
normalize source bytes. Reject omitted/duplicate/reordered pairs, wrong
path/commit/blob/hash/resource, malformed base64/UTF-8, surplus fields, bounded
IO/fetch failures and coherently rehashed forged archives. All six Node scopes
must replay; web/database must not gain a source-correspondence summary.

Keep the full source files out of customer images and never execute them. Preserve
all 24 original residual identities, existing path candidates, ncrypto and open
execution/full-component/license applicability questions. This observation proves
selected source/resource size-hash correspondence, not license acceptance or a
reproducible build. No dependency, image packaging, application, database,
permission or connector-scope change is planned. A reviewed collector/policy/schema
revert with fresh checks is the recovery path. Require native validation,
independent immutable-candidate review, fresh CI and downloaded evidence before
merge. Then prioritize actual disposition and release-review gates.

### Completed increment: Node built-in resource evidence

Under NFR-SEC-010 / AC-MNT-004, collect the exact pinned binary's native resource
table without evaluating resource bodies or invoking accessors. The initial
isolated experiment observed 371 string resources (9,352,034 UTF-8 bytes) and one
own undefined `configs` entry, identically in the three diagnostic images. An
initial all-string assumption failed safely; preserve the undefined observation
explicitly. Enumerate every own key and descriptor, reject symbols/accessors and
unexpected types, and bound keys, strings, aggregate bytes, output and execution.

Retain reviewed identity/resource pins, three raw outputs and command receipts;
schema 7 requires 80 evidence files. Bind each probe to the accepted image's exact
Node binary and original notice before execution, using the existing isolated
container controls. Shared collection and retained replay verify both scopes.
Archive policies must match independently supplied trusted checkout policy
content; final downloaded verification also compares exact candidate Git bytes.

Derive all 24 residual notice sections from existing validated original sections,
without adding editable historical assertions. Six notice paths have seven
candidate resource identifiers observed by the experiment. Preserve these as
path/name candidates, not authenticated upstream source equivalence, execution
or linked-code membership. Keep ncrypto's state derived and unresolved. No
additional source fetch, notice packaging, runtime dependency or application,
database, permission or connector-scope change is needed. Rollback is a reviewed
collector/policy/schema revert with fresh checks.

Run meaningful omission/type/descriptor/byte/receipt/policy-anchor/retained-forgery
tests, required native checks, fresh packaged CI and downloaded comparisons, then
obtain separate immutable candidate review before merge. All release blockers
remain open. PR #35 merged as `43b59f8` after all candidate gates passed; its
merged-main foundation and documentation checks also passed.

Native lint/typecheck, 309 unit tests (54 new resource tests), seven builds,
thirteen documentation regressions and traceability passed. An independent
descriptor traversal reproduced every measured pin. Precheck's lossless-encoding
fix passed separate recheck and final three-image/six-scope replay with unchanged
pins. PR #36 merged as `889716b` after separate candidate approval, passing required
CI and downloaded verification of all 80 files, ten native scopes and six resource
scopes. CI also passed 10 integration/eight browser tests, 17 packaged groups and
both customer profiles. Its duplicate merged-main foundation and documentation
checks also passed at `889716b`.

### Completed increment: Node supplemental original notices

Under NFR-SEC-010 / AC-MNT-004, authenticate four immutable Node source files in a
separate build stage. Preserve nbytes's complete original LICENSE and all 149
reviewed SQLite attribution comments with their full parent-source hashes and
exact byte intervals. Discovery must agree with the reviewed inventory before
writing the index. Fetch only fixed source URLs with bounded HTTPS responses;
repeat source verification and extraction under Docker's disabled network.

Package only the original notice bytes and index under the same Node-specific
supplement directory in API, worker and operations. Keep the executable, complete
root LICENSE and runtime metadata unchanged. Source files and packaging helpers
remain build-only. Retain separate source occurrences, including repeated and
conditional/platform/header comments; do not claim complete linked membership.
ncrypto remains explicitly unresolved and all three literal root-notice gaps
remain distinct from supplemental coverage.

Schema 6 adds the reviewed supplemental policy to the existing 72-file bundle.
Shared collection and retained replay validate exact index/policy/source pins,
every physical notice file and its independent supplying layer, accepted Node
binary and both scanner scopes. Reject source/range substitutions, missing files
and entries together, foreign namespaces, links, extra files and forged coverage.
Run required native validation, fresh packaged CI, downloaded checks and separate
immutable candidate review. Rollback is a reviewed packaging/policy revert; no
database, permission, dependency version or connector-scope change is intended.

Native lint, type checking, 255 unit tests (68 supplemental), seven builds,
thirteen documentation regressions and traceability checks pass. Three diagnostic
images build. Finish six real-image scope replays, exact candidate review and
downloaded CI evidence verification before merging this increment.

### Completed increment: Node binary and component attribution

Under NFR-SEC-010 / AC-MNT-004, retain the current Node/runtime images and add a
reviewed policy for its exact binary, original source notice sections and process
metadata. Collect bounded direct Node metadata from each accepted API, worker and
operations image, with networking disabled, a read-only root filesystem, nonroot
execution, dropped capabilities and no application entrypoint. Verify binary and
notice identity before executing the probe. Archive the raw output and command
receipt, and reconcile both native scanner scopes with the policy and original
notice bytes. Downloaded evidence repeats the same checks, including the existing
runtime-tooling policy. Schema 5 retains the policy and six per-target raw/receipt
files in addition to the existing 65 files.

Keep built-ins distinct from application npm packages; distinguish library,
ABI/data, disabled-feature and source-only records. Preserve all 44 original
source sections and the Node preamble. Explicitly retain unrepresented component
attribution and unresolved source-only membership. Operations legitimately copies
its binary and notice in different layers. This is metadata/source coverage, not
a complete linked-component census, legal decision or vulnerability disposition.

Validate changed/surplus binary copies, wrong image/layer/target, original notice
substitution, missing/extra/mistyped metadata, disabled QUIC values, source-section
omission and forged retained summaries. Required native checks, six real scanner
scope replays, fresh immutable packaged CI and non-author candidate review gate
merge. No runtime dependency, Dockerfile, database, permission or connector-scope
change is planned. Rollback is a reviewed evidence-tooling/policy revert.

## Out of scope

Jira/AI/email, source writes, customer deployment activation, commercial release
and customer-specific identity registration. Generic production paths use a
controlled provider in an isolated test deployment.

## Current state

Main `889716b` contains the reviewed production boundary, executable foundation
contracts, release operations, customer composition acceptance and runtime distribution hardening. STORY-001/002/003
are accepted after exact review, matching CI and merge; STORY-004/005 remain in progress. The user authorized continued
implementation and public branch/PR publication. Earlier TLS, scope and logout
findings were resolved in PR #16.

PR #30 rebuilt Caddy 2.11.4 with pinned Go 1.26.8, retaining the publisher's
build tags, 143 dependency versions and original notices. Independent review,
candidate CI, all 63 artifact hashes and subsequent merged-main CI passed.

PR #31 removed unused curl from the web preparation stage
with offline APK dependency resolution, before the existing fresh layer graph.
The expected removed set is curl, libcurl, brotli-libs, c-ares, libidn2, libpsl,
libunistring, nghttp2-libs and zstd-libs. Verify the actual set against the prior
image; reject unexpected removals or version changes. Preserve BusyBox/wget,
the CA store, OpenSSL and APK's remaining dependencies. Require absence of removed
packages and command/library payloads in both scanner scopes, and retain Caddy's
pure-Go build contract. Run the existing HTTPS, browser, health and both-profile
packaged acceptance on the resulting immutable images. These checks, independent
candidate review and subsequent merged-main CI passed; the reviewed tree is
`a7f64a13f9c6c97c4eec2bb60868fd02ffacbabf`.

PR #32 collects original notices for the exact compiled
Caddy module inventory (main module plus 143 dependencies). A first-party Go
build helper uses only the pinned compiler's standard library, reads binary build
information, verifies cached module ZIP content hashes against compiled h1 values
and a committed inventory, then copies original attribution bytes with an index.
Retain the unchanged Caddy binary, module versions and existing Go/Caddy notices.
No source archives, module cache or helper executable enter the final image.

Pin each module's expected notice paths and hashes as well as its coordinate and
h1, so deleting a nested notice and its index entry cannot silently reduce
coverage. Handle mixed-case paths, nested attribution and identical content for
distinct modules. Offline collection fails on malformed paths, unsupported file
types, bounded size/count overruns, changed module contents or unexpected files.
Reconcile the index, original bytes and exact binary/module metadata independently
in both immutable image scopes; report Go notice coverage separately from npm.
This is a source-module notice superset requiring legal/package-level review,
including terms outside the normally permitted list. It does not approve licenses
or claim complete source-header, generated-data or standard-library attribution.

Completed changes: build helper and its Go tests, committed module/notice inventory,
Docker packaging, Syft capture and JavaScript evidence reconciliation, negative
fixtures, adoption/notice/image records and this plan. No new dependency or
runtime behavior. Verify changed/missing modules, h1/ZIP/notice tampering, missing
nested notices, path escapes, replacements and mismatched binary/index/layers;
then run all required repository and immutable packaged checks and obtain a
separate non-author review. These candidate gates, all 64 downloaded evidence
hashes and subsequent merged-main CI passed. Root owns edits and Git. Rollback is a reviewed
packaging/evidence revert without database recovery.

This is dependency minimization; scanner observations do not establish live
exploitability. Detailed applicability assessment remains private, and
STORY-004/005 and all distribution review gates stay open. No database, connector
scope or authorization policy change. A reviewed revert restores the prior
development image; it does not authorize a customer release of that image.

## Proposed design

### Current increment: npm notice capture and attribution

Under NFR-SEC-010 / AC-MNT-004, correct the twelve observed npm notice gaps
without changing package versions or image contents. Capture the complete original
README files in `@tokenizer/token@0.3.0`, `pg-types@2.2.0` and `pgpass@1.0.5`;
their publisher archives contain the original MIT notices there. Bind selected
files and package manifests to reviewed hashes/sizes and exact lock integrity.
The five versionless RxJS entrypoints must retain their native scanner records
and use only their uniquely enclosing, source-pinned `rxjs@7.8.2` parent LICENSE.
Preserve any child-specific notices and reject cross-package or cross-layer
borrowing, altered bytes, missing parent files and ambiguous identities.

Add the selected README capture globs, an npm notice policy and a first-party
reconciler; run application/notice reconciliation for both squashed and all-layer
scopes. Keep every package/manifest/file/layer occurrence independently recorded.
Schema 4 must retain the policy and replay its original-byte and lock/parent
checks from downloaded native reports. Modified summaries or omitted selected
notice/manifest records cannot waive missing evidence. Preserve the existing Go
contract, native license observations, vulnerability reports and release refusal.

Add meaningful omission, tampering, ownership and retained-report regression
fixtures; run required lint/types/unit/build/documentation checks, actual scanner
capture, full immutable packaged CI and a separate non-author candidate review.
Root owns edits and Git on `feature/npm-notice-attribution`. Update notice,
adoption, image, validation and decision records. No runtime dependency, schema,
authorization or connector change is planned. Rollback is a reviewed tooling and
evidence-policy revert without database recovery. This bounded attribution proof
does not approve complete npm/OS/source-header licensing or a customer release.

### Existing foundation design

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

- 2026-09-08: Begin npm original notice capture/attribution from verified main
  `7c85993` on `feature/npm-notice-attribution`. PR #32 merged-main CI passed.
  Implement the four-package source policy, three exact README capture paths,
  explicit five-entrypoint parent attribution and schema-4 retained evidence
  replay. All 75 focused tests passed after correcting a negative fixture to
  reach the intended guard. An old local fixture image correctly failed the
  pre-existing versioned application inventory check; rebuilt current diagnostic
  images pass all six actual scanner scopes. Local lint/types, all 135 unit tests,
  seven builds, 13 documentation regressions and traceability pass. Immutable CI
  artifacts and a non-author candidate review remain pending. Local BuildKit Git
  provenance warnings keep diagnostic scans distinct from final CI evidence.

- 2026-09-08: Implement the Go notice helper, exact 144-module/197-file inventory
  and schema-3 reconciliation on `feature/go-dependency-notices`. The source audit
  verified every archive h1 and all matching notice bytes. Initial offline
  `go mod download` metadata lookup failed; direct named-cache ZIP reads passed
  under network isolation while independently verifying compiled/pinned h1 values.
  Five Go test groups and 58 JavaScript distribution tests passed. Both rebuilt
  diagnostic image scopes verify all notices and unchanged runtime bytes/versions;
  the old image is rejected. Inventory formatting correctly invalidated a prior
  diagnostic image's byte hash, so it was rebuilt before verification. Local
  lint/typecheck, all 118 unit tests, seven builds, 13 documentation regressions
  and documentation validation passed. Fresh non-author review and immutable CI evidence remain
  required before merge. No license or broader release criterion is accepted.

- 2026-09-07: Begin the two-portfolio authorization matrix on
  `feature/portfolio-authorization-acceptance`. Requirements: FR-ADM-003,
  NFR-SEC-001 and TR-DATA-003; AC-AUTH-002 / SEC-AUTH-002. Create two additional
  same-customer portfolios with one synthetic project each in the existing isolated
  database test. Preserve the manager's seeded Atlas project grant. Grant portfolio
  A through administrator HTTP, prove exact HTTP/repository scope excludes B, deny
  nonadministrator grant/revoke with unchanged grants/audit, then revoke through
  HTTP and prove A access disappears while Atlas remains. Verify exact appended
  audit events and clean up only newly created fixture rows, retaining immutable
  audits. No runtime policy, schema, dependency or connector changes are planned.
  Reconcile prior PR traceability and assess all five STORY-005 criteria after the
  immutable candidate passes independent review, required CI and artifact checks.
  Root owns edits/Git; an independent acceptance auditor checks completeness.
  All local checks pass: 99 unit, ten DB/API, eight browser, seven builds and
  13 documentation regressions. The audit supports conditional criterion acceptance
  while retaining the story-level security assessment. CI-MNT-002 is registered
  from existing execution evidence; no CI behavior changes.

- 2026-09-07: PR #28 merged reviewed `0c9489f` as `519c192` after both independent
  reviews and required checks. Matching CI passed 99 unit, nine database/API, eight
  browser tests and 17 packaged groups; all 63 downloaded evidence files match the
  reviewed tree. See [final evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/28#issuecomment-5572894493).
  The remaining generic identity evidence gap is the two-portfolio boundary matrix;
  customer activation and distribution/signing gates remain separate.

- 2026-09-07: Begin real OIDC expiry acceptance on `feature/oidc-expiry-acceptance`.
  Requirements: TR-AUTH-001/002/003, NFR-SEC-001/005; AC-AUTH-001 / SEC-AUTH-001.
  After existing logout/replay/operator tests, sign in a fresh project-manager
  context and load both its project list and detail. Retain one token only in
  memory; wait beyond its real expiry under a finite overall deadline. Require
  fixed HTTP 401 contracts on protected reads and valid grant writes, unchanged
  business/grant/audit projection, and a real browser request using that same
  token followed by cleared protected data and enabled organization sign-in.
  Valid-token grant writes must first return 403: this checks authentication before
  authorization and does not claim the manager previously had grant authority.
  Require one token exchange, complete original-response disclosure capture and
  run-bound count-only evidence. No clock spoofing, response replacement, token
  refresh, fixture lifetime change, new dependency/schema or connector scope.
  Root owns edits/Git; security and QA independently review the immutable candidate.

- 2026-09-07: PR #27 merged reviewed `3b88a84` as `71b4e6d` after both independent
  reviews and required checks. CI passed 97 unit, nine database/API, eight browser
  tests and 16 packaged groups; all 63 downloaded evidence files match the reviewed
  tree. Merged-main foundation/documentation CI also passed (34090690904/34090690939).
  See [final evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/27#issuecomment-5565987075).
  STORY-005 and release gates remain open; R0 3/5, R1 0/33.

- 2026-09-07: Begin INT-ADM-001 / AC-ADM-001 configuration acceptance on
  `feature/oidc-configuration-acceptance`, following merged PR #26 (`2a9882f`).
  Requirements: FR-ADM-001/002/003, TR-AUTH-001/003, TR-DEP-003 and NFR-SEC-001.
  Extend the bundled customer fixture after its first grant: keep one issued token
  in verifier memory while changing only the operator env-file group mapping and
  recreating only the API on the identical image. Require removed roles with HTTP
  200 identity, HTTP 403 administrative reads/writes, unchanged business/audit
  projection and restored access. Match public OIDC metadata to operator settings.
  Bind ordered nonsecret coordination files to run/profile/session; enforce finite
  deadlines and verifier exit zero. Capture logs before each replacement and scan
  probe responses. Use a ten-minute customer-fixture token lifetime for the bounded
  restart rehearsal; production lifetime remains controlled by the customer's IdP.
  Root owns edits/Git; independent security and QA reviews precede merge. No UI,
  schema, dependency, connector scope, hot reload or customer activation is added.

- 2026-09-07: PR #26 merged exact independently reviewed `40da638` as `2a9882f`.
  Matching CI passed 92 unit, nine database/API, eight browser and 15 packaged
  groups, both customer profiles and all 63 downloaded evidence files. See its
  [review and validation record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/26#issuecomment-5565335909).
  STORY-004/005 and release gates remain open; R0 3/5, R1 0/33.

- 2026-09-07: Begin the bounded STORY-005 security-output and outbound-policy
  increment on `feature/foundation-security-boundaries`. Requirements:
  NFR-SEC-001/004/005, TR-DEP-003, FR-APP-010 and FR-ADM-009;
  AC-SEC-001/003 and SEC-SECRET-001/SEC-OUTBOUND-003. Bind dispatch to
  server-owned current configuration/policy readers and a recording adapter;
  model-style invocation arguments cannot supply approval. Enforce runtime log
  field/category allowlists and verify real HTTP bodies/headers, captured logs,
  browser outputs/assets and nonsecret deployment exports using generated fixture
  secrets. Preserve intended IdP token delivery and logout flows. Root owns edits
  and Git. Assigned independent reviewers: `review_customer_candidate` (security)
  and `baseline_quality` (acceptance/QA); review the immutable final SHA before
  merge. The Product Owner confirmed they are the sole GitHub contributor, so no
  other GitHub collaborator is available for review requests. Record agent review
  assignment and outcome explicitly on the next PR. No live connectors, new
  schema/dependencies or release acceptance are introduced. Full checks and both
  packaged customer profiles remain required; preserve the local database and
  use CI for the complete container rebuild.

- 2026-09-07: PR #25 merged reviewed `5071cea` as `1d0bcb9` after independent
  review and all required checks. The downloaded evidence passed hash and source
  verification. Issue #5 and distribution acceptance remain open. The approved
  public CI status is linked on PR #25; the detailed local report was retained
  locally after automatic approval review rejected public disclosure.

- 2026-09-07: Start runtime distribution hardening from `438cc13`. PR #24's
  exact reviewed tree passed all checks, collected 37 verified files for five
  images and eight browser components; main CI also passed (34052815887/34052815843).
  The observed npm closure contains 18 scanner matches per API/worker image,
  including one Critical and seven High matches; this is not exploit validation.
  Remove unused package managers in a preparation stage and copy its clean
  filesystem into a fresh image graph, preserving Node configuration and original
  notices. Copy Node's original bundled notice beside the operations binary.
  Keep runtime reconciliation on squashed reports and add separate all-layer
  SBOM/SPDX/scans with file/layer attribution, scope-denial tests and tooling
  absence checks. Compare exact accepted images and retain legal, vulnerability,
  complete attribution and signing blockers. Root owns edits/Git; independent
  review and complete packaged CI are required. No OS/base pin, Node version,
  database schema, permission policy, connector scope or release approval changes.

- 2026-09-06: Start STORY-004 evidence increment from main `4ae6986` on
  `feature/distribution-evidence`. ADR-014 defines checksum-pinned SBOM/scanning
  tooling, exact final-image evidence, static-browser component notices and
  fail-closed evidence validation. Collect actual blockers before requesting any
  legal/product decision; commercial approval and signing are not inferred.
  Root owns implementation/Git; an independent agent reviews the immutable SHA.
  Local Docker recovery has passed full database reads and seven browser tests;
  the existing database volume is retained. Use CI for the full packaged rebuild
  after the prior host-storage failure.

- 2026-09-06: PR #22 merged as `27bc174` after exact `c669e95` review and all
  matching checks. Both unchanged shipped customer profiles pass install, operator
  access, upgrade and restore; existing transport denials complete SEC-TLS-001.
  Accept STORY-003; R0 3/5 (60%), R1 0/33. Next: STORY-004 distribution gates,
  then remaining STORY-005 identity tests. Local Docker recovery is pending host
  storage; successful CI evidence is in CUSTOMER_COMPOSITION_VALIDATION.md.

- 2026-09-06: Customer composition increment starts from reviewed main `736b507`.
  Run the shipped customer Compose base and optional bundled database overlay
  directly, with additive controlled IdP/test services only. Verify resolved product
  services are unchanged by the fixture overlay. Exercise empty install, real
  operator login/grant/revoke, backup, stop/migrate/recreate and quarantined restore
  on bundled and external PostgreSQL using identical application image IDs.
  Current-release redeployment is the available upgrade rehearsal; no future schema
  or customer-specific IdP compatibility is implied. Preserve the existing preview.
  Root owns implementation/Git; an independent agent reviews the exact candidate.

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

The 2026-09-07 independent acceptance audit supports conditional acceptance of all
five STORY-005 criteria after the portfolio candidate passes its full merge gates.
STORY-005 remains in progress pending the Definition of Done high/critical security
assessment of unresolved image matches. FOUNDATION_SECURITY_ACCEPTANCE.md records
the mapping and scope; customer activation is separate and no security gate is waived.

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
composition and TLS/external-database acceptance are now verified in PR #22;
STORY-003 is accepted. Full distribution gates and remaining identity validation
stay in this ExecPlan. R0 release and Issue #5 remain open.
