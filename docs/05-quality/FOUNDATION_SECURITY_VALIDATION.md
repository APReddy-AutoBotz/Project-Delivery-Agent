# Foundation security boundary validation

Date: 2026-09-07
Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5)
Requirements: NFR-SEC-001, NFR-SEC-004, NFR-SEC-005, TR-AUTH-003, TR-DEP-003, FR-APP-010, FR-ADM-009
Criteria: AC-SEC-001, AC-SEC-003
Specifications: SEC-SECRET-001, SEC-OUTBOUND-003
Plan: [EXEC-003](../04-delivery/exec-plans/EXEC-003-customer-hosted-foundation.md)

## Scope and review assignment

This increment starts from merged `1d0bcb9`, on
`feature/foundation-security-boundaries`. Root owns implementation and Git.
Independent reviewers are `review_customer_candidate` for security and
`baseline_quality` for acceptance and evidence. Both perform read-only review;
their immutable candidate SHA and findings disposition must be recorded on the
PR before merge. The Product Owner confirmed they are currently the sole GitHub
contributor. Agent assignments and review records do not claim GitHub account
review requests or self-approval.

STORY-005 remains in progress. A passing bounded foundation test does not activate
a customer connector, accept the full story or approve customer distribution.

## Runtime contracts

The platform provides a bound outbound operation through `createOutboundDispatcher`.
Its configuration reader, current policy reader and adapter are supplied by trusted
server code. Invocation has no policy, approval or adapter arguments. Missing or
invalid configuration, shadow mode, malformed/denied policy and reader failures
all deny dispatch. Policy is read on each invocation; configured shadow mode is
checked again after policy validation, immediately before adapter invocation.
Runtime logging serializes only known categories and validated own data fields;
unknown fields, accessors and arbitrary error objects are not serialized.

Logout and expired sessions clear tokens, protected queries and mutation data.
Only the exact public `auth-config` query remains; removing it would trigger a
redundant fetch immediately before the provider redirect. Browser coverage checks
that a subsequent operator session cannot see the previous project-manager data.

No production action caller or model-tool registry exists yet. This contract
establishes the shared foundation boundary and a recording-adapter test, not
connector approval authority, proposal persistence, atomic remote preflight,
receipts, idempotency or reconciliation. Those remain required in their later
approved workflows. Do not expose the factory or policy readers as model tools.

## Executable evidence

| Contract | Evidence |
|---|---|
| Randomized authenticated ciphertext; context binding; missing/wrong keys, tampering and invalid tags denied | Existing `tests/security.test.ts`, `tests/identity-boundary.test.ts`, `tests/database.integration.test.ts` |
| Separated production secret files and safe configuration failures | Existing `tests/production-config.test.ts` |
| Real HTTP success/error bodies and headers, public configuration and both process output streams exclude generated secrets | Extended `tests/api-contract.test.ts`; existing repository/parser error cases retained |
| Runtime log categories/fields and API/worker startup output | `tests/logging.test.ts`, `tests/startup-disclosure.test.ts`; existing fatal subprocess checks in `tests/operations.test.ts` |
| Default shadow, malformed configuration/policy, policy revocation, shadow changes during lookup, invocation overrides and reader failure produce zero blocked adapter calls | `tests/outbound-boundary.test.ts`, existing policy cases in `tests/security.test.ts` |
| Disclosure checker and capture helpers reject seeded leaks, incomplete captures and invalid asset evidence | `tests/disclosure.test.ts`, `tests/disclosure-capture.test.ts` |
| Packaged browser outputs and complete inventoried static assets | `scripts/acceptance/disclosure.mjs`, `run.mjs`, `customer.mjs` |
| Session cleanup preserves public configuration while clearing protected data; actual provider logout return is awaited | `apps/web/src/main.tsx`, `tests/e2e/foundation.spec.ts`, packaged OIDC workflows |
| Packaged service stdout/stderr, operations diagnostics, nonsecret env and resolved Compose exports | `scripts/test-production.mjs`, `scripts/acceptance/customer-host.mjs` |

Packaged fixtures generate database passwords, keys, login credentials and a
connector credential per run. The restored connector plaintext uses the same
generated value that disclosure checks register. Scans include raw, JSON-escaped
and URL-encoded forms. A required channel cannot pass with an empty capture.
Only counts and passing channel summaries enter canonical evidence; raw captures
and secret values are excluded from published artifacts.

Browser capture covers response bodies/headers, console arguments, error stacks,
DOM and local/session storage, awaiting all capture tasks before closing contexts.
The exact configured fixture token response must be observed. Its expected
access/ID/refresh token fields are permitted there; headers, metadata and server
secrets remain checked. Issued tokens join checks for other observed outputs.
The browser's intended bearer request and provider logout hint are retained.
All manifest-declared shipped assets are fetched and hash-checked, including
unvisited chunks, HTML and notice files. Distribution validation separately checks
that the asset manifest covers the actual image filesystem.

Successful service logs are checked before teardown and before customer runtime
recreation. Commands whose stdout is parsed retain stderr in private diagnostics;
operation containers removed after execution cannot supply those streams later.
The host passes private captures to `check-disclosure.mjs` in the existing isolated
verifier, which reads the original secret files through their read-only mount.
This preserves their container ownership and modes; the host does not need direct
secret-file access. Sanitized receipts bind the current run, profile and phase.
Signed token-shaped values are also rejected in service/operation logs without
exporting browser-issued token values to the host evidence bundle.

## Validation status and acceptance limits

Local validation passes all 91 unit tests, seven workspace builds, lint, typecheck,
architecture/OpenAPI/dependency checks, documentation validation and all 13
documentation regressions, plus seven browser workflows. The first stream-capture attempt correctly failed
because Vitest redirected console output away from the intercepted streams; the
test now binds console methods to those streams, and the unchanged nonempty
capture requirement passes. Two helper lint diagnostics were corrected. An initial
documentation-test discovery used the wrong directory and ran zero tests; the
correct scripts directory passed all 13. These initial attempts are not counted
as passing checks.

The initial PR #26 candidate `5ce5f0c` passed application and documentation CI,
but packaged CI run `34078657994` stopped at incomplete browser capture after the
OIDC navigation checks. Await capture before changing pages, and remove an
unnecessary navigation before the final snapshot. Capture failures still fail
closed and report only fixed response/console failure counts. Matching corrected
candidate CI is required; the initial packaged run is failed evidence.

Corrected run `34079193910` also failed packaged capture while application and
documentation checks passed. An isolated local reproduction confirmed the missing
body was a completed HTTP 200 auth-configuration refetch whose document navigated
away. The browser now retains only the public configuration during session cleanup,
response headers and bodies begin capture concurrently, and logout tests wait for
the actual returned main-frame document before taking a snapshot. An added helper
regression verifies body capture starts even while headers are pending. Missing
response bodies still fail; neither failed CI attempt is accepted evidence.

The corrected local OIDC probe passed logout and reached grant/revoke, then found
Chromium's body-read error on the two HTTP 204 responses. A separate loopback
Chromium probe confirmed that HTTP 204/205 return no body through that API. The
collector now retains header checks and safe counts for bodyless responses,
including HEAD; injected header secrets still fail the added regression. Ordinary
response body failures remain blocking. Post-logout captures also wait for the
returned document's organization sign-in control to become enabled, proving its
public configuration has loaded before the context can close.

A later probe exposed the same completed-body navigation race on identity-provider
metadata. The observer therefore holds product/fixture-identity navigation until
pending response and console captures drain, including captures queued during the
wait. It installs and awaits the guard before creating pages. A ten-second deadline
aborts navigation and leaves a persistent capture failure; it never refetches or
replaces responses or bypasses browser TLS. Unit regressions cover delayed bodies,
newly queued captures, first navigation without a token, and a stuck capture.
Playwright routing disables HTTP caching and guards the initial request in a
redirect chain; later unavailable response bodies still fail the final capture.

One local full-suite attempt during concurrent Docker/browser work returned empty
output from two 15-second subprocess checks (86 passed, two failed). With the
fixture stopped, all 88 tests then present passed with two workers and unchanged
timeouts/assertions. After adding the bodyless-response and navigation regressions,
the full current 91-test suite passed with two workers. Matching final-candidate
packaged validation is required and recorded on the PR.

A separate local verifier probe passed three scenarios using an actual container
volume with a UID1000-owned mode0700 directory and root-owned mode0600 secrets:
clean capture passed, injected stderr disclosure failed, and empty required output
failed. No secret appeared in process output. The probe reused an existing image,
used no network and removed only its verified, uniquely labelled temporary volume.

The two security specifications now reference executable tests as implemented;
this is not acceptance of AC-SEC-001/003 or STORY-005. Remote packaged results and
independent review of the exact candidate remain required and are recorded on the
PR. Required
gates are lint, typecheck, full unit/integration/browser suites, seven workspace
builds, architecture/OpenAPI/dependency checks, recovery, documentation validation
and regressions, and both packaged customer profiles with distribution evidence.
No acceptance status changes before matching results and exact candidate review.

Generated runtime secrets are created after image build. Their absence in shipped
assets proves runtime-secret separation for these fixtures; it does not claim
coverage of arbitrary build-time secret injection. Customer-specific IdP mapping,
key management, infrastructure logging and deployment acceptance remain separate.
Existing image, license/notice and trusted signing review blockers remain open.
R0 stays 3/5 accepted; R1 stays 0/33.

## Impact and recovery

Files change in platform logging/dispatch, native and packaged tests, fixture
preparation, evidence capture and traceability documents. No database schema or
migration, runtime dependency, connector scopes or live external operation is
added. Existing local data and preview are preserved. Roll back through a reviewed
revert and previous reviewed images; no database rollback is required.
