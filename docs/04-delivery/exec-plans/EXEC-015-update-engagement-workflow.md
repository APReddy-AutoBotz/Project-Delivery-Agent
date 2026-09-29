# EXEC-015: Durable update engagement and recipient response

Status: Draft — independent design review pending  
Owner: Implementation controller  
Requirement IDs: FR-UPD-001..012, FR-ESC-001..007, FR-ADM-004, NFR-REL-002, NFR-SEC-001, TR-DATA-001, TR-MSG-001, TR-STACK-006; AC-UPD-002/003/004/006/007/008/009/010, AC-WFL-001  
GitHub issue: #9  
Target release: R1  
Last updated: 2026-09-29

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

1. **Revision and identity.** A due obligation retains the immutable policy revision and selected assessment/source dependencies. Each planned stage has a stable key `(customer, obligation, policy revision, stage kind, ordinal, recipient subject)`. The first request goes only to the configured responsible owner. Any additional recipient must be explicitly named by a later policy revision and pass a current project responsibility and project/portfolio grant check. Never infer recipients from a Jira assignee or an email address found in source text.
2. **Schedule snapshot and policy changes.** At activation, persist the logical due instant from the revision-pinned assessment. For each named stage recipient, resolve the authorized recipient-profile IANA time zone when available, otherwise the project policy zone, otherwise the configured customer zone. Record the chosen zone and its source, original candidate instant, eligible UTC instant, local wall time, UTC offset, weekday/quiet-hour/DST deferral reasons and rule revision. Validate every zone; reject an invalid configured value rather than silently substituting UTC. Reuse EXEC-014's deterministic gap/overlap rules, extending its schedule calculation to per-recipient stages. Recheck a changed recipient zone or policy before send: suppress the old unsent stage and create a new explicit revisioned stage snapshot under a lock, with history linking both, rather than silently sending at the old local time. A policy edit likewise does not silently change an active obligation; a superseding transaction closes unsent stages and creates a new snapshot only after re-assessment with the new policy. Previously sent events remain history.
3. **Domain state and outbox.** Keep authoritative obligation, per-required-fact satisfaction, response and stage state in PostgreSQL. In one transaction, create a stage intent and outbox event when eligible. A unique key prevents a second intent for the same active stage. Graphile Worker wakes processing; the outbox and domain rows remain authoritative after a worker crash. Human waits use `nextActionAt`, not a held process.
4. **Pre-send gate.** An atomic claim locks obligation, stage and outbox; rechecks customer/project scope, current owner/delegate, policy revision, satisfaction, pause/closure, project exemption, current recipient grant, quiet hours, channel policy and global/action shadow mode. A failed check creates a reasoned suppression or deferral receipt. The worker cannot use a previous user's session. Recipient address resolution happens only through the approved customer identity/contact configuration.
5. **Delivery.** Capture mode records the exact bounded message, recipient and secure route without network I/O. Shadow mode records a suppressed attempt and never calls an adapter. Approved email mode requires an explicit customer sender/recipient allowlist and verified foundation security gate. Every adapter call carries a stable correlation/idempotency key where the provider supports it; SMTP itself provides no exactly-once guarantee. After a timeout or uncertain provider outcome, mark UNKNOWN and require provider reconciliation or manual resolution; do not retry blindly. Success, permanent failure and transient retry have bounded, auditable transitions.
6. **Response route.** The link contains only an opaque request locator, never project facts or a bearer authorization. Server-side expiry is stored per invitation and enforced on every read and submit. Production access requires an authenticated OIDC subject equal to the current named recipient, a current project/portfolio grant, and current invitation/obligation state. An invalid, expired, revoked or wrong-recipient locator returns the same non-disclosing denial shape. CSRF, rate limits, no-store responses and redacted logs apply. A responder's allowed project information is rechecked at every read.
7. **Response and interpretation.** Store raw free text and selected choices as a scoped, append-only response with actor, time and source request. Immediately acknowledge receipt, but do not satisfy facts, create canonical versions or write Jira. The later bounded AI extraction produces proposals only, with schema and source-authority validation. Ambiguity creates a focused clarification task. A human confirms/corrects before a permitted fact version and evidence link are created.
8. **Satisfaction and races.** Confirmation locks the obligation and required fact rows, writes confirmed fact versions and a satisfaction mask, suppresses future stages for satisfied facts and adds audit/outbox records atomically. Partial confirmation preserves unresolved clarification/reminder actions. A dispatch worker rechecks state under the same lock before adapter handoff. For any send already in flight, the attempt receipt records the race; the system never claims impossible cancellation of an external email.
9. **Escalation.** PM notification follows only the configured unanswered stages and current PM responsibility/grant. It includes the original request, stage/attempt history, exact unresolved facts and project impact from currently authorized evidence. It excludes hidden source content and personal performance judgments. Later lead/channel cascade requires an explicit policy extension and separate criteria evidence.
10. **Recovery.** Scheduled work is reconstructible from durable due stages/outbox. Claims use leases and fencing generations; expiry permits one safe reclaim. A restored database starts outbound disabled. Reconcile provider idempotency/unknown outcomes before resuming, preserving immutable attempts and audit. No duplicate material action is inferred from a completed database transaction alone.

## Files and modules expected to change

- Domain: `packages/domain/src/project-updates.ts`, `project-update-schedule.ts` and new engagement state/schema module.
- Data: `packages/data/src/project-updates.ts`, new engagement repository, Prisma schema and additive migrations.
- API/web: authorized request/response controllers and contracts, OpenAPI, owner response page and admin policy UI.
- Worker/platform: named Graphile task, narrow signed internal endpoint, shadow/capture dispatch guard and approved email adapter.
- Tests and docs: domain, repository, API, security, recovery and Playwright cases; upgrade/recovery inventories, operator guide, traceability, Issue #9 and status ledger.

## Data model or migration impact

Use additive tables for update stage, request, response, per-fact satisfaction, transactional outbox and immutable attempt/audit history, with composite customer/project foreign keys, unique stage/outbox idempotency keys, expiry and lease indexes, and constrained finite states. Historic policy and assessment rows stay immutable. Existing OPEN obligations are not backfilled into outbound sends; a controlled re-assessment is required. Restrict worker SQL privileges to claim/receipt procedures and scoped reads. Prefix upgrades, clean install, repeat deployment, failed migration recovery and encrypted restore must include the new tables.

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

Pure schedule tests cover recipient-zone preference, project/customer fallbacks, recipient-zone changes, quiet boundaries, weekends, DST gaps/overlaps, invalid IANA zones and reason records. Repository tests cover scope, policy changes, recipient revocation, stage uniqueness, atomic claims, satisfaction races and partial responses. API/Playwright tests cover owner/PM/lead access, wrong user, expired/revoked locator, CSRF, no disclosure, capture/shadow and denial after role changes. Recovery tests crash before/after domain-plus-outbox commit, claim and adapter call, and restart Graphile Worker; unknown delivery stays quarantined. Run required lint, typecheck, unit/integration, build, documentation, browser, migration, upgrade and restore gates on the exact candidate.

## Rollback and recovery

Keep migrations forward-only and old records readable. A rollback of application code leaves new tables intact and turns outbound dispatch off. Never drop attempt history or replay UNKNOWN attempts. An encrypted restore is quarantined, reconciles provider outcomes and owner/policy state, then explicitly resumes dispatch. A defective schedule or authorization path requires an outbound stop and forward fix.

## Progress log

- 2026-09-29: Independent design review identified the recipient-local scheduling omission. Revised stage snapshots to resolve recipient, project, then customer zones and to reschedule explicitly on zone changes; clarified that SMTP has no exactly-once guarantee.
- 2026-09-29: Confirmed main `fa1f48e6987520d479ed3697b7472ed38cb29343`, Issue #9 remaining criteria, EXEC-014's no-send boundary, and the worker's scan-only task. Drafted the next engagement workflow design for independent review.

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

Design review, exact-head checks and merge evidence pending.

## Completion summary

Pending staged implementation and criterion-specific evidence. Issue #9 remains open; accepted-story totals remain R0 3/5 and R1 2/33.
