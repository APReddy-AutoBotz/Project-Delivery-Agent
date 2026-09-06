# Customer composition validation

Requirements: TR-DEP-001/003/004, NFR-AVL-001/002, NFR-PORT-001/002/004,
NFR-SEC-003/005, NFR-MNT-005; supporting TR-AUTH-001 and FR-ADM-001/002/003.
Issue #5, STORY-003, AC-DEP-001/002, DEP-001/002; ADR-011/013; EXEC-003.

## Executable contract

`scripts/test-production.mjs` builds immutable API, worker, web, operations and
test images. After the existing production suite and its teardown, it invokes
`scripts/acceptance/customer-host.mjs` for bundled and external PostgreSQL 17.
Each profile uses `deploy/customer/compose.yaml` and, for the bundled profile,
`deploy/customer/bundled-database.yaml`. A separate env file contains generated
nonsecret settings. The caller's matching environment variables are removed so
the operator env file actually controls the composition.

`deploy/acceptance/customer-fixtures.yaml` only adds controlled identity, identity
TLS ingress, verifier and external database services. The harness compares every
resolved shipped service before and after this overlay and rejects any override.
It verifies the running application image IDs, restart policy, no database host
port, and absence of a bundled database in the external configuration. No source
code is mounted into application or test containers. No host trust store changes.

`scripts/acceptance/customer.mjs` checks the following against both profiles:

1. Provision and repeat; customer-mode installation, verified database TLS,
   pgvector, completed migration history, readiness and worker progress. No demo
   projects, portfolios, grants or audit rows are created by provisioning.
2. Real browser OIDC login at a separate issuer; operator has no implicit business
   scope. Only after the empty installation check, a guarded fixture adds synthetic
   project data. Operator grant/revoke creates audit records and controls a real
   project manager's browser view. Provider logout crosses the configured origin.
3. The actual least-privilege backup service creates an encrypted archive. Stop
   API/worker; a wrong target confirmation fails and leaves them stopped. Apply the
   current release as the migration account, recreate runtime containers using the
   same images, and verify preserved customer/data/grants/audit/history plus fresh
   worker progress. The database container remains unchanged.
4. Restore through the shipped operations service into a new same-cluster database.
   Compare restored state to the pre-backup snapshot, deny API/worker CONNECT and
   verify that the running source retains its later revocation and audit records.

## Verified acceptance, 2026-09-06

[PR #22](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/22) merged
independently reviewed `c669e950312025df10e7c1bed591d41d176a8a5c` as
`27bc174a0ba59553f60a26d53a3cec37c2de8873` at 2026-09-06T17:03:34Z.
[Application/production CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34046645663)
and [documentation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34046645695)
passed. Evidence run `pdaa-acceptance-1788713340023-00402c5c` completed after all
teardown at 2026-09-06T17:02:06.999Z, with 13 packaged groups and both complete
customer profiles. Its clean source `775f8329d89e1cbbce597c57bd9e7417d9ed4d1e`
and reviewed candidate share tree `ee569146f85b774c6c0d142204c6e099015cdb6c`.
The saved artifact is `artifacts/pr-22-c669e95/production-acceptance.json`; the CI
run retains `production-boundary-evidence` with five immutable image IDs and
`distributionAccepted: false`. Both customer profiles used identical application IDs.

Native CI passes 33 unit tests, nine database/API tests and seven browser workflows
(49 native), seven builds, lint, typecheck, architecture/contracts/dependency gates,
audit, migration and recovery. Documentation validation and 13 validator regressions
pass. Review corrected a heartbeat cutoff taken before shutdown: the accepted test
requires a new heartbeat after replacement-runtime verification begins.

DEP-001/002 now have complete direct composition evidence. SEC-TLS-001 combines
these shipped-ingress positive paths with the same run's browser hostname denial,
wrong CA/hostname/plaintext database denials, migration TLS and untrusted JWKS-host
denial, plus the documented synthetic-only loopback HTTP boundary. The controller
accepts STORY-003 and AC-DEP-001/002 / AC-SEC-002 under delegated authority after
review, matching checks and merge. R0 is 3/5 (60%); R1 remains 0/33 (0%). Issue #5,
STORY-004/005 and customer/commercial release remain open.

The local packaged build failed before starting acceptance containers because its
host drive filled and Docker reported an I/O error. That run is failed evidence;
CI supplies the successful immutable verification. Cache cleanup recovered 333 MB
without removing databases. Docker restart timed out and local database readiness
remains unavailable; local data integrity must be checked after the host recovers.
This host incident does not replace or invalidate the independent CI result.

## Evidence and limits

The successful production artifact contains both customer profiles, their immutable
application image IDs and all five phase receipts for each profile. Only successful teardown of every owned
project permits publication of the canonical artifact. Raw diagnostics, private
fixtures and operator env files are not uploaded. Existing 11 production groups
remain, with two additional customer-composition groups.

No business schema, application permission policy, runtime dependency, connector
scope or external action changes. Tests use synthetic data in customer mode; they
do not activate a customer installation. Current-release redeployment does not
prove a future schema upgrade, Podman support, customer-scale capacity or an
untested IdP registration. Image distribution and remaining identity gates stay
open; `distributionAccepted` stays false. STORY-036 post-backup external-action
reconciliation remains separate from this foundation restore drill.

Recovery: revert these test/documentation changes; retain existing customer data.
The operator runbook retains previous reviewed images and fresh-target restore
with separately held keys. Isolated acceptance deletes only its generated project
volumes and preserves the local development preview and database.

Design references: [Compose merge rules](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/),
[one-shot commands](https://docs.docker.com/reference/cli/docker/compose/run/),
[Keycloak hostname configuration](https://www.keycloak.org/server/hostname).
