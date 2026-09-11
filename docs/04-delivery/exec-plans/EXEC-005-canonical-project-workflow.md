# EXEC-005: Create and inspect a canonical project

Status: Design approved; implementation and validation in progress; acceptance pending.
Owner: Implementation controller
Updated: 2026-09-11
Issue: #6, STORY-010, AC-MOD-001, INT-MOD-001
Requirements: FR-MOD-001/002/004/005/007; adjacent FR-MOD-003/006,
NFR-SEC-001/004, TR-API-001. ADR-001 through ADR-010, ADR-012/013 apply.
Base: PR44 merge dc606d5ab3667f218efb846bfdb125b8e2a3d0ec.

## Outcome and bounded scope

A permitted PMO Administrator or Portfolio Manager selects an existing portfolio,
creates an optional programme, creates a project with its delivery structure and
then inspects that saved project in the browser. The API returns the same persisted
structure. Responsibilities, baseline/planned/forecast/actual dates, reported health
and configured external references remain distinct. This journey operates on
synthetic fixtures until the separate customer-activation gates pass.

This increment implements creation and retrieval. It does not expose an update or
reparent endpoint. Changing a saved baseline/forecast, source reconciliation,
ingestion, approval history and evidence display are subsequent workflows in
EXEC-004. New creation records are immutable so this boundary cannot silently
rewrite material history before those workflows exist. Existing project IDs,
summary contracts and all three released migrations are preserved.

## Persistence

Use an additive fourth migration and ten new customer-qualified tables:

1. Programme: UUID, customer/portfolio, unique code per portfolio, name,
   server-created author/time; immutable parent and content.
2. CanonicalProject: one-to-one extension of Project; optional programme bound
   to the same customer/portfolio; eight nullable date-only fields (start/end for
   baseline, planned, forecast, actual), server author/time, creation revision 1,
   declared collection counts and a one-time seal.
3. ProjectResponsibility: role (SPONSOR, PROJECT_MANAGER, SCRUM_MASTER, TEAM_LEAD,
   RESPONSIBLE_OWNER), identity-provider subject, display name; unique role/subject.
4. Sprint: project-local key, name and four date pairs.
5. Milestone: project-local key, name, declared state and four date pairs.
6. WorkItem: project-local key, title, declared state, optional same-project sprint,
   and four date pairs.
7. RequiredWorkItem: same-project milestone/work-item pair. This records the
   relation; it does not run the later contradiction/reconciliation engine.
8. RaidItem: typed RISK, ASSUMPTION, ISSUE, DEPENDENCY, DECISION or ACTION,
   project-local key, title, description, declared state and optional owner subject.
9. CanonicalSourceMapping: manual source system/instance key/type/external ID,
   optional safe HTTPS URL, revision string; target is the project or exactly one
   typed same-project sprint/milestone/work-item/RAID relation. Unique external
   identity per customer/system/instance/type/ID. No connector credential access.
10. CanonicalCreationReceipt: actor/customer/portfolio/idempotency key, operation,
    normalized request hash and typed created programme/project target.

UUIDs, author and creation time are server-owned. Request-local keys resolve only
inside the submitted project aggregate; duplicate/missing/foreign keys are denied.
Every child has a composite customer/project foreign key and every child relation
uses a composite same-project key. Storage checks constrain enums, lengths,
date ordering, target cardinality and receipt target type. Typed columns, rather
than arbitrary JSON payloads, represent business records. API and repository
schemas are strict and bounded: at most 50 rows per collection and at most 200
child records across an aggregate. Dates use real Gregorian YYYY-MM-DD values,
with no timezone conversion or inference. Missing dates remain null. An end date
before its corresponding start is rejected; no cross-category ordering is assumed.

Creation is atomic, including all records, the receipt and sanitized audit event.
Use parent-portfolio then current-grant locking, followed by existing programme
and creation-receipt access; project detail uses project then current-grant locks,
consistent with fact storage. A parent lock serializes same-portfolio creates.
Same actor/key/body replays the created identifier after current authorization;
different body or operation conflicts. Duplicate codes/external identities return
a generic conflict without identifying another project. No cached serialized
response is replayed. After inserting the project extension with sealed=false,
insert its children and receipt and perform the sole permitted false-to-true seal.
Seal validation checks typed links, all seven declared collection counts and the
typed project receipt. Child inserts lock their extension and reject sealed parents;
deferred COMMIT guards reject any unsealed aggregate or programme without its receipt.
Consequently later INSERTs cannot silently expand a saved creation result. Declared
counts are bounded nonnegative integers, with at most 200 child rows in total.
New aggregate rows reject UPDATE/DELETE/TRUNCATE except the one-time seal; base
Project content/identity changes are rejected when its canonical extension exists.
Deferred integrity validates complete parent/receipt linkage at commit. Legacy
projects may remain without an extension and retain existing data unchanged.
Their detail explicitly returns configured=false, null dates and empty collections,
while retaining their original reported status verbatim without inventing a RAG.

## Authorization and API

Add `portfolio_manager` as a sixth recognized role, with an additive AccessGrant
constraint change. Production role claims still require explicit configured OIDC
mapping; no claim grants scope. Replace fixed role-array bounds with the shared
role count. New role support does not expand existing fact write/policy authority.

- Create programme/project and list setup options: current pmo_admin or
  portfolio_manager grant on the existing parent portfolio, with the same role
  present on the authenticated actor. Project-only grants cannot create siblings.
- Canonical read: matching current leadership, project_manager, pmo_admin or
  portfolio_manager role and grant covering that project. Operational access,
  contributor access, mismatched roles and responsibilities grant no such read.
- Source mapping configuration is visible only to matching current pmo_admin or
  portfolio_manager scope. Other authorized readers get no mapping rows/URLs
  and an explicit withheld indicator. These are unverified configuration references,
  not source evidence or verified project facts.
- Legacy six-field project summary routes retain their existing tested access
  semantics. Richer details are a distinct route with stricter authorization.

REST routes, strict runtime request/response schemas and generated OpenAPI:

- GET /api/project-setup: writable portfolios and their programmes; at most 100
  portfolios and 100 programmes each, with explicit truncation indicators.
- POST /api/portfolios/:id/programmes: explicit human programme creation.
- POST /api/projects: explicit human canonical aggregate creation.
- GET /api/projects/:id/canonical: persisted canonical detail, including hierarchy,
  delivery relations, responsibilities, four date categories and reported status.

Use fixed 400/401/404/409/413/415/500 errors with no echoed data. Unauthorized
target IDs return an indistinguishable 404. Correlation IDs remain server-owned;
audit contains event/IDs/counts, never names, dates, descriptions or source URLs.
Request body stays within the existing bounded parser limit. API composition
receives a separate narrow CanonicalProjectRepository, with no ORM import into
controllers. Success response validation and unknown-route detection remain active.

## Browser journey

Show Create project only when the current setup query returns a writable portfolio.
Use an accessible form with portfolio/programme choice, code/name/description,
reported RAG and grouped optional dates. Repeating sections support responsibilities,
sprints, milestones, work items, required work links, RAID records and source mappings.
Allow creating a programme within the selected portfolio. Review the entered
details before the final Create project action; keep one idempotency key across
uncertain retries. Clearly label reported health as unassessed and configured
source links as unverified. URLs must be credential-free HTTPS with a valid hostname
and no control characters; render anchors with noopener/noreferrer without fetching.

On success, invalidate the project list and open persisted detail. Render only the
server's authorized response. Preserve existing expiry/sign-out cache cleanup and
clear sensitive drafts on session loss. Loading, empty, validation, denied and
conflict states must be usable by keyboard. Responsibility names/subjects never
alter role mapping. Add a synthetic-only PMO persona with explicit portfolio grant
for this acceptance journey; production development login remains unavailable.

## Validation and release boundaries

Unit tests cover strict schemas, Gregorian dates, bounds, references and no authority
from responsibility labels. Real database/API tests cover complete create/retrieve,
idempotency and conflict, concurrent duplicate creates, atomic rollback, same-scope
composite constraints, missing/role-only/project-only/mismatched/cross-customer and
cross-portfolio/programme denials, revocation before replay/read, mapping withholding,
sanitized errors/audits, immutable rows and legacy preservation. Test six-role OIDC
mapping and remapping denial without automatically accepting unconfigured claims.

Playwright executes creation and reload, persisted detail/relations, withheld
mappings, validation/denial, programme creation, and session expiry with sensitive
form cleanup. Attach a synthetic screenshot. Run all repository-required checks.
Packaged acceptance uses actual API runtime privileges, genuine populated upgrades
from each prior migration state and encrypted recovery of all 31 business tables
plus the exact migration ledger. Preserve existing packaged/OIDC/disclosure checks.
API has SELECT/INSERT on the new tables and column-only UPDATE(sealed) on
CanonicalProject for the one-time seal; worker has none; backup SELECT only.
Actual-role acceptance must reject every other new-table/column UPDATE privilege.

Independent design and immutable implementation review are required, plus the
existing source/build and fresh original-artifact gates before merge. R0 remains
3/5 and R1 0/33 until complete criterion/story evidence and verified merge permit
a deliberate acceptance decision. Issue6 remains open for evidence/reconciliation
criteria. Inventory, licensing, vulnerability, layer and signing gates remain open.
No connector scope, runtime dependency, real-data activation or outbound action
is added. Recovery retains additive history during a compatible application revert,
or uses the matching reviewed release to restore into a fresh quarantined target.

## Progress

### Approved validation amendment

The existing 1,000-version authority capture repeatedly exceeded its unchanged
10-second transaction budget during native verification (Prisma P2028). Its failed
transaction preserved all assessment, link, conflict and audit counts. A rollback-only
probe measured repeated extraction of large immutable result arrays: caching the
versions/conflicts arrays once reduced the stored predicate from 5,948 to 1,484 ms
on that fixture; all 37 saved fixtures returned equivalent results. This measurement
is local diagnostic evidence, not a reference-load performance guarantee.

Append the equivalent CREATE OR REPLACE predicate to the unreleased fourth migration.
The third migration stays byte-for-byte unchanged. Independent review reversed the
two declarations, two assignments and 22 references and recovered the exact original
function. Review SHA256 `bf1d3b85d6e34dfe757643fdbf1e0b7a1a134908d799f29cfe1906dfd9038642`.
FR-EVD-003/010 and NFR-SEC-001 apply. No resolver rule, safety bound, permission,
exception handler or seal/delivery callsite changes. Full prior hostile/boundary
tests, genuine prefix upgrades and quarantined recovery remain mandatory.

### Current state

- Post-merge PR44 Foundation 34437256817 and Docs 34437256823 both passed.
- Main is clean at the base above; no other open PR was present at reconciliation.
- Independent non-author design approval covers the preserved plan SHA256
  `7ec20cee758a6cc0d802636556d6bb4c3e9769e04327ade5477516f676d6c2d4`.
  The review receipt SHA256 is `4165db2a0a65b1f5c9d2d7f4beec5fc6b124e44b1e55d2660f1c978ef474fdcd`.
- Initial domain, repository, migration, API and browser implementation exists on
  `codex/canonical-project-workflow`. All seven workspace builds and OpenAPI export
  passed. Final native verification passed 739 unit tests, 77 database/API cases,
  all seven builds/typechecks, 31-table recovery, architecture/OpenAPI, dependency
  register and package audit. The authority boundary passes with its original limits.
- Independent UI review fixed retained programme selection beyond the setup cap,
  explicit stale child-reference validation and stable unchanged lost-response
  retries. The final complete 14-case browser suite passed, including all six
  canonical cases. Final candidate/packaged/review/CI gates remain pending.
- Planned checks and mutable implementation reviews are not acceptance evidence.
- Initial candidate `5709392` received independent immutable source approval and
  passed native CI and all 19 packaged groups. Distribution collection then
  correctly rejected updated selected Debian advisory text. ADR-014 records the
  independently approved two-description amendment (NFR-SEC-010, NFR-MNT-004,
  TR-TEST-001/002, AC-MNT-004); its 101 focused Perl tests pass. The original failed
  CI attempt is retained. The replacement candidate needs fresh review and CI.
