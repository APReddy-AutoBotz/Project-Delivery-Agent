# EXEC-008: Durable scalar-conflict reconciliation

Status: Design approved under delegated controller authority; implementation in progress.
Owner: Implementation controller.
Requirement IDs: FR-EVD-001/002/003/004/006/007/009/010/012, FR-ADM-005,
FR-MOD-004, NFR-SEC-001/002/005/009, NFR-REL-001/002/005, NFR-MNT-002/004/005.
GitHub issue: #6; STORY-012, AC-EVD-004, FAIL-009 and INT-EVD-004.
Target release: R1. Last updated: 2026-09-14.
Applicable ADRs: 001-014; no new infrastructure, dependency or autonomous action.

## Objective

An authorized manager explicitly checks an existing scalar fact under its current
authority policy. A complete, currently readable CONFLICTING assessment whose
policy requests reconciliation atomically creates or reuses one durable internal
OPEN request. Its original frozen proof is available to the exact currently
authorized configured PM. Missing PM configuration creates an honest unassigned
request, not NO_REQUEST. Preserve both conflicting values and all fact dimensions.

## In scope

Generic scalar facts, including a genuinely configured project's forecast date and
legacy base projects without canonical metadata; fresh owned scalar checks;
actor-scoped command retry distinct from actor-independent business deduplication;
append-only assignment history, scoped API/PM presentation and complete native SQL,
concurrency, upgrade, encrypted restore and packaged/browser acceptance.

## Out of scope

No invented milestone/canonical project, authority winner, evidence sharing,
responsibility editor, external message/write-back, acknowledgement/read receipt,
approval tool, scheduler, AI invocation, source resolution or automatic closure.
GOLDEN-003's broader leadership-answer/health behavior and all customer release
gates remain separate. No test definition or ownership is narrowed for acceptance.

## Current state

Clean main `2bc8c93ff320b9557f3cdb9cbbda88ecd0a55608` contains PR51 canonical
requests and PR52's corrected progress record. Both required candidate gates passed;
the PR52 main repeat Foundation34758388160 and Documentation34758388168 also passed.
R0 is 3/5, R1 2/33; Issue6 remains open, STORY-012/FAIL-009/GOLDEN-003 planned.
INT-EVD-004's literal retained-value/nonselection behavior is implemented.

The scalar evaluator sets `reconciliationRequired` but creates no request. The
canonical rule correctly returns UNKNOWN for unresolved scalar target states, so
it cannot substitute. Existing transaction-scoped prepare/persist methods and the
frozen FactAssessment proof are reusable. All six released migrations are immutable.
The default local `pdaa` contains an older draft and must not be used for migration,
seed, reset or acceptance. Preserve all retained databases, volumes and originals.

## Proposed design

### Eligibility and historical proof

Keep `resolveSourceAuthority`, its exact JSON result and `valid_fact_assessment`
semantics unchanged. Evaluate only a newly prepared scalar snapshot, after locks
and the single server clock. Eligibility is exactly: complete true, status
CONFLICTING, revalidationRequired false, reconciliationRequired true, selected
policy nonnull and applicable with conflictBehavior REQUEST_RECONCILIATION, and
every retained version available. No current-only contributor filter is applied.
Unresolved recorded conflicts and stale higher-authority contradictions remain
requestable with visible freshness warnings; requesting is not selecting a value.

All other valid outcomes persist an owned negative check with NO_REQUEST and null
requestId. INCOMPLETE/REVALIDATION_REQUIRED/NO_POLICY/POLICY_NOT_APPLICABLE,
RETAIN_CONFLICT, resolved, ambiguous and unknown outcomes cannot create a request.
Malformed or over-budget derived identity fails atomically with a fixed error;
never truncate contributors or convert integrity failure into NO_REQUEST.

The frozen FactAssessment retains its complete version/conflict prefix, policy,
values, provenance/freshness/conflict, evidence IDs and asOf. Every original source
dependency, not only conflict contributors, is reauthorized on each delivery.
Retain ordinary assessment GET's existing project/role/all-source authorization
for these scalar proofs: it is an evidence read, not request management/delivery.
Never add request/recipient/grant metadata to that existing scalar response.

### Exact contributor identity and business equivalence

Protocol revision is `scalar-authority-conflict/v1`. Identity is compact ASCII JSON:

```text
["scalar-authority-conflict/v1",customerId,projectId,factId,policyRevisionId,
 [[versionId,sourceId,valueType,[evidenceId,...]],...]]
```

Every identity ID is canonical lowercase UUID text. valueType is the existing
typed-value enum. The complete union of version IDs from ALL output conflict groups
is unique and sorted by UUID text; each tuple contains its original source ID,
typed value discriminator and complete sorted unique evidence IDs. Require exact
group evidence unions and existing available version references. The source/evidence
scope and actual typed value are bound by immutable version rows and the validated
frozen proof, not by trusting an arbitrary caller identity. No free text, number
value, source record string or factType is serialized into this identity; factId
uniquely binds factType. This avoids JS/PostgreSQL Unicode/number formatting drift.

Exclude actor, asOf, assessment/check IDs, latest publication/fact/conflict prefix
revisions, conflict row IDs and group kinds. Persisted RECORDED groups duplicate
derived participants without changing the business case. The selected immutable
AuthorityPolicyRevision.id is included; future publications that do not change the
selected policy do not change identity. Changed contributor/version/evidence or
selected policy creates a new case. Different conflict graphs over the same full
participant set reuse one fact-level request; no graph-identical-proof claim.

TypeScript uses JSON.stringify on these arrays; SQL reconstructs the same bytes
with ordered string_agg/format over validated UUIDs and fixed value-type tokens,
not jsonb::text, locale ordering or whitespace replacement. SHA256 is computed in
the data layer and SQL, never in the domain through Node imports. Bound at most
1,000 versions, 64,000 aggregate contributor evidence references and 4 MiB ASCII
identity; account before expanding arrays. Compare full identity on hash reuse;
any unequal collision is a fixed integrity failure, not reuse or replacement.

### Commands, transaction and delivery

New request action input is `{projectId,factId,idempotencyKey}` only; normalized UUID
IDs and the existing 1..128 ASCII key. Hash exactly compact ordered JSON
`{"projectId":"<uuid>","factId":"<uuid>"}`. Customer and subject come from identity,
not client fields. No caller policy, result, time, recipient, enable flag or owner.

Use ReadCommitted/maxWait5000ms/timeout10000ms. Lock scoped Project FOR UPDATE,
then the sorted UNION of actor and sole configured PM grants FOR SHARE, then the
target fact FOR UPDATE. One server millisecond clock follows coordination. Current
matching project_manager, portfolio_manager or pmo_admin role+grant is required;
leadership ordinary capture does not permit this material request operation.
Existing source/grant/policy writers coordinate through these locks.

Lookup the actor/project retry key; changed fact hash fails IDEMPOTENCY_CONFLICT.
An exact replay returns original check/assessment/request identities and original
outcome, with fresh current delivery and latest assignment metadata. It creates
no new proof/conflict/audit/assignment and does not reevaluate or reroute the case.
For a new key, generate check ID, prepare/persist a newly owned scalar assessment,
derive eligibility/identity, create or reuse the business request, create initial
assignment only for CREATED, append check/audits and seal the new request. Commit
all or nothing. Never adopt or re-own any earlier standalone or milestone proof.

Business reuse retains the original request/proof and assignment; the new check
owns its own new scalar assessment. Negative later checks, expiry, policy change
or source revocation do not close earlier requests. A hash collision or invalid
stored proof aborts the transaction. Errors are finite and do not expose content.

Extract a narrow transaction-scoped scalar delivery method from the existing
private deliver function; do not call a public repository method that opens another
transaction. New check response returns that caller-authorized assessment and
metadata only, not the original request proof through a management shortcut.
PM request detail independently requires latest ASSIGNED recipient equality,
sole current configured PM, actual current IdP project_manager role, current same-
role scope and all original source dependencies. Wrong scope/recipient gives fixed
404; lost evidence yields the existing restricted envelope with null result.

### Routing and immutable assignment snapshot

Reuse existing legitimate ProjectResponsibility configuration, never a grant-only
guess. Zero PMs -> NO_CONFIGURED_PM; more than one -> AMBIGUOUS_CONFIGURED_PM;
exactly one without matching grant -> PM_SCOPE_UNAVAILABLE; otherwise ASSIGNED.
Choose project grant before inherited portfolio grant, then UUID order. Creation
cannot attest the eventual recipient's current IdP role; delivery always checks it.

Each assignment additionally stores capturedPortfolioId and nullable
configurationReceiptId. Under the Project lock, pin the exact sealed canonical
project creation receipt if it exists, otherwise null; null configuration requires
NO_CONFIGURED_PM. This is a routing snapshot only and never a request prerequisite.
Historical validators inspect the pinned immutable configuration, not the current
Project portfolio, current grants or newly added configuration. Later canonical
configuration must not invalidate an earlier legitimate unassigned record.
The INSERT guard compares the captured snapshot with actual current configuration,
portfolio and deterministically selected grant at that command's linearization.

Refresh is a separate append-capable action with requestId, expectedAssignmentRevision
and idempotencyKey. Require current last revision, increment by one, store predecessor
ID and full historical routing snapshot. Same key/same hash replays the original
assignment attempt; changed hash fails before revision checking. Negative/repeated
unassigned attempts remain explicit immutable revisions. Reuse does not refresh.

## Data model or migration impact

New additive migration 7, `202609130001_scalar_reconciliation_requests`. No old row
backfill/adoption. Three new business tables (39 -> 42); all six prior migration
checksums remain unchanged. Prisma mirrors every field/relation/index below; SQL
owns deferred constraints/guards. IDs are UUID, times timestamptz(3), subjects
varchar(256), retry keys varchar(128), hashes char(64); checks require finite times,
nonblank subjects, existing key syntax and 64 lowercase hex hashes.

### FactAssessment ownership

Add nullable scalarReconciliationCheckId UUID, globally unique. Replace only
FactAssessment_capture_shape with disjoint cases: SCALAR has both owners null;
MILESTONE has milestoneAssessmentId nonnull and scalar owner null;
SCALAR_REQUEST has milestone owner null and scalar owner nonnull. Existing defaults
remain SCALAR. Add unique `(customerId,projectId,factId,id,scalarReconciliationCheckId)`.
Existing immutable-header guard already prohibits owner mutation through its full
row comparison. Preserve all old prefix, milestone birth, seal and dependency guards.
New deferred ownership constraints/COMMIT trigger cover SCALAR_REQUEST from birth.

### ScalarReconciliationRequest

Fields: id PK; customerId, projectId, factId; ruleRevision varchar(48) fixed protocol;
originalAssessmentId UNIQUE; originCommandId UNIQUE; contributorHash; contributorIdentity
text (1..4194304 octets, SHA256 equality); createdBy, createdAt; state varchar(16)
fixed OPEN; auditEventId UNIQUE; sealed boolean default false.
Unique `(customerId,projectId,factId,id)` and
`(customerId,projectId,factId,originalAssessmentId)` (redundant scoped uniqueness
required for Prisma's one-to-one proof relation) and
`(customerId,projectId,factId,id,originCommandId,originalAssessmentId)`;
business unique `(customerId,projectId,factId,ruleRevision,contributorHash)`;
page index `(customerId,projectId,createdAt,id)`.
Same-scope fact FK to ProjectFact; original proof FK includes customer/project/fact;
audit FK `(customerId,auditEventId)` is deferred. Birth FK to the exact check's
`(customerId,projectId,factId,requestId,id,assessmentId)` is deferred.

### ScalarReconciliationCheck

Fields: id PK; customerId, projectId, factId; subject, idempotencyKey, requestHash;
assessmentId UNIQUE; requestId nullable; outcome varchar(16); occurredAt;
auditEventId UNIQUE. Outcome NO_REQUEST iff requestId null, otherwise CREATED/REUSED.
Retry unique `(customerId,projectId,subject,idempotencyKey)`; unique owner tuple
`(customerId,projectId,factId,assessmentId,id)` and birth tuple
`(customerId,projectId,factId,requestId,id,assessmentId)`.
Same-scope request FK is immediate. Reciprocal proof/check FKs match all five
owner fields and are DEFERRABLE INITIALLY DEFERRED, with RESTRICT update/delete.
Audit FK is deferred. FactAssessment's scalar owner points back to this exact tuple.

### ScalarReconciliationAssignment

Fields: id PK; customerId, projectId, factId, requestId; revision/expectedRevision
integers; previousAssignmentId nullable; kind varchar(16) INITIAL/REFRESH;
recipientSubject/responsibilityId nullable; reason varchar(32); actor, occurredAt;
auditEventId UNIQUE; idempotencyKey/requestHash nullable; capturedPortfolioId UUID;
configurationReceiptId nullable UUID; nullable grantId/grantCustomerId/grantSubject/
grantScopeType(varchar16)/grantScopeId/grantRole(varchar32).
Revision 1..2147483647 equals expectedRevision+1 using bigint arithmetic. INITIAL:
revision1, expected0, null predecessor/key/hash. REFRESH: revision>1 and all three
nonnull. ASSIGNED requires all recipient/responsibility/grant fields, matching
customer/subject, project_manager role and project or captured-portfolio scope.
Unassigned reasons require all recipient/responsibility/grant fields null.
Unique scoped request revision and predecessor tuple; actor/request retry unique.
Same-scope request, responsibility, predecessor and configuration receipt FKs;
captured portfolio FK to same customer. Audit FK deferred. Every FK RESTRICT.

### Exact integrity predicates and guards

`scalar_reconciliation_identity(uuid)` reconstructs identity from a valid sealed
FactAssessment's original rows, exact conflict participant/evidence union and selected
policy; null only for a valid ineligible proof. Integrity error cannot become null.
`valid_scalar_reconciliation_assignment(uuid)` checks exact snapshot/initial or
refresh predecessor/command hash/audit; no live grant/source/configuration lookup.
`valid_scalar_reconciliation_request(uuid)` checks OPEN, exact fresh original owned
positive proof/identity/hash/rule, CREATED birth command, original subject/asOf,
request/check audit bytes and valid revision1 assignment. It may inspect its birth
check fields directly, but must not recursively call check validation.
`valid_scalar_reconciliation_check(uuid)` validates its exact sealed owned proof,
command hash/asOf/subject/audit and outcome complement; positive outcomes bind full
identity and valid request. CREATED is its birth proof/check; REUSED has different
check and assessment IDs and retains the request's original proof. Validators catch
malformed data as false; callers require IS TRUE, never truthiness of NULL.

Request INSERT must start unsealed and reference its newly owned sealed positive
proof. Only the unsealed->sealed transition is permitted, with every other column
unchanged and all request predicates true. Check INSERT requires correct unsealed
birth request for CREATED or sealed older request for REUSED; no mutation/deletion.
Assignment INSERT validates current configuration/grant selection, expected latest
revision, correct sealed/unsealed parent for refresh/initial and snapshot equality;
no mutation/deletion. Guards lock Project before row/grant work.
Deferred INSERT triggers require valid sealed request/check/assignment and reciprocal
owned FactAssessment, including negative checks. Disallow TRUNCATE on all three.
No self-reported hash, shape-only check, forced SET CONSTRAINTS or missing owner may
substitute for genuine native COMMIT completeness.

Audit event names: scalar.reconciliation.checked, .requested and .assigned.
Exact detail respectively: `{projectId,factId,checkId,assessmentId,requestId,outcome}`;
`{projectId,factId,requestId,assessmentId,checkId}`;
`{projectId,factId,requestId,assignmentId,revision,reason}`. Match actor/time/customer
and immutable event ID. Refresh command hash is ordered compact JSON of projectId,
requestId, expectedAssignmentRevision; body contains no routing override.

## Security and privacy impact

Finite API SELECT/INSERT on the three tables, UPDATE(sealed) only on request;
retain FactAssessment UPDATE(sealed) only. Worker gets no business grants; backup
gets SELECT. Revoke PUBLIC/API/worker/backup execution of every new function by
signature; grant API EXECUTE only on required historical predicates/identity.
Restore --no-acl must reconstruct the same finite boundary. No privilege from
prototype/class method exposure or client capability flags substitutes for auth.

## Connector and permission impact

No connector scope or external side effect. New manager actions use existing
append-capable roles; PM detail/queue remains exact recipient-specific. Ordinary
leadership scalar capture/GET retain their read boundary and no new request effect.

## Public API and user experience

Separate scalar routes preserve the shipped milestone wire contract:

- POST `/api/projects/:id/scalar-reconciliation-checks`: factId and idempotencyKey.
- GET `/api/projects/:id/managed-scalar-reconciliation-requests`: management queue.
- GET `/api/projects/:id/scalar-reconciliation-requests`: current configured PM queue.
- GET `/api/projects/:id/scalar-reconciliation-requests/:requestId`: PM frozen proof.
- POST `/api/projects/:id/scalar-reconciliation-requests/:requestId/assignment`:
  expectedAssignmentRevision and idempotencyKey.

Strict shared Zod DTOs and generated OpenAPI; fixed existing 400/401/404/409/413/415/
500 errors. New check result contains checkId/outcome/replayed, caller-authorized
scalar AssessmentDelivery and nullable request summary. Summary has id/projectId/
factId/factType/createdAt/OPEN/latest assignment metadata, never proof, contributor
identity, grant snapshot or source values. Queue is live bounded keyset pagination
with `(createdAt,id)`, limit1..20, fetch21; no aggregate counts or proof-loading.
Detail binds request fact and original positive assessment and ASSIGNED recipient.
Current source loss returns restricted assessment/result null, not old proof.

Evidence view offers a separate “Check and request reconciliation” action only for
append-capable users. Keep standalone “Capture assessment” behavior unchanged and
label the old flag as not itself a request. Show CREATED/REUSED/NO_REQUEST honestly,
pending/unassigned status, original historical asOf and all retained values/badges.
PM queue/detail presents original proof and never “sent/read/approved/resolved”.
Retain uncertain command keys until conclusive retry; changed target/session must
not attach an old command to another fact/actor. Clear protected detail and query
state on current denial/identity change; retain unchanged native response draining
and packaged recorder shutdown assertions. No token persistence or content logs.

## Files and modules expected to change

Domain scalar identity/contracts and tests; data Prisma/new migration, authority
transaction delivery/ownership seam, scalar repository and integration tests; API
controller/contracts/composition/OpenAPI; evidence and PM UI/browser tests; operations
grants/restore predicates; all native and packaged inventories, genuine prior-schema
projection/upgrade fixtures, scalar workflow/COMMIT/race/restore evidence and docs.
Existing milestone semantics, dependencies and all released migrations unchanged.

## Open-source dependency impact

None. Reuse installed approved Zod, Prisma/PostgreSQL, React and test infrastructure.

## Implementation stages

1. Independently review this concrete design; resolve findings before code/DDL.
2. Implement pure eligibility/identity and strict contracts, additive persistence,
   native COMMIT/permission/retry/race controls and recovery inventories.
3. Wire the scoped API and genuine scalar manager/PM workflow; implement browser
   and both shipped-profile evidence, upgrades and quarantined restores.
4. Review exact immutable candidate, run required local and GitHub checks, authenticate
   original packaged evidence and obtain independent artifact reviews; expected-head
   merge and verify actual tree/parents/raw files. Record complete behavior only.

## Test and evaluation plan

Prove policy opt-in/out, missing/future/disabled policy, resolved/ambiguous/unknown,
incomplete/restricted prefix, stale recorded/higher-authority conflicts; deterministic
input permutations/duplicate group equivalence, changed selected policy/contributor,
arbitrary original text/number values without identity serialization drift, bounds,
malformed identities and exact TypeScript/PostgreSQL byte correspondence.

Native API-role SQL COMMIT controls must reject orphan/borrowed proof, wrong owner,
cross-scope, wrong positive/negative outcome, omitted evidence, altered identity/hash,
incorrect request/check/audit, missing initial assignment, wrong configuration/grant,
revision/predecessor misuse, postseal mutation/insertion/truncation and privilege
escalation. Positive controls genuinely commit. Whole relevant table projections
must prove rollback after each negative control; retain native SQLSTATE/outcome.

Actual concurrent connections with observer/latch prove project->grant->fact ordering,
duplicate business/actor requests, changed-key reuse, competing refresh CAS, source
revocation, role/grant loss and policy change, including replay and recipient GET.
Use fixed existing transaction/operation deadlines; do not mask failed assertions.

UI/HTTP prove configured PM scalar delivery, management versus PM permission, ordinary
leadership capture without request, legacy unassigned, repeated key and new-key
business reuse, changed contributor, restricted proof, natural OIDC expiry and
session teardown. Both bundled and external customer profiles must exercise the
real scalar action, not a fake milestone or composite-only substitute.

Extend all explicit 39-table inventories to the exact 42 tables, with normalized
scalar rows/audits/full proofs before and after encrypted restore. Extend genuine
prefixes1..6 ->7, populated prefix6 retaining old scalar/milestone/request history,
correct historical ACL and column sets. New functions and scalar owner-orphan checks
must be included in whole-database restore validation. Three packaged fresh-target
quarantined restores and both profiles remain required. Run full applicable lint,
types/unit/build, architecture/contracts/dependencies, integration/browser/docs and
documentation regression suites. No default `pdaa` operations.

## Rollback and recovery

No down migration or deletion of owned history. Use a compatible reviewed application
rollback that preserves additive tables, or matching reviewed operations tooling and
encrypted backup into a fresh runtime-CONNECT-quarantined target. Release6 archives
do not become direct release7 restores by changing labels; use genuine upgrade.
Never resume application/worker automatically after restore.

## Progress log

2026-09-14 current-authorization acceptance slice (FR-EVD-009/012,
NFR-SEC-001/REL-001): extend the actual-API contention harness with source-first,
read-first, creator/recipient PM-grant-first and policy-first cases, plus a separate
current authenticated actor-role-loss control. The latter supplies leadership
instead of project_manager with the same subject and unchanged grants; it is not
an IdP event or mutation of an in-flight JWT. Select the removed source through
original persisted proof/version/evidence joins. Require exact retained histories,
fresh owned negative checks, original IDs and values, source/grant/policy snapshots,
per-operation audits and observed backend blocking paths. Preserve repository
transaction options, roles, migrations and all original run evidence. Independent
closed-inventory readers accompany primary and both customer-profile wiring.
Execution and review results will be recorded below; wiring alone is not packaged
acceptance. Native scalar COMMIT controls remain a separate outstanding block.

2026-09-13: independent non-author workflow/API/authorization/UI and persistence/
DDL/COMMIT reviewers accepted design candidate
`5e5987a343c9c7cc6fcf876fd2f9b6451473a593`, tree
`a90aa74c929194a72ddc0b7bc9b77cc8db4e2d74`, with no P0/P1 findings.
Controller approves the routine design under existing delegation and starts stage2.
This is design approval only; implementation, native execution, acceptance and
release gates remain open. Preserve pinned historical routing and exact older
schema projections, including implicit Prisma reads/writes of nullable columns.
Retained independent workflow report SHA256:
`f974c895fbaba0f214f205cdc53d725372e3b2eb8e2b226098abb44228bc48d9`;
persistence report SHA256:
`85fc66f41cd1c5ba4413cda4fe5018ddc6fe0f9b83c54bd42aec9679bc91438a`.

2026-09-13: domain identity/contracts implemented at `46bf9f5`; independent bounded
kernel review found no P0/P1 and one P2 test-sensitivity issue. Corrected that test
to assert zero array getter accesses and added a four-contributor union vector.
The original kernel's 39 new unit tests and expanded 114 tests across five files
passed; domain types/lint/architecture and documentation validation passed.
Migration7, Prisma ownership relations, scalar repository and finite ACL/restore
predicate additions are drafted. Generated-client validation initially required
the redundant scoped proof unique key above; generation and domain/data/operations
builds then passed. All seven migrations applied in new isolated synthetic database
`pdaa_test_1789308047968`; default `pdaa` untouched. The first integration run had
three fixture failures because assertions lacked an explicit validity period;
no eligibility rule was changed. Corrected synthetic validity and reran: five
integration tests passed. Broader native-role/COMMIT/race/upgrade/restore/API/UI
and exact-candidate review remain pending; no full-stage acceptance claim.

2026-09-13: verified clean main and successful postmerge repeat; created
`codex/scalar-reconciliation-requests`. Read scalar source/authorization/persistence,
approved requirements/ADRs and private feasibility/routing inputs. This proposal is
not design approval or implementation evidence. Independent review is next.

## Decisions made

2026-09-13 implementation checkpoint: five scalar API routes and the explicit
check action, management/PM queues, original-proof detail and saved request links
are implemented in the local candidate. The focused Chromium journey passed:
create, fresh-check business reuse, assigned PM saved-link login, original proof,
and whole-proof withholding after source access withdrawal. This is one local
browser regression, not packaged-profile or full workflow acceptance.

Persistence review of `7f3b0e0` requested corrections. Four audit comparisons in
the unreleased seventh migration now interpret retained timestamp-without-zone
audit fields explicitly as UTC; a fresh isolated database
`pdaa_test_1789309024135` passed historical predicate validation under Asia/Kolkata.
The same negative control failed on the retained pre-fix database. New-write
testing additionally reached the retained assessment seal guard under a non-UTC
connection; scalar check/refresh transactions now establish transaction-local UTC
without changing pooled-session defaults. Assignment timestamps are constrained
to the DTO's year range. Exact native history-guard assertions replace broad
mutation failures; genuine orphan-COMMIT transport evidence, coherent year-range
negative control and independent correction review remain pending.

The full unit run initially reported 1173 passes and one obsolete finite-function
inventory assertion. That assertion now covers all three migration-5/6/7 revoke
sets and only the nine allowed API functions; this does not substitute for actual
role execution. Six-prefix populated upgrades, 42-table inventories, native-role
COMMIT/races, bounded-load checks, three restores and both packaged profiles still
remain. No acceptance counts, issue closure or release gates change here.

Focused rerun: all 1174 unit tests across 51 files passed; nine scalar integration
tests and 15 history-guard helper tests passed. Data build, API/web type checks,
lint, diff whitespace checks and documentation validation passed. The non-UTC
write test verifies creation, refresh, subsequent PM delivery and restoration of
the original connection timezone. These counts describe only the executed suites,
not the pending native-role/upgrade/restore/packaged acceptance matrix.

Independent API/UI review of `170c2ee` found no P0/P1 in that bounded scope and
one P2: resetting the management queue could strand a pending page-two assignment
retry. The reset is now disabled while a command is pending. Both focused browser
journeys passed, including controlled second-page metadata with real API assignment
requests, an aborted first attempt and an exact-body/key retry. This controlled
pagination test is not evidence of native database pagination correctness.
Retained review report SHA256:
`bbbcea1ab74067880878fcee7aded5daac2098a9f90672c1d9745134f29db424`.

The orphan negative control now observes the unchanged native COMMIT transport
with the existing acceptance observer and an independent connection, requires the
exact scalar guard/FK error, verifies the returned callback and settled COMMIT,
and compares the full relevant rollback projection. A coherent year-10000 refresh
and matching audit is rejected by the exact assignment shape constraint, with
audit and assignment rollback verified. Ten scalar integration and 18 helper
tests passed. These are isolated local-principal probes, not the remaining actual
API-role matrix or independent persistence correction approval.

One fact-level request over the full conflict participant union; explicit policy
opt-in and manager action; separate scalar family rather than weakening milestone
predicates; immutable routing snapshot permits honest legacy unassigned history.
Existing configured PM routing suffices without a new responsibility editor.
These routine design choices are approved for implementation under delegated
controller authority after the independent design reviews recorded above.

## Risks and mitigations

Serialization mismatch -> UUID/type-only identity and native byte vectors. History
adoption -> immutable ownership from birth and reciprocal COMMIT checks. Recipient
substitution/leak -> exact current role/grant/configuration/source checks. Historical
routing drift -> pinned configuration snapshot, separate current INSERT/delivery
guards. Scope inflation -> unchanged authority/milestone/read semantics and no new
external action. Cost/timeout -> bounded prefixes/identity/queues and real-role races.

## Validation evidence

2026-09-13 finalized upgrade repeat: run
`pdaa-acceptance-1789314047945-8b7d00af` passed all six genuine populated prefixes
to migration seven, retaining respectively 7/14/21/31/36/39 prior business tables
and producing 42 current tables. Every receipt includes positive pre-upgrade
row counts and unchanged-source hashes. Root separately read the original six
receipts with the native COMMIT/race readers and an independent finite per-prefix
table-inventory reader. All passed; each contains 12 released milestone-family
native COMMIT cases. These are not the still-pending new scalar native matrix.
Prefix six retained original check/request/proof identities and passed recipient
revocation, regrant-without-reroute and explicit-refresh original-proof delivery.
All generated clusters, volumes and original diagnostics were retained.

Original receipt SHA256s, by prefix:

- 1: `81a7071a7ece664d1bc5c92e02810c6829082be75b7d0ee9805e97fce82956b6`
- 2: `6b24d0e3665d6d4924e1ab3dc5006f93fff5aa805225e6a90ddda0b12b55687b`
- 3: `7d3b23e63b81a68da0761ad9163aded1cac9c2c97e3c96e2bcdaf2c6805fc4a3`
- 4: `e1168ccded283be0178dc7e5a10a18473b4477c6f2e4e7f67ee28e60f1c2eaee`
- 5: `0d71c4e6aa2c5c6e625a30baaa4e779a332fc12295db0339c1ad84b7daf82875`
- 6: `405a969dd99528daaaf432db95ecf3d13c61aaf16744ae2833a06dddbf8fcdd0`

Independent source review of `c76dd64` found no P0/P1 in the bounded upgrade slice.
Its nonblocking host-inventory hardening suggestion is implemented: expected table
names are now independently enumerated rather than taken from producer fields;
a self-consistent renamed-table negative control fails. The three reader tests
and all six real original receipts pass this checker. Whole-increment review and
intact packaged execution remain separate requirements.

Added a reusable scalar-family full-row projection, finite table/column/function
privilege checks, strict restored-integrity total and shared immutable-guard
invocation. Four focused helper tests passed. Native read-only privilege/inventory
checks passed in the isolated current schema with all three scalar tables empty;
this does not prove populated scalar recovery or native scalar mutation controls.
Final unit regression for these additions passed 1198 tests across 54 files;
lint, diff whitespace and documentation validation passed.

2026-09-13 populated-upgrade checkpoint: the release-six fixture now uses frozen
v6 grants and the prior-schema adapter to create genuine CREATED/REUSED/NO_REQUEST,
assigned/unassigned and revoked-recipient history before migration seven. This
retained-data producer is distinct from the current-release native/race producer;
it explicitly reports that native probes were not executed before upgrade.
Upgrade verification freezes all old columns and complete ledger rows, preserves
v6 milestone ownership, checks new scalar owners are null and only actually new
tables are empty, then verifies original-command replay and original PM proof.
Regrant alone does not reroute the historical assignment; explicit refresh does.

The first isolated restricted-role run failed because its preflight incorrectly
read the migration ledger as pdaa_api. The check was moved to the fixture owner;
no API permissions changed. A new generated TLS cluster then passed the populated
prefix-six to seven rehearsal: 39 original populated business tables retained,
42 current tables, original proof/retry/recipient checks and the existing released
milestone native COMMIT/race controls. Original receipt SHA256:
`29ea4a36514cabf59fd9e42d44031e355fa9f3ad4b924e0fb0503813d17b7145`.
It is retained under run `pdaa-acceptance-1789313832345-27d65e06`. This private
composite-code rehearsal is not intact-image or new scalar-native-matrix acceptance.

Added the sixth packaged upgrade invocation and matching host checks for exact
prior table/row-count inventory and original retained IDs. The first successful
receipt predates the new row-count field; a fresh six-prefix repeat is in progress
with source hashes checked before/after execution. Full unit regression passed
1191 tests, lint and documentation validation passed. Full 42-table scalar data
population/recovery inventories and both packaged profiles remain outstanding;
none of these checkpoints closes a release or story gate.

2026-09-13 next-step checkpoint: independent persistence correction review of
`82fd51e` resolved the previous UTC, year-range and broad-error findings in source,
with no P0/P1 in that bounded review. Report SHA256:
`d22c20fef0c8a46ef7f6dd08f1353454125ecbe6ce4e5f5d42fc9b18dcdbbf4c`.
Its remaining P2 test-lifecycle finding is addressed by finite connection/query
budgets, protected observer acquisition and existing failure-retaining cleanup.
Ten scalar integration and 18 guard-helper tests passed after this change.

Prior-schema adaptation now supports exact prefixes 2-6, omits the absent scalar
owner in top-level and nested milestone scalar projections, preserves released
v5/v6 ownership and retry keys, and rejects attempts to select or adopt forward
ownership. Added a guarded, frozen release-six ACL helper without changing the
release-five helper. The adapter, frozen-ACL and cleanup suites passed 29 tests.
The frozen ACL helper has not yet been executed under actual packaged roles.

Local-principal native compatibility smoke ran on newly created
`pdaa_test_1789312781770` (prefix five) and `pdaa_test_1789312787790` (prefix six).
Both genuinely installed only their prior migration prefix before repository
operations, then applied migration seven. Actual reads/inserts/nested projections,
exact retained scalar row and prior-ledger comparison, and old-command replay
passed. Prefix six also preserved a request-owned milestone NO_REQUEST check.
Databases were retained. This smoke does not populate every old table, exercise
the complete positive/negative assignment history, or establish actual API-role
privileges. Wiring the complete six-prefix producer/consumer upgrade evidence,
42-table recovery inventory and native-role/packaged acceptance remains pending.

Pending for this increment. Prior Stage3/PR52 evidence is historical, not new
execution or approval of this scalar design. No additional story is accepted.

## Completion summary

2026-09-13 populated-recovery implementation checkpoint (FR-EVD-007/009/012,
NFR-SEC-001/REL-001): added actual API-role scalar fixtures covering CREATED,
REUSED, exact retries, explicit opt-out, legacy unassigned requests, original
source withdrawal/restoration and revoked recipients. Added worker denials and
extended local and packaged recovery inventories to all 42 business tables and
seven migrations. Packaged recovery now verifies original-command replay and
original proof delivery after explicit reassignment, with runtime CONNECT still
denied. Independent host readers reject missing scalar evidence and mismatched
original request/check/assessment identities; six focused helper tests passed.

Generated TLS run `pdaa-acceptance-1789317010093-8d260655` passed actual API-role
population, exact privileges, worker denials, native immutable guards, native
dump/restore scalar-row equality, revoked-recipient denial, regrant without
rerouting and explicit refresh delivering the original proof. Restore application
checks ran as fixture_admin while runtime remained quarantined. This focused
composite-runtime run is NOT intact-image or encrypted 42-table packaged recovery
acceptance. The earlier tooling run lacked pg_dump; its original artifacts and
database were retained, and the successful run used existing database-image
clients without adding dependencies or changing runtime permissions.

The first current full integration run applied and repeated all seven migrations:
116/117 tests passed; an existing milestone contributor-change test exceeded its
unchanged 20-second test limit. Its isolated rerun passed in 10.66 seconds. The
failed database `pdaa_test_1789316653473` remains retained; a new complete run is
in progress. No timeout was increased and the earlier failure is not waived.
Native scalar COMMIT/race/load controls and all three packaged restore runs
remain required. No issue, story or release gate is closed by this checkpoint.

2026-09-13 recovery correction checkpoint: independent review of `4a851c7`
identified two P1 acceptance false-positive risks (report SHA256
`ff64eed34f36ce59a1742f77ffc4b491d40ef812658da2a9790cce3cc249e4f4`).
Restore business transactions now SET LOCAL ROLE pdaa_api and assert both effective
role and fixture-admin transport, preserving original transaction budgets; denial
audits have the same restricted wrapper rather than exposed owner delegates.
Original PM proof must be available, complete CONFLICTING, scoped correctly, and
retain both original date values and evidence/version references. Withdrawal must
be restricted/revalidation-required/null. The host reader rejects missing proof,
owner-runtime-role and mismatched original identity evidence.

Fresh run `pdaa-acceptance-1789317573391-aa45a59c` passed the corrected native
scalar restore with all five business transactions asserted as pdaa_api, retained
runtime quarantine and original available proof. Original population SHA256:
`c840e67a03da137992f064cc5866885ba178ee2779e67b337bbcbc3e63f95255`;
restored receipt SHA256:
`352f1abbbe3aa1cc864c08a01890b199c068f13267301f763d086c5d11116e30`.
The final additional policy-scope/null-resolved-value reader assertions also passed
against that retained original. Seven focused helper tests passed.

The fresh complete database run on `pdaa_test_1789317097171` passed 117/117 tests
with unchanged limits. The 42-table local native recovery rehearsal passed into
`pdaa_restore_1789317550973`: exact full rows/ledger, populated scalar families,
native integrity, immutable guards, credential decryption and restored project
scope. A preceding recovery query timed out and remains a retained failed attempt;
the repeat passed without timeout changes. Neither local native recovery nor the
focused scalar dump replaces any of the three encrypted packaged recovery gates.
The proper unit selection passed 1201 tests across 55 files; lint and documentation
validation passed. An earlier invocation omitted the unit-only exclusion and
correctly failed all eight integration-suite environment guards without a database;
it is not represented as an integration run or a successful full command.

2026-09-14 scalar command contention and retained-version boundary: added an
actual pdaa_api recipient-queue transaction holder and two independently observed
API contenders, preserving production transaction options and the existing
three-second lock-observer bound. Four cases exercise identical command retry,
actor-independent business reuse, competing assignment CAS and identical refresh
retry. Full scoped row fingerprints/deltas, retained-row equality, returned
check/proof/request/assignment mappings and per-contender audit attribution are
checked against committed SQL rows. Independent host readers reject missing cases,
absent contention, changed input rows, wrong proof IDs and misattributed audits.

The scalar load control persists 1,000 retained versions on one real scalar fact,
checks a complete positive owned proof under the unchanged 10-second application
deadline and exact SQL/TypeScript identity, then appends version 1,001 and requires
a genuinely owned INCOMPLETE/NO_REQUEST check with zero dependency rows. It pins
actual persisted fact revisions/counts, preserves conflict/assignment history and
the original OPEN request, and replays the original proof. This is 1,000 retained
proof versions, not 1,000 distinct identity contributors or a 64,000-reference test.

Fresh isolated TLS run `pdaa-acceptance-1789356345243-604d2b4b` passed these four
races and the boundary (positive command 4,917.856 ms), then the existing focused
native scalar dump/restore. Original race receipt SHA256:
`4ab8333ffaae82460cce2fb9d55c2ca4a3b6c2e883e4e7fa034827d3ba32d7d1`;
boundary receipt SHA256:
`0b92538b3dcc0b34eaabc06d2983732f9d2c52a64372caaedb111e98cf3439d1`.
Both originals passed the separate host readers. Earlier runs are retained:
Docker initially unavailable, an unsuccessful missing-request latch, and a denied
temporary-object setup. The corrected holder is a successful real queue read;
load setup uses guarded individual append statements without extra TEMP grants.
No production permission, migration, deadline or evaluator changed.

Primary and both customer-profile acceptance producers/readers now require these
scalar command/load receipts. This wiring is not fresh packaged execution evidence:
the runs above mount current code on inspected tooling and remain composite native
tests. Source/grant/policy/role-loss races, changed-key/fact contention, remaining
native scalar COMMIT controls, full identity/conflict-prefix bounds, scalar
HTTP/browser journeys and all three encrypted packaged restores remain required.
No issue, story, merge or customer-release gate closes at this checkpoint.

Independent review of `7f54c1b` found no P0/P1 in this bounded submatrix (report
SHA256 `132820bc9b99e0118ea7b3db8ca4acb725265926248dc0a906ee8cba9c605c1d`).
Its P2 host-reader gap is addressed: emitted operations, command keys/scopes,
stored actor/key links and successful checked/requested/assigned audit IDs and
exact detail now participate in validation. Wrong successful audit event/detail
and wrong same-command key controls were added. The strengthened reader passes
the retained original race receipt without regenerating it. The rollback aggregate
also retains the secondary caught error as its lint-required cause while keeping
both original and rollback failures in the error list.

Full unit validation is not yet green: two runs returned 1202/1203, with the
existing production-config Prisma subprocess reaching its unchanged 15-second
spawn timeout. A separate diagnostic eventually returned the correct configuration
denial after 23.95 seconds; subsequent unchanged startup took 4.48 seconds. The
reason for this startup variability is unproven; no update-check setting or timeout
change was adopted. A one-worker complete repeat is in progress to reduce test
contention. Existing failed runs are not waived. Lint passed after the cause fix;
documentation validation and the focused reader tests passed before the final
additional wrong-detail negative. Required broader validation remains open.

The one-worker full repeat completed successfully: 1,203 tests across 56 files,
171.99 seconds, with every test/subprocess/application timeout unchanged. This
reduces parallel test contention; it does not establish the root cause of the
earlier startup variability or erase either failed two-worker run. No runtime
configuration change was made to obtain this pass.

Not complete. FAIL-009 and Issue6 closure require the implemented, reviewed and
executed generic request workflow; planning and domain flags do not satisfy them.

2026-09-14 authorization-race native evidence: generated TLS run
`pdaa-acceptance-1789359353312-2905f236` passed source-first, read-first,
PM creator/recipient grant-first and policy-first contention, plus current-role
denial with unchanged grants. Actual pdaa_api connections and exact blocking paths
were observed. Fresh source-restricted proofs retain their two versions/one conflict
and are sealed REVALIDATION_REQUIRED/NO_REQUEST; their public delivery is restricted
with null result. Policy opt-out produces an available owned NO_REQUEST while
original proof/retry remains unchanged. Grant loss denies fresh/retry and PM detail;
role-loss denial does not mutate the grant or the earlier authenticated identity.

Original access receipt SHA256:
`7bcc91ea6c6eb8a14cce458001494ae6670d464f15dea17082bb70408468101c`.
The strengthened reader passes that unchanged original and rejects twelve separate
mutations covering source/policy audit detail, SQL audit mismatch, fresh dependency
owner/access revision/conflict, absent blocking, unchanged source/grant, incorrect
role and a read-first fixture that always withholds. Four focused reader unit tests
passed; focused lint, documentation and whitespace checks passed. Full unit repeat
and immutable candidate review are pending at this checkpoint.

The enclosing run also passed the existing command races, 1000/1001 boundary and
focused native dump/restore, stopping its generated database and retaining all
volumes/originals. This is composite current-code native evidence, not intact-image
or encrypted packaged acceptance. Primary and both customer-profile producers and
host readers now require the new access receipt, but those full packaged workflows
have not been rerun. No runtime, SQL migration, API permission, connector scope,
dependency or transaction deadline changed. Rollback is reverting these acceptance
scripts; do not delete retained history. Native COMMIT corruption controls,
changed-fact/key/contributor races, further identity bounds and full packaged/browser
acceptance remain open; no story or release gate closes here.

The complete one-worker unit repeat passed 1,205 tests across 57 files in
87.66 seconds. Full lint, architecture boundaries, documentation validation and
whitespace checks passed. Application/test transaction deadlines remain unchanged.
These are current acceptance-script checks, not a new application build, HTTP/IdP
run or full packaged acceptance result. Immutable source/original review is pending.
