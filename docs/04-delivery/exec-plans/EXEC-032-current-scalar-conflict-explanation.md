# EXEC-032: Current scalar disagreement explanation

Status: Independently reviewed candidate merged in PR #126 after its candidate
checks passed; post-merge Foundation and Documentation passed. No acceptance is claimed. This possible partial increment supports FR-QA-004/005/007/012
and FR-EVD-004. It is groundwork related to FR-QA-007, not the registered
GOLDEN-003 sheet-versus-Jira milestone scenario. It depends on the existing
source-authority evaluator, scoped fact catalogue and scalar reconciliation
workflow. PR #125's verified merged tree is the source-equivalent local base;
its actual post-merge Foundation and Documentation checks passed. It does not complete
GOLDEN-003, general Q&A, AC-QA-005, AC-EVD-004, STORY-012/027/028/029 or any
issue or release hold. OD-013/014 and the stop on Original19/20 capture remain.

## Scope and semantics

A leadership reader may select one fact already visible in its authorized,
bounded project fact catalogue and request a current explanation of a narrow,
fully proven scalar source disagreement. Unlike a cross-object milestone
contradiction, each position is a value of the same fact. Show both or all
material conflicting values and their individual authorized source/version/
evidence associations; never select one as settled. This is a read-only
observation, not a new or completed reconciliation request, an approval or an
external write. The pre-existing PM scalar reconciliation workflow remains
responsible for its own authorized durable request.

Do not call the saved-assessment or scalar-reconciliation capture path for a
GET: those paths write assessments, audit and possibly conflict/request rows.
Use a new transaction-owned read-only loader and the existing pure resolver,
not a second authority algorithm. The historical result's mode or saved proof
alone does not establish current access. Failure to prove visibility, source
permissions, integrity, boundedness or semantics must withhold the entire
result; do not return a partial set of conflicting positions or hidden IDs,
counts, values or labels. A `NOT_DETECTED` result is not initially proposed:
this feature may return an explanation only for a proven conflict and otherwise
one generic unavailable result. No source origin, Jira/sheet association, human
presence or model conclusion may be invented from opaque IDs or input labels.

## Authorization and supported-writer coordination

Require authentication, leadership in the current token and a same-customer
positive leadership grant at the project or current portfolio scope. Acquire the
same-customer Project SHARE and all matching project/portfolio grant rows SHARE
in one deterministic ID order, intersect token roles, and retain them through
full response validation and commit. Reuse or carefully reproduce the existing
fact catalogue's scoped visible-fact identity contract in that same transaction;
project/fact denial, nonexistent, malformed, cross-project or hidden selection
must have a uniform generic 404. The first version revalidates membership in the
first page of 50 project facts, ordered by fact type with a 51st row used only
to indicate truncation; the UI offers only that freshly loaded page. It does not
claim to prove what the browser previously displayed, and it does not accept a
caller-supplied cursor or limit. Fact catalogue entries are project-authorized
metadata, not proof that their sources are readable. Do not open a nested transaction or allow the
caller to provide a policy, source proof, customer, reader, clock or decision.
The exact fact-catalogue paging and visibility behavior must be checked before
using a fact ID as an externally distinguishable target; no hidden-fact oracle.
Once a target already visible in the approved bounded catalogue is established,
all other incomplete/unavailable states map to one generic 503. Pre-visibility
query/timeout failures use the same 404 concealment boundary.

Hold Project SHARE, not fact/policy/source/access row locks that might deadlock
with supported writers that acquire a tuple lock before their Project trigger.
Verify the current writer and trigger protocol for fact append/birth, authority
revision, source access/readers, conflicts, and grant change, including the first
insert case. Document that arbitrary privileged SQL and disabled triggers are
outside this guarantee. Use an 8-second statement timeout, 3-second lock timeout,
5-second transaction acquisition wait and 20-second transaction timeout; obtain a
single database millisecond clock after coordination. Load a complete bounded
version/conflict/policy/source prefix, including every unselected, superseded or
stale version. Check AVAILABLE and the current subject's reader for every source
before any successful output, including when a version is not a displayed
contributor. A scope grant is not a source grant.

Static writer review found project coordination in supported fact birth,
append, source birth/access/reader, policy revision and conflict paths, including
atomic RAID reopen. Health assessment starts with Project SHARE and can later
insert a conflict whose trigger upgrades to Project UPDATE; the reader must never
upgrade or take later fact/source/policy tuple locks. Grant mutations do not take
Project: existing matching grants are protected by retained ordered grant SHARE,
while an absent first insert has no row to lock. Require a positive grant from the
single locked query and never rescan or upgrade it; a concurrent first insert can
be visible on a later read. An unattached evidence insert alone is not project-
gated, but enters the assessed prefix only through a project-gated version insert.
Seed/restore maintenance and arbitrary privileged cross-table SQL are outside this
guarantee. Confirm these claims with native blocker-PID tests, including a
modeled health-style SHARE-to-conflict-insert upgrade and both orders of first
insertion. That original model does not exercise the full health-assessment
workflow; the later PR #129 test below exercises the real health writer.

## Conservative initial candidate

The authority resolver can report recorded unresolved conflicts, same-tier
`AUTHORITY_DISAGREEMENT`, or `HIGHER_AUTHORITY_CONTRADICTION` involving a
higher source that may be stale or have unknown validity. These have different
temporal meanings. Initially emit only one complete, fully authorized current
same-tier `AUTHORITY_DISAGREEMENT` with at least two distinct selected date values.
The group's exact version IDs must equal the resolver's `candidateVersionIds`;
map every candidate to its stored source and evidence. All contributors must be
selected, APPLICABLE, trusted and CURRENT at the same database clock, with the
applicable policy's approval requirement satisfied. `NOT_REQUIRED` is an internal
no-approval-needed marker, not evidence of human approval. `CONFLICTING` alone is insufficient: it takes precedence
over temporal ambiguity, so check applicability explicitly. Reject all higher
authority contradiction groups, ambiguous streams and any unresolved recorded
edge whose endpoints are not both in that exact selected current group. Allow
recorded edges within that group only after verifying their stored identities and
the full group; never describe the historical edge as a separate current fact.
This supports the same disagreement before and after a separate PM capture, while
withholding cases that require a historical or mixed-validity explanation.

Initially support date-valued facts only, using the existing canonical calendar
date validator, and require a finite, non-null resolver-adjusted expiry for every
contributor. A finite explicit deadline can coexist with an UNTIL_SUPERSEDED
selector; allow it without claiming a selector mode. Withhold cases without a
finite adjusted expiry, and text, numbers, booleans and mixed types rather than
inventing an expiry or coercing values. Equality at expiry is stale. This avoids introducing arbitrary source text or OD-014 content in
this increment. Return a strict bounded envelope with project/fact IDs, fact
type, database `asOf`, selected policy revision and one position per distinct
date; each position contains all associated selected version/evidence/source
tuples, stored provenance and effective/observed/adjusted-expiry instants.
Preserve individual provenance and times rather than collapsing agreeing sources.
All IDs, date/instant formats, policy/fact/source associations and uniqueness are
validated; enforce at most 1,000 total versions, conflict rows, sources and
displayed support tuples, at most 64,000 derived references, and at most 262,144
UTF-8 JSON bytes. Preflight nested counts before traversal; statement and
transaction timeouts bound query duration, not physical rows scanned.

Factor the pure pre-augmentation snapshot/resolver phase from the existing
transaction-owned authority preparation, preserving the original capture path's
behavior and tests. The current preparation creates random in-memory conflict
rows before resolving a second time; this read must evaluate the actual stored
prefix without creating or serializing synthetic IDs. It must not persist an
assessment, conflict, audit or request. Recheck after factoring against the
existing capture on equivalent snapshots and reject unexpected stored groups or
associations rather than silently dropping them.

Question whether existing persisted scalar conflict rows are sufficient proof
of a current dispute when their contributors are superseded or stale. If not,
refuse those results rather than silently omitting them or describing them as
current. A full historical conflict explanation needs its own timestamp and
retention contract. Until a supported connector-to-fact provenance path exists,
synthetic or manually entered statements must not be described as live Jira or
sheet observations, and reviewed spreadsheet rows remain proposals. Never load
or retain Jira comment bodies or authors under OD-014. Any future text-valued scope
must render plain text, enforce size/encoding bounds and keep them out of
logs, URLs, prompts and error bodies; no model or instructions from evidence are
executed.

## Required design and evidence gates

Before coding, independent reviewers must recheck the fixed first-page target
rule, date-only response, conflict grouping and pure pre-augmentation seam, as
well as current catalogue/source-access policies, supported writer locks and
provenance/retention behavior. Tests must
cover independent values with exact associations and candidate IDs before and
after separate PM capture (allowing distinct observation times), more than two
sources, until-superseded date facts with and without finite explicit deadlines,
unsupported and mixed value types, first-page 50/51 membership and 404s,
multiple conflict classes, stale or superseded contributors, disagreement plus
unrelated recorded conflict, all-version access revocation, cross-tenant and
guessed IDs, grant/source/fact/policy/conflict write races in both orders with
actual PostgreSQL blocker PIDs including both orders of first inserts, bounded
prefix and response overflow, no-write scoped snapshots/proxy, role-switched API
and browser session/selection races. The fact selector and answer must disappear
or invalidate on identity, project or session change, role/refetch/error,
catalogue refresh/failure, fact switch or input change. Focus/visibility return
and explicit refresh clear old evidence before reauthorization; abort-resistant
late responses must not restore it.
Use a qualified disposable synthetic database, not the default local database.
Document that SET LOCAL ROLE and owner-writer tests do not prove a separately
authenticated production login or arbitrary privileged SQL behavior. Compare
with the pure resolver and existing durable scalar reconciliation on controlled
equivalent snapshots without mutating the read path. Validate result text as
plain text and reject injection/HTML as instructions, not as a reason to invent
an answer. Preserve failed attempts and obtain independent exact-tree review,
full hosted checks, expected-head merge, actual merge verification and post-merge
evidence before acceptance decisions.

## In-progress local evidence

Independent design/source/coverage reviews confirmed the pre-augmentation seam,
the first-page boundary and supported-writer coordination, with the qualifications
above. Their early code review identified and prompted removal of a browser
runtime-domain import and a JavaScript ordering assertion incompatible with
database collations; it also identified that ambiguous and mixed-type nonselected
streams must be withheld. Local domain, data, API and web type checks, the
architecture boundary check, nine mocked reader tests, four schema/decoder tests,
two focused API tests, the 17-test shared API contract suite and mocked Chromium journeys for the scalar and existing milestone
panels have passed. A first reader test
incorrectly expected a stale nonselected agreeing source to suppress an otherwise
complete current disagreement; it failed and was corrected to expire the sole
source of one position, consistent with the approved selected-current semantics.
An independent exact-tree review found the shared API route-coverage harness had
not yet included the new endpoint; the fixture and successful authenticated
contract request were added, and that complete local harness then passed.
The PR #126 health lock upgrade was modeled and did not execute the complete
health workflow. The expanded mocked browser journey also covers project switching and
identity role removal. The published candidate passed independent exact-tree and
remote tree/parent/file-set reviews. Documentation 40955269546 passed; Foundation
40955269273 passed 266 native cases in 19 files, synthetic 85-table recovery,
58 browser tests and the production-boundary job. Actual merge
`3c59ea981c023b76af9e2bd535e7d22fefe96d8f` has reviewed tree
`46304a87178fccf786d0ba288cfedba527c68f99` and ordered parents
`b5b438fb0e5ffaee4b743dacdd2d53c55cbb42ec` and reviewed head
`58d1ec3c5750864268ae9c4ca84579422d14ef5f`. Post-merge Foundation 40959136424
and Documentation 40959136440 passed, including packaged runtime and distribution
evidence. Native readers use `SET LOCAL ROLE pdaa_api`, writers use the setup/owner
connection and no-write claims cover the specified snapshots and proxy; this is
not a separately authenticated production database login or proof about arbitrary
SELECT functions. General Q&A and GOLDEN-003 evidence remain incomplete. These
results do not accept any story, criterion, issue or release hold.

## Subsequent real health-writer concurrency evidence

[PR #129](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/129)
adds a native test using `DatabaseHealthAssessmentRepository.create` and the
role-switched scalar reader against the same synthetic opened-at conflict. It
observes the database blocker in both lock orders and checks the exact recorded
conflict, policy, source/evidence/version associations and health result. The
health writer uses the setup/owner connection; the reader uses
`SET LOCAL ROLE pdaa_api`. This is not a separately authenticated API database
login, an HTTP journey, or proof for arbitrary privileged SQL.

The reviewed published head `8e5be2ecedc8e6764515ae37b475d0918364116b` has
tree `538f9174158e7043759ddd9daeed465724cb5610` and sole parent
`77dc781a2ee1a355cafec2a0753e401b5c032101`. GitHub's synthetic merge
`14bdb6a45493ab7f338b89f60c01320b1842256a` passed Foundation 40974732508,
including the new test. Actual merge `87274123880b84b63450ed4e3da2c42885e5522a`
has that tree and ordered parents `77dc781a2ee1a355cafec2a0753e401b5c032101`
and the reviewed head. Post-merge Foundation 40977661194 and Documentation
40977661313 passed, and the new test ran successfully again on the merged tree.
This evidence does not change any acceptance or release-hold decision.
