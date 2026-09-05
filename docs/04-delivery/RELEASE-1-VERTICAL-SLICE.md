# Release 1 Vertical Slice

## Release objective

Demonstrate and deliver one reliable closed loop from stale project information to a verified management answer and approved source-system update.

## Hero workflow

```text
Jira + portfolio spreadsheet
-> detect stale update and delivery concern
-> ask responsible owner a contextual question
-> receive free-text response
-> extract proposed facts
-> clarify or confirm
-> show PM approval diff
-> write approved Jira comment
-> create action receipt
-> recalculate project signal
-> recommend next PM action
-> answer leadership with evidence
-> update dashboard and PowerPoint snapshot
```

## Release 1 users

- PMO Administrator
- Project Manager
- Contributor
- Leadership user
- System Administrator

Scrum-master and team-lead views may reuse the PM action framework but are not required to be fully expanded before the core loop works.

## In-scope source data

### Jira

- Project
- Board and sprint
- Issue
- Status
- Assignee
- Due date
- Selected custom fields
- Comments
- Changelog
- Issue links and parent relationships

### Spreadsheet

- Project ID and name
- PM and sponsor
- Workstream and business unit
- Priority and business impact
- Phase and lifecycle status
- Baseline and forecast dates
- Reported RAG
- Next milestone
- Risks, dependencies and remarks
- Last updated date

## Required Release 1 scenarios

1. Current project: no update request.
2. Stale project: contextual request created.
3. No response: reminders and PM escalation.
4. Valid response: pending reminders stopped.
5. Ambiguous response: clarification requested.
6. Confirmed update: fact version created.
7. Material Jira proposal: approval diff shown.
8. Jira changed after approval: write blocked.
9. Successful Jira comment: action receipt created.
10. GREEN project with critical overdue evidence: contradiction displayed.
11. Leadership delay question: evidence-backed answer.
12. Unknown cause: agent admits uncertainty and requests clarification.
13. Unauthorized user: project and evidence denied.
14. Shadow mode: no external side effects.
15. AI unavailable: monitoring continues and response awaits manual structuring.
16. PowerPoint snapshot uses the same fact set as dashboard and email preview.

## Release milestones

### M1 Foundation

- Monorepo
- CI
- containers
- database
- seed
- auth skeleton

### M2 Project truth

- Jira connector
- spreadsheet import
- canonical model
- evidence ledger
- authority and freshness

### M3 Assurance

- health signals
- contradiction rule
- update obligations
- reminders and escalation

### M4 Controlled action

- response extraction
- clarification
- confirmation
- approval diff
- write-back
- action receipts

### M5 Experience

- PM action queue
- leadership Q&A
- dashboard
- reports

### M6 Release hardening

- security
- failure recovery
- backup and restore
- documentation
- event demo
- pilot package

## Release gate

Release 1 is not complete if only the dashboard or report generator works. The complete engagement, approval, action and explanation loop must pass.

## Deferred from R1

- Full Microsoft Teams bot
- PowerPoint input
- Multiple PM tools
- Resource capacity
- Financial PPM
- Predictive delivery dates
- Automatic baseline or customer communication
- General workflow builder
