# Durable authority policy and assessment validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6)
Plan: [EXEC-004](../04-delivery/exec-plans/EXEC-004-canonical-model.md)
Partial requirements: FR-ADM-005, FR-EVD-003, FR-EVD-004, FR-EVD-006,
FR-EVD-007, FR-EVD-009, FR-EVD-010, FR-EVD-012 and NFR-SEC-001; ADR-009/010.

## Implemented boundary

The internal authority repository publishes immutable enabled policies or disabled
events for an existing project and fact type. The server supplies scope, author,
recording time and causal revision. Only a current scoped PMO administrator can
publish, using optimistic concurrency and actor-scoped idempotency. Greatest
eligible causal revision wins: an older scheduled enable never overrides a later
eligible disable. Specific source selectors must bind existing immutable human
sources in the same customer, project and fact type. Wildcards can precede facts.
A newly inserted policy aggregate must have a valid published revision at COMMIT.

Capture takes only project, fact type and idempotency key. It authorizes the current
actor, locks the project and reads server time, active policy, complete fact history,
source permissions and every retained conflict. Human statements remain
HUMAN_CONFIRMED with approval NOT_REQUIRED; they cannot satisfy APPROVED rules.
The original resolver result and exact typed dependencies are stored and sealed
once. Fact, policy and conflict publication prefixes remain stable when later rows
share the same millisecond. New captures must pin the current prefixes; later
reads validate the captured prefixes. Source-access revision is checked when each
dependency is inserted, and current access is checked again on every delivery.

The reader proves the 1,000-version and 1,000-conflict bounds by reading one extra
row. Oversize histories return explicit INCOMPLETE without truncated winners.
New disagreements retain all contributors as an atomic bounded pair batch. When
that batch crosses the conflict limit, all its pairs persist and the capture is
INCOMPLETE; subsequent captures stop without adding pairs. Existing conflicts
survive policy changes, supersession and expiry. Reconciliation is a signal only.

Sealing validates scope, timing, immutable copied values, source/evidence tuples,
policy selection, derived authority/approval/temporal state and complete dependency
coverage. Unsealed transactions fail at actual COMMIT; sealed history cannot be
extended or changed. Frozen reads never recompute the saved result. Loss of any
captured source's current access or verification withholds the entire copied
result. Restored access cannot upgrade an originally redacted assessment.

## Migration, permission and recovery impact

The additive third migration adds AuthorityPolicy, AuthorityPolicyRevision,
AuthorityPolicyReceipt, FactAuthorityConflict, FactAssessment,
FactAssessmentVersion and FactAssessmentConflict. Both original migration files
remain byte-for-byte unchanged. Existing fourteen-table data is preserved.

API access adds SELECT/INSERT on those seven tables and UPDATE only on the policy
counter and assessment seal. SQL guards enforce the allowed transitions. Backup
receives SELECT; the worker receives no new business access. Current project grants
and source-reader access remain mandatory; audit failures expose fixed sanitized
errors. No model tool, public route, UI workflow, runtime dependency, connector
scope or outbound operation is added.

Upgrade fixtures start from genuinely populated one- and two-migration releases,
retain every prior business row and complete migration-ledger row, then apply and
repeat the third migration. Packaged fixtures use the actual API role for policy,
capture, denied-role and redaction cases. Finite table/column grants, grant options,
ownership, worker denial and immutable history are checked. Encrypted restore
compares all 21 business tables and the migration ledger before additional probes.
The restored database remains quarantined; all policy/conflict/assessment integrity
predicates run before it is reported verified. Restored complete capture COMMIT
and rejected unsealed COMMIT are separate assertions.

Recovery preserves the existing local database, container, volume and Docker VHD.
After successful migration, a compatible application revert keeps immutable new
history. Otherwise restore with the matching reviewed release into a fresh
quarantined target. There is no destructive down-migration or in-place data reset.

## Verification status and remaining work

The independently reviewed design resolved causal policy ordering, full dependency
capture, one-time sealing and recovery validation before implementation. Initial
code review added stable conflict prefixes, current capture pins, dense policy
history checks, source-access pin binding and stricter copied-result validation.
Operational review added conflict-history continuity and complete column-grant
option/MAINTAIN checks. Meaningful denial and boundary cases accompany these fixes.

Native lint and type checks, 712 unit tests in 29 files, seven builds, architecture,
OpenAPI, all 38 registered dependencies, documentation validation and 13 validator
regressions passed. The final database suite passed 63 cases, including SQL
claim forgery, complete 1,000/1,001 bounds, permission loss and exact millisecond
expiry in different timezones and rollback on an out-of-range deadline. Native
recovery compared all 21 business tables and the complete migration ledger exactly,
validated restored integrity and preserved immutable history. No application was
started on the restored target. Dependency audit and final lint/documentation
checks also passed. Immutable review, required CI, packaged upgrade/encrypted
restore and original artifact review remain merge gates. Earlier
development failures are retained separately and do not count as acceptance evidence.

This remains partial AC-ADM-003 and AC-EVD-002/003/004 evidence. Canonical hierarchy,
trusted external ingestion, approval history, conflict reconciliation and scoped
API/browser acceptance remain pending. Issue #6 and its six criteria remain open;
R0 stays 3/5 and R1 stays 0/33 accepted stories. Inventory, licensing/notices,
vulnerability dispositions, distributed layers and trusted release signing remain
open. No customer release or real-data activation is approved.
