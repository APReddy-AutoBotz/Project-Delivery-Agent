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
outcomes are disclosed without automatically retrying. An uncertain dispatched
assessment command is retained for the same customer, subject and project across
local panel, visibility and same-principal session changes, and blocks another
assessment in that scope rather than being resent. This continuity does not
survive a page reload or another tab. Unresolved
outcomes and command keys are bounded to 64 entries per registry; reaching the
limit withholds further affected actions for the tab and reports that limit.
`contentAvailable=false` is described neutrally because retention or current
source access may withhold content. No token, question or source content is
placed in the new query keys or browser storage.

The current local synthetic browser suite exercises keyboard focus, nonleader
visibility, held old success/denial responses delivered to a test wrapper, a same-task project
switch and pagehide/focus. Earlier tests exercised explicit same-key retry after
uncertain or held writes; the later no-retry work supersedes that behavior.
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

Hosted Foundation run `41270591605` failed on the original candidate in two
independent jobs. The browser suite passed 112 cases and failed E2E-HLT-007
when Playwright could not retrieve the successful policy POST response body;
the cause is not established. The production disclosure check reported an
aborted GET with 2xx response during capture eligibility and incomplete capture.
Its finite resource class does not identify the endpoint; neither disclosure nor
its absence is established. The E2E now starts reading each matching original
policy and assessment response as soon as Playwright observes it, preserving
the status, response-body, UI and persisted-assessment assertions. This test
change does not itself prove a cause or a passing native browser journey. A
focused mocked-browser case passed with a held policy response, the editor
hidden during the write, an observed original response body, no main-frame navigation, one save, refreshed policy
and one subsequent assessment request; it does not replace the native test.
The test-only child then passed the hosted verify job in Foundation run
`41601163304`, including all 114 browser cases and E2E-HLT-007. That run's
separate production-boundary job failed SEC-AUTH-001 `loaded-details-disclosure`
with an aborted project-class GET and 2xx response during capture eligibility.
Capture was incomplete; neither its cause nor its disclosure outcome is known.
The passing browser job does not explain the earlier POST response failure or
resolve either disclosure failure, and further corrected hosted checks remain
required.

A controlled local loopback test now exercises the actual app and existing CDP
recorder rather than a mocked `page.route` response. With the published baseline
`624ba4524e88f105471e550cea7421478d2fc488`, the second project fetch carried a
signal that scope revalidation aborted. Separately, CDP correlated the marked
held coordinator request with an aborted network event and incomplete recorder
capture. In the in-progress implementation, the second fetch had no supplied
signal and the marked coordinator response was read and continued with its exact
synthetic JSON. Both local assertions passed; fetch invocation ordering alone
does not bind the signal listener to the marked CDP identity. This proves
the controlled fixture race only: it does not identify the historical hosted
request, establish all other request lifetimes or replace independent review and
fresh hosted production validation. An earlier interrupted local regression run
was invalidated by concurrent source edits; it is not passing evidence.
The strengthened fixture subsequently correlated the held response's CDP network
identity with the coordinator call site: on baseline that same request emitted
an aborted failure, while in the in-progress version the replacement scope became
ready before the old original body was read and continued. A separate synthetic
canary in that original body caused the disclosure check to fail as intended.
The baseline control and both in-progress cases passed locally. During test
development, one canary assertion was attempted after its context was closed,
and an initial correlation check ran before CDP Network events were enabled;
those test runs failed and were corrected before these passing checks. The
fixture uses development login and a separate synthetic token response, so it
does not establish real OIDC or application-token secrecy.

An additional local control deliberately aborted an original 2xx GET and the
recorder reported incomplete capture; this control and the two held-response
cases passed alongside 12 scoped-navigation and milestone regressions in one
unchanged-source run. The abort's finite diagnostic reflected CDP observing
headers before Playwright exposed a response; an earlier test assumption that
Playwright had already classified it as 2xx failed and was corrected.

An in-progress scoped-write change also suppresses an old project's denial
side effects after a scope change. A synthetic browser test delivered a held
old-project 403 and observed no list invalidation; a current-project 403 served
as a positive control and did invalidate the list. The first fixture run failed
because unrelated fixture 404s also invalidated the list, and the next failed
because generic 200 responses were not valid fixtures. The corrected fixture
uses non-denial failures for unrelated endpoints. This local test does not
establish global session or project-query fencing, and the implementation still
requires independent review and fresh hosted checks.

The in-progress read coordination reserves a logical scope before an existing
leadership resource refresh and keeps that reservation across a coalesced
replacement. It releases the logical read on cancellation while the separate
managed transport slot remains held until locally confirmed cleanup. Focused
unit tests cover admission, cancellation, held physical slots and unknown
cleanup. Synthetic dual-role browser controls observed both refreshes block a
health write, followed by a successful assessment, and observed a write start
while a deselected read's original response remained held. A separate same-view
control observed the original canceled 403 reader release without a denial
latch, and confirmed that a current 403 does latch. These controls do not prove
remote termination or disclosure-recorder completion. Whether an unstarted
leadership check may be superseded by a same-task write remains a design and
coverage question; broader policy draft continuity and global identity/project
ordering are also unresolved. The implementation is not approved for publication.

Three further synthetic actual-app loopback controls exercised a current 503,
a current 403 after a queued refresh, and a superseded 503 with its replacement
held. They observed the appropriate error, denial latch or loading state while
the original body was still open, then observed EOF and release of the same
application reader and successful explicit recovery or replacement. The dirty
403 control observed no additional milestone read before recheck; the
superseded-503 control used a positive-controlled DOM observer. These tests did
not use the disclosure recorder and do not prove its capture, global identity
behavior, remote termination or a managed-slot release. An earlier rerun did
not reach the tests because the local Vite process did not become ready; a
subsequent run of all three controls passed. A concurrent lint process had a
virtual-memory allocation failure, and a later isolated scoped lint run passed.

The two existing E2E-HLT-003 source-authority cases now start reading each
original threshold and assessment response as soon as it is observed. Their
status, content, current-human-source, threshold and unassessable assertions
remain in place; the original promises are still awaited on failure. These are
test-only changes and do not reopen the already accepted AC-HLT-003. The native
cases need a fresh isolated application/database run and exact-candidate hosted
validation; no suitable local isolated stack was verified during this run.

Local policy-editor work retains bounded in-memory drafts while the project
panel stays mounted under the same session, actor, roles and project, including
a transient identity or project check error. Fields remain hidden while checks fail. A
changed policy revision blocks submission until explicit review of the current
policy, including all current target overrides; ambiguous results retain the
draft and do not establish the outcome. Synthetic controls cover both policy
editors, changed revisions, a malformed confirmation and transient check
errors. Leaving the panel or changing selection, session, actor or roles discards
the old panel draft. These controls do not
replace the pending identity and project request-ordering work or a native
authority/revocation test.

The fixed policy callers also compare the submitted revision with the current
scoped, successfully decoded query before a write lease is acquired. A local
browser fixture mounts the actual forms, provider, fence and query client with
synthetic requests: in the same event it advances each policy cache revision
and invokes the old form, verifies the submit and admission handlers ran with
no lease or write, and then reviews and submits the retained draft with the new
revision. Current and initial-revision controls also passed. This is a UI
correctness check, not server authorization or a real network POST. An earlier
fixture run failed two cases because new button labels made selectors
ambiguous; exact selectors corrected that test error.

On the local working snapshot after the admission and decoder changes, the
combined synthetic browser suite passed 29 cases. It included the eight policy
fixture controls, the separate actual-app CDP controls and scoped/milestone
regressions. These local results do not replace exact-candidate hosted tests,
native database checks or the remaining identity-boundary implementation.

Subsequent local assessment work supersedes the earlier same-key retry design:
the server can purge both the assessment and its receipt, so retrying an unknown
dispatch could create a second assessment even with the same key. The local
fence now blocks further submissions for that owner and project until the
original current response confirms it with status 201 and a validated matching
view. An unknown outcome remains unknown after a later as-of read. This is an
in-memory browser-session safeguard, not a cross-tab, reload, other-actor, or
server-side guarantee. A server-backed reconciliation path remains to be
designed. This new local change still needs its complete independent review and
exact-candidate verification.

Two later local loopback controls use the actual app and disclosure recorder to
inspect original assessment responses. The revised fixture passed for a valid
201 followed by a second explicitly initiated command with a different key,
and for an unexpected 200 that left both controls disabled. Earlier versions
of the two-command control had incomplete recorder runs: one reported a
console-capture failure and another reported body, response and target failures.
A separate instrumented copy passed without a diagnostic event. The later pass
does not establish the cause of the earlier failures. These synthetic controls
do not establish native receipt behavior, production authorization or the
remaining held-response and identity-race cases.

An additional unregistered session/identity/project state model is under local
review. It is not connected to the application and confers no request or
server authorization. Its tests cover stale handles, selection epochs, held
identity checks, malformed input and reentrant validation. The model uses
necessary local identity-size checks for a proposed 65,536-byte response cap;
the actual transport must enforce encoded bytes before decoding. Its token
accessors are for a future trusted synchronous dispatcher, not child callbacks.
Protected request binding, cache commit ordering, exact project-target checks,
login and OIDC expiry races and real browser/hosted validation remain open.

The unwired model now also exposes its validated immutable actor only to an
exact current identity capability, and models a manager queue view, up to 25
queue IDs and a preview turn of up to five distinct rows. Queue refresh and
preview replacement require their exact current owner; navigation and identity
transitions invalidate earlier handles. The trusted navigation owner alone
may enter the queue view. These are local state primitives, not authorization,
request dispatch, physical request accounting or a substitute for the current
server checks. The existing queue accepts some identifier strings that the
stricter preview decoder cannot display; the model fails closed for those rows.
Per-request/row denial sequencing, exact endpoint binding and full application
integration remain to be designed and reviewed.

The local queue model uses fresh opaque idle owners after cancellation or
failed parsing, and exact-turn cancellation preserves a newer preview. A
separate unwired callback prototype captures fixed owners and a copied preview
batch; its child-facing callbacks cannot complete a queue response or obtain a
preview handle. The trusted owner must keep the model and completion methods
private, invalidate the exact idle or active owner on visibility/navigation
transitions, and preserve the existing physical request leases. The model can
represent an empty preview, but the existing UI does not dispatch one. These
unit-tested prototypes have no live application integration; per-request
authorization, response provenance, transport lifetime and all actual UI
callbacks still require implementation and verification.

An unwired trusted coordinator prototype now accepts a completed JSON string,
uses the existing queue presentation decoder and derives both the project labels
and a deeply frozen full queue snapshot from that same parse. It rechecks the
captured owner before installing membership. The existing decoder does not
validate every possible field; the full snapshot is not a sanitized log or an
independent source-authority proof. This prototype's 2 MiB encoded-string cap
can reject whitespace-heavy or escape-heavy inputs that the existing
post-parse cap would accept. It does not enforce a wire-byte or UTF-8 limit
before a body has been materialized. An eventual dispatcher must bind the
original request, bound and drain its response, process session-level 401s,
retain physical leases and prove the current UI and server authorization flow.

The still-unwired PM-queue transport experiment retains the existing queue
driver's coalescing rule: a refresh hides the old queue immediately, and a
superseded 403, 404 or 503 is not presented as the outcome of the replacement.
The replacement must perform its own current server-authorized read; a denial
is not evidence that a project exists or that access persists. A current,
unsuperseded queue denial reports generic unavailability before its original
body finishes. Current-session 401 handling remains independent of the queue
turn. This experiment is separate from the health project's current-denial
latch, and has not been integrated into the application. Its one physical
queue slot is intended to survive mount changes and unknown cleanup; it does
not bound other requests. Raw 2 MiB, fatal UTF-8, detached logical cancellation
and redirect-error behavior are availability changes requiring final review.

Local unit controls exercise that transport with the actual queue resource,
including synchronous invalidation of a prior queue/preview at refresh,
single-flight retention through an old held body, current 403/404 notification,
and same-session 401 expiry even when the queue turn is stale. Synthetic
browser-fixture controls use real loopback fetches and instrument the original
response to observe headers and reader acquisition before held EOF; they check
navigation, current and old-view denial, and same-token replacement-session
behavior. A separate fixture combines the actual queue resource and transport:
after a ready result it holds a superseded 403, 404 or 503, observes no
transient unavailable or error state with positively controlled observers, and
confirms the replacement is dispatched after the original reader releases.
The fixture's owner explicitly invalidates the prior operation when loading;
the production owner does not yet do so. Separate CDP-recorder controls captured and continued the original
200 and 403 bodies; a generated 403-body canary was detected. These fixtures
do not mount the product App, prove real IdP or server authorization, or
replace hosted acceptance. The synthetic recorder token response is separate
from the fixture bearer; it does not test credential discovery for that bearer.
The one-slot transport exposes capacity-change notifications to its trusted
owner, but the owner must recheck admission and must not automatically retry
while an indeterminate slot remains occupied. Local stream termination is not
evidence of disclosure capture or remote completion.

During local implementation, the architecture check rejected runtime imports
from the domain workspace in web code. The candidate now uses local web
decoders and type-only domain imports; the architecture check passed afterward.
Representative decoder and UUID/role parity tests ran against the current
domain source with the lockfile-pinned Zod version. These tests cover ordinary
JSON boundaries and selected hostile-object cases, not exhaustive parity or
isolation from arbitrary executing JavaScript.

Local SEC-AUTH-001 integration work now binds protected request callbacks to
the issuing in-memory token and session generation. A stale callback cannot
normally borrow a later session's token, including when token text is reused;
late unavailable callbacks are gated and stale successful or failed results
are rejected. The request checks session and scoped eligibility after preparing
request options, and reports a managed read terminated when preparation fails
before dispatch. The PM queue and leadership blocker drivers capture their
issuing request; the blocker view is also keyed by session. A header-eligible
project denial may invalidate the session-wide project list after its own
scoped ticket is revoked, provided the issuing session is still current.
The project-list query is additionally keyed by session generation, and
protected fetches request no HTTP cache storage or reuse. This changes caching
behavior and requires full integration review. In an actual-App synthetic
loopback test, a replacement login using the same bearer received and displayed
its own list while the earlier response was held; the old 401 was then consumed
and did not expire the replacement. A current-session 401 expired the session.
The test calibrates transient login detection and verifies both list bearers.
Before adding no-store, the fixture saw two fetch invocations but only one
server arrival; the precise cause was not established. The fixture also
exercised old 200, 403 and 404 responses and checked for transient old project
data with calibrated insertion and text-mutation observers. Headers and bodies
were delivered together, so these tests do not establish header-before-EOF or
disclosure-recorder behavior.

These measures do not establish the full application session boundary: shared
identity and project issuance, OIDC events, navigation and post-await UI/cache
effects still need integration and tests. The new physical queue transport is
not connected to the product owner. Pre-dispatch logical guards depend on
trusted, non-reentrant scope predicates, and an unsent health write can still
be conservatively marked uncertain. Additional current-code browser coverage
must exercise same-token replacement for other resources and held-body cases,
denial callbacks, read cleanup and scoped write admission before a reviewed
candidate can be published. The eight existing held-response controls were
repeated after the project-list cache changes; the eventual candidate still
needs its own validation.

Further local SEC-AUTH-001 work qualifies global identity queries by session
and selected-project queries by session, selection, retry attempt and identity
issuance. Current
global `/me` 403/404 responses terminate the issuing session at headers; the
separate health coordinator's identity check is not yet integrated into the
same authority. The selected-project check latches its own 403/404 before body
drain, closes scoped requests, hides the selected subtree and offers an explicit
new-attempt retry. A current identity and project success, both idle, are needed
to admit selected-subtree requests. Retained project drafts remain mounted and
hidden through ordinary revalidation or transient error; a real project denial,
session, actor, role, selection or explicit retry transition may remount them.

Evidence resources use per-admission and per-owner tokens so stale refreshes or
completions cannot borrow a later view. Current evidence is rechecked on
readmission while same-owner retained values keep hidden draft owners mounted.
Nested source and reconciliation actions are bound to their immediate resource
proof. Reporting-policy reads use admission-scoped caches, preserve dirty drafts
on revalidation and require explicit discard when the saved revision changes.
The policy presentation decoder has selected parity tests against the domain
schema, not an exhaustive equivalence proof. Confirmed policy responses must be
HTTP 200 and match the submitted values and next revision; a newer local cache
revision is not overwritten. Source-access confirmation uses the endpoint's
HTTP 200 source-ID and next-revision receipt, which does not echo reader/state
values.

The local policy and source write registries retain unresolved outcomes across
SPA navigation and actor changes for the same resource. They are bounded,
in-memory page-instance guards, not server receipts or cross-tab/reload locks;
they conservatively block on some pre-dispatch failures and definitive rejection
statuses as well as truly uncertain outcomes. The source key is a normalized
project/source UUID-shaped pair; the policy key is a normalized customer/project
pair. Other evidence write forms have only mounted-component uncertainty
handling and need their own durable/reconciliation design. The source write
guard does not establish whether an unseen external write committed.

Synthetic browser controls cover current global identity 403/404 before held
EOF, A→B→A selection, same-token old responses, held selected-project 200 and
403/404 with explicit retry, evidence and policy draft retention, stale evidence
refresh ownership, and selected unconfirmed policy/source write outcomes. These
tests do not establish real IdP or backend authorization, arbitrary delayed UI
effects, cross-tab behavior, or a complete disclosure-recorder result. Native
database-backed tests, app-wide identity and OIDC admission, nonselected queue
capabilities, current source-specific and reconciliation command races, exact
candidate review and hosted/postmerge checks remain open.

Health and reassessment callbacks also reject a captured global identity
issuance after a new global identity check begins. A loopback control observes
same-actor identity and project reads following a focus transition and then a
successful reassessment read; it does not sequence the health coordinator's
separate identity check or prove all scheduler interleavings.

Both global and health `/me` reads now require HTTP 200 and validate their
bounded identity body against the wire shape before accepting it. Invalid
identity content is unavailable, not a denial; each consumer rechecks its own
issuance after parsing. Synthetic Vite browser controls exercise malformed
roles, keys, UUID, JSON, unexpected 201/204 and multibyte oversize responses,
then a valid retry. Oversize cancellation does not establish complete body or
disclosure-recorder capture. The global check and health check still have
separate ownership; these controls do not close all global protected views.

Selected-project checks wait for the current successful identity, check its
issuance at dispatch and completion, and require HTTP 200 and the selected ID.
The hidden project draft owner is separate from the query cache and is retained
only for the same session, selection, retry attempt and actor/roles. A project
denial remains latched through a same-actor identity check and is cleared on a
verified actor change. A session-owned account retry recovers from an identity
error without clearing the project denial. Synthetic browser tests cover a
same-session actor change, sticky denial and recovery, A→B→A, and same-actor
draft retention; they do not prove every scheduler interleaving or late body.

The next identity-boundary integration must qualify other protected caches by
identity ownership, fence requests and later callbacks, retain drafts only for
the same verified principal, and keep retry and sign-out usable while checks
fail. The nonselected project queue needs its own identity-scoped owner.
OIDC callback and expiry ownership, asynchronous writes and cache publication
timing remain separate requirements.

Local follow-on work binds the project list and project setup to the current
session and verified identity issuance, and gives each read its own issuance.
Old list actions and creation callbacks are fenced as soon as identity checking
starts. List and setup reads require HTTP 200 and bounded, validated bodies;
their respective 16 MiB and 8 MiB limits can make otherwise valid responses
unavailable because the API contract does not promise those byte limits. The
setup decoder has representative domain-schema parity checks, not exhaustive
equivalence. Synthetic browser cases cover both list/setup completion orders,
malformed and oversized responses, unavailable states and explicit retries.
They do not prove every delayed body, scheduler interleaving or recorder result.

Creation drafts for the same verified owner survive identity and setup checks;
changed owners do not inherit them. Review, selection and asynchronous digest
preparation have separate synchronous invalidation fences. Page-instance write
guards retain bounded hashes and idempotency keys for unresolved project and
programme commands; an exact same-owner, same-key and byte-identical command
can be replayed. These guards are neither durable across reloads nor shared
across tabs, and a form reopened after navigation cannot reconstruct its old
command. They can also conservatively block a command that was never sent.
A confirmed programme receipt can retain its exact selection when a newly
authorized truncated setup omits it; an untruncated omission remains unavailable.
The synthetic replay tests establish the client request and UI behavior, not
backend commit or deduplication.

The queue and preview receive identity-bound request functions. A synchronous
view revision and per-publication proof fence queue actions through navigation,
refresh and React-batched return to an earlier view. A current queue project
must be in the accepted decoded observation, and preview opening checks the
current row, category and request. These checks do not establish server
authorization. The queue uses one page-lifetime physical read slot, a 2 MiB
response limit and logical invalidation without forwarding its signal to the
original fetch. A capacity waiter rechecks the current driver after physical
release and driver settlement; unknown cleanup keeps the slot occupied.

Preview reads use a separate two-slot page-lifetime registry and an exact
batch/page lease, retaining original responses across logical invalidation.
An operation captures the current queue proof, turn, signal, up to five project
IDs and its exact allowed endpoint/cursor paths; each path can be attempted once
and a new operation requires a new signal. Current denials hide the affected
preview at headers; issuing-session 401 remains independent of stale scoped
ownership. The adapter requires HTTP 200 and caps response bodies at 65,536
bytes. Both byte caps are availability restrictions, not API size guarantees.
Unknown cleanup can permanently occupy a slot in the current document, and
retry may remain unavailable while previous originals are still being handled.

Synthetic actual-App tests cover held queue and preview originals, same-task
stale queue actions, current versus stale denial and same-token session
replacement, EOF/release ordering, a fresh preview page/action, and a 15-second
preview timeout followed by original completion and explicit retry. They do not prove
server authorization, complete response-recorder capture, every scheduling or
wake ordering, or complete timeout and indeterminate-cleanup behavior. The
prepared protected queue transport and session model remain unwired. Full
candidate review, isolated native
database and browser validation, hosted checks and postmerge evidence remain
required.

The local update-invitation view now retains drafts only for the same session,
verified actor/roles, locator and view owner. It hides them during identity or
invitation revalidation, requires a fresh identity-qualified invitation read,
and fences captured edits and submits to that read. Current 403/404 responses
hide the view at headers and clear that owner's invitation cache; explicit
retry starts a new attempt while an old original can still drain. An expiry
timer is owned by the retained principal and locator rather than a transient
identity issuance; it keeps the earliest validated deadline, clears the draft
and that owner's cached invitations at expiry, and rechecks time on actions.
Invitation reads use eight page-lifetime managed slots and an 8 MiB body limit;
an indeterminate cleanup keeps its slot, and the byte limit can reject a valid
response because it is not a published API maximum. The local decoder has
representative schema parity tests, not an exhaustive equivalence proof.

An invitation response uses a synchronous submission guard and a separate
page-instance bounded registry for pending and uncertain writes. It retains an
idempotency key and a hash rather than response text, allows a freshly authorized
same-subject exact replay, and blocks a different response while an earlier
outcome is unconfirmed. The guard is not durable across reloads or shared across
tabs; leaving the retained draft owner can make the earlier command impossible
to reconstruct in this UI. Confirmation requires HTTP 201 and a bounded receipt
matching the captured request ID; a failed later refresh does not undo a
confirmed response. Local synthetic browser controls cover issuance-time stale
submit, same/different actor drafts, held old read and write, same-key retry,
wrong status or receipt, expiry and StrictMode replay/cache cleanup. These do
not establish real backend replay, server authorization, full recorder capture
or all lifecycle interleavings.

The local Platform view now binds status, operation history and access actions
to the current identity and view. A synchronous draft revision prevents an old
form from submitting values from an earlier render. Grant and revoke have no
idempotency receipt, so the page-instance guard leaves an unconfirmed target
blocked rather than repeating the write; a successful original HTTP 204 is
needed to release it. This guard is not a server authorization check or a
cross-tab lock. Synthetic browser controls cover stale submits, same-task edit
and submit, a held 204 after an actor change, and current denials at headers.

For FR-CON-006/007 and SEC-AUTH-001, the local CSV view uses current identity,
project-list, source-list, rendered mapping and receipt proofs. Dirty mappings
cannot be used for upload or review, and a preview from an earlier source
revision remains historical until a fresh preview is created. Configuration
writes have no safe replay; an unconfirmed write remains blocked, and a
confirmed write requires a fresh authorized source snapshot before further
source work. Preview and reviewed-import commands share a bounded page-instance
source guard. An uncertain command retains its original subject, key, source
revisions, SHA-256 fingerprint and, for review, parent and selected ordinals.
Preview preparation snapshots at most 1 MiB of CSV bytes and sends that same
snapshot; the bytes are not retained in the registry. Only the original
subject can retry an exact command after current authorization and revision
checks. A review retry rereads and validates its parent; a redacted parent may
still support replay of an already stored receipt, while the server remains
responsible for rejecting an invalid new commit.

Confirmed import metadata stays fenced until a current authorized receipt read
validates the source, original subject, receipt kind, revisions, count and
reviewed parent ordinals. A failed read is retried as a read, not as a new
import. Receipt denials are scoped to the receipt and act at headers; managed
originals remain owned through terminal cleanup. Source and receipt reads each
have eight page-instance physical slots and an 8 MiB response limit. Receipt
tickets are separately bounded and reserved before an import; an indeterminate
original may permanently consume physical capacity in that document. The local
source and receipt decoders have representative parity and adversarial tests;
their size and date limits can reject a valid response and are not API bounds.

These guards do not survive a page reload, coordinate other tabs or operators,
or establish safe replay after database restore or rollback. The receipt API
does not provide a content-expiry deadline, so an already displayed proposal is
rechecked on admission but is not automatically purged at the instant its
retention expires during an uninterrupted view. The source remains proposals:
review does not publish canonical facts. The local data-layer correction emits
null identity for an invalid row that has no persisted record type; its native
database test, including authorization and recovery evidence, remains required.
Synthetic tests do not establish real backend deduplication or authorization,
complete disclosure-recorder capture, every pre-commit scheduling interleaving,
or restore behavior. Independent review of the immutable candidate, full
validation, hosted checks, merge and postmerge evidence remain open.

### PR #164 production-boundary failure and bounded diagnostics

Reviewed candidate `e6c75de86419faad35cc1f9bba182833a2f42323` was published in
[PR #164](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/164).
Documentation workflow `41967472776` passed. Foundation workflow `41967472872`
passed its native integration and recovery steps, but its production-boundary
job `127047702212` failed at the first post-login disclosure checkpoint. The
reported recorder counters show two failed tracked requests; the job log does
not identify their resource, response or failure category, or establish the
cause. A cancelled navigation, an interrupted response or another transport
failure are hypotheses only. The Foundation browser workflow finished with
276 passing and 17 failing tests. The failures include milestone draft
retention, receipt-capacity synchronization, preview and queue lifecycle tests,
source-access journeys, reporting-policy journeys, and disclosure checks.
Their individual causes require evidence; the full Foundation and
production-boundary acceptance remain required.

A follow-up adds only finite, allowlisted request categories to the existing
sanitized diagnostic and emits it when that first checkpoint or a Foundation
browser disclosure checkpoint fails. It keeps
the original error, request accounting, response capture and fail-closed
acceptance requirements. It does not authorize retrieving Original19/20
artifacts or rerunning those stopped captures. No failure is classified as
resolved, and no story, criterion or release hold is accepted by this record.

The separate local follow-up retains a same-owner milestone draft while a
current access check hides the view, and rejects a stale edit callback. Focused
synthetic browser tests cover the retained draft and current edit, selection
and identity changes. A synchronized 64-receipt denied-capacity test verifies
that retry does not repeat the reviewed write until the imports view is
reopened, and then submits the exact original selection. Queue and preview
tests observe the original response reaching EOF and releasing its reader
before replacement work. These are local synthetic checks, not evidence of a
successful hosted rerun, database authorization, or final release acceptance.

The source-access save receipt must report a strictly newer revision for the
same source; reader triggers can advance that revision more than once. A
confirmed receipt still causes a fresh authorized history read before content
is shown. Synthetic browser checks cover a larger revision jump and reject a
wrong-source receipt; the strengthened real-database journey remains to run.
The initial reporting-policy form also stays disabled until its current policy
has populated the draft, including the no-policy case. Focused synthetic
browser checks cover both initial responses.
