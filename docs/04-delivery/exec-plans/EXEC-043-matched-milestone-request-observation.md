# EXEC-043: Observe a matching milestone reconciliation request

Status: implementation in progress; not accepted. This partial
slice supports FR-EVD-009/012, FR-HLT-008/009, FR-QA-003/007 and the eventual
GOLDEN-003 journey. The initial implementation was based on `de8a2e3f6c13a18fd77a4c2ba28d04203a4c2e20`;
the local integration now includes main `a78b8b93cbcc088d1ae7449ec38cd43b7d02ef41`.
Original19/20 capture remains stopped, OD-013/014 stay in force,
and imported or connector proposals do not become source-backed facts.

## Scope and disclosure boundary

For a current, completely authorized cross-object milestone conflict only,
allow a user who holds **both** leadership and existing reconciliation-manage
authority whose grants each cover the selected project to check whether an OPEN request is recorded
for the exact current contradiction contributors. This is a narrower dual-role
view, not permission for leadership alone to inspect the recipient-only request
or to discover the project request queue. Enforce matching token roles and
current database grants for each capability. The roles may be granted at different
covering scopes: one subject cannot hold two roles at the same unique grant key.
A manager without leadership or
leader without manage authority cannot use this new view. Return no request,
recipient, assignment, grant or historical proof identifiers, content, hashes
or contributor identity. Do not create, reuse, refresh, assign or deliver any
request. A manager's separate authorized command remains the only write path.

For a complete current CONFLICTING cross-object observation, return only
`MATCHING_REQUEST_RECORDED` or `NO_MATCHING_REQUEST_RECORDED`. The former says
only that an intact open request matches these contradiction contributors;
it does not mean its complete historical snapshot is current, that a PM is
currently eligible or assigned, or that anyone received or acted on it. The
latter means no matching request was recorded for these contributors at the
check, not that no older request exists. For NOT_DETECTED or unresolved,
incomplete, stale, ambiguous, restricted or no-policy inputs, withhold the
request status. Invalid or unsealed request, hash collision, unavailable proof,
timeout, unbounded history or failed authorization must fail closed; no error
may be presented as absence. Never turn a same-fact disagreement into a resolved
milestone or use this separate signal to claim GOLDEN-003 completion.
Return a bounded as-of and the conflict observation together with the status
from the same evaluation and transaction. The UI must not present this status
as matching positions obtained by a separate, potentially older read. Staleness
means a currently applicable head is stale or unknown; superseded history need
not be fresh but every historical dependency must remain accessible.

## Candidate transaction and proof design for independent review

Start with a scoped Project SHARE lock, then lock the existing actor grant rows
for that project/portfolio in deterministic order before fact work. Require
one currently held token-compatible leadership grant and one current matching
project-manager, portfolio-manager or PMO-admin manage grant. This equals the
existing management actor-capability predicate, not its complete PM routing
workflow. Preserve the existing configured-responsibility bound as a fail-closed
limit without claiming recipient eligibility. Do not lock or
infer another person's eligibility; a missing grant row has no negative row
lock. Reuse the existing bounded cross-object evaluation inside this same
transaction and one database as-of, without upgrading Project SHARE to UPDATE
or taking fact tuples after the project gate. Preserve all current project,
binding, complete-prefix, source-reader and timeout checks. Explicitly require
every version in every complete current prefix, including superseded or
unselected history, to have HUMAN_CONFIRMED provenance and a human_statement
source. The existing cross-object observer can accept SYSTEM_VERIFIED and does
not provide this whole-prefix human-only guarantee on its own.

Keep the evaluator's canonical `contributorIdentity` internal. Hash its exact
UTF-8 bytes with SHA-256 solely for the existing scoped unique-index lookup by
customer, project, milestone and rule, without filtering state or seal in the
lookup. On a found row require sealed OPEN state and createdAt no later than
the server as-of,
byte-for-byte identity equality, the request's native proof validator and its
original sealed assessment's complete current source access for this actor.
Before fetching frozen JSON or invoking native validators, check bounded target,
child, version and evidence counts and result byte size, then bounded-read the
complete original dependency graph. Reject unsupported origin on every original
dependency, inconsistent counts, overflow or unavailable source access. The
current `deliverInTransaction` has an unbounded nested dependency read and is
not by itself proof that this design is bounded. Historical content must never
be included in this status response. A collision,
corrupt or restricted proof is unavailable, not an absent match. No scan or
unbounded queue traversal is permitted. A negative result is meaningful only
if supported request writers are proven to acquire the conflicting project
gate before insertion/sealing. Prove first-insert and both transaction orders
against real PostgreSQL. The existing contributor identity binds only the
contributing target/binding/fact/version/evidence tuples and rule scope; it does
not include noncontributing dependencies, all policy revisions, PM assignment
or a complete historical snapshot. Do not broaden the wording of a match.
The preflight must include every nested scalar result, conflict and dependency
collection and a finite aggregate byte budget, with statement/transaction
timeouts on validators. It must compare actual counts and associations against
the same complete stable IDs that are subsequently checked; a page or sample
cannot establish access. If a delivery helper is retained after such a bound,
require `visibility === "available"` and `revalidationRequired === false`.

The local first increment adds a presentation contract and a dual-role
repository reader with bounded matching-proof and complete-prefix checks.
Fifteen focused schema, proof and reader tests and the domain/data typechecks
passed locally, including malformed histories, stale applicable heads and policy
history byte-budget tests.
Eight focused synthetic PostgreSQL cases passed locally after clean migration and
application of the project's business-role grants: both grant arrangements, both
request-birth orders, and both orders of source-reader removal and grant revocation
against an existing match. The source removal uses the API role, while grant
deletion uses the test database's administrative identity. Two further native
cases passed: changing noncontributing evidence and policy preserves the matching
contributor identity, while changing a contributor removes the match; an isolated
helper check withholds access after original-source revocation. The revoked source
is also a current-prefix dependency, so normal reads withhold earlier. Reconciliation
and audit rows are compared across the races; intentionally changed grant and source
tables are outside that snapshot. The local HTTP endpoint now has passing
synthetic database-backed checks for serialization, both role requirements,
grant revocation and current source revocation. Its shared and focused HTTP
contract tests also pass. A separate native case confirmed a null request status
for no detected conflict and unavailable status after the relevant policy was
disabled. A dual-role browser view checks request status with
its own same-transaction observation. Mocked-browser checks passed for distinct
response snapshots, an oversized stream, contributor expiry, unavailable access,
and consumed late responses during mode, milestone and sign-out changes. The
view describes these as historical checks at the displayed as-of and directs the
user to refresh before relying; its contributor timer is not a full-prefix
validity guarantee. The complete 36-case local milestone reconciliation
integration file passed before integrating the separately merged state-disagreement
slice. These results do not establish remaining recovery or production-role
behavior; the combined candidate requires fresh verification and review.

This read is provisional until independent design/security review establishes
that the dual-role gate preserves the existing management actor-capability predicate,
that the current observation can share a transaction without new lock cycles,
and that historic source access is complete and bounded. Do not reuse an API
endpoint that requires recipient identity or infer a role from a caller input.

## Verification and gates

Exercise matching and no-matching cases, request reuse and changed contributors,
unchanged contributor identity with changed noncontributing evidence or policy,
exact version/evidence associations, collision/unsealed/invalid proofs,
historical-source revocation, token-role/grant mismatch, project and tenant
denial, both covering project/portfolio grant arrangements, missing leadership
or manage capability, mixed provenance in current and historical prefixes,
oversized or inconsistent historical graphs, stale/no-policy/same-fact
disagreement, accessible expired superseded history, a contributor change between
independent reads, and the NOT_DETECTED outcome. Test request birth versus read in
both lock orders with backend IDs and actual blocking evidence, plus grant and
source revocation ordering and no-write snapshots. Bound all prefix and proof
work. Verify serialized API output and browser revocation/session handling if
exposed in the interface. Include clean, upgrade/recovery and packaged checks
as applicable, independent exact-candidate review, hosted checks, expected-head
merge and actual post-merge verification. Do not accept a story or release hold
from this partial human-origin path.

## Health-adjacent access and scope work in progress

The local candidate links the existing leadership milestone question from the
health area without adding its result to a saved health assessment or changing
reported or calculated status. The destination remains a separately authorized
check with its own `asOf`; the saved assessment retains its own `assessedAt`.
The standard leadership observation can disclose stored `SYSTEM_VERIFIED` or
`HUMAN_CONFIRMED` provenance when authorized. It does not independently prove a
person's confirmation, Jira/sheet origin, a project-wide absence of conflict or
PM request delivery. The separate manager-status read retains its dual-role gate.
The disabled unranked endpoint remains disabled.

Both health panels share a browser-tab-local scope fence and latest-assessment
query key. A session, project, known identity/project revalidation or page
visibility transition invalidates old health reads and fences actions before
React's next commit; already rendered DOM is not claimed to disappear within
the same JavaScript task. A fresh direct identity check is followed by a fresh
project check before delivery. Every health and milestone endpoint still applies
its own server-side grant and source authorization. The browser cannot detect a
remote revocation continuously while idle; a later independently authorized
read is an as-of check, not an atomic snapshot with the two scope checks.

One App-lifetime in-memory health-write lease is shared across both panels and
policy editors. It is not a cross-tab, reload or server lock. A local write
remains leased until its promise settles; an abort or network error cannot prove
that a remote write stopped or that a later GET is its final outcome. Unknown
outcomes are disclosed without automatically retrying. An assessment command
key is retained for the same customer, subject and project across local panel,
visibility and same-principal session changes, and is reused only on explicit
retry. This continuity does not survive a page reload or another tab. Unresolved
outcomes and command keys are bounded to 64 entries per registry; reaching the
limit withholds further affected actions for the tab and reports that limit.
`contentAvailable=false` is described neutrally because retention or current
source access may withhold content. No token, question or source content is
placed in the new query keys or browser storage.

The current local synthetic browser suite exercises keyboard focus, nonleader
visibility, held old success/denial responses delivered to a test wrapper, a same-task project
switch, pagehide/focus and explicit same-key retry after uncertain or held writes.
The first cold-start run timed out during local Vite page loading; it did not
reach the app. A subsequent run of the initial three synthetic cases passed;
six expanded cases and three existing milestone regressions passed before the
latest streamed-response test. A later seven-case run passed six cases, including
the first streamed-response case, but the nonleader case timed out waiting for
the development sign-in button; the cause is not established. A subsequent
seven-case run passed, including application-reader EOF on the held success
stream; that pass does not explain the timeout. A further seven-case run passed
after adding a held canonical-response remount barrier, a positive-controlled
transient DOM observer and cleanup for the held gates. The old success/denial wrapper reads a clone and does not prove the
application's original reader consumed the body. The separate success-stream
case holds a synthetic prebuffered body after application reading begins; a
subsequent focused rerun also observed that reader release its lock. It
does not prove network drain after a denial. These mocked cases do not establish native source-reader
revocation, continuous authorization, remote write completion or real workbook
provenance. Fresh hosted checks and any appropriate native/browser race evidence
remain required. No story, shared GOLDEN-003 criterion or release hold is accepted.
