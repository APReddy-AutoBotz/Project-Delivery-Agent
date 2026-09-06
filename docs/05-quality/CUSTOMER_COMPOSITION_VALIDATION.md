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

## Evidence and limits

Implementation is under validation; exact candidate review, matching remote CI and
merge are required before STORY-003 acceptance. The successful production artifact
must contain both customer profiles, their immutable application image IDs and all
five phase receipts for each profile. Only successful teardown of every owned
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
