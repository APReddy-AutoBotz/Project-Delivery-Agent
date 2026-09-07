# Two-portfolio authorization acceptance

Date: 2026-09-07
Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5)
Requirements: FR-ADM-003, NFR-SEC-001, TR-DATA-003
Criterion and specification: AC-AUTH-002 / SEC-AUTH-002
Plan: [EXEC-003](../04-delivery/exec-plans/EXEC-003-customer-hosted-foundation.md)

## Evidence gap and implementation

This increment starts from merged `519c192` on
`feature/portfolio-authorization-acceptance`. The existing repository test grants
the only portfolio containing Atlas and Draco. It proves inclusion and revocation,
but cannot distinguish another portfolio belonging to the same customer. Existing
HTTP administration coverage grants projects. No runtime authorization defect was
demonstrated; this change adds the missing portfolio boundary evidence.

The new SEC-AUTH-002 case in `tests/database.integration.test.ts` creates two
additional portfolios with one project each in the existing guarded synthetic
test database. The manager retains its seeded Atlas project grant. Using the same
issued development-fixture token throughout, the manager sees exactly Atlas before
the administrator grants portfolio A through HTTP; afterward it sees exactly Atlas
and A's project. Both HTTP and repository reads return A's complete expected detail,
exclude B from enumeration and return the fixed nondisclosing 404/null for B.
The operational administrator has no implicit business scope at any phase.

While A's grant is active, valid manager attempts to grant B or revoke A return
the fixed HTTP 403 contract. Repository calls reject both operations independently.
The complete grant and audit projections must remain identical after each denial.
An authorized HTTP revocation then removes A's list/detail access while preserving
Atlas. Each successful HTTP mutation must append exactly one audit record with the
expected actor, customer, action, exact scope detail and returned request ID; all
previous audit rows remain unchanged. The final grant projection equals the baseline.

Setup is transactional and uses unique portfolio/project IDs. Cleanup targets only
those IDs and retains immutable audits. Existing project grants and all earlier
integration tests remain intact. Real OIDC verification belongs to the separate
packaged fixture, including PR #28's natural expiry rehearsal; this database test
does not substitute a development token for production identity acceptance.

## Validation and acceptance gates

Local validation passed 99 unit tests, ten database/API tests, eight browser
workflows, seven package builds, lint, types, architecture/OpenAPI and 37 dependency
records. Documentation validation and all 13 documentation regressions passed.
The final typed fixture reran the entire ten-test isolated suite successfully.
Clean/repeat migration preserved the existing ledger; no migration was added.
Independent review and matching CI remain pending. Before merge, require a
non-author review of the exact candidate, all
required remote checks, and downloaded immutable evidence verification. The full
packaged suite retains 17 groups and both shipped customer database profiles.

The independent acceptance audit supports criterion-level acceptance of AC-ADM-001,
AC-AUTH-001/002 and AC-SEC-001/003 only after this increment's exact review, passing
CI, verified evidence and merge. The complete mapping and conditional decision are
in [FOUNDATION_SECURITY_ACCEPTANCE.md](FOUNDATION_SECURITY_ACCEPTANCE.md).
STORY-005 remains in progress because the Definition of Done's high/critical
security assessment is unresolved. Scanner matches require applicability/severity
assessment; they are neither automatically proven exploitable findings nor evidence
of their absence. Customer-specific activation and STORY-004 distribution/signing
remain separate. R0 stays 3/5 (60%); R1 stays 0/33.

## Impact and recovery

Only tests and traceability/validation documents change. There is no application
permission-policy, dependency, schema/migration or connector-scope change. The
original local development database is preserved; rehearsal databases are uniquely
named and guarded. Recovery is a reviewed revert without a database rollback.
