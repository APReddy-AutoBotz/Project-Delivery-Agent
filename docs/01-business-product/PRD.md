# Product Requirements Document

## 1. Product definition

The Project Delivery Assurance Agent is a customer-hosted application that continuously monitors project information, identifies missing or contradictory updates, coordinates follow-up, recommends role-specific actions, controls write-back and provides evidence-backed leadership answers.

## 2. Product promise

> Keep project truth current, coordinate the next action and explain delivery with evidence.

## 3. Primary jobs to be done

### Leadership

“When I need to understand a project or portfolio, give me the latest verified position, the cause of any problem, the action being taken, the remaining uncertainty and the evidence.”

### Head of PMO

“When project reporting is due, show me what is missing or inconsistent, drive the follow-up process and produce an approved portfolio view.”

### Project Manager

“When delivery information changes, reduce my administration, tell me what needs intervention and prepare safe updates for my approval.”

### Scrum Master or Team Lead

“When work is blocked or updates are stale, identify the relevant people and suggest a practical follow-up.”

### Contributor

“When my input is needed, ask one focused question with enough context and make it easy to respond.”

## 4. Product principles

1. Evidence before narrative
2. Deterministic signals before AI interpretation
3. Human accountability for material commitments
4. Minimum necessary permissions
5. One product, configurable by customer
6. Action queues before generic chat
7. Live view plus immutable snapshots
8. Useful without AI
9. Explain uncertainty
10. Safe failure instead of silent guessing

## 5. Core experiences

### 5.1 Project Truth Workspace

- Current project status
- Last verified update
- Source and evidence for important facts
- Open conflicts
- Risks, issues, dependencies and decisions
- Planned versus forecast dates
- Action and approval history

### 5.2 PM Action Queue

- Updates awaiting approval
- Missing forecasts
- Stale blockers
- Dependencies needing escalation
- Suggested stakeholder communications
- Reminders ready to send
- Source conflicts requiring reconciliation

### 5.3 Update Interaction

The product sends a focused request containing:

- Project or work item
- Current known position
- Missing information
- Previous commitment
- Response options
- Secure link or supported reply channel
- Due date and escalation context

### 5.4 Approval Diff

Before a material write, the user sees:

- Current value
- Proposed value
- Extracted reason
- Source person and timestamp
- Supporting evidence
- Systems to be updated
- Notifications to be sent
- Edit, approve or reject controls

### 5.5 Leadership Q&A

A leader can select one permitted project for each R1 question; multi-project aggregation is deferred to R3. The answer contains:

- Direct response
- Current health and change since the previous period
- Verified cause
- Actions taken and pending
- Decisions required
- Remaining uncertainty
- Claim-level evidence links
- Data freshness

### 5.6 PMO Portfolio Workspace

- Portfolio health
- Missing and late updates
- Project confidence and freshness
- Cross-project dependencies
- Contradictions
- Decisions required
- Report generation and approval

## 6. Release 1 scope

Release 1 must include:

- Jira Cloud read integration
- Excel or CSV portfolio import
- Canonical project model
- Evidence ledger and source authority
- Freshness and completeness checks
- At least one deterministic delivery-risk rule
- Contextual update requests
- Reminder and escalation state machine
- Secure in-app response flow
- AI-assisted structured extraction from a reply
- Human approval diff
- Approved Jira comment write-back (field writes deferred to R2)
- Action receipts
- PM recommendation
- Leadership Q&A with evidence
- Live dashboard
- Editable PowerPoint management snapshot; optional PDF
- Role-based access
- Shadow mode
- Customer-configurable AI provider
- Customer-hostable container deployment

## 7. Out of Release 1 scope

- Full replacement for project-management tools
- Resource capacity optimisation
- Portfolio financial planning
- Timesheets
- General demand intake
- Predictive completion dates based on weak data
- Employee productivity or performance scoring
- Automatic baseline changes
- Automatic customer-facing communication
- ClickUp, Trello, monday.com and Asana connectors
- PowerPoint ingestion
- Full Microsoft Teams conversational bot
- A general no-code workflow builder
- Kubernetes as the default deployment

## 8. Long-term capabilities

- Outlook/shared mailbox response processing
- Teams and Slack interaction
- Confluence, SharePoint and OneDrive evidence
- Cross-project dependency propagation
- RAID hygiene and unlogged-risk detection
- Advanced portfolio contradiction detection beyond the two R1 rules
- Portfolio-level recommendations
- Multiple PM tool connectors
- Customer-specific report templates
- MCP interface for controlled external assistants
- Optional Atlassian/Rovo interaction layer
- Signed offline product licences
- Source-access and escrow commercial tiers

## 9. User experience requirements

- A user must see why the product is asking for an update.
- Reminders must show prior requests and remaining due time.
- The product must not overload users with every signal.
- Role workspaces must rank items by urgency and impact.
- Evidence must be inspectable without leaving the answer where possible.
- A fact classification and freshness indicator must be visible on material claims.
- Approval must show the proposed consequence, not only the generated text.
- Users must be able to correct the agent’s interpretation.
- Shadow mode must be clearly visible.
- The interface must support keyboard navigation and accessible contrast.

## 10. Product analytics

Measure:

- Updates requested, received and late
- Reminder count and response conversion
- Time from request to valid response
- Approval acceptance, edit and rejection rates
- Alerts acknowledged and dismissed
- Q&A usage and evidence coverage
- Report preparation time
- Connector failures
- AI extraction correction rate
- Unsupported-answer rate
- Active users by role

Analytics must not become employee performance scoring.

## 11. Release acceptance

Release 1 is acceptable only when the complete hero workflow works end to end and all P0 acceptance criteria pass, including permission failures, conflicting sources, duplicate events, ambiguous replies, expired credentials and source changes between approval and write-back.

## Approved R1 scope decisions (2026-09-06)

- External project writes: approved Jira comments only; non-baseline field writes move to R2.
- Q&A: one explicitly resolved authorized project per answer; multi-project/portfolio analysis remains R3. Portfolio dashboards may list authorized projects.
- Reporting: editable PowerPoint required; PDF is optional and cannot substitute for PowerPoint.
- Cadence: weekday calculations, IANA time zones and quiet hours in R1; customer holiday calendars in R2.
- Health: stale/missing updates, blocker age, overdue work, GREEN-versus-critical-signal and completed-milestone-versus-open-work rules in R1; advanced propagation later.
- Basic OIDC user/group role mapping and enforced scope are foundation work; later enterprise administration extends them.

These decisions resolve OD-003/006/007/008 and conflicting earlier release wording.
