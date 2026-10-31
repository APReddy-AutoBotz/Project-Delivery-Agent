# EXEC-036: Bounded access-operation search

Status: partial groundwork merged in PR #132. The search repository and cursor
are not wired into the API or UI, and no index or migration was added.
This is a partial step toward FR-AUD-006; project-scoped and general audit search,
STORY-034, Issue #12 and release acceptance remain open. Original19/20 capture
remains stopped.

Retain the existing GET and deprecated alias. A prospective separate read-only
POST will require an authenticated current system-administrator role at both
controller and repository boundaries, with the customer taken from the verified
actor on every page. It will filter only recorded `access.granted` and
`access.revoked` operations by an optional exact actor and action, and a required
half-open interval of at most 31 days. Page size is fixed at 30 with one lookahead;
the output retains only ID, actor, action and recorded time. No hidden count,
subject, scope, event detail, generic audit or project-access inference is added.

The interval and results describe recorded wall-time values. The database column
is `timestamp(3) without time zone`, and historical writer time zones are not
established. The existing ISO `Z` suffix is a serialization convention, not
evidence that historical values were written in UTC. The database query strips
the suffix for comparison and formats the stored wall time explicitly. A synthetic
role-switched, non-UTC session test exercises this interpretation; it does not
establish how historical records were written. Results
are live keyset pages, not a forensic snapshot: concurrent late commits can be
missed until refresh. Order is recorded time descending, then UUID descending.

The prospective opaque cursor binds customer, subject, exact filters and last
returned position; it is not authorization. It retains its original 15-minute
expiry across pages. Replicas must share the configured key and synchronized
clocks; up to 60 seconds of verifier clock skew is permitted. A subject that does
not fit the cursor budget fails closed without truncation before a database read.
Each encryption derives a separate AES-256-GCM key using a new CSPRNG 256-bit
salt, HKDF-SHA256 domain separation and authenticated version/salt. A fixed GCM
nonce is safe only under a different derived key for each encryption. Random-salt
collisions are probabilistic; for at most 2^32 issuances over the root key's entire
lifetime across replicas, the salt-collision probability is about 2^-193, assuming
independent healthy entropy. This is an operational assumption, not an enforced
global counter or a complete cryptographic risk bound. Snapshot/VM cloning must
not repeat random-generator state; attempts and aggregate issuance need bounded
admission and monitoring before exposure. Cursor lengths can reveal approximate
input length; request/response bodies and cursors must not enter proxy, trace or
application logs. Encryption-key rotation can affect existing persisted ingestion
credentials and requires a separate reviewed key/data procedure.

The local repository parameterizes filters and applies server-side statement,
lock and idle-transaction timeouts. A provisional no-queue process admission
limit and transaction-scoped advisory locks gate cooperating searches on the same
database to four slots and one per hashed tenant. These are availability controls,
not authorization or a limit on unrelated SQL, other databases or bypassing
clients. Tenant hash collisions can deny unrelated tenants, lock identifiers may
be visible to database observers, and fairness is not guaranteed. On an uncertain
transaction failure the process permanently retains the permit until restart;
four ordinary failures can disable search. Recovery, nonsensitive monitoring,
backend termination and old/new process overlap need verification before exposure.
The default admission object must be shared by every search path in each process.
The existing mock tests do not establish server-side lock or cancellation behavior.
The unwired repository orders by the qualified stored timestamp and UUID, matching
its native tuple cursor predicate. Previously the unqualified timestamp name in
ORDER BY resolved to the formatted output label; ordering formatted text depends
on collation. Supported filters bound queries to finite, four-digit AD recorded
wall times, excluding BC, year-10000 and infinity values. This alignment does not
establish equivalence for all database collations or historical data.

Private synthetic PostgreSQL 17.11 research compared the two expressions over
200,005 generated rows and 64 sampled plans, using one libc collation. The indexed
dense sample avoided a Sort with the qualified timestamp, while a generic missing
actor sample still filtered 10,000 entries. Fixed-order single samples do not
prove latency, bounded scanning, production plans or index readiness. A first
environment-inspection attempt failed before collecting plans; a corrected run
was retained separately. No production index or migration follows from these
observations. The newly added repository ordering and boundary native test had
not run locally when this candidate was prepared; candidate hosted validation is
required before merge.
Before integration, independently review and add an appropriate forward-only
partial access-event index, demonstrate prepared-query plans and sparse filters on
qualified synthetic data, bound tenant/global concurrency and failed cursor
verification, and examine migration locks, populated upgrade and recovery impact.
Do not place unbounded actor text directly into a B-tree index. Verify exact grants,
cross-customer and role isolation, timestamp ties, lookahead, page progression,
anomalous records, live insertions, cancellation and session-role changes. The
API must validate all returned rows and strict descending order, call cursor
capacity validation before any database query, suppress sensitive errors, and
reauthorize each page; the UI must withhold stale data and cursors on filter,
session or role changes. Existing no-store and body-free application logging do
not prove proxy and tracing configuration.

The operations migration validator rejects top-level `SET` and `CONCURRENTLY`,
and its runner wraps each migration in a transaction. A normal index build can
block audit inserts while it holds its table lock; a lock-acquisition deadline
does not bound build time. A reviewed timeout and failure/recovery strategy must
cover both operations and Prisma migration paths, including the migration ledger
and restored index definition and validity. Existing row-only recovery comparisons
do not establish index recovery. No migration was included in the merged groundwork.

Local unit tests cover cursor tampering, identity/filter binding, expiry, keyset
progression, Unicode and token capacity, and a mocked repository's SQL shape and
failure handling. Role-switched, non-UTC and pre-held-advisory-slot synthetic
native fixtures passed in candidate Foundation 40989482642 and post-merge
Foundation 40992309783; the latter fixture observes actual lock replies and backend IDs,
but does not cover independent full search processes, disconnects or restart.
Scoped domain, data and API TypeScript checks passed using mapped local dependencies.
A separate clean dependency installation downloaded the locked packages but could
not finish because Windows denied a workspace symlink, so it did not establish a
complete clean-install build.
The candidate Documentation 40989482620 and post-merge Documentation 40992310126
also passed. Three independent reviewers approved exact public head
`08544fa66312d1becd13213114509bfcd7b81681` as inert groundwork. Actual merge
`f70093a49f1087ae299ee83256dceed6cd306f44` has reviewed tree
`bca5b4d17118bdf4d8d2f9da715bf8397196d0f5` and ordered parents
`15846267d3984d9825197235eb4325074af988d1` and that head. The tests do not prove
query planning and index behavior, separate production database login,
cancellation, full-stack authentication or browser handling. All integration and
exposure gates above remain open; no story, issue or release hold is accepted.
