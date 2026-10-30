# EXEC-038: PMO ingestion reassessment status

Status: design for a partial read-only project panel. No additional story,
criterion, issue or release hold is accepted. Original19/20 capture remains
stopped; live Jira activation and comment ingestion remain disabled under
OD-013/014. Imported spreadsheet values remain proposals, not canonical facts.

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

Design, source and test reviews precede publication. Cover correct and malformed
pages, role and source loss, delayed body and old-session responses, no automatic
write or retry calls, accessible controls and navigation. Use existing native
authorization tests and add narrowly scoped role-switched synthetic HTTP/database
evidence where needed; mocked browser cases are not production authorization or
OIDC evidence. Exact-candidate review, hosted checks, a verified merge and actual
post-merge checks remain required before describing the panel as delivered.

Local checkpoint: the scoped architecture check, web typecheck and lint passed;
four decoder/lease tests and eight mocked Chromium cases passed. The browser cases
cover first-page bounds, focus/expiry, project and source-visibility changes, stalled denial
and success bodies, session replacement and 401 handling. A role-switched
synthetic HTTP/database test is prepared but unrun locally; it checks a visible
and a hidden source, role/project/customer denials, reader revocation and four
named customer-scoped tables around the reads. It does not establish database-wide
no-write behavior, separately authenticated production database access or a
real OIDC journey.
