# PM escalation request-history validation

Date: 2026-10-22
Plan: [EXEC-020](../04-delivery/exec-plans/EXEC-020-pm-escalation-history.md)
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/9
Requirements: FR-ESC-005/006, FR-UPD-004, NFR-SEC-001/005
Criterion: AC-UPD-008 history portion only; supporting AC-UPD-003

## Verified merge and validation

The bounded history increment merged in [PR #114](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/114).
Independent source and coverage reviews approved exact candidate
`452d455dd269920e73dadaff1919ec33022e9a20`. Actual merge
`fe353437f45ce37b835255f63bfb12837068fa8a` preserves reviewed tree
`c45a9c91c58dde05c8079b54dc8c5843ca90d5a8` and ordered parents base
`9e1d84323c280b74f4f17bf62de80ec664e600fc` then that candidate.

Exact-candidate [Foundation 39809095541](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39809095541)
and [Documentation 39809095548](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39809095548)
pass. Separate actual post-merge [Foundation 39814060478](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39814060478)
and [Documentation 39814060230](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39814060230)
also pass at the actual merge SHA. Foundation passes on one unchanged failed-job
rerun. Its first production job failed at bundled restore's
`sessions_before_commit`; the original failure remains retained and its session
cause is not established. The verification job already passed on the first
attempt; no guard, assertion, source or deadline was relaxed for the rerun.
Exact-candidate hosted evidence confirms
1,904 units, 225 native tests, 45 ordinary browser cases and the separate saved
history browser, exact 85-business-table recovery plus the migration ledger,
and packaged TLS/OIDC/customer/distribution-manifest gates. Technical distribution
evidence does not accept any of the five release holds.

The fresh local fourth native run separately passes 225 cases / 16 files in
642.20s. Its genuine success receipt supports guarded recovery into a new,
quarantined database: exact 85 business tables plus the ledger, 14 populated
proof families including 116 reassessment causes, immutable-history denials and
no running application. API/worker CONNECT remains false on the restored target.
Earlier failed and interrupted runs remain historical without passing credit.

This completes the bounded implementation's review and merge gates. Full
AC-UPD-008, E2E-ESC-008 and Issue #9 remain open; delivery and supported project
impact are still required. Accepted stories remain 7/38 (R0 3/5, R1 4/33).
No schema, privilege, dependency or connector scope changes. Original19/20
research capture remains stopped.

## Verified merged boundary

The currently named PM can read a bounded, current-cycle projection through an
existing authorized escalation invitation. The original request, owner reminders
and owner escalation preserve their actual stage/request identity and time. A
21-row probe rejects a cycle larger than 20 before origin bodies or dependencies
are queried. It never returns partial history for a missing original or overflow.

Every existing invitation gate remains in force. Each origin requires the current
responsible owner's binding/grant and both readers' current source access.
Historical source A is checked independently of the current PM message's source B.
Expired or restricted origins return metadata only. Whole-view grant/gate loss
denies the invitation. The browser hides each body at its own original expiry.

The server verifies the retained digest and supported renderer's exact trailing
reviewer notice before replacing only that notice with a fixed display notice.
Neither the digest, origin reviewer list, locator nor raw owner responses is
returned. The PM's own responses and unconfirmed submission contract remain.
The view labels historical text and explicitly UNKNOWN delivery impact.

No schema, migration, renderer, dependency, connector scope or privilege changes.
All 25 released migrations and the exact 85 business-table inventory must remain
unchanged. Current canonical facts, outbox attempts and recorded bodies are not
changed by a read. No delivery, model call, interpretation or approval is added.
OD-013/014, proposal-only imports, all five release holds and stopped research
capture remain in force. The accepted-story total stays 7/38.

## Observed validation results

| Gate | Result |
| --- | --- |
| Build, lint, typecheck | Pass across all eight workspaces |
| Full unit suite | 1,904 tests / 109 files pass in 240.55s |
| Focused history units | 41 schema, digest and display-projection cases pass |
| Cache cleanup units | Eight cases use the real QueryClient and pass in the full suite |
| Focused native history | Current 13 cases pass in 21.71s under `SET LOCAL ROLE pdaa_api`, including real same-engagement generation selection |
| Related browsers | Five UI contracts plus three existing real update journeys pass in 38.4s |
| Real saved PM browser | Current dedicated-customer journey passes in 11.6s (assertions 7.3s); screenshot and exact-fixture receipt inspected |
| OpenAPI | Regenerated additive response snapshot and exact check pass |
| Architecture | Eight packages / 102 sources pass |
| Dependencies | 42 exact direct/override records pass; no graph change |
| Audit | Existing high threshold passes: zero high/critical, six moderate advisories |
| Documentation | 245 requirements / 91 criteria / 38 stories / 143 test specs pass |
| Released migrations | All 25 SQL files match verified main byte for byte |
| Fresh full native and recovery | Local fourth run: 225/16 pass; quarantined exact 85-table recovery and 14 populated proof families pass. Exact-head hosted native/recovery also pass |
| Immutable review and hosted gates | Exact-candidate independent source/coverage reviews approve; exact-head and actual post-merge Foundation/Documentation all pass |

The migration-lock logical content is unchanged; its existing checkout CRLF
format differs from Git LF. No migration file was rewritten.

## Executable coverage

`tests/project-update-escalation.test.ts` covers legacy omission/default null,
exact identities/order, tied clocks, 20/21 bounds, explicit expiry states,
digest/footer/renderer rejection, UTF-8 bounds and reviewer redaction.
`tests/project-update-response-state.test.ts` proves exact protected-query erasure
on 401/403/404 while unrelated keys remain. The denied view is disabled, preventing
automatic refetch from restoring the removed context.

`tests/project-update-escalation.integration.test.ts` uses real protected rows,
separate A/B dependencies, current PM/owner denial, retention, unrelated-project
exclusion, PM-own response compatibility and immutable-state snapshots. Positive
body/response seam controls prove the guards are armed; revoked/expired A yields
zero origin body queries while B and the PM's own reply remain readable. A
read-only as-of seam challenges retention without changing stored timestamps or
scheduler rules. Exact 20/21 uses a bounded projection seam; immutable guards stay
enabled. Existing engagement regressions separately cover older-generation
predecessor isolation and rotated/old invitation denial in the full native cohort.
The history-specific native fixture also retains five real captured records in
generation 1, rotates/re-enables its isolated customer's issuance gate with valid
audits, and calls the real PMO capture-generation command. The same engagement
and policy then have five generation-2 records. The native test checks both DB
generations, the actual old capture IDs and AVAILABLE exact latest-anchor/current
history IDs; all old IDs are absent. Owner escalation is captured after the PM
message, and its actual later timestamp is included at read-as-of.

A later generation cannot coexist with an authorized old PM invitation: whole-
view generation fencing runs before context selection. The old PM locator is
tested DENIED before any context query after renewal. That denial is jointly
epoch and generation fenced; it does not isolate either gate independently.

`scripts/acceptance/escalation-history.mjs` creates five actual protected capture
records per cycle with all birth/outbox/content guards enabled. The native-only
older-cycle option requires a newly isolated customer; it retains two cycles in
the main project before the unrelated project is created. A reminder has the original
request's capture time and a lower UUID. This is a projection fixture, not proof
of scheduler processing or external delivery. The native harness prepares it
before the timed view cases, retaining private fixture JSON outside public
artifacts.

The earlier pre-isolation saved journey used a fresh `pdaa_test_1792656590693`, real API and built
web preview without route interception or a worker. It asserts exact IDs before
rendering, source-A revocation with three restricted origins while B remains
visible, no private owner reply, UNKNOWN impact and sign-out cleanup. Its sanitized
receipt is written only after every assertion passes. Root inspected the final
saved Antigravity screenshot and receipt. CI publishes only
`pm-escalation-history-browser` PNG/JSON, not private fixture files or full logs.
This proves the prior runtime/browser behavior only. The current dedicated-
customer/API-binding run separately passes on `pdaa_test_1792683902011` in 11.6s
(journey assertions 7.3s). Root inspected its saved screenshot and verified that
the post-assertion receipt's project, current request and original request match
that exact private fixture. The history hides origin reviewer details and private
owner replies; the PM's own existing reviewer/response contract remains intact.

The separate intercepted response UI contract proves an origin body expires
before its PM invitation, a later reminder remains visible and a denied refetch
clears the view/draft and disables further reads. It is not real API evidence.
All eight related browsers ran on separate fresh `pdaa_test_1792656449477`.

## Retained unsuccessful runs

The first full native run passed 198 and failed 14 cases. Its shared fixture's
valid additional pm-atlas grant conflicted with three foundation tests' exact
scope assumptions, and default-customer issuance-epoch rotations invalidated ten
history cases. One unchanged milestone 1,000/1,001 capture also failed with a
generic persistence error; its cause remains unproven. The fixture now has its
own synthetic customer/gate and a second protected project for exclusion checks.
The configured default customer's scope and gate remain untouched. Independent
coverage review found no remaining cross-customer fixture write; the unrelated
project test now requires AVAILABLE plus exact four current-project IDs.

A fresh abbreviated probe passed the existing foundation and milestone files,
but omitted the standard ACL reconstruction and therefore could not exercise
the history repository under pdaa_api. Read-only diagnostics confirmed absent
base-table SELECT grants in that probe. No application privilege was widened.
The corrected full native run uses the unchanged normal provisioning path. It
passes 209 of 212 tests, including all 12 history cases and the earlier scope/gate
regressions. Three existing cases fail: the combined five-child-death scenario
and the long ingestion scenario exceed their generic 20s test limits; milestone
1000/1001 capture reports a wrapped persistence error. A private diagnostic on the
retained isolated database captures the original Prisma P2028 at the unchanged
production 10s transaction limit. Sanitized operation timings show time across
proof writes, validation and delivery reads; no deadline or validator is changed.
Neither
failed full run earns full-suite credit. The failed run's success receipt was
correctly retained/removed by the harness; no success artifact was synthesized.

Independent coverage review identified that the five-child scenario combines
five separately bounded 15s child processes under one 20s aggregate allowance.
The test now uses one shared fixture and five ordered actual-death steps, each
with the existing 20s case and 15s child bounds, followed by the no-sixth-claim
check. Every charge, generation, zero-side-effect, live-lease, exact 120000ms lease
and exhaustion assertion remains. Fail-stop prerequisites reject skipped, failed,
retried or incomplete earlier steps; a late timed-out promise cannot re-enable
later steps. The aggregate scenario allowance changes; no production deadline
changes. Fresh full-suite evidence is required for this correction.

Independent source review also approved decomposing the existing long ingestion
scenario into eight sequential bounded phases. An async generator preserves the
original lexical state, statement order and every assertion. Seven explicit
yields divide only reviewed boundaries; each phase runs inside a default 20s
test with failure/abort/prerequisite latches. The real six-second expiry lock and
its 15s transaction remain. No database work moves into untimed setup. This also
changes the aggregate scenario allowance and earns no latency-compliance claim.
The 224-case third run lost its tool handle without a final result. Inspection
found no test-database client sessions, its exclusive bridge closed and no success
receipt. It is retained without passing credit. The new lineage regression brings
the current full native cohort to 225 cases across the same 16 files. Its fresh
fourth execution was running at that local checkpoint; ordinary hosted Linux validation was then pending.

The first full unit run passed 1,902 cases and failed two: its OpenAPI snapshot was
stale, and the unchanged startup-disclosure child exceeded its fixed 15s limit.
After contract generation, both the unchanged isolated startup check and the
complete 1,904-case run pass. No test deadline or assertion was changed.

The first two real-browser preparations stopped at a 30s startup allowance. A
standalone compiled API import measured 69,660ms on the Windows host, so the new
runner bounds prerequisite startup at 120s. Playwright deadlines stay unchanged.
The third run failed cold development transforms; subsequent runs use actual
built web output. The fourth/fifth exposed fixture PM identity/responsibility
mismatch, corrected at project birth. The sixth incorrectly expected the existing
memory-only development session to survive reload. The seventh passed with an
authenticated visibility refetch; the eighth passes on that pre-isolation build.
The dedicated-customer fixture/runner correction requires a fresh browser pass.
The ninth run creates that isolated fixture but stops before the journey: the
actual API child does not become ready inside 120s and its log is empty. It earns
no browser credit. A direct compiled-app import then measures 9,169ms; the full
static-entry imports measure 13,693ms. A private fixed-marker startup diagnostic
against the ninth run's isolated fixture reaches readiness in 8,586ms, including
successful app creation. It does not reproduce or establish the earlier stall's
cause. The tenth reaches the browser launch prerequisite, then fails because the
sandbox default cache lacks the pinned Chromium executable. The already-installed
matching revision is verified in the user cache; setting PLAYWRIGHT_BROWSERS_PATH
selects it without a download or source/deadline change. The eleventh fresh run
passes the complete current isolated-customer journey. All unsuccessful logs and
diagnostic files remain private; no failed run receives passing credit.

All failed logs, traces and fixtures are retained privately without full-suite
credit. Default local `pdaa`, unrelated resources and the unfinished
interpretation checkout are untouched.

## Acceptance and recovery

INT-ESC-001 covers only this bounded request-history projection. Full E2E-ESC-008,
AC-UPD-008 and Issue #9 remain open: delivery and supported project impact are
still required. No story is accepted by these checks.

Revert the additive projection/API/browser increment through normal review.
Retained rows and schema remain compatible; no data rollback is needed.
