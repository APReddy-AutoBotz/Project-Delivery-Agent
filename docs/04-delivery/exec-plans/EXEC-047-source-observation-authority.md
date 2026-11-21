# EXEC-047: Source observations in the fact ledger

Status: Draft
Owner: Implementation controller
Requirement IDs: FR-EVD-003/004/006/007/009/010/012, FR-ADM-005, FR-HLT-008/009, FR-QA-002/007, FR-CON-003/006/007
GitHub issues: #6, #7, #8, #12
Target release: R1
Last updated: 2026-11-21

## Objective

Carry a workbook-reported milestone state and Jira-reported required work from
durable ingestion evidence into the same authorized fact, health, PM
reconciliation, and leadership answer journeys. An immutable record must explain
why a version is SYSTEM_VERIFIED, which mapped source revision it describes, and
which evidence the current viewer may use. Keep source origin, freshness,
authority, and conflict independent as required by ADR-009.

GOLDEN-003 still requires the workbook Complete position, three explicitly
linked mandatory Jira issues that are Open, no rule settling the contradiction,
one durable request to the currently authorized PM, and a leadership answer
that retains both positions. AC-EVD-004, AC-HLT-005, and AC-QA-005 share that
test. INT-EVD-004, INT-HLT-005, and FAIL-009 keep their existing scope.

## In scope

Start with synthetic Jira issues and one explicitly configured XLSX portfolio
sheet in an isolated deployment. Use only mapped state fields of existing
milestones and required work items. The first implementation must include both
source admission and the consumers that interpret these origins. The proof
must cover the production-shaped ingestion and read paths. Fixtures supply
upstream observations. The normal ledger and assessment transactions produce
the facts and assessments.

## Out of scope

Public OAuth onboarding, live Jira activation, comment ingestion, connector
write-back, raw workbook retention, general fact promotion, generic Q&A, and
customer release approval are outside this increment. OD-013 and OD-014 apply.
CSV and XLSX import commits continue to save reviewed proposals. Original19/20
capture remains stopped. Other approved source types and connector stories
retain their scope.

## Current state

Base is verified main 359af5d83b27b9767f17424b698ed397e9d186e1 after PR #182.
The [ingestion plan](EXEC-009-read-only-ingestion.md#stage-two-preparation-and-integration-gate)
requires a coupled origin, stream, policy, proof, and presentation change. The
current ledger constrains ProjectFactVersion.provenance to HUMAN_CONFIRMED.
FactSource and FactEvidence carry human attribution. Fact history and multiple
SQL proof builders reconstruct human source keys and confirmation semantics.
The generic TypeScript authority resolver already recognizes SYSTEM_VERIFIED
with finite validity, but does not establish that origin.

The durable ingestion side already separates IngestionSource,
IngestionExternalRecord, IngestionFactStream, IngestionSourceRevision,
IngestionProposalProjection, retained proposal content, and operation
receipts. XLSX commits add the reviewed import and selected-row binding. The
[PM workflow](EXEC-007-milestone-reconciliation.md) and
[leadership answer](EXEC-031-bounded-milestone-question.md) exist, but their
current evidence does not establish workbook or Jira origin. Issue #6 still
has AC-EVD-004 open, Issue #8 has AC-HLT-005 open, and Issue #12 has AC-QA-005
open.

## Proposed design

### Bind a real source revision to a canonical fact

Record an immutable binding revision from a scoped ingestion stream to an
existing canonical state binding. Pin customer, project, typed canonical
target and field, ingestion source, record, fact stream, source kind,
configuration revision, mapping revision, and authority policy revision.
Use a narrowly typed mapping for an XLSX milestone state and a Jira
required-work state. Verify mandatory membership from the canonical link.
Resolve UUIDs on the server from configured IDs. Enforce composite foreign
keys for scope and target equality. A template, title, row number, external
name, or model output cannot resolve a target. A record can occupy only the
explicitly configured target slot. Remapping requires a new immutable binding
revision and keeps old facts attached to their original target.

Allocate a separate FactSource for each admitted canonical fact and ingestion
stream. Connection identity is a configuration and access boundary. It
cannot stand in for a per-fact source. Preserve canonical fact and source UUIDs
used by existing authority proofs. Use the FactSource UUID as the authority
selector instance. Use the bound stream UUID and immutable source revision UUID
in the typed temporal reference so arbitrary remote identifiers are outside
the temporal and public contracts. The retained witness pins the actual record
identity and upstream revision. Supersession occurs only within a stream.
Reject cross-target, cross-source, cross-revision, and mismatched fact-type
joins.

### Create a source-backed binding without a placeholder statement

The existing CanonicalStateBinding seal requires a revision-1 human fact
and its exact birth receipt. The authority policy guard also requires a
sealed reserved-state binding. Keep both human birth and its proof validator.
Introduce a versioned source birth of the same typed binding for an existing
milestone or work item with no state binding yet.

Use a distinct preapproved admission configuration for the scoped canonical
target and stream. Reserve the fact and source identities under the project
lock, verify the first source outcome, append its version and witness,
and seal the binding with its source birth receipt. At that point publish
the preapproved authority selector into the normal authority ledger in the
same transaction. The source birth verifier checks the admission decision,
witness and structural receipt independently of the active authority head.
A deferred activation guard additionally requires the exact published
authority revision, which removes the birth/authority validation cycle.
There is no externally visible provisional binding or fact. A concurrent
human birth or another activation loses the unique target race and must
reload the existing binding. On an already bound target append only through
the scoped admission capability, with the selector and binding both checked.

### Establish origin without human attribution

Represent the existing human statement and source observation as disjoint
origin variants. Existing rows keep their contents and existing human wire
shape. A source observation carries typed source kind, the immutable origin
witness, source/evidence/version identity, and admitted timestamps. It has
no confirmation timestamp, original human statement, or human author. Any
operator or service identity is scoped audit metadata about admission. The
human attribution and origin remain different parts of the contract.

On the relational path, add scoped unconditional evidence-to-source
referential integrity alongside the existing author foreign key. Allow the
human-only fields to be absent for the new variant, while constraints still
require all of them for the human variant. A new immutable witness table
links exactly one source evidence/version pair to the binding, scoped
retained projection field, source revision, and authorized ingestion
receipt. Native deferred validation must require exactly one matching
witness for SYSTEM_VERIFIED and reject a witness on a human version. Validate
both directions and bind the version value and timestamps to that witness.

For Jira require a sealed CONNECTOR_PAGE receipt with CONNECTOR_SYNC mode
and the connector:jira-runtime service identity. Verify the completed
scheduled job, its authenticated task dispatch, exact project sync grant
receipt, active configuration and generation, and the accepted jira.issue
outcome for the configured field, typed state mapping and immutable issue
revision. Reuse the proved service-scope joins from the ingestion assurance
handoff. Add a prospective immutable task-to-job lineage if the current
dispatch receipt lacks the required join. Deny legacy or unlinked results.
A user-submitted page, webhook payload, reset receipt or unrelated entity
projection does not establish Jira origin.

For XLSX require the exact sealed reviewed import, selected row, preview
lineage and retained accepted projection. A reviewed proposal is necessary
input for the workbook path. The manifest or review decision alone does
not grant fact authority.

Lock the proposal content and recheck current retention authorization,
expiry and redaction during a fresh admission. Native admission derives the
typed field commitment from the retained normalized field and its immutable
source/projection and receipt/row linkage. Commit the exact fact value,
witness, admission receipt and audit commitment together. Historical
validation ties all those fixed pins to the same ledger version, source
and evidence using its frozen codec. Preserve the trusted encrypted-backup
and ledger boundary. After lawful scrub, the two digests do not prove
membership in or recover the deleted payload. They preserve the native
admission record.

Require an explicit, previously approved basis for retaining the normalized
value in canonical history. Use synthetic data only in this increment.
Missing retention approval, expiry or redaction before first admission,
and missing scope or lineage deny admission. Neither the witness nor the
audit duplicates raw cells, Jira text, remote keys, or credentials. An
authorized exact replay after a later scrub returns only the admitted
receipt identity and status. No input content is revived.

### Use an explicit, confined admission transaction

Invoke a separate capability after ingestion with an immutable binding and
source outcome reference. Deny by default. An import, cursor advance, webhook
receipt, or connector job cannot directly publish by successfully ingesting
data. Use distinct publication authorization covering the precise fact type
and source/project pair. Reuse existing project, ingestion, and source-reader
policy checks. A connector token or upload grant alone conveys no publication
authority. Grant execution only to a dedicated synthetic acceptance role
in a disposable database and deployment. Omit the grant from every shipped
API, connector, scheduler and customer profile role. A feature setting
cannot add that privilege. Production enablement is a separate decision.

Acquire project, actor or service grants, configuration/source, binding, then
canonical fact locks in deterministic order. Audit existing mutation lock
order for overlap before selecting query locks. Co-lock multi-object inputs in
ascending stable identity order and recheck current generations, mapping and
all applicable permissions after waiting. The database admission function uses
a finite role and explicit project scope with no direct general fact inserts.
Serialize fact revision and exact evidence admission under the fact lock.
Commit fact, evidence, witness, operation receipt and minimal audit together.
On failure all roll back. Keep admission idempotency distinct from sync,
import, and source-revision idempotency.

Deduplicate by canonical target, stable ingestion stream and immutable
source revision and field across binding, mapping and policy revisions.
These are the temporal revision identity and its explicit scope. An
authorized repeat with the same admitted semantics returns the original
result after current access and authority checks. Any changed value,
source identity, timestamp or interpretation commitment for that revision
is a conflict. If remapping retires the binding, current use of the old
receipt is denied. Reusing a command key for different input is also a
conflict. Use separate checks for stable identity, command replay and
current admission authorization.

Reordering and concurrent human updates must not regenerate identifiers or
replace a frozen version. Keep the source effective time, trusted first
observation, and ledger admission transaction time distinct. Source
effective time ranks snapshots. First observation supports freshness and
cannot establish when the ledger knew the fact. The admission receipt pins
the server time and exact ledger revision under lock. As-of visibility
requires the observation and admission by the assessed time and membership
in the committed per-fact revision prefix pinned by that assessment. Take
the server as-of and committed prefix under the existing coordination locks
for current assessment. Historical mixed-origin evaluation reuses a frozen
as-of and committed prefix. This increment adds no arbitrary historical
point-in-time reconstruction from wall clock alone. A pre-admission
snapshot remains unchanged after delayed workbook review, and replays
refresh neither the observation nor admission.

Among visible source revisions in one stream, use validated effective time
only. Equal-order incompatible revisions remain ambiguous even when
retrieved at different times. Match this rule in TypeScript and native
proof validation and preserve the original human-only comparator. UUIDs,
lexical revisions, arrival order and workbook row positions do not settle
source ties. Missing or removed values and unknown time do not clear or
retire a fact. Model unavailable or stale current evidence explicitly.

Use source-specific, verified snapshot time. For Jira, keep the adapter's
persisted first observation and use the validated issue version time for
snapshot ordering. Issue updated does not establish when the status changed.
Reject a snapshot ordered after its trusted observation time and do not
infer a status-transition time or duration. For XLSX, require an explicitly
mapped UTC millisecond snapshot-time text field from the same retained,
reviewed row projection and validate it against the server's first receipt
time for that source revision. It dates the workbook's stated snapshot.
Neither upload nor review time substitutes for a missing snapshot time.
Keep both time bases in the witness, with a fixed bounded expiry under the
pinned authority policy. A later replay cannot refresh the first observation
or extend its expiry.

### Reuse authority and protect mixed-origin reads

Use the current authority selection model and source-specific finite validity.
Require a configured applicable selector and role-approved source policy. Pin
the rule revision and evaluation time. Preserve existing tier selection and
lower-tier human contradiction rules. Origin and approval do not resolve an
unresolved equal-tier conflict. Reuse the same origin decoder and native
validation in the authority assessment, canonical state, milestone, scalar,
health, and answer paths. An inaccessible or invalid candidate must fail
closed rather than revive an older claim or imply an absence of conflicts.

Keep all existing stored proof identities and JSON byte semantics. Select the
proof codec by a frozen proof-version discriminator or a legacy default for
older rows. Preserve the historical verifier and its recorded fact revision,
as-of and policy cutoff. Keep legacy and mixed origin codecs in parity
between native proofs and TypeScript. New proofs reconstruct all inputs from
scoped persisted facts and witnesses, including
scope across the complete temporal prefix and pinned authority and retention
decisions. Admitting a mixed-origin version must not make unrelated historic
human results unreadable. Readers with a deliberately human-only contract
must continue to fail closed on a mixed prefix until they have their reviewed
mixed-origin path. Restore validates both historical codecs without requiring
active credentials, access, or deleted plaintext.

Expose evidence type and bounded display labels through a typed history and
assessment union. Read and replay require the intersection of current project
authorization, FactSourceAccess and FactSourceReader, the current exact
IngestionConfigurationReader for that project/source, and the active binding
and publication scope. A change on either ACL side cannot grant the other
side or rehabilitate an older allowed version. Recheck the intersection for
every material claim, historical read, PM delivery and evidence-link
retrieval. A revoked grant or binding yields the existing restricted or
unavailable response. Frozen attribution and proof remain immutable.
Withhold upstream locators, raw receipts, credentials and private recipient
identity.

Build leadership answers from validated claim objects and claim evidence.
Each field can resolve under its own configured selector, while the
cross-object contradiction is CONFLICTING and presents both positions,
freshness and uncertainty without a settled winner. Reuse the authorized
manager command for one durable PM request and verify current-recipient
delivery. The separate dual-role matching-request status endpoint retains
its documented human-only boundary until separately extended. Use the
actual manager and recipient flows for the shared golden proof.

## Files and modules expected to change

- Prisma schema and one additive migration, with subsequent migrations only
  for separately reviewed corrections.
- Data repositories for project facts, authority assessments, canonical
  binding and milestone/scalar proof. Ingestion persistence stays the source
  of exact receipt and projection evidence.
- Shared origin/history contracts and temporal authority adapters in domain
  and API. Update generated API and browser decoders and evidence presentation
  together where mixed-origin facts can enter their normal paths.
- Native contracts, restore inventory and proof checks, production grants,
  packaged acceptance fixture, and browser journeys.

## Data model or migration impact

Keep all released migration inputs immutable. Pin scoped FK and unique keys,
discriminators, immutable ledgers, deferred commit guards and limited grants
in executable tests. Validate a populated released-prefix upgrade and repeat
old proof reading and recovery after the new version is installed.

Before DDL review, trace these current owners and distinguish legacy-only
commands from mixed-origin reads or proof forms:

| Boundary | Current owners to classify |
| --- | --- |
| Native origin and authority | Project facts, authority assessments, canonical projects, milestone consistency, scalar validation, atomic RAID reopen, blocker-age assessment and project-update migrations |
| Fact and proof readers | project-facts, milestone persistence/conflict/request/state-disagreement, scalar conflict/request, blocker-age advice/proof and project-updates in packages/data |
| Domain and wire contracts | temporal-facts, project-facts, evidence-responses, source-authority, authority-persistence and the related milestone, scalar, blocker-age and project-update contracts |
| Browser consumers | evidence display and forms, milestone and scalar decoders, milestone reconciliation and PM queue |
| Operational proof | Finite grants, schema/restore inventories, native guard checks, quarantined recovery, and generated OpenAPI |

Record whether each reachable entry point admits mixed evidence, deliberately
keeps its human-only meaning, or cannot receive these fact types. Verify
legacy behavior in native and wire tests. An origin-specific exception must
follow from the entry point's semantics, not from a missing decoder.

## Security and privacy impact

The admission capability and the evidence projection each enforce their own
current authorization. Sensitive retained material remains under existing
receipt retention and source ACLs. Logs, errors, metrics and audit expose
stable reason classes and permitted identifiers only. Enforce customer and
project isolation in native tests as well as at the HTTP boundary.

## Connector and permission impact

Existing Jira and spreadsheet scopes stay fixed. No connection activation,
upstream request, external message or upstream write is added. Review the
finite database role and its callable functions during implementation.
Separate source admission, authority administration, project read, source
read, and PM reconciliation capabilities.

## Open-source dependency impact

Reuse the current adapter, XLSX decoder, contracts, and database runtime.
No new library is required by this design.

## Implementation stages

1. Review the immutable design and inventory all affected proof and runtime
   contracts before allowing source facts into the ledger.
2. Add the coupled mixed-origin schema, admission transaction, authority and
   downstream proof codecs, and typed reads on a gated branch. Keep the change
   disabled outside the isolated workflow. Review the exact candidate
   against main before merge.
3. Connect the packaged synthetic Jira and XLSX flow to health, PM and
   leadership. Verify both database profiles and negative access cases
   through normal entry points.
4. Record exact candidate and main evidence. Review the shared golden result
   and other mapped tests before updating any acceptance or story totals.

## Test and evaluation plan

- Exercise both legitimate origins and wrong source scope, mapping, revision,
  proof type, projection value, or workbook selection at commit. Exercise
  inaccessible sources, expired content, stale guards and unmapped facts.
- Prove exact replay, mismatched command retries, races against revocation or
  remapping, concurrent human append and source admission, temporal ties, and
  rollback after any write fails. Include equal-order revisions arriving in
  both orders, same-revision replays across binding and policy changes,
  source-birth rollback before authority activation, and a previously
  captured assessment that excludes a workbook proposal admitted after
  that assessment. Verify the committed cutoff across an in-flight
  admission and replay. Assert no ingestion route automatically changes
  canonical facts.
- In GOLDEN-003, parse and review an actual synthetic workbook, obtain three
  source-authorized Jira issues through the adapter, and admit their exact
  durable evidence. Verify the linked mandatory items, typed origins, both
  positions, no winning classification, one durable PM request and eligible
  delivery, and the contemporaneous leadership answer on the same evidence.
  Both the cross-object signal and answer show CONFLICTING while keeping
  their two source positions. Verify current access after independent
  project, fact source and ingestion-source revocations on refresh, copied
  evidence URL, replay and request delivery. Assert no upstream mutation.
  Keep the independent INT-EVD-004, INT-HLT-005 and FAIL-009 checks.
- Prove clean native bootstrap, populated upgrade, grant audit, and encrypted
  recovery with old human and new mixed proofs. Include a lawful content
  scrub, origin-shape and invalid-witness denial, quarantined restore and
  redelivery under current authorization. Exercise both shipped database
  profiles and the existing standalone rehearsal.
- Require exact candidate independent review, lint, typecheck, unit, native,
  browser, build, Foundation and Documentation gates, verified merge tree
  and parents, and actual post-merge checks. Preserve original failures.

## Rollback and recovery

Disable the admission capability first. Retain accepted immutable facts and
prior proof codecs and use a compatible image to read them. A runtime from
before the mixed-origin decoder cannot safely serve a database containing new
origins. Use a forward compatibility correction or documented quarantined
recovery with the exact compatible image and encrypted backup. Recheck
scope, grant inventory, ledger and retained evidence before restoring
connectivity. No destructive downgrade or default development database use.

## Progress log

- 2026-11-21: Matched verified main and open issue criteria. Drafted the coupled
  admission, origin, authority, presentation, and proof design.
- 2026-11-22: Added a GOLDEN-003 scenario to the disposable XLSX customer
  rehearsal. It reviews a generated Portfolio workbook through the existing
  browser workflow, reads three required Jira issues through the adapter's
  synthetic transport, and uses their exact receipts for explicit admission.
  The browser checks the PM's durable request, exact retry, contributor reuse,
  leadership's current answer, and independent project and source withdrawals.
  The restore verifier checks both native proof codecs and the original
  reconciliation. The acceptance role is created and removed in the same
  synthetic database transaction. Both packaged profiles and the coupled
  release gates remain subject to successful execution and exact review.

## Decisions made

The existing proposal-only import contract and approved deployment boundaries
remain active. The draft selects a separate, explicitly authorized admission
path and preserves factual origin independently of review and authority.

## Risks and mitigations

The relational proof and wire contracts currently assume humans. Require
executable compatibility for old proofs and every reachable mixed-origin
consumer before allowing writes. Use typed joins and finite grants to prevent
tenant or record substitution. Require a complete, bounded authorized
snapshot to avoid treating missing data as a settled value.

## Validation evidence

Draft stage. Review and validation results will identify the exact candidate
and actual main merge where applicable.

## Completion summary

The design addresses the prerequisite for genuine source evidence in the
shared golden journey. Existing story and criterion status remains open
pending implementation and verified end-to-end evidence.
