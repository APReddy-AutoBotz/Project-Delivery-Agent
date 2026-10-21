# Deterministic advice core validation

Date: 2026-10-21
Plan: [EXEC-017](../04-delivery/exec-plans/EXEC-017-deterministic-advice-core.md)
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/11

## Implemented boundary

FR-ADV-001/002/006/007/008, FR-RPT-002, BR-013 and NFR-REL-003 have
internal groundwork in `packages/domain/src/delivery-advice.ts`. Its pure builder
recomputes existing health input, retains exact trigger/rule/source metadata,
uses fixed PM/leadership suggestions and ranks bounded eligible items. Pending
approval metadata preserves independent provenance, freshness and conflict.
Source text cannot replace the fixed action/outcome templates. Suggestions do not
execute an action, approve a proposal or publish a fact.

## Executed checks

- New advice suite: 56 tests passed.
- Advice plus existing health suite: 63 tests passed across two files.
- Full lint and new-test lint passed; final review-fix rerun pending.
- Architecture check passed: eight packages and 97 first-party source files.
- Documentation validation passed: 245 requirements, 91 acceptance criteria,
  38 stories and 141 specifications; final documentation rerun pending.
- Build and typecheck passed for all eight packages, including Prisma generation
  only and the production web bundle. No database operation was invoked.
- Full unit regression: 1,802 passed and one existing startup-disclosure check
  failed after its child reached the unchanged 15-second deadline with empty
  output while the workspace build was in progress. This is not a passing run.
  A subsequent serial run was stopped to incorporate source-review corrections;
  it supplies no completed pass. Final corrected-candidate regression is pending.

The first focused run had 49 passes and one faulty fixture expectation: a critical
reported/calculated mismatch correctly ranked ahead of a HIGH approval. The test
now asserts HIGH approval precedes LOW intervention while preserving the critical
mismatch. An expanded mixed-category fixture initially reused a signal ID; the
existing validator correctly rejected it. Giving each concern a distinct ID
produced the passing 62-test result. The final review correction adds a passing
63rd regression check. No existing guard or timeout was weakened.
An initial sandbox run failed its temporary-file rename before running tests;
the authorized normal-runtime run is the execution evidence above.

Independent source review of `1ebb373653543cc5ab4934ee241415be199fe99c`
found no P0/P1/security blocker, but identified a P2 evidence omission: calculated
GREEN can depend on CLEAR signals that generate no individual advice item. The
reconciliation trigger now retains the complete bounded objective-signal snapshot;
the regression verifies its exact source facts, permutation and detached immutable
state. Separate coverage review approved the limited groundwork and identified
three nonblocking fixture improvements. The future assessment/approval fixtures
now remain inside valid expiry intervals, and the 26-project fixture uses distinct
identities, isolating the intended guards. Final exact-head re-review is pending.

## Coverage and remaining gates

The new file provides internal UNIT-ADV-001/005 groundwork, fixed-template safety,
PM/leadership adaptation, six signal mappings, uncertainty, reported/calculated
reconciliation, queue order/permutation, current-scope input filtering, exact
reviewer matching, deadlines, detached immutability and admission limits.
The positive bounds include 500 signals and 100 approval reviews without loss.

Supplied scope lists are trusted application inputs, not proof of authorization.
The server must freshly load current customer/identity/project/assignment/evidence
and approval capabilities and active validity policy. No public API or model tool
accepts these inputs. This does not establish NFR-SEC-001/SEC-RPT-003 server
enforcement. Database, browser, model evaluation and full GOLDEN-012 remain open.
In particular, Scrum Master behavior and a named current escalation recipient need
later role/reader integration. Planned acceptance specifications remain planned.

EPIC-06 remains the dependency for complete EPIC-07 integration. Exact candidate
nonauthor source/coverage review, exact-head required CI, publication and verified
merge remain pending. Issue #11 remains open and accepted totals remain R0 3/5,
R1 2/33, overall 5/38. Stopped research capture stays stopped; no artifact reference,
download, HTTP utility, observer, sealer or new research attempt was invoked.

## Impact and recovery

No database/migration, connector scope, credential, external SDK or runtime
dependency changes. No UI changes. OD-013 public OAuth/live Jira activation stays
disabled and spreadsheet commits remain reviewed proposals. Roll back by reverting
the additive domain/export/docs/tests change through review; no data restoration
or customer operation is necessary.
