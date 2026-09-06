# ADR-013: Foundation operations jobs

Status: Accepted under delegated controller authority; exact implementation review required
Date: 2026-09-06
Requirements: TR-DEP-001, TR-DEP-003, TR-DEP-004, TR-STACK-005, NFR-MNT-005, NFR-AVL-001, NFR-AVL-002, NFR-SEC-003, NFR-SEC-004, NFR-SEC-005

## Decision

Provide a separate first-party TypeScript operations package and OCI job for
provisioning, migration, backup and quarantined restore. Reuse the approved pg,
Graphile Worker and platform configuration dependencies. Keep Prisma for runtime
repositories and development migration generation; do not ship its development
CLI/Studio closure or adopt a new migration-library dependency.

The release migration adapter executes complete reviewed PostgreSQL SQL files on
one connection, under Prisma's pinned advisory-lock key and a transaction per
file. Keep one migration history using the pinned Prisma 7 ledger contract;
verify interoperability in both directions. Reject incomplete/unknown/divergent
history and future nontransactional migration forms until separately designed.
This is an explicit deployment adapter exception to repository-only business
data access. Application/domain boundaries remain unchanged.

Provision only an explicitly confirmed database target. Keep migration, API,
worker and backup roles separate; runtime roles cannot own the business schema.
Initialize Graphile through its public migration API and revoke temporary
database CREATE afterward. Customer configuration contains no synthetic projects.

Back up all application and Graphile schemas with PostgreSQL 17 tools. Encrypt
the archive with a separate mounted AES-256-GCM key and authenticated metadata;
publish only a completed encrypted file. Never pass passwords in command arguments
or inherit libpq connection/TLS overrides. Verify TLS independently for libpq.

Authenticate the complete backup before invoking restore. Restore into an
explicitly confirmed empty database with runtime CONNECT revoked, including the
PUBLIC grant. Reconstruct reviewed ownership and grants while keeping runtime
access quarantined; never overwrite the source or automatically resume workers.
Preserve the credential-encryption key separately. Full reconciliation of later
external actions remains STORY-036 and cannot be claimed by this foundation drill.

Use container restart policies, bounded readiness and worker progress checks.
Unexpected failures emit fixed diagnostics and terminate for supervised restart.
Exercise database connection loss only in the isolated acceptance deployment.

## Limits

PostgreSQL 17 is the initial supported operations target. Image signing, complete
OS/transitive notices and vulnerability disposition remain STORY-004 release
gates. These jobs are implemented and tested locally/CI without activating a
customer installation or approving commercial distribution.

Sources: [PostgreSQL backup](https://www.postgresql.org/docs/17/app-pgdump.html),
[restore](https://www.postgresql.org/docs/17/app-pgrestore.html),
[advisory locks](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).
