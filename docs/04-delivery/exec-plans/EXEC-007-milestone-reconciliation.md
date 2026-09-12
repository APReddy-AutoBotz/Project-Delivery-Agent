# EXEC-007: Canonical milestone reconciliation

Status: Stage 1 design approved; implementation candidate in validation.
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

PR47/48 merged the reviewed evidence workflow and its acceptance records. Main
`9cc0873bfd8bf0a0d21541f59cdbbe21a87a83a2` has accepted STORY-010/011; R0 3/5,
R1 2/33. RequiredWorkItem already links canonical milestones to mandatory work.
Canonical states and source mappings are configuration, not evidence. ProjectFact
currently has only project plus literal fact-type identity; no child binding.
The existing source-authority evaluator is deterministic and bounded. Its scalar
conflict/assessment foreign keys cannot store cross-fact contributors.

The latest main repeat (Foundation 34641338774) passed application verification
but failed disclosure capture during bundled customer revocation. The original
failure has response=1 and continuation=1, with no header/body failure. The
recorder closes its browser context before draining queued CDP work. Preserve the
failed run; do not classify its unknown response as harmless or waive capture.

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

## Persistence and delivery contract for later stages

Use a separate immutable state binding with typed milestone/work-item foreign keys,
same-customer/project/fact relations and uniqueness on target+field and fact ID.
Create a new server-named fact and its first confirmed statement atomically; never
adopt an occupied arbitrary fact key. Every append path, including generic REST
and direct runtime-role database writes, must enforce the bound state vocabulary.
Unbound generic facts and sealed canonical configuration remain compatible.

Load all required links, bindings and history under one bounded ReadCommitted
transaction. Project lock first, deterministic grant order, then sorted fact/
binding locks; take one server clock after coordination locks. Do not call public
repository methods that start separate transactions. Preserve the 10-second limit
and prove aggregate bounds before loading 51 independently maximal histories.

Create a separately sealed cross-fact proof with exact contributor/target/link FKs,
immutable per-fact prefixes/policy/as-of/rule and complete dependency counts.
Validate completeness and receipt at COMMIT, forbid mutation or post-seal inserts,
and expose integrity checks for restored rows. Existing single-fact constraints
remain unchanged. Specify exact tables, privileges and SQL predicates before the
fifth migration; preserve all four released migration bytes.

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

Current stage can revert compatible application/test code without changing data.
Later additive history remains during compatible revert or encrypted restore into
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
under delegated authority. Implementation and focused regressions are present;
full validation, immutable candidate review, fresh packaged evidence and merge are
pending. Later stages require their separate concrete design reviews.

The close race is source-proven; the failed original response's contents remain
unavailable and are not presumed safe. The initial native Chromium fixture needed
both expected token fields and native base64 decoding; after those fixture repairs,
both real-browser regressions passed. See MILESTONE_CONSISTENCY_VALIDATION.md.
