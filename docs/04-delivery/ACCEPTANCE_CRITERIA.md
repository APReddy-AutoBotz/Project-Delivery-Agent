# Acceptance Criteria

The machine-readable traceability register is under `requirements/traceability.yaml`.

## Foundation

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-FND-001 | The repository contains a pnpm TypeScript workspace with buildable web, API and worker applications and shared package boundaries. | P0 | TR-STACK-001, TR-STACK-002, TR-STACK-003 | CI-FND-001 |

## Data foundation

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-DATA-001 | A clean PostgreSQL database can apply the initial versioned migration and create customer, identity, project, connector and audit foundations. | P0 | TR-STACK-004, TR-STACK-005, NFR-MNT-005 | INT-DATA-001 |

## Canonical model

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-MOD-001 | The API can create and retrieve a canonical project with hierarchy, roles, baseline/forecast dates, reported health and external source mappings. | P0 | FR-MOD-001, FR-MOD-002, FR-MOD-004, FR-MOD-005, FR-MOD-007 | INT-MOD-001 |

## Connectors

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-CON-001 | Given valid Jira credentials and approved scopes, the administrator can connect a site and receive a successful connection test without enabling writes. | P0 | FR-CON-001, FR-CON-009, FR-CON-012 | INT-CON-001, E2E-CON-001 |
| AC-CON-002 | A Jira project not visible to the integration identity is not listed, synchronized or queryable. | P0 | FR-CON-002, NFR-SEC-002 | INT-CON-002 |
| AC-CON-003 | Configured issue, sprint, comment, changelog, link and selected custom-field data is normalized with source IDs and revisions. | P0 | FR-CON-003, FR-MOD-007, FR-EVD-011 | INT-CON-003 |
| AC-CON-004 | Submitting the same webhook event twice produces one source observation and no duplicate downstream obligation. | P0 | FR-CON-004, FR-CON-010, NFR-REL-001 | INT-CON-004 |
| AC-CON-005 | An Excel or CSV import previews mappings, invalid rows and planned changes before any facts are committed. | P0 | FR-CON-006, FR-CON-007 | E2E-CON-005 |
| AC-CON-006 | Expired credentials change connector health to failed or degraded and show a safe administrator-facing reason without exposing the secret. | P0 | FR-CON-009, NFR-REL-004, NFR-SEC-005 | INT-CON-006, SEC-CON-001 |

## Evidence

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-EVD-001 | A changed source value creates a new fact version and preserves the previous value, source and timestamps. | P0 | FR-EVD-001, FR-EVD-002, FR-EVD-004 | INT-EVD-001 |
| AC-EVD-002 | Every material fact returned by the API includes a valid fact classification. | P0 | FR-EVD-003 | UNIT-EVD-002 |
| AC-EVD-003 | A fact outside its configured validity period is marked STALE and cannot be presented as current without warning. | P0 | FR-EVD-006, FR-EVD-010 | UNIT-EVD-003, E2E-EVD-003 |
| AC-EVD-004 | When two applicable authoritative sources disagree, both values are retained and the fact is CONFLICTING. | P0 | FR-EVD-007, FR-EVD-012, FR-ADM-005 | INT-EVD-004, GOLDEN-003 |
| AC-EVD-005 | A user without access to the source project cannot open or retrieve its evidence, even through a copied evidence URL. | P0 | FR-EVD-009, FR-QA-012, NFR-SEC-001 | SEC-EVD-005 |
| AC-EVD-006 | A confirmed response records the confirming user, timestamp, original response and linked evidence. | P0 | FR-EVD-005, FR-UPD-008 | INT-EVD-006 |

## Health and contradiction

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-HLT-001 | A project whose required update is older than policy is shown as stale and creates the configured obligation. | P0 | FR-HLT-001, FR-UPD-001 | UNIT-HLT-001, E2E-UPD-001 |
| AC-HLT-002 | The completeness check lists the exact required facts that are missing or unconfirmed. | P0 | FR-HLT-002 | UNIT-HLT-002 |
| AC-HLT-003 | Blocker age is calculated from source dates and the applied threshold is visible. | P0 | FR-HLT-004, FR-HLT-009, FR-HLT-011 | UNIT-HLT-003 |
| AC-HLT-004 | A reported GREEN value remains visible while a RED calculated signal is shown separately with rationale. | P0 | FR-HLT-007, FR-HLT-008 | E2E-HLT-004, GOLDEN-002 |
| AC-HLT-005 | A completed milestone with mandatory open linked issues creates a contradiction signal and a PM reconciliation action. | P0 | FR-HLT-008, FR-HLT-009 | INT-HLT-005, GOLDEN-003 |
| AC-HLT-006 | The health result is reproducible with the AI provider disabled. | P0 | FR-HLT-011, NFR-REL-003 | UNIT-HLT-006 |

## Update and escalation

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-UPD-001 | When an update becomes due, the request names the project, current known position and specific missing information. | P0 | FR-UPD-001, FR-UPD-002 | E2E-UPD-001 |
| AC-UPD-002 | The initial request is sent only to the configured responsible owner unless policy names additional recipients. | P0 | FR-UPD-003 | INT-UPD-002 |
| AC-UPD-003 | An expired, invalid or unauthorized response link cannot submit or reveal project information. | P0 | FR-UPD-004, NFR-SEC-001 | SEC-UPD-003 |
| AC-UPD-004 | A valid free-text reply produces schema-valid proposed facts and does not directly write to Jira. | P0 | FR-UPD-006, FR-UPD-007, NFR-AI-001 | AI-UPD-004, E2E-UPD-004 |
| AC-UPD-005 | An ambiguous response creates a focused clarification request and no material fact or write proposal is approved automatically. | P0 | FR-UPD-009 | AI-UPD-005, GOLDEN-005 |
| AC-UPD-006 | A response satisfying the obligation cancels pending reminder and escalation jobs. | P0 | FR-UPD-010, FR-ESC-006 | INT-UPD-006 |
| AC-UPD-007 | A reminder becoming due during quiet hours is deferred to the next allowed time and the reason is recorded. | P0 | FR-UPD-012 | UNIT-UPD-007 |
| AC-UPD-008 | After the configured unanswered stages, the PM receives the original request, reminder history, missing facts and project impact. | P0 | FR-ESC-001, FR-ESC-003, FR-ESC-005 | E2E-ESC-008 |

## Advice

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-ADV-001 | A recommendation contains the triggering facts, rule, urgency, suggested action and expected outcome. | P0 | FR-ADV-001, FR-ADV-007 | UNIT-ADV-001, AI-ADV-001 |
| AC-ADV-002 | The PM action queue ranks pending approvals, stale updates and critical interventions for assigned projects. | P0 | FR-ADV-002, FR-RPT-002 | E2E-ADV-002 |
| AC-ADV-003 | The same underlying concern is expressed as an operational action for the PM and as a decision/intervention need for leadership. | P0 | FR-ADV-002, FR-ADV-006 | AI-ADV-003 |
| AC-ADV-004 | The recommendation does not label a person as underperforming or personally at fault based only on response time or activity. | P0 | FR-ADV-008, BR-013 | AI-SAFE-004 |
| AC-ADV-005 | Disabling the AI provider does not remove the underlying recommendation trigger from the action queue. | P0 | FR-ADV-001, NFR-REL-003 | UNIT-ADV-005 |

## Approval and write-back

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-APP-001 | A material Jira proposal displays target, current value, proposed value, source response, evidence, side effects and required approver. | P0 | FR-APP-001, FR-APP-002 | E2E-APP-001 |
| AC-APP-002 | A user with read access but without approval authority cannot approve the proposal. | P0 | FR-APP-005, NFR-SEC-001 | SEC-APP-002 |
| AC-APP-003 | An authorized reviewer can edit the proposed text or allowlisted value and the approved revision is retained. | P0 | FR-APP-003, FR-APP-004 | E2E-APP-003 |
| AC-APP-004 | An expired proposal cannot execute without a new review or approval. | P0 | FR-APP-006 | UNIT-APP-004 |
| AC-APP-005 | If Jira changes between approval and execution, execution stops and a new diff is required. | P0 | FR-APP-007, FR-APP-008 | INT-APP-005 |
| AC-APP-006 | In shadow mode, an approved-looking proposal never calls the external write endpoint. | P0 | FR-APP-010, FR-CON-012 | INT-APP-006 |
| AC-APP-007 | Retrying an already successful write does not create a duplicate comment or field change. | P0 | FR-WRB-004, NFR-REL-001 | INT-WRB-007 |
| AC-APP-008 | Every write attempt records proposal, approver, execution identity, result, correlation ID and external revision or error class. | P0 | FR-WRB-007, FR-AUD-002 | INT-AUD-008 |

## Leadership Q&A

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-QA-001 | An authorized leader can ask why a project is delayed and receive baseline, forecast, verified cause, action and uncertainty. | P0 | FR-QA-001, FR-QA-009 | E2E-QA-001, GOLDEN-001 |
| AC-QA-002 | Every material date, number, cause and current-state claim has at least one authorized evidence reference. | P0 | FR-QA-004, NFR-AI-002 | AI-QA-002 |
| AC-QA-003 | An inferred conclusion is explicitly labelled and is not presented as SYSTEM_VERIFIED or HUMAN_CONFIRMED. | P0 | FR-QA-005 | AI-QA-003 |
| AC-QA-004 | The answer states when the latest project update is stale and identifies the active clarification request. | P0 | FR-QA-006 | GOLDEN-004 |
| AC-QA-005 | The answer describes both conflicting values and does not silently choose one. | P0 | FR-QA-007 | GOLDEN-003 |
| AC-QA-006 | When delay is verified but cause is not, the answer states that the cause is unknown and can create a clarification request. | P0 | FR-QA-008 | GOLDEN-005 |
| AC-QA-007 | A user authorized for Project A receives no fact, title, person or evidence from Project B in answers or citations. | P0 | FR-QA-012 | SEC-QA-007 |
| AC-QA-008 | A 'what changed' answer compares the current fact set with the selected prior snapshot or time point. | P0 | FR-QA-010 | INT-QA-008 |

## Reporting

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-RPT-001 | A dashboard snapshot, email preview and PowerPoint generated for one report run share the same fact-set revision. | P0 | FR-RPT-001, FR-RPT-004, FR-RPT-005, FR-RPT-010 | INT-RPT-001 |
| AC-RPT-002 | Generated PowerPoint contains reporting period, generation time, approval state, freshness and snapshot ID. | P0 | FR-RPT-005, FR-RPT-007 | INT-RPT-002 |
| AC-RPT-003 | A user sees only action-queue items from authorized projects. | P0 | FR-RPT-002, NFR-SEC-001 | SEC-RPT-003 |
| AC-RPT-004 | A finalized snapshot does not change when live source data changes later. | P0 | FR-RPT-009, FR-RPT-010 | INT-RPT-004 |
| AC-RPT-005 | Health uses labels and explanation rather than color alone. | P0 | NFR-ACC-001 | E2E-ACC-005 |

## Administration

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-ADM-001 | An administrator can configure OIDC metadata and map an identity group to an application role without code changes. | P0 | FR-ADM-001, FR-ADM-002 | INT-ADM-001 |
| AC-ADM-002 | An administrator can configure due time, reminders, escalation recipient and quiet hours and preview the resulting schedule. | P0 | FR-ADM-004, FR-ESC-002 | E2E-ADM-002 |
| AC-ADM-003 | Changing an authority rule affects subsequent fact resolution while preserving prior fact history. | P0 | FR-ADM-005, FR-EVD-004 | INT-ADM-003 |
| AC-ADM-004 | An administrator can select an approved provider or OpenAI-compatible private endpoint and test it without exposing the secret. | P0 | FR-ADM-007, TR-AI-001 | INT-ADM-004, SEC-ADM-004 |

## Deployment

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-DEP-001 | The documented container composition starts web/API, worker and PostgreSQL and passes readiness checks. | P0 | TR-DEP-001, NFR-AVL-001 | DEP-001 |
| AC-DEP-002 | The same application can connect to a supported external PostgreSQL instance without product-code changes. | P0 | NFR-PORT-002 | DEP-002 |
| AC-DEP-003 | A documented backup can be restored into a clean deployment with fact, workflow and audit consistency checks passing. | P0 | TR-DEP-004, NFR-AVL-002 | DEP-003 |
| AC-DEP-004 | The reference deployment supports a no-AI mode in which synchronization, freshness, health and manual reporting remain available. | P0 | BR-014, NFR-REL-003 | E2E-DEP-004 |

## Maintainability

| ID | Criterion | Priority | Requirements | Planned tests |
|---|---|---:|---|---|
| AC-MNT-001 | A second synthetic customer configuration with different fields and cadence runs on the same build. | P0 | NFR-MNT-003, PR-013 | E2E-MNT-001 |
| AC-MNT-002 | A pull request fails CI when lint, type checking, tests, build or documentation validation fails. | P0 | NFR-MNT-004 | CI-MNT-002 |
| AC-MNT-003 | The Jira connector passes the shared connector contract test suite. | P0 | TR-TEST-003 | INT-MNT-003 |
| AC-MNT-004 | A new runtime dependency not added to the open-source adoption register fails documentation validation or review policy. | P1 | OPEN_SOURCE_POLICY | CI-MNT-004 |
