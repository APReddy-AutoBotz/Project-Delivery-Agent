# Traceability Matrix

The machine-readable source is `requirements/traceability.yaml`. This document provides the human-readable Release 1 view.

| Business need | Product or functional requirement | Acceptance criteria | Planned verification |
|---|---|---|---|
| BR-001 Reduce manual update chasing | FR-UPD-001, FR-UPD-002, FR-ESC-001 | AC-UPD-001 to AC-UPD-006 | Unit, integration and E2E cadence tests |
| BR-002 Improve information freshness | FR-EVD-006, FR-HLT-001, FR-HLT-002 | AC-EVD-001 to AC-EVD-004 | Freshness and completeness tests |
| BR-003 Detect risks earlier | FR-HLT-004, FR-HLT-006, FR-HLT-008 | AC-HLT-001 to AC-HLT-006 | Golden risk scenarios |
| BR-004 Answer leadership with evidence | FR-QA-001 to FR-QA-008 | AC-QA-001 to AC-QA-008 | Grounding and access-control evals |
| BR-005 Preserve current tools | FR-CON-001, FR-CON-004, FR-WRB-001 | AC-CON-001 to AC-CON-005 | Jira and spreadsheet integration tests |
| BR-006 Customer-controlled deployment and AI | NFR-PORT-001, NFR-PRV-003, TR-AI-001 | AC-DEP-001 to AC-DEP-004 | Container and provider-switch tests |
| BR-007 Govern source-system changes | FR-APP-001 to FR-APP-008, FR-WRB-002 | AC-APP-001 to AC-APP-008 | Approval, concurrency and receipt tests |
| BR-008 Configurable PMO policies | FR-ADM-004, FR-ESC-002, FR-ADV-001 | AC-ADM-001 to AC-ADM-004 | Configuration and policy tests |
| BR-009 Support different project roles | FR-ADV-002 to FR-ADV-006, FR-RPT-002 | AC-ADV-001 to AC-ADV-005 | Role-based usability and authorization tests |
| BR-010 Maintain a commercially supportable product | NFR-MNT-001 to NFR-MNT-005 | AC-MNT-001 to AC-MNT-004 | Architecture, deployment and upgrade review |

## Traceability rules

- Requirement IDs are never reused.
- Superseded requirements remain in history.
- Release 1 functional requirements require acceptance criteria.
- Pull requests must list implemented IDs.
- Test names should include the requirement or acceptance-criterion ID where practical.
- Any requirement without a parent business need must be justified in the requirements register.
