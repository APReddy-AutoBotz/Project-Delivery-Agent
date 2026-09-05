# Non-Functional Requirements

## 1. Purpose

This document defines quality, security, privacy, reliability, maintainability, portability, performance, accessibility and AI-governance requirements.

## 2. Requirements

### Security

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-SEC-001 | Every data access and action must be authorized on the server for the user, role, project and portfolio. | Must | R1 |
| NFR-SEC-002 | Connectors, service accounts and application roles must use minimum required permissions. | Must | R1 |
| NFR-SEC-003 | All external and user-facing network traffic must use approved TLS. | Must | R1 |
| NFR-SEC-004 | Secrets and sensitive stored data must be encrypted using customer-approved controls. | Must | R1 |
| NFR-SEC-005 | Secrets must not be committed to source control, exposed in logs or returned to the browser. | Must | R1 |
| NFR-SEC-006 | Inbound webhooks must use authenticity validation, replay protection and idempotency controls where supported. | Must | R1 |
| NFR-SEC-007 | The language model must not receive unrestricted database or connector access. | Must | R1 |
| NFR-SEC-008 | Content from external systems must be treated as untrusted data and must not override system policies or tool permissions. | Must | R1 |
| NFR-SEC-009 | Material actions must be attributable and reviewable. | Must | R1 |
| NFR-SEC-010 | Runtime dependencies and container images must be scanned before release. | Must | R1 |

### Privacy and data control

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-PRV-001 | Only information required for the selected use case may be processed or sent to an AI provider. | Must | R1 |
| NFR-PRV-002 | Customer data must remain within customer-controlled storage except approved external API calls. | Must | R1 |
| NFR-PRV-003 | The customer must control which AI provider or private endpoint receives which data classifications. | Must | R1 |
| NFR-PRV-004 | Operational, evidence, AI and audit data must support configurable retention. | Must | R1 |
| NFR-PRV-005 | The product must not claim that customer data is excluded from provider training unless the configured provider agreement supports it. | Must | R1 |

### Reliability and recovery

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-REL-001 | Duplicate events, retries and worker restarts must not create duplicate material actions. | Must | R1 |
| NFR-REL-002 | Update obligations, reminders, approvals and writes must recover after process restart. | Must | R1 |
| NFR-REL-003 | Deterministic monitoring must continue when the AI provider is unavailable. | Must | R1 |
| NFR-REL-004 | The system must expose failed synchronization, generation and write operations rather than silently discarding them. | Must | R1 |
| NFR-REL-005 | Retries must be bounded, classified and observable. | Must | R1 |

### Performance

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-PERF-001 | Normal dashboard pages should load core data within three seconds under the Release 1 reference load. | Should | R1 |
| NFR-PERF-002 | Leadership Q&A must acknowledge a request promptly and stream or return progress for longer answers. | Should | R1 |
| NFR-PERF-003 | Report generation and synchronization must not block interactive application requests. | Must | R1 |

### Scalability

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-SCL-001 | Release 1 must support at least 200 projects, 20,000 work items and 200 active users in one customer deployment. | Should | R1 |
| NFR-SCL-002 | Background workers should be horizontally scalable without changing business workflow state. | Should | R2 |

### Availability and maintenance

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-AVL-001 | The default deployment must support health checks and restart-safe services. | Must | R1 |
| NFR-AVL-002 | Upgrade procedures must document expected downtime and rollback. | Must | R1 |

### Maintainability

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-MNT-001 | The core web, API, worker and connector implementation should use TypeScript. | Must | R1 |
| NFR-MNT-002 | Domain modules must have clear public interfaces and must not create circular dependencies. | Must | R1 |
| NFR-MNT-003 | Customer variation must be implemented through configuration or extension points. | Must | R1 |
| NFR-MNT-004 | Linting, type checking, tests, builds and documentation validation must run in CI. | Must | R1 |
| NFR-MNT-005 | Database changes must be versioned, repeatable and tested. | Must | R1 |

### Portability

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-PORT-001 | The application must be distributable as OCI-compatible container images. | Must | R1 |
| NFR-PORT-002 | The product must support standard PostgreSQL without mandatory Supabase-specific runtime features. | Must | R1 |
| NFR-PORT-003 | The AI layer must support replacement of the configured provider without changing domain logic. | Must | R1 |
| NFR-PORT-004 | The core product must not require a mandatory vendor-operated control plane. | Must | R1 |

### Accessibility

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-ACC-001 | Core user journeys must target WCAG 2.2 AA practices. | Should | R1 |
| NFR-ACC-002 | Core dashboards, chat, forms and approvals must be operable by keyboard. | Should | R1 |

### Observability

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-OBS-001 | Services must emit structured logs with correlation IDs and without secrets. | Must | R1 |
| NFR-OBS-002 | Services must expose health, queue, connector, latency and failure metrics. | Should | R1 |
| NFR-OBS-003 | The architecture must support OpenTelemetry-compatible tracing. | Should | R2 |

### AI quality and governance

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| NFR-AI-001 | AI extraction used for action proposals must conform to a validated schema. | Must | R1 |
| NFR-AI-002 | Material answer claims must have evidence or be clearly labelled as inference or unknown. | Must | R1 |
| NFR-AI-003 | Golden scenarios must be rerunnable across supported model providers. | Should | R1 |
| NFR-AI-004 | Administrators must be able to set provider, model and usage limits. | Should | R1 |
| NFR-AI-005 | The product must retain decision inputs, tool calls and result summaries without depending on private model chain-of-thought. | Must | R1 |

## 3. Reference load

The Release 1 reference load is a single customer deployment containing:

- Up to 200 active projects
- Up to 20,000 work items
- Up to 200 active users
- Up to 20 concurrent interactive users
- Scheduled synchronization and reporting across the portfolio

This is an engineering target, not a contractual service level.

## 4. Service-level agreements

Customer-specific availability, support response and recovery targets belong in the commercial agreement. The product baseline must provide the technical controls needed to meet an agreed SLA but does not itself create a contractual SLA.
