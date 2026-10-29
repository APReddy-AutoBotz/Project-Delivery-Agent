# EXEC-026: Assigned-project action queue

Status: Merged partial increment; Issue #11 and story acceptance remain open.
Requirements: FR-ADV-001/002/006/007/008, FR-RPT-002, NFR-SEC-001,
NFR-REL-003, BR-013. Issue #11; AC-ADV-001/002/003/004/005 and AC-RPT-003
remain open. Base: verified main `eaa90cf3f521718f8ee6609ddabe85624e21f850`.

## Goal and boundaries

Advance the PM action queue by presenting current, authorized schedule and
update-information suggestions across the PM's assigned projects, with
deterministic review ordering and the evidence and rules already provided by
the two merged project-level readers. This is one increment toward the full
queue: approvals, blocker-specific recommendations and other unsupported
categories must be labeled unavailable, never described as zero or clear. Do
not claim AC-ADV-002 or a story complete. Keep Original19/20 capture stopped,
public Jira activation and comment reading disabled under OD-013/014, and
spreadsheet imports as proposals. No external action, migration, or new runtime
dependency is planned.

## Authorization, consistency and bounds under review

The endpoint accepts no project IDs or actor/evidence/time inputs. The server
derives customer, subject and PM role from authenticated identity. It discovers
unique project IDs using a current scoped `project_manager` grant plus exact
`PROJECT_MANAGER` responsibility in a canonical project. Discovery is ordered by
project ID and reads at most 26 unique candidates; 26 means a generic unavailable
result, not truncation. A missing token PM role is denied. Any candidate whose
canonical project is unsealed fails the entire request instead of being silently
omitted. Use same-customer Project and CanonicalProject, an `EXISTS` responsibility
for the authenticated subject and role, and an `EXISTS` matching same-customer
project or portfolio PM grant. Multiple assigned PMs are allowed; overlapping
grants must not duplicate projects before the limit. No general project-list
output establishes this intersection. The responsibility's enforced composite
foreign key requires a canonical parent; disabled constraints or privileged
database corruption are outside the supported writer protocol.

Use one bounded ReadCommitted transaction. Discover the candidate set, lock
each candidate Project row `FOR SHARE` in deterministic ID order, then call
transaction-owned versions of the existing schedule and update readers without
nested transactions. After the project locks and before either facet, lock and
recheck a current qualifying PM grant for each project and the sealed exact-subject
responsibility; retain those grant locks through commit and reject a facet whose
audience is not `project_manager`, including dual-role leadership fallback.
Preserve the readers' exact authorization, source visibility,
policy, capacity, error and as-of behavior; hold the relevant locks until the
materialized response commits. Re-enumerate the candidate set in a fresh final
statement and fail the entire response generically on membership change,
overflow, denial, incomplete or unavailable inputs. A concurrent insertion of
a qualifying grant after that statement can change the next result; an uncommitted
phantom or transient remove-and-readd may also escape equality. This is a bounded
observation, not a promise of a complete current list or instantaneous revocation.
Do not claim a single simultaneous data snapshot: each facet retains its own
database as-of time. The design relies on the supported project-lock protocols
of the existing readers and their writers, not on arbitrary privileged SQL.
The schedule reader retains its shared per-project advisory policy lock;
supported schedule-policy writers take the same key exclusively. AccessGrant
writers do not lock Project, so qualifying grant rows are locked separately;
new grants remain phantoms handled by the final membership check. Supported
fact, source-reader and authority writers acquire Project first; sealed
canonical children are immutable. Independently review their actual triggers,
permissions and multi-project lock order, then verify them natively.
If one transaction cannot safely preserve those properties, withhold it until a
reviewed alternative is implemented.

Review ordering is a new explicit versioned presentation policy, not measured
delivery severity or the time a concern began. Preserve each underlying
category, source rule and as-of time. Do not substitute unavailable observations
with empty arrays, truncate the queue, infer a complete approval list or label a
person at fault. Establish a total response/item budget and fail closed on
overflow. The existing schedule-only view does not establish source authority;
keep that limitation visible alongside its suggestions. Revalidate the
session-scoped browser state on refresh and visibility return, discard late
responses after session changes, and never retain stale content as a fallback.
The browser keeps the enforced type-only domain boundary: a local presentation
decoder checks rendered fields, completeness and order of pointers, and the
declared coverage before showing a response. It is not an authorization or full
domain validator; the API's response interceptor validates the domain contract
and the transaction-owned readers enforce current source access.

## Verification and recovery

Independent design, source and coverage reviews are required. Exercise exact
grant and assignment intersection, multiple grants without duplicate projects,
overflow, hidden and cross-customer projects, dual-role fallback, source-reader
revocation, grant deletion, additions during discovery, lock waits, failed reads,
ordering, empty versus unconfigured data, no business writes, and browser
scope/late-response behavior. Run repository build/lint/typecheck/unit and
applicable native/API/browser checks against a separately qualified isolated
target. Review the exact candidate SHA, required hosted CI, expected-head merge,
actual merge tree and post-merge checks before updating acceptance evidence.
Reverting the increment removes the reader and presentation; no business data
rollback is expected.

## Verified merged evidence

The exact reviewed PR #120 head `04a2c52c7dfb6a5a35f53b2f934ad9b26442e9c1`
has tree `72acdfa2e88374f139880efb41ca4c5f85559b35`. Independent source and
boundary reviews covered the final queue and the API-contract test correction.
Head-associated PR [Foundation 40913488026](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40913488026)
and [Documentation 40913488021](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40913488021)
passed using synthetic merge `c35d294e7763524cc88a7f51ac555ee9cb22b62c`;
its ordered parents are the base and reviewed head, and its tree equals the
reviewed tree. Foundation included 1,966 non-integration tests in 118 files,
236 tests in 18 database-integration files, 48 browser tests, recovery and
production-boundary checks.
The initial candidate Foundation 40912651584 failed because the exhaustive API
contract test did not list the new route; the final candidate added that route
and a real success request without weakening route equality.

Merge `d1f52f45da30925752095784aab0b91d5ece5bab` has ordered parents
`eaa90cf3f521718f8ee6609ddabe85624e21f850` and the reviewed head, and the same
reviewed tree. Actual post-merge [Foundation 40918133860](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40918133860)
and [Documentation 40918134190](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/40918134190)
passed on that merge SHA.

Native fixtures use a disposable hosted database with `SET LOCAL ROLE pdaa_api`;
they cover assigned-project and grant intersection, populated customer isolation,
dual-role fallback, the 25/26 project limit, source-reader revocation in both
observed lock orders, grant deletion/insertion and an unsealed candidate visible
in its creating transaction. Their no-write count assertions cover audit events
and health assessments only. They do not establish a separate authenticated API
login, all possible membership or policy races, or unchanged contents of every
business table. The browser journey uses mocked API responses to exercise refresh,
visibility and late-session response handling. Schedule output does not assess
source authority; in the PR #120 merge, approvals, blocker-age and other
categories are unavailable.
This is partial queue groundwork, not acceptance of AC-ADV-002, Issue #11, any
story or a release hold. Original19/20 capture remains stopped.
