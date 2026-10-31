# EXEC-037: PM reconciliation previews

Status: partial navigation aid merged in PR #133. It
does not complete the PM action queue, approvals, any story, issue or release
hold. Original19/20 capture stays stopped; OD-013/014 remain unchanged.

## Current pagination increment

The local pagination increment adds an explicit next-page action for a single
project and request category, using the existing recipient endpoint and its
paired `(createdAt, id)` cursor. Each response is a new authorized live read,
not an atomic inbox: assignments and access may change, and newly eligible
requests before an already-passed cursor may be missed. The current project page
replaces prior rows; its other category is cleared and can be explicitly read
again. Cursors remain in memory only. A return to the first page performs a new
read. Opening any row still invokes the existing authorized detail journey.

The browser checks each row's project, recipient, assignment and strict
ordering beyond the previous cursor, limits pages to 20, and accepts a next
cursor only when it matches the last returned row of a full page. Batch and
single-page reads share the existing non-queuing lease through actual promise
settlement. Queue refresh invalidates the child synchronously and increments a
generation. A further review of the original draft found that an old Next or
Open control could still act in the same JavaScript task after sign-out and
before React unmounted it. The correction synchronously invalidates the preview
on session-generation transitions and checks its captured session before action
or publication. Session, scope, navigation, focus and visibility changes discard
old views. Denials clear both project categories before the body finishes.
These client checks do not prove server authorization or stop work after a
browser abort.

Local synthetic browser coverage includes both request categories, cursor
queries, page replacement, stalled denial and duplicate clicks, StrictMode
mount replay, same-turn queue refresh and separate same-task stale Next/Open
after development sign-out, and delayed response after session or focus changes.
The 19-case local browser suite passed after the session correction. It does not
independently simulate every OIDC expiry or token-replacement path. The
delayed-response fixture waits for actual body EOF and uses a DOM
observer canary; it is not production OIDC or a general disclosure proof. Two
isolated synthetic HTTP/database cases passed, each with 21 real scalar or
milestone requests, a role-switched API reader, both pages, a separately granted
but non-recipient PM and a later revoked recipient grant. Scalar no-write
comparison checks counts in five named tables only; milestone comparison checks
full rows in named assessment/reconciliation tables and excludes audit. Neither
proves database-wide absence of writes. The first scalar run was inconclusive
before fixture creation because a local OpenAPI test dependency was missing;
the corrected run passed after linking the existing dependency. The isolated
database was stopped after a zero-session check and its volume retained. Forced
equal-timestamp boundaries and assignment-change races remain required before
broader claims. No story or release hold is accepted.

For a currently authenticated project manager, use only projects from a freshly
validated PM action-queue observation as discovery hints. On explicit request,
show the first page of recorded open scalar and milestone reconciliation requests
for up to five projects at a time. Each list is independently authorized by its
existing recipient endpoint; never call manage routes, fetch evidence/details
automatically, mutate assignments or send messages. A recorded OPEN request is
not proof that a disagreement is still current. Opening a request uses the
existing project journey and triggers its normal current authorization checks.
The existing saved-link representation places the selected project and request
identifiers in the browser URL; it does not include request content or evidence.

The action queue can fail when it has more than 25 assigned projects or a required
facet is unavailable, and a recipient list may deny an ambiguous PM assignment.
Treat each failed category as unavailable, not empty. Mark every truncated page
and every unvisited project batch explicitly; do not claim a complete or atomic
cross-project inbox. Display project name, request kind and recorded creation
time, not recipient subjects, source values or evidence identifiers.
An access denial for either type immediately withholds both types for that project
and prevents a later category read for that project in the current batch.

Limit each explicit batch to five projects, two browser requests at once and
20 rows per project/category. Do not issue both list requests for the same project
concurrently. A shared no-queue browser scheduler must retain its lease until all
old request promises settle, even after abort; a stale batch must not start a new
one. Abort and withhold results on queue revalidation, identity/session/role change,
focus/visibility transition or navigation, and require another explicit load.
This caps cooperating browser work, not server-wide transactions or work after a
browser abort. Independently validate bounded response bytes and each page's
project, recipient, assignment, order, cursor and row count before rendering.
Request-level and batch failures must be generic and must not leak hidden data.
The preview withholds its partial results after a 15-second deadline while its
browser lease remains held until old calls actually settle. For known denials,
clear the affected view promptly and drain response bytes without retaining them
so the existing disclosure recorder can observe a complete response when it
arrives; a stalled body must not delay the visible denial or identity clearing.

Independent exact-candidate reviews approved public head
`a353e8eb882ea66ecfc3e534f1db874667dab1c6`. Candidate Foundation 40993940587
and Documentation 40993940448 passed, including the synthetic native fixture,
mocked browser cases and existing packaged OIDC/disclosure checks. Actual merge
`9f46d6b0abf51f20587402d7eefc7776887c88a1` has reviewed tree
`6d0a8f43c596a8fcdf3eda2960806e3fb4ad1be3` and ordered parents
`f70093a49f1087ae299ee83256dceed6cd306f44` and that head. Post-merge
Foundation 40996865826 and Documentation 40996865722 passed. The native test's positive assignment is scalar only and its
no-write snapshot covers named tables and project-tagged audit rows. The packaged
checks are not a dedicated real-OIDC preview journey.

Local checkpoint: scoped web typecheck and lint, 12 focused unit tests and 10
mocked Chromium cases passed. The browser cases cover bounded batches, denial,
timeouts, same-token session replacement and recipient-detail navigation; they
do not establish real OIDC or production authorization. The disposable-database
HTTP case passed in candidate hosted verification: it uses role-switched transactions,
two synthetic actors, a positive scalar assignment and empty milestone lists,
and compares named assessment/reconciliation tables plus project-tagged audit
rows. It does not prove a database-wide absence of writes or a real production
database login. Actual post-merge Foundation and Documentation checks passed.
