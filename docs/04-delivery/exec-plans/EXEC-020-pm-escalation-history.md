# EXEC-020: Current authorized request history for PM escalations

Status: Bounded history increment merged in PR #114; exact-candidate and actual post-merge checks verified.
Owner: Implementation controller
Date: 2026-10-22
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/9
Requirements: FR-ESC-005, FR-ESC-006, FR-UPD-004, NFR-SEC-001, NFR-SEC-005
Criterion: AC-UPD-008 (request-history portion only); supporting AC-UPD-003

## Verified merge and validation

The bounded history increment merged in [PR #114](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/114).
Independent source and coverage reviews approved exact candidate
`452d455dd269920e73dadaff1919ec33022e9a20`. Actual merge
`fe353437f45ce37b835255f63bfb12837068fa8a` preserves reviewed tree
`c45a9c91c58dde05c8079b54dc8c5843ca90d5a8` and ordered parents base
`9e1d84323c280b74f4f17bf62de80ec664e600fc` then that candidate.

Exact-candidate [Foundation 39809095541](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39809095541)
and [Documentation 39809095548](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39809095548)
pass. Separate actual post-merge [Foundation 39814060478](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39814060478)
and [Documentation 39814060230](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39814060230)
also pass at the actual merge SHA. Foundation passes on one unchanged failed-job
rerun. Its first production job failed at bundled restore's
`sessions_before_commit`; the original failure remains retained and its session
cause is not established. The verification job already passed on the first
attempt; no guard, assertion, source or deadline was relaxed for the rerun.
Exact-candidate hosted evidence confirms
1,904 units, 225 native tests, 45 ordinary browser cases and the separate saved
history browser, exact 85-business-table recovery plus the migration ledger,
and packaged TLS/OIDC/customer/distribution-manifest gates. Technical distribution
evidence does not accept any of the five release holds.

The fresh local fourth native run separately passes 225 cases / 16 files in
642.20s. Its genuine success receipt supports guarded recovery into a new,
quarantined database: exact 85 business tables plus the ledger, 14 populated
proof families including 116 reassessment causes, immutable-history denials and
no running application. API/worker CONNECT remains false on the restored target.
Earlier failed and interrupted runs remain historical without passing credit.

This completes the bounded implementation's review and merge gates. Full
AC-UPD-008, E2E-ESC-008 and Issue #9 remain open; delivery and supported project
impact are still required. Accepted stories remain 7/38 (R0 3/5, R1 4/33).
No schema, privilege, dependency or connector scope changes. Original19/20
research capture remains stopped.

## Objective and verified boundary

PR #109 implements authenticated, recipient-bound local recording and unconfirmed
replies. PR #112 adds the durable source-to-assessment handoff. The PM escalation
stage is sequenced after the owner's request/reminders, but its generic message
contains no request/reminder history. The PM's existing history list shows only
requests addressed to that PM. PMs do not inherit the separate PMO raw-response
reviewer authorization.

Add a real, currently authorized request-history projection to an existing PM
escalation invitation. This is independent of unfinished EXEC-016 interpretation
work and its stopped research capture. Preserve that work. Do not implement a
second interpretation system or resume research capture.

Full AC-UPD-008 also requires delivery and project impact. Neither is accepted
by this history slice. Existing assessments do not establish a delivery-impact
field; the view must explicitly say delivery impact is unknown. Do not relabel
freshness, completeness, reported status or late responses as project impact.

## Concrete design

### Current projection, not a new frozen message

Leave recorded messages, renderer revision, digests, invitations, retention and
all historical rows unchanged. Use existing immutable request/stage/engagement
lineage to project history at the server's current read time. Return that as-of
time and distinguish it from the escalation's original capture time. This is
current request history, not a claimed snapshot of what the original message
contained. No new table, migration, worker privilege or copied content is needed.

Add a bounded structured `escalationContext` to the existing recipient-request
response. It is null for non-PM or non-escalation requests. Only the invitation's
currently named, authorized PM receives it after every existing invitation gate
passes. The existing top-level history list does not acquire owner content or
new reviewer rights. Its PM invitation link opens the scoped context view.

### Exact cycle and bounds

Resolve the invitation's exact customer/project/engagement, policy revision and
stage generation. Locate the latest captured OWNER REQUEST in that engagement
and policy revision at or before the PM stage generation. Include that request
and the captured OWNER REMINDER/ESCALATION entries from its generation through
the PM stage generation. Preserve request/stage identity, generation, kind,
ordinal and capture time; verify the original content digest server-side only.
Do not serialize message digests, including for restricted entries. Order by generation, capture
time and stable request ID, with the original request first for tied timestamps.
Never substitute a different engagement, project,
recipient, policy or cycle. Exclude later generations and the PM's own message.

This is an explicitly current projection; a later eligible same-cycle record
appears with its actual timestamp, without being described as present at original
escalation capture. No timestamp-only claim of frozen membership is made.

Read at most 21 entries and admit at most 20. If no exact original request exists,
or the complete admitted cycle exceeds the bound, return an explicit unavailable
context with no partial history. Never silently truncate. Normal configured
cycles contain one request, at most eight reminders and the owner escalation.
Do not disclose query limits or database details in product wording.

### Current authorization and retention

The existing invitation gate remains authoritative: current identity, project
scope, PM responsibility, exact named recipient, expiry, active engagement/policy,
current issuance gate and source readability of the PM's own message.

For each historical origin independently, disclose its body only while:

- content is PRESENT, before its original purge deadline;
- the origin's named recipient equals the current engagement's responsible owner
  and still has current responsibility and project scope;
- the PM and origin recipient can currently read every original source dependency;
- the origin's captured metadata/digest and same-cycle lineage are valid.

Reuse the current dependency readability resolver. It verifies AVAILABLE source
access and current reader membership for historical versions; it does not
re-resolve current authority or compare stored authority/access revisions. Label
the result as historical request text, not current confirmed facts. Do not use the current
PM message's dependencies as authorization for historical bodies. Retention
expiry, source revocation or origin recipient revocation yields a metadata-only
EXPIRED/RESTRICTED entry. An ended or old-epoch invitation does not become usable;
retained historical content follows the same current permission rules as existing
history, under the current issuance gate. A closed gate denies the whole PM view.
Existing whole-view gates take precedence: loss of the current owner's grant
denies the invitation rather than producing partially visible history. Entry
redaction applies only while all original PM invitation gates still pass.

Return request metadata and authorized display projections of original request
bodies only. Renderer @1 embeds a frozen raw-response reviewer notice. Verify the
original body digest and supported renderer first, then require its exact trailing
notice to match the frozen reviewer metadata. Replace only that known suffix with
a fixed notice that readership details are withheld. Do not use broad text search
or parse untrusted source prose. If the digest, renderer or exact suffix cannot
be verified, withhold the body. Label the result as a display projection with
reviewer names withheld. Its retained original content digest identifies the
original stored body internally; never serialize it or claim the projected text hashes to it. Stored content
is not changed. Do not return owner response bodies, reviewer lists, response locators, source values from
restricted entries or new response permissions. Raw replies remain UNCONFIRMED
under existing frozen/current reviewer rules. Historical metadata is workflow
context, not evidence of a confirmed fact or personal performance.

Current unresolved fact labels remain those in the authorized escalation request;
they do not become satisfied because a response exists. Explicitly label delivery
impact UNKNOWN and explain that confirmation belongs to the existing workflow; do not
create a new obligation, clarification task or material write from a read.

### API and browser

Extend the strict domain recipient view schema and generated OpenAPI response.
Accept an omitted `escalationContext` as null/default for legacy payloads, retain
every existing field and preserve the PM's own responses and submission contract.
Validate IDs, timestamps, finite states, maximum entries, unique identities,
original-request membership and exact request/engagement context. Return null for
other stages. The browser renders plain text in the existing Antigravity panel,
shows the read as-of time, original request and reminder sequence, and explains
restricted/expired entries and unknown impact. It adds no send, confirmation or
approval controls. Each displayed origin carries its original content expiry;
the browser hides that body at the deadline without waiting for invitation expiry
or another network request. Do not interpolate source text into HTML.

## Implementation and validation

Expected files: `packages/domain/src/project-update-capture.ts`,
`packages/data/src/project-updates.ts`, existing API contracts/OpenAPI,
`apps/web/src/project-update-response.tsx`, native engagement tests, domain and
controller tests, response browser journey, operator/traceability documentation.

Independent design review precedes runtime edits. Root owns all edits and Git.
Keep all 25 released migrations byte-identical and all 85-table inventories exact.
The existing encrypted restore/issuance quarantine must continue denying views
until explicitly enabled; no new restore behavior is introduced.

Test exact cycle membership, owner-first request/reminder order and identity,
same-cycle later records, older/later/unrelated generations and projects,
no-original/over-bound unavailable context, duplicate/malformed context rejection,
exact suffix projection and reviewer-name non-disclosure, unknown renderer/digest/
notice mismatch withholding, browser origin-body expiry before invitation expiry,
ordinary PM access with no raw owner replies, current PM grant loss, origin source
and recipient revocation, original body retention expiry, current issuance gate,
no fact/satisfaction changes and no context on owner/non-escalation invitations.
Add a real saved PM browser journey with private response markers absent, original
request/reminder bodies and explicit UNKNOWN impact. Assert immutable recorded
messages/digests, source/canonical state and outbox attempts remain unchanged by
reads. Keep full E2E-ESC-008 planned; add a separate bounded-history specification.

New projection/browser evidence must create actual guard-valid owner request,
reminder and PM escalation rows and assert exact IDs before rendering the real
API response. Use isolated birth fixtures where necessary; do not bypass triggers,
weaken production weekday rules, intercept the API or count a weekend early return
as passing history evidence. For source redaction, historical source A must be
absent from the PM invitation's own readable dependencies B, so base invitation
denial cannot make the result vacuous. Test origin-specific response query exclusion
with a throwing query seam while allowing the PM request's own response query.
Exact 20/21 bounds may use a projection seam if larger guard-valid cycles cannot
be constructed; do not disable immutable guards. Verify legacy recipient payload
parsing and sign-out/refetch-denial context cleanup.

Run required build/lint/typecheck/unit/architecture/contracts/documentation,
isolated native and relevant browser gates. Use only the existing task-owned
synthetic server and guarded runners, never default pdaa. Obtain independent
exact-candidate source/coverage reviews, all normal hosted checks, expected-head
merge and actual-tree/post-merge verification before completion. Normal CI is
independent of the stopped research attempts.

## Limits and recovery

No live email, new transport, model/provider call, source publication, human
confirmation, approval execution, new dependency or privilege is added. No full
criterion/story/Issue #9 acceptance follows from this bounded history increment.
OD-013/014, proposal-only imports and all five release holds remain in force.
PR #113's separate STORY-008/013 acceptance completed its own gates.

Revert the additive projection/API/browser increment through review. Existing
stored content and schema remain compatible; no data rollback or rewrite is
needed. Original19/20 research capture remains stopped throughout.

## Approval and progress

Before runtime edits, independent design and coverage reviewers approved the
complete design at SHA256
`74ca1bd478b0f20e370efe08e317404c41e6e4af3c280fcb8c51fd3acfbe10be`.
The controller approves this bounded implementation under the existing delegation.
Advisory source review then identified a tied-clock UUID ordering omission; the
query now admits the complete generation and explicitly orders its request first.
A native fixture gives a reminder the same capture time and a lower UUID.

The additive domain/data/browser projection is implemented. Focused validation
passes 41 history units and 13 native cases, including positive query-seam
controls. The final full suite passes 1,904 units / 109 files; eight additional
cleanup cases use the real QueryClient. Build, lint, typecheck, architecture,
OpenAPI, 42 dependency records and documentation pass. The unchanged high audit
threshold passes with zero high/critical and six moderate advisories. All 25
released SQL migrations are byte-identical to verified main.

The earlier pre-isolation built-web/API journey passes one test in 9.7s on a fresh
synthetic database. It proves that prior runtime/browser behavior only; the
current dedicated-customer fixture and API binding separately pass a fresh
11.6s journey (assertions 7.3s) on `pdaa_test_1792683902011`. Root inspected the
saved screenshot and verified the success receipt against that exact fixture.
Five response UI contracts and three existing update journeys pass
together in 38.4s. Root inspected the saved Antigravity screenshot and sanitized
success receipt. Independent coverage review identified retained query data after
a denied GET refetch; the view now removes that exact protected query and disables
it on 401/403/404. Browser and real QueryClient checks cover cleanup.

At the earlier local validation checkpoint, fresh full native validation was pending a corrected rerun. Quarantined recovery follows before
exact candidate reviews, required hosted checks and verified merge. The earlier
failed runs remain retained without passing credit. No authorization rule,
production deadline or immutable guard was changed. See
[validation](../../05-quality/ESCALATION_HISTORY_VALIDATION.md) for full results
and the remaining gates. AC-UPD-008, E2E-ESC-008 and Issue #9 remain open.

PR #113 completed its separate exact-head and actual post-merge checks, making
its 7/38 accepted-story total effective. This increment adds no story credit.
Original19/20 research capture remains stopped.

The first full native run exposed shared-fixture scope/gate contamination; it is
retained without passing credit. History now has a dedicated synthetic customer
and unrelated protected project. The configured default customer is unchanged.
A migration-only diagnostic omitted normal baseline ACL reconstruction, so the
second full run used the unchanged complete harness: 209/212 pass, including all
12 history cases and the prior scope/gate regressions. Three unchanged cases fail
on aggregate timing or a wrapped milestone persistence error. A private retained-
database diagnostic confirms the latter is Prisma P2028 at the unchanged 10s
production transaction limit. Sanitized operation timings are retained privately;
no production deadline or validator is changed.

Coverage review approved splitting the five actual child deaths from one 20s
aggregate case into five sequential 20s steps plus the no-sixth-claim check. The
same fixture, actual deaths, individual 15s child bounds and every intermediate
assertion remain. Fail-stop prerequisites prevent filtered, failed or incomplete
earlier steps from advancing; late timed-out work cannot restore eligibility.
This changes the aggregate scenario allowance and requires fresh full evidence.
Independent source review also approved eight sequential bounded ingestion
phases, preserving the original lexical state, exact statement/assertion order
and real six-second expiry lock through an async generator. Each phase runs
inside its default 20s test; failure/abort/prerequisite latches stop later work.
No database work moves into setup. This changes that aggregate test allowance.
The 224-case third run lost its tool handle without a final result. The database
has no test client sessions, the bridge closed and no success receipt exists;
that run is retained without passing credit.

Independent coverage review found that earlier generation regressions did not
exercise the new history SQL. The native-only fixture now retains five old
captures, rotates/re-enables its newly isolated customer's gate through audited
transitions, and calls the real capture-generation command. The same engagement
and policy have generation 1 and 2. A new test checks genuine old capture IDs,
AVAILABLE exact latest request/current-cycle IDs, exclusion of old IDs and actual
owner-escalation capture time after the PM message. An old PM invitation cannot
remain authorized when a later generation exists; its joint epoch/generation
denial is asserted before context work. No immutable guard is bypassed.
The current focused 13-case native suite passes in 21.71s. The full current cohort
contained 225 cases across the same 16 files; at that checkpoint its fresh fourth run was underway.
The current isolated-customer browser passes. Earlier readiness/cache prerequisite
failures remain retained without credit; no further startup/test deadline changed.
No app grant was expanded. At that earlier checkpoint, full native/recovery and
required hosted results remained required before immutable review and publication.
