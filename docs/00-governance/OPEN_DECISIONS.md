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
