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
local browser/database run is claimed. Fresh hosted baseline checks and independent
immutable final-SHA review remain required. Existing scalar CI belongs to its own SHA.

## Completion summary

The internal read/CSV batch is implemented and locally validated, pending immutable
review, fresh hosted checks and merge. No Issue #7 story is accepted. Real Jira,
XLSX, persistence and user-facing ingestion remain subsequent stages of this same
approved increment.
