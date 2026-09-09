# Project fact persistence validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6)
Plan: [EXEC-004](../04-delivery/exec-plans/EXEC-004-canonical-model.md)
Requirements: FR-EVD-001, FR-EVD-002, FR-EVD-003, FR-EVD-004, FR-EVD-005,
FR-EVD-009, FR-MOD-007, NFR-SEC-001, NFR-SEC-004, TR-STACK-005; ADR-009/010/013.

## Implemented boundary

The internal repository appends durable HUMAN_CONFIRMED statements to existing
projects, returns explicitly historical pages and manages source disclosure.
Seven additive tables retain immutable source streams, statements, typed versions
and actor/project idempotency receipts. The original 4,488-byte foundation SQL
remains SHA256 `9738bed726d754be02fb157ce2ee787def280d5e6e4c5319d778080d8b040aca`.
No existing project or historical fact is rewritten by migration.

Trusted server actors must intersect current scoped grants with their current
business roles. Source readers are a separate content permission. A restricted
history or retry retains only IDs/revisions and an explicit revalidation marker;
it cannot expose a cached value, original statement or author. History has a fixed
upper revision and bounded continuation. It is not a current/authoritative fact.

Append derives the human source and provenance, stamps server observation time,
and atomically creates evidence, version, counter advance, receipt and metadata
audit. Same-key retries recheck current permission. Expected revisions reject
competing writes. SQL enforces scoped references, scalar/date/text bounds,
monotonic revisions, original-history immutability and fixed project scope.
Reader insertion/deletion advances an opaque source-access counter independently
of the repository; a stale management request cannot resurrect a deleted reader.

Files span `packages/domain/src/actor.ts` and `project-facts.ts`, public exports,
the data repository and Prisma schema/second migration, operations business-table
grants, database/recovery tests and guarded packaged acceptance fixtures. Shared
actor exports retain their prior contract. No runtime dependency or connector
scope is added. There is no new route, UI, model tool, outbound action or ingestion
path, and no SYSTEM_VERIFIED assertion can enter through this human repository.

## Executed native checks and failure history

The focused domain/error suite passes 32 cases. Fresh/repeated PostgreSQL install
passes both migration checksums and the exact fourteen-business-table catalogue.
The 28 integration cases include 18 fact persistence cases and ten existing
foundation cases. They cover durable history, provenance, author streams, same-key
and optimistic races, role/grant intersection, same-customer other-project and
cross-scope references, source disclosure, fixed paging, immutable DML, scalar
round trips and all ECMAScript whitespace. Deterministic two-connection barriers
exercise grant deletion/role change and history/replay versus source revocation
in both winning orders. They wait for observed PostgreSQL lock contention.

The native backup/restore rehearsal compares every row in all fourteen business
tables and the complete migration ledger; source and restored rows match exactly.
Restored fact and audit UPDATE/DELETE/TRUNCATE attempts remain denied. Tests use
disposable synthetic databases and preserve the existing development database,
container, volume and Docker VHD.

The first integration attempt failed because a strict history request fixture
contained append-only fields. The corrected fixture passed 22 cases; subsequent
SQL and concurrency controls passed 28. Independent pre-review identified a raw
error from a failed denial audit, lossy arbitrary-precision SQL numeric values,
reader deletion without revision invalidation and space-only SQL blank checks.
All four corrections have executable controls. A Unicode-length hypothesis was
withdrawn after checking the pinned Zod code-point implementation.

The first full suite passed 615 of 616 tests; its architecture case detected
type-only import cycles through package entry points. Actor definitions were
extracted and the repository now imports its generated database type directly.
The architecture rule remains unchanged. The corrected full suite passes all 616
tests in 27 files, lint/typecheck and all seven builds. Architecture/OpenAPI,
38 dependency registrations, documentation validation and thirteen documentation
regressions also pass. Packaged results, immutable candidate review and downloaded
original-artifact verification remain merge gates before completion.

## Packaged acceptance and recovery contract

The acceptance fixture first creates the exact old foundation schema under
`pdaa_migrate`, populates all seven old tables, and captures the old migration
ledger. It then invokes the release migration as that owner, checks retained rows,
the unchanged old ledger and one new migration, empty new tables and finite ACLs.
It appends representative facts through `pdaa_api`, repeats migration without
replay, and rejects backup-role maintenance, ownership drift and unexpected
column grants. These are executed acceptance assertions, not product seed data.
Actual worker connections must receive PostgreSQL permission denials on history
SELECT/INSERT, in addition to the complete owner-side ACL catalogue checks.

Encrypted packaged backup/restore retains all old/new rows, immutable protections,
function/table ownership and runtime ACLs. Both shipped customer compositions
prove empty installation, populated current-release restart and quarantined
restore. The separate old-schema fixture supplies genuine forward-upgrade proof.
Stable heartbeat fixtures compare exactly; the live worker's restored timestamp
must lie between recorded source checkpoints. Application CONNECT remains denied
on restored targets. The production receipt embeds these detailed results.

A failed migration rolls back its transaction and successful-history entry. A
successful additive upgrade can retain data during a compatible application
rollback. For recovery from backup, use the matching reviewed image/migration list
in a fresh quarantined target, then the customer's separate promotion/change
procedure. Do not delete history or use a destructive down-migration.

This is partial evidence for Issue #6. Source-authority policy, canonical hierarchy,
multi-evidence ingestion, reconciliation, public API/browser journeys and full
story acceptance remain pending. R0 remains 3/5; R1 remains 0/33. Distribution,
license/notice, vulnerability/layer review and release-signing gates remain open.
