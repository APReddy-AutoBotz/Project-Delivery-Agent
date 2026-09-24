# EXEC-009: Read-only source ingestion

Status: In Progress
Owner: Implementation controller
Requirement IDs: FR-CON-001/002/003/004/005/006/007/009/010/011/012,
FR-MOD-007, FR-EVD-001/002/011, NFR-SEC-001/002/004/005/006/008,
NFR-REL-001, NFR-MNT-002, TR-JIRA-002, TR-TEST-003
GitHub issue: #7 (EPIC-02, STORY-006..009)
Target release: R1
Last updated: 2026-09-22

## Objective

Ingest explicitly scoped Jira and spreadsheet observations into the existing
versioned evidence model without enabling external writes or inventing authority.
The current implementation batch is the synthetic-only internal read contract and
mapped CSV dry-run core. It is not the complete ingestion workflow or story acceptance.

## In scope

- This batch: tool-neutral read ports, bounded runtime schemas, exact scope/cursor/
  record validation, finite failure/retry advice, strict CSV parsing and explicit
  mapped row-level proposals, with synthetic adapter and adversarial tests.
- Subsequent batches: approved scoped Jira adapter, encrypted atomic OAuth rotation,
  durable cursor/event/sync health, authentic replay-safe webhooks and reconciliation;
  authorized CSV/XLSX upload, preview and explicit import commit with provenance.
- Shared tests retain the whole AC-MNT-003 identity/sync/cursor/duplicate/permission/
  throttling/unknown-outcome contract. This read-only subset does not satisfy it alone.

## Out of scope

No live-source activation, external write/message, approval or resolution action,
AI provider, leadership answer, new infrastructure or Antigravity redesign.
This batch adds no API, upload, database schema, credentials, worker, network call
or XLSX library. Proposal/approved execution/reconciliation ports remain outstanding;
there is no caller-controlled approval boolean.

## Current state

The scalar integration merged through PR54 as `ddbafb4` with its own exact-head
gate and [acceptance record](../../05-quality/SCALAR_RECONCILIATION_VALIDATION.md).
All nine applied migrations must remain immutable.
Issue #6 and shared GOLDEN-003 remain open; ingestion does not waive their health/
leadership-answer behavior. Accepted totals remain R0 3/5 and R1 2/33.
Issue #7 permits synthetic fixtures while real source credentials are unavailable.

## Proposed design

Use only the existing domain package and Zod. A trusted application supplies the
customer/source binding and allowed projects separately from adapter results.
Internal helpers check consistency, not actor authorization. Future repositories
and API must enforce current actor/service/source permissions before invoking them.
Records preserve exact customer/source/project/type/key identity, source revision,
effective/observed times and typed proposals. They assert no evidence provenance.

Read pages allow at most 100 records and 32 unique fact types per record. Input
cursor must match; a continuing page is nonempty and advances to a distinct non-null
cursor; a terminal page has null next cursor and may be empty. Duplicate detection
is per-page only, not persisted or cross-page idempotency. Deep links remain data:
canonical absolute HTTPS, no userinfo, same configured origin, no fetch/navigation.
Finite read retry advice permits only rate-limit/temporary-unavailability failures,
honors Retry-After up to 24h and allows at most 5 attempts. Unknown outcomes do not retry.

CSV parsing accepts one leading BOM, comma delimiters, CR/LF/CRLF, quoted newlines/
delimiters and doubled quotes. Reject stray/unclosed quotes, trailing junk after a
closing quote, duplicate/blank headers, ragged rows, NUL and lone surrogates.
Headers are exact; no locale, trim or implicit field mapping. String input only;
no implicit lossy byte decoder. Bound code-unit length before UTF-8 allocation.
Limits: 1MiB UTF-8, 1000 data rows, 64 columns, 4096 code units/cell, 32 mapped fields;
1000 baseline rows, 100 distinct project UUIDs. IDs are canonical UUIDs; record/fact
type 96, external key 256, revision 128, filename/sheet/header 256, cursor/link 2048.
Array size guards run before element parsing. Limit failures reject the complete
preview, not an apparently safe truncated result. Maps handle prototype-like names.

Mappings specify distinct columns and fact types, an explicit row-key column and
project UUID column, exact mapping revision, type and required flag. Dates reuse
the existing calendar/value schema (no year 0000); booleans are true/false. Numbers
must round-trip exactly through Number/String, be finite and within safe magnitude,
and use canonical non-exponent decimals (no plus/leading zeros/trailing fractional
zeros/-0/whitespace). Invalid numeric fields return INVALID_NUMBER. This preserves
decimal round trips, not exact binary rational arithmetic. Formula-like text is
invalid, never evaluated. Optional blank is preview-only MISSING, no fact or clear;
required blank is invalid. Real zero/false are retained.

Baseline binds customer/source/sheet/mapping revision and allowed projects, contains
unique keys/fact types with matching mapped types, and never implies authority.
Stable row identity is customer/source/sheet/key; changing a key's project is invalid.
Comparison ignores row/column order and display filename; it compares present typed
fields only. Missing optional fields never clear a previous value. All-optional
empty rows produce UNCHANGED when known, otherwise NONE.

Rows are INVALID when fields/identity/project fail; unmatched new keys become
REVIEW_REQUIRED if any prior key is missing or another row has untrustworthy
identity/project. Both statuses have operation NONE and no fact proposals. There
is no fuzzy/positional match. Valid rows otherwise propose CREATE/UPDATE/UNCHANGED.
Without a baseline, CREATE is explicitly BASELINE_ABSENT and unapproved. Missing
previous keys are review information only; omission never proposes deletion.
CREATE describes a new source-row proposal, not automatic creation of a canonical
project. Project IDs must already be in the trusted allowlist. Reported row numbers
are logical CSV records including the header, not physical lines inside quoted cells.

## Files and modules expected to change

- packages/domain/src/connector.ts and spreadsheet-preview.ts; index exports.
- tests/connector.test.ts, spreadsheet-preview.test.ts and synthetic read fixture.
- This plan, implementation status, document index and evidence/acceptance records.
- Later stages will add connector adapters, persistence, worker/API/UI boundaries
  only after their concrete data/permission design and independent review.

## Data model or migration impact

None in this batch. Later additive tables must define observation revision identity,
import run/rows, cursor CAS, dedupe receipts, health and atomic credential rotation;
extend finite ACL/recovery inventories and prove restart/recovery. Never rewrite an
applied migration or impersonate a human to publish source observations.

## Stage 2 durable proposal design and implementation

This section records the durable proposal design and its additive local
implementation. The implementation checkpoint below tracks validation and
independent review. This stage persists connector-page/event and CSV-preview
proposals only. It does not publish canonical facts, change the evidence/history
contract, run a worker, accept live webhook authenticity, store credentials,
expose an API route, or enable an external write.

### Identities and durable records

- `IngestionSource.id` is the connector-instance identity. A domain
  `connectorBinding.sourceId` resolves to this ID; it is not a `FactSource.id`.
- An immutable configuration revision stores source type/origin, normalized
  mapping definition, the exact customer/project allowlist and a per-project
  source-reader list. Its current revision is authoritative. `pmo_admin` must
  hold a current project or portfolio grant for every project being added;
  project reassignment of an existing external key is rejected. Mapping revision
  increments only when mapping semantics change; configuration revision also
  increments for scope or reader changes.
- An external record is unique within customer, source instance, record type and
  external key. For CSV, record type is exactly `spreadsheet:` plus the exact
  configured sheet name; identity is customer/source/sheet/row key. Sheet and key
  use exact validated Unicode strings; filename, row order and column order do
  not participate. Its first project binding is immutable. A per-fact stream is
  a separate stable ID unique within that record and fact type; changing a
  mapping revision does not silently create a second stream.
- Source revision and mapped projection are separate identities. A source
  observation revision is unique within the external record and retains the
  opaque source revision, source-content digest, remote observed/effective times
  when provided, and server receive time. The digest is computed over the
  connector's bounded canonical source fields before mapping; it contains no raw
  payload. Same revision plus the same source digest is replay; the same revision
  with a different source digest is an integrity conflict. An immutable mapped
  projection is keyed by source revision plus mapping revision and retains its
  own normalized proposal digest and typed proposals. Replaying the same mapping
  revision must match that digest; a new mapping revision creates a new
  projection against the same source revision without changing its source
  identity or stream IDs. Opaque source revisions are equality keys only. CSV
  rows use a deterministic SHA-256 over the sorted exact header/value pairs as
  both source revision and source-content digest, independent of mapping and row
  order. The server receive time is the CSV observed time; no effective time is
  invented.
- Operation receipts have their own identity and kind (`CONNECTOR_PAGE`,
  `CONNECTOR_EVENT`, `CSV_PREVIEW`, `SYNC_RESET`), actor, command key/hash,
  optional event key, exact config/mapping revisions, outcome count, and safe
  audit reference. Unique
  command key is `(customer,source,actor,kind,key)`; event key is `(source,event
  ID)`; source revision is `(external record,opaque source revision)`; projection
  key is `(source revision,mapping revision)`. These command, event,
  source-revision, projection and cursor compare-and-swap checks remain
  independent. Same command key with changed payload fails; same event ID with
  changed payload fails; event replay under a new command key returns the
  original event result after current authorization.
- Per-run row outcomes retain row ordinal, finite state/operation/error codes,
  stable identity where trustworthy, stream/revision references and typed
  proposals. Persist no original CSV bytes or raw cell strings. The CSV byte
  digest and normalized preview are sufficient for exact retry and review.

### Authorization and locking

Configuration is `pmo_admin` only; connector-page/event persistence and CSV
preview persistence require current `project_manager`, `portfolio_manager`, or
`pmo_admin` grants on every affected project. Proposal reads and all replay
responses require a current read grant on every affected project, including
`leadership`, plus an independent current per-project source-reader grant in the
active source configuration. A source-reader grant conveys no project access;
a project grant conveys no source-content access. Configuration project
allowlists, source-reader entries and current customer/project grants are checked
in the transaction; actor roles supplied by the application must also match the
current database grant. Removed projects and source-reader revocations deny old
proposal content. No service or worker principal is added in this stage. This
local source-reader ACL is not proof of current upstream Jira visibility; the
future live adapter must independently recheck source-side permission on every
sync and before any disclosure of source content.

Mutations acquire locks in this order: project rows sorted by customer/project
UUID; matching AccessGrant rows sorted by grant ID; source/configuration row;
external-record rows sorted by record type/key; then stream/revision/projection,
cursor generation, receipt and outcome rows sorted by stable identity. The
AccessGrant `FOR SHARE` row lock is what serializes against an update/revoke of
that grant: an operation that locks first completes before revocation, while an
operation that checks after revocation sees no grant. Project rows are still
locked first for stable project/portfolio resolution. Reads hold project/grant
share locks through content selection. Replays authorize the full original scope
before any receipt data is returned.

### Atomic progress, bounds and health

A page command includes current configuration revision, expected cursor revision,
expected sync generation, exact input cursor, command idempotency key and
validated page. Cursor revision is a never-reset monotonic counter; an explicit
reset increments both generation and cursor revision under the same source-row
lock/CAS as page persistence. Reset has its own command receipt, actor, audit and
replay hash. A late page from an earlier generation is rejected. A single bounded
transaction verifies config and grants, checks command/event/revision collisions,
persists external identities, streams, observation revisions, outcomes, receipt
and audit, then compare-and-swaps cursor/revision. Any failure rolls back the
entire page and cursor. A terminal page enters an explicit terminal state; only
an explicit, permission-checked sync reset starts another generation. Config or
mapping changes invalidate the old cursor and require that explicit reset.

CSV previews persist up to 1,000 outcomes atomically. `INVALID` and
`REVIEW_REQUIRED` rows are retained with finite codes and no proposals; valid
rows retain typed proposals. Optional missing cells, omitted rows, absent
baselines, uncertain identities, and key/project changes never clear, delete,
adopt, or publish a fact. An oversized or malformed upload rejects the complete
preview. The existing 1 MiB input limit applies; the canonical serialized page
and preview have a separate 4 MiB ceiling before database work.

Safe synchronization health stores only a finite state/code, server timestamps,
and last successful receipt. It never stores raw exceptions, URLs beyond the
validated origin, tokens, or source snippets. Denial audits contain only the
operation and finite error class. Source data and typed proposals are visible
only through these current-scope services and follow customer source-data
retention policy; no audit event copies row content. Proposal content is stored
separately from immutable receipt/row metadata, with a customer retention-policy
revision and expiry timestamp. New source/import persistence fails closed when
the customer has not configured proposal-content retention; this design does not
choose a customer retention duration. Expired or administratively purged content
is replaced by a one-way tombstone while its receipt, digest, identity and finite
outcome status remain. A later shorter retention policy applies retroactively
from each receipt's creation time; read services hide newly expired content
immediately, and purge physically redacts it. Policy changes never restore
already purged content. A narrow redaction path is allowed only after expiry;
restore purges expired content in quarantine before application access. Retention
policy changes and purge runs are audited without row content. Encrypted backup
retirement still follows the customer's configured backup-retention policy. A
`system_admin` may configure retention and invoke purge without gaining content
read access; no AI or worker role can read or purge source content.

### Schema, native enforcement and recovery

Use one additive tenth migration; preserve all nine released migration bytes.
The migration adds source/configuration/project, external-record, fact-stream,
observation-revision, mapping-projection, receipt/outcome/content and retention
policy tables. Composite foreign keys bind customer/source/project/record/stream/
revision/projection/receipt scopes. Sealed configuration and receipt headers
have deferred native validators. At COMMIT the receipt validator requires
actual outcome count to equal its declaration, contiguous ordinals from 1,
complete same-scope source/revision/projection/stream references, and an audit
event matching the exact actor, operation, scope, digest and count. Append-only
guards prevent post-seal mutation/delete/truncate; the sole content exception is
the expired one-way redaction path. API-role COMMIT tests reject omitted outcomes,
wrong audit, orphan and cross-scope rows and prove full rollback. Only the API
role receives exact required table/column grants and validator execution; the
worker and backup principals receive no business write privileges. Restore
re-applies exact grants, redacts expired content while quarantined and checks all
new native invariants before releasing quarantine.

Validation includes actual API-role `COMMIT` and rollback probes, independent
connection races for duplicate command/event/revision and cursor CAS, grant and
configuration-reader revocation, mapping remap, page/reset/terminal replay and
restart/retry behavior, clean/repeat migration, a
genuine populated released-nine upgrade with byte/checksum and row preservation,
isolated encrypted recovery profiles, and exact row/ACL/constraint inventory.
The additive migration and implementation are present locally; database-backed
validation and final design review are still required before this work can be
treated as accepted. These outcomes remain proposals, not `SYSTEM_VERIFIED`
evidence, and do not close an Issue #7 story or acceptance criterion.

## Security and privacy impact

Untrusted source content is parsed as data, never code or model instructions.
Finite errors exclude raw third-party exceptions/secrets. No new disclosure route,
actor permission or activation decision. Synthetic scope helpers are not an access
control service. Subsequent real-data work retains EPIC-01/security release gates.

## Connector and permission impact

No connector scopes or external calls added. First-party read-only interfaces hide
SDK types. Adapter selection must verify current official contracts and licences.

## Open-source dependency impact

None. Existing Zod only; no CSV/XLSX/Jira dependency or vendored source added.

## Implementation stages

1. Reviewed read/CSV core and meaningful unit/synthetic-port tests (current batch).
2. Reviewed additive ingestion/source-event/import persistence and scoped services.
3. Synthetic Jira read adapter, encrypted refresh and durable webhook/reconciliation.
4. Authorized CSV/XLSX upload/preview/commit and admin journeys preserving styling.
5. Native/package/customer-profile/upgrade/recovery matrix and full Issue #7 review.

## Test and evaluation plan

Run focused parser/preview/connector tests, full lint/typecheck/units/build,
architecture and documentation checks; independent immutable candidate review and
exact-head hosted checks before merge. Include same-source scope drift, duplicate/
cursor/expired-token/permission/throttle/unknown-outcome cases; CSV bounds-before-
entry-access, quote/Unicode/prototype cases, changed/reordered keys, no deletion,
optional blanks, zero/false, date and precision-loss failures. This batch has no
new browser/database boundary; do not label unit checks as end-to-end import proof.
Later stages require genuine API/browser, migration/recovery, safe token rotation,
restart, missed-event reconciliation and both shipped customer-profile execution.

## Rollback and recovery

Revert the isolated internal modules/exports/tests through a reviewed commit. No
stored data changes in this batch. Later persistence needs additive-compatible
reverts or encrypted restore into a fresh quarantined database; never delete history.

## Progress log

- 2026-09-23: approved the stage-two durable proposal design after independent
  review at section SHA256
  `3dcc2f58a4d0762b0a351a3265b45bed08e4f7661216216b014975091a8ad563`.
  Review blockers for source-revision/mapping projection identity, exact sheet
  identity, COMMIT completeness, retention/redaction and cursor-reset fencing
  were resolved. A follow-up found and fixed the missing `SYNC_RESET` receipt
  kind. Source-reader ACL remains distinct from project grants; live upstream
  authorization and all story acceptance remain outstanding.

- 2026-09-22: approved Issue #7/master-plan/architecture/ADRs and requirements read.
  Independent design review corrected identity ambiguity, optional blanks, finite
  budgets, cursor/link semantics and numeric precision before implementation.
  Resolved design report SHA256 259259b3effe4f36852c253d30ddc371d6a93481b7bfd8c1dedaa0940722dbe8.
- Code prepared in ignored staging while PR54 remained unchanged. Formative source
  review corrected negative subunit numbers, specific numeric errors and added a
  typed synthetic port fixture. Final tracked validation/review remains separate.

## Decisions made

Implement synthetic-only internal core first; no secret is needed for it. Preserve
the full approved ingestion scope and acceptance gates rather than declaring this
partial contract a finished connector. Conservative identity ambiguity requires
review; do not infer renamed IDs or clearing from missing data.

## Risks and mitigations

Partial helpers could be mistaken for authorization/live conformance: comments,
tests, API absence and acceptance records explicitly prohibit those claims.
CSV formula/presentation content remains untrusted. There is no export-safety claim.

## Validation evidence

Focused tracked tests pass 103/103 across two files (3.16s), including a synthetic
ReadOnlyConnector fixture. An explicit strict TypeScript no-emit compilation of
both tests and that fixture passes. Full workspace typechecking, production lint
and separate test/fixture lint pass. Documentation validates 245 requirements,
91 acceptance criteria, 38 stories and 135 test specifications; those catalog
counts are not executable-test counts.

The first default-parallel full unit run passed 1,473, failed four tests and skipped
nine after an API contract setup timeout (74 files, 99.31s). The five affected
existing files are unchanged: API contract/health/operations hit existing hook/test
limits, while production configuration and startup disclosure had empty subprocess
output at their 15-second boundaries. All 22 tests in those five files then passed
serially unchanged (61.17s). A pnpm shorthand invocation rejected forwarded worker
options before starting tests; the retry invokes the same full Vitest command
directly with one worker and no file parallelism. No assertion or deadline was
relaxed. The complete serial run then passed all 1,486 tests across 74 files in
265.01s. All seven package/application builds passed; architecture verified seven
packages and 62 source files. Final documentation and diff checks passed. The
earlier failures remain recorded; scheduling was the only test-run adjustment.
No browser/database workflow was added in this internal-only batch, so no new
local browser/database run is claimed. At this local-validation checkpoint, fresh
hosted baseline checks and independent immutable final-SHA review were still required.
The verified stage-one gate below supersedes that pending status; earlier scalar CI
belongs to its own SHA.

## Completion summary

The internal read/CSV batch merged through PR55 as `937fee1` on 2026-09-22 after
immutable review and both exact-head hosted workflows passed. No Issue #7 story
is accepted. Real Jira, XLSX, persistence and user-facing ingestion remain subsequent
stages of this same approved increment.

## Verified stage-one merge

Candidate `e5b03c368bb8a0c4f587067298c3be4e3a75bc4a`, tree
`c94b0f7ad6b646d40ec1bb76f94bdbccb12d8f71`, base `ddbafb4` merged as
`937fee1e03d9d6dd8bb4499f11f15c34500acd93`. Actual ordered parents/tree, all 16
changed raw files, all nine unchanged migrations and stylesheet blob
`2c726e6f827cba390c3a5218d997c31a4a415fd3` were verified after fetching main.

Documentation run 35724176434 and foundation run 35724176449 passed. Hosted native
results: 1,486 units across 74 files (17.66s), 127 integrations across eight files
(42.28s), 32 browser journeys (1.1m) and isolated 42-table recovery. Packaged primary,
bundled and external profiles passed; originals include 18 scalar temporal cases,
six genuine prior-prefix upgrades, three encrypted quarantined restores, two customer
scalar UI receipts and 144 milestone native COMMIT observations. Primary-only natural
expiry used a 120-second token; first protected browser denial was 962ms after expiry
and clearing completed 149ms later. These are fresh PR55 results, not ancestor evidence.

Independent source/governance and current native/production/distribution reviews
passed. Root read all sealed reports and verified their hashes. All five original
archives and metadata bind the exact candidate/CI merge; final receipt SHA256 is
`98cd45011743c1568d61febfdf7b2e658cd99ced2b3dc774a4ee889ac204570f`.
The [final gate](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/55#issuecomment-5776515613)
records full source/report/archive pins and review limits; the
[postmerge record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/55#issuecomment-5776534840)
records actual integration. Main-triggered repeats are separate and not claimed here.
Reviewers replayed pure readers on originals, not producers, SQL or browser tests.
Distribution evidence passes but release remains blocked by all five existing gates;
802 unresolved High/Critical scanner occurrences are not 802 distinct exploits.

## Stage-two preparation and integration gate

Branch `codex/durable-ingestion-persistence` begins at the verified merge. A separate
read-only integration audit identified the next persistence boundary; its report
SHA256 is `069096b0ff3365153413755889a0d78fb7896fa26df1ae526534aae694969ed2`.
The [Issue #7 preparation record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7#issuecomment-5776181946)
retains this finding without claiming a completed schema or source publication.

The next coherent scope is durable permission-checked source/import proposals,
row outcomes, command/event/revision deduplication, atomic cursor progression and
safe health state. Define current actor/service authorization, explicit configuration
and mapping revisions, deterministic project/grant/source lock order, replay hashes,
cursor CAS and whole-batch failure behavior before the additive migration. Preserve
missing-cell/row no-clear/no-delete behavior and renamed-key review requirements.
Include native COMMIT/denial/race/restart tests, a genuine populated-prefix-nine
upgrade, finite ACL/table inventories and all three encrypted recovery profiles.

Existing fact history, authority/canonical/scalar SQL proofs, response schemas and
UI labels assume human statements. A connector instance can own many records and
per-fact streams; it cannot substitute for existing FactSource identity. Durable
proposals must not call appendHumanStatement under an invented actor or self-assert
SYSTEM_VERIFIED. Publishing source observations requires a reviewed coupled origin,
stream, policy, proof and presentation change preserving all old frozen histories.
No schema/role design is approved solely by this risk audit; no new runtime change
or acceptance is claimed. The full later Jira/OAuth/webhook/XLSX/upload/commit scope
and existing Antigravity design remain unchanged.

## Stage 2 implementation checkpoint, 2026-09-23

The independently reviewed Stage 2 design is implemented locally through an
additive tenth migration containing 14 ingestion tables and a scoped data-layer
repository. It persists bounded connector/CSV proposals, row outcomes, configuration
and mapping revisions, command/event/source-revision deduplication, cursor/reset
receipts, independent current project-grant and source-reader authorization, and
audited retention redaction. Existing fact history remains unchanged and receives
no connector proposals as published evidence. No API endpoint, live adapter,
credential flow, worker privilege or external write was added.

The serial database-independent unit suite passes 1,489 tests across 74 files.
Prisma schema validation/generation and strict TypeScript checks pass. Local
PostgreSQL migration/integration probes, populated-prefix-nine upgrade and
encrypted recovery validation are pending because the Docker service is unavailable.
The default `pdaa` database was not used. Implementation, Issue #7 acceptance and
story totals remain separate: native database validation, independent exact-code
review and matching CI are still required before this checkpoint can advance.
## Stage 3 Jira issue reader checkpoint, 2026-09-24

This synthetic-first increment adds `@pdaa/connectors-jira` as a connector-package
adapter over the approved `jira.js` SDK. Explicit internal-project/Jira-key mappings
bound project discovery, JQL issue search and direct record lookup. Only configured
scalar fields are projected into typed, hashed proposals. The adapter rechecks
project identity, same-origin links and first-party page/cursor contracts, and maps
SDK failures to finite redacted classes. Ten synthetic contract cases cover
connection, scope, permissions, projection, paging, lookup and failure redaction.

No API or worker invokes the adapter. There is no live account, OAuth callback,
refresh-token persistence, webhook, scheduled reconciliation, sprint/comment/full
changelog/link normalization, source-fact publication or write method. The existing
proposal persistence path is not yet wired to this reader. AC-CON-001/002/003 and
AC-MNT-003 remain incomplete; no Issue #7 story or acceptance total changes. No new
database migration is needed for this adapter-only boundary; the already merged
Stage 2 proposal tables remain as previously documented. Next is independent exact-
candidate review, complete relevant CI and PR integration, followed by the separate
OAuth/webhook/reconciliation and spreadsheet-upload increments.
