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
| OD-013 | Jira Cloud app distribution, OAuth callback and client-secret delivery for customer-hosted installs | No live OAuth onboarding until a policy-compliant distributable app and callback/secret model is approved | Before public Jira OAuth onboarding |
| OD-014 | Jira comment body/author receipt, retention, visibility and deletion policy | Do not call comment endpoints or retain body/author data until an explicit privacy/retention policy is approved | Before comment ingestion |

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


## Jira Cloud onboarding and comment-data gates, 2026-09-26

- OD-013 remains open. Atlassian's current [3LO app guidance](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) states that apps collecting API tokens or instructing customers to create individual 3LO apps do not comply with its cloud app requirements. It recommends one distributable app, and requires the runtime `redirect_uri` to match the callback configured in the app. The product is customer-hosted and its approved architecture has no vendor-operated control plane, so callback reachability, shared app registration, client-secret delivery and installation lifecycle have product and policy consequences. Keep the public callback, onboarding UI and live activation disabled until those consequences have an approved design. Do not direct customers to create their own OAuth app or collect API tokens.
- OD-014 remains open. Jira comment endpoints return comment bodies along with metadata, so a metadata-only normalizer does not by itself prevent the product from receiving body data. Until purpose, visibility, retention, redaction, deletion and access rules are explicitly approved, do not request Jira comments or persist comment body/author fields. Synthetic redaction fixtures may be used; they are not live connector evidence.

These gates do not prevent progress on issue, selected custom-field, allowlisted changelog, issue-link and explicitly mapped board/sprint adapter work. No Issue #7 criterion or accepted-story count changes from this disposition.
