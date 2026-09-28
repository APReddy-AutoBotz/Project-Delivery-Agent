# EXEC-012: Project update freshness and completeness

Status: Draft — design candidate awaiting independent review
Owner: Implementation controller
Requirement IDs: AC-HLT-001/002, AC-UPD-001, FR-HLT-001/002, FR-UPD-001/002/003, NFR-REL-003, NFR-SEC-001/002
GitHub issue: #8 (EPIC-04, STORY-013..015); linked request behavior in #9
Target release: R1
Last updated: 2026-09-28

## Objective

Complete the authorized project-update freshness and required-fact completeness path on top of the existing pure evaluators. A stale configured update must produce one durable, explainable project obligation. The PM/owner view must identify the project context and exact missing or unconfirmed required facts. Server code resolves source authority and access; clients cannot choose source dates or submit health results.

This is a design candidate only. Do not change application code until a separate non-author reviewer approves the immutable design candidate. Preserve Issue #8, STORY-013..015 and accepted-story totals as open until the complete acceptance and all gates pass.

## In scope

- A versioned project reporting policy with an explicit freshness window, IANA time zone, complete required-fact set and one currently configured `RESPONSIBLE_OWNER`. No implicit default policy, owner or fact list.
- A server-authorized read that gathers every configured required fact and resolves current source authority at one database as-of time. Inaccessible, absent, stale, conflicting or otherwise unresolved evidence is shown only as unconfirmed. Spreadsheet/import proposals are never canonical inputs.
- Deterministic freshness and completeness results using the existing `assessUpdateFreshness` and `assessProjectCompleteness` contracts where they fit. Return the exact missing/unconfirmed field labels and reasons without disclosing unauthorized fact content.
- Durable, idempotent creation of the configured `PROJECT_UPDATE` obligation and audit event when its freshness rule becomes due. A repeated assessment or worker retry must not create a duplicate obligation.
- A bounded Graphile Worker scan of configured projects, plus authenticated, project-scoped read/configuration APIs and a small project/admin UI. The scan operates on server-selected policy/project rows, not caller-provided project IDs.
- An update request preview that names the project, distinguishes reported status from verified evidence, shows the source date and configured threshold, and lists the specific stale, missing or unconfirmed information.
- Additive migration, strict schemas, authorization and denial tests, migration/upgrade/recovery inventory updates and operator documentation.

## Out of scope

- Sending email, chat or Jira messages; reminders, escalation, response collection, interpretation, confirmation, satisfaction, delegation or closure. The durable due obligation is created here; dispatch and response lifecycle remain in the later EPIC-05 stages.
- Any live Jira OAuth onboarding or activation (OD-013), Jira comment read (OD-014), connector lookup, external write or new source scope.
- Treating a spreadsheet row, connector proposal, agent inference, project narrative, or user-supplied `effectiveAt` as a freshness clock or canonical value.
- Writing or promoting ProjectFact values while assessing freshness/completeness.
- AC-HLT-005/006, the Issue #8-only AC-HLT-007 extension, closure of Issue #8, acceptance of STORY-013..015 or any change to official accepted-story totals.

## Current state

- Live main at design start: merge `3b7d4ecffec7b0cdb910f718a05ba75d463c988c` (PR #94; its post-merge Foundation validation is still running and remains an independent gate).
- Issue #8 already records AC-HLT-003 accepted from PR #89 and AC-HLT-004 accepted from PR #91. AC-HLT-001, AC-HLT-002, AC-HLT-005 and AC-HLT-006 remain unchecked; AC-HLT-007 is present only in Issue #8 and is not in the canonical acceptance criteria register.
- PR #78 added the pure `assessUpdateFreshness` calculation. It compares an explicit latest-valid-update instant (or project creation if there is none) with a configured elapsed-seconds window and returns an explainable obligation descriptor plus a stable deduplication key. It intentionally does not persist or dispatch obligations.
- PR #80 added the pure `assessProjectCompleteness` calculation. It requires a complete configured fact list and one authority result per fact, and separates missing from unconfirmed fields without exposing values.
- Current main has no ProjectUpdatePolicy or UpdateObligation Prisma model, update-policy/admin route, update-obligation API, or update-obligation worker. `E2E-UPD-001` is planned. Existing ProjectFact histories and source-authority resolution must remain the only source for canonical update evidence.
- The canonical model already records project responsibilities, including `RESPONSIBLE_OWNER`; select only an existing scoped responsibility rather than accepting arbitrary recipients.

## Proposed design

### Policy and recipient

Add a customer/project-scoped, monotonically revisioned reporting policy. A revision contains the canonical required fact types and safe labels, elapsed freshness window, IANA time zone and selected responsible-owner subject. The API validates every type and label, requires a non-empty bounded complete list, validates the IANA zone, and confirms the recipient is the current `RESPONSIBLE_OWNER` on the same project. A `pmo_admin` with current project administration authority may create or revise it. No missing value is defaulted. Keep policy revisions immutable and audit each change.

### Source-authorized update time

Use a single database as-of time and the existing project/scope/source-reader gates. For each required type, obtain the current applicable authority result and its selected accessible version. Count a required fact as confirmed only when the authority result is current, resolved and conflict-free; otherwise report it as missing or unconfirmed per the existing completeness contract.

For this increment, define the server-derived `latestValidUpdateAt` as the oldest server-recorded `observedAt` among the current selected versions for the complete required-fact set. If any required fact has no current authorized selected version, pass `null`; the existing pure rule then uses canonical-project creation time. This is conservative: one recently edited field cannot make older required fields look freshly reported. Never use the user-provided effective date as the clock. Freeze the source-version IDs, source-access revisions, authority-policy revisions and observation instants used by the evaluation so replayed or displayed results are explainable.

### Due decision and durable obligation

Use `assessUpdateFreshness` with server-owned project/policy/source values and the database clock. The configured elapsed freshness window determines the due instant; the validated policy IANA zone is retained for the explanation and later cadence behavior. A stale result inserts one obligation in the same transaction as its audit event, keyed by customer, project, policy revision and the evaluator's stable deduplication identity. A unique database constraint plus idempotent retry returns the original open obligation. No worker or API endpoint sends the request in this increment.

Use `assessProjectCompleteness` over the exact policy fact set and one current authority summary per fact. Completeness is read-only: it cannot append facts, alter authority, resolve conflicts or count reviewed proposals. The result lists exact labels and reason codes; raw values remain subject to current source-reader authorization.

### Scheduling and presentation

Add a bounded Graphile Worker task that scans active configured policies in stable project order and processes a capped page per run. It creates obligations only through the same transactional repository operation used by an authenticated assessment; a retry is safe and a cursor resumes after restart. The internal task endpoint must use a dedicated signed worker-task capability, strict body/path checks and nonce replay protection. It cannot impersonate a project user or accept arbitrary project IDs.

The project view presents reported status separately from the update freshness result. Show the policy revision/window, as-of/source date, exact missing or unconfirmed labels, responsible owner and open obligation due instant. The request preview may include only project context and authorized current information; do not expose source values to a recipient who lacks source access. No notification is emitted.

## Files and modules expected to change

- `packages/domain/src/freshness-signals.ts`, `completeness-signals.ts` and shared strict update-policy/obligation contracts.
- `packages/data/prisma/schema.prisma`, an additive update-policy/obligation migration, generated Prisma output, and new repository modules with transaction, audit, uniqueness and current source-authority enforcement.
- `apps/api/src`: update policy, assessment and internal worker routes; dependency injection; generated/validated OpenAPI contract.
- `apps/worker/src/main.ts` and `tasks.ts`: named bounded scan task, cursor continuation, timeout/retry behavior.
- `apps/web/src`: project update freshness/completeness panel and PMO policy editor.
- `tests`: domain, policy, scoped authorization, persistence, race/replay, worker restart/retry and Playwright `E2E-UPD-001` coverage.
- `scripts/acceptance` and upgrade/recovery inventories as required by the repository validators.
- `requirements/traceability/tests.yaml`, `docs/04-delivery/IMPLEMENTATION_STATUS.md`, and this plan after evidence exists; update Issue #8 only after exact-head and post-merge evidence passes.

## Data model or migration impact

Additive only. Add immutable `ProjectUpdatePolicyRevision` rows and durable `UpdateObligation` rows scoped by customer and project. Enforce project/customer foreign keys, bounded JSON/array fields, explicit states, optimistic versioning and a unique deduplication identity. Keep obligation evidence metadata minimal; do not copy source fact values or response text into the obligation. Any needed assessment envelope must reference exact fact/version/evidence IDs and recheck source access on read. Update clean-install, repeat-deploy, failed-upgrade recovery, prefix-upgrade and restore inventories. Do not mutate existing migrations.

## Security and privacy impact

Every policy write and obligation read rechecks authenticated identity and current project/portfolio grant. Only a scoped PMO administrator can configure policy. A configured recipient must be a current project responsibility. Resolve source evidence under explicit policy and reader ACLs; return no value or source excerpt when access is absent or revoked. Strict API schemas reject client-supplied freshness dates, fact assessments, policy revisions and computed results. The worker has a separate least-privilege signed capability, bounded to the update scan route and operation. Log fixed event categories and IDs only; no raw fact values or original statements.

## Connector and permission impact

No connector scope or live source call changes. Existing human statements may participate only when current source authority and reader access resolve them. Jira credentials, OAuth routes and Jira comments remain governed by OD-013/OD-014. CSV/XLSX saves remain reviewed proposals and are excluded from both evaluators.

## Open-source dependency impact

No new runtime or development package is planned. Continue using TypeScript, PostgreSQL and Graphile Worker.

## Implementation stages

1. **Design gate:** independent non-author review of this immutable plan SHA. Resolve all review findings before implementation; no application code in this stage.
2. **Implementation:** add policy/revision storage, scoped server resolution, durable deduplicated obligations, bounded scheduled scan and UI. Preserve the existing pure evaluator contracts unless an approved plan amendment explains a necessary change. Open one implementation PR against the resulting main.
3. **Validation and review:** exact-head independent implementation review; hosted Foundation `verify` and `production-boundary` plus Documentation `validate`; resolve failures on a new exact candidate and rerun relevant gates.
4. **Merge and ledger:** merge only the reviewed SHA with an expected-head guard; wait for post-merge Foundation and Documentation runs. Then attach exact candidate/merge/test/run evidence to the traceability registry, implementation status, ExecPlan and Issue #8. Check AC-HLT-001/002 only when all required evidence passes. Keep Issue #8 and stories open unless their full remaining criteria independently pass.

## Test and evaluation plan

- Preserve `UNIT-HLT-001` and `UNIT-HLT-002` boundary, malformed-input and deterministic-order cases.
- Add repository tests for policy revision conflicts, arbitrary/removed recipients, missing project scope, complete fact-set enforcement, current source-policy resolution, source-reader revocation and proposal exclusion.
- Add obligation tests for threshold boundary, project-creation fallback, stale/current transition, stable deduplication, simultaneous scan collision, audit atomicity, retry after API/worker restart and bounded cursor continuation.
- `E2E-UPD-001` must configure an authorized project policy and responsibility, supply synthetic human-authorized source facts, cross the configured freshness boundary, run the scheduled path, and show one persisted obligation plus its project context and exact missing/stale information. Include no-authority/revoked-reader and incomplete-required-set cases; they cannot claim a valid update or disclose protected values.
- Run applicable lint, typecheck, unit/integration, build, Playwright, migration/restore and documentation validation through hosted checks on the exact candidate.

## Rollback and recovery

The additive migration keeps existing project facts, authority policy and health assessments unchanged. If policy or scan behavior fails, disable the update scan task and revert policy activation through a new audited revision; retain obligation/audit history. Do not delete customer evidence or roll back immutable fact history. On migration failure, stop upgrade and use the existing backup/restore runbook before resuming. Restore tests must prove no notifications are replayed because this increment creates none.

## Progress log

- 2026-09-28: Live main inspection confirmed AC-HLT-003 and AC-HLT-004 are already accepted; AC-HLT-001/002 remain open. The current source contains only the pure evaluators and no obligation storage or update workflow. Started this design gate from main merge `3b7d4ecffec7b0cdb910f718a05ba75d463c988c`.

## Decisions made

- Use server-owned `observedAt`, never client-provided `effectiveAt`, as the freshness clock.
- A complete update set uses its oldest currently selected server-observed version time. Any missing/unconfirmed required field makes `latestValidUpdateAt` null, preserving the already implemented project-creation fallback. This avoids a recent update to one field concealing stale required fields.
- A due obligation is durable state only in this increment. Notification and response flows remain in the approved later engagement sequence.
- User-visible “current known position” must preserve reported-vs-calculated and provenance/freshness/conflict dimensions; it cannot be presented as a canonical fact merely because it appears in a request preview.

## Risks and mitigations

- **Wrong authority or stale-source leakage:** resolve each configured fact at one as-of time, require current source access, disclose only labels/reasons to unauthorized readers, and test revoked-access responses.
- **Duplicate or skipped obligation:** same transaction, stable deduplication identity, unique constraint, bounded cursor and retry/race tests.
- **Arbitrary recipients:** select and recheck one configured `RESPONSIBLE_OWNER`; do not accept free-form email or subject identifiers.
- **Misleading freshness:** use system-observed fact times and the oldest required current fact; distinguish missing, unconfirmed and stale results and label all policy inputs.
- **Unintended external effect:** prohibit dispatch in this scope, including from the scheduled task; verify zero outbound calls in hosted acceptance.
- **Scope drift:** do not check AC-HLT-005/006 or Issue #8-only AC-HLT-007 in this stage; reconcile that criterion against canonical acceptance change control separately.

## Validation evidence

Design-stage checks and independent review are pending on the exact candidate SHA. No implementation or acceptance claim is made by this plan-only change.

## Completion summary

Pending design review. This plan does not mark AC-HLT-001/002 implemented or accepted.
