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

2026-09-14 larger acceptance milestone in progress (FR-EVD-004/007/009/012,
NFR-REL-001/002): batch the remaining fresh-proof/request seal probes with real
changed-fact retry-key contention and a public contributor-append race. Require
native immediate seal failures, a coherent positive seal control, exact rollback
across all eleven history families, complete independent receipt readers and
negative controls. The changed-fact loser must leave no partial graph; the
contributor winner must create a distinct business request while historical
delivery and original-key replay retain the original proof. Validate this combined
candidate in one isolated actual-role database run, then full local checks and
separate immutable-candidate review. Do not alter runtime transaction limits,
authorization, evaluator/SQL eligibility, migrations or customer release gates.
Historical load-time variability and full packaged/browser/encrypted-restore
acceptance remain open; this paragraph records intended work, not a pass.

The combined milestone now implements six seal cases (one genuine committed
positive, five immediate rollback-only corruptions), a fifth command race for one
actor/key contending on two real facts, and a sixth access/input race using the
public contributor append. Independent readers bind canonical command hashes,
internal proof keys, native seal statements and parameters, exact frozen inputs,
assignment/audit clocks and all eleven history families. Contributor evidence also
binds the public append receipt; historical delivery/replay retain the old proof.
Both packaged profile producers and the shared host reader require this inventory.
This adds acceptance coverage, not new product semantics or a released feature.

First combined native run `pdaa-acceptance-1789372390415-32a5353d` passed six seal,
six access/input and five command cases alongside COMMIT22/boundary30. It FAILED
the later unchanged 1000-version load gate: returned command 12041.27ms, process
user/system CPU 2517.55/220.04ms, event-loop active/idle 2076.73/9964.73ms.
No restore ran. Originals and stopped database/volume remain retained. This run
predates the final command observation and independent-reader review bindings;
it is not substituted for final-candidate evidence. A fresh isolated run with
private, content-free query-category timing is pending. No timeout cause is proven.

Whole-workspace typecheck/build passed. Nine focused tests, lint and architecture
checks passed; documentation passed with the existing pinned-PyYAML `.venv` after
the unconfigured system Python failed its prerequisite. The default full unit run
had 1226 passes/two failures (startup disclosure and production configuration
subprocesses returned no expected output); a single-worker run had 1227 passes/
one startup-disclosure failure. Direct content-free startup diagnosis returned the
expected fixed API/worker failure events in 7182.40/1574.82ms. The unchanged seven
focused startup/configuration tests then passed in isolation. These are retained
failures, not waived deadlines or a full-suite pass. Final validation and separate
immutable-candidate review remain pending.

Final combined native evidence: `pdaa-acceptance-1789373187089-7a6ff71a` passed
seal6, access/input6, command5, COMMIT22, boundary30, the unchanged 1000/1001
boundary and focused native dump/restore with runtime quarantine. Original hashes:
seal `d51ccae58ded96b974b28b9abc9e0a7fdae2530a31da77eb901ccd331ac917dd`;
access `1e76524677c7fe5d7cc83fce606960fc0d0803c75809e0bd90b73b563d8c3196`;
command `ff99c0761e430c230abdb604897bd47146028abe6ba9931eb6f10fe0db1e61fe`.
One seal control genuinely committed; the five negative controls produced exactly
two request-seal and three proof-seal P0001 failures, zero COMMIT attempts and full
rollback. Changed-fact contention produced one CREATED and one IDEMPOTENCY_CONFLICT;
contributor contention retained the original proof and created a distinct request.

This run used optional private content-free query profiling, not an uninstrumented
timing claim. The 1000-version command measured 6018.27ms; COMMIT 3466.44ms, proof
seal 492.88ms, delivery validation 348.05ms, request seal 339.90ms and request INSERT
327.35ms. Profile hash:
`1a2383a7fdb0094aa81b01297de60c2f67301e2e5df8c613c3b0338e8a361f63`.
The passing repeat neither diagnoses nor erases the 12041.27ms failure or earlier
intermittent failures. Both generated databases are stopped, with all originals,
volumes and networks retained; default local `pdaa` remains untouched.

Cross-host replay found and fixed an acceptance-reader timezone defect: offsetless
AuditEvent timestamps must be interpreted as UTC, not the Windows host's timezone.
The reader-only correction covers equality and ordering; a native-shaped regression
accepts UTC-equivalent timestamps and rejects a changed clock. No original receipt
was modified. The corrected host reader accepts all six unchanged original families
and rejects 46 corrupted copies; control-report hash:
`935d830fdd1e59780057a37cd1e449d09932d4e60040423de16b43fa282f9cdb`.

Final full unit repeat passed 1229 tests across 61 files in 165.58 seconds with one
worker and unchanged individual test deadlines; ten focused tests also passed.
The earlier full-suite startup/configuration failures remain recorded above, with
no root-cause or performance-fix claim. Whole-workspace typecheck/build, full lint,
architecture and documentation validation passed before the final reader-only
correction; full lint/architecture/docs/whitespace also passed after that correction.
Exact source/reader candidate `51754b3cb896b1159c4288840a4f1a394ed8e1bf` received
independent non-author approval for this bounded batch with no material findings;
the report was fully read and its SHA256 verified:
`3929cbc06c4c109cdef98c789a96c961c825a83b9923e3aa5fa266e4ee24d5b2`.
The initial `a041d5a` review disposition was explicitly superseded by the host
timezone finding, not treated as final approval. No runtime/schema/migration,
permission, connector scope, dependency or deadline changes were made. Rollback is
reverting this acceptance-only batch while preserving all original evidence.
Remaining identity/conflict-prefix vectors and full HTTP/browser/natural-OIDC,
both-profile intact builds and three encrypted 42-table packaged restores remain
open. Issue6/STORY-012/FAIL-009 and customer release gates are not closed.

2026-09-14 ownership and immediate SQL-boundary block (FR-EVD-009/012,
NFR-SEC-001/REL-001): use independently committed opt-out SCALAR proofs with matching
canonical check hash/subject/time to isolate missing ownership, plus a real other
project/fact tuple for cross-scope proof rejection. Distinguish two actual native
COMMIT controls from 28 immediate guards/privilege checks. Direct API-role SQL uses
explicit rollback-only transactions with bounded statements/lock waits; it is not
a changed repository transaction budget or HTTP authorization test. Every outcome
must retain all eleven row families across the three fixture projects and prove
customer-wide absence of generated IDs. Unexpected successful DDL/DML is rolled back
before rejection, never committed. Preserve native error phase/constraint and both
primary/rollback failures. Source/schema/permission changes remain out of scope.
Execution and independent review evidence follow below.

2026-09-14 scalar native COMMIT acceptance block (FR-EVD-009/012,
NFR-REL-001/002): implement four native positive controls (CREATED, REUSED,
NO_REQUEST, REFRESH) and fifteen deferred negatives. Use fresh owned proofs,
actual pdaa_api sessions, unchanged ReadCommitted/maxWait5000/timeout10000,
the existing native transport observer and a separate settled-COMMIT connection.
Record full before/pending/after eleven-table projections, actual generated IDs
including authority-owned proof/conflict UUIDs, exact case-specific PostgreSQL
errors and customer-wide generated-row absence. Audit-scope negatives separately
pin the attempted out-of-project audit and its rollback. No forced constraints,
trigger bypass, privilege expansion, early insert failure or timeout counts as a
native COMMIT result. Pending immutable review and final execution results below.

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

2026-09-14 native COMMIT checkpoint: 19 actual pdaa_api cases passed in generated
TLS run `pdaa-acceptance-1789363669138-a136c3c7`: four positives and fifteen deferred
negatives. Every callback returned before exactly one native COMMIT, a separate
connection observed the settled writer, and negative errors matched the finite
case-specific guard/FK inventory. Full pending rows identify the attempted proof,
check, assignment and audits; all eleven before/after table families and generated
ID absence prove rollback, including the intentionally wrong-project audit.
Original COMMIT receipt SHA256:
`413910a5b2d56e8332e7af865b3f0daf42821bc9a1a4b20e602f0ed020b06751`.
The closed host reader passes this unchanged original and rejects fourteen
independent mutated receipts (native phase/error/observer, rollback, audit,
assignment, outcome and inventory failures). Seven focused reader unit tests pass.

The first enclosing attempt, `pdaa-acceptance-1789363349084-dd3ef4e9`, passed the
COMMIT cases but failed the previous source-access reader: changing revision can
change the full-JSON SQL sort order. Its original failure and volume remain retained.
The reader now compares those exact rows by stable source ID; a regression proves
both row permutations pass while missing/unchanged/incorrect rows fail. The fresh
enclosing run above passed access/command races, the 1000/1001 boundary and focused
native dump/restore without transaction or test-timeout changes. Both generated
databases were stopped; no default database, volumes or original artifacts deleted.

Primary and both customer-profile producers/host readers now require this native
receipt. This is wiring plus composite current-code execution, not an intact-image,
encrypted packaged restore or fresh browser/HTTP acceptance run. No runtime code,
schema, migration, role permission, connector scope or dependency changed. Reverting
the acceptance scripts is the implementation rollback; retained data stays intact.
Borrowed/cross-scope proof and wrong-REUSED-identity controls, remaining immediate
shape/privilege/seal controls, changed-key/contributor races and full packaged
acceptance remain open. Full unit/lint/docs and exact-candidate review are pending
at this checkpoint. No story, issue, merge or customer-release gate closes here.

The complete one-worker repeat passed 1,210 unit tests across 58 files in
91.40 seconds. Full lint, architecture boundaries, documentation validation and
whitespace checks passed. No application build, fresh HTTP/browser run or intact
packaged acceptance is claimed for this acceptance-only delta. Independent immutable
source/original review remains in progress.

2026-09-14 boundary execution checkpoint: generated TLS run
`pdaa-acceptance-1789365041975-ea408a78` passed 30 actual pdaa_api cases: two
deferred standalone/cross-project proof rejections, fifteen immediate guard/FK/shape
cases and thirteen exact 42501 privilege denials. Each case preserves all eleven
row families across the three projects and records customer-wide generated-ID
absence. Deferred outcomes include the independently observed native COMMIT;
immediate failures are explicitly not represented as COMMIT evidence. Assignment
controls retain otherwise valid current routing and predecessor history.
Original boundary receipt SHA256:
`a665d8118db3238cb1662728e0e3abeae0db90a16006c364682dc453b6f9c8e6`.
The reader accepts the unchanged original and rejects sixteen individual corrupted
receipts covering phase, native observation, exact error, wrong SQL/target, borrowed
scope/subject, assignment/audit fields, retained history and generated-row evidence.
Eight focused boundary/cleanup unit tests passed; focused lint passed.

An earlier run `pdaa-acceptance-1789364728676-81b2333a` passed the same boundary
cases before explicit generated-ID evidence and failure-preserving rollback cleanup
were added. Its enclosing run subsequently failed the existing 1000-version
wall-clock assertion at the unchanged 10-second budget, after all boundary, COMMIT,
access and command cases passed. The reason for this variability is unproven;
no timeout or runtime setting was changed. Both runs' artifacts remain retained.
The cleanup helper now preserves
both the original SQL error and a failed ROLLBACK; unit controls cover primary plus
cleanup failure, cleanup failure alone and successful rollback. No original failure
is suppressed or converted to successful evidence. Full suite, enclosing restore
completion and immutable review are pending at this checkpoint.

Primary and both customer-profile producers/host readers require the boundary
receipt. These are direct SQL/fixture tests on composite current code, not a fresh
intact-image, encrypted packaged restore or HTTP/browser authorization run. Ordinary
API roles, runtime code, migration bytes, triggers and connector scopes are unchanged.
Reverting acceptance scripts is the implementation rollback; retain all fixture data.
Wrong REUSED identity with changed-input rollback, negative-proof positive labeling,
coherently altered identity/seal and missing-dependency controls, changed-key and
contributor races, expanded identity bounds and full packaged/browser acceptance
remain outstanding. No story, issue, merge or customer-release gate closes here.

The final enclosing run `pdaa-acceptance-1789365041975-ea408a78` completed
successfully, including the unchanged 1000/1001 boundary and focused native
dump/restore. It is a distinct successful repeat, not a waiver or relabeling of the
earlier load-budget failure. Both generated databases were stopped with volumes
and all original evidence retained. Full unit and independent review remain pending.

Final boundary validation: the complete one-worker suite passed 1,214 unit tests
across 59 files in 215.57 seconds. Full lint, architecture boundaries, documentation
validation and whitespace checks passed. Independent bounded source/original review
approved `577516e385becff2d3fa10bafcffefdba8abcd6b` with no unresolved material
findings; this is not whole-feature or merge approval. A subsequent reader-only
safeguard rejects native-command metadata on immediate statement failures. Its four
focused tests passed, the unchanged original receipt still passed, and all sixteen
corrupted-receipt controls were rejected. No database rerun or full-suite rerun is
claimed for that final reader-only delta; its exact-candidate review is pending.

2026-09-14 identity-reuse continuation (FR-EVD-004/007/009/012,
NFR-REL-001/002): expand the native COMMIT matrix from 19 to 22 cases. A direct
guarded version/evidence append under the authorized Project/grants/fact lock order
prepares a fresh eligible proof with different contributor identity. Attaching it
as REUSED to the old valid request must fail only at actual native COMMIT, rolling
back the fact revision, appended input, derived conflict, proof, check and audit.
The complementary coherent CREATED graph commits a distinct request while retaining
the original request, proof and assignment. A subsequently committed actual
RETAIN_CONFLICT policy yields a valid ineligible same-fact proof; attaching it as
REUSED to the older positive request must likewise fail at native COMMIT.

The reader reconstructs exact identity bytes from original SQL version/source/
evidence rows and all retained output participants, distinguishes eligibility from
proof validity, binds exact append/conflict scope and time, and requires the old
request's historical predicate to remain true after full graph assembly. Closed
eleven-family projections and an exact generated-ID inventory prove rollback.
These direct transaction-scoped persistence controls do not claim execution of a
public append command, its receipt, or the separate changed-contributor race.
No runtime, schema, migration, role, connector scope or deadline changed. Rollback
is reverting acceptance changes, with databases and original evidence retained.
Focused seven reader tests and lint passed; final native evidence, wider checks and
exact-candidate review remain pending at this implementation checkpoint.

Native identity evidence: `pdaa-acceptance-1789367975472-5b93d1c4` passed all
22 native COMMIT cases and the unchanged boundary/access/command matrices. Its
original COMMIT receipt SHA256 is
`d2d5ba810bb928e340a057bb5df93006344047372a18d85c0ba6b8ec704f1e42`.
The final reader accepts this unchanged original, including post-assembly historical
request validity and complete version/conflict dependency prefixes. The enclosing
run FAILED later at the existing 1000-version wall-clock assertion (10-second
budget); restore did not execute for this run. Cause is unproven, no deadline was
increased, and this remains an open full-acceptance performance risk.

The earlier `pdaa-acceptance-1789367619540-d538635a` passed the 22 cases and enclosing
load/restore before the added post-assembly validity observation and final reader
bindings. It is not substitute evidence for those additions. The intervening
`pdaa-acceptance-1789367790836-2f1f6acf` failed before database execution because
Docker's automatic subnet pool was exhausted. The final isolated run used an
explicit, locally inspected non-overlapping `10.250.254.0/24` network through a
private runner override. No shipped composition, existing network, default database
or retained volume was modified/deleted. Generated databases are stopped and all
originals retained. This remains composite current-code native evidence, not an
intact-image, encrypted packaged restore or browser/HTTP acceptance claim.

Identity continuation validation completed: 1,216 unit tests across 59 files passed
in 237.18 seconds; full lint, architecture, documentation and whitespace checks
passed. The unchanged original receipt passed the final reader and 26 independently
corrupted copies were rejected. Independent source/original review approved bounded
candidate `437693cafca79432fdbb90a00fc8810f377bad60` with no unresolved material
findings. No runtime build, fresh HTTP/browser or final-run restore is claimed.
The recurring load-budget failure remains open; this checkpoint does not close
STORY-012, FAIL-009, Issue #6, full acceptance, merge or customer-release gates.

2026-09-14 load-failure investigation (NFR-REL-001, NFR-OBS-001): source review
identifies approximately nine full proof validations on CREATED, including repeated
same-proof validation through deferred request/check/owner guards. The effective
released validator already caches JSON arrays and has the source-temporal index;
neither is a missing optimization. No proof predicate, released migration, SQL
statement, runtime configuration or deadline is changed by this investigation.

Private diagnostic run `pdaa-acceptance-1789369691297-0f8011cd` passed the enclosing
native/load/restore workflow. Query-duration observation preserved transport bytes
and results and recorded statement categories only, not SQL/parameters/content.
The 1000-version command took 3580.49ms: COMMIT 1225.51ms, request seal 458.51ms,
proof seal 394.49ms, request INSERT 340.49ms and delivery proof validation 246.14ms.
This locates costs in a successful instrumented run; it does NOT explain the prior
failures or waive them. Speculative validator simplification/caching is not applied.

Acceptance now retains a unique create-only `scalar-load-<factId>.json` diagnostic
before raising the unchanged deadline assertion, including when the repository
command rejects. A closed record contains wall elapsed time, process user/system
CPU and event-loop active/idle deltas, returned/rejected state and the fixed
10000ms limit. These are process-wide interval measurements, not database CPU,
native COMMIT/rollback proof or a diagnosis of contention. No SQL, parameters,
returned proof, raw error text or credentials enter this record. Publication is
outside the measured command interval; a diagnostic failure retains any command
or deadline failure rather than replacing it. Existing artifacts are never
overwritten. Successful host receipts require the same exact measurement and a
returned command below the unchanged deadline. Both shipped profile consumers
inherit this requirement; full packaged execution is not claimed by wiring.

This acceptance-only diagnostic change leaves the performance investigation and
remaining sealing/race/packaged gates open. Rollback is reverting these acceptance
changes; preserve every generated database, volume and original diagnostic.

Diagnostic verification: `pdaa-acceptance-1789370117405-98b702bd`, with private
query profiling disabled, passed native COMMIT22, boundary30, access/command races,
the unchanged 1000/1001 limit and focused native dump/restore. The 1000-version
command measured 7515.94ms, process user/system CPU 2650.12/196.85ms and event-loop
active/idle 1989.51/5526.78ms. The original retained diagnostic and successful
receipt contain exactly the same measurement. Receipt SHA256:
`2c1caac3a5d35789f5833b701d66be245a479c2148a97aec1b7013596ea8d9be`;
diagnostic SHA256:
`acb698fe84919e7eee5f84dbc6b932da53b1e1d32ed87a84ced76e3bb9b27ad1`.
The reader accepts both unchanged originals and rejects nine corrupted receipt
copies. Real command rejection/deadline/publication-failure behavior is covered by
deterministic unit controls, not claimed as newly observed native timeout evidence.
The private passing profile hash is
`6ff729704751461bad753f54d15e61833fc914d7c826edc2e1f4edb6e823173f`.
Both generated databases were stopped with originals/volumes retained; fresh
non-overlapping subnets 10.250.253.0/24 and 10.250.252.0/24 were used without pruning
or changing existing networks. These runs remain composite current-code evidence,
not intact-image/encrypted packaged/browser acceptance. Prior failing runs remain
valid failures and their root cause remains unproven. Full unit validation and
exact-candidate review are pending at this checkpoint.

Load-diagnostic validation completed: 1,223 unit tests across 60 files passed in
189.37 seconds; full lint, architecture, documentation and whitespace checks passed.
Independent source/original review approved bounded candidate
`c5390003941fc4f0d8b770804d2326d824ba57df` with no material findings. The historical
timeout cause remains unresolved; no performance fix or whole-feature completion
is claimed. Remaining sealing/concurrency, full packaged and browser gates stay open.

### Combined identity and conflict-prefix acceptance milestone

FR-EVD-007/009/012, FR-ADM-005 and NFR-REL-001: extend actual API-role
acceptance with date, number, boolean and arbitrary-text SQL/TypeScript identity
vectors, actor-independent reuse, recorded-group equivalence, irrelevant future
policy publication and a changed selected policy. Add the 1002-conflict control
whose maximum revision lies outside the UUID-ordered 1001-row sample. Require an
owned INCOMPLETE negative check with the true prefix and preserved original OPEN
request, proof and retry. Wire independent receipt readers and corrupted-copy
controls into both profiles, then execute in a fresh isolated synthetic cluster.
Keep runtime limits, authorization, migrations and production behavior unchanged.
Do not infer native stale-participant or impossible 64-evidence-per-version
coverage from domain tests. Historical load variability, intact-image/encrypted
packaged acceptance and remaining browser gates stay open. Rollback is reverting
these acceptance-only changes; retain all original diagnostics and fixture volumes.

Native evidence for this milestone: isolated composite run
`pdaa-acceptance-1789375343450-a7c8edc3` passed all sixteen typed identity commands,
including actor-independent recorded reuse, future-policy reuse and new selected
policy identity, and the five-command 1002-conflict prefix/original-proof control.
The independent readers accepted the unchanged originals and rejected 25 identity
and 17 prefix corrupted copies. Original identity receipt SHA256:
`5e2e836cc997baed1334dda694df92630016a42382a6bafc05352bf43e524c95`;
prefix receipt SHA256:
`1d16a64f9367fdc9e868774f23d556b98dfd375b7a638498b4f1ad6a338421d5`.
Both receipt families are mandatory in operations and customer profile readers.
The native text receipt includes a real newline, Unicode, quotes and backslash;
number vectors retain both `1e-100` and `1e100`. Source-access dependency revisions
are checked against actual saved access rows, not an assumed revision of one.

The same run passed the existing boundary30, COMMIT22, seal6, access/input6 and
command-race5 controls, then FAILED the existing 1000-version command: rejected
after 11359.91ms against the unchanged 10000ms deadline. No restore ran after that
failure; no performance fix, full matrix pass or release acceptance is claimed.
The earlier run `pdaa-acceptance-1789374952848-c0e47979` failed the reader's incorrect
source-access revision assumption; that assumption was corrected without runtime
changes. Both generated databases were stopped and all volumes/originals retained.
Current-code scripts/runtime mounts remain composite evidence, not intact-image or
encrypted packaged acceptance. Full unit validation and immutable-candidate review
are being completed; stale-recorded-participant native vectors and the historical
load reliability issue remain open along with packaged/browser gates.

Local validation: all 1241 unit tests across 63 files passed in 132.61 seconds
with two workers. Full type checking, build, lint, architecture, documentation and
whitespace checks passed. The initial `pnpm test --maxWorkers=2` invocation was
rejected by pnpm before test execution; the successful full run used Vitest's
actual unit command with the integration exclusion and `--maxWorkers=2`.
The eleven focused tests passed before the final offsetless-UTC control; the full
suite includes that additional control. No runtime dependency, connector scope,
authorization rule, transaction limit or migration changed in this milestone.
