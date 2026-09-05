# Reporting Requirements

## Reporting model

The live application is the current source of truth. Email and presentation files are communication or historical snapshot channels.

## Live dashboard

The dashboard must show:

- Portfolio and project health
- Reported RAG and calculated signals separately
- Last verified update
- Missing or late updates
- Milestone position
- Risks, issues and dependencies
- Decisions required
- Recommended actions
- Conflicts and unresolved questions
- Evidence and freshness
- Approval and write history

## Role action queues

### Project Manager

- Proposed updates awaiting review
- Missing forecasts
- Stale blockers
- Dependencies needing follow-up
- Suggested communications
- Upcoming reporting obligations

### Scrum Master

- Stale blockers
- Repeated carryover
- Unowned work
- Sprint goal concerns
- Missing team updates

### Team Lead

- Technical dependencies
- Unowned critical work
- Missing estimates or forecasts
- Unresolved decisions

### PMO

- Projects missing updates
- Conflicting RAG or milestones
- Portfolio dependencies
- Reports awaiting approval
- Projects needing management attention

### Leadership

- Projects needing intervention
- Decisions awaiting leadership
- Material changes since previous period
- Low-confidence forecasts

## Email digest

A leadership digest should contain:

- Material changes
- Projects that moved health state
- Decisions required
- Critical risks and dependencies
- Missing project updates
- Link to the authenticated live view

The email must not include confidential detail beyond recipient authorization.

## PowerPoint/PDF snapshot

Release 1 snapshot sections:

1. Portfolio summary
2. Projects requiring attention
3. Key changes since previous snapshot
4. Critical milestones
5. Risks and dependencies
6. Decisions required
7. Missing or low-confidence information
8. Appendix with project detail where configured

Each snapshot must display:

- Reporting period
- Generation timestamp
- Approval status
- Data freshness
- Version or snapshot ID
- Confidentiality classification
- Optional evidence references

## Consistency

The dashboard, email and formal snapshot must use the same reporting-run fact set. A generated final snapshot remains immutable even if live project data changes later.

## Report approval

Draft reports may be generated automatically. Final distribution must follow customer policy. Customer-facing and board-level reports require explicit approval in Release 1.

## Accessibility and usability

- Avoid dense text.
- Use accessible contrast and labels, not color alone.
- Explain RAG criteria.
- Keep executive summaries concise.
- Provide detailed evidence in drill-down or appendix.
- Make generated PowerPoint content editable.
