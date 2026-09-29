# EXEC-012: Project update freshness and completeness

Status: Completed — implementation and required acceptance complete
Owner: Implementation controller
Requirement IDs: AC-HLT-001/002, AC-UPD-001, FR-HLT-001/002, FR-UPD-001/002/003, NFR-REL-003, NFR-SEC-001/002
GitHub issue: #8 (EPIC-04, STORY-013..015); linked request behavior in #9
Target release: R1
Last updated: 2026-09-29

## Objective

Complete the authorized project-update freshness and required-fact completeness path on top of the existing pure evaluators. A stale configured update must produce one durable, explainable project obligation. The PM/owner view must identify the project context and exact missing or unconfirmed required facts. Server code resolves source authority and access; clients cannot choose source dates or submit health results.

The design candidate was independently approved at PR #95 head `985a394d350d680d4661be7c4fb2e398407613f4`. Implementation, acceptance tests and hosted validation are complete. Preserve Issue #8, Issue #9, STORY-013..015 and accepted-story totals as open; this increment only supports the scoped acceptance criteria listed below.

## In scope

- A versioned project reporting policy with an explicit freshness window, IANA time zone, complete required-fact set and one currently configured `RESPONSIBLE_OWNER`. No implicit default policy, owner or fact list.
- A server-authorized read that gathers every configured required fact and resolves current source authority at one database as-of time. Inaccessible, absent, stale, conflicting or otherwise unresolved evidence is shown only as unconfirmed. Spreadsheet/import proposals are never canonical inputs.
- Deterministic freshness and completeness results using the existing `assessUpdateFreshness` and `assessProjectCompleteness` contracts where they fit. Return the exact missing/unconfirmed field labels and reasons without disclosing unauthorized fact content.
- Durable, idempotent creation of the configured `PROJECT_UPDATE` obligation, its persisted request-preview draft and audit event when its freshness rule becomes due. A repeated assessment, worker retry or policy revision must not create overlapping active obligations.
- A bounded Graphile Worker scan of configured projects, plus authenticated, project-scoped read/configuration APIs and a small project/admin UI. The scan operates on server-selected policy/project rows, not caller-provided project IDs, and requires the separately configured scheduled-action service identity and service policy mandated by RBAC.
- An immutable, persisted update-request-preview draft that names the project, distinguishes reported status from verified evidence, shows the selected source-time basis/date and configured threshold, and lists the exact stale, missing or unconfirmed information. It references authorized source versions instead of copying raw fact values, and it is never sent in this increment.
- Additive migration, strict schemas, authorization and denial tests, migration/upgrade/recovery inventory updates and operator documentation.

## Out of scope

- Sending email, chat or Jira messages; reminders, escalation, response collection, interpretation, confirmation, satisfaction, delegation or closure. The durable due obligation is created here; dispatch and response lifecycle remain in the later EPIC-05 stages.
- Any live Jira OAuth onboarding or activation (OD-013), Jira comment read (OD-014), connector lookup, external write or new source scope.
- Treating a spreadsheet row, connector proposal, agent inference, project narrative, or user-supplied `effectiveAt` as a freshness clock or canonical value.
- Writing or promoting ProjectFact values while assessing freshness/completeness.
- AC-HLT-005/006, the Issue #8-only AC-HLT-007 extension, closure of Issue #8, acceptance of STORY-013..015 or any change to official accepted-story totals.

## Current state

- Live main at design start: merge `3b7d4ecffec7b0cdb910f718a05ba75d463c988c` (PR #94; its post-merge Foundation and Documentation validations succeeded before this plan was opened).
- Issue #8 records AC-HLT-003 accepted from PR #89 and AC-HLT-004 accepted from PR #91; AC-HLT-001 and AC-HLT-002 remain unchecked. Issue #9 also tracks AC-HLT-001 and AC-UPD-001, and both map to E2E-UPD-001. AC-HLT-005 and AC-HLT-006 remain unchecked; AC-HLT-007 is present only in Issue #8 and is not in the canonical acceptance criteria register. AC-UPD-002, which requires sending only to the configured owner, is a separate dispatch criterion and remains out of scope here.
- PR #78 added the pure `assessUpdateFreshness` calculation. It compares an explicit latest-valid-update instant (or project creation if there is none) with a configured elapsed-seconds window and returns an explainable obligation descriptor plus a stable deduplication key. It intentionally does not persist or dispatch obligations.
- PR #80 added the pure `assessProjectCompleteness` calculation. It requires a complete configured fact list and one authority result per fact, and separates missing from unconfirmed fields without exposing values.
- PR #96 implemented the versioned policy/revision model, scoped APIs/UI, source-authorized assessment, persisted obligation and immutable value-free preview, signed bounded scheduler, additive migration, and upgrade/recovery inventory. PR #97 fixed raw-body capture for the signed internal scan and completed scheduled-path E2E-UPD-001. Existing ProjectFact histories and source-authority resolution remain the only source for canonical update evidence; import proposals are excluded.
- The canonical model already records project responsibilities, including `RESPONSIBLE_OWNER`; select only an existing scoped responsibility rather than accepting arbitrary recipients.

## Proposed design

### Policy and recipient

Add a customer/project-scoped, monotonically revisioned reporting policy. A revision contains the canonical required fact types and safe labels, elapsed freshness window, IANA time zone and selected responsible-owner subject. The API validates every type and label, requires a non-empty bounded complete list, validates the IANA zone, and confirms the recipient is the current `RESPONSIBLE_OWNER` on the same project. A `pmo_admin` with current project administration authority may create or revise it. No missing value is defaulted. Keep policy revisions immutable and audit each change.

### Source-authorized update time

Use one database `asOf` time and the existing project/scope/source-reader gates. For each required type, resolve the current authority result, selected accessible version and the temporal basis explicitly selected by the active source-authority policy. Count a required fact as confirmed only when the authority result is current, resolved and conflict-free; otherwise report it as missing or unconfirmed under the existing completeness contract.

Derive each fact's freshness timestamp from the immutable evidence/version selected by that authority policy. For a `human_statement`, always use server-stamped `FactEvidence.observedAt`; ignore caller-supplied `effectiveAt`, even if syntactically valid. For connector-backed facts, honor the active selector's explicit `effectiveAt` or `observedAt` basis. An `effectiveAt` qualifies only when the connector adapter validates it as the source's update/last-modified instant; if the selected basis is `effectiveAt` and it is absent, untrusted, future-dated or otherwise invalid, mark the fact unconfirmed for freshness and do not fall back to ingestion time. `observedAt` is the server time the exact evidence/version was first observed. Re-reading unchanged source data must reuse its evidence/version identity and original `observedAt`; it must not create a new fact version or restamp the observation. Display whether the time is source-updated or server-observed so collection time is not represented as a source update.

`CanonicalProject.createdAt` records when the canonical row was created, not when the real project began, so a trusted connector update can legitimately predate it. The current `assessUpdateFreshness` contract rejects `latestValidUpdateAt < project.createdAt`; amend that evaluator invariant to require only that `project.createdAt <= asOf` and a non-null trusted `latestValidUpdateAt <= asOf`, without the lower-bound comparison. Preserve the resolved source timestamp unchanged: do not clamp it to canonical row creation or replace it with ingestion time. Add a regression where validated connector `effectiveAt` predates canonical project creation and produces staleness and the threshold from that older timestamp.

Define server-derived `latestValidUpdateAt` as the oldest qualifying timestamp across the complete required-fact set. If any required type lacks a current authorized selected version, a trusted timestamp under its active selector, or source-reader access, pass `null`; only this no-trusted-time case uses canonical-project creation as the pure evaluator fallback. Freeze selected version/evidence IDs, source-access revisions, authority-policy revisions, timestamp bases and exact instants so replayed or displayed results are explainable. A delayed-ingestion test must prove that an old connector update remains old when the active policy selects its validated `effectiveAt`; an observed-time policy intentionally measures first server observation and must be labeled as such.

### Due decision and durable obligation

Use `assessUpdateFreshness` with server-owned project/policy/source values and the database clock. For each assessment, calculate `freshnessThresholdAt = (latestValidUpdateAt ?? canonicalProject.createdAt) + freshnessWindowSeconds`; supply that ISO instant as the pure evaluator's required `policy.obligationDueAt`. The evaluator's existing strict boundary is authoritative: exactly at the threshold the project is `CURRENT`; it becomes `STALE` only when `asOf > freshnessThresholdAt`. The returned obligation `dueAt` is this freshness-threshold instant, when the update first became due. It is not a response deadline, grace period or dispatch time; response deadlines and notifications remain in the later EPIC-05 work and are not modeled here. The validated policy IANA zone is retained for explanation and later cadence behavior.

A stale result inserts one obligation, the persisted request-preview draft and their audit event in the same transaction. Keep the evaluator's revision-specific deduplication key as the exact assessment/retry identity, but enforce a separate active slot unique to customer/project, independent of policy revision. Under a project-policy transaction lock, reuse an open obligation only when the current stale cycle has the same source-date field/value, threshold, responsible subject and sorted required-fact set; append the reassessment audit and a preview revision. If a new revision changes any of those cycle-defining inputs, atomically supersede the old obligation and preview, then create a replacement only if the current evaluation remains stale. If the project is no longer stale, supersede the old open obligation and create none. A partial unique database constraint allows at most one open project-update obligation per customer/project, so a revision or concurrent worker cannot create overlapping requests. No worker or API endpoint sends the draft.

### Scheduling and presentation

Add a bounded Graphile Worker task that scans active configured policies in stable project order and processes a capped page per run. It creates obligations and request-preview drafts only through the same transactional repository operation used by an authenticated assessment; a retry is safe and a cursor resumes after restart. The internal task endpoint must use a dedicated signed worker-task capability, strict body/path checks and nonce replay protection. The job also requires an explicitly configured non-human scheduled-action service identity and per-customer/project service policy limited to freshness/completeness evaluation and obligation creation. This is a separate capability from the task-signing key, never inherits the last interactive user's permissions, and cannot impersonate a project user or accept arbitrary project IDs. Without that service policy, the scan fails closed without reading source content or creating obligations or previews.

The project view presents reported status separately from the update freshness result. Show the policy revision/window, as-of time and whether each source date is server-observed or connector-validated, exact missing or unconfirmed labels, responsible owner and open obligation threshold instant. Persist an immutable `ProjectUpdateRequestPreview` revision for the active obligation. It stores the project/policy revisions, assessment ID, configured responsibility, current-known-position references (exact authorized fact/version/evidence or applicable health-assessment IDs), and exact requested fact labels/reason codes; it does not copy raw fact values or original statements. An authorized read rechecks current project and source-reader ACLs before resolving referenced values, suppresses inaccessible values, and presents the recorded as-of/provenance/freshness/conflict dimensions. Reassessment appends a preview revision or supersedes it with its obligation; preview creation never causes an outbound message or response deadline.

## Files and modules expected to change

- `packages/domain/src/freshness-signals.ts`, `completeness-signals.ts` and shared strict update-policy, obligation and request-preview contracts.
- `packages/data/prisma/schema.prisma`, an additive policy/obligation/request-preview migration, generated Prisma output, and repository modules for transactional reconciliation, preview snapshots, audit, uniqueness and current source-authority enforcement.
- `apps/api/src`: update policy, assessment, authorized preview and internal worker routes; dependency injection; generated/validated OpenAPI contract.
- `apps/worker/src/main.ts` and `tasks.ts`: named bounded scan task, cursor continuation, timeout/retry behavior.
- `apps/web/src`: project update freshness/completeness panel, persisted request preview and PMO policy editor.
- `tests`: domain, policy, scoped authorization, persistence, race/replay, worker restart/retry and Playwright `E2E-UPD-001` coverage.
- `scripts/acceptance` and upgrade/recovery inventories as required by the repository validators.
- `requirements/traceability/tests.yaml`, `docs/04-delivery/IMPLEMENTATION_STATUS.md`, and this plan after evidence exists; update Issues #8 and #9 only after exact-head and post-merge evidence passes.

## Data model or migration impact

Additive only. Add immutable `ProjectUpdatePolicyRevision` rows, durable `UpdateObligation` rows and immutable `ProjectUpdateRequestPreview` revisions scoped to customer/project and linked to the obligation. Enforce project/customer foreign keys, bounded JSON/array fields, explicit states, optimistic versioning, a unique evaluator replay identity and a partial unique constraint for one active project-update obligation per customer/project regardless of policy revision. Keep obligation and preview evidence metadata minimal: store exact fact/version/evidence/assessment references, labels and reason codes, not copied source values or original statements. Recheck source access whenever a preview reference is rendered. Update clean-install, repeat-deploy, failed-upgrade recovery, prefix-upgrade and restore inventories. Do not mutate existing migrations.

## Security and privacy impact

Every policy write, obligation read and preview render rechecks authenticated identity and current project/portfolio grant. Only a scoped PMO administrator can configure policy. A configured recipient must be a current project responsibility. The scheduled job uses the RBAC-mandated separately configured service identity and explicit customer/project operation policy; it never borrows a user's grant. Resolve source evidence under the explicit authority policy and source-reader ACLs. Preview rows store references and safe labels only; a reader with revoked or absent source access receives no value or source excerpt, even if the reference was authorized when the preview was created. Strict API schemas reject client-supplied freshness dates, timestamp bases, fact assessments, policy revisions and computed results. The worker has a separate least-privilege signed task capability, bounded to the update scan route and operation. Log fixed event categories and IDs only; no raw fact values or original statements.

## Connector and permission impact

No connector scope or live source call changes. Existing human statements may participate only when current source authority and reader access resolve them. Jira credentials, OAuth routes and Jira comments remain governed by OD-013/OD-014. CSV/XLSX saves remain reviewed proposals and are excluded from both evaluators.

## Open-source dependency impact

No new runtime or development package is planned. Continue using TypeScript, PostgreSQL and Graphile Worker.

## Implementation stages

1. **Design gate:** independent non-author review of this immutable plan SHA. Resolve all review findings before implementation; no application code in this stage.
2. **Implementation:** add policy/revision storage, scoped server resolution, durable deduplicated obligations, atomically persisted preview drafts, bounded scheduled scan and UI. Apply this plan's explicit evaluator compatibility amendment to accept trusted connector update timestamps before canonical-project row creation; preserve all other pure evaluator contracts unless an approved plan amendment explains a necessary change. Open one implementation PR against the resulting main.
3. **Validation and review:** exact-head independent implementation review; hosted Foundation `verify` and `production-boundary` plus Documentation `validate`; resolve failures on a new exact candidate and rerun relevant gates.
4. **Merge and ledger:** merge only the reviewed SHA with an expected-head guard; wait for post-merge Foundation and Documentation runs. Then attach exact candidate/merge/test/run evidence to the traceability registry, implementation status, ExecPlan and both Issue #8 and Issue #9. Check AC-HLT-001 on each issue only after E2E-UPD-001 and all required evidence pass. Check AC-HLT-002 on Issue #8 only after its completeness assertions and all required evidence pass. Check AC-UPD-001 on Issue #9 only after the persisted preview artifact and E2E-UPD-001 assert the project name, authorized current known position and exact missing information. Leave AC-UPD-002 unchecked because this increment sends no request. Keep both issues and stories open unless their full remaining criteria independently pass.

## Test and evaluation plan

- Preserve `UNIT-HLT-001` and `UNIT-HLT-002` boundary, malformed-input and deterministic-order cases.
- Add repository tests for policy revision conflicts, arbitrary/removed recipients, missing project scope, complete fact-set enforcement, current source-policy resolution, source-reader revocation and proposal exclusion.
- Add obligation tests for the strict threshold boundary (exact equality remains current; the first instant after it is stale), threshold-as-`dueAt`, project-creation fallback, stale/current transition, stable evaluator retry identity, policy-revision changes with an open obligation, single-active-slot uniqueness, simultaneous scan collision, atomic supersession/creation, audit and preview atomicity, retry after API/worker restart, and bounded cursor continuation.
- Verify source-time selection per active authority policy: human `effectiveAt` is ignored in favor of server `observedAt`; connector `effectiveAt` is accepted only under a validating adapter; delayed ingestion cannot make a source-updated basis look fresh; a trusted connector update may predate `CanonicalProject.createdAt` and still drives the expected stale state/threshold; first-observed time is immutable; repeated reads of unchanged data do not restamp it; and a required fact without a trusted selected time is unconfirmed. Update the existing evaluator test that incorrectly rejects pre-canonical timestamps while preserving future-date and malformed-time denial cases.
- Deny the scheduled scan when its service identity/policy is absent, expired, revoked or outside a project scope; verify it never falls back to the last interactive actor.
- `E2E-UPD-001` must configure an authorized project policy and responsibility, supply synthetic authorized source facts, cross the configured freshness boundary, run the scheduled path, and assert one active persisted obligation plus one persisted request-preview revision that names the project, displays the authorized current known position with provenance dimensions, and lists exact missing/stale/unconfirmed information. Include no-authority, revoked-reader, delayed-ingestion and incomplete-required-set cases; they cannot claim a valid update or disclose protected values. Assert that no message, connector write or response deadline is created.
- Run applicable lint, typecheck, unit/integration, build, Playwright, migration/restore and documentation validation through hosted checks on the exact candidate.

## Rollback and recovery

The additive migration keeps existing project facts, authority policy and health assessments unchanged. If policy or scan behavior fails, disable the update scan task and revert policy activation through a new audited revision; retain obligation/audit history. Do not delete customer evidence or roll back immutable fact history. On migration failure, stop upgrade and use the existing backup/restore runbook before resuming. Restore tests must prove no notifications are replayed because this increment creates none.

## Progress log

- 2026-09-28: Live main inspection confirmed AC-HLT-003/004 were already accepted and opened the design gate from merge `3b7d4ecffec7b0cdb910f718a05ba75d463c988c`.
- 2026-09-29: PR #96 implemented the authorized freshness/completeness workflow and merged as `b45f9188343d1dc635ea9abb5c252fb221fe7bf4` after hosted exact-head and post-merge validation.
- 2026-09-29: PR #97 completed the scheduled E2E coverage, synthetic loopback task-signing boundary and raw-body parser fix; exact-head and post-merge Foundation/Documentation validation passed, and the independent exact-head review approved candidate `0e157120c6b680fddccec432b0ce2d45ce309b98`.

## Decisions made

- Follow each current source-authority selector's explicit timestamp basis for connector facts; human statements use immutable server `observedAt`, never client-provided `effectiveAt`. Connector `effectiveAt` qualifies only when its adapter validates the source update instant; unchanged observations are not restamped. A trusted connector update may precede `CanonicalProject.createdAt`; that database creation time is not a project-origin lower bound, and the pure evaluator must preserve the older source time.
- A complete update set uses its oldest timestamp that qualifies under the active authority policy. Any missing/unconfirmed required field or untrusted selected timestamp makes `latestValidUpdateAt` null, preserving the pure evaluator's project-creation fallback. This prevents one recently edited field from concealing stale required fields.
- The freshness threshold is `(latestValidUpdateAt ?? project.createdAt) + freshnessWindowSeconds`; equality is current, staleness starts strictly after it, and the returned obligation `dueAt` is the threshold rather than a reply deadline.
- A stale obligation and immutable referenced request-preview draft are durable state only in this increment. Notification and response flows remain in the approved later engagement sequence.
- User-visible “current known position” must preserve reported-vs-calculated and provenance/freshness/conflict dimensions; it cannot be presented as a canonical fact merely because it appears in a request preview.

## Risks and mitigations

- **Wrong authority or stale-source leakage:** resolve each configured fact at one as-of time, apply its active timestamp basis, require current source access, and test revoked access, delayed ingestion, repeated unchanged observations and preview-reference suppression.
- **Duplicate or skipped obligation:** preserve the evaluator's exact retry key and reconcile under a project-policy lock; a partial unique active slot spans policy revisions. Test reuse, audited supersession/replacement and no-longer-stale cases, concurrent scans and bounded cursor retry.
- **Arbitrary recipients:** select and recheck one configured `RESPONSIBLE_OWNER`; do not accept free-form email or subject identifiers.
- **Overbroad scheduled access:** require a distinct explicitly configured service identity and narrow project operation policy, with source-reader checks on each fact; deny by default.
- **Misleading freshness:** use authority-selected trusted timestamps and the oldest complete required set; label source-updated versus server-observed dates and surface untrusted/missing time as unconfirmed.
- **Preview privacy or stale references:** persist IDs, labels and reason codes only; recheck project/source-reader ACLs on render and suppress revoked values.
- **Unintended external effect:** prohibit dispatch in this scope, including from the scheduled task; verify zero outbound calls in hosted acceptance.
- **Scope drift:** do not check AC-HLT-005/006 or Issue #8-only AC-HLT-007 in this stage; reconcile that criterion against canonical acceptance change control separately.

## Validation evidence

PR #96 implementation candidate `16d7577e24030e00a9e4e3370425c0b41ca97995` merged as `b45f9188343d1dc635ea9abb5c252fb221fe7bf4`; its exact-head Foundation #491 / run `36486323748` and Documentation #533 / run `36486323686` passed, as did post-merge Foundation #492 / run `36489403220` and Documentation #534 / run `36489403554`. Independent implementation review reported no actionable findings at implementation commit `371506726cd5f14e2029367c6663b612a5f992d4`; subsequent candidate changes were acceptance fixtures and release-inventory assertions.

The scheduled-path follow-up candidate `0e157120c6b680fddccec432b0ce2d45ce309b98` merged as `f3027dd902466f5030924dde8bbbd2a6fdc80d38`. Exact-head Foundation #494 / run `36493039261` passed on attempt 2, including verify and production-boundary; Documentation #536 / run `36493039367` passed. Independent exact-candidate review approved without blockers. The first production-boundary attempt failed during the bundled restore at `sessions_before_commit`; the failed job was rerun on the same reviewed SHA and passed. Post-merge Foundation #495 / run `36497312417` and Documentation #537 / run `36497312413` passed.

E2E-UPD-001 passed in the Foundation verify job: all 37 browser tests passed. It exercises the signed scheduler on a synthetic local project, checks the persisted stale assessment/obligation/preview, project code and name, authorized current known position, exact missing `project.schedule` information, and no outbound dispatch. Database, integration, recovery, build, architecture/contracts, lint, typecheck, dependency and audit checks passed. Exact acceptance evidence is recorded in `requirements/traceability/tests.yaml` and `docs/04-delivery/IMPLEMENTATION_STATUS.md.

## Completion summary

EXEC-012 implementation and acceptance are complete. E2E-UPD-001 supports AC-HLT-001, AC-HLT-002 and AC-UPD-001 with source-authorized persistence and scheduled-path browser evidence; the traceability registry and acceptance criteria map the test to all three criteria. On 2026-09-29 the corresponding scoped evidence was recorded in Issue #8 (AC-HLT-001/002) and Issue #9 (AC-HLT-001/AC-UPD-001); both issues remain open. AC-UPD-002, AC-HLT-005, AC-HLT-006 and Issue #8-only AC-HLT-007 remain unchecked. No request was sent, no canonical fact was written, live Jira onboarding/activation remains disabled under OD-013, and official accepted-story totals remain R0 3/5, R1 2/33, combined 5/38 (13.2%).
