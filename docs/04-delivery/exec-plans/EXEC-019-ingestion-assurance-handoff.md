# EXEC-019: Durable connector receipt to project assurance handoff

Status: Design review pending; implementation not started
Owner: Implementation controller
Date: 2026-10-22
Requirement IDs: FR-CON-004, FR-CON-010, FR-HLT-001, FR-HLT-002, FR-UPD-001,
NFR-REL-001, NFR-SEC-001
Criterion: AC-CON-004; supporting AC-HLT-001/002
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7

## Objective and baseline

Complete the missing durable causal handoff from a successfully committed Jira
webhook/reconciliation page to a permission-checked project reassessment and its
optional downstream update obligation. Duplicate delivery must retain one source
observation and one cause, with no duplicate assessment or obligation for that
completed cause. Evaluate existing canonical evidence only; incoming values remain
proposals and gain no verified provenance, trusted timestamp or satisfaction.

Prepare locally on reviewed PR #111 candidate 0eba485 while its ordinary CI runs.
Before publication, reconcile against verified merged main and rerun applicable
gates. PR #110 is merged at 8de6063 with the reviewed tree; its first post-merge
external-customer restore failed at sessions_before_commit and one unchanged
failed-job rerun is in progress. Neither pending CI nor a retry is passing evidence.
Keep original19/20 research capture stopped and preserve all unfinished work.

## Scope

Add receipt/project work to the CONNECTOR_SYNC page path used by real webhook and
scheduled Jira jobs. Enqueue only distinct changed projects whose current reporting
policy explicitly enables the separately configured scheduled service. Use the
existing signed project-update scan route/worker pump; consume causes and record
their exact assessment/obligation lineage. Add bounded administrative status/retry
operations, meaningful native/API/race/restart/upgrade/recovery evidence, and the
required inventory and documentation changes.

This increment does not enqueue from standalone HUMAN connector contract helpers,
CSV/XLSX previews or reviewed imports. Those paths keep their current behavior.
Their broader causal integration remains future scope. No canonical source
publication, interpretation/approval execution, engagement activation, outbound
message, provider/model call, new connector scope or dependency is included.
OD-013/014 remain in force. Preserve Antigravity styling and existing product forms.

## Verified current boundary

acceptWebhook authenticates and deduplicates into ConnectorSyncJob. The runtime
rereads current source data. persistConnectorPageForJob atomically stores outcomes,
observation/proposal revisions, receipt, cursor and completed job, but creates no
project assessment. Existing INT-CON-004 counts stop at proposal projection.
scanScheduledProjects currently selects one project, stamps its attempt separately,
then assesses it. Success is throttled for 60 minutes; failure retry is five minutes.
Jira reconciliation's 15-minute default is a separate schedule.

## Cause creation and storage

Add one table, IngestionProjectReassessment, through migration 25. Required identity
fields: id, customerId, sourceId, receiptId, projectId, configRevision,
mappingRevision, createdAt and immutable reason CONNECTOR_CHANGED. Unique
(customerId, sourceId, receiptId, projectId). Reference the exact CONNECTOR_SYNC
receipt, sync job/project grant scope and canonical project through composite
constraints/validators. Require at least one same-project ACCEPTED CREATE/UPDATE
outcome in the receipt. Do not store values, statements, remote timestamps or SDK
objects. Reject forged scope, revision, mode or unrelated outcome lineage.

Control fields: state READY/COMPLETED/BLOCKED, attemptCount (0..5), totalAttempts
(monotonic), recoveryRevision (monotonic), availableAt, lastReason, assessmentId,
obligationId, previewId, claimedGeneration, completedAt and auditEventId.
READY has no completion references;
COMPLETED has an exact same-project assessment and nullable same-project obligation
from that assessment; BLOCKED has a fixed reason and no completion references.
For an open obligation, bind completion through the exact immutable preview whose
assessmentId/obligationId/customer/project match; an existing reused obligation
retains its original birth assessment. Do not require its birth assessment to be
the new reassessment. Null obligation/preview means the actual prepared view
returned no obligation and there is no preview for that assessment; never infer
this solely from freshness.state. Existing active same-policy engagement can
retain an obligation/preview despite CURRENT project-created fallback when source
facts become unresolved. Preserve and bind that actual output.
Freeze the completion's claim generation too;
future claims must not invalidate historical proof.
Cause fields and completed rows are immutable. Control changes require matching
audit events and narrow SQL validation. No DELETE grant. Index the unique receipt
identity, project/FK lookup and READY project/availableAt/createdAt/id selection;
use a partial READY index rather than scanning all historical completions.

In the existing source-page transaction, after receipt outcomes are built, insert
one cause per changed project with a current enabled reporting policy and nonempty
scheduledServiceSubject. No policy/service enablement is inferred from connector
grants. Skip absent/disabled policies, unchanged/empty/reset-only pages and HUMAN
receipts. Do not alter project scheduler timers while holding ingestion locks.
An insertion/validation failure rolls back page, cursor, receipt, job completion
and cause together. Existing command/event/revision replay and payload-conflict
rules remain unchanged; ON CONFLICT may preserve an identical already-bound cause
but cannot overwrite immutable lineage.

## Unified project claim and processing

Extend ProjectUpdatePolicy with separate scheduler control for periodic due time,
failure next eligibility, claim generation and lease. Preserve legacy timing at
upgrade: copy existing scheduledScanNextEligibleAt into the new mandatory failure
not-before fence as well as retaining it as periodic due time. Its legacy value
may represent success or failure, so conservatively honor it before any new cause
can bypass periodic timing. No immediate privilege or dispatch activation.
A successful scan sets
the next periodic time to now+60 minutes. Failure sets retry to now+five minutes.
A pending available cause bypasses only periodic delay, never failure backoff or
an active lease. Keep engagement-processing timers independent.

The signed route still accepts only {} and selects work server-side. limit=1
continues to mean at most one project per invocation. Eligibility requires current
enabled reporting policy for the configured nonhuman service subject, no active
claim, reached failure retry time, and either periodic due or available READY work.
Order all eligible projects together by least-recent persisted attempt, then stable
customer/project IDs. Source causes do not take unconditional priority over due
periodic projects. Claim Project FOR UPDATE SKIP LOCKED, then its policy head;
increment a generation, set a two-minute database-time lease and stamp attempt.
In that same durable claim transaction, select at most 25 READY causes with
availableAt <= the captured DB-time cutoff, ordered by createdAt/id, and bind their
IDs to claimedGeneration. Charge attemptCount and totalAttempts once at claim,
before committing. Exhausted READY causes are blocked instead of charged again.
Retain this fixed cohort in durable rows and the private claim return value; do
not add newly arrived/unavailable causes during later assessment or failure work.
No model or caller can supply a project, recipient, source date or assessment.

In the assessment transaction, lock Project then policy, recheck exact generation,
unexpired lease and current service policy, and load only the exact READY cohort
bound to that generation, still respecting its availability cutoff. Lock work
rows and revalidate exact source/config/mapping
and active same-project sync grants. For any source/grant lock taken after Project,
use NOWAIT/SKIP LOCKED; on known contention roll back the entire assessment
transaction without completing causes or treating contention as revoked access.
Then release through a separate fenced control transaction: under the same current
generation and unexpired lease, refund precisely that cohort's provisional
attemptCount charge, preserve monotonic totalAttempts, clear claimedGeneration,
defer its availableAt by 60 seconds, clear that claim and preserve the existing
failure fence. Record LOCK_CONTENDED audit lineage. Do not mark a failure or burn
the five-attempt budget for known contention. If that generation/lease is stale,
perform no release/refund; an unknown crashed/expired attempt remains charged.
Source configuration/sync paths
can hold Source before Project, so never block in that inverse order.

For revoked/changed source scope, block the cause with fixed SOURCE_SCOPE_CHANGED,
without consuming its proposed content. If valid causes remain, or periodic work
is independently due, call the existing assessInTransaction under the current
scheduled service actor. Resolve canonical source readers/authority at its real DB
as-of instant. Commit assessment, optional obligation/preview, existing engagement
refresh and valid-cause completion together, recording exact IDs. A genuinely current
project can complete causes without an obligation. An inactive engagement stays
inactive; no external dispatch is added. One assessment may acknowledge the bounded
valid cause batch. Remaining causes stay READY for a later fair project attempt.

Before success/acknowledgement, recheck the same lease/generation. Clear that claim,
advance periodic timing and clear failure backoff only on success. If no valid
cause remains and periodic work is not due, record the blocked work and release
the claim without inventing an assessment. Policy disablement under the existing
authorized PMO transaction fences outstanding claims and blocks READY causes with
POLICY_DISABLED. Reenablement does not silently reset blocked work.

## Failure, overlap and explicit recovery

Keep all claim/attempt clocks server-owned. Each durable automatic claim charges
its selected cohort once, capped at five. A recorded failure retains that charge;
process death/lease expiry also retains it, so repeated crashes cannot retry
forever. When a fifth claimed attempt fails or expires, block with RETRY_EXHAUSTED
before another automatic claim. A successful fifth attempt may complete normally.
Only the exact known-contention refund above or authorized explicit recovery may
reduce attemptCount; totalAttempts never decreases. Failure accounting uses the
durable cohort and its claimedGeneration after rollback, never a fresh READY query.
Retain all immutable audit records. Backoff is five
minutes and applies to the project, so a new event cannot reset a failing project's
fence. An expired claim can be reclaimed with a new generation; stale success or
failure cannot acknowledge causes, overwrite retry state or release a newer claim.
An ambiguous response after commit is handled by durable completion, not another
assessment for the same cause. Database-only assessment/acknowledgement rolls back
as a unit on precommit failure or process death.

Add project-scoped PMO status and explicit retry routes with strict bounded schemas.
Status returns only currently authorized source/cause identifiers, state, fixed
reason, attempt/recovery revision and safe completion references; no values or
source excerpts. Reuse the same current project and source-reader/configuration
authorization as ingestion receipt reads. Retry accepts only workId and expected
recoveryRevision, requires current PMO project administration, current source
authorization, exact unchanged source/config/mapping/sync grant and enabled service
policy, and operates only on BLOCKED work. Completed causes cannot be reset. A
retry increments recoveryRevision, resets attemptCount, preserves totalAttempts,
records an immutable audit event and leaves the project failure fence intact.
Changed historical source/config lineage requires a new genuine synchronization
receipt; retry cannot edit it. Denial or revision conflict writes nothing.

## Data, permissions and recovery

One new business table raises the inventory to 85; scheduler columns add no table.
Preserve all 24 applied migration bytes. Register migration 25 in clean/repeat and
populated prefix-nine/prior-prefix upgrade evidence. API has only reviewed work
reads/inserts/control transitions; worker gets no business-table grants. Backup
can read the complete new history. Add SQL proof/tamper denial for cause/completion
scope and immutable identity, and include the table/columns in exact inventories,
backup, quarantined restore, grants/ownership and recovery correspondence.

Restore keeps runtime CONNECT denied and scanning disabled operationally. Preserve
READY/BLOCKED/COMPLETED rows, exact completion references, attempts and generations.
An active claim becomes reclaimable only after its DB-time lease expires and
current policy/source grants are rechecked; completed causes never run again.
No restore automatically starts a worker or enables an engagement. Rollback is a
reviewed application revert with compatible retained schema; do not drop history.

## Validation and implementation sequence

1. Obtain independent source/design and coverage review of this immutable design.
2. Implement migration, constraints, typed repository/ports, receipt insertion,
   unified claim/scan, scoped status/retry REST contracts and operations inventories.
   Root owns all edits and Git. Keep PR #111's published candidate unchanged.
3. Extend INT-CON-004 through the actual signed task and real repositories: duplicate
   webhook -> one observation/projection/cause/assessment and one stale obligation;
   unchanged reconciliation -> no new cause; current canonical input -> no obligation.
   Prove no canonical versions/timestamps/satisfaction from proposals, and no
   engagement activation or outbound request.
4. Test receipt/cause rollback, assessment/ack rollback, response loss, concurrent
   scans, expired/stale claims and stale failures, five consecutive process-death
   claims reaching exhaustion, bounded 25-cause batches and unavailable READY work
   that must remain uncharged/unprocessed when another cause makes a project due,
   cross-project fairness, periodic work beside a busy source and five-minute
   failure backoff despite new events, including an upgraded legacy failure fence.
   Exercise source/config contention without deadlock, more than five known
   contention releases without false exhaustion, and stale contention refund
   denial. Test source/service/reader revocation; task authentication/replay; explicit
   retry authorization, revision conflicts and completed-work denial. Assert total
   durable obligation count (including closed/superseded rows) and exact reused IDs
   under duplicate/replay, not merely one active row. Preserve the active-engagement
   CURRENT-fallback edge with exact returned obligation/preview completion lineage.
5. Run complete build/lint/types/unit, native API/COMMIT/race/restart, populated
   upgrade and exact 85-table restore, packaged customer profiles, OpenAPI,
   architecture/register/docs/audit and relevant browser/operator journeys. Use only
   explicitly isolated synthetic targets; never the default local pdaa database.
6. Reconcile verified main before publication, obtain final exact-SHA nonauthor
   reviews, pass complete exact-head CI, expected-head merge, actual tree/parent
   verification and post-merge checks. Record real failures without passing credit.
7. Only after original acceptance evidence and independent criterion review consider
   checking AC-CON-004. Issue #7 and all story totals remain open/unchanged unless
   their complete remaining contracts independently pass. Five release holds stay
   open. Research capture remains stopped throughout.

## Progress and decision record

2026-10-22: Independent next-scope review found the concrete missing handoff and
reviewed lock/timing risks. Root chooses the runtime CONNECTOR_SYNC path for this
bounded criterion increment; standalone HUMAN/import integration remains explicit
future scope. Independent review of this concrete design is pending. No queue,
migration, new endpoint, hosted diagnostic or acceptance claim has been implemented.
