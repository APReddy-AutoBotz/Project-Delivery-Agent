# EXEC-007: Canonical milestone reconciliation

Status: Stage 1 merged; Stage 2 design approved and implementation in progress.
Owner: Implementation controller. Last updated: 2026-09-12.
Requirement IDs: FR-EVD-001/002/003/004/006/007/009/010/012, FR-ADM-005,
FR-MOD-001/002/004, FR-HLT-008/009, NFR-SEC-001/004/005, NFR-REL-001/002.
GitHub issue: #6; target R1, STORY-012, AC-EVD-004 / GOLDEN-003.
Applicable decisions: ADR-001/002/003/006/007/008/009/010/012/013/014.

## Objective

Detect a milestone reported Complete while explicitly linked mandatory work is
Open, retain both evidence-backed positions, and create one durable internal
request delivered to the currently authorized assigned PM. Never choose a settled
winner or change a source record. A scalar conflict or a domain result alone does
not implement the required request and does not complete the criterion/story.

## Current state

PR47/48 merged the reviewed evidence workflow and its acceptance records. PR49
merged Stage 1 as `bfac958b0af9805c6b3109f7aedf109ccdec3618`; its candidate and
post-merge Foundation/Documentation checks passed. Main has accepted STORY-010/011;
R0 is 3/5 and R1 is 2/33. RequiredWorkItem already links canonical milestones
to mandatory work.
Canonical states and source mappings are configuration, not evidence. ProjectFact
currently has only project plus literal fact-type identity; no child binding.
The existing source-authority evaluator is deterministic and bounded. Its scalar
conflict/assessment foreign keys cannot store cross-fact contributors.

The earlier main repeat Foundation 34641338774 remains failed evidence: its
original response contents were unavailable and are not reclassified. PR49 repaired
the recorder ordering. Candidate Foundation 34663772792 and Documentation
34663772811 passed; the main repeats 34665245478 and 34665245473 also passed.

## Scope and implementation stages

1. Repair the demonstrated capture-close ordering and add a deterministic delayed
   response regression, preserving all fail-closed and post-close checks. Implement
   a pure, internal milestone consistency evaluator and its adversarial tests.
   This is the current commit/PR boundary: no database, API, browser product surface,
   authority policy default, PM request or complete criterion is introduced.
2. Add explicit state-evidence bindings, coherent database capture and cross-fact
   proof, with an additive reviewed migration and real database tests. Specify the
   concrete schema and SQL integrity/privilege contract in this plan before edits.
3. Add atomic durable request deduplication, explicit pending/unassigned handling,
   scoped REST/OpenAPI and PM UI. Review exact schema and authorization commands
   before implementation; include both shipped customer-profile workflows.
4. Accept AC-EVD-004 / STORY-012 only after the complete scenario, immutable reviews,
   required CI, original evidence and verified merge. Shared health/Q&A/engagement
   criteria remain separate. Catalogue tests remain planned until fully covered.

## Current-stage design

The internal evaluator consumes a trusted snapshot with customer/project/milestone,
one explicit as-of time, an explicitly enabled fixed rule revision, a complete
mandatory-work ID list and one target slot per required work item plus milestone.
Each slot is either missing a binding, or includes an explicit immutable binding
identity (customer/project/target kind/target ID/field=state/fact ID/fact type) and
the existing raw source-authority snapshot. These are trusted repository inputs,
not user-supplied API assertions or authorization decisions. Canonical configured
state is never an input substitute. There is no inference from a literal fact key.

Validate exact scope, common as-of, unique target/binding/fact identities and exact
required-set coverage. Bound the whole request before deep snapshot parsing:
one milestone plus at most 50 distinct work items, at most 1000 aggregate versions,
1000 recorded scalar conflicts and 64000 evidence dependencies. Individual scalar
bounds remain unchanged. Over-limit or declared incomplete input returns a small
INCOMPLETE result with no partial values, contributors or request key; malformed
scope/identity/structure fails with a fixed error and no parser diagnostics.

Before invoking any scalar resolver, also enforce a shared conservative 64000
derived-reference budget: reserve twice the sum of (1 + evidence-reference count)
for every version (the two possible generated scalar conflict groups), then add
(1 + referenced-version evidence count) for every recorded conflict/version edge,
including inactive conflicts. This bounds conflict version/evidence expansion
across all targets, including repeated dependencies, before any scalar result is
allocated. Conservative overflow is INCOMPLETE. Ordinary version/support/dependency
arrays remain bounded by the global input limits; no independently maximal scalar
proofs may be accumulated. Bounded outer identity/shape validation precedes the
budget shortcut; oversized nested content is not deeply parsed or returned.

Reuse resolveSourceAuthority for every bound fact. Bound state versions must be
text values in OPEN, IN_PROGRESS, COMPLETE or CANCELLED. Preserve original evidence,
provenance, source and timestamps; do not accept precomputed eligibility or winner
booleans. Unknown binding/policy, noncurrent/ambiguous/internally conflicting facts,
or CANCELLED state produce UNKNOWN, never a completion claim. Any restricted or
invalid source dependency produces a whole-result REVALIDATION_REQUIRED envelope
without copied values. Declared incomplete scalar history produces INCOMPLETE.
Both withholding envelopes allow only customer/project/milestone scope, as-of,
rule revision and status: no contributor IDs/counts/key, scalar assessments or
derived finding fields. Restriction takes precedence over UNKNOWN for otherwise
valid bounded input. An unrelated unresolved target prevents a positive pair from
becoming a whole-set finding. IN_PROGRESS is explicitly incomplete mandatory work;
CANCELLED remains unknown because required-link waiver semantics are not approved.

Only a complete, currently readable set of individually RESOLVED current facts can
produce a new cross-fact conclusion. Fixed rule milestone-required-state/v1 means
COMPLETE milestone versus at least one OPEN or IN_PROGRESS mandatory item. A zero
mandatory set is UNKNOWN, not vacuous proof of completion. The negative outcome
is NOT_DETECTED for this rule at this as-of; it neither verifies overall milestone
completion nor closes any old unresolved case. Disabling the rule is explicit and
returns DISABLED. No cross-fact authority precedence or LLM winner is introduced.

A contradiction retains the milestone and every open mandatory item's complete
supportingVersionIds and supportingEvidenceIds, including all agreeing sources,
binding/target IDs and original scalar assessments. Never choose one representative
version. Every supporting version and its evidence participates in dedupe tuples.
The cross-fact result is CONFLICTING independently of each input's original scalar
dimensions. Include the complete evaluated dependency set, not only contributors.
Sort outputs by stable identifiers; freeze detached results without mutating input.
Return a canonical contributor identity string for later business deduplication:
customer/project/milestone/rule revision plus sorted binding/fact/version/evidence
tuples. The future repository will hash and compare these exact tuples. Exclude
actor, idempotency key, capture time, policy-publication revision, access revision
and assignee from that identity. Unchanged unresolved evidence is one case; changed
contributors are a new retained case. No request creation or automatic closure is
performed by this function.

## Stage 2 persistence design candidate

This section is the concrete design review input. No migration may be written until
a fresh non-author review approves it or all findings are resolved and the updated
text is reviewed again. Migration 5 is additive; the exact bytes and checksums of
the four released migrations remain unchanged.

### Binding identity and Prisma shape

Add nullable `bindingBirthId uuid` to `ProjectFact`. It is immutable from row birth,
unique when non-null, and has a deferred same-scope foreign key to
`CanonicalStateBinding(customerId, projectId, id)`. Existing facts remain null and
cannot be converted. A new binding command first inserts a new `ProjectFact` with
`bindingBirthId` equal to the planned binding ID, then inserts the binding and its
first version before COMMIT. This mutual relation is the durable birth proof; a
revision-zero fact, matching prefix, timestamp or application `create` call is not.

Add `CanonicalStateBinding` with `id`, customer/project, `targetKind`, nullable
typed `milestoneId`/`workItemId`, literal `field='state'`, `factId`, `factType`,
`createdBy`, one database `createdAt`, and `sealed`. It has same-scope FKs to
`CanonicalProject`, `Milestone`, `WorkItem`, and the typed `ProjectFact` key. Its
shape check requires exactly one typed target matching `targetKind`. Composite
unique keys cover `(customerId,projectId,id)`, `(customerId,projectId,factId)`,
the typed fact tuple, and each target+field tuple; therefore one fact and one state
binding serve exactly one canonical target. The `ProjectFact.bindingBirthId` value
must equal the binding ID and the fact's type/scope must match.

Add `CanonicalStateBindingReceipt` with `id`, customer/project, subject,
idempotency key, SHA-256 request hash, binding/fact/source/evidence/version IDs,
`initialSourceAccessRevision=2`, `initialSourceAccessState='AVAILABLE'`,
`initialReaderSubject`, and `auditEventId`. Its request key is unique independently of `FactAppendReceipt`;
each referenced identity is also unique to one binding receipt. Composite FKs bind
the exact binding, first revision/evidence/source tuple and same-customer
`AuditEvent`. Add named immutable composite unique keys on `ProjectFactVersion`
for `(customerId,projectId,factId,id,sourceId,evidenceId)`, on the binding for its
typed target/fact tuples, and on `AuditEvent` for `(customerId,id)`. The validation
function requires fact-version revision 1, HUMAN_CONFIRMED provenance, creator-owned
source, matching immutable birth snapshot/receipt and a `fact.binding.created`
audit by the same actor. The receipt INSERT guard verifies access revision 2,
AVAILABLE state and the sole creator reader at command time: the access row starts
at 1 and the existing reader-insert trigger advances it to 2. Restore validation
checks that the durable snapshot is exactly that birth state and that current access
revision is at least 2; it deliberately does not require current availability or
creator readership. Later access/reader changes therefore remain valid through
their existing revision guards without rewriting the historical birth snapshot.

The server naming convention is `canonical.state.` plus a lowercase UUID without
hyphens. The prefix is admission control, not proof. After migration, generic fact
creation under it is rejected unless a non-null birth ID is supplied, and new
authority aggregates under it require an already sealed valid binding. Pre-existing
facts or policies with that prefix are grandfathered but are never bindings. The
repository tries at most eight generated candidates, checking both ProjectFact and
AuthorityPolicy under the project lock; any occupied fact-only, policy-only or
paired key is skipped. Exhaustion returns the fixed persistence failure. Binding
creation never adopts a fact and never creates, copies or enables authority policy.

Replace the existing ProjectFact admission/revision trigger function so every
INSERT/UPDATE/DELETE first locks the same-scope Project `FOR UPDATE`, before any
fact or binding lookup. It enforces birth-ID immutability, reserved-prefix shape and
fact/policy collision checks. Replace the version append guard so it also locks
Project first and then its fact. Binding, receipt, authority-prefix and cross-proof
header/child guards follow the same Project-first order before their lower-level
locks. Thus direct `pdaa_api` DML cannot race or invert the repository's eight-key
collision loop for supported creation workflows. A Project-first FactSource INSERT
guard prevents its fact FK lock from preceding Project. A BEFORE STATEMENT trigger
rejects standalone ProjectFact UPDATE before tuple acquisition (WHEN trigger depth
is zero), retaining only nested append-driven revision advancement. Arbitrary raw
row locks and pre-existing raw reader/access maintenance can still deadlock and must
roll back/retry the whole transaction; they are not a no-deadlock guarantee.
Concurrent actual-role COMMIT probes exercise generic fact,
policy-only, reserved binding creation and capture races.

`guard_bound_state_version` applies on every `ProjectFactVersion` INSERT, including
generic REST/repository and direct `pdaa_api` SQL. When the parent fact has a birth
binding, the value must be exactly a text `OPEN`, `IN_PROGRESS`, `COMPLETE` or
`CANCELLED`; unrelated generic facts retain all existing value types. Binding,
receipt and birth identity are immutable and non-truncatable. The binding receipt
can be inserted only while its binding is unsealed; ordinary later FactSource,
FactEvidence and ProjectFactVersion appends remain governed by their existing
history/revision guards. The only binding update is false to true after
`valid_canonical_state_binding(id)`. A deferred constraint trigger requires every
inserted binding to be sealed and valid at COMMIT.

### Binding command and retry semantics

The internal TypeScript port accepts project, typed target, initial state,
effective/optional-valid-until instants, original statement and a binding-command
idempotency key. The normalized request hash covers those caller-controlled fields
in fixed property order and excludes generated IDs, clock, actor roles and
correlation ID. Authorization uses the existing append-capable roles
`project_manager`, `portfolio_manager` or `pmo_admin`; leadership is excluded.
Project authorization/lock happens before receipt lookup, so a replay reauthorizes
current delivery. An identical replay returns the original binding, fact key and
first entry; altered reuse is `IDEMPOTENCY_CONFLICT`. The command uses one
ReadCommitted transaction with the existing five-second wait and ten-second limit,
one server millisecond clock, inserts fact/binding/source/access/reader/evidence/
version/receipt/audit, seals the binding and returns only after SQL validation.

### Coherent scalar capture primitive

Extract a data-package-private transaction primitive used by both the current
single-fact capture and Stage 2. It accepts the existing Prisma transaction,
authorized actor, sorted fact targets and explicit database `asOf`; it never opens
a transaction or reads a clock. It bulk-loads fact/policy prefixes, at most 1001
aggregate versions, conflicts and sources, then applies the existing resolver.
Prospective generated scalar conflict pairs are computed for all facts before any
insert. Existing plus prospective conflicts, all version/evidence references and
the Stage 1 conservative derived-reference calculation must fit the shared 51
target, 1000 version/source/conflict and 64000 evidence/reference/derived budgets.
Overflow yields one minimal cross-fact INCOMPLETE proof and commits no new scalar
conflict or scalar assessment. Otherwise new pairs are inserted in fact-ID/pair
order with contiguous per-fact revisions at the common `asOf`, all facts are
reevaluated, and one ordinary sealed `FactAssessment` per bound fact is persisted
with the existing complete prefix, policy, conflict and access-revision semantics.
The public scalar method calls the same primitive for one fact, retaining its
current response, authorization, idempotency and side effects.

Extend `FactAssessment` with `captureKind`, defaulting existing/public rows to
`SCALAR`, plus nullable `milestoneAssessmentId`. Replace its current request unique
key with `(customerId,projectId,subject,captureKind,idempotencyKey)`. SCALAR rows
must have no parent. Stage 2 rows use `MILESTONE`, a deferred same-scope parent FK,
and a unique `(milestoneAssessmentId,factId)` relation. Their deterministic child
key is `mc_` plus the parent UUID and binding UUID without hyphens; their request
hash covers `MILESTONE`, parent/binding IDs, project, fact type and common `asOf`.
This isolates them structurally from public scalar retries. Existing public request
hashes and replay behavior remain unchanged under SCALAR.

The FactAssessment INSERT guard treats MILESTONE rows as cross-proof children:
it first locks Project, then the unsealed same-scope parent header, and rejects a
missing/sealed parent, mismatched actor/as-of, non-bound fact or duplicate fact.
SCALAR keeps its existing Project/prefix checks and cannot supply a parent. The
cross-proof validator requires a bijection: every MILESTONE scalar child is
referenced exactly once by one non-null target, and every non-null target references
exactly one valid child; no unreferenced parent scalar may survive the seal.

The cross-capture request hash covers caller-controlled project ID, milestone ID,
literal rule revision and enabled flag in fixed order. Current append authorization
occurs before its receipt/header lookup. An identical retry returns the original
cross proof and rechecks current dependency access; changing any hashed field under
the same key raises `IDEMPOTENCY_CONFLICT`. The parent header is the authoritative
replay receipt, so sealed child scalar rows are never independently recreated.

Capture coordination is Project `FOR UPDATE` first, current matching grants by ID
`FOR SHARE`, ordinary reads of immutable canonical header/creation receipt and focal
Milestone, exact RequiredWorkItem rows by ID, bindings by ID, then facts by ID
`FOR UPDATE`. Immutable tables receive no UPDATE grants merely to lock rows. A second
read after locks must match the first identities. This is one bounded SQL statement
comparing ordered receipt/milestone/link/binding/fact tuples with structural JSONB
equality, including fact type, revision and birth identity; it must return true.
Take the one database clock only
after coordination. Do not use the mutable configured `Milestone.state` or
`WorkItem.state` values as evidence.

### Sealed cross-fact proof

Add `MilestoneConsistencyAssessment` with customer/project/focal milestone,
`canonicalReceiptId`, rule revision, enabled flag, database `asOf`, subject,
idempotency key, request hash, status, completeness and exact target/link/version/
evidence/conflict/contributor counts, result JSON, `auditEventId` and `sealed`.
The unique request key is actor-scoped and separate from binding, append and scalar
keys. The canonical receipt FK pins the actual immutable sealed project creation;
there is no invented mutable canonical revision.

Add `MilestoneConsistencyTarget` rows. A milestone row has its typed milestone and
no required-link ID. Each work-item row has the exact `RequiredWorkItem.id`, focal
milestone and typed work-item pair. Binding/fact/scalar-assessment fields are all
null only for a genuinely missing binding; otherwise composite FKs prove the exact
typed binding/fact and sealed `FactAssessment`. Every scalar assessment has the
same `asOf`; its fact/policy/conflict prefixes and version/access dependencies are
therefore reused rather than copied or weakened. Add the required immutable
five-column unique key to RequiredWorkItem for the exact link FK.

Missing-binding admission is checked at target INSERT and again at header seal
under the Project lock. The immutable null target is the historical absence
snapshot, analogous to the binding's birth-access receipt. Restore verifies its
sealed graph, not absence in today's binding set; later binding creation must not
invalidate an earlier UNKNOWN proof. Timestamp comparison is not an ordering proof
because separate commands can share a millisecond.

Add a named exact RequiredWorkItem compound unique key and exact compound target/
binding/FactAssessment keys for every FK described here. Add
`MilestoneConsistencyContributorVersion` only for a positive contradiction,
with assessment, target/binding/fact, version and evidence IDs. Composite FKs bind
it to a non-null target, the exact fact version and its one current evidence row.
It records every supporting version/evidence association, not only their unions.
The complete evaluated dependency set remains the target-to-scalar-assessment set;
contributors are the positive subset used by the canonical case identity.

`valid_milestone_consistency_assessment(id)` is a bounded, security-invoker restore
predicate. For a complete row it verifies valid canonical project/receipt, exact
live required-link membership, one milestone target plus every required link,
valid sealed bindings, common-as-of valid scalar assessments, all declared counts,
and exact result scope/rule/status. It reconstructs evaluation/dependency arrays
from scalar results. UNKNOWN requires zero required links, a missing binding, a
non-RESOLVED scalar, or any resolved `CANCELLED` state;
NOT_DETECTED requires all states resolved and no COMPLETE-versus-OPEN/IN_PROGRESS
pair; CONFLICTING requires that pair and exact contributor rows/identity;
REVALIDATION_REQUIRED is the minimal whole-result envelope when any scalar proof
was restricted. A disabled result is minimal. An aggregate-bound failure is a
sealed minimal INCOMPLETE header with zero child/dependency/contributor counts and
no scalar side effects. The validator rejects extra JSON fields, unbound IDs,
partial target sets, wrong counts, altered contributor tuples and cross-scope FKs.

The capture insert order is final-output unsealed header, deterministic MILESTONE scalar
assessments,
target rows, contributor rows, audit event, header seal, independently validated
delivery, then COMMIT. The redundant post-seal validity query is omitted: BEFORE
seal, delivery and deferred COMMIT still each validate the graph. Writes return
only IDs when their row bodies are discarded, avoiding repeated transfer of large
proof JSON. The header starts unsealed. MILESTONE scalar/target/contributor INSERT
is allowed only while it is unsealed; UPDATE/DELETE and TRUNCATE always fail. The
only header update changes false to true after the BEFORE trigger validates the
completed graph. A deferred constraint trigger requires a newly
inserted header to be sealed and valid at COMMIT, and the audit FK/validator binds
the `milestone.consistency.captured` event. No child may be added after seal.

### Delivery, privileges and restoration

Capture uses append-capable project authority rather than leadership capture
permission, anticipating the Stage 3 request side effect without widening it.
Receipt lookup precedes no authorization. Replay/read delivery verifies the actual
actor's current matching role/grant and current AVAILABLE reader access to every
source retained by every scalar assessment. Lost access returns a fixed restricted
envelope with no stored result; a stored REVALIDATION_REQUIRED result is never
upgraded after access changes. No model/API route is added in Stage 2.

`pdaa_api` receives SELECT/INSERT on the binding, receipt, assessment, target and
contributor tables, plus column-only UPDATE of the two `sealed` flags. It retains
the existing finite ProjectFact revision and scalar-assessment grants; it receives
no UPDATE/DELETE/TRUNCATE on immutable rows and no policy shortcut. `pdaa_worker`
receives no new business DML. `pdaa_backup` receives SELECT through the existing
all-table grant. Every new or replaced function is schema-qualified, owned by
`pdaa_migrate`, uses security-invoker semantics and fixes `search_path` to
`pg_catalog, public`. Revoke PUBLIC execution on all new validation/trigger functions;
grant only the two restore predicates to `pdaa_api` (the migration owner retains
owner execution). Trigger invocation does not require caller EXECUTE.

Restore/recovery inventory expands from 31 to 36 business tables and calls both
new validity predicates for every sealed row while runtime CONNECT remains revoked.
Acceptance must exercise clean migration, repeat/no-op, populated genuine prefixes
1-to-5 through 4-to-5, exact prior ledger/checksum retention, actual `pdaa_api`
positive and negative COMMIT probes, and encrypted full-table restore into a fresh
quarantined database. Rollback is application-compatible: keep additive history and
run the matching reviewed release, or restore the pre-upgrade encrypted backup into
a separate quarantined target. There is no destructive down migration.

### Stage 3 delivery boundary

Deduplicate the durable unresolved request independently from actor-scoped HTTP
retries; compare exact canonical contributor tuples on hash reuse. Capture and
request creation commit together. Rule reevaluation, expiry, source revocation,
policy change or a negative later check never implicitly closes an old request.
No fake sent event, Graphile job or external dispatch is created for an internal UI
item. Request creation requires current matching PM/PMO/portfolio-manager scope,
not the leadership permission used for ordinary scalar capture.

Assign only a single configured PROJECT_MANAGER responsibility subject with a
current matching project/inherited project_manager grant. Multiple configured
subjects remain UNASSIGNED; do not filter into a silent substitute. Creation cannot
attest another person's IdP claims. Every delivery requires recipient equality,
current project_manager identity role and same-role current scope, plus current
source access for every retained dependency. Missing/ambiguous PM leaves a durable
pending case. Reassignment requires a later explicit audited revisioned command.
Wrong/removed recipient scope returns fixed 404; restricted evidence is withheld
without changing the original case. No evidence is shared automatically.

## Files, security, connector and dependency impact

Current stage: packages/domain/src/milestone-consistency.ts and domain exports,
focused tests, acceptance disclosure helper/tests, indexed plan and validation
record. No new runtime dependency, infrastructure, migration, grant, connector
scope or model-callable tool. The evaluator is not a permission boundary and has
no clock, network, database, secret or actor access. Failures expose no raw input.

Later stages extend existing domain/data/API/web modules and deployment/recovery
fixtures after their concrete schema review. No email, Jira changes, connector
ingestion, cadence/reminder engine, human approval, source-state editing, general
health calculation or leadership Q&A is part of this plan's initial delivery.

## Test and evaluation plan

Current stage: Complete plus three required Open items; mixed OPEN/IN_PROGRESS;
all-complete and incomplete milestones; no links; missing bindings/policies;
cancelled/unknown/stale/conflicting/ambiguous facts; source restriction/deletion;
forged scope, relation, timestamp, origin, state and duplicate identities; exact
aggregate bounds and bounded incomplete output; deterministic permutations;
unchanged input/frozen results; dedupe stability across permitted policy/as-of
changes and distinct identity for changed contributing versions/evidence.
Do not label this GOLDEN-003 passed: there is no durable authorized PM delivery.

Disclosure repair: enqueue delayed original body and continuation after a prior
successful snapshot, begin close, and require both plus newly queued captures to
finish before context destruction. Keep the 10-second drain deadline, cleanup on
failure, sanitized errors, secret-body/header negatives and existing late-close
failure checks. A real Chromium fixture must reproduce the close ordering and
verify original bytes; no response rewriting, filtering or error suppression.

Run lint/types/full units/seven builds, architecture/OpenAPI, documentation and
appropriate native browser regression. Full required remote CI and separate exact
candidate review gate merge; changed packaged capture needs both-profile evidence.
Later persistence requires current role/grant races, dedupe concurrency/replay,
every FK/COMMIT/mutation/privilege denial, genuine prior-prefix upgrades and exact
full-table encrypted recovery with runtime quarantine. Later UI needs assigned-PM
relogin, copied-link/source revocation and cleanup, across both packaged profiles.

## Rollback and recovery

Stage 1 can revert compatible application/test code without changing data. Stage 2
adds durable history: retain that additive schema and history during a compatible
application revert, or use encrypted restore into
a fresh quarantined target with the matching reviewed release. Preserve the local
development database, volumes, Docker VHD and failed evidence. No destructive down
migration. Extend the full-table and genuine four-to-five upgrade contracts before
claiming any fifth-migration acceptance.

## Decisions, risks and progress

The controller adopts the reviewed intake's explicit binding, aggregate bounds,
conservative predicate, independent dedupe and recipient decisions subject to this
plan's independent review. Finite staged implementation prevents an untested domain
result from becoming a durable request or accepted story. The documented limits
are partial delivery, not waivers. All five customer/distribution release gates,
Issue #5 and real-data activation remain open. No new story is accepted by this plan.

The independent non-author design review approved Stage 1 on 2026-09-12 after
clarifying the shared derived-reference budget, whole-result withholding and all
agreeing-source support in dedupe. The controller adopts those routine decisions
under delegated authority. Stage 1 implementation, full validation, immutable
review, packaged evidence and merge are complete. The Stage 2 candidate above
records the concrete DDL, transaction, privilege and recovery choices. It
was independently approved on 2026-09-12 after three passes resolved seven P1
findings; implementation is now in progress.

### Stage 2 implementation checkpoint (2026-09-12, unmerged)

The working candidate contains migration 5, strict binding/capture contracts,
atomic fresh binding receipts, coherent cross-fact persistence, runtime grants,
restore predicates and acceptance coverage for all four released upgrade prefixes.
The four released migrations remain byte-for-byte unchanged. Formative review
has driven null-safe typed-target checks, complete child/count validation, historical
missing-binding semantics and Project-first raw append coordination. This is not
an immutable-candidate approval or a release gate pass.

Lightweight validation has passed lint, 25 new domain-contract tests, documentation
validation and 13 documentation regression tests. The latest isolated focused
database run passed 7 of 8 cases; the 1,000-version cross-fact capture failed the
unchanged 10-second transaction deadline (P2028). A prior complete database run
passed 89 of 92 cases; two fixture/assertion defects were subsequently corrected,
but the scalar boundary and full suite still require a fresh successful run.
Sanitized profiling reproduced the cross-fact timeout after bounded read/return
optimizations. Host diagnostics also found 93% physical memory use; that does not
prove resource pressure is the sole cause. Unfamiliar processes and all existing
development databases and retained evidence are preserved.

After narrowing the evidence projection and batching sorted fact locks, direct
data-package TypeScript compilation passed. A subsequent focused rerun passed all
34 Stage 2 unit tests: 25 domain contracts, six prior-schema adapter tests and three
acceptance-helper contracts. The helper contracts initially stopped at the local
isolation guard; their setup was corrected to exercise the intended role/source
assertions, without bypassing that guard. Full repository lint subsequently passed.
Documentation validation and all 13
documentation regressions also passed. A broader one-worker unit attempt encountered
startup/worker termination timeouts and was interrupted; it is not passing evidence.

Acceptance COMMIT probes now use a pinned positive assessment and assert the actual
transaction role is pdaa_api, including under restore quarantine. Positive complete
DISABLED and minimal INCOMPLETE controls accompany isolated typed-binding,
incomplete-scalar-child and hidden-scalar rejection cases. Every genuine prior-prefix
upgrade must check those receipt flags. Formative source review found no defect in
the corrected probes; their real database execution remains pending. An additional
public-scalar regression constructs 1,002 conflicts whose UUID-ordered sample omits
revision 1,002, requiring the stored immutable prefix to retain the true maximum
without adding conflicts or partial dependencies. That integration test is unrun.

A read-only schema comparison found only two new foreign-key naming mismatches;
explicit Prisma relation maps now match migration 5. Its first recheck could not
reach the local database (P1001); after verifying the existing container was healthy,
a read-only retry against the same disposable database returned an empty diff and
exit zero. Two further read-only
profiles aborted before the first parent INSERT was sent and confirmed substantial,
variable client/startup overhead; they are not successful capture evidence. The
10-second capture deadline and all integrity checks remain unchanged. A draft
candidate is being prepared for the existing clean-host CI and exact-SHA review;
neither draft publication nor passing focused tests authorize merge.

Outstanding gates include remaining adversarial database cases, executable
prior-schema adapter/upgrade and actual-role COMMIT probes, clean migration/schema
consistency, full native checks, encrypted 36-table recovery, both packaged customer
profiles, exact-SHA non-author review and required remote CI. No Stage 2 PR has
been merged. STORY-012, Issue #6 and all customer/distribution release gates remain
open; no PM delivery or external messaging has been added.

The close race is source-proven; the failed original response's contents remain
unavailable and are not presumed safe. The initial native Chromium fixture needed
both expected token fields and native base64 decoding; after those fixture repairs,
both real-browser regressions passed. See MILESTONE_CONSISTENCY_VALIDATION.md.

### Stage 2 review remediation (2026-09-12, PR #50 remains draft)

Candidate `131ba9268ee2aab224c521831b436b4eb8d4563b` was published to draft PR #50.
Documentation CI 34687589046 passed. Foundation 34687589048 failed: its native
build/architecture/contracts/lint/types/unit/dependency checks passed, and database
tests passed 93/94, including the 1,002-conflict prefix regression. The sole database
failure was UNKNOWN instead of CONFLICTING at the 1,000-version boundary. Fixture
evidence timestamps were millisecond-truncated and every effective timestamp was
identical, producing tied same-source temporal heads. Review confirmed the fixture
already has the full required-work set. The remediation orders evidence by observed
time then ID and gives revisions 2–500 strictly increasing past effective times;
counts, expected CONFLICTING and production/test deadlines are unchanged.

The same candidate's packaged job passed TLS/OIDC/runtime and forward-upgrade
checks but failed restored function privileges. Independent review requested four
changes: rebuilding migration-5 function ACLs after `pg_restore --no-acl`, actual-API
contention/admission tests, binding-birth COMMIT/receipt probes, and strict local
recovery error classification. No reviewer approved that candidate for merge.

The correction reapplies all 14 exact function revocations before granting only
the two API validation predicates. Recovery probes now require the observed Prisma
PostgreSQL P2010/P0001 structured error and the exact relevant guard message; FK,
transport, timeout, unrelated P0001 and unsupported wrapper errors do not pass.
Even unexpectedly successful probe mutations roll back. Binding-birth controls
commit under pdaa_api; complete unsealed births fail at COMMIT and missing/altered
receipts fail at sealing, with every generated negative-probe row proven absent.
Initial and quarantined-restore probes receive separate, pre-reserved canonical
projects. No runtime CONNECT privilege or production caller ID input is added.

New packaged coverage uses real API credentials, transaction-local role/PID
observation, exact blocking chains and bounded latches for identical append,
policy-only, binding and capture commands; distinct namespace collisions; and
append/policy/source/grant changes winning against capture. Genuine v4 fixtures
also retain fact-only and policy-only occupied reserved keys, then prove the fresh
binding allocator skips both without adoption, implicit policy or replay allocation.
These expanded database scenarios are implemented but not yet passing evidence.

Twenty focused remediation contracts passed (4 ACL, 11 immutable-history,
2 birth-helper and 3 transaction-latch tests). An earlier sandbox invocation failed
before test collection with an EPERM cache-write error; a scoped authorized rerun
passed. Interim non-author source review found no new blocker in the birth,
recovery and timestamp corrections, but does not replace immutable-SHA review.
Full corrected-candidate native checks, database/recovery/customer-profile runs,
original evidence review and exact-SHA approvals remain required. The default pdaa
database, released migration bytes, story/issue status and release gates are unchanged.

After the contention-harness recheck, observer credentials are supplied through the
original explicit admin transport (pg-pool hides its stored password from object
spread). Cleanup now releases locks, drains all started operations before closing
clients, and retains primary plus cleanup failures. A stalled-observer regression
enforces the three-second latch independently of database response time. No
repository deadline was increased. Interim re-review found no remaining defect in
that bounded correction; final immutable-SHA review is still required.

Current corrected-tree native validation passed full build, typecheck, architecture,
lint, all 887 unit tests across 41 files, OpenAPI contract matching, documentation
validation and all 13 documentation regressions. Raw Git-object comparison again
confirmed all four released migration files unchanged. The fresh isolated database
`pdaa_test_1789218137780` applied all five migrations and repeated deployment cleanly,
but its suite passed only 73/94: one authority test deadline, one query read timeout,
18 connection-timeout failures, and the 1,000-version cross-capture's sanitized
persistence failure. Its underlying exception was not exposed and is not presumed.
The conditional recovery rehearsal did not run, and no successful database receipt
was produced. These failures remain recorded; clean-host corrected-candidate CI,
actual-API races, upgrade/restore probes and original-artifact review remain gates.
