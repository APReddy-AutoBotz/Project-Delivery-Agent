# Epics and Stories

## Epics

| ID | Epic | Release | Outcome |
|---|---|---:|---|
| EPIC-01 | Repository and platform foundation | R0 | Create monorepo, CI, configuration, local deployment, enforced identity, scoped authorization and encrypted secrets and seeded data. |
| EPIC-02 | Jira and spreadsheet ingestion | R1 | Connect Jira Cloud and portfolio spreadsheets through isolated, testable connectors. |
| EPIC-03 | Canonical model and evidence ledger | R1 | Normalize project data, version facts, retain evidence, freshness and conflicts. |
| EPIC-04 | Delivery health and contradiction engine | R1 | Calculate deterministic signals and identify selected source/status contradictions. |
| EPIC-05 | Update engagement and escalation | R1 | Create obligations, send contextual requests, collect replies, remind and escalate. |
| EPIC-06 | Interpretation, approval and write-back | R1 | Extract structured updates, confirm interpretation, approve changes and write safely. |
| EPIC-07 | Role advice and action queues | R1 | Provide prioritized, explainable actions to PM and other project roles. |
| EPIC-08 | Leadership Q&A and evidence | R1 | Answer current project questions with authorization, citations, freshness and uncertainty. |
| EPIC-09 | Dashboards and management snapshots | R1 | Provide live views, email preview and PowerPoint/PDF outputs from one fact set. |
| EPIC-10 | Security, deployment and release readiness | R1 | Harden access, audit, backup, recovery, shadow mode and customer deployment. |
| EPIC-11 | Microsoft enterprise collaboration | R2 | Add Microsoft Graph email, Teams and SharePoint/OneDrive integration. |
| EPIC-12 | Portfolio intelligence | R3 | Add cross-project dependencies, RAID hygiene and advanced contradiction detection. |
| EPIC-13 | Connector expansion | R4 | Add ClickUp, Trello, monday.com, Asana, Slack and other sources. |
| EPIC-14 | Enterprise productization | R5 | Add signed licensing, source-access tier, escrow support, MCP and upgrade tooling. |

## Release 0 and Release 1 stories

| ID | Epic | Story | Priority | Requirement IDs |
|---|---|---|---:|---|
| STORY-001 | EPIC-01 | **Initialize TypeScript monorepo.** Create pnpm workspace with web, API, worker and shared packages. | P0 | TR-STACK-001, TR-STACK-002, TR-STACK-003, NFR-MNT-001, NFR-MNT-002, TR-API-001 |
| STORY-002 | EPIC-01 | **Create PostgreSQL schema foundation.** Create customer, identity, project, connector and audit foundations with migrations. | P0 | TR-STACK-004, TR-STACK-005, NFR-MNT-005 |
| STORY-003 | EPIC-01 | **Create containerized local environment.** Provide reference Docker Compose, health checks and synthetic seed. | P0 | TR-DEP-001, NFR-AVL-001, NFR-PORT-001, NFR-PORT-004, NFR-SEC-003, NFR-PORT-002 |
| STORY-004 | EPIC-01 | **Establish CI and documentation validation.** Run lint, typecheck, tests, build and requirements validation. | P0 | NFR-MNT-004, TR-TEST-001, TR-TEST-002, NFR-SEC-010 |
| STORY-005 | EPIC-01 | **Implement foundation security controls.** Enforce production OIDC validation, scoped grants/revocation and encrypted secrets before real data; constrain local identity to synthetic development. | P0 | FR-ADM-001, FR-ADM-002, FR-ADM-003, TR-AUTH-001, TR-AUTH-002, TR-AUTH-003, NFR-SEC-001, TR-DATA-003, NFR-SEC-004, NFR-SEC-005, TR-DEP-003, FR-APP-010, FR-ADM-009 |
| STORY-006 | EPIC-02 | **Implement connector contract.** Define source read, health, cursor, write proposal and execution interfaces. | P0 | FR-CON-011, TR-TEST-003 |
| STORY-007 | EPIC-02 | **Implement Jira read connector.** Use jira.js to connect, discover and synchronize configured Jira data. | P0 | FR-CON-001, FR-CON-002, FR-CON-003, FR-CON-009, FR-CON-012, NFR-SEC-002, FR-MOD-007, FR-EVD-011, TR-JIRA-002, NFR-SEC-004 |
| STORY-008 | EPIC-02 | **Implement Jira webhook and reconciliation.** Ingest events idempotently and run scheduled recovery sync. | P0 | FR-CON-004, FR-CON-005, FR-CON-010, NFR-REL-001, NFR-SEC-006 |
| STORY-009 | EPIC-02 | **Implement spreadsheet mapping and import.** Support Excel/CSV dry-run, validation and canonical mapping. | P0 | FR-CON-006, FR-CON-007 |
| STORY-010 | EPIC-03 | **Implement canonical project model.** Represent projects, milestones, work items, roles, RAID and dates. | P0 | FR-MOD-001, FR-MOD-002, FR-MOD-004, FR-MOD-005, FR-MOD-007 |
| STORY-011 | EPIC-03 | **Implement fact and evidence versioning.** Persist fact versions, source evidence, classifications and human confirmation. | P0 | FR-EVD-001, FR-EVD-002, FR-EVD-003, FR-EVD-004, FR-ADM-005, FR-EVD-006, FR-EVD-007 |
| STORY-012 | EPIC-03 | **Implement source authority and conflict resolution.** Apply configured authority and retain unresolved conflicts. | P0 | FR-EVD-006, FR-EVD-007, FR-EVD-012, FR-ADM-005, FR-EVD-004, FR-EVD-010 |
| STORY-013 | EPIC-04 | **Implement freshness and completeness rules.** Detect overdue updates and missing required facts. | P0 | FR-HLT-001, FR-HLT-002, FR-UPD-001 |
| STORY-014 | EPIC-04 | **Implement blocker and overdue signals.** Calculate blocker age, overdue work and explain inputs. | P0 | FR-HLT-003, FR-HLT-004, FR-HLT-009, FR-HLT-011, FR-HLT-008, PR-005, BR-003, NFR-REL-003 |
| STORY-015 | EPIC-04 | **Implement first contradiction rules.** Detect GREEN-versus-critical-signal and completed-milestone-versus-open-work contradictions. | P0 | FR-HLT-007, FR-HLT-008, FR-MOD-006, FR-HLT-009 |
| STORY-016 | EPIC-05 | **Implement update-obligation state machine.** Create durable due, request, reminder, escalation, response and closure state. | P0 | FR-UPD-001, FR-ESC-001, NFR-REL-002, FR-HLT-001, FR-UPD-002, FR-ESC-003, FR-ESC-005, TR-DATA-001, TR-STACK-006 |
| STORY-017 | EPIC-05 | **Implement contextual request generator.** Build focused messages from current facts and missing information. | P0 | FR-UPD-002, FR-UPD-003, FR-UPD-001 |
| STORY-018 | EPIC-05 | **Implement secure response page.** Allow authenticated or tokenized response, structured choices and free text. | P0 | FR-UPD-004, FR-UPD-005, FR-UPD-006, NFR-SEC-001, FR-UPD-007, NFR-AI-001, FR-UPD-008, TR-MSG-001 |
| STORY-019 | EPIC-05 | **Implement reminder and escalation jobs.** Use Graphile Worker, quiet hours, duplicate suppression and PM escalation. | P0 | FR-UPD-010, FR-UPD-012, FR-ESC-003, FR-ESC-006, NFR-REL-002, FR-ESC-001, FR-ESC-005, FR-ESC-002, PR-007, FR-ADM-004 |
| STORY-020 | EPIC-06 | **Implement AI response extraction.** Use provider abstraction and Zod schema to create proposed facts. | P0 | FR-UPD-007, NFR-AI-001, TR-AI-001, FR-ADM-007, FR-UPD-006, NFR-SEC-007, NFR-SEC-008, TR-AI-002, FR-WRB-003, FR-APP-004, FR-APP-005, FR-ADM-008, NFR-PRV-001, NFR-PRV-002, NFR-PRV-003, NFR-PRV-005, NFR-PORT-003, TR-STACK-007, TR-TEST-004 |
| STORY-021 | EPIC-06 | **Implement clarification and interpretation confirmation.** Ask focused clarification and allow user correction. | P0 | FR-UPD-008, FR-UPD-009, FR-EVD-005 |
| STORY-022 | EPIC-06 | **Implement approval diff and authority.** Show consequences and enforce project-specific approver. | P0 | FR-APP-001, FR-APP-002, FR-APP-005, NFR-SEC-001, FR-APP-003, FR-APP-004, FR-APP-006 |
| STORY-023 | EPIC-06 | **Implement Jira comment write-back.** Preflight, execute approved comment, retry safely and create receipt. | P0 | FR-WRB-001, FR-WRB-004, FR-WRB-007, FR-AUD-002, NFR-REL-001, FR-WRB-003, FR-WRB-005, FR-WRB-009, FR-WRB-010, FR-APP-009, TR-JIRA-003, BR-007, PR-009, FR-WRB-008, NFR-REL-005, FR-APP-007, FR-APP-008 |
| STORY-024 | EPIC-06 | **Implement source-change conflict.** Block execution when Jira changes after approval. | P0 | FR-APP-007, FR-APP-008 |
| STORY-025 | EPIC-07 | **Implement recommendation framework.** Create deterministic triggers and explainable role-specific recommendation objects. | P0 | FR-ADV-001, FR-ADV-007, NFR-REL-003, FR-ADV-008, BR-013 |
| STORY-026 | EPIC-07 | **Implement PM action queue.** Rank approvals, updates, blockers and interventions for assigned projects. | P0 | FR-ADV-002, FR-RPT-002, FR-ADV-006, NFR-SEC-001 |
| STORY-027 | EPIC-08 | **Implement authorized Q&A scope.** Resolve project/time scope and enforce access before retrieval. | P0 | FR-QA-001, FR-QA-002, FR-QA-012, FR-EVD-009, NFR-SEC-001, FR-QA-009, FR-QA-003, TR-DATA-004 |
| STORY-028 | EPIC-08 | **Implement claim and citation composer.** Construct evidence-backed claims and validate model output. | P0 | FR-QA-003, FR-QA-004, TR-AI-003, NFR-AI-002, PR-010, BR-004 |
| STORY-029 | EPIC-08 | **Implement delay explanation.** Answer baseline, forecast, cause, actions and uncertainty. | P0 | FR-QA-005, FR-QA-006, FR-QA-007, FR-QA-008, FR-QA-009, FR-QA-001, FR-QA-010 |
| STORY-030 | EPIC-09 | **Implement live project and portfolio views.** Show facts, signals, freshness, conflicts and action queues. | P0 | FR-RPT-001, FR-RPT-002, FR-RPT-003, FR-ADV-002, FR-RPT-004, FR-RPT-005, FR-RPT-010, NFR-SEC-001, NFR-PERF-003, NFR-PERF-001 |
| STORY-031 | EPIC-09 | **Implement report-run fact set.** Freeze a reporting revision used by all output channels. | P0 | FR-RPT-010, FR-RPT-001, FR-RPT-004, FR-RPT-005, FR-RPT-009 |
| STORY-032 | EPIC-09 | **Implement PowerPoint snapshot.** Generate editable management slides with metadata and approval state. | P0 | FR-RPT-005, FR-RPT-007, FR-RPT-001, FR-RPT-004, FR-RPT-010, TR-STACK-008, NFR-ACC-001 |
| STORY-033 | EPIC-09 | **Implement email digest preview.** Draft material changes and decision needs with an authenticated link. | P1 | FR-RPT-004, FR-RPT-001, FR-RPT-005, FR-RPT-010 |
| STORY-034 | EPIC-10 | **Implement audit and action-receipt search.** Create append-only events and authorized search. | P0 | FR-AUD-001, FR-AUD-002, FR-AUD-005, FR-WRB-007, NFR-PRV-004, FR-AUD-007, FR-ADM-008, FR-AUD-003, FR-AUD-004, NFR-SEC-009, NFR-OBS-001, NFR-AI-005, TR-DATA-002, TR-API-003, TR-AI-004 |
| STORY-035 | EPIC-10 | **Implement shadow mode.** Verify and extend the foundation outbound guard with global, connector and action-class shadow administration and full workflow tests. | P0 | FR-APP-010, FR-ADM-009, FR-CON-012, BR-011, PR-014 |
| STORY-036 | EPIC-10 | **Implement backup, restore and upgrade runbook.** Package migrations, backup, restore and recovery validation. | P0 | TR-DEP-004, NFR-AVL-002, NFR-REL-001, FR-WRB-004, BR-006, PR-012, NFR-PORT-003, BR-014, NFR-REL-003 |
| STORY-037 | EPIC-10 | **Run security and failure gates.** Complete authorization, prompt injection, duplicate event and unknown-outcome tests. | P0 | NFR-SEC-008, NFR-REL-001, NFR-REL-004, FR-WRB-004, FR-CON-004, FR-CON-010, FR-CON-009, NFR-SEC-005, NFR-SEC-007, TR-AI-002, FR-WRB-003, FR-APP-004, FR-APP-005 |
| STORY-038 | EPIC-10 | **Prepare synthetic event demo.** Seed portfolio, scripted delay, update interaction, approval and leadership Q&A. | P0 | FR-UPD-001, FR-UPD-002, FR-QA-009, FR-RPT-005, FR-HLT-001, FR-QA-001, FR-RPT-001, FR-RPT-004, FR-RPT-010, FR-RPT-007, TR-STACK-008, BR-001, BR-002, BR-003, BR-012, PR-015, BR-013, BR-004, BR-005, PR-001, PR-002, PR-003, PR-004, PR-005, PR-006, NFR-MNT-003, PR-013, BR-008, BR-010 |

## Story rules

- A GitHub implementation issue must map to one or more stories or explain why a new story is needed.
- Each story must identify acceptance criteria before implementation.
- Stories may be split without changing the product requirement.
- Scope must not be added to R1 only because a connector or AI framework makes it easy.
