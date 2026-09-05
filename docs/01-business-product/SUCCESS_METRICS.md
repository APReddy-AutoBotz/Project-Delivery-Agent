# Success Metrics

## Product outcome metrics

| ID | Metric | Direction |
|---|---|---|
| MET-001 | PM/PMO hours spent on update chasing and report preparation | Decrease |
| MET-002 | Percentage of project updates received by the agreed deadline | Increase |
| MET-003 | Percentage of active projects with a current verified update | Increase |
| MET-004 | Median time to answer a leadership project-status question | Decrease |
| MET-005 | Percentage of material answer claims with valid evidence | Increase |
| MET-006 | Number of material delivery risks identified before the scheduled report | Increase initially |
| MET-007 | Median response time after an update request | Decrease |
| MET-008 | Percentage of external writes with complete action receipts | Target 100% |
| MET-009 | Percentage of AI-extracted updates accepted without correction | Increase |
| MET-010 | Unsupported or ungrounded answer rate | Decrease |
| MET-011 | False or low-value alert rate | Decrease |
| MET-012 | Active weekly usage by PMs and PMO | Increase |

## Release 1 quality targets

| Metric | Initial target |
|---|---:|
| Material claims with evidence | 100% |
| External writes with approval where required | 100% |
| External writes with action receipt | 100% |
| Cross-project data leakage in tests | 0 |
| Duplicate webhook resulting in duplicate action | 0 |
| Valid owner response stopping pending reminders | 100% |
| High-risk ambiguous response written automatically | 0 |
| P0 acceptance criteria passed | 100% |
| Golden grounding scenarios passed | At least 95% |
| Critical security findings at release | 0 |

## Pilot measurement

Establish a two-to-four-week baseline before automation where possible, then compare:

- Current hours per reporting cycle
- Projects updated on time
- Average update age
- Number of reminder messages sent manually
- Time from risk identification to PM acknowledgement
- Time to prepare the steering report
- Time to answer ad hoc leadership questions
- Number of source conflicts found
- User acceptance and perceived usefulness

## Guardrail metrics

The product must not optimize only for reminder volume or task activity.

Monitor:

- User complaints or reminder opt-outs
- Requests sent outside quiet hours
- Repeated unnecessary escalations
- Incorrect responsibility assignment
- Excessive LLM cost
- Sensitive content sent to an unapproved provider
- Answers withheld because evidence is insufficient
- Recommendations dismissed as irrelevant

A healthy product reduces administration without becoming intrusive surveillance.
