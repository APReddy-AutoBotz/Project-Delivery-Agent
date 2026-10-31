# EXEC-038: PMO ingestion reassessment status

Status: partial read-only project panel merged in PR #134. No additional story,
criterion, issue or release hold is accepted. Original19/20 capture remains
stopped; live Jira activation and comment ingestion remain disabled under
OD-013/014. Imported spreadsheet values remain proposals, not canonical facts.

## Candidate follow-up: explicit live pages

The in-progress follow-up supersedes the sole-GET and first-page-only restrictions
below, which describe PR #134. A separately authorized read-only page POST sends one
canonical UUID position in a strict JSON body, not a URL. It reuses the current
PMO, project and source-reader repository checks for every page. The cursor is
an arbitrary position, not proof of previous access. The browser validates the
page and ordering, retains only one next position in scoped memory, and replaces
the old page after a fresh explicit action. Live UUID ordering is not a snapshot;
new rows before the cursor can be missed. Current application operational logs
are body-free, but external proxy, browser and trace body capture is not proven
safe. The response still transports other internal IDs to the authorized browser.

This candidate adds no write, retry, canonical fact publication or acceptance.
Client session/project scope changes, stale actions, expiry, denial-body draining
and settled-request admission are part of the review. A new native two-page
role-switched HTTP fixture is included; exact-candidate review and hosted checks
remain required. Local web typecheck and five focused
unit cases passed. The first browser attempt could not locate Chromium in the
sandbox; the second found it but could not reach the sandboxed test server. An
unrestricted local server and the installed Chromium then passed nine cases.
After adding denial-drain coverage, nine of ten passed; the navigation case first
timed out looking for an unavailable project selector and then failed an
ambiguous selector. A corrected targeted retry passed. These failures remain part
of the evidence, not results from the hosted candidate.
The generated OpenAPI snapshot and 17 API-contract cases subsequently passed;
the first contract run failed because the expected route count had not yet been
updated for the new endpoint. The first export attempt failed the synthetic
target guard before connecting; the corrected unique synthetic target setting
allowed contract export. The focused denial-body test passed, and the corrected
navigation case also passed with same-task double-action and project/sign-out
checks. These mocked browser cases do not establish native role or proxy behavior.
An isolated PostgreSQL 17.11 target was then prepared with 26 reviewed migrations
and finite business grants, and the focused role-switched synthetic HTTP test
passed with 27 visible rows, at least one hidden source row ordered before the
first-page boundary, distinct pages, token-role/project denials and reader
revocation. It compared four named customer-scoped tables around the reads; it
does not establish database-wide no-write behavior or production function-owner
parity. The initial database-preparation script was not run: review identified
insufficient target and ownership checks. A revised script verified the fresh
container, cluster and migration socket before its single successful run. The
late-page project-switch browser case passed. Scoped product lint passed; a
broader ad-hoc lint including tests encountered an existing `any` in the
unchanged API-contract fixture, outside the repository's normal lint targets.
The expanded native case also passed for arbitrary and hidden-source cursor
positions. Eleven focused Chromium cases passed together after strengthening
denial-reader EOF/lease and delayed-page canary instrumentation. These remain
synthetic and mocked browser results; the retained test database is stopped.

Use the existing `GET /projects/:id/ingestion-reassessments` as the sole data
source, gated by a current authenticated `pmo_admin` role and the currently
authorized project. The endpoint independently rechecks project access and
current sealed ingestion-configuration reader membership for the source and
project; its result intentionally excludes unreadable sources. Do not call the
retry endpoint, mutate work, fetch raw source content or
show source, receipt, assessment, obligation or preview identifiers. The
existing response still transports these identifiers to the authorized browser;
not rendering them does not establish response-body logging or telemetry safety.
Show only
bounded state, approved reason, attempt counts and recorded timestamps. A
completed item means the reassessment work completed, not source publication,
delivery or fact approval.

Load only on an explicit action and show the independently authorized first
live page of at most 25 items. The first page is UUID ordered, not temporal order
or a snapshot; additional pages are not offered in this slice. State that an
empty page means no work visible to this user on that page, not that no other
work exists. Indicate when more was observed without displaying, retaining or
sending the returned cursor in a later API URL. Withhold rows on focus, visibility,
role, identity, session or project changes, and after 30 seconds; a fresh load
is required. Hide the panel during identity refresh or identity errors. This is a
browser freshness limit, not continuous authorization: timers can be throttled
or suspended, so also clear on visibility/focus and check elapsed time on resume
and action. Source access can change immediately after any successful read.
Any access denial, malformed page, timeout or current-source revalidation error
withholds existing rows immediately. Never retain last-good data after an error.

Bound response bytes before JSON parsing and strictly validate every field against
the existing response contract, project identity, UUID ordering, uniqueness,
cursor/last-row correspondence and safe integer limits. Label `availableAt` as
scheduled availability, not a completed event. Project the decoded
response down to visible fields before rendering. A single shared browser lease
prevents a new read while an earlier aborted or stale read is still settling,
including across component remounts. A timeout withholds data immediately but
does not establish server-side cancellation. Known access-denial/expiry signals
must be acted on before waiting for a slow response body; use the existing
streaming discard and session-generation protections.

The design required source and test reviews before publication. It covers correct and malformed
pages, role and source loss, delayed body and old-session responses, no automatic
write or retry calls, accessible controls and navigation. Use existing native
authorization tests and add narrowly scoped role-switched synthetic HTTP/database
evidence where needed; mocked browser cases are not production authorization or
OIDC evidence. The reviewed corrected candidate passed its hosted checks and was
merged; actual post-merge Foundation and Documentation checks also passed.

Local checkpoint: the scoped architecture check, web typecheck and lint passed;
four decoder/lease tests and eight mocked Chromium cases passed. The browser cases
cover first-page bounds, focus/expiry, project and source-visibility changes, stalled denial
and success bodies, session replacement and 401 handling. A role-switched
synthetic HTTP/database test is prepared but unrun locally; it checks a visible
and a hidden source, role/project/customer denials, reader revocation and four
named customer-scoped tables around the reads. It does not establish database-wide
no-write behavior, separately authenticated production database access or a
real OIDC journey.

The verify job of initial hosted Foundation 40998210774 failed in unit-test
collection because the parity test imported `@pdaa/domain` from the repository
root, where that package alias is not installed. The other 2,073 unit tests passed;
the native and browser steps did not run. Its separate production-boundary job
was still running at this checkpoint. The parity test now imports the domain
source by relative path; corrected hosted results do not erase this failure.

Three independent reviews approved corrected public head
`38c6327b07f97c99538837c312fedcdaf57e8b3b`. Corrected candidate Foundation
40998795639 and Documentation 40998795630 passed, including the new role-switched
synthetic HTTP test, eight mocked browser cases and existing packaged OIDC and
disclosure checks. Actual merge `a59b2d22d76be614b287b03d186e8d922b4c8f06` has
reviewed tree `097ee6f72e44ab57aaa5fe4cb2a827f1bc910c1d` and ordered parents
`9f46d6b0abf51f20587402d7eefc7776887c88a1` and that head. Post-merge Documentation
41001414146 and Foundation 41001414248 passed. The
packaged checks are not a dedicated real-OIDC reassessment-panel journey.
