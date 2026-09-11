# EXEC-006: Project evidence history and saved assessments

Status: Implemented, independently reviewed, verified and accepted after PR #47 merge.
Owner: Implementation controller. Date: 2026-09-11.
Issue: #6; STORY-011/012; broad approved design EXEC-004.
Requirements: FR-ADM-005, FR-EVD-001/002/003/004/005/006/007/009/010/012,
NFR-SEC-001/004, TR-API-001. ADR-001 through ADR-010 and ADR-012/013 apply.

## Outcome

From an authorized project, inspect its human evidence, confirm a typed statement,
inspect the original history, configure explicit authority and capture a saved
assessment. Open a saved link with current project and source authorization.
The assessment preserves all original dimensions and its server-selected as-of
time. Source restrictions withhold content and copied assessment results.

The prior canonical workflow and its acceptance are merged. Main 798e676 and
its final Foundation repeat 34625704035 passed. No prior artifact audit needs
repeating. This increment uses synthetic manual statements and existing narrow
repositories; real-data activation and all five release gates remain open.

## Product decisions under delegated authority

Fact identity remains the existing project plus fact-type key. Provide a bounded
keyset catalogue of existing fact types (50 per page, maximum 100); an explicit
fact-type input can open a new target before its first statement. Label it as
project evidence, not a verified canonical field or child relationship. Display
the literal key. Typed inputs support text, number, boolean, date and empty; show
each historical value's original type. There is no implicit forecast conversion
or default authority. A fact-type key is not a canonical child foreign key.

Discovery returns only fact IDs, type keys, aggregate revisions and server-derived
canAppend/canConfigure capabilities after the same current project authorization
as history; no source names or values. Capabilities use matching role/grant pairs.
Unknown and denied projects return the same fixed 404. Refine the unpublished
history port so an authorized absent fact returns an empty historical page with
factId null and revision zero inside that same locked authorization transaction.
Only a zero/null cursor is valid for this empty target. Denied remains null/404.
A prior catalogue response never authorizes a later history read; a failed read
clears content and drafts. A global role alone cannot discover a project.
Catalogue paging is live, explicitly separate from
the frozen throughRevision used for history.

Follow the EXEC-004 role table: leadership reads/captures; project_manager,
portfolio_manager and pmo_admin read/append/capture; only pmo_admin configures
authority or source readers. Every capability requires the same current role in
both the identity and an applicable project/portfolio grant. Operational and
contributor roles gain no fact capability. Include mixed-role, remapping and
revocation tests when adding portfolio_manager to fact authorization.

Each human source initially remains private to its confirming subject. Add a
PMO-only source-access inspection port and editor using source IDs from history.
Inspection exposes revision, state and exact reader subject IDs, not the original
statement or confirmer. The PMO explicitly replaces the complete reader list and
source state against the inspected revision, with a review step. Identity-provider
subject IDs are entered literally; no directory enumeration or guessed identity
labels. Source sharing is additional to current project permission and cannot
grant that permission. Preserve the existing 100-reader bound and metadata audit.
An uncertain access-save response requires reload and comparison before another
change, since this existing operation uses optimistic revision, not replay keys.

Policy inspection retains the full active rule, selected event and aggregate
through-revision. PMO configuration uses a typed form for one explicit wildcard
human_statement tier, required approval, validity basis and duration, conflict
behavior and effective time, or explicit disable. Preview states that this
replaces the whole rule with the displayed configuration, including any existing
multi-tier rule, and distinguishes published versus active revisions. The REST
port retains the existing bounded general policy schema; no default policy is
installed. A pending scheduled rule is never presented as active, including after
reload. REQUEST_RECONCILIATION displays a need; no PM request is created.
A policy change
is configuration, not human approval; NOT_REQUIRED is explicit and APPROVED
does not convert human confirmation into approval. Save uses expected aggregate
revision and a stable actor-scoped idempotency key.

Confirming a statement records only the entered value, original text, effective
time and optional valid-until. A preview confirms the fact target and typed value.
Server code derives attribution, observation time and HUMAN_CONFIRMED provenance.
Keep a stable request/key across retries after an uncertain response; changing
the reviewed body requires a new key. Revision conflicts require refresh and a
new explicit confirmation, never silent resubmission against a newer revision.
These statements do not change canonical project records or source systems.

History shows original source/evidence identifiers, confirmer and effective,
observed, confirmed and validity times only for currently readable entries.
Restricted entries contain permitted IDs/revisions plus revalidation warning.
Page navigation replaces the displayed page; it never mixes differently
authorized or captured pages or supplies paginated input to the resolver.

Captures use only project/fact target and idempotency key. The trusted repository
loads complete bounded history and policy and owns the database clock. Display
the immutable original result, every orthogonal dimension, authority reason,
chosen value only when available, and original assessment time. All displays say
historical even for CURRENT-at-capture. Show an additional warning when an
assessed expiry elapses while open; never rewrite the saved assessment dimensions.
An explicit fresh capture creates a new assessment and preserves the old link.
Links use same-origin project and assessment identifiers; they fetch through
current authorization rather than carrying content or tokens.

Protected views clear content and drafts on session loss, selected-project change,
or denied current-scope revalidation. Source-sensitive queries revalidate on
focus and periodically; hide protected content during revalidation and on errors,
including a source restriction. Transient transport/503 failures hide content and
disable mutations, but retain an uncertain mutation's reviewed request/key in
memory until successful revalidation or an explicit user discard; they never
silently generate a replacement key. Actual scope/session denial or source access
loss clears that private state. Old asynchronous responses cannot repopulate a
different project/session. No evidence content, drafts or results in localStorage,
URLs, operational logs or client-side persistence. A displayed historical result
is only permission-checked as of its latest successful request; the UI states this
and refreshes while visible. No claim of instantaneous remote revocation delivery.

## REST and storage boundary

Dedicated Nest controller, injected ProjectFactRepository and AuthorityRepository,
composed only in main.ts. All requests use strict existing/new Zod schemas;
successful responses have discriminated available/restricted runtime schemas and
generated OpenAPI. Authenticate first. Fixed errors: 400 invalid input, 401 expired
or missing identity, 404 denied/absent/restricted write, 409 revision/idempotency
conflict, 503 repository unavailable. Never serialize database or Zod diagnostics.
Keep no-store and correlation IDs. No model-callable approval or arbitrary tool.

New reads: scoped fact catalogue and PMO source-access state. No schema migration,
table, database grant, external runtime dependency or connector scope is planned.
A type-only web-to-domain workspace dependency shares wire types with no new
browser runtime import. Reuse
the 31-table history and integrity controls. Add only bounded queries in existing
transactions and preserve project-then-grant lock order. Capture remains complete
at the existing 1000/1001 limit; no timeout or completeness bound is relaxed.

## Acceptance and validation

Target complete AC-EVD-001 (changed value retains history), AC-EVD-002
(human/stale/conflicting dimensions in API/display with unchanged older snapshot),
AC-EVD-003 (configured expiry warning), AC-ADM-003 (subsequent-only policy impact).
Accept only after actual API, browser and persistence evidence and immutable
independent review. AC-EVD-004 / GOLDEN-003's milestone versus mandatory-work
reconciliation is outside this increment and remains open. Full STORY-012 is
not accepted by a scalar conflict screen. Acceptance was withheld until the completion gates recorded below passed.

Tests: strict contracts and sanitized failures; authorized empty catalogue;
pagination bounds; source-reader management denied across roles/scopes; matching
portfolio role, changed role mappings and revoked grants; idempotent append/capture/
policy retries; changed-body rejection; denied replay; copied assessment links;
source revoke/delete/unverifiable redaction; source restoration does not upgrade
redacted originals; original typed history; configured expiry at boundary; retained
conflicts with HUMAN_CONFIRMED+STALE+CONFLICTING; disabled/scheduled rule display;
frozen snapshot unchanged after later facts/policies/time; expired session and
in-flight navigation cleanup. Browser acceptance uses the real API/PostgreSQL with
controlled synthetic grants; isolated fixture setup is not product behavior.

Run applicable lint, typecheck, full unit tests, seven builds, architecture,
OpenAPI, documentation checks, database/API and Playwright checks. Extend packaged
HTTP acceptance for the delivered journey; preserve existing migration/recovery
and distribution assertions. Required remote CI and separate immutable candidate
review precede merge. Root retains tracked edit/Git ownership; reviewers are
independent agents. Record exact evidence and screenshots before accepting scope.

Recovery: revert the compatible application version while preserving all additive
history. Existing encrypted backup/restore to a fresh quarantined target remains
available. Preserve the local development database, volume and Docker VHD.

## Progress

- Plan drafted from approved requirements and existing repository contracts.
- Independent design approved plan SHA256
  `285beedefd02132978e254c3d75226cc69726be01fe5f0e2a83cf10651c22335`.
  Private review SHA256
  `627bf460cf70bc358e6b79eeda4a31d474b258b76090a572bffc360cfa5d93b5`.
  The authorized-empty history ambiguity was resolved before implementation.
- Scoped repository reads, nine strict API operations and reviewed browser forms
  implemented. Four dedicated real browser journeys passed. Full unit suite passed
  764 tests with two workers; no process timeout was relaxed. Final native and packaged
  gates subsequently passed; see the completion entry below.
- Packaged acceptance covers both customer profiles, original response projections,
  reviewed statements/sharing, policy expiry, saved links after recreation and
  current revocation. All new evidence-fixture writes precede backup; deliberate
  project-grant revocation occurs after recreation, and quarantined restore compares
  the earlier backup. No released migration changed.
- [Workflow and validation record](../../05-quality/PROJECT_EVIDENCE_WORKFLOW_VALIDATION.md)
  documents the user/admin behavior, initial failed checks and remaining scope.

## Verified completion, 2026-09-12

[PR #47](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/47)
merged candidate `5ecefb11c94b9cd63077fa9ac8269e093f0e5a03` as
`2187f3a774f1655ec34eb26dee5381ffeea3a4c4` at 2026-09-11T19:25:42Z, with tree
`12aa5d3ca593f558cbb02ede60c7a0f0b8d7145d`. The
[public gate record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/47#issuecomment-5639577926) binds three independent immutable source reviews,
both original-artifact reviews and the root's retained evidence checks.
[Foundation 34634884717](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34634884717)
and [Documentation 34634884612](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34634884612)
passed for that candidate: 764 unit/contract tests, 85 database/API cases, 18 browser
workflows, seven package builds, 19 packaged groups, both customer profiles, three
populated upgrade prefixes and exact 31-table recovery. The reviewed tree and
ordered merge parents were verified after merge. These are completed candidate
checks; later main-branch repeats have their own results.

Under delegated controller authority, AC-EVD-001/002/003 and AC-ADM-003 are accepted,
completing STORY-011. Typed human statements preserve original versions; explicit
PMO authority changes subsequent captures; saved assessments retain provenance,
freshness and conflict independently and apply current permissions on delivery.
Issue #6 remains open with five of six criteria accepted. AC-EVD-004 / GOLDEN-003
and STORY-012 still require canonical milestone/mandatory-work reconciliation and
a durable request delivered to the currently authorized PM.

Accepted stories: R0 3/5 (60%); R1 2/33 (6.1%). These fixed story fractions do not
measure engineering effort or commercial readiness. The five inventory, licensing,
vulnerability, distributed-layer and signing release gates remain open. The current
87-file distribution evidence retains 832 High/Critical scanner occurrences,
112 validated dispositions and 720 unresolved occurrences; no new disposition
or customer-release approval is granted.

No migration, table, database grant, external dependency version or connector scope
changes. Current matching role/grant and source permissions protect every operation;
known denial clears protected browser state, while transient failures retain only
the reviewed in-memory retry request. No AI call, external write or real-data
activation. Recovery uses a compatible application revert preserving additive
history, or encrypted restore into a fresh quarantined target.
