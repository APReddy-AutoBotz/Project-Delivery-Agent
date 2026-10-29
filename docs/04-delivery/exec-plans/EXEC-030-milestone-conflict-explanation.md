# EXEC-030: Source-authorized milestone conflict explanation

Status: Implementation in progress; no acceptance is implied. This partial
increment supports FR-QA-007/012 and the shared
GOLDEN-003 scenario. It does not complete natural-language Q&A, AC-QA-005,
AC-HLT-005, AC-EVD-004, STORY-012/014/015, Issue #6/#8 or a release hold.
The design began on the tree of merged blocker-age PR #122, whose candidate and
post-merge checks passed. The isolated implementation has since incorporated the
reviewed tree of merged access-history PR #123; that merge's Documentation has
passed and its Foundation run was still in progress at this checkpoint.

## Goal and factual boundary

Give a leadership reader a deterministic, read-only explanation for one
explicitly selected milestone in one authorized project. If current,
source-authorized inputs show a recorded COMPLETE milestone alongside one or
more required OPEN or IN_PROGRESS work items, present the distinct positions,
their separately supported evidence and an explanation that completion is not
established. Identify the contradiction as a derived rule result, not as a
human-confirmed statement, model conclusion, resolved source conflict or proof
that a reconciliation request was created. Recommend PM reconciliation without
sending a request or writing to Jira. Do not describe evidence as Jira or sheet
data unless its authorized provenance actually establishes that origin.

This is a cross-object consistency rule: a milestone and its required work
items each have their own authority result. Do not treat it as two versions of
one scalar fact. Preserve internal evaluator distinctions, but map restricted
dependencies and unprovable inputs to a generic external unavailable result
without hidden identifiers, values, counts or target labels. `NOT_DETECTED`
means only that this named rule found no contradiction with complete, resolved
inputs, not that the project has no conflicts. Empty required links, missing
bindings, stale or unresolved inputs and CANCELLED states must not be presented
as a clean or resolved answer. Spreadsheet imports remain
proposals; do not fabricate human confirmation or live source provenance.
The current evaluator requires distinct milestone and work-item UUIDs even
though those identifiers originate in separate tables. If they collide, this
increment fails unavailable; it does not interpret that valid-data edge as a
clean result.
The proposed successful response has only `CONFLICTING` and `NOT_DETECTED`.
A fixed, generic HTTP 503 represents unavailable computation, including
internal UNKNOWN, INCOMPLETE, DISABLED and REVALIDATION_REQUIRED, absent links,
inaccessible inputs, unproved integrity, overflow and timeouts after visibility is
established. Failures while establishing visibility, including timeouts, use the
same generic 404 to preserve target concealment. A generic 404
denies an unauthorized or unavailable project/milestone without revealing which.
Only an existing milestone already visible in the caller's authorized canonical
project view can reach evaluation; nonexistent, hidden, unauthorized and cross-project IDs use the
same 404 so the 404/503 distinction cannot reveal a hidden target.
Only CONFLICTING contains position/evidence details. NOT_DETECTED contains no
claim of project-wide conflict absence; the fixed error bodies contain no hidden
IDs, positions, counts or labels. Apply the same complete dependency-authorization
check before NOT_DETECTED, despite its lack of detailed claims.

## Proposed read boundary

Require an authenticated leadership role and a current same-customer leadership
grant covering the selected project or its current portfolio. No caller supplies
customer, audience, graph, policy, as-of, proof, source access or rule enablement.
Lock the scoped Project and matching positive grant through output materialization
in the supported writer order, then verify the sealed canonical graph, receipt,
required links and state bindings. Compute `asOf` from the database clock. Resolve
each necessary current fact, version, policy and evidence with current
source-reader authorization under a single coherent transaction, holding the
locks required by supported source, grant, authority and fact writers. Deny or
return a generic unavailable state when completeness or current access cannot be
proved, including after concurrent revocation. Do not reuse the existing schedule
health projection as source-authority proof.

The existing `captureInTransaction` persists a milestone assessment, child
assessments, conflicts and audit records. It is not a read-only helper. The
existing `getMilestoneConsistency` uses append authorization and explicitly
returns historical assessment evidence. Implement a separately reviewed,
transaction-owned read-only loader alongside capture, preserving its canonical
identity, bounded re-read, authority, freshness and source checks without
modifying capture or performing those writes. Because this repeats critical
coordination logic, compare both paths on controlled equivalent snapshots and
explicitly review future-drift risk; share existing pure authority/evaluator
functions instead of inventing a second authority algorithm. Authority
preparation may construct ephemeral
conflict IDs: never expose or persist those IDs as historical evidence. A
historical saved proof cannot by itself establish current facts or permissions.
The initial candidate must fail unavailable if preparation creates any new
ephemeral conflict, rather than serializing its ID or persisting it as a side
effect. Recheck the current reader and AVAILABLE state of every source across
all required prefixes, including unselected/superseded versions, before
disclosing any material result. This is a conservative proposed boundary to be
tested, not a claim that a partial resolver view is safe.

The current capture locks Project UPDATE, current grant SHARE and sorted fact
heads UPDATE, then rechecks graph identity, obtains one DB clock and loads
bounded prefixes. Its assessment preparation is read-only but can create random
in-memory conflict IDs. Project SHARE may serialize supported writers, but the
new read must verify every supported fact, policy, binding and source-access
writer's protocol. The API role lacks UPDATE on immutable readers, so do not
assume it can take row SHARE locks there; prove any gate using actual role
privileges and both writer/reader orders. Raw evaluator results contain
dependency identities and contributor data and must never be returned directly.

Proposed supported-writer protocol: begin READ COMMITTED; validate the actor
and identifiers, require leadership in the token, lock the same-customer Project
FOR SHARE, then lock all matching project/portfolio grant rows FOR SHARE in one
deterministic ID order, intersect them with token roles and require a positive
leadership grant. Derive any administrative mapping visibility from that same
locked set; do not relock a differently ordered subset. Deny if the leadership
grant is absent. Hold both gates until
the bounded response is fully validated and the transaction commits; after a
wait, acquire fresh statement snapshots and check current state. Supported
fact/source-access/binding and authority-policy mutation paths use Project UPDATE
before changes, including first inserts; grant upsert/delete does not take Project,
so the positive grant row lock is separately necessary. The API role may lock
Project and AccessGrant because it has UPDATE there; it cannot row-lock immutable
FactSourceReader records by assuming SELECT suffices. Do not add unnecessary fact
lock upgrades that can deadlock two readers. Sealed canonical creation is the
supported source of required links and its guards make the sealed graph immutable.
This protects the supported application writers only, not privileged direct SQL
or bypass paths. Complete the audit of all worker/delegated mutations and tests of
first inserts and grant removal before approval; absence of an unlocked grant
cannot prove that a concurrent grant will remain absent, so deny without output.

Source audit evidence: `fact-authorization.ts` takes Project UPDATE before
append/access/capture; `project-facts.ts` changes fact/source-reader state
through that gate; `authority-persistence.ts` uses it for policy birth and
capture; and `milestone-persistence.ts` uses it for binding creation. Fact,
policy, conflict, source-access, reader and binding guards in migrations
`202609090001`, `202609100001` and `202609120001` also require Project UPDATE.
Sealed canonical graph guards are in `202609110001_canonical_projects`. The
supported RAID reopen function takes Project UPDATE before its grant and state
writes; ingestion persistence retains separate proposal streams and does not
itself publish canonical fact versions. Project-update observation uses read-only
authority preparation. This review excludes privileged direct SQL and
trigger-disabled operation. A direct row UPDATE/DELETE can acquire its tuple
before a BEFORE trigger waits on Project, so a reader holding Project SHARE must
not then wait on that mutable fact/policy/access tuple: that would invert the
order. Native role and two-order tests remain mandatory evidence.

For review, select one fixed, versioned on-demand diagnostic rule on the server;
this is not a claim about a customer-configured enablement policy. Do not invent
a DISABLED state when no such policy exists. The reader selects a milestone
from a bounded authorized canonical project view and the server independently
reauthorizes the selected identifier. Extract the existing canonical detail's
complete transaction-owned loader, preserving its exact bounded collection
queries, cross-reference projection, role-conditional mappings and strict
schema. The existing `detail` wrapper retains its authorization and calls that
same helper; the new route calls it inside its own transaction with the single
locked grant set, never through a nested transaction or a second grant scan.
Require configured/sealed state and the selected ID in the successfully parsed
view before any target-sensitive result. Missing, hidden, cross-project,
unconfigured, malformed and over-limit views use the same generic 404. A
timeout or database failure while establishing authorization and this bounded
view also maps to that fixed 404 before target visibility is established;
after a visible target is proved, evaluation timeout/overflow maps to the fixed
503. Initial authentication and malformed-parameter errors follow the existing
API contract without exposing raw input or database errors. A
concurrent first insertion of an administrative grant absent from the locked
set cannot upgrade this observation's mapping visibility; do not claim stable
absence or rescan. Verify 51st-row limits for every visible collection and
dual-role/mapping behavior with native and controlled malformed fixtures.

For each material position, the proposed claim binds customer/project/target,
canonical state binding, selected current version IDs, each exact version to
evidence to source association, value, effective and observed times, applicable
policy revision and freshness. Its classification distinguishes stored
provenance from a separate DERIVED_RULE inference. A source-type string alone
does not prove Jira/sheet publication, and a stored human-confirmed label does
not independently establish human presence. Fail closed on mismatched,
missing, expired or unlinked evidence. Each displayed position has a nonempty,
bounded list of exact `(versionId, evidenceId, sourceId)` associations, with
the same customer/project/fact/target and selected applicable policy revision;
retain all agreeing supporting versions, reject duplicates and never emit partial
lists. The precise finite schema remains a review gate. Do not serialize raw resolver inputs, restricted
values, contributor identity hashes, unlinked evidence or arbitrary source text.
Use existing bounds as a starting point: at most 50 required links and 1,000
aggregate versions/conflicts/sources and at most 1,000 published associations.
The proposed maximum serialized UTF-8 response is 262,144 bytes, with a 3-second
lock timeout, 8-second statement timeout and 20-second transaction deadline;
overflow or timeout fails closed rather than truncating. These bounds do not
prove a fixed number of physical database rows scanned. Apply aggregate budgets
before nested traversal and before serialization. The on-demand
rule is server-selected, not enabled by a caller flag. Distinguish generic
unavailability from an observed non-conflict without revealing restricted data.

The proposed strict wire object contains `projectId`, `milestoneId`,
`asOf`, fixed `ruleRevision`, and `outcome`. `NOT_DETECTED` has no positions.
`CONFLICTING` has two to 51 positions: exactly one MILESTONE/COMPLETE and one
to 50 distinct required WORK_ITEM/OPEN-or-IN_PROGRESS targets. Each position has
target, binding and fact IDs, fact type, resolved state, the selected policy
revision ID and one to 1,000
unique evidence tuples. Each tuple has version/evidence/source IDs and its
stored provenance label, CURRENT freshness, effective and observed timestamps,
optional stored `versionValidUntil`, and the resolver's policy-adjusted
`assessedValidUntil` and a finite validity mode. The existing resolver restricts
UNTIL_SUPERSEDED to blocker-opened-at fact types, so it is not valid for these
milestone/work-item state facts. CURRENT
must be calculated by the resolver at the common DB `asOf`, not inferred from
the raw nullable timestamp. A null assessed deadline is unknown for these state
facts; do not invent an expiry. At the effective expiry equality is stale.
Different agreeing versions may have different provenance;
do not collapse them into one origin claim. All positions and tuples
are tied to the same authorized project and observation time; totals are bounded
across the whole response, not separately per position. Any invalid tuple,
missing policy, unknown provenance, unprovable validity or over-budget result
fails unavailable, rather than dropping a contributor. The schema must also
enforce target and tuple uniqueness, exact contributor/support correspondence,
and the absence of position data on NOT_DETECTED before disclosure. These claims
describe stored evidence and an on-demand derived comparison, not a fact that a
person was verified present or a live connector origin.
Use strict objects, canonical lowercase UUIDs and round-trip millisecond UTC
instants as in the existing temporal schema; fact types use its 1–96 character
allowlist. Bind positive policy revisions to the exact selected policy row and
require finite provenance values supported by that resolver. Tuple uniqueness
does not prohibit different versions sharing a source. Check all prefix sources,
including nonselected and superseded versions, before either success outcome.

## Required design and verification

Before code, independently review the exact lock order and ownership of the
read-only seam, source-reader revocation, phantom/first-insert behavior, rule
enablement, claim schema, sanitization and bounded work. Review role semantics,
audience separation and stale-session handling. Preserve current supported
writers, stored assessments and source authority. No model call, model tool,
new migration, connector access, fact/assessment/audit mutation, worker or
external action is intended in this slice.

Native disposable-database tests should exercise COMPLETE plus three required
OPEN items, both positions and exact authorized evidence, nonmandatory exclusion,
all-complete and IN_PROGRESS alternatives, no links, missing/stale/restricted
evidence, unresolved scalar conflicts, wrong customer/project/role/grant and
malformed/over-budget input. Verify policy, source-reader, fact and grant races
in both lock orders using observed blockers; compare relevant persisted rows and
intercept writes without claiming coverage beyond observed paths. API tests must
exercise strict project/milestone identifiers, unknown parameters, generic
denials and bounded response schemas. Browser tests must hide old information
on role/session/project changes, failed refresh and late responses, and
distinguish unavailable from a supported non-conflict. Run native/recovery
work only on independently qualified owned disposable targets.

Complete independent exact-candidate reviews, hosted checks, expected-head
merge and actual post-merge verification before updating evidence. The complete
shared golden also requires authorized Q&A and a real PM reconciliation path,
not just this deterministic observation. OD-013/014 remain disabled and
Original19/20 capture remains stopped.


## Implementation checkpoint

The isolated candidate contains a transaction-owned canonical visibility helper,
read-only source-authorized milestone observation, strict response schema and
leadership milestone selector. Independent static reviews identified and the
candidate corrected the future-observation validation, binding-work ordering,
identity-refresh visibility and API metadata import ordering. Local TypeScript,
focused domain and API/contract tests and a mocked browser flow have passed.
The browser flow covers a pending identity refetch and role change, a denied
refresh, milestone switching with a pending response and sign-out. These checks
are not native database or complete golden-scenario evidence.

Synthetic database cases are authored for API-role privileges and an authenticated
HTTP read, the three-item conflict, source revocation, no-conflict dependency checks including an
unselected source, both source-writer lock orders, both leadership-grant revoke
orders and a first-grant insert, and both lock orders for fact/policy updates
and binding birth. They have not run: the local Docker daemon is unavailable. The
standard isolated hosted database runner reconstructs production business
privileges; the test asserts the effective role and AuditEvent read privilege.
The HTTP repository uses `SET LOCAL ROLE`, not a separately authenticated API
database login; race writers use the setup/owner connection.
The read-only proxy and named scoped row snapshots provide bounded evidence,
not a proof about arbitrary SELECT-called functions or triggers. Further work
includes remaining native boundary cases, actual-input
independent review, exact-head hosted checks, and reconciliation with subsequent
merged work. Neither a PR nor any acceptance is claimed for this candidate.
Original19/20 capture remains stopped.
