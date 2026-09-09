# EXEC-004: Canonical projects and immutable evidence

Status: In progress; PR41 temporal model and PR42 persistence merged; authority resolver design reviewed.
Owner: Implementation controller
Updated: 2026-09-10
Issue: #6, STORY-010/011/012; target R1; requirements FR-ADM-005,
FR-MOD-001/002/004/005/007, FR-EVD-001/002/003/004/006/007/010/012.
Adjacent scope: FR-MOD-003/006, FR-EVD-005/009, NFR-SEC-001.

## Outcome and sequencing decision

A scoped user can create and inspect a canonical project, retain separate source
values with evidence, and see why a fact is current, stale, conflicting or unknown.
Every changed fact/policy creates a version. A later assessment does not alter a
previously frozen assessment or grant access to restricted evidence.

PR #40 passed immutable review, native/CI and original-artifact gates and merged
as `5d45e1d0da36218f27b81c55201ec3d3affa1560` on 2026-09-09. Develop this
increment using synthetic information and the delivered foundation controls.
This delegated sequencing decision supersedes the historical “Then proceed”
paragraph in PUBLICATION_RECORD.md's production-boundary section and the old
next-task statement in IMPLEMENTATION_STATUS.md. Preserve those statements as
history and preserve their real-source restriction. Apply the master plan's
foundation-control, per-increment and release gates and ADR-010. The separate
private sequencing and complete design reviews approved this bounded transition;
tracked plan and later immutable implementation review remain required.
Issue #5, STORY-004/005, AC-MNT-004, distribution/security/signing and customer
activation remain open. No source, requirement or failed control is waived.

## Acceptance mapping

| Criterion | Behavior and executable evidence |
|---|---|
| AC-MOD-001 | Create/retrieve programme/project, sprint/milestone/work-item relations, responsibilities, four distinct date categories, reported health and external mappings; INT-MOD-001, scoped API/UI workflow |
| AC-EVD-001 | Changed source value appends a version retaining source identity/revision, value, observed/effective/validity timestamps and evidence; INT-EVD-001, concurrency/idempotency tests |
| AC-EVD-002 | Human origin survives stale/conflicting assessments, API/UI expose all dimensions, old frozen assessment unchanged; UNIT-EVD-002, GOLDEN-013, FAIL-028 |
| AC-EVD-003 | Configured expiry and explicit as-of produce stale; absent validity is unknown; UNIT-EVD-003, E2E-EVD-003, boundary/invalid date tests |
| AC-EVD-004 | Retain all applicable authoritative alternatives and explicit conflict; INT-EVD-004, FAIL-009; GOLDEN-003 coverage limits stated below |
| AC-ADM-003 | Scoped policy revision affects only subsequent resolution; INT-ADM-003, immutable prior policy/assessment replay |

Also retain original human statement/confirming subject/time, and independently
authorize copied evidence URLs, including revoked/deleted/unverifiable sources.
These boundary tests do not imply the later owner-response or reporting stories
are complete. Planned catalogue IDs are not executed evidence.

## Persistence and contracts

Use additive migrations and customer-qualified composite relations throughout.
Preserve the seven existing foundation tables and existing synthetic project IDs.
Add Programme (portfolio parent), canonical Sprint/Milestone/WorkItem relations,
project responsibilities, source mappings, and typed RAID/decision/action records.
Enforce programme/project portfolio consistency with composite storage relations.
Preserve legacy project IDs. Reparenting is denied in this increment, avoiding
implicit movement across authorization scopes.
RAID includes risks, assumptions, issues and dependencies; decisions remain
explicit. Avoid polymorphic foreign keys that cannot enforce same-project links.
Baseline, planned, forecast and actual dates remain distinct. Reported health is
stored separately from later deterministic calculated-health signals.

Separate source instance/record identities from immutable observations. Fact
identity uses a canonical entity/field; versions retain typed value, provenance,
source revision, original evidence, observation/effective/validity times and author.
Require same-customer/project evidence and source links in storage and repository
methods. Use bounded JSON/schema validation and size limits at the API boundary.
Append atomically with optimistic expected revision; retry by an actor-scoped
idempotency key cannot create a duplicate or hide a conflicting request body.
Do not overwrite a previous source's value to accommodate a competing source.
Supersede only within one source stream, retaining every prior version. Effective
time determines applicability; observation time remains independent. Late-arriving
older observations cannot replace a later effective value. Multiple revisions of
one stream are not automatically treated as a cross-source conflict.

Keep original human response text or its permitted immutable evidence reference,
specific target record, confirming identity/time and ambiguity state. Derive the
actor from authentication, never a supplied confirmer ID. A user cannot label
their own arbitrary input SYSTEM_VERIFIED. That origin comes only from a trusted
source adapter; this increment exercises a controlled synthetic source through
tests/seed, with no unrestricted production ingestion endpoint or demo identity.
No arbitrary SQL, connector client or human-approval capability is exposed to AI.
All public fact-creation routes derive provenance, author/confirmation identity
and observation time from trusted server context. Bounded effective/source times
remain explicit assertions; caller-supplied origin/confirmation fields are denied.

Evidence authorization is current state independent of a frozen claim. Separate
content/deep-link permission from project/status visibility. Record explicit source
access state and revalidation requirement. Revocation/deletion/unverifiable source
hides disallowed content and links while retaining only permitted metadata/history.
Authorization checks precede serialization, including direct-ID/history/snapshot
routes; history must not leak values through an earlier authorized response.
Every frozen/copied value retains its evidence dependency IDs, including cached
idempotency results. Reauthorize response delivery instead of replaying an earlier
serialized body after revocation; redact disallowed values and links, flag
revalidation, and never present a stale cached success as a newly settled claim.
This includes copied scalar values, excerpts and titles in snapshots, cached
responses and reconciliation requests, not only document content or deep links.

## Authority and assessments

Each immutable policy revision captures customer/scope, canonical fact type/field,
source type and optional instance, approval requirement, validity, fallback order,
conflict behavior and effective date. Examples in SOURCE_AUTHORITY_MODEL are
examples, not mandatory hardcoded customer policies. Do not invent a winner when
no applicable rule exists. Configuration is deterministic and schema validated.

Resolve under an explicit policy revision/as-of, excluding unauthorized/invalid
evidence, then evaluating approval and freshness. Retain secondary candidates.
The current view selects server time and the active policy; caller-selected dates
or old revisions produce explicitly historical assessments. A historical query
cannot manufacture a current settled value.
Two applicable authoritative values that disagree create CONFLICTING. Missing
validity remains UNKNOWN. A human confirmation cannot override policy authority.
Persist origin separately; compute freshness/conflict/classification independently.
Only current, unconflicted, authorized SYSTEM_VERIFIED/HUMAN_CONFIRMED evidence
may be presented as settled. Freeze inputs, dimensions, policy revision and as-of
in an assessment; current access filtering still controls its delivery.
Track unresolved contradictions independently of current-value eligibility.
Expiry or exclusion from authority selection cannot alone erase the conflict of
a HUMAN_CONFIRMED version: it may remain STALE and CONFLICTING simultaneously.

GOLDEN-003 includes PM reconciliation, not merely displaying conflict. Create a
bounded internal reconciliation request assigned to the project's authorized PM,
retaining both values and unresolved state, and visible in that PM's scoped UI.
No email, Jira mutation, notification dispatch or full engagement engine is part
of this step. If any golden scenario requirement is still unmet, mark it partial
and keep affected criterion/story acceptance open rather than relabeling it passed.
The scenario compares milestone completion with mandatory linked work-item state,
not merely two literal values of one field. Add an explicit required-work-item
relation and a bounded deterministic Complete-versus-Open contradiction check
retaining the contributing fact/version/evidence IDs. A general health/RAG engine
remains outside this increment.
Deduplicate an internal PM request by the same unresolved conflict/version set,
recheck assignee authority when it is delivered, and retain a pending/unassigned
state when no authorized PM exists. Do not silently substitute another recipient.

## Permission decisions and workflow

Require a current AccessGrant whose subject/customer match the actor, whose scope
covers the target, whose role permits the action, and whose same recognized role
is present in the authenticated actor roles. A global PM role plus a leadership
or read-only grant cannot authorize writes. Recheck inside write transactions.

| Action | Required scoped grant role and scope |
|---|---|
| Read project/status | Current permitted project or inherited portfolio read grant; evidence disclosure checked independently |
| Create programme/project | PMO Administrator or Portfolio Manager grant on the existing parent portfolio |
| Update canonical project/records, append a human statement | PMO Administrator, Portfolio Manager or Project Manager grant covering that project; authenticated subject owns the statement |
| Configure source mappings | PMO Administrator or Portfolio Manager grant covering the mapped scope; Project Manager limited to explicitly designated fields in the assigned project |
| Configure authority policy | PMO Administrator grant covering the exact policy scope |
| View/handle reconciliation request | Assigned Project Manager with current project-management scope; no automatic change to either source |

Map this table to concrete role IDs and denial cases before endpoint exposure.
Portfolio Manager is absent from the current five-role schema: add it only with
explicit configured identity mapping, matching scoped grants and OIDC/remapping
regressions. Unknown/unconfigured claims remain denied; the role adds no scope.
Project responsibility labels (sponsor/lead/etc.) do not add authentication roles.
Contributors retain assigned-context limits; broad manual confirmation/configuration
is denied unless an explicit authorized owner capability is implemented and tested.
System administrators gain no implicit business-data access.

Extend existing REST/OpenAPI contracts and React project details. Provide canonical
project creation/details, source-linked field history, evidence access handling,
policy history and an assessment view showing all dimensions and competing values.
Capture user intent through forms; deterministic services own writes/resolution.
Keep implementation details out of these product flows.

## Verification, acceptance and recovery

Test real persistence and server authorization: cross-customer/cross-project and
cross-parent IDs, absent/wrong grants, role-only authorization, read-versus-write,
copied links, revoked evidence, fabricated confirmer/provenance, append conflicts,
idempotent retries and denied-request audit/redaction. Test frozen assessments
after both policy changes and time changes, plus inaccessible prior evidence.
Use API integration and browser workflows for creation/history/conflict displays.

Run all required native checks, architecture/contracts/dependency registration,
documentation/traceability, CI, independent immutable review and appropriate fresh
packaged tests. Database evidence must cover clean install, repeat, upgrade from
the preserved foundation and recovery with representative old/new records.
Keep the user's development database, Docker volume and VHD intact. Do not reset
or drop existing data. Rollback uses the documented application compatibility and
tested restore process; an applied append-only migration is not casually reversed.

Accept only criteria with complete executed evidence and reviewed immutable refs.
Do not change accepted-story percentages, close Issue6 or activate real sources
from this plan. No new runtime dependency is planned.

## Implementation increments

The tracked planning gate passed before code. The first temporal component and
64 focused cases are implemented; the corrected full 584-test native suite,
lint/typecheck, seven builds, architecture/OpenAPI, dependency registration and
documentation checks pass. Independent pre-review found and verified the fix for
UUID case splitting. See TEMPORAL_FACT_MODEL_VALIDATION.md for scope, failure
history and remaining immutable-candidate, CI and original-artifact gates.

Start with the deterministic temporal fact model in `packages/domain`. It accepts
validated immutable source-version snapshots and an explicit assessment time,
retains source record/revision and evidence dependencies, chooses the latest
applicable version within each source stream by effective time and then observed
time, and calculates configured freshness without changing origin. Future
observations and future-effective versions are not applicable at an earlier
assessment. Equal effective/observed timestamps with different revisions are
ambiguous: do not break the tie by input order or arbitrary identifier.

This first component is an internal computation over already authorized input.
It does not implement durable append-only storage, grant authorization, policy
authority selection or a settled/current fact claim. It returns temporal
applicability and all dimensions with evidence dependency IDs; supplied unresolved
conflict links remain independent of freshness and source-stream supersession.
It cannot serve a public endpoint until current evidence authorization, trusted
provenance creation and current-policy selection are integrated. No role, route,
migration, connector or user-facing workflow changes in this first increment.

Keep this component separate from the existing lightweight `assessFact` contract.
Use explicit strict timestamp/value schemas and bounded input, deterministic
order, detached deeply frozen output and unchanged inputs. Test chronological
and late observations, ties, missing validity, expiry boundaries, conflicting
stale human versions, invalid/cross-scope links and frozen replay after subsequent
input changes. These are partial domain checks for FR-EVD-001/002/003/004/006/007/
010/012; they do not execute the full integration/browser/golden criteria above.

Then implement additive canonical/evidence persistence with migration/recovery,
current permission intersection and trusted ingestion, complete versioned source
authority resolution and disclosure, and the scoped API/browser journeys. Accept
Issue #6 criteria only after their entire planned contracts pass. Each increment
has native checks, separate immutable review and applicable CI/artifact gates.

## Next slice: durable human statements for existing projects

PR #41 merged candidate `28090cf6860dafeb048cea369a8cbf8bfbdb96da` as
`47d7c4516b906fc6e684ba04fa43dffc130c8a22`, tree
`404c7f0df5f871836e7bc2cee0f2ae1a01bfbee7`, after all candidate checks and
independent code/fresh-artifact reviews. Its 64 focused / 584 full tests passed.
The subsequent main verify job failed installing browser OS dependencies because
an upstream package index failed its hash check; production-boundary passed.
The unchanged retry of run `34385164564`, attempt 2, passed at
2026-09-09T18:26:31Z; preserve the first failed package-download attempt as history.
Main documentation run `34385164595` also passed.

Implement a complete internal repository path for appending a human statement,
reading explicitly historical pages and changing source disclosure permission.
Requirements FR-EVD-001/002/003/004/005/009, FR-MOD-007, NFR-SEC-001 and
TR-STACK-005 are partial; no full issue criterion or story is accepted. Existing
Project is the concrete typed subject. Programme/delivery hierarchy, policy
versions/resolution, multi-evidence associations, frozen assessments, external
ingestion and API/UI remain subsequent slices of this full plan. A project fact
history page must never claim to be a current/authoritative assessment.

### Storage and invariant decisions

Add seven tables in one second migration, preserving the initial migration bytes:

- `ProjectFact`: immutable customer/project/fact-type identity; mutable sequential
  aggregate revision. Same-customer Project FK and unique project/fact type.
- `FactSource`: immutable human stream, unique customer/project/fact/author.
  Its generated ID is the stable source instance/record identity for that stream;
  each evidence ID is a distinct server-generated source revision. Append derives
  this stream from the authenticated subject; no caller-supplied source identity.
- `FactSourceAccess`: current AVAILABLE/REVOKED/DELETED/UNVERIFIABLE state and
  optimistic revision. Identity cannot be changed. DELETED is a disclosure state,
  not a physical erasure or retention-policy implementation.
  Revision is an opaque counter: every reader INSERT/DELETE also advances it,
  including direct maintenance SQL, so a removed reader cannot be restored using
  a stale expected revision. One management request can advance it several times.
- `FactSourceReader`: explicit subject-level evidence permission, distinct from
  project access. The author receives their own reader on first source creation.
  Other managers/administrators gain no automatic content permission.
- `FactEvidence`: immutable original statement, authenticated author and server
  observation/confirmation time. Its FK includes the entire source scope and
  author so a statement cannot be attached to another person's stream.
- `ProjectFactVersion`: immutable typed scalar value, effective/valid-until times,
  HUMAN_CONFIRMED provenance and one primary evidence reference. Full
  customer/project/fact/source FK to evidence; unique evidence per version.
  Author/observed/confirmed time are read from that immutable evidence, avoiding
  independently mutable duplicates. Fact revision is unique and monotonic.
- `FactAppendReceipt`: immutable customer/project/actor/idempotency key, canonical
  request hash and scoped fact/version result IDs; never a cached response body.

All business relations use customer/project-qualified FKs, with RESTRICT on
identity changes/deletion. Preserve Project id/customer/portfolio identity with a
trigger: a later parent update cannot move existing facts to a new access scope.
Immutable source/evidence/version/receipt tables reject UPDATE/DELETE/TRUNCATE,
including owner-level accidental SQL. Mutable fact/access rows reject identity
changes. Bounded schemas and SQL checks enforce scalar types, calendar values,
required text and consistent validity intervals. No embeddings or new dependency.
SQL required-text checks use explicit ECMAScript whitespace without trimming the
retained statement. JSON numbers must round-trip through PostgreSQL float8's
shortest representation; arbitrary numeric precision that Node would change is
rejected. UTC millisecond timestamps use years 0001 through 9999. The version
INSERT trigger advances the aggregate revision; the repository does not advance
it twice. Shared actor definitions live in an acyclic module with unchanged exports.

### Repository, authorization and retry contract

Expose a narrow domain port, implemented with Prisma transactions. It accepts
the already-authenticated server Actor and correlation ID, never caller-supplied
customer, author, observed time or provenance. Strict schemas reject extra fields,
noncanonical UUIDs, invalid dates, unbounded text and unsafe scalar values. The
public human path always derives HUMAN_CONFIRMED origin. No SYSTEM_VERIFIED entry
point is added; controlled trusted-source ingestion is later work.

`appendHumanStatement` targets an existing project/fact type with expected
aggregate revision and an actor/project-scoped idempotency key. In one Read
Committed transaction: lock Project FOR UPDATE, lock and verify a matching
current action-capable AccessGrant FOR SHARE, check idempotency before expected
revision, derive the author's source and verify its current permission, append
evidence/version, advance revision, and insert receipt plus metadata-only audit.
Any failure rolls back all material changes. A same key/body returns original
references; a different normalized validated body is denied. Expected revision
prevents two different requests silently winning the same update. Hash optional
fields with explicit defaults and stable property order.

Matching grant role must also be in the authenticated Actor roles. Append permits
only scoped `project_manager` or `pmo_admin`; changing source readers/state permits
only scoped `pmo_admin`. Historical reads permit scoped leadership, project_manager
or pmo_admin and independently require a current explicit source reader to return
content. Contributor/assigned-owner workflows and Portfolio Manager identity
mapping remain unimplemented; operational roles confer no business authority.

Reads lock Project FOR SHARE, then qualifying grants FOR SHARE. Append/access
changes use Project FOR UPDATE first. FOR SHARE on grants conflicts with DELETE
and non-key role UPDATE, including the existing grant-management implementation.
Thus a revocation that wins the grant lock is observed before a write; an already
authorized write finishes before the revocation commits. Source-access changes
use the same project lock and expected source-access revision. All repository
paths use this lock order and bounded timeouts; no network calls inside a write.

History accepts an explicit ascending revision cursor and fixed throughRevision,
returns at most 100 entries, and supplies a continuation cursor. It never silently
truncates a claimed complete history or feeds a partial page to the temporal
resolver. A denied source retains only permitted IDs/revision and a restricted,
revalidation-required marker; value, statement, author and source content are
absent. Do not substitute an older visible version for an inaccessible later one.
New reads and receipt replays recheck current project and source permissions;
copied scalar values cannot leak through a prior result. Revoked source access
denies new append to that stream until an authorized access change restores it.

Audit successful mutations and domain-level denials using validated scope IDs,
fixed event/reason codes and correlation ID. Never copy statement/value/request
bodies into audits or exceptions. Invalid actor input fails before persistence.
Material-transaction rollback precedes a separate denial audit. A failed denial
audit returns a fixed error without a raw SQL cause; it cannot commit a fact.

### Deployment and validation obligations

Extend explicit runtime ACLs: API SELECT/INSERT on immutable tables; only needed
revision/access UPDATE and reader DELETE on mutable tables. No new worker
privileges; backup can read all tables. Extract a finite public-table ACL routine
shared by provision/restore and the migration-owner release upgrade. Only table
ownership is required for that routine; do not invoke administrator-only database
or Graphile grants from the migration role. A failed ACL application fails the
release job and can be retried against the completed migration ledger. The
migration-only job cannot silently be assumed to grant runtime access.
Explicitly require the migration owner (or the administrative provisioning path)
and verify public business-table ownership. A backup account must fail even on an
unchanged schema; PostgreSQL GRANT/REVOKE warnings alone cannot prove ACL success.

Exercise fresh and repeated two-migration installs, populated foundation-to-new
upgrade, runtime privilege/trigger denials, failed migration rollback, encrypted
backup/restore of representative old/new rows and restored immutable protections.
Fix multi-migration fixtures to address each ledger row by name/checksum. Extend
database evidence to report seven preserved foundation and seven added business
tables, with complete ledger checks and executed test IDs.

Meaningful integration cases include distinct-author competing streams, append
history/provenance, same-key retry and changed-body rejection, optimistic races,
grant deletion and role-change races, cross-customer/project/fact/source/evidence
FK attacks, read-versus-write role intersection, source reader/state revocation,
redacted history/replay, paging while appends occur, immutable SQL denials and
metadata-only audit. These are repository checks, not API/browser acceptance of
the later user workflow. Existing HTTP/browser and packaged foundation regressions
still run, plus all native, documentation, architecture and candidate gates.

Recovery: preserve the original DB/container/volume/VHD. Use isolated synthetic
test databases and acceptance deployments. A failed migration transaction leaves
the prior schema/history intact. After a successful additive migration, prefer a
compatible application rollback that preserves new rows; otherwise use the tested
quarantined encrypted restore. Do not use destructive down-migrations or reset.
Restore a pre-upgrade archive with its matching reviewed release and exact
migration list; do not relax archive/history matching. Any later promotion and
upgrade follows the separate customer change process. Stable heartbeat fixtures
are compared exactly; a live worker heartbeat is checked with recorded before,
restored and after bounds because it advances independently during backup.

Current native evidence and the remaining immutable review, packaged CI and
artifact gates are recorded in PROJECT_FACT_PERSISTENCE_VALIDATION.md.

Technical references: [PostgreSQL 17 locks](https://www.postgresql.org/docs/17/explicit-locking.html)
and [Prisma 7 transactions](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions).

## Next slice: explicit historical source-authority resolution

Base main 062fcd741c74fba38a6943fb5fe95b7efee52cf9; PR42 merged and its main
Foundation run34398409132 now passed. Root implements; separate agent reviews.
Partial FR-ADM-005, FR-EVD-003/004/006/007/009/010/012 under Issue6. ADR009/010,
SOURCE_AUTHORITY_MODEL and the full EXEC004 govern; no story acceptance.

Implement a complete bounded internal domain evaluator plus meaningful tests.
Policy persistence, administrative authorization, active-policy selection, trusted
ingestion, durable frozen assessments and API/UI follow. Never wire this function
to a route or model tool; inputs are trusted server snapshots and the result is
explicitly historical. No database, permission grant, connector or dependency change.

Input is strict, detached and bounded: fact scope, explicit asOf, complete boolean,
one immutable policy revision or null, up to1000 temporal versions/conflicts, source
instance metadata and evidence permission/verification descriptors. A complete=false
input produces INCOMPLETE and no resolved value; oversize or malformed input rejects
with a constant generic error, never input values. The caller is responsible for
proving completeness of source heads and unresolved-conflict dependencies; history
pagination is never treated as an authority snapshot.

Policy contains revisionId, exact customer/project/factType, recordedAt, effectiveAt,
ordered tiers, and conflictBehavior RETAIN_CONFLICT or REQUEST_RECONCILIATION. Each
tier has selectors with sourceType, optional instance UUID, requiredApproval
APPROVED or NOT_REQUIRED, and optional fixed-duration freshness policy/basis. An
absent policy or a revision not yet recorded/effective at asOf never resolves. No
implicit default/winner, scope inheritance or hardcoded customer authority matrix.
Selectors for a source type cannot overlap (wildcard plus specific, repeated instance)
within/across tiers. Multiple nonoverlapping selectors in a tier have equal authority.

Each version is the existing immutable temporal version plus trusted approval
metadata: state APPROVED/PENDING/REJECTED/NOT_REQUIRED, decisionAt and decisionId
(both required only for APPROVED/REJECTED). This represents a single immutable
initial decision, not a mutable last-decision field or approval event history.
Before a future decisionAt the decision is pending; later approval revocation or
replacement cannot be represented by rewriting it and must make the supplied
evidence UNVERIFIABLE until a later reviewed approval-history adapter exists.
REJECTED at/before asOf always excludes even if approval is not required. Source
types are supplied per immutable
instance, never inferred from provenance or source text. Evidence descriptors bind
the exact fact scope and each dependency ID to access AUTHORIZED/RESTRICTED and,
separately, verification VALID/REVOKED/DELETED/UNVERIFIABLE. Both AUTHORIZED and
VALID are required for content disclosure and value eligibility.
All source instances/evidence dependencies must have exactly one descriptor; no
orphans, duplicate identities or cross-scope references. Decision time cannot
precede version observation. Approval is evaluated at asOf; future decisions cannot
authorize earlier evidence. No human approval operation is introduced.

Run the existing temporal evaluator across ALL versions before eligibility filters
so an excluded/revoked/unapproved newer stream head never resurrects its predecessor.
Retain superseded, future and tied versions. Determine each matching selector's
freshness from its configured basis/duration and the version's explicit validity,
taking the earliest deadline; missing validity is UNKNOWN. Preserve existing
unresolved conflicts independently of policy eligibility, freshness and supersession.

Find the first tier having temporal APPLICABLE or AMBIGUOUS, approved, authorized,
valid, CURRENT, SYSTEM_VERIFIED/HUMAN_CONFIRMED candidates. Unknown/inferred origins
can never supply a resolved value. All same-tier applicable alternatives participate;
different typed values imply CONFLICTING, including empty-vs-scalar and date-vs-text.
An ambiguous stream in that tier blocks fallback/selection rather than choosing by
input order. Higher-tier stale/unknown/unapproved/absent candidates permit configured
fallback; lower tiers remain secondary evidence. Previously recorded unresolved
contradictions remain blocking across all tiers and never disappear upon expiry.
Before a human fallback can resolve, compare it with every authorized, valid,
approval-qualified SYSTEM_VERIFIED/HUMAN_CONFIRMED head in higher tiers, including
STALE/UNKNOWN higher heads and ambiguous alternatives. A differing typed value
creates a new blocking conflict retaining both dependencies and marks both rows
CONFLICTING. A higher source expiring cannot alone promote a contradictory human
fallback, even when no prior conflict was persisted. This guard concerns selected
human fallback values; secondary owner proposals do not overwrite a current primary.
New cross-source disagreement in the selected tier is returned as deterministic
version/evidence dependency sets, not a fabricated persisted conflict ID.
The higher-authority check unions only actual disagreement participants into one
deterministic group. Bound aggregate conflict evidence references to 64,000 while
constructing each group's unique set, before expanded arrays are allocated.
Over-budget snapshots reject entirely; no truncation or partial resolution.

Conservative disclosure: if any input evidence descriptor has RESTRICTED access or
verification other than VALID (including REVOKED and DELETED), no resolved value is returned and revalidationRequired=true. Such
versions return only version/evidence IDs and a restricted marker, with no value,
source record text, approval metadata, timestamps, provenance or other content.
This first evaluator does not optimize irrelevant inaccessible historical rows;
the later authorized repository reader must supply a complete minimal snapshot.
Frozen assessments always require fresh permission checks on later delivery.

Output retains scope/asOf/explicit policy revision and HISTORICAL mode; complete,
revalidationRequired, status (NO_POLICY/POLICY_NOT_APPLICABLE/INCOMPLETE/
REVALIDATION_REQUIRED/CONFLICTING/AMBIGUOUS/UNKNOWN/RESOLVED), selectedTier,
resolvedValue (only on RESOLVED), every selected supporting version/evidence ID,
all authorized candidates with orthogonal dimensions and eligibility explanation,
restricted envelopes and conflict dependencies. RESOLVED means only the explicit
historical policy computation; never a settled current application fact. Deep freeze
the detached result and preserve the complete policy for reproducible prior output.

Tests: primary/instance matching, approved timing and rejected metadata, multi-source
equal/disagreeing typed values, ordered fallback, no fallback on ambiguity/conflict,
no predecessor resurrection, policy revision/time changes, frozen replay, scope and
duplicate validation, missing/orphan evidence, restricted copied values, inference,
missing validity/expiry/overflow, retained stale+conflicting human provenance,
incomplete/oversize inputs, deterministic ordering and text treated as data.

Files: packages/domain/src/source-authority.ts, domain index export,
tests/source-authority.test.ts; EXEC004, validation/index/status/publication docs.
Run focused and full unit, lint/typecheck/build, architecture/OpenAPI/dependencies,
documentation validator/regressions; immutable non-author review and candidate CI
with applicable fresh original-artifact checks remain merge gates. Recovery is a
reviewed application revert; storage and existing migrations remain unchanged.

Implementation evidence: the domain resolver and 69 focused cases are implemented.
The full native 685-test suite, lint/typecheck, seven builds, architecture/OpenAPI,
38 registered dependencies and documentation validation/13 regressions pass.
Independent pre-review passes 26 additional edge probes and dense 1,000-version
resource checks. The first full run's unchanged startup-disclosure timeout and
successful unchanged retries are preserved in SOURCE_AUTHORITY_VALIDATION.md.
Immutable candidate review, candidate CI and fresh original-artifact gates remain
required before merge. No R1 acceptance criterion is claimed complete.
