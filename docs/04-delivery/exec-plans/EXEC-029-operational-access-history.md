# EXEC-029: Operational access-operation history

Status: The first delivery slice has been independently reviewed and is in
implementation; validation and acceptance are pending. This partial increment
supports operational identity administration and groundwork for FR-AUD-006.
It does not complete general audit search, STORY-034, Issue #12 or a release gate.

## Problem and boundary

The existing recent-access panel labels every returned event other than
`access.granted` as a revocation, but the generic `/api/audit` returns all event
types for the customer. Unrelated events can both be mislabeled and crowd actual
access operations out of its 30-row limit. The grant upsert and revoke deletion
also emit their respective event even when the request makes no effective change.
The event therefore proves a recorded operation, not a change in effective
access. Form confirmations must likewise say that an operation was recorded,
not assert that effective access changed. Loading or failure must not be
presented as an empty result.

Introduce a separate bounded, read-only operational history of the two exact
event types. Filter in the database before the limit. Show only opaque event ID,
actor, event kind and event time, with labels describing recorded grant/revoke
operations; omit grant subject, scope, role, detail and correlation ID. Use an
explicit unknown-event failure, never a default revocation label. Distinguish
loading, unavailable and a successfully observed empty page. Reauthorize every
request and clear or withhold stale results across session changes. Search and
paging are live views, not a complete forensic snapshot; later commits with older
transaction timestamps may appear behind a previously read cursor.

System administrators operate identity without implicit business-data access;
the new tenant-wide endpoint is limited to operational access-event metadata
and requires the current authenticated `system_admin` role at both API and
repository boundaries. It never grants project/evidence or generic audit access.
The independently reviewed policy interprets the token-mapped system administrator
role as deployment-level identity-administration authority within its authenticated
customer. Actor, event and timestamp are sensitive personal/activity metadata even
with all event detail withheld. The old generic `/api/audit` endpoint returned
selected metadata for every customer event to both administrator roles without
project-scope checks. The separately reviewed correction retains that URL and
array/object shape as a deprecated alias for this same system-admin-only access
operation projection, with the role also enforced in the repository. This is an
intentional compatibility change: PMO-only callers receive 403, and system
administrators no longer receive other event kinds. The bounded schema can also
return unavailable for anomalous historical IDs or oversized actor values.
External clients may depend on the old behavior; they must not interpret the
alias as general or complete audit history. Legacy query parameters continue to
be ignored and cannot influence the selection; the new route rejects them. A PMO-scoped
history would require an explicitly selected scope and a locked, current
matching PMO grant and is deferred, as are general project audit and receipts.
The UI must clearly show the unavailable state for other roles rather than
claim no events exist.

For a later increment, proposed search accepts exact bounded actor, one of two action types and an
explicit UTC time range; strict schemas reject unknown or malformed parameters.
Use a bounded page size, deterministic `(occurredAt DESC, id DESC)` keyset and
an opaque, strictly validated cursor bound to customer and filters; return no
hidden total. Filter before pagination, reauthorize each page, preserve database
timestamp precision, and describe refresh as a live re-query. A cursor is not an
authorization token. Evaluate a finite access-event index and query timeout on
qualified synthetic data before selecting the migration; preserve existing
applied migration bytes and update upgrade/recovery inventories if needed.

The wire contract remains undecided. A read-only POST search with a strict body,
no-store responses, body-free logs and authenticated, non-disclosing or
server-held cursor can avoid putting actor filters in URLs and browser history;
it still needs review against proxy and tracing behavior. Bind all cursor state
to the customer and normalized filters, repeat authorization, impose finite
range, page, actor and cursor limits, and use half-open interval semantics.
The current `AuditEvent.occurredAt` is `TIMESTAMP(3) WITHOUT TIME ZONE`; session
time zone affects historical writes. Preserve millisecond cursor precision and
test actual non-UTC sessions. Do not assert that old rows of unknown origin are
verified UTC, silently rewrite immutable events, or change their interpretation
without a reviewed migration/data policy. A limit does not itself bound a scan:
review a partial event/time/ID index, sparse-filter behavior, explicit query
timeout and migration lock/upgrade effects before making performance claims.
The initial view prints the recorded wall-time representation with a historical
time-zone caveat, rather than converting it to the viewer's local time. The wire
format retains the existing ISO serialization convention; it does not establish
that old writes occurred in UTC. An unexpected event, invalid timestamp or actor
outside the 1–512 character response bound makes the entire view unavailable;
no actor is truncated. The UUID contract permits RFC version/variant IDs plus
nil and max; other values PostgreSQL permits are withheld as invalid output.

The platform view also serves PMO-only users; the new restricted panel must not
request or cache this tenant-wide history for them and must show it as unavailable,
not empty. Client handling must reject malformed results, clear late or cached
data on session/role/filter changes, and never expose a cursor from an old query.

## Review and verification gates

### Proposed first delivery slice

To correct the current misleading display without inventing historical time
semantics or exposing search terms, independent reviewers approved a smaller first slice:
one system-administrator-only tenant-scoped endpoint with no search inputs,
cursors or pagination, returning at most 30 exact grant/revoke events ordered
by recorded time and ID. Filter both kinds before the limit; no other event or
detail is returned. The panel and mutation feedback use operation labels and
honest loading, unavailable, empty and error states. PMO-only users receive an
unavailable explanation. Keep `/api/audit`'s wire shape while deliberately
narrowing its legacy role and event semantics as described above. This does not implement search or meet
FR-AUD-006. The existing client-side database query timeout is not proof of
server-side cancellation and does not bound scanned rows; the endpoint may fail under
load, and no index, scale or forensic-completeness claim follows. Revisit search,
timestamp semantics, a selective index and scoped PMO access in a later review.

The later search design must settle filter/cursor binding, pagination, finite
query cost and timestamp semantics before coding. First-slice tests must cover
more than 30 unrelated newer rows, tie ordering, both event kinds, cross-customer
isolation, forbidden roles, malformed query and response, and the scope of
observed no-write evidence.
Also test the deprecated alias at both API and repository boundaries, its
intentional PMO denial, event allowlist, cross-customer isolation and the
existing real OIDC operator group-remapping probe. The correction does not add
database row-level security or provide a scoped PMO audit view.
Browser coverage must distinguish loading, empty and error, never call an unknown
event a revocation, clear stale data on session/role changes and preserve the
existing visual style. Native tests must use qualified owned disposable targets,
not the default local database. Independent exact-candidate review, hosted
checks, expected-head merge and verified actual merge/post-merge checks precede
any evidence-ledger update. Original19/20 capture remains stopped.

Local work-in-progress checks: the synthetic API contract suite passed 17 tests,
the mocked repository test passed two tests, and six isolated mocked-browser
journeys passed. The held-response test permits request cancellation, so it
demonstrates stale-content withholding after settlement rather than proving that
the old response was delivered. These do not prove the real database or authenticated API-role
behavior. The native fixture is prepared for the hosted disposable database
wrapper, which reconstructs production business grants; it has not yet run for
this increment. Architecture and documentation validation passed. No story,
issue, general audit-search criterion or release hold is accepted here.
