# Temporal fact model validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6)
Plan: [EXEC-004](../04-delivery/exec-plans/EXEC-004-canonical-model.md)
Requirements: FR-EVD-001, FR-EVD-002, FR-EVD-003, FR-EVD-004, FR-EVD-006,
FR-EVD-007, FR-EVD-010, FR-EVD-012; ADR-009.

## Implemented boundary

`packages/domain/src/temporal-facts.ts` computes a historical temporal assessment
over validated, already authorized source-version snapshots. It retains typed
values, customer/project/fact scope, full source instance/type/record/revision,
effective and observed timestamps, evidence dependency IDs and validity-policy
revision. It uses no database, clock, model provider or connector. The existing
`assessFact` implementation is extracted unchanged into `fact-state.ts` and remains
available through its original package export.

Within each source stream the most recent effective version is considered first,
then observation time. Future observations/effective dates cannot replace earlier
applicable versions. Exact timestamp ties remain ambiguous; expiry never revives
an older version. Applicable here means temporal applicability only, not source
authority, authorization or a settled fact. The result contains no authority
winner or settled flag.

Validity uses the explicit source deadline and any configured duration/basis,
taking the earlier deadline. Missing validity remains unknown. Unresolved conflict
records are evaluated at the explicit historical time, including their detection
and resolution boundaries. A superseded, stale human version retains its origin
and unresolved conflict. Copied output is deeply frozen and does not share mutable
input values, evidence arrays or policy objects.

## Executable checks

`tests/temporal-facts.test.ts` currently has 64 passing domain cases: chronological
and late updates, observation/effective boundaries, ambiguous ties, full stream
identity, no revival after expiry, validity bases and exact expiry, unresolved
stale/superseded human conflict, historical resolution, immutable output, all four
provenance values and supported scalar types. Negative cases cover inconsistent
scope/policy/conflict references, duplicate identities and source revisions,
missing/duplicate evidence, invalid calendar/timestamps, malformed/oversized
values, duration overflow, conflict chronology, input bounds and caller-provided
authority assertions. All UUID input uses canonical lowercase representation.

Independent pre-review found that uppercase UUIDs could split a source stream or
bypass duplicate checks even though database UUID identity is case-insensitive.
The shared ID schema now rejects noncanonical forms before comparison. Seven new
regressions exercise version/source/evidence/policy/conflict identity and duplicate
case splits. Opaque source record/type/revision strings remain unchanged.

The initial 57-case component passed the full 577-test native suite, lint, types,
seven builds, architecture and OpenAPI checks. The local documentation wrapper
first searched the wrong directory and ran zero tests; the actual documentation
regression script then passed all 13 tests. That wrapper failure is not acceptance
evidence. On the corrected code all 584 tests in 25 files, lint/typecheck, seven
builds, architecture/OpenAPI, 38 dependency registrations, documentation validation
and all 13 documentation regressions pass. Independent correction replay checks
all 24 UUID positions and the four originally reproduced bypasses; no pre-review
finding remains. Immutable-candidate review, remote CI and fresh packaged-artifact
verification still gate merge.

## Remaining acceptance and recovery

This is partial domain evidence for AC-EVD-001/002/003/004. It does not complete
UNIT-EVD-002/003's broader API/display contract, integration/browser scenarios,
GOLDEN-003/013, any Issue #6 criterion or STORY-010/011/012. The test catalogue and
accepted-story counts remain unchanged. Durable append-only storage, trusted
origin/confirmation creation, current grant/evidence authorization, versioned
authority selection and policy activation, reconciliation and UI remain planned.

Every future service must check current evidence access before computation and
delivery, including copied values and frozen historical results. A schema-valid
snapshot does not prove authorization, source truth, durable immutability or
complete history. Evidence IDs are dependency references; their database scope
and disclosure require the later repository boundary. This component adds no
route, role, database migration, dependency or connector scope. No user-visible
workflow changed, so no new browser test is attributed to this component.

Packaged verification must bind the expected compiled domain files to immutable
Git source and preserve strict comparison of every other file. Windows working
tree line endings can alter unrelated emitted multiline strings; they are not
accepted runtime changes or a reason to normalize image evidence. Existing
notice, native scanner and distribution gates remain required.

Recovery is a reviewed application-code revert and rebuild. No data rollback is
needed. Preserve the existing development database, container, volume and VHD.
Issue #5 and all distribution/security/signing/customer-activation gates remain
open; this domain increment approves no customer release.
