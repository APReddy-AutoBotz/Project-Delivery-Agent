# Real OIDC expiry acceptance

Date: 2026-09-07
Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5)
Requirements: TR-AUTH-001, TR-AUTH-002, TR-AUTH-003, NFR-SEC-001, NFR-SEC-005
Criterion and specification: AC-AUTH-001 / SEC-AUTH-001
Plan: [EXEC-003](../04-delivery/exec-plans/EXEC-003-customer-hosted-foundation.md)

## Scope and evidence gap

This increment starts from merged `71b4e6d` on `feature/oidc-expiry-acceptance`.
Existing unit tests reject invalid signatures, issuers, audiences, expired tokens
and missing claims. The primary packaged fixture already verifies real PKCE/JWKS,
ID-token rejection, disabled production development login, logout, code replay
and invalid state. The browser expiry regression injects a 401. This increment
adds the missing execution with a naturally expired token through the deployed
API and browser; it does not assert that a runtime defect already existed.

## Executable behavior

After the existing logout, replay and operator grant/revoke workflows finish,
`scripts/acceptance/identity-expiry.mjs` creates a fresh browser context. The
project manager signs in through the controlled IdP, successfully reads its
identity and scoped project list, and loads an authorized project detail. The
original bearer is retained only in process memory. Both the initially loaded
detail request and the later browser denial must use that exact bearer.

The existing primary fixture issues 120-second tokens. Integer issue/expiry
claims, expected lifetime and sufficient remaining validity are checked before
waiting beyond real `exp` with a small boundary margin. One four-minute deadline
bounds login, the wait, HTTP requests, browser assertions and database operations.
No token claims, clocks or response bodies are replaced. Exactly one token request
and one successful exchange are required, so refresh/relogin cannot pass the test.

While valid, the manager's two valid grant-write payloads return the fixed 403
contract: this identity has project read scope and never had grant authority.
After expiry, the same bearer receives fixed 401 contracts for identity, project
list, project detail, grant POST and grant DELETE. Authentication must reject
before authorization. Transport failures, expired-token 403s or changed response
contracts cannot satisfy this check.

The browser reselects the already loaded project after its cache becomes stale.
Its real detail request must receive 401 with the original bearer. The session-ended
alert and enabled organization sign-in appear, project names/details disappear,
and local/session storage remains empty. Customer, portfolio, project, grant,
audit and migration projections remain identical throughout; heartbeat changes
are excluded. This proves application cleanup after access-token expiry, not
termination of the IdP SSO session. Existing explicit provider logout remains
the separate proof of session termination.

Original browser responses/headers, DOM, storage and diagnostics use the existing
complete-response disclosure recorder. New API bodies/headers are checked against
generated secrets and the issued token. API and gateway output also joins the
existing host log checks. Tokens, hashes of tokens, response bodies and database
projections are absent from the canonical receipt.

`expiry-evidence.mjs` rejects stale run identity, missing/reordered phases, absent
pre-expiry authorization, incomplete denials, token replacement/refresh, missing
cleanup and unknown or payload-bearing channels. `scripts/test-production.mjs`
requires that receipt and exactly one new successful packaged result. The full
suite now has 17 packaged groups; missing or failed execution cannot publish a
successful canonical report.

## Validation and acceptance limits

All 99 unit tests, eight browser workflows, seven package builds, lint, types,
architecture, OpenAPI, 37 dependency records, documentation validation and all
13 documentation regressions passed locally. The five focused expiry/identity
tests also passed. The real local diagnostic uses existing images with
current scripts and compiled web assets mounted read-only, so a successful run is
functional diagnostic evidence only. Matching CI must rebuild immutable images,
pass both customer profiles and produce a verified downloaded evidence bundle.
Independent security and QA reviewers assess the exact final candidate before merge.

Local diagnostic `pdaa-acceptance-1788793107223-6fe1976f` passed all primary
TLS/identity workflows, naturally expired the token, required all five API denials,
cleared loaded browser data and verified disclosure. Its receipt records one token
exchange, authenticated/expired/cleared phases and unchanged database state. The
verifier exited zero and the uniquely named fixture was removed. It used existing
images and current scripts/assets, with the diagnostic limitation above.

The first local diagnostic `pdaa-acceptance-1788792704308-fe02a732` failed before
the wait at a new authenticated-page assertion. The page and detail panel both
use the project name as a heading; the assertion now selects the detail heading
explicitly. Existing TLS, login, logout, replay and operator checks passed in
that attempt, but it is not passing expiry evidence. Lint also identified a browser
global reference and a throw in cleanup; both were corrected without suppressions.
Cleanup preserves the first fixed failure, always closes the database and cannot
return passing evidence when cleanup fails. Lint and all 13 documentation
regressions pass after correction.

SEC-AUTH-001 already has implemented status; this adds evidence without accepting
AC-AUTH-001 or STORY-005. Issue #5, remaining identity/disclosure work,
customer-specific interoperability and distribution/signing gates remain open.
R0 remains 3/5 accepted (60%); R1 remains 0/33.

## Impact and recovery

Only acceptance helpers, regression tests and traceability/evidence documents
change. No application permission policy, fixture token lifetime, dependency,
schema/migration or connector scope changes. The isolated local fixture is removed
after the rehearsal and the original development database is preserved. Revert
this increment through review; no database rollback or customer action is needed.

## Verified merge and immutable evidence

[PR #28](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/28) merged
reviewed `0c9489fb24267b28a0976d628fc1e1bfef882b1a` as
`519c1926edbf1b391c0f8ad56d0b89741b3194c5`. Both independent exact-candidate
reviews and all three required checks passed. The downloaded acceptance run
`pdaa-acceptance-1788793939639-f68441af` and 63-file distribution bundle have
reviewed tree `43944f9512391579028d384eb24ed1be7f693530`. CI passed 99 unit,
nine database/API and eight browser tests plus 17 packaged groups; five images
across both customer profiles and eight browser components were verified.
The [final verification record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/28#issuecomment-5572894493)
links matching CI and reviewers. Distribution acceptance remains false.
The independent follow-up audit identified the two-portfolio authorization matrix
as the remaining generic identity evidence gap. Formal story acceptance remains
subject to its complete evidence and Definition of Done; customer activation is separate.
