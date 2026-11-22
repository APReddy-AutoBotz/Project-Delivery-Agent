# Traceability Matrix

The machine-readable source is `requirements/traceability.yaml`. This document provides the human-readable Release 1 view.

| Business need | Product or functional requirement | Acceptance criteria | Planned verification |
|---|---|---|---|
| BR-001 Reduce manual update chasing | FR-UPD-001, FR-UPD-002, FR-ESC-001 | AC-UPD-001 to AC-UPD-006 | Unit, integration and E2E cadence tests |
| BR-002 Improve information freshness | FR-EVD-006, FR-HLT-001, FR-HLT-002 | AC-EVD-001 to AC-EVD-004, AC-HLT-001/002 | Freshness and completeness tests, INT-HLT-002, E2E-UPD-001 |
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


## STORY-008 and STORY-013 acceptance evidence, 2026-10-22

| Story | Requirement/criterion chain | Implementation and complete acceptance record |
| --- | --- | --- |
| STORY-008 / Issue #7 | FR-CON-004/005/010, NFR-REL-001, NFR-SEC-006 -> AC-CON-004/007 -> INT-CON-004 and webhook/reconciliation suites | PR #112; [complete evidence and gates](../05-quality/JIRA_WEBHOOK_RECONCILIATION_ACCEPTANCE.md) |
| STORY-013 / Issue #8 | FR-HLT-001/002, FR-UPD-001 -> AC-HLT-001/002 -> freshness/completeness rules, native policy/evidence suites and E2E-UPD-001 | PR #97/#111/#112; [complete evidence and gates](../05-quality/FRESHNESS_COMPLETENESS_ACCEPTANCE.md) |

Acceptance takes effect after this record's separately reviewed merge and required
checks. Other story/criterion ownership and shared GOLDEN-003 remain unchanged.

## STORY-009 acceptance evidence, 2026-11-18

| Story | Requirement/criterion chain | Implementation and complete acceptance record |
| --- | --- | --- |
| STORY-009 / Issue #7 | FR-CON-006/007 -> AC-CON-005 -> E2E-CON-005 and FAIL-006 | PR #168; [reviewed CSV import acceptance](../05-quality/CSV_REVIEWED_IMPORT_ACCEPTANCE.md) |

## STORY-012 source-authority acceptance evidence, 2026-11-22

| Story or criterion | Required evidence | Implementation |
| --- | --- | --- |
| STORY-012 / Issue #6 | AC-ADM-003, AC-EVD-003, AC-EVD-004. INT-ADM-003, UNIT-EVD-003, E2E-EVD-003, INT-EVD-004, GOLDEN-003 and FAIL-009. | PR #47, #54 and #184. [Source-authority acceptance](../05-quality/EXEC_047_SOURCE_AUTHORITY_ACCEPTANCE.md) |
| AC-HLT-005 / Issue #8 | INT-HLT-005 and GOLDEN-003. | PR #184 and the prior milestone integration. [Source-authority acceptance](../05-quality/EXEC_047_SOURCE_AUTHORITY_ACCEPTANCE.md) |
| AC-QA-005 / Issue #12 | GOLDEN-003. | PR #184. [Source-authority acceptance](../05-quality/EXEC_047_SOURCE_AUTHORITY_ACCEPTANCE.md) |

Acceptance takes effect when this increment passes independent review and
required checks and merges.

## STORY-014 delivery signal acceptance evidence, 2026-11-22

| Story | Approved criteria and tests | Implementation evidence |
| --- | --- | --- |
| STORY-014 / Issue #8 | AC-HLT-003, AC-HLT-005, AC-HLT-006 and AC-HLT-007. UNIT-HLT-003, E2E-HLT-003, INT-HLT-005, GOLDEN-003, UNIT-HLT-006, UNIT-HLT-007, INT-HLT-007 and E2E-HLT-007. | PR #88, #89, #100, #184 and #186. [Delivery signal acceptance](../05-quality/DELIVERY_SIGNAL_ACCEPTANCE.md) |

Acceptance takes effect when this increment passes independent review and
required checks and merges.
