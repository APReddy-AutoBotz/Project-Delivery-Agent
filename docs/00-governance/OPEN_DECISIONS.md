# Open Product Owner Decisions

These decisions do not block creation of the documentation baseline. Recommended defaults are provided so review can be efficient.

| ID | Decision | Recommended default | Needed by |
|---|---|---|---|
| OD-001 | Final product name | Continue with “Project Delivery Assurance Agent” as working name | Before external branding |
| OD-002 | First production buyer segment | Consulting/IT services delivery PMO using Jira and Excel | Pilot outreach |
| OD-003 | First Jira write operation | Approved comment first; add allowlisted field only after stability | R1 implementation |
| OD-004 | Demo email provider | Simple transactional adapter for demo; Microsoft Graph in R2 | Demo deployment |
| OD-005 | Initial AI provider | Provider-neutral architecture; use available high-quality API for demo | AI implementation |
| OD-006 | Default cadence | Request at due time, reminders on business days 1 and 2, PM escalation day 3 | R1 configuration |
| OD-007 | R1 health rules | Stale update, blocker age, overdue critical work and two contradiction rules | R1 implementation |
| OD-008 | Leadership answer format | Direct answer, cause, impact, action, uncertainty, evidence | R1 UX |
| OD-009 | Customer source-access offer | Standard images only; source access priced separately | Commercial proposal |
| OD-010 | AvalaOS integration | No integration in R1; API-compatible future boundary | Product roadmap |
| OD-011 | Event demo dataset | Synthetic Atlas/Draco portfolio | Demo build |
| OD-012 | Default deployment | Docker Compose/OCI on Linux with external PostgreSQL supported | R1 deployment |

A change to a recommended default should update the related requirement, ADR or release document.

## Implementation dispositions, 2026-09-06

Under the Product Owner's delegated controller authorization:

- OD-001/002/009: keep working name and recommended buyer/packaging assumptions; branding, final pricing and legal terms remain commercial decisions before external commitments.
- OD-003: accepted, approved comment only in R1; selected fields R2.
- OD-004: local capture adapter for synthetic development; customer-approved SMTP adapter for R1 notification; Microsoft Graph R2. No live send without configured policy and credentials.
- OD-005: deterministic mock provider for development/CI; provider-neutral adapter with approved customer endpoint. A missing live credential blocks only live tests.
- OD-006: accepted default, weekday reminders on days 1/2 and PM escalation day 3 with recipient timezone and quiet hours; holidays R2.
- OD-007: accepted, stale/completeness, blocker age, overdue critical work and the two documented contradictions.
- OD-008: accepted format for a single authorized project; portfolio analysis R3.
- OD-010/011/012: accepted, standalone product, synthetic Atlas/Draco, OCI/Compose Linux and standard external PostgreSQL support.

No unresolved product direction blocks EPIC-01. These dispositions do not claim
customer credentials, pilot agreements or deployment approval already exist.
