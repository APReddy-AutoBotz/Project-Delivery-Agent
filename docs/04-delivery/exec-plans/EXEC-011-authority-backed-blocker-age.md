# EXEC-011: Authority-backed blocker-age assessment

Status: Draft
Owner: Implementation controller
Requirement IDs: AC-HLT-003, FR-HLT-004/009/010/011, FR-EVD-001/002/003/006/007/009/010/012, FR-ADM-005/006, FR-MOD-006, FR-AUD-001/005/007, NFR-SEC-001/002, NFR-PRV-004, NFR-REL-001/003
GitHub issue: #8 (EPIC-04, STORY-013..015)
Target release: R1
Last updated: 2026-09-27

## Objective

Extend the stored health-assessment path so it can calculate and display blocker age only from a current, complete, in-scope set of canonical blockers, an authority-resolved date fact for each blocker, and a versioned configured threshold. Keep missing or inaccessible evidence visibly unassessable. Preserve the existing schedule calculation and reported-status separation.

This plan requires independent design review at an immutable candidate SHA before application code is changed.

## In scope

- Define the v1 inventory as every active canonical RAID item in the sealed project: all RAID kinds in OPEN or IN_PROGRESS state. It is a blocker only when the exact source-authorized boolean ProjectFact `raid_item.<lowercase RAID-item UUID>.blocks_delivery` resolves to true at assessment time. A resolved false excludes that item; an unresolved classification remains visible and prevents a false-clear result. Work-item or external blockers must first be represented in the canonical RAID inventory for this increment; mappings and proposals never classify them.
- Require a separate, exact project fact `project.open_blocker_inventory_complete` to resolve true under current source authority. It attests that the canonical RAID inventory contains every open delivery blocker at assessment time. A missing, false, stale, unknown, inaccessible or conflicted assertion, an incomplete or over-bound snapshot, or an empty query without this assertion is UNASSESSABLE rather than evidence that no blockers exist.
- For each item classified as a blocker, use only the exact date ProjectFact `raid_item.<lowercase RAID-item UUID>.opened_at`. It means the start of the current uninterrupted open period. A close followed by a reopen requires a new immutable fact version with the reopened date. The authorized canonical RAID reopen command must append that version atomically with the state change or reject the reopen; never infer it from local creation time or state-change metadata. No source mapping, source URL, title, description, connector payload or reviewed import proposal supplies classification or date.
- Resolve the inventory-completeness, blocker-classification and opened-date facts at the database assessment time through the existing source-authority resolver. Use only current, unconflicted, authority-permitted, reader-accessible `human_statement` facts in this increment. Give `opened_at` an explicit `UNTIL_SUPERSEDED` validity mode: the selected applicable event-date fact remains CURRENT until superseded or withdrawn, without an arbitrary finite lifetime. Require an explicitly configured finite freshness policy for the inventory-completeness and blocker-classification facts; absent, stale or unknown policy outcomes are unresolved.
- Add one customer-scoped `BlockerAgeThresholdPolicy` with a configured `minimumBlockerAgeDays` and finite `auditRetentionHours`. Require a customer-scoped `pmo_admin` capability to view or change it through a strict API and small admin UI. Neither value has an implicit default; a missing threshold makes blocker-age coverage UNASSESSABLE, and threshold change events expire under the configured audit window.
- Use UTC calendar days in v1. Freeze the threshold value and revision, `blocker-age@1` rule revision, as-of time, timezone, inventory assertion, each classification/date fact and version/evidence identifier, authority-policy revision, per-item outcome and aggregate coverage in the immutable assessment envelope. The calculation uses `ageDays >= minimumBlockerAgeDays`.
- Aggregate blocker-age coverage precisely: COMPLETE requires the current true inventory assertion, a complete bounded snapshot, a configured threshold, a current true/false classification for every active RAID item, and a current resolved date for every item classified as a blocker. COMPLETE with zero blockers is a positive, attested empty inventory and must display “No open blockers.” PARTIAL requires at least one fully assessed blocker and at least one unresolved active candidate; show assessed results and unknown rows without any aggregate clear/no-blocker claim. UNASSESSABLE applies when a global gate fails, or when unresolved candidates leave no fully assessed blocker result. Missing threshold or inventory evidence never renders as CLEAR.
- Add blocker-age results as a separately labeled signal family in the stored assessment and project UI. Do not feed blocker-age outcomes into the existing calculated schedule RAG until approved severity semantics exist. Preserve the reported RAG and schedule result unchanged.
- Keep the existing caller contract: clients submit only project ID and command key. Build candidate inventory, source snapshots, threshold, time, calculation, authorization, persistence and audit on the server.
- On every assessment read and idempotent replay, recheck project authorization and current access for every source fact referenced by blocker-age content. If any referenced source is no longer accessible, return allowed assessment metadata with content hidden; do not expose stored dates or derived blocker details without current source permission.
- Keep schedule-only historical assessment rows readable under their existing contract. New assessment rows identify both rule families and separately report blocker-age coverage as COMPLETE, PARTIAL or UNASSESSABLE using the aggregation above.
- Update API/OpenAPI schemas, admin behavior, UI labels, migration and restore inventories, source-authority schemas/explanations, traceability, tests, and implementation evidence.

## Out of scope

- Reading Jira or another connector, resolving external mappings, importing spreadsheet rows as canonical facts, or promoting reviewed proposals.
- Calculating age directly from work-item or external-record rows in this increment. Represent a blocker discovered there in the canonical RAID inventory before it participates in this rule.
- Inferring an opened date from a local createdAt value, a state-change timestamp not captured as an explicit fact, a source URL, an external record pointer, or an unreviewed proposal.
- Changing canonical RAID state or writing a ProjectFact during assessment.
- Changing the existing calculated schedule RAG, defining aged-blocker severity for overall project health, completing AC-HLT-004/005/007, closing Issue #8, or accepting STORY-013..015.
- AI or embedding use, portfolio aggregation, new external writes, and broad authority-policy wildcard support.

## Current state

- main is 93290cfa1fa209ce8db2f1c48c0d6082bb6c8be7.
- PR #82 provides a deterministic pure blocker-age evaluator with a caller-supplied time zone, date field, threshold, closed-record exclusion, and unassessable missing dates. It does not establish source authority or connect to API/UI/persistence.
- PR #85 provides an authenticated stored schedule-only assessment, separate from reported RAG, with immutable payloads, idempotency, retention and an API/UI. PR #86 and the latest post-merge Foundation and Documentation checks passed.
- EXEC-010 explicitly excludes source mapping resolution, source authority, proposals, blocker age and other unimplemented health families. This increment is a new plan and will not silently widen EXEC-010.
- RAID items have no source opened date. Canonical source mappings are pointers, and ingestion rows are proposals. The project-fact model supports date values and existing source-authority resolution, with per-project/per-fact-type policy, history, conflict, freshness and source-access checks.
- DatabaseAuthorityRepository.prepareAssessmentInTransaction is the read-only resolution seam. Its documented callers hold the Project and relevant fact locks before taking one asOf. The existing health route currently locks project access and a sealed canonical schedule graph, but does not load RAID items or ProjectFacts.
- Issue #8 remains open with all seven checkboxes unchecked. Current accepted-story totals are R0 3/5, R1 2/33, combined 5/38 (13.2%). UNIT-HLT-003 is evidence for the pure evaluator only; AC-HLT-003 remains partial.

## Proposed design

### Source-date identity and resolution

Use three exact fact identities: `project.open_blocker_inventory_complete` (boolean), `raid_item.<lowercase RAID-item UUID>.blocks_delivery` (boolean), and `raid_item.<lowercase RAID-item UUID>.opened_at` (date). The first is a current completeness attestation that every open delivery blocker is represented in the canonical RAID inventory. The second explicitly classifies each active RAID candidate. The third is the start date of its current uninterrupted open period. All fit the existing fact-type bound and use the existing human fact/evidence authoring boundary; the assessment path does not create or infer them. Each exact fact type requires its own current source-authority policy. If any required source fact has no current policy, is not `HUMAN_CONFIRMED`, conflicts, is inapplicable, lacks a valid typed value, has incomplete history, or is not readable by the actor, retain its row as unresolved and do not silently omit it.

The source-authority selector for `opened_at` must support explicit `UNTIL_SUPERSEDED` validity. The resolver returns freshness CURRENT only for the selected applicable version while it remains the current version under the configured authority policy, unconflicted and accessible; supersession or withdrawal ends that validity. `UNTIL_SUPERSEDED` applies only to this historical event-date fact type. A finite freshness validity remains available and becomes STALE at its configured boundary. An unset validity policy remains UNKNOWN. Add this mode to the strict authority-policy schema/resolver and its proof output; do not encode an infinite timestamp or silently treat null validity as current.

The classification and completeness facts use explicit configured finite freshness periods. No assessment default is synthesized. The product administrator chooses a suitable confirmation cadence through the existing authority-policy surface; a missing or non-current rule leaves the affected classification/inventory gate unresolved. No query over local RAID rows alone proves that the inventory contains every open blocker.

The canonical RAID reopen command must coordinate the state change and source date: when a row transitions from COMPLETE/CANCELLED to OPEN/IN_PROGRESS, it requires an authorized new `opened_at` fact version effective for the reopened period and commits that fact with the state transition in one transaction. If the new source date is absent, invalid, unauthorized or cannot be committed, reject the reopen. The database must deny alternate direct application-role state updates that bypass this command. An existing active row without a current-period fact remains unassessable until an authorized person supplies it.

Within a new assessment transaction:

1. Recheck the authenticated actor and acquire the app `Project` row `FOR SHARE`; then acquire matching project/portfolio `AccessGrant` rows `FOR SHARE ORDER BY id` and verify the current read grant. This is the compatible read lock order for writers that take `Project FOR UPDATE` before grant changes.
2. Acquire the existing per-command idempotency advisory lock after authorization. Read the configured health-assessment retention row `FOR SHARE` and the command receipt. If a valid receipt exists, check its retry/content retention and current source access, then return the original frozen assessment without reading the current threshold or taking a new assessment `asOf`; source-access revocation may hide its content. Keep the command lock until transaction completion.
3. For a new command only, acquire `pg_advisory_xact_lock_shared` on a stable transaction-scoped customer key under a reserved, documented namespace. Threshold writers use `pg_advisory_xact_lock` with the same key. This serializes the absent-policy-row case. Read an existing `BlockerAgeThresholdPolicy` row `FOR SHARE`; if absent, record blocker-age coverage as UNASSESSABLE. Retain the shared lock through commit.
4. Lock and read the sealed `CanonicalProject` and every active RAID item for the same customer/project `FOR SHARE ORDER BY id`, across all RAID kinds. Require a complete query and enforce the bound of 50 without truncation. A failed or over-bound read makes blocker-age coverage UNASSESSABLE while preserving an otherwise valid schedule result.
5. Collect exact fact rows for the inventory-completeness assertion and every active candidate's `blocks_delivery` and `opened_at` types; acquire relevant ProjectFact locks and authority-policy snapshots in stable `(factType, id)` order. Resolve facts using `DatabaseAuthorityRepository.prepareAssessmentInTransaction`. Read and lock selected source-access rows in stable source-ID order. Existing authority/source-access mutations take `Project FOR UPDATE`, so they cannot cross the held project read lock.
6. After project/grant, command, health-retention and customer-threshold locks, the canonical RAID snapshot, facts, authority policy and source-access locks are held, take one database UTC assessment `asOf`. Use it for every freshness, authority, access, classification, opened-date, threshold and age calculation. Do not read a separate wall clock per blocker.
7. Require the inventory fact to resolve true. Require every active RAID candidate's boolean classifier to resolve true or false. A false item is excluded. For each true item, require one resolved date fact with a date value and CURRENT `UNTIL_SUPERSEDED` validity. Store explicit unresolved rows/reason codes for unknown classification, missing or invalid date, stale/unknown freshness, conflict, inaccessible evidence or future date.
8. Run the existing pure evaluator over only the source-authorized true blockers with `timeZone=UTC` and `ruleRevision=blocker-age@1`. Apply the exact coverage aggregation defined in Scope. An attested complete inventory with no active RAID rows, or with every active row explicitly classified false, is COMPLETE with zero blockers. Without the assertion, the same empty read is UNASSESSABLE. Never turn an unresolved candidate into WITHIN_THRESHOLD.
9. Save bounded candidate classifications, authorized input values and results, coverage, retention deadlines, envelope hash, command receipt and audit event atomically with the schedule result. New threshold revisions apply only to new commands; an idempotent retry returns the original frozen threshold and assessment. The top-level rule revision becomes `schedule-health@1+blocker-age@1`; existing schedule signals remain `schedule-health@1`.
10. On latest/read and replay delivery, reacquire project `FOR SHARE`, grant rows `FOR SHARE ORDER BY id`, and relevant source-access rows in the same deterministic order. Recheck current visibility for every referenced fact. If any supporting source is revoked, restricted or no longer readable, hide all assessment content while preserving only permitted metadata; content retention expiry still applies first.

The blocker-age panel shows blocker key/kind, source date and fact field, current open-period age, applied numeric threshold, outcome, rule and threshold revisions, inventory-completeness status, aggregate coverage and concise authority/freshness/conflict/access status. A COMPLETE zero-blocker result is shown only with its current source-authorized completeness proof; PARTIAL and UNASSESSABLE never appear as no blockers or within-threshold.

### Threshold policy

Add one `BlockerAgeThresholdPolicy` row per customer with `minimumBlockerAgeDays`, `auditRetentionHours`, monotonic revision, `changedBy` and `changedAt`. Validate `minimumBlockerAgeDays` in 1..3650 and `auditRetentionHours` in 1..87600, matching the existing bounded retention policy range. Require both values on initial creation (`expectedRevision=0`); updates submit the full current configuration plus exact `expectedRevision`. Only an authenticated principal with a customer-scoped `pmo_admin` capability may read or update this customer-wide setting; a project-scoped admin grant is insufficient. In one transaction, the writer takes the customer advisory lock exclusively, locks an existing policy row `FOR UPDATE`, checks the revision, writes the next revision and appends an `AuditEvent` with the new revision and its configured `auditRetentionHours`. The policy update and event commit or roll back together.

Each threshold-policy change event captures its own finite `auditRetentionHours` in immutable `AuditEvent.detail`; that event expires at `occurredAt + captured auditRetentionHours`, regardless of later policy changes. The additive migration validates the captured interval and prevents deletion before that deadline. A fixed-scope worker function named `purge_expired_blocker_age_threshold_audit_events()` deletes only expired threshold-policy events after their captured deadline; ordinary API access cannot update/delete audit rows or execute this procedure. Do not add an individual audit-event foreign key from the policy row; identify an event by customer, object type/id and revision in event metadata so expiry cannot block threshold updates or recovery.

This implements FR-AUD-007 and NFR-PRV-004 for threshold changes. The current `HealthAssessmentRetentionPolicy` governs assessment evidence only and is not reused. No default audit window is introduced: the customer `pmo_admin` must configure a finite interval, including when creating the initial threshold policy, subject to the applicable legal requirements.

An absent threshold policy is allowed but blocker-age coverage is UNASSESSABLE. A successful threshold change affects subsequent new assessment commands only; an existing assessment and same-key replay retain the exact threshold and policy revision originally used.

### Bounds and failure behavior

- Bound the canonical blocker set to 50 records and the source fact history to the existing cross-fact limit. Never treat a truncated or incomplete query as complete.
- If the canonical project is missing/unsealed or a required read fails, follow the health repository's fail-closed contract. When only blocker-age source data or its policy is missing/incomplete, preserve a valid schedule result and store explicit blocker-age UNASSESSABLE coverage.
- Keep all joins and locks scoped by customerId and projectId. Do not fall back to another project, portfolio-wide query, source mapping, proposal, or model output.
- Do not persist new FactAssessment rows or mutate ProjectFact, RAID state, or authority policy. The health assessment is the frozen proof for this calculation; source history remains owned by the evidence subsystem.

## Files and modules expected to change

- Domain blocker-age, health-assessment, delivery-health and source-authority contracts/builders, strict authority selector schemas/resolver, and package exports.
- Data health-assessment and canonical RAID repositories, authority-resolution composition, strict threshold-policy repository, retention procedure/guards, Prisma schema, additive migration and runtime ACLs.
- API health-assessment and canonical RAID controllers, atomic reopen/date-fact guard, strict customer-scoped threshold routes, OpenAPI contract and app composition.
- Web canonical project health panel, guarded RAID reopen workflow and a `pmo_admin` threshold/retention editor; visible inventory-completeness, source, partial and unassessable states.
- Unit, authority-resolver, reopen-transaction, repository, PostgreSQL integration, retention-boundary, API/RBAC, browser and recovery tests; a registered runtime acceptance test if needed.
- Requirement/test traceability, source-authority/API/config documentation, migration/upgrade/restore inventories, `IMPLEMENTATION_STATUS.md`, and this ExecPlan.

## Data model or migration impact

Add one customer-scoped threshold-policy table with bounded minimum age, finite `auditRetentionHours` and revision metadata. Extend the immutable health-assessment envelope/schema to store bounded inventory completeness, blocker classifications, source dates, coverage and references to fact/source/evidence versions; never store raw human statements. Existing ProjectFact tables hold the inventory/classification/date facts, so do not add a parallel canonical blocker flag or edit applied migrations.

Extend the strict source-authority selector/proof schema to represent `UNTIL_SUPERSEDED` validity for the exact opened-date fact type. Preserve current behavior for existing policy selectors; an unset validity remains UNKNOWN. Add the threshold audit-event retention check/early-delete guard and a fixed-scope expiry procedure using the per-event captured window. Keep the migrations additive, maintain customer foreign keys and unique/check constraints, enforce minimum API and worker ACLs, and preserve assessment insert/read-only and retention-worker boundaries. Update generated Prisma artifacts and every clean, repeat, table-count, production-boundary, backup, upgrade and restore inventory.

## Security and privacy impact

- Use the current server actor and authorization locks for assessment writes and reads; never trust caller-supplied candidate lists, classification/date values, completeness assertions, threshold, as-of time or evidence IDs. Only the guarded canonical RAID transition may reopen an item, and it must atomically persist its new opened-date fact.
- Require current source-level authorization for inventory, classification and opened-date facts. Recheck source access on later delivery and hide stored assessment content if any supporting source access is revoked.
- Store no source narrative. Bound input, result and evidence references; hash the canonical serialized envelope and enforce assessment content/audit retention. Capture the customer-configured threshold-audit window in each event and purge only after that window.
- Restrict threshold access to a customer-scoped `pmo_admin`, scope the row by customer, audit every successful revision, and never permit threshold updates through a project-only role. Apply the finite configured audit retention to each threshold change event.
- Keep imported proposals, source URLs, connector credentials and model tooling outside the health calculation.

## Connector and permission impact

No connector call or permission scope is added. Existing project/portfolio read grants remain required; exact source-reader grants for the inventory-completeness, `blocks_delivery` and `opened_at` facts are additionally required before their content can be exposed. Only a customer-scoped `pmo_admin` can configure the customer-wide blocker threshold. Exact per-project fact authority for these three fact types remains under the existing authority-policy administrator surface.

## Open-source dependency impact

None.

## Implementation stages

1. Obtain independent review of the concrete design at a named candidate SHA and resolve findings before implementation.
2. Implement strict blocker-age, source-authority `UNTIL_SUPERSEDED`, and threshold-policy domain contracts; add the guarded atomic RAID reopen/date-fact command and test age boundaries, reopen behavior, UTC behavior, missing dates/threshold, closed items and no false-clear output.
3. Add additive threshold-policy and finite audit-retention storage, customer-scoped audited `pmo_admin` API, optimistic revision checks, captured event expiry/guard/worker cleanup, generated database types, grants and clean/repeat migration evidence.
4. Compose complete locked RAID and ProjectFact snapshots in the health repository; resolve through the source-authority seam; persist schedule and blocker-age input/output atomically with audit, retention and idempotency.
5. Gate latest/replay output on current source access; add the admin threshold editor, blocker-age evidence panel and clear unknown/restricted states.
6. Add integration, authorization, reopen, audit-expiry, race, API contract, browser and recovery coverage; update traceability, operational inventories and progress evidence.
7. Run exact-head Foundation and Documentation workflows, clean/repeat and forward-upgrade/restore validation, and registered AC-HLT-003 runtime acceptance. Obtain independent non-author review of the immutable implementation candidate. Merge only the reviewed SHA with all required checks green, then record post-merge validation and status.

## Test and evaluation plan

Use only synthetic fixtures and isolated databases.

- Extend UNIT-HLT-003 for age equality/below/above threshold, UTC date boundary and DST-independent behavior, missing/invalid/future dates, closed-item exclusion and visible rule/policy threshold values. Test close-to-open transitions append a new opened_at fact in the same transaction; without that fact the reopen command fails, and the old period date cannot assess the reopened item.
- Test blocker candidate identity with all RAID kinds in OPEN/IN_PROGRESS, false classification exclusion, true classification inclusion, unresolved classification retained as unknown, and closed RAID rows excluded. Work-item/external pointers and mappings/proposals must never enter the candidate list.
- Test a current true inventory attestation with zero RAID rows yields COMPLETE “No open blockers”; an empty query without it, false/missing/stale/unknown/restricted assertion, incomplete snapshot and over-bound query yield UNASSESSABLE. Test complete all-false classification yields COMPLETE with zero blockers.
- Test exact fact identities, boolean/date type validation, unset authority policy, missing history, stale/unknown finite classification/completeness facts, CURRENT `UNTIL_SUPERSEDED` opened date, superseded/reopened date, finite-validity expiry, conflicts, inaccessible/revoked sources and future opened dates. Verify unknown inputs never become WITHIN_THRESHOLD or CLEAR.
- Test aggregation: all facts resolve and at least one blocker gives COMPLETE; one assessed blocker plus unresolved candidate gives PARTIAL; unresolved candidates with no fully assessed blocker gives UNASSESSABLE. No unknown candidate may be dropped from the coverage calculation.
- Test the complete stored path, schedule-result preservation, as-of boundary, output rule/policy/authority revisions, source dependency retention, content hide on revocation before latest-read and replay, and content expiry/redaction.
- Test concurrent assessments against fact, authority-policy and source-access changes under the Project/grant/fact lock order. Test concurrent threshold assessment vs create/update with both a policy row present and absent, expectedRevision conflict without duplicate audit events, customer isolation, denied project-scoped admin, authorized customer `pmo_admin`, and rollback of the policy/audit pair.
- Verify threshold audit uses generic `AuditEvent`, remains independent of `HealthAssessmentRetentionPolicy`, captures each event's configured 1..87600 hour window, rejects early deletion, purges at/after expiry only through `purge_expired_blocker_age_threshold_audit_events()`, and has no restrictive event FK from the policy row.
- Run unit, integration, API/OpenAPI, browser, lint, typecheck, build, architecture, clean/repeat migration, prefix upgrade, production-boundary and restore suites through required hosted workflows. Do not claim local results if workspace execution is unavailable. Use no real customer data or AI calls.

## Rollback and recovery

The migration is additive; preserve all earlier migrations, facts, proposals and health assessments. Before deployment, disable the new threshold routes and blocker-age portion of assessment composition if the feature must be stopped; existing schedule-only assessments remain readable. Do not drop the policy or assessment data as rollback. Do not rewrite source facts or proposals. Upgrade, repeated migration and restore must preserve threshold revisions, assessment hashes, source references, audit records and retention behavior. Any later destructive removal requires a separately reviewed migration and verified export/retention plan.

## Progress log

- 2026-09-27: Drafted after confirming PR #82 is evaluator-only and PR #85/86 leave runtime assessment schedule-only. Independent review of `67abadcc` found blocker/inventory, freshness, and lock-order gaps; review of `d65c4ed` confirmed those fixes and identified audit retention plus reopen enforcement as remaining gates. This revision addresses them. No application code changed; new exact-SHA review and required plan validation are pending.

## Decisions made

- Bound v1 candidates to all active canonical RAID items. Require an exact, current, source-authorized `blocks_delivery` boolean for every candidate instead of treating RAID kind alone as blocker status.
- Require a current source-authorized `project.open_blocker_inventory_complete=true` assertion before any complete/no-blocker result. An empty local query never proves the inventory is empty.
- Define `opened_at` as the beginning of the current uninterrupted open period; a reopen creates a new immutable fact version.
- Use `UNTIL_SUPERSEDED` freshness only for the historical `opened_at` event fact; keep classification/completeness freshness explicit and finite. Never assign an arbitrary long opened-date lifetime.
- Use UTC calendar days, a customer-scoped threshold and audit window, no defaults, and a customer-scoped `pmo_admin` capability.
- Serialize threshold policy read/write and absent-row creation with the same customer advisory-lock key. Assessment locks Project `FOR SHARE`, then grant rows `FOR SHARE ORDER BY id`, then the shared customer advisory lock, and takes one `asOf` only after canonical, fact, authority and source-access locks.
- Keep blocker-age output separate from schedule RAG until approved severity semantics exist.

These proposed implementation decisions follow the existing delegation and remain subject to independent exact-SHA design review before code changes.

## Risks and mitigations

- A local RAID list may be empty or incomplete. Mitigation: require the current authorized completeness assertion and classify every active item; otherwise report UNASSESSABLE/PARTIAL, never no blockers or clear.
- A human may provide an unconfirmed, stale or conflicting blocker fact. Mitigation: use the source resolver and explicit finite policies for classification/completeness; require authority-permitted CURRENT event-date facts.
- A reopened item may be measured from its original first-ever opening. Mitigation: define `opened_at` as the beginning of the current uninterrupted open period and require a new immutable version after reopening.
- Project permission may be broader than evidence permission. Mitigation: check source access at calculation and every delivery; hide the content when access changes.
- Threshold creation/update may race with assessment, especially when the row is absent. Mitigation: shared/exclusive transaction advisory locks derived from the same customer key, plus row locks and expected-revision updates.
- Threshold audit retention may be confused with health-assessment retention. Mitigation: configure a finite customer audit window, capture it per event, and purge through a worker-only fixed-scope procedure; do not reuse health-assessment retention.
- A future connector may submit plausible dates or classifications. Mitigation: proposals, mappings and connector payloads remain explicitly excluded until a separate source-publication design is approved.

## Validation evidence

Pending independent design review of the exact candidate SHA, plan validation, and reviewer disposition. No implementation or AC-HLT-003 acceptance is claimed by this draft.

## Completion summary

Not complete. This plan is not yet approved; application-code work is gated on independent exact-SHA design review.
