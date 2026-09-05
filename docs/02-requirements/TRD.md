# Technical Requirements Document

## 1. Technical objective

Provide a customer-hostable, maintainable and secure product with one primary language, one operational database and clear module boundaries.

## 2. Selected technology baseline

| Layer | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Web | React, Vite, Tailwind CSS, accessible component primitives |
| API | NestJS, REST, OpenAPI |
| Streaming | Server-Sent Events |
| Database | PostgreSQL |
| Semantic retrieval | pgvector |
| Data access | Prisma behind repositories |
| Background work | Graphile Worker |
| AI integration | Provider abstraction, initially Vercel AI SDK and Zod |
| Jira | First-party connector wrapping `jira.js` |
| Microsoft 365 | Later connector wrapping Microsoft Graph JavaScript SDK |
| PowerPoint | PptxGenJS |
| Spreadsheet output | ExcelJS |
| Browser tests | Playwright |
| Deployment | OCI containers, Docker Compose and Podman-compatible target |
| Observability | Structured logs and OpenTelemetry-compatible instrumentation |

## 3. Technical requirements

### Application stack

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-STACK-001 | The web application, API, worker and first-party connectors must use TypeScript on Node.js 24 LTS unless an approved ADR states otherwise. | Must | R1 |
| TR-STACK-002 | The web application must use React, Vite, Tailwind CSS and an approved accessible component layer. | Must | R1 |
| TR-STACK-003 | The API must use NestJS with REST endpoints and generated OpenAPI documentation. | Must | R1 |
| TR-STACK-004 | The operational database must be PostgreSQL with pgvector available for approved semantic retrieval. | Must | R1 |
| TR-STACK-005 | Database access must use Prisma or an approved alternative behind repository interfaces, with versioned migrations. | Must | R1 |
| TR-STACK-006 | Scheduled and background workflows must use Graphile Worker in Release 1. | Must | R1 |
| TR-STACK-007 | The initial provider abstraction must use the Vercel AI SDK or a thinner approved adapter and validated Zod schemas. | Must | R1 |
| TR-STACK-008 | PowerPoint and spreadsheet generation must use approved server-side libraries that do not require Microsoft Office installation. | Must | R1 |

### APIs and correlation

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-API-001 | REST endpoints must publish and validate an OpenAPI contract. | Must | R1 |
| TR-API-002 | Conversational responses should use Server-Sent Events in Release 1. | Should | R1 |
| TR-API-003 | Inbound requests, worker jobs, AI runs and connector calls must share correlation identifiers. | Must | R1 |

### Data and transactions

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-DATA-001 | Material domain events and external actions must use a transactional outbox or equivalent atomic pattern. | Must | R1 |
| TR-DATA-002 | Audit and action-receipt records must be append-only through normal application APIs. | Must | R1 |
| TR-DATA-003 | Project and portfolio authorization must be enforced in service and query boundaries; optional database policies may provide defense in depth. | Must | R1 |
| TR-DATA-004 | Embeddings must never replace structured authoritative fields. | Must | R1 |

### Authentication

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-AUTH-001 | Production authentication must support OpenID Connect and customer identity providers. | Must | R1 |
| TR-AUTH-002 | A local development or demo login may exist but must be disabled by default in production. | Should | R1 |
| TR-AUTH-003 | Sessions and tokens must use secure cookie or bearer-token practices appropriate to the deployment. | Must | R1 |

### Jira integration

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-JIRA-001 | The Jira connector should use `jira.js` behind a first-party connector interface. | Should | R1 |
| TR-JIRA-002 | Jira OAuth refresh-token rotation must be persisted atomically and encrypted. | Must | R1 |
| TR-JIRA-003 | Jira write-back must use an administrator-configured operation and field allowlist. | Must | R1 |

### Messaging and collaboration

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-MSG-001 | Release 1 must support an email notification adapter and secure web response route. | Must | R1 |
| TR-MSG-002 | The channel abstraction must allow later Microsoft Graph email and Teams adapters. | Should | R1 |

### AI architecture

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-AI-001 | The AI configuration must support provider type, endpoint, model, secret reference, embedding model and policy restrictions. | Must | R1 |
| TR-AI-002 | AI tools must be registered with explicit schemas, permission checks, read/write classification and audit behavior. | Must | R1 |
| TR-AI-003 | Leadership answers must be assembled from claim objects containing text, classification, evidence IDs and freshness. | Must | R1 |
| TR-AI-004 | System prompts and extraction schemas must be versioned in source control and recorded with AI runs. | Must | R1 |

### Deployment and upgrades

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-DEP-001 | The default deployment must include web/API, worker, PostgreSQL or an external database option, reverse proxy and backup job. | Must | R1 |
| TR-DEP-002 | Container images should run on standard OCI runtimes including Podman where practical. | Should | R1 |
| TR-DEP-003 | Deployment configuration must separate secrets from non-secret customer settings. | Must | R1 |
| TR-DEP-004 | Each release must include migrations, release notes, backup guidance and rollback or recovery instructions. | Must | R1 |

### Testing

| ID | Requirement | Priority | Release |
|---|---|---:|---:|
| TR-TEST-001 | TypeScript unit and integration tests must use Vitest or Jest consistently. | Must | R1 |
| TR-TEST-002 | End-to-end browser tests must use Playwright. | Must | R1 |
| TR-TEST-003 | Each connector must pass shared contract tests for identity, sync, idempotency, permission failure and rate limiting. | Must | R1 |
| TR-TEST-004 | AI-dependent functions must support deterministic fixtures or mocks for most CI tests. | Must | R1 |

## 4. Technical constraints

- No mandatory vendor-operated control plane.
- No customer-specific code branches.
- No unrestricted LLM database or connector tools.
- No microservice split without a measured operational or scaling need.
- No production dependency on an unclear or incompatible open-source licence.
- No silent migration or automatic baseline changes.
- No Microsoft Office installation required for server-side report generation.

## 5. Supported deployment profiles

### Demonstration

- Managed PostgreSQL may be used.
- Local or hosted containers.
- Synthetic data.
- Development identity provider or protected demo login.

### Standard customer-hosted

- Customer Linux host or approved container service.
- Customer-managed OIDC.
- Customer-provided PostgreSQL or bundled supported PostgreSQL.
- Customer-owned connector credentials and AI endpoint.
- Signed application images.

### Enterprise

- Customer container platform.
- Managed PostgreSQL.
- Enterprise secret manager.
- Centralized logging and monitoring.
- Optional horizontal workers.
- Optional source access or escrow under contract.
