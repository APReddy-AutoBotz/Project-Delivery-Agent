# Decision Log

## Synthetic canonical model activation, 2026-09-09

Under delegated implementation authority, start EXEC-004 after PR #40's verified
merge `5d45e1d0da36218f27b81c55201ec3d3affa1560`. Independent private sequencing and
design reviews support this bounded transition. This decision explicitly supersedes
the historical next-task interpretation in PUBLICATION_RECORD.md and status,
applying the master plan's foundation-control/per-increment/release distinction
and ADR-010. Real-source activation, Issue #5, STORY-004/005 and all unresolved
security/distribution/signing criteria stay open. Accepted story counts do not change.

Start with an internal deterministic temporal fact model for FR-EVD-001/002/003/
004/006/007/010/012. It retains source versions, evidence dependencies and independent
fact dimensions, with explicit as-of and ambiguous-tie behavior. It is not an
authority decision or a public read/write service. Complete current authorization,
trusted ingestion, durable versioning, policy resolution and API/browser evidence
in subsequent reviewed increments. Tracked planning and each immutable code
candidate require independent non-author review and applicable validation.

| Decision | Date | Status | Reference |
|---|---|---|---|
| Build as a standalone product rather than inside AvalaOS | 2026-09-05 | Accepted | BRD, PRODUCT_SCOPE |
| Position as delivery assurance and coordination, not only reporting | 2026-09-05 | Accepted | VISION_AND_STRATEGY |
| Use a TypeScript-first modular monolith | 2026-09-05 | Accepted under 2026-09-06 delegation | ADR-001, ADR-008 |
| Use PostgreSQL and pgvector | 2026-09-05 | Accepted under 2026-09-06 delegation | ADR-002 |
| Use Graphile Worker for schedules and durable background work | 2026-09-05 | Accepted under 2026-09-06 delegation | ADR-003 |
| Use customer-controlled AI provider routing | 2026-09-05 | Accepted | ADR-004 |
| Use customer-hosted, single-tenant deployments first | 2026-09-05 | Accepted | ADR-005 |
| Require human approval for material writes | 2026-09-05 | Accepted | ADR-007 |
| Adopt libraries through package managers, not copied repositories | 2026-09-05 | Accepted | OPEN_SOURCE_POLICY |
| Defer broad connector support until the Jira-plus-spreadsheet loop is complete | 2026-09-05 | Accepted | RELEASE-1-VERTICAL-SLICE |

## 2026-09-06 delegated controller decisions

The Product Owner authorized applying the five controller corrections and starting
implementation. Routine baseline/ADR decisions below are accepted under that
delegation; independent review, checks and merge remain separate evidence gates.

| Decision | Disposition | Reference |
|---|---|---|
| Routine baseline and ADR approval | Delegated to controller after documented gates | DOCUMENT_CONTROL.md |
| Preserve fact origin through staleness/conflict | Accepted | ADR-009 |
| Security enforced in foundation; review exact candidate with non-author | Accepted | ADR-010, CONTRIBUTING.md |
| R1 Jira comments only; fields R2 | Accepted | OD-003, ADR-010 |
| R1 single-project Q&A; portfolio analysis R3 | Accepted | ADR-010 |
| R1 weekday/timezone/quiet hours; holidays R2 | Accepted | OD-006, ADR-010 |
| PowerPoint required; PDF optional; two initial contradictions | Accepted | OD-007, ADR-010 |
| Independent information satisfaction and external action | Accepted | WORKFLOW_ARCHITECTURE.md |
| Retry preflight and restore quarantine | Accepted | APPROVAL_AND_WRITEBACK.md, DEPLOYMENT_AND_OPERATIONS.md |
| No unsupported commercial outcome claim | Retain proposed terms; measure pilot evidence | PILOT_SUCCESS_METRICS.md |

## Publication and partial-increment acceptance, 2026-09-06

The Product Owner explicitly approved public publication. PRs #2/#3/#4 merged
after separate exact-candidate review and passing remote checks. Four milestones
and ten implementation issues are published. Accept the foundation merge only
for its documented synthetic scope; keep STORY-001..005 in progress until their
full contracts pass. Tailwind and pgvector deferrals are outstanding requirement
work, not approved waivers. R0 remains 0/5 and R1 0/33 accepted.

## Customer-hosted boundary implementation, 2026-09-06

Accept ADR-011's native React/Tailwind layer, explicit production file secrets,
shared verified database transport and configurable OIDC scope/logout behavior
under delegated routine architecture authority. Modern pnpm deploy and bounded
optional-build-peer metadata hooks separate runtime packages from development
tools; upstream package files are unchanged. Controlled TLS/Keycloak fixtures run
only in isolated development containers. Commercial distribution, OS license
review, complete notices and final image vulnerability disposition are not waived.
EXEC-003 remains open until its complete acceptance scope is evidenced.

## Executable foundation contracts, 2026-09-06

Accept ADR-012 under delegated routine architecture authority. Shared Zod schemas
generate OpenAPI and validate requests/successful responses; development-only Ajv
independently verifies actual HTTP bodies. Exact MIT Ajv 8.20.0 and ajv-formats
3.0.1 are approved for development validation. TypeScript import/package gates
enforce the documented boundaries, and worker heartbeat persistence moves behind
a domain repository port. No new schema or integration is required. STORY-001/002
acceptance remains conditional on complete evidence, exact review, CI and merge.

## First foundation story acceptance, 2026-09-06

Accept STORY-001 / AC-FND-001 and STORY-002 / AC-DATA-001 under delegated
implementation controller authority. Non-author review approved exact `56e4fbd`;
all three remote jobs passed and PR #18 merged as `5829e23`. Saved CI artifacts
match the reviewed source tree and confirm 44 native tests, eight production
groups, migration/recovery and the remaining required checks. See
FOUNDATION_CONTRACT_VALIDATION.md for full immutable references. R0 is 2/5 (40%);
R1 is 0/33 (0%). STORY-003/004/005, Issue #5, customer deployment and commercial
release/distribution remain open; no release gate or customer prerequisite is waived.

## Foundation operations adapter, 2026-09-06

Accept ADR-013 under delegated routine implementation authority. A separate
operations image reuses approved dependencies and PostgreSQL 17 tools, shares the
pinned Prisma migration ledger/lock, provisions restricted roles, and authenticates
encrypted backups before a fresh quarantined restore. Customer reference Compose
supports bundled or external PostgreSQL. No dependency version, business schema,
connector scope or customer activation is introduced. Cross-cluster bootstrap,
restore promotion/action reconciliation and full distribution gates remain open.
Independent review and immutable packaged acceptance are required before merge.

## Foundation security criteria and story gate, 2026-09-07

Under delegated authority, conditionally accept AC-ADM-001, AC-AUTH-001/002 and
AC-SEC-001/003 after the portfolio authorization candidate passes exact non-author
review, required CI, downloaded evidence verification and merge. Record actual
commit/check identities on the PR and Issue #5 before updating criterion checkboxes.
See FOUNDATION_SECURITY_ACCEPTANCE.md for the requirement/evidence mapping.
STORY-005 remains in progress: the Definition of Done high/critical security review
requires assessment of unresolved image matches, which are neither proven
exploitable findings nor evidence of their absence. No DoD waiver or customer
credential prerequisite is introduced. R0 stays 3/5 (60%); R1 stays 0/33.

The same effective gate applies to AC-MNT-002: register the already executed
CI-MNT-002 workflow and documentation regression evidence without accepting the
broader STORY-004 distribution criterion. After verified merge, six additional
Issue #5 criterion checkboxes may be checked; story counts remain unchanged.

## Web runtime build, 2026-09-07

Under delegated controller authority, retain Caddy 2.11.4 and its upstream
module selection while rebuilding with the pinned Go 1.26.8 toolchain. Preserve
the supported HTTPS interface, original notices and complete scanner evidence.
Require a fresh layer graph and reject inconsistent binary/compiler copies in
both image scopes. This adoption becomes effective after exact independent
candidate review, required checks and verified merge. ADR-014 and EXEC-003 record
the constraints; detailed security assessment remains private. No story,
distribution, signing or customer deployment gate is waived.

## Web transfer-tool exclusion, 2026-09-08

Under delegated implementation authority, remove the unused curl closure from
the existing web image using its offline package resolver. Preserve Caddy,
BusyBox health checks, shared native dependencies and original attribution.
ADR-014 and EXEC-003 require an exact package-set comparison, absence of removed
payloads from both image scopes and full candidate acceptance before merge.
This reduces the shipped dependency inventory without assigning exploitability
verdicts or waiving distribution, legal, signing or story completion gates.

## Compiled Go notice evidence, 2026-09-08

Under delegated routine implementation authority, preserve original attribution
for the existing Caddy module graph with a standard-library-only build helper.
Pin all compiled module h1 values and discovered original notice paths/hashes;
verify source archive contents offline and reconcile actual shipped bytes in both
image scopes. ADR-014 records the schema-3 evidence contract and source-superset
limits. No module, license category or runtime policy is newly adopted. Unclear
or custom source-subtree terms remain review-required, and STORY-004/005, legal,
security and signing gates stay open. Exact non-author review, required checks
and immutable artifact verification are required before merge.

## Npm original notice attribution, 2026-09-08

Under delegated routine implementation authority, capture the three existing
README notices and explicitly associate five source-pinned RxJS entrypoints with
their physical parent LICENSE. Preserve original bytes, native scanner records
and separate target/image/manifest/file/layer occurrences. ADR-014's schema-4
amendment requires source-file/lock-integrity pins, both-scope reconciliation and
replay from retained original evidence, including missing/altered-file denials.
No dependency, image package contents or license category is newly adopted.
Full candidate validation and a non-author immutable-SHA review gate merge;
commercial licensing, vulnerability dispositions and trusted signing stay open.

## Node binary metadata and source coverage, 2026-09-08

Under delegated routine implementation authority, bind the unchanged Node binary
and original notice to a reviewed source/metadata policy and each accepted image.
Capture direct metadata with bounded isolated execution and replay the full
contract from retained schema-5 evidence in both scopes. Preserve 29 metadata
keys, 44 original source sections, valid cross-layer operations packaging, and
explicit ABI/data/disabled/source-only distinctions. Missing component-source
attribution remains unresolved; no license choice, dependency upgrade, runtime
permission or customer-release approval is introduced. ADR-014 and EXEC-003 record
the contract and limits. Non-author immutable candidate review, full required CI
and downloaded evidence verification remain merge gates.

## Node supplemental original source notices, 2026-09-08

Under delegated routine implementation authority, package nbytes's original
LICENSE and all reviewed SQLite attribution comment occurrences for the existing
Node binary. Authenticate complete immutable parent sources before offline
extraction and retain original bytes, source spans and separate occurrences.
Ship only the notices/index; keep source and helper build-only. ADR-014 and
EXEC-003 require fixed component/source coverage, bounded reads, image/layer
binding and shared schema-6 collection/retained replay. ncrypto, literal root
notice gaps and linked-source/legal applicability remain explicit review work.
No dependency version or licence choice is made. Required validation and a
separate immutable candidate review gate merge; distribution approval stays open.

## Observed Node resource inventory, 2026-09-08

Under delegated routine implementation authority, retain bounded observations of
the exact Node binary's native resource table. Independent design review narrowed
the scope to measured resource pins and residual sections derived from existing
validated notices, without duplicate historical assertions. The initial experiment
found an undefined `configs` property alongside 371 strings; preserve its exact
descriptor rather than silently omitting it. An independent traversal reproduced
the inventory. Add lossless UTF-8 encoding checks and trusted checkout policy
anchoring before accepting retained observations. ADR-014 and EXEC-003 require
all 80 files, both scopes, unchanged runtime files and full candidate validation.
Candidate resource names do not authorize source-membership or legal conclusions.
No dependency, notice packaging or licence choice is introduced; all release
review gates remain open.

## Selected Node source/resource correspondence, 2026-09-08

Under delegated routine implementation authority, retain seven independently
authenticated JavaScript originals that match existing observed resources by
size/SHA-256. Bind a deterministic original-byte bundle to reviewed source pins
and both existing Node policies. Fixed-pair completeness, exact source bytes,
bounded separate preparation and offline physical/resource replay are required
by ADR-014 and EXEC-003. The schema-8 manifest has 82 files. A separate fetch
receipt repeating the bundle's own assertions adds no independent authority.

Preserve all residual section identities and distinguish verified selected-file
correspondence from unresolved execution, full membership and licence applicability.
ncrypto and all release blockers remain open. No runtime source packaging,
dependency version, application, database, permission or connector scope changes.
After this bounded correspondence bridge, prioritize actual vulnerability
dispositions and release review. Required validation and separate non-author
immutable candidate review still gate merge.
