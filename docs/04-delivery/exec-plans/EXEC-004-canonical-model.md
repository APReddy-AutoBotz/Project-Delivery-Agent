# EXEC-004: Canonical projects and immutable evidence

Status: In progress; tracked plan independently approved and first domain component implemented, with final candidate gates pending.
Owner: Implementation controller
Updated: 2026-09-09
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
