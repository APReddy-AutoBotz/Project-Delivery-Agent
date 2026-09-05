# Functional Requirements Document

## 1. Purpose

This document defines the required system behaviour. The structured source is `requirements/requirements.yaml`.

## 2. Functional principles

- Preserve source-system authority at field level.
- Keep recorded facts separate from human confirmation and AI inference.
- Use deterministic rules for timing, calculations, permissions and health signals.
- Use AI for interpretation, extraction, explanation and drafting.
- Require approval for material external changes.
- Record every material action and evidence source.
- Enforce project access on every interaction.
- Support shadow mode before automation is enabled.

## 3. Requirement priority

- **Must:** Required for the stated release.
- **Should:** Strongly expected but may be deferred by an approved scope decision.
- **Could:** Optional enhancement.

## Connectors and ingestion

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-CON-001 | An administrator must be able to connect a Jira Cloud site using an approved authentication method and least-privilege scopes. | Must | R1 |
| FR-CON-002 | The connector must list only Jira projects visible to the configured identity. | Must | R1 |
| FR-CON-003 | The connector must read configured projects, boards, sprints, issues, comments, changelog, links and selected custom fields. | Must | R1 |
| FR-CON-004 | The connector must accept supported Jira webhook events with signature or authenticity controls where available. | Should | R1 |
| FR-CON-005 | The connector must run scheduled reconciliation to recover missed events and refresh current state. | Must | R1 |
| FR-CON-006 | An authorized user must be able to import Excel or CSV portfolio data through a configured mapping. | Must | R1 |
| FR-CON-007 | The system must preview source-to-canonical field mappings and validation errors before import. | Must | R1 |
| FR-CON-008 | The system must avoid reprocessing unchanged source records where feasible. | Should | R1 |
| FR-CON-009 | The system must display connection state, last success, last failure and actionable error detail. | Must | R1 |
| FR-CON-010 | Repeated delivery of the same source event must not create duplicate facts, reminders or writes. | Must | R1 |
| FR-CON-011 | External systems must implement a common connector contract without leaking SDK-specific types into domain modules. | Must | R1 |
| FR-CON-012 | Each connector must support a configuration that prevents external writes. | Must | R1 |

## Canonical project model

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-MOD-001 | The canonical model must represent portfolios, programmes and projects. | Must | R1 |
| FR-MOD-002 | The canonical model must represent sprints, milestones, work items and relationships. | Must | R1 |
| FR-MOD-003 | The canonical model must represent risks, assumptions, issues, dependencies, decisions and actions. | Should | R1 |
| FR-MOD-004 | The model must represent sponsor, PM, scrum master, team lead and responsible owner relationships. | Must | R1 |
| FR-MOD-005 | The model must distinguish baseline, planned, forecast and actual dates. | Must | R1 |
| FR-MOD-006 | The model must store reported health separately from calculated delivery signals. | Must | R1 |
| FR-MOD-007 | The model must retain mappings between canonical entities and source-system records. | Must | R1 |
| FR-MOD-008 | Administrators must be able to map customer terminology to canonical concepts without changing code. | Should | R1 |

## Facts and evidence

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-EVD-001 | Every material project fact must retain its value, type, effective date, observed date and source. | Must | R1 |
| FR-EVD-002 | A fact must retain a resolvable source record identifier or approved stored evidence reference. | Must | R1 |
| FR-EVD-003 | A material fact must use an approved classification: SYSTEM_VERIFIED, HUMAN_CONFIRMED, AGENT_INFERENCE, CONFLICTING, STALE or UNKNOWN. | Must | R1 |
| FR-EVD-004 | Changing a fact must create a new version while retaining the previous value and provenance. | Must | R1 |
| FR-EVD-005 | The system must record who confirmed a fact and when. | Must | R1 |
| FR-EVD-006 | The system must calculate fact freshness using configurable validity periods by fact type. | Must | R1 |
| FR-EVD-007 | When authoritative sources disagree, the system must retain both values and mark the fact as conflicting. | Must | R1 |
| FR-EVD-008 | The system must retain an explainable confidence level without presenting it as proof. | Should | R1 |
| FR-EVD-009 | A user must be able to inspect evidence supporting a claim when authorized for the source project. | Must | R1 |
| FR-EVD-010 | Expired or superseded evidence must not be used as current fact without a visible warning. | Must | R1 |
| FR-EVD-011 | The system must retain source synchronization time and source revision where available. | Should | R1 |
| FR-EVD-012 | The system must not silently choose a value when applicable authority rules do not resolve a conflict. | Must | R1 |

## Delivery health and contradictions

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-HLT-001 | The system must identify projects whose required update is outside the configured freshness window. | Must | R1 |
| FR-HLT-002 | The system must identify required project fields that are missing or unconfirmed. | Must | R1 |
| FR-HLT-003 | The system must identify configured overdue work items and milestones. | Must | R1 |
| FR-HLT-004 | The system must calculate the age of open blockers and compare it with configured thresholds. | Must | R1 |
| FR-HLT-005 | The system must identify repeated forecast-date changes while retaining the change history. | Should | R1 |
| FR-HLT-006 | The system must identify a discoverable dependency whose due date or status threatens the dependent item. | Should | R1 |
| FR-HLT-007 | The system must show reported RAG separately from calculated signals. | Must | R1 |
| FR-HLT-008 | The system must detect configured contradictions between reported status and objective facts. | Must | R1 |
| FR-HLT-009 | Each health signal must expose the inputs and rule that produced it. | Must | R1 |
| FR-HLT-010 | Authorized administrators must be able to tune thresholds without changing code. | Should | R1 |
| FR-HLT-011 | The language model must not be the sole calculator of project health or schedule variance. | Must | R1 |
| FR-HLT-012 | The system must retain material signal changes over reporting periods. | Should | R1 |

## Update collection and interaction

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-UPD-001 | The system must create an update request when a configured reporting obligation becomes due and no valid current update exists. | Must | R1 |
| FR-UPD-002 | The request must identify the project context and the specific missing or stale information. | Must | R1 |
| FR-UPD-003 | The system must address the request to the configured responsible person and avoid broad unnecessary distribution. | Must | R1 |
| FR-UPD-004 | A recipient must be able to submit an update through a secure, time-limited or authenticated page. | Must | R1 |
| FR-UPD-005 | The request may provide configurable structured response choices in addition to free text. | Should | R1 |
| FR-UPD-006 | The recipient must be able to provide a natural-language update. | Must | R1 |
| FR-UPD-007 | The system may use AI to extract proposed structured facts from the response. | Must | R1 |
| FR-UPD-008 | The recipient or authorized reviewer must be able to confirm or correct the extracted interpretation. | Must | R1 |
| FR-UPD-009 | The system must request clarification when a response cannot safely support the required fact or action. | Must | R1 |
| FR-UPD-010 | A valid response must cancel or suppress pending reminders for the satisfied obligation. | Must | R1 |
| FR-UPD-011 | The recipient must be able to indicate absence, delegation or an allowed skip reason. | Should | R1 |
| FR-UPD-012 | Requests and reminders must use configured user or project time zones and quiet hours. | Must | R1 |

## Reminder and escalation

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-ESC-001 | The system must send reminders according to a configured schedule when no valid response is received. | Must | R1 |
| FR-ESC-002 | Administrators must be able to configure escalation stages, delays, recipients and channels. | Must | R1 |
| FR-ESC-003 | The system must be able to notify the project manager after configured unanswered reminders. | Must | R1 |
| FR-ESC-004 | The system must be able to notify a team lead or alternate role after a continued non-response. | Should | R1 |
| FR-ESC-005 | An escalation must include request history, project impact and the exact missing information. | Must | R1 |
| FR-ESC-006 | The system must prevent duplicate reminders or escalations for the same active obligation. | Must | R1 |
| FR-ESC-007 | An authorized user must be able to pause or close an update obligation with a recorded reason. | Should | R1 |
| FR-ESC-008 | The policy must support business days, holidays and quiet hours. | Should | R2 |

## Role-based advice

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-ADV-001 | Recommendations must be triggered by approved delivery rules and current facts. | Must | R1 |
| FR-ADV-002 | The product must provide project managers with prioritized suggested follow-up or recovery actions. | Should | R1 |
| FR-ADV-003 | The product must provide scrum masters with relevant blocker, carryover and sprint-hygiene suggestions. | Should | R1 |
| FR-ADV-004 | The product must provide team leads with relevant ownership, dependency and technical-decision suggestions. | Should | R1 |
| FR-ADV-005 | The product must provide PMO users with reporting, governance and portfolio-intervention suggestions. | Should | R1 |
| FR-ADV-006 | Leadership recommendations must focus on decisions and interventions, not operational task management. | Should | R1 |
| FR-ADV-007 | Each recommendation must state the triggering facts, rule and expected outcome. | Must | R1 |
| FR-ADV-008 | The system must not attribute personal blame unless an authorized source explicitly records responsibility and the context is appropriate. | Must | R1 |

## Approval

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-APP-001 | Every proposed action must have a configured risk and approval class. | Must | R1 |
| FR-APP-002 | A material proposal must show current value, proposed value, reason, source, evidence and intended side effects. | Must | R1 |
| FR-APP-003 | An authorized reviewer must be able to edit a proposal before approval. | Must | R1 |
| FR-APP-004 | An authorized reviewer must be able to approve or reject a proposal with an optional reason. | Must | R1 |
| FR-APP-005 | The system must enforce the configured approval role for the action type and project. | Must | R1 |
| FR-APP-006 | A proposal must expire or require reconfirmation after its configured validity period. | Should | R1 |
| FR-APP-007 | Immediately before execution, the system must verify that the source value still matches the approved comparison base. | Must | R1 |
| FR-APP-008 | If the source changed after approval, the system must stop execution and create a new proposal or reconciliation task. | Must | R1 |
| FR-APP-009 | Bulk approval must be disabled for material actions in Release 1. | Must | R1 |
| FR-APP-010 | In shadow mode, proposals must be recorded but never sent or executed externally. | Must | R1 |

## Controlled write-back

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-WRB-001 | The system must support an approved Jira comment write-back for Release 1. | Must | R1 |
| FR-WRB-002 | The system may support approved changes to a configured allowlist of non-baseline Jira fields. | Should | R1 |
| FR-WRB-003 | The agent must not receive a generic unrestricted Jira update capability. | Must | R1 |
| FR-WRB-004 | Each external write must use an idempotency control or equivalent duplicate protection. | Must | R1 |
| FR-WRB-005 | The system must check application and connector permission before execution. | Must | R1 |
| FR-WRB-006 | The external update must identify its source and acting integration account where supported. | Should | R1 |
| FR-WRB-007 | The system must record success, failure, external record revision and returned identifier. | Must | R1 |
| FR-WRB-008 | Only failures classified as safe to retry may be retried automatically. | Must | R1 |
| FR-WRB-009 | The product must not automatically change project baselines, budget or contractual commitments. | Must | R1 |
| FR-WRB-010 | The product must not autonomously mark a work item complete in Release 1. | Must | R1 |

## Leadership and project Q&A

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-QA-001 | A user must be able to ask a natural-language question across projects they are authorized to access. | Must | R1 |
| FR-QA-002 | The system must resolve the requested project, portfolio, time period and question type without broadening access. | Must | R1 |
| FR-QA-003 | The system must retrieve structured current facts before unstructured evidence. | Must | R1 |
| FR-QA-004 | Each material factual claim in an answer must be linked to supporting evidence. | Must | R1 |
| FR-QA-005 | The answer must distinguish verified facts, human confirmations and agent inferences. | Must | R1 |
| FR-QA-006 | The answer must state relevant data freshness and unresolved update requests. | Must | R1 |
| FR-QA-007 | The answer must disclose material source conflicts and avoid presenting either value as settled without authority. | Must | R1 |
| FR-QA-008 | When evidence is insufficient, the system must say what is unknown and may initiate an approved clarification request. | Must | R1 |
| FR-QA-009 | The system must answer why a project is delayed using baseline, forecast, causal evidence, actions and uncertainty. | Must | R1 |
| FR-QA-010 | The system must answer what changed since a selected prior time or snapshot. | Should | R1 |
| FR-QA-011 | The system must identify decisions awaiting the user or their role. | Should | R1 |
| FR-QA-012 | Answer generation must enforce row- and evidence-level authorization. | Must | R1 |

## Dashboards and reporting

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-RPT-001 | The system must provide a live project view based on the current approved fact set. | Must | R1 |
| FR-RPT-002 | The system must provide role-specific prioritized action queues. | Must | R1 |
| FR-RPT-003 | The PMO view must show update freshness, missing updates and conflicts. | Must | R1 |
| FR-RPT-004 | The system must generate an email digest preview from the approved fact set. | Should | R1 |
| FR-RPT-005 | The system must generate a timestamped PowerPoint management snapshot. | Must | R1 |
| FR-RPT-006 | The system should generate a PDF snapshot from an approved template. | Should | R1 |
| FR-RPT-007 | A final report must show reporting period, generated time, source freshness and approval state. | Must | R1 |
| FR-RPT-008 | The reporting engine must support different approved templates for leadership, PMO and customer audiences. | Should | R2 |
| FR-RPT-009 | The system must retain metadata and references for generated final snapshots. | Should | R1 |
| FR-RPT-010 | All output channels must use the same versioned approved fact set for the reporting run. | Must | R1 |

## Administration and configuration

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-ADM-001 | An administrator must be able to configure an approved OpenID Connect identity provider. | Must | R1 |
| FR-ADM-002 | The system must map identity-provider users or groups to application roles. | Must | R1 |
| FR-ADM-003 | Administrators must be able to grant portfolio- and project-level access. | Must | R1 |
| FR-ADM-004 | Administrators must be able to configure update obligations, due times, reminders and escalations. | Must | R1 |
| FR-ADM-005 | Administrators must be able to configure source authority by fact type or field. | Must | R1 |
| FR-ADM-006 | Administrators must be able to enable and tune approved health rules. | Should | R1 |
| FR-ADM-007 | Administrators must be able to configure an approved AI provider, endpoint, model and secret reference. | Must | R1 |
| FR-ADM-008 | Administrators must be able to configure retention, redaction and AI data-routing restrictions. | Must | R1 |
| FR-ADM-009 | Administrators must be able to enable shadow mode globally or by connector/action class. | Must | R1 |
| FR-ADM-010 | The system must display configured connector permissions and expected scopes. | Should | R1 |
| FR-ADM-011 | Administrators should be able to configure approved logo, terminology and report branding. | Could | R2 |
| FR-ADM-012 | The system should support secure export of non-secret customer configuration for backup or migration. | Should | R2 |

## Audit and action receipts

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| FR-AUD-001 | The system must record material authentication, configuration, agent, approval and connector actions. | Must | R1 |
| FR-AUD-002 | Every attempted external write must create an action receipt with proposal, approval, execution and outcome. | Must | R1 |
| FR-AUD-003 | Audit records must distinguish human user, service account, scheduled worker and AI-assisted action. | Must | R1 |
| FR-AUD-004 | The system must record AI purpose, provider, model, prompt version, source IDs and outcome without logging unnecessary secrets. | Must | R1 |
| FR-AUD-005 | Material audit records must not be editable through normal application functions. | Must | R1 |
| FR-AUD-006 | Authorized administrators must be able to search audit records by project, actor, action and time. | Should | R1 |
| FR-AUD-007 | Audit retention must follow configured policy and legal requirements. | Must | R1 |
| FR-AUD-008 | Authorized administrators should be able to export selected audit records. | Should | R2 |

## 4. Functional requirement governance

- Release 1 `Must` requirements need acceptance criteria before implementation.
- A requirement may be deferred only through approved change control.
- The implementation must not satisfy a requirement only in the user interface if server-side enforcement is required.
- AI behaviour must be testable through fixtures and golden scenarios.
- Customer-specific behaviour must be represented by configuration or documented extension points.
