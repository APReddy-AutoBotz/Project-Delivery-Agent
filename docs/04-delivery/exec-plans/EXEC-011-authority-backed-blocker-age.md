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

- Define an open blocker for this increment as a canonical RAID item whose kind is ISSUE or DEPENDENCY and whose state is OPEN or IN_PROGRESS. COMPLETE and CANCELLED items are excluded. RISK, ASSUMPTION, DECISION, and ACTION are outside this blocker-age rule.
- Use the explicit date ProjectFact whose exact fact type is raid_item.<lowercase RAID-item UUID>.opened_at. Do not use RAID-item or mapping creation times, titles, descriptions, connector payloads, source mappings, or reviewed import proposals as the date.
- Resolve each date at the database assessment time through the existing source-authority resolver. Use a date only when the history is complete and the current policy resolves it as current, unconflicted, authority-permitted, and readable by the requesting actor. Current persistence represents supported fact sources as human_statement; this increment therefore uses an explicitly confirmed human source date only. Missing policy, missing/invalid date, stale/unknown freshness, conflict, restricted/revoked evidence, or incomplete history yields UNASSESSABLE for that blocker.
- Add one per-customer, audited BlockerAgeThresholdPolicy with minimumBlockerAgeDays in the evaluator's supported range. A pmo_admin can view and update it through a strict API and a small admin UI. No implicit default is introduced: an absent policy makes blocker-age coverage UNASSESSABLE and never CLEAR.
- Use UTC calendar days in v1, matching the existing stored assessment's database UTC clock and the schedule-health implementation. Freeze the threshold value, threshold-policy revision, rule revision, as-of time, time zone, source date, fact/version/evidence identifiers, authority-policy revision, status and explanation into the immutable assessment envelope. The calculation uses ageDays >= minimumBlockerAgeDays, as the existing pure evaluator specifies.
- Add blocker-age results as a separately labeled signal family in the stored assessment and project UI. Do not feed blocker-age outcomes into the existing calculated schedule RAG in this increment; its severity effect on overall project health is not specified by AC-HLT-003. Preserve the reported RAG and schedule result unchanged.
- Retain the existing caller contract: clients submit only the project ID and command key. Build source snapshots, threshold, time, calculation, authorization, persistence and audit on the server.
- On every assessment read and idempotent replay, recheck project authorization and current access for every source fact referenced by blocker-age content. If any referenced source is no longer accessible, return the assessment metadata with content hidden; do not expose stored dates or derived blocker details to a project reader without current source permission.
- Keep schedule-only historical assessment rows readable under their existing contract. New assessment rows identify both rule families and separately state blocker-age coverage as complete, partial, or unassessable.
- Update API/OpenAPI schemas, admin behavior, UI labels, migration and restore inventories, source-authority explanations, traceability, tests, and implementation evidence.

## Out of scope

- Reading Jira or other connector data, resolving external mappings, importing spreadsheet rows as canonical facts, or promoting reviewed proposals.
- Inferring an opened date from a local createdAt value, a source URL, an external record pointer, or an unreviewed proposal.
- Changing canonical RAID state or writing a source fact during assessment.
- Changing the existing calculated schedule RAG, defining the RAG severity of an aged blocker, completing AC-HLT-004/005/007, closing Issue #8, or accepting STORY-013..015.
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

Use the fixed, documented fact-type function raid_item.<lowercase RAID-item UUID>.opened_at. It fits the existing 96-character fact-type bound, maps one fact to one canonical blocker, and avoids ambiguous matching by user-facing key or source mapping. The fact value must have type date and pass the canonical date schema. The existing fact-authoring/evidence boundary records the explicit human statement; the administrator configures the exact fact type's source authority policy using the existing API. No authority policy is synthesized by the assessment path.

Within the assessment transaction:

1. Recheck the authenticated actor and project/portfolio read grant, holding locks in the established Project-then-grant order.
2. Lock and read the sealed CanonicalProject and a complete, bounded RAID snapshot under the same tenant/project scope. Query ISSUE/DEPENDENCY records only; reject an over-bound snapshot as unassessable rather than truncating it.
3. Sort the exact opened-date fact rows by stable ID/fact type and acquire the fact locks before taking the single database UTC assessment instant. A Project lock serializes existing fact and authority mutations that follow the fact-authorization contract. Load the matching bounded history, current authority policy/revision, conflicts and source-access rows through the existing transaction-scoped resolver.
4. For each blocker, accept only one resolver result with status RESOLVED, a date value, and current actor access. Record only the date and minimum metadata needed to reproduce and authorize the result; never copy originalStatement or other narrative.
5. Run the existing pure blocker-age evaluator over this complete authorized snapshot with timeZone=UTC, ruleRevision=blocker-age@1, and the policy's exact minimum days. Translate unresolved inputs to explicit UNASSESSABLE rows with a reason code. A future date is unassessable, not a negative age or a clear result.
6. Save the blocker-age inputs/result in the existing immutable health assessment with the schedule result, retention deadlines, envelope hash and audit event in the same transaction. The new top-level assessment revision is schedule-health@1+blocker-age@1; the existing schedule signals remain schedule-health@1. New threshold policy revisions apply to subsequent assessment commands; retries return the original snapshot.
7. On latest/read and replay delivery, parse the stored source dependency list and recheck current FactSourceAccess. If any required source is missing, revoked, restricted, or lacks the reader, hide the complete assessment content while preserving allowed assessment metadata. Read-time content expiry still applies first.

The blocker-age panel shows each blocker key, source date and field, calendar age, applied minimum-age threshold, outcome, blocker-age@1, threshold-policy revision, and a concise authority/freshness/conflict/access status. Missing threshold/date and incomplete coverage are visible; no absent data is rendered as within threshold. The panel is separate from the calculated schedule RAG and reported RAG.

### Threshold policy

Add BlockerAgeThresholdPolicy, keyed by customer, with minimumBlockerAgeDays, monotonic revision, changedBy, changedAt, and an audit-event reference. Validate 1..3650 days. The administrator API requires an authenticated pmo_admin, strict input, and expectedRevision for serialized updates; every successful change appends an audit event. A missing policy is allowed but leaves blocker age unassessable. A rule edit never changes an already stored assessment.

### Bounds and failure behavior

- Bound the canonical blocker set to 50 records and the source fact history to the existing cross-fact limit. Never treat a truncated or incomplete query as complete.
- If the canonical project is missing/unsealed or a required read fails, follow the health repository's fail-closed contract. When only blocker-age source data or its policy is missing/incomplete, preserve a valid schedule result and store explicit blocker-age UNASSESSABLE coverage.
- Keep all joins and locks scoped by customerId and projectId. Do not fall back to another project, portfolio-wide query, source mapping, proposal, or model output.
- Do not persist new FactAssessment rows or mutate ProjectFact, RAID state, or authority policy. The health assessment is the frozen proof for this calculation; source history remains owned by the evidence subsystem.

## Files and modules expected to change

- Domain blocker-age, health-assessment and delivery-health schemas/builders, plus package exports.
- Data health-assessment repository, authority-resolution composition, strict threshold-policy repository, Prisma schema, additive migration and runtime ACLs.
- API health-assessment controller, strict threshold-policy routes, OpenAPI contract and app composition.
- Web canonical project health panel and a pmo_admin threshold editor; visible source/evidence status and unassessable cases.
- Unit, repository, PostgreSQL integration, API/RBAC, browser and recovery tests; a registered runtime acceptance test if needed.
- Requirement/test traceability, API/config documentation, migration/upgrade/restore inventories, IMPLEMENTATION_STATUS.md, and this ExecPlan.

## Data model or migration impact

Add one customer-scoped policy table with bounded minimum age, revision and audit metadata. Extend the health-assessment rule-revision constraint and strict API schemas additively while retaining existing schedule-only rows. The assessment JSON will include bounded blocker-age input/output and referenced fact/source/evidence IDs; it will not store raw human statements.

The new migration must be additive and follow the current migration sequence. It must maintain customer foreign keys, unique constraints, safe check constraints, the API's minimum policy access, and the existing insert/read-only assessment and retention-worker boundaries. Update generated Prisma artifacts and every clean, repeat, prefix-upgrade, table-count, production-boundary, backup and restore inventory. Do not edit an applied migration.

## Security and privacy impact

- Use the current server actor and authorization locks for both assessment writes and reads; never trust caller-supplied blocker lists, date values, threshold, as-of time or evidence IDs.
- Require current source-level authorization for resolved dates. Recheck it on later delivery and hide stored assessment content if any supporting source is no longer accessible. Tests must cover revocation before retry and before latest-read.
- Store no source narrative. Bound input, result and evidence references; hash the canonical serialized envelope and enforce existing retention/redaction behavior.
- Restrict threshold updates to pmo_admin, scope the policy by customer, audit successful revisions, and never permit threshold updates through a project-level client role.
- Keep imported proposals, source URLs, connector credentials, and model tooling outside the health calculation.

## Connector and permission impact

No connector call or permission scope is added. Existing project/portfolio read grants remain required; exact fact-source reader grants are an additional requirement for exposing blocker-age content. Only a pmo_admin can configure the customer-wide blocker threshold. Exact per-project opened-date authority remains under the existing authority-policy administrator surface.

## Open-source dependency impact

None.

## Implementation stages

1. Obtain independent review of the concrete design at a named candidate SHA and resolve findings before implementation.
2. Implement strict blocker-age and threshold-policy domain contracts; unit-test age boundaries, UTC behavior, missing dates/threshold, closed items, and no false-clear output.
3. Add additive threshold-policy storage, audited pmo_admin API, optimistic revision check, generated database types, grants and clean/repeat migration evidence.
4. Compose complete locked RAID and ProjectFact snapshots in the health repository; resolve through the existing source-authority seam; persist schedule and blocker-age input/output atomically with audit, retention and idempotency.
5. Gate latest/replay output on current source access; add the admin threshold editor, blocker-age evidence panel and clear unknown/restricted states.
6. Add integration, authorization, race, API contract, browser and recovery coverage; update traceability, operational inventories and progress evidence.
7. Run exact-head Foundation and Documentation workflows, clean/repeat and forward-upgrade/restore validation, and registered AC-HLT-003 runtime acceptance. Obtain independent non-author review of the immutable implementation candidate. Merge only the reviewed SHA with all required checks green, then record post-merge validation and status.

## Test and evaluation plan

Use only synthetic fixtures and isolated databases.

- Extend UNIT-HLT-003 for date-age equality/below/above the threshold, UTC date boundary, DST-independent UTC behavior, missing/invalid/future source dates, closed blockers, and visible rule/policy threshold values.
- Test the full stored path with ISSUE and DEPENDENCY blockers, complete and over-bound snapshots, matching/nonmatching fact types, date versus text value, no policy, disabled/nonapplicable authority policy, stale/unknown/conflicting facts, current resolved human fact, and restricted/revoked source access. Confirm unresolved inputs never become WITHIN_THRESHOLD or CLEAR.
- Test a concurrent assessment against fact, authority-policy, source-access and threshold-policy changes; all captured inputs must be from one documented assessment boundary. Same-key retries preserve the original snapshot and audit count. Changed expected policy revision conflicts without a duplicate policy event.
- Test project/customer isolation, denied roles, pmo_admin-only threshold edits, source access revoked before latest-read/replay, and content expiry/redaction using the existing health retention policy.
- Verify output displays exact source date, applied numeric threshold, blocker rule revision, authority-policy revision, and explicit assessment time. Verify reported RAG and calculated schedule RAG remain unchanged by blocker-age results.
- Run unit, integration, API contract/OpenAPI, browser, lint, typecheck, build, architecture, clean/repeat migration, prefix upgrade, production-boundary and restore suites through the required hosted workflows. Do not claim local results if workspace execution remains unavailable. No real customer data and no AI calls.

## Rollback and recovery

The migration is additive; preserve all earlier migrations, facts, proposals and health assessments. Before deployment, disable the new threshold routes and blocker-age portion of assessment composition if the feature must be stopped; existing schedule-only assessments remain readable. Do not drop the policy or assessment data as rollback. Do not rewrite source facts or proposals. Upgrade, repeated migration and restore must preserve threshold revisions, assessment hashes, source references, audit records and retention behavior. Any later destructive removal requires a separately reviewed migration and verified export/retention plan.

## Progress log

- 2026-09-27: Drafted after confirming PR #82 is evaluator-only and PR #85/86 leave runtime assessment schedule-only. No application code changed. Independent design review and exact-SHA approval are pending.

## Decisions made

- Reuse explicit authority-resolved ProjectFacts rather than infer dates from RAID-item createdAt or use mapping/proposal data.
- Use exact blocker fact type raid_item.<lowercase RAID-item UUID>.opened_at; require its current per-project authority policy and current reader access.
- Treat canonical ISSUE and DEPENDENCY records in OPEN or IN_PROGRESS as blockers for this criterion; exclude other RAID kinds and closed states.
- Configure minimum age once per customer, require pmo_admin, and leave it unset by default. Missing threshold is UNASSESSABLE.
- Use UTC calendar days in v1. Show blocker-age signals separately without changing the existing schedule RAG.

These are proposed routine implementation decisions under the existing controller delegation; they remain subject to independent design review before code changes.

## Risks and mitigations

- A user may record a plausible date without an authority policy. Mitigation: resolver status must be RESOLVED; otherwise show UNASSESSABLE.
- Project read permission may be broader than source evidence permission. Mitigation: source-level check at calculation and every delivery; hide the content if access changes.
- A future connector may produce date proposals that look authoritative. Mitigation: proposal tables, mappings and connector payloads are explicitly excluded; source publication needs a separate reviewed design.
- Large histories or partial database reads could create false-clear results. Mitigation: fixed complete-snapshot bounds; over-bound/incomplete blocker coverage is UNASSESSABLE.
- Threshold changes could make old results appear current. Mitigation: freeze policy revision/value in each assessment and return original values on idempotent replay.
- Treating aged blockers as an overall RED/AMBER status could change product semantics. Mitigation: keep blocker-age separate from the schedule RAG until an approved health severity rule defines aggregation.

## Validation evidence

Pending independent design review of the exact candidate SHA, plan validation, and reviewer disposition. No implementation or AC-HLT-003 acceptance is claimed by this draft.

## Completion summary

Not complete. This plan is not yet approved; application-code work is gated on independent exact-SHA design review.
