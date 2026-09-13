# EXEC-008: Durable scalar-conflict reconciliation

Status: Draft; concrete design review required before implementation.
Owner: Implementation controller.
Requirement IDs: FR-EVD-001/002/003/004/006/007/009/010/012, FR-ADM-005,
FR-MOD-004, NFR-SEC-001/002/005/009, NFR-REL-001/002/005, NFR-MNT-002/004/005.
GitHub issue: #6; STORY-012, AC-EVD-004, FAIL-009 and INT-EVD-004.
Target release: R1. Last updated: 2026-09-13.
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

2026-09-13: verified clean main and successful postmerge repeat; created
`codex/scalar-reconciliation-requests`. Read scalar source/authorization/persistence,
approved requirements/ADRs and private feasibility/routing inputs. This proposal is
not design approval or implementation evidence. Independent review is next.

## Decisions made

One fact-level request over the full conflict participant union; explicit policy
opt-in and manager action; separate scalar family rather than weakening milestone
predicates; immutable routing snapshot permits honest legacy unassigned history.
Existing configured PM routing suffices without a new responsibility editor.
These proposed routine choices become effective only after design review findings
are resolved under delegated controller authority.

## Risks and mitigations

Serialization mismatch -> UUID/type-only identity and native byte vectors. History
adoption -> immutable ownership from birth and reciprocal COMMIT checks. Recipient
substitution/leak -> exact current role/grant/configuration/source checks. Historical
routing drift -> pinned configuration snapshot, separate current INSERT/delivery
guards. Scope inflation -> unchanged authority/milestone/read semantics and no new
external action. Cost/timeout -> bounded prefixes/identity/queues and real-role races.

## Validation evidence

Pending for this increment. Prior Stage3/PR52 evidence is historical, not new
execution or approval of this scalar design. No additional story is accepted.

## Completion summary

Not complete. FAIL-009 and Issue6 closure require the implemented, reviewed and
executed generic request workflow; planning and domain flags do not satisfy them.
