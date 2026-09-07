# OIDC configuration acceptance

Date: 2026-09-07
Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5)
Requirements: FR-ADM-001, FR-ADM-002, FR-ADM-003, TR-AUTH-001, TR-AUTH-003, TR-DEP-003, NFR-SEC-001
Criterion: AC-ADM-001; supporting AC-AUTH-001/002
Specification: INT-ADM-001
Plan: [EXEC-003](../04-delivery/exec-plans/EXEC-003-customer-hosted-foundation.md)

## Scope

This increment starts from merged `2a9882f` on
`feature/oidc-configuration-acceptance`. Production configuration already maps
OIDC groups on each authentication. The missing evidence was an operator changing
that mapping through the documented environment file on an unchanged application
image. It does not introduce a new administration UI or live configuration reload.

The bundled customer profile runs the configuration rehearsal after its initial
browser grant and before backup. The external profile retains its existing
installation, identity, upgrade and restore checks. Both still use the same
application images. A sixteenth packaged acceptance group requires the new result.

## Executable behavior

`scripts/acceptance/customer-identity.mjs` signs in through the real fixture IdP
and retains one access token only in verifier process memory. The browser context
closes after its outputs are scanned. Subsequent HTTP requests reuse the same
token without refresh or another login.

`customer-identity-host.mjs` changes only `OIDC_GROUP_ROLE_MAP` in the operator
environment file, then recreates only the API with `--no-deps`. It verifies a new
API container ID, the same image, an unchanged environment apart from that mapping,
and unchanged worker, web, database and identity-service container IDs. API logs
are captured before each replacement. The original environment file is restored
even when the probe fails; the enclosing disposable fixture is then torn down.

For mapped, removed and restored phases, the probe matches public OIDC metadata
to the operator settings and requires `/api/me` HTTP 200 for the original subject.
Administrative roles disappear only in the removed phase. `/api/platform` and
`/api/audit` must return 403 then, and 200 before and after. Project enumeration
remains empty because operational administration grants no implicit business scope.

While the mapping is removed, valid POST and DELETE requests target an existing
project grant and must return 403. Customer, portfolio, project, grant, audit and
migration projections stay identical throughout. A 401 or expired token cannot
satisfy the test. The customer-only IdP fixture issues ten-minute tokens for this
rehearsal; host and verifier share one six-minute absolute deadline. Customer production token
lifetimes remain IdP policy.

Atomic coordination markers contain only run, profile, random session and phase.
`remapping-exchange.mjs` rejects missing, malformed, stale and failed markers.
The host requires ordered completion receipts and verifier exit zero. Container
ownership is checked before targeted removal. Canonical receipts validate every
field and permit only counts in known disclosure channels; they contain no token,
token hash, raw response or database projection.

The new HTTP bodies/headers and browser outputs are scanned against generated
secrets and the issued token. Deployment configuration, every replaced API's logs
and verifier output join the existing runtime disclosure checks. Private diagnostic
files are excluded from uploaded artifacts.

## Validation and acceptance limits

- `tests/identity-configuration.test.ts`: coordination failures, receipt identity,
  required denials, completed phases and count-only evidence.
- `tests/production-config.test.ts`: malformed mapping JSON, unknown roles and
  invalid mapping shapes reject with a fixed error that omits submitted values.
- `scripts/acceptance/customer-identity.mjs` and `customer-identity-host.mjs`:
  real OIDC, configuration-only recreation, permission checks and disclosure.
- `scripts/test-production.mjs`: requires the successful bundled-profile receipt
  before publishing its canonical sixteen-group acceptance report.

All 97 unit tests, eight browser tests, seven package builds, lint, type checking,
architecture boundaries, OpenAPI contract and 37 dependency records passed locally.
Documentation validation and all 13 documentation regressions also passed. Matching
CI results, downloaded immutable evidence and both exact-candidate reviews are
required before merge and recorded on the PR. Root owns implementation and Git;
`review_customer_candidate` reviews security and `baseline_quality` reviews QA.

Early QA found that the later upgrade compared against an API ID from before
remapping, and that a control wait was shorter than an allowed API recreation.
The upgrade now records all runtime IDs immediately before maintenance. Host,
verifier, requests and phase waits use the same absolute deadline; a regression
checks that phases cannot renew it. The first existing-image local diagnostic
stopped at the earlier browser sign-in and did not execute remapping. A second
probe with current compiled web assets reproduced the stop; timestamps show
Keycloak finishing realm startup after sign-in had already been attempted.
Customer installation now waits for HTTP 200 discovery with the exact configured
issuer over trusted HTTPS. Invalid metadata fails, and startup retries have a
finite deadline. Neither failed diagnostic is passing evidence.

The corrected local run `pdaa-acceptance-1788760096347-a625fa44` passed installed,
before-upgrade and mapped/removed/restored configuration checks. The original
token remained valid, two writes were denied without database changes, both API
replacements retained the image and other configuration, and dependency containers
were unchanged. The verifier exited zero and the uniquely named fixture was
removed. This probe used existing images and current scripts/compiled web assets
mounted read-only; it is functional diagnostic evidence, not immutable release
evidence. All ten focused configuration/readiness/coordination tests passed.

INT-ADM-001 is registered as implemented, which is not a passing execution claim
or acceptance of AC-ADM-001/AC-AUTH-001/002. STORY-005, customer-specific identity
interoperability and existing distribution gates remain open. R0 remains 3/5
accepted and R1 remains 0/33.

## Verified merge record

[PR #27](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/27) merged
reviewed `3b88a846f9c3f2f0e3f91d6c80d1f06e00b63f13` as
`71b4e6df1972b379660500237c6a159e6ad46232`. Both non-author reviews passed.
[Foundation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34089107999)
and [documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34089108087)
passed with 97 unit, nine database/API, eight browser tests and 16 packaged groups.
All 63 downloaded evidence files match reviewed tree
`ca8035764e84a3cb2e63fad9447c72afd80378d1`; the full immutable record is on the
[PR](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/27#issuecomment-5565987075).
Merged-main CI also passed. Earlier pending-check wording records the pre-merge
sequence; the acceptance limits above remain unchanged.

## Impact and recovery

Changes are confined to acceptance helpers, test-only fixture lifetime, negative
tests and traceability/operations documentation. No application runtime policy,
schema/migration, dependency or connector scope changes. Existing local data is
preserved. Operators apply role mappings through the environment file and API
recreation; restore the previous mapping and recreate the API to reverse a change.
Revert this test increment through review; no database rollback is required.
