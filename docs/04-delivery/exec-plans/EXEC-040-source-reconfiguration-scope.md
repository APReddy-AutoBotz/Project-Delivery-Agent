# EXEC-040: Authorize both sides of source reconfiguration

Status: implementation in progress; not accepted. FR-CON-002/006/007,
FR-EVD-009, NFR-SEC-001/004/005 and Issue #7. This integration candidate is
based on PR #137 head `26bee0f6994da285d5c3f70e37e46c234d35f2bc`, whose hosted
production-boundary failed in run `41196254183`; its other checks remain pending
at this checkpoint. PR #136 merged as
`2c70ab888af026d18565804a68b371d32ec02904`; its post-merge Docs and production
jobs passed, while Foundation verify failed during the fresh role-bootstrap
check. The documented PR #137 work addresses that failure and subsequent
capture-test failures without assigning an unproven root cause. Reconcile the
actual accepted base and verify its gates before merge. Original19/20 capture
stays stopped; OD-013/014 and proposal-only spreadsheet imports remain
unchanged.

## Problem and scope

Existing `configure` holds the source row, but authorizes the requested projects
and prior Jira sync-grant projects, not all projects in the current sealed
configuration. A non-Jira or CSV source can have no sync-grant rows. A
same-customer PMO with a current grant only for project B who knows project A's
source UUID, source type and origin may replace A's configuration with B,
removing A's current reader scope and fencing its cursor. Independent static
reviews confirmed this path; execution has not yet reproduced it. Do not infer
that the actor can read A's prior content from this finding.

Require a current token-compatible PMO grant for every project affected by an
existing-source reconfiguration: the old sealed scope, requested new scope and
the existing sync-grant projects whose state the operation may change. Reject
missing, malformed or unsealed old configuration before mutation. An unknown
source is a distinct first-create path, which still requires authorization on
the requested scope. Check the existing immutable source binding only after
authorization so a caller outside its scope is not given a type/origin oracle.
Do not narrow source-reader rules for proposal content, enable publication,
change customer identity or weaken current denial behavior.

## Candidate implementation and native boundary

Load and validate the current sealed configuration while holding the existing
source lock, combine its project IDs with requested and **all** historical
sync-grant projects, then lock and authorize the complete deduplicated set in
deterministic order before writes. Keep the existing conservative requirement
for even inactive historical grants; do not truncate history. The existing
100-project limit remains on each configuration, but no fixed union limit is
applied to configuration changes, because immutable history can accumulate.
This intentionally permits some previously denied large unions. The single
project-lock query followed by the single grant-lock query preserves the
helper's existing project-before-grant ordering, and indexed in-memory scope
sets avoid quadratic project-by-grant comparisons.

This is not a resource bound: the existing grant-history query already reads
and locks all historical rows, and the change permits larger authorization
queries, arrays, locks and transactions. Large histories can exhaust resources
or hit the transaction timeout. A load-tested lifecycle, bounded maintenance or
other administrative design is still required for a supported large-tenant
guarantee; a timeout must roll back all changes. Test 100+100 disjoint scopes,
larger retained histories, mixed project/portfolio grants, and denial on a
late item. Do not imply arbitrary-size success or a tested recovery procedure.

An additive migration must also guard direct runtime-role configuration seals:
under a stable source row, require the new revision's audit subject to hold
current PMO project/portfolio grants for the old and new scope, preserving all
existing new-scope and mapping/receipt checks. Check at both the seal and source
head activation, because the same transaction could change its own grant after
sealing. The native guard checks the old/new configuration union; each changed
sync grant retains its existing native project check, while the application
additionally checks untouched historical grants. The shared API database role
and actor subject are trusted application inputs, not separate database
authentication for each user. Do not rewrite applied migrations. Prove the
role's actual privileges and grant-revocation serialization; keep the
source/configuration and project/grant locks until the transaction ends.
The guard establishes authorization at sealing and activation. An external
transaction cannot revoke a locked grant until the transaction finishes; the
same transaction can remove its own grant after activation, so no stronger
through-commit authorization claim follows from these checks.

This narrowly addresses affected-scope authorization; it does not by itself
resolve the existing source-before-project versus project-before-source lock
inversion. A deadlock/timeout must roll back the whole transaction, and a later
separately reviewed lock-graph repair is required. Do not claim deadlock freedom.

## Verification and review

Use isolated synthetic data only. Test real application and runtime database
role behavior for B-only takeover denial of an existing A-only non-Jira/CSV
source, A-only denial when adding B, and successful explicitly authorized A+B
replacement. Assert exact source/config/cursor/readers/job state and audit
effects, accounting for the deliberately recorded generic denial audit; do not
claim no audit event on denial. Cover prior inactive Jira grants, first creation,
missing or unsealed old configuration, current role intersection, grant revoke
and concurrent replacement/races, two 100-project scopes, and direct runtime
SQL attempting to seal or move a source with only new-scope authority. Negative
assertions must prove transaction rollback and no leaked project/source content.

Test a clean install and populated previous-prefix upgrade, runtime privilege
reapplication, immutable old configuration/history, recovery/quarantine and
unchanged schema/table inventories. Independently review the design, native
guards, tests and exact immutable candidate. Complete applicable local and
hosted checks; use expected-head merge, verify actual tree/parents and post-merge
checks. Record all failures and do not change accepted-story totals.

At this checkpoint the candidate's synthetic test coverage does not yet prove
all of the verification above. In particular, the existing non-Jira denial
snapshot has no live Jira job or sync grant and does not assert the generic
denial audit. A separate synthetic Jira fixture now specifies those checks for
a pending job and active grant; it has not yet run on PostgreSQL. Simultaneous first-create and replacement, malformed old-head
integrity, token-role intersection, and denied-request content leakage remain
unverified for this change. The populated upgrade covers generic-source
revisions and readers under synthetic role/ACL conditions; it does not establish
production function-owner parity or retained Jira receipt/history recovery.
