# EXEC-015: Durable update engagement and recipient response

Status: Approved design — staged implementation in progress  
Owner: Implementation controller  
Requirement IDs: FR-UPD-001..012, FR-ESC-001..007, FR-ADM-004, NFR-REL-002, NFR-SEC-001, TR-DATA-001, TR-MSG-001, TR-STACK-006; AC-UPD-002/003/004/006/007/008/009/010, AC-WFL-001  
GitHub issue: #9  
Target release: R1  
Last updated: 2026-09-30

## Objective

Extend the source-authorized, revision-pinned update obligation and cadence preview into a durable request, recipient response, reminder and escalation workflow. Keep a human statement separate from a confirmed fact and a dispatched notification separate from a saved draft. This plan covers implementation stages; no criterion or story becomes accepted until its own evidence and merge gates pass.

## In scope

- Persist planned stages, request/response history, an outbox, dispatch attempts and deferral/unknown-outcome reasons.
- Provide authenticated, recipient-bound, expiring response access for the configured owner and explicitly authorized PM/lead/contributor recipients.
- Capture free text and configured choices as unconfirmed responses; prepare schema-valid proposed interpretations in the later AI stage, with confirmation before fact satisfaction.
- Use the existing deterministic IANA weekday/quiet-hour schedule, then re-evaluate current obligation and access state at dispatch.
- Suppress satisfied-fact reminders in the same transaction that commits confirmed facts. Keep unresolved facts eligible for clarification.
- Rehearse crash/restart, duplicate work, ambiguous delivery and quarantined restore using synthetic identities and a capture adapter.
- Add approved customer-hosted email delivery only after the foundation messaging security gate, sender/recipient policy and operator configuration are evidenced.

## Out of scope

- Public Jira OAuth onboarding, callback or live Jira activation under OD-013.
- Publishing spreadsheet import proposals as canonical facts.
- Automatic Jira changes, unapproved channels, leadership broadcast, employee scoring or customer holiday calendars.
- Treating a received response as satisfied facts before authorized confirmation.
- Claiming that a local capture adapter proves real SMTP deliverability.

## Current state

EXEC-012 stores an assessed, source-authorized update preview and an OPEN/SUPERSEDED obligation pinned to a policy revision. EXEC-014 stores bounded reminder offsets, one PM escalation recipient and quiet hours, and calculates a transient schedule. It sends nothing, persists no stage events and offers no response route. The worker currently invokes a signed scan endpoint but has no engagement dispatch task. Foundation security controls exist, while STORY-004/005 and the release security assessment remain unaccepted. Therefore production sends remain disabled until their applicable gate is met. Issue #9 has accepted AC-HLT-001, AC-UPD-001 and AC-ADM-002 only.

## Proposed design

1. **Revision and identity.** A due obligation retains the immutable policy revision and selected assessment/source dependencies. Each planned recipient-stage has a stable key `(customer, obligation, policy revision, stage kind, ordinal, recipient subject)`. The first request and owner reminders go only to the configured responsible owner. Additional recipients must be explicitly named by the applicable policy revision or an audited authorized delegation, and each must pass a current project responsibility and project/portfolio grant check. The already configured PM in that same revision is a valid escalation recipient; no later policy edit is required. Never infer recipients from a Jira assignee or an email address found in source text.
2. **Schedule snapshot and policy changes.** At activation, persist the logical due instant from the revision-pinned assessment. For each named stage recipient, resolve the authorized recipient-profile IANA time zone when available, otherwise the project policy zone, otherwise the configured customer zone. Record the chosen zone and its source, original candidate instant, eligible UTC instant, local wall time, UTC offset, weekday/quiet-hour/DST deferral reasons and rule revision. Validate every zone; reject an invalid configured value rather than silently substituting UTC. Reuse EXEC-014's deterministic gap/overlap rules, extending its schedule calculation to per-recipient stages. Recheck a changed recipient zone or policy before send: suppress the old unsent stage and create a new explicit revisioned stage snapshot under a lock, with history linking both, rather than silently sending at the old local time. A policy edit likewise does not silently change an active obligation; a superseding transaction closes unsent stages and creates a new snapshot only after re-assessment with the new policy. Previously sent events remain history.
3. **Domain state and outbox.** Keep the existing ProjectUpdateObligation row immutable except its existing OPEN→SUPERSEDED transition. Store current engagement owner, per-required-fact satisfaction, response and stage state in new PostgreSQL rows linked to that obligation. In one transaction, create a stage intent and outbox event when eligible. A unique key prevents a second intent for the same active stage. Graphile Worker wakes processing; the outbox and domain rows remain authoritative after a worker crash. Human waits use `nextActionAt`, not a held process.
4. **Pre-send gate.** An atomic claim locks obligation, stage and outbox; rechecks customer/project scope, current owner/delegate, policy revision, satisfaction, pause/closure, project exemption, current recipient grant, quiet hours, channel policy and global/action shadow mode. It also re-assesses the latest normalized, source-authorized fact versions and freshness rule under the current source-access boundary. If a source update now satisfies the required information, suppress the corresponding pending fact stages atomically with the refreshed engagement state; never send from an obsolete preview. An inaccessible or ambiguous source dependency fails closed and requests re-assessment. A failed check creates a reasoned suppression or deferral receipt. An authorized delegate transfer atomically cancels unsent old-owner stages, records the actor/reason/grant, updates the mutable engagement-owner row linked to the immutable obligation and creates revisioned replacement stages for the currently authorized delegate; it never leaves required facts without a next action. The worker cannot use a previous user's session. Recipient address resolution happens only through the approved customer identity/contact configuration.
5. **Delivery.** Capture mode records the exact bounded message, recipient and secure route without network I/O. Shadow mode records a suppressed attempt and never calls an adapter. Approved email mode requires an explicit customer sender/recipient allowlist and verified foundation security gate. Every adapter call carries a stable correlation/idempotency key where the provider supports it; SMTP itself provides no exactly-once guarantee. Persist a pre-call handoff marker before adapter invocation. After a timeout, crash after handoff, or uncertain provider outcome, mark UNKNOWN and require provider reconciliation or manual resolution; do not retry blindly. Only a claim proven to have expired before handoff may be reclaimed for dispatch. Success, permanent failure and transient retry have bounded, auditable transitions.
6. **Response route.** The link contains only an opaque request locator, never project facts or a bearer authorization. Server-side expiry is stored per invitation and enforced on every read and submit. Production access requires an authenticated OIDC subject equal to the current named recipient, a current project/portfolio grant, and current invitation/obligation state. An invalid, expired, revoked or wrong-recipient locator returns the same non-disclosing denial shape. CSRF, rate limits, no-store responses and redacted logs apply. A responder's allowed project information is rechecked at every read.
7. **Response and interpretation.** Store raw free text and selected choices as a scoped, append-only response with actor, time and source request. Immediately acknowledge receipt, but do not satisfy facts, create canonical versions or write Jira. The later bounded AI extraction produces proposals only, with schema and source-authority validation. Ambiguity creates a focused clarification task. A human confirms/corrects before a permitted fact version and evidence link are created.
8. **Satisfaction and races.** Human-response confirmation locks the obligation and required fact rows, writes confirmed fact versions and a satisfaction mask, suppresses future stages for satisfied facts and adds audit/outbox records atomically. Independently, an authorized source observation that now satisfies the freshness rule re-assesses and suppresses the corresponding pending stages in one transaction without treating an unconfirmed human reply as a fact. Partial confirmation or partial source satisfaction preserves unresolved clarification/reminder actions. A dispatch worker repeats source and state checks under the same lock before adapter handoff. For any send already in flight, the attempt receipt records the race; the system never claims impossible cancellation of an external email.
9. **Escalation.** The accepted R1 default template is owner request at due time, owner reminders after business days 1 and 2, and owner plus configured PM escalation on business day 3. Preserve disabled cadence fields on historical policy revisions so no old obligation gains surprise sends. A new policy becomes send-eligible only when its responsible owner is explicitly configured and currently authorized. A PM escalation stage additionally requires its configured PM recipient to be currently authorized; if that stage is enabled but invalid, keep that stage outbound-disabled and surface a configuration action. A customer may validly disable or change the default escalation without blocking authorized owner requests. Customer policy may change the bounded stages. At PM escalation, create separate recipient-stage intents for owner and PM, each with current responsibility/grant checks, only after the configured unanswered stages. The PM view includes the original request, stage/attempt history, exact unresolved facts and project impact from currently authorized evidence. It excludes hidden source content and personal performance judgments. Later lead/channel cascade requires an explicit policy extension and separate criteria evidence.
10. **Recovery.** Scheduled work is reconstructible from durable due stages/outbox. Claims use leases and fencing generations. Lease expiry permits reclaim only when the durable record proves no adapter handoff occurred. If handoff may have occurred, quarantine as UNKNOWN even if the provider has no receipt; resolve by provider reconciliation or manual review, never automatic resend. A restored database starts outbound disabled. Reconcile provider idempotency/unknown outcomes before resuming, preserving immutable attempts and audit. No duplicate material action is inferred from a completed database transaction alone.

## Files and modules expected to change

- Domain: `packages/domain/src/project-updates.ts`, `project-update-schedule.ts` and new engagement state/schema module.
- Data: `packages/data/src/project-updates.ts`, new engagement repository, Prisma schema and additive migrations.
- API/web: authorized request/response controllers and contracts, OpenAPI, owner response page and admin policy UI.
- Worker/platform: named Graphile task, narrow signed internal endpoint, shadow/capture dispatch guard and approved email adapter.
- Tests and docs: domain, repository, API, security, recovery and Playwright cases; upgrade/recovery inventories, operator guide, traceability, Issue #9 and status ledger.

## Data model or migration impact

Use additive tables for mutable engagement-owner/state, update stage, request, response, per-fact satisfaction, transactional outbox and immutable attempt/audit history, with composite customer/project foreign keys, unique stage/outbox idempotency keys, expiry and lease indexes, and constrained finite states. Historic policy, assessment and obligation identity/content rows stay immutable under their current triggers; only the established obligation supersession transition is permitted. Existing OPEN obligations are not backfilled into outbound sends; a controlled re-assessment is required. Restrict worker SQL privileges to claim/receipt procedures and scoped reads. Prefix upgrades, clean install, repeat deployment, failed migration recovery and encrypted restore must include the new tables.

## Security and privacy impact

Production response authorization is OIDC plus named recipient and current project grant; a URL alone grants no access. Project facts and invitation existence are not disclosed by denial responses. Raw reply and message bodies follow customer retention and evidence ACL, stay out of audit/log text, and are never sent to AI without configured routing/redaction. Worker identity and email credentials are separate from user sessions. Message content is drawn from current source-authorized evidence immediately before send.

## Connector and permission impact

No Jira scope or OAuth change. No Jira write. Email is a separate customer-approved outbound channel behind the common shadow guard; it adds no permission until configured and validated. Synthetic capture has no external side effect.

## Open-source dependency impact

Prefer existing Graphile Worker and platform dependencies. Any SMTP library or new runtime package requires pinned version, licence and notice review before adoption.

## Implementation stages

1. Independently review this design, resolve source-authority, delivery, identity and race concerns, then merge a plan-only PR after exact-head Documentation and Foundation checks.
2. Implement durable stage/outbox/attempt state, deterministic deferral reasons and capture/shadow processing. Prove AC-UPD-007 and the applicable AC-WFL-001 crash cases without enabling network sends.
3. Implement the authenticated recipient-bound response page and append-only response capture. Prove AC-UPD-003 and the response-access part of AC-UPD-009 using browser and denial tests.
4. Add bounded interpretation proposals and human confirmation, atomically satisfying facts and suppressing reminders. Prove applicable AC-UPD-004/006 and partial-response races.
5. Add customer-approved email delivery and configured recipients/channels only after foundation gates. Prove AC-UPD-002/008/009/010, unknown-outcome recovery and shadow suppression. Leave live sends disabled where customer configuration is absent.
6. For each implementation PR: obtain a separate non-author exact-candidate review, pass Foundation and Documentation workflows on that SHA, merge with expected head, check post-merge workflows, then update Issue #9 and status only for criteria actually evidenced.

## Test and evaluation plan

Pure schedule tests cover recipient-zone preference, project/customer fallbacks, recipient-zone changes, quiet boundaries, weekends, DST gaps/overlaps, invalid IANA zones and reason records. Repository tests cover scope, policy changes, recipient revocation, atomic delegate cancel-and-replan, stage uniqueness, atomic claims, pre-handoff reclaim versus post-handoff UNKNOWN, source-driven freshness satisfaction, stale preview suppression, satisfaction races and partial responses. API/Playwright tests cover owner/PM/lead access, wrong user, expired/revoked locator, CSRF, no disclosure, capture/shadow and denial after role changes. Recovery tests crash before/after domain-plus-outbox commit, claim and adapter call, and restart Graphile Worker; unknown delivery stays quarantined. Run required lint, typecheck, unit/integration, build, documentation, browser, migration, upgrade and restore gates on the exact candidate.

## Rollback and recovery

Keep migrations forward-only and old records readable. A rollback of application code leaves new tables intact and turns outbound dispatch off. Never drop attempt history or replay UNKNOWN attempts. An encrypted restore is quarantined, reconciles provider outcomes and owner/policy state, then explicitly resumes dispatch. A defective schedule or authorization path requires an outbound stop and forward fix.

## Progress log

- 2026-09-30: Corrected storage candidate passed independent review and 1615 unit tests, then the required high audit gate reported existing development brace-expansion 5.0.9. Prepared the publisher's MIT 5.0.11 patch using pinned pnpm 11.19.0 lockfile-only resolution with scripts disabled. Hosted preparation run 36720861453 read registry metadata and produced the exact lock diff; tarball integrity is `sha512-awigjhi6cLTh90bdw6+QJ9CtmJmyYhEIi70iCbc8Rozn04Fw9FeQIBjv/E22FFGuCGx1bLJyUfB64x/szUSXUg==`. Added finite override/registration and removed the temporary read-only preparation workflow. No audit gate is waived; fresh review and all checks are required.

- 2026-09-30: First Stage 2a independent candidate review found malformed dollar delimiters in one trigger function; fixed them. Hosted validation also identified the centralized function-ACL contract's old inventory; extended its exact validator/guard allowlists without expanding execution privileges. Recovery accepts the new exact engagement TRUNCATE guard when canonical CASCADE reaches linked engagement history. Fresh candidate review/checks are required.

- 2026-09-30: Stage 2a candidate adds engagement, immutable stage snapshots, transactional outbox and automatic append-only transition receipts. Composite lineage preserves the obligation's exact policy/assessment identity; fenced claims can be reclaimed only before handoff, and UNKNOWN is terminal in this slice. API and worker have no privileges on these new tables. Upgrade creates no engagement rows. This is a storage foundation, not capture dispatch, quiet-hour scheduling acceptance or a completed AC-WFL-001 crash rehearsal. Stage 2b must wire same-transaction current-source assessment, current recipient/zone checks, explicit activation, real schedule reason calculation, and signed shadow/capture processing before claiming Stage 2 complete.
- 2026-09-30: Verified PR #104 design and PR #105 pure stage gate merges, identical reviewed/merged trees and successful post-merge Foundation/Documentation runs. Updated governance and status records; no acceptance totals changed.

- 2026-09-29: Current schema inspection showed ProjectUpdateObligation is immutable except supersession. Clarified that delegation and fact satisfaction update a new linked engagement-state row, preserving the existing trigger and obligation history.
- 2026-09-29: Final design-delta review clarified that a disabled PM stage cannot block otherwise authorized owner requests; PM recipient validity gates only an enabled PM stage.
- 2026-09-29: Independent design review found an incomplete delegate transfer and unsafe lease reclaim after possible SMTP handoff. Added atomic old-owner cancel/delegate replan and a durable handoff boundary with UNKNOWN quarantine.
- 2026-09-29: Independent design review found missing source-driven stop conditions. Added current source-authorized freshness re-assessment and atomic suppression before dispatch, separate from human-response confirmation.
- 2026-09-29: Independent design review found that the PM escalation already belongs to the applicable revision and the accepted default includes the owner at day-3 escalation. Corrected recipient-stage identity, current-revision PM use, legacy defaults and new-policy send eligibility.
- 2026-09-29: Independent design review identified the recipient-local scheduling omission. Revised stage snapshots to resolve recipient, project, then customer zones and to reschedule explicitly on zone changes; clarified that SMTP has no exactly-once guarantee.
- 2026-09-29: Confirmed main `fa1f48e6987520d479ed3697b7472ed38cb29343`, Issue #9 remaining criteria, EXEC-014's no-send boundary, and the worker's scan-only task. Drafted the next engagement workflow design for independent review.

- 2026-09-30: Candidate 60e9c7 passed audit, unit and migration gates, and reached native storage evidence. ACL reconstruction correctly refused older fixture tables owned by the local synthetic superuser. Align only current-user-owned tables in the guarded isolated pdaa_test database with pdaa_migrate, matching the existing prefix-upgrade rehearsal. Production ownership checks remain strict; fresh exact-candidate review and full hosted validation remain required.

- 2026-09-30: Production validation reached TLS/OIDC/runtime authorization checks, then stopped at an old 21-migration inventory assertion. Extend both producer and independent host inventory to migration 22 and the four new business tables; require them empty after legacy upgrades and verify their least-privilege ACLs after upgrade/restore. Populated storage recovery remains covered by the native synthetic rehearsal. No production send or workflow acceptance is inferred.

- 2026-09-30: Independent review also identified the customer composition rehearsal's old 21/74 inventory. Extend its exact installed/backup/restore projection and empty-table checks with all four engagement tables; require current finite ACLs on installed, upgraded and quarantined restored databases. Keep the populated synthetic fixture evidence distinct.

- 2026-09-30: Independent inventory scan found the scalar recovery receipt's active host assertion also pinned 21 migrations / 74 tables. Extend it and its positive/negative fixtures to 22/78, retaining rejection of missing and future migration counts. Candidate fce64's native verify job passed 1,615 unit, 134 integration and 39 browser tests, populated 78-table restore and storage fixtures; production/final candidate gates remain pending.

- 2026-09-30: Production legacy-upgrade evidence exposed an intermediate-fixture misuse of current release ACL reconstruction: the deliberately pre-cadence 20-migration fixture has neither cadence nor engagement functions yet. Apply only the migration engine to this intermediate owner-only fixture, then retain the final full migrateRelease and ACL verification after all 22 migrations. Production release ACLs remain complete and strict.

- 2026-09-30: Candidate 8dbac passed native verify and production migration/whole-database restore probes. The additional independent prefix-six host inventory still omitted the four new empty tables; extend that explicit assertion while retaining exact prior-history and row checks. Final Foundation remains failed until fresh complete validation passes.

- 2026-09-30: Stage 2b preparation begins with deterministic recipient-stage snapshots and policy lineage. Owner business-day offsets remain anchored to the eligible owner request; PM fanout uses the owner escalation instant as a lower bound and then applies the PM-local weekday/quiet-hour rules. This prevents a distant PM zone from escalating before the configured unanswered owner stages. The repository must bind those server-selected anchors, subjects and revisions under its transaction; a pure planner is not authorization or dispatch evidence. Historical policy/obligation rows remain unchanged except established supersession after explicit re-assessment.

- 2026-09-30: Stage 2b independent review caught the second autumn overlap occurrence: quiet-hour end resolution must honor the current instant as a lower bound. Preserve the earlier-overlap rule for unanchored candidates, select the later overlap when necessary during eligibility, and record DST_GAP only for an actually nonexistent wall time. Added the New York second-occurrence regression; fresh review and hosted checks remain required.

## Decisions made

- Begin with durable capture/shadow and authenticated response access; production sends require the existing foundation security gate and approved customer email configuration.
- Use an opaque locator plus current OIDC recipient/project authorization, never a bearer link with project data.
- Preserve immutable obligation policy snapshots and explicit supersession.
- Keep raw replies and extraction proposals outside canonical facts until human confirmation.
- Keep OD-013 and reviewed spreadsheet import-proposal boundaries in force.

## Risks and mitigations

- A stale policy or revoked recipient could misdirect a message: lock and recheck current grants and policy at claim/send, with a reasoned stop.
- SMTP may return an ambiguous result: UNKNOWN is a quarantined state, not an automatic retry.
- A response can race dispatch: transactional suppression plus a recorded in-flight outcome avoids a false cancellation claim.
- A restored outbox can replay: restore starts outbound disabled and requires reconciliation.

## Validation evidence

- Design [PR #104](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/104): independently reviewed candidate `dfb37b894912b9b4b8d1582611d07a41abce4ae3`, merge `8fa204eb25ee7fe7f14b4f90a15f5048a0d0c9d5`, identical tree `db38a1bcff56dc4775d84eacc7ea9172a30b0269`. Candidate [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36598915585) and [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36598915538), and post-merge [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36602482509) and [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36602482117), passed.
- Pure stage gate [PR #105](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/105): independently reviewed candidate `78d448c66d719ebd0522b4248f9e52360bde1af8`, merge `036b5bb5804b5cf3feab6853845b3cc49a086820`, identical tree `3fa9504ffb4245b88a8bbc3c3ff281dd6e4cfd48`. Candidate [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36600702589), and post-merge [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36603903345) and [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/36603903354), passed.
- Stage 2b scheduling/lineage candidate: pending independent exact-SHA review and hosted validation; no activation route, dispatcher, recipient response or adapter is included in this preparation.
- Stage 2a storage candidate: independent exact-SHA review and hosted checks pending. Local execution remains unavailable because the desktop process helper fails before launching PowerShell; required checks run in hosted CI. Native synthetic fixtures test atomic stage/intent commit, uniqueness, concurrent claims, pre-handoff lease expiry, terminal uncertain handoff, reason persistence, immutable receipts, finite ACL reconstruction, empty prefix upgrades and populated restore. They do not prove live email or a recipient response workflow.

## Completion summary

Pending staged implementation and criterion-specific evidence. Issue #9 remains open; accepted-story totals remain R0 3/5 and R1 2/33.
