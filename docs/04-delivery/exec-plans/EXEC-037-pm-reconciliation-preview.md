# EXEC-037: PM reconciliation previews

Status: design reviewed; implementation in progress. This partial navigation aid
does not complete the PM action queue, approvals, any story, issue or release
hold. Original19/20 capture stays stopped; OD-013/014 remain unchanged.

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

Independent design reviews, synthetic API/native access and browser tests,
exact-candidate review, hosted checks and verified merge/post-merge evidence are
required before describing this slice as delivered.

Local checkpoint: scoped web typecheck and lint, 12 focused unit tests and 10
mocked Chromium cases passed. The browser cases cover bounded batches, denial,
timeouts, same-token session replacement and recipient-detail navigation; they
do not establish real OIDC or production authorization. A new disposable-database
HTTP case is prepared but has not run locally: it uses role-switched transactions,
two synthetic actors, a positive scalar assignment and empty milestone lists,
and compares named assessment/reconciliation tables plus project-tagged audit
rows. It does not prove a database-wide absence of writes or a real production
database login. Hosted disclosure and identity-expiry checks remain required.
