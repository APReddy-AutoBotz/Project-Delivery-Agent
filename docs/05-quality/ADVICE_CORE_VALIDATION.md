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
- Full lint and new-test lint passed on the corrected candidate.
- Architecture check passed: eight packages and 97 first-party source files.
- Documentation validation passed: 245 requirements, 91 acceptance criteria,
  38 stories and 141 specifications; the corrected-candidate check passed.
- Build and typecheck passed for all eight packages, including Prisma generation
  only and the production web bundle. No database operation was invoked.
- Final full unit regression: **1,804 passed across 105 files** in 121.58 seconds
  with two workers and unchanged test/hook/child deadlines. This includes the
  existing startup-disclosure check and all 56 new advice tests. The domain build
  was repeated after the review correction. Underlying pinned tools were invoked
  directly for equivalent package scripts, avoiding shared dependency synchronization.
- Earlier full unit regression: 1,802 passed and one existing startup-disclosure check
  failed after its child reached the unchanged 15-second deadline with empty
  output while the workspace build was in progress. This is not a passing run.
  A subsequent serial run was stopped to incorporate source-review corrections;
  it supplies no completed pass. Both earlier logs remain retained locally.

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
identities, isolating the intended guards. Both independent reviewers approved
corrected source candidate `652bb30b197b3159858d583d174e2592d04f9574`
(tree `3af3eb8304a05b1daa93d6bd66910e355d1419b7`) without remaining findings.
Root bound all seven working-file review hashes to those Git blobs, accounting
explicitly for the checkout's existing line-ending filters. Final documentation
record updates require exact-head review before publication.

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

EPIC-06 remains the dependency for complete EPIC-07 integration. Exact-head
required CI, publication and verified merge remain pending at this local checkpoint.
Issue #11 remains open and accepted totals remain R0 3/5,
R1 2/33, overall 5/38. Stopped research capture stays stopped; no artifact reference,
download, HTTP utility, observer, sealer or new research attempt was invoked.

## Impact and recovery

The original advice-only candidate has no dependency change. Its normal hosted
audit subsequently blocked merge on three existing dependency versions. The
independently reviewed repair pins proxy-addr 2.0.8 (API runtime), source-map-js
1.2.2 and Vite 7.3.7 (development/build tooling), with exact override/adoption/notices
records. Registry identity, engines, declared permissive licenses and integrity
were verified. A fresh pnpm 11.19.0 frozen install passed in a separate dependency
tree, reusing 490 published packages and downloading only the three patches. All
39 unrelated adoption records retain their exact values and original formatting;
the complete lock diff contains only these patches and their references/peer pins.
Original installed licenses were read and retained; identities and SRI values match
registry metadata and the lock. Registration verifies 42 exact dependency records.
The unchanged high-severity audit passed: zero high/critical, four moderate.
Fresh actual `pnpm build`, `pnpm lint`, `pnpm typecheck`, and
`pnpm test --maxWorkers=2` all passed on this graph. The final regression passes
1,804 tests/105 files in 172.06 seconds, with unchanged deadlines. New-test lint,
eight-package/97-source architecture and 245-requirement documentation checks pass.
Both independent reviewers approve dependency candidate
`97c341c59b53bb8e637970b43130e7b762dbc904`
(tree `1cf110c91453a102cb0587073cd816545bfd26b5`) with no remaining findings.
Final record-only exact-head reviews and fresh hosted/customer CI remain required;
earlier core-only results do not supply evidence for the new graph.

## Distribution advisory metadata repair (NFR-SEC-010 / AC-MNT-004)

The initial normal Foundation run 39647616494's production/customer acceptance
passed before its distribution collector rejected changed CVE-2026-8376 fix
metadata. This failure receives no distribution passing credit. Debian's tracker
and DLA-4821-1 now identify security version 5.36.0-7+deb12u4 as fixed, while the
pinned u3 source package remains vulnerable. The unchanged primary CNA bytes
still describe the 32-bit-build precondition. Original publisher responses and the
complete CI log are retained privately; the primary CNA hash remains
`a083a4770e008b866e381ef59b7cb132fe889f3ed593e13a1405c55a424f2cbe`.

The independently reviewed repair changes only the policy's exact expected fix
object to `fixed`/u4 and its scanner-reported first-observed availability. It does
not claim the u3 image is patched or treat first-observed as a publisher release
date. The physical x86-64/ELF64/build-width proof, analysis/CNA/material/layer/
relationship/match-envelope hashes, target/scope/description constraints, matcher
and narrow architecture disposition remain unchanged. Whole-image/embedded
absence and release approval remain false. Other CVEs and all five release holds
remain open.

Twelve new regressions pin the complete fix object, preserve u3 installed-material
identity and the narrow disposition, and reject the obsolete object/state,
changed/missing versions, availability/date/kind and unknown or duplicated fields.
The preexisting selected-description regression now mutates `fixed` to `wont-fix`
so it still tests a genuine rejection. Focused Perl/gosu validation passes all
174 tests. The full final local regression passes 1,816 tests/105 files in 86.60
seconds with two workers and unchanged deadlines. Required lint, separate advice
test lint, architecture, 42-record dependency registration, documentation validation
and the unchanged audit all pass (zero high/critical, four moderate). Application
and dependency blobs remain identical to the earlier full build/typecheck input.
Exact-head reviews and fresh complete normal CI remain pending at this checkpoint.

An additional ad hoc lint probe of the legacy Perl test file reported 20 uses of
explicit-any fixture style, outside the repository's required lint paths. The two
new uses were replaced with explicit types; 18 preexisting uses remain unchanged.
No lint rule, assertion or deadline is relaxed.
The required `pnpm lint` passes. The failed probe is retained and supplies no
passing credit.

No database/migration, connector scope, credential, external SDK or UI changes.
OD-013 public OAuth/live Jira activation stays
disabled and spreadsheet commits remain reviewed proposals. Roll back by reverting
the additive domain/export/docs/tests and manifest/lock/register change through
review and rebuilding; no data restoration or customer operation is necessary.
