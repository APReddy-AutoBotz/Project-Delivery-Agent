# Solution Architecture

## 1. Architecture objective

Provide an enterprise-ready but low-maintenance application that can be deployed inside a customer environment, connect to existing project systems, coordinate delivery updates and answer questions using governed evidence.

## 2. Architecture principles

- Modular monolith before microservices
- One primary language
- PostgreSQL as operational centre
- Deterministic business rules
- Bounded AI tools
- Field-level source authority
- Append-only material audit
- Customer-controlled identity, infrastructure and AI routing
- Configuration instead of customer forks
- Safe read-only and shadow modes
- External systems accessed through isolated connectors
- Formal events and idempotency around side effects

## 3. System context

```mermaid
flowchart LR
    L[Leadership] --> PDAA[Project Delivery Assurance Agent]
    PMO[PMO / Portfolio] --> PDAA
    PM[Project Manager] --> PDAA
    SM[Scrum Master / Team Lead] --> PDAA
    C[Contributor] --> PDAA
    A[Administrator] --> PDAA

    PDAA <--> J[Jira Cloud]
    PDAA <--> S[Excel / CSV Portfolio Sources]
    PDAA <--> M[Email / Microsoft 365]
    PDAA <--> D[Approved Documents and Collaboration Sources]
    PDAA --> AI[Customer-selected AI Provider]
    PDAA --> IDP[Customer Identity Provider]
    PDAA --> R[PowerPoint / PDF / Email Outputs]
```

## 4. Container architecture

```mermaid
flowchart TB
    Browser[Web Browser] --> Proxy[Reverse Proxy / TLS]
    Proxy --> Web[React + Vite Web Assets]
    Proxy --> API[NestJS API]

    API --> DB[(PostgreSQL + pgvector)]
    API --> Obj[Optional Object Storage]
    API --> Outbox[(Transactional Outbox)]
    Worker[Graphile Worker Process] --> DB
    Worker --> Outbox

    API --> AIAdapter[AI Provider Adapter]
    Worker --> AIAdapter
    AIAdapter --> Model[Customer-selected Model Endpoint]

    API --> JiraConnector[Jira Connector]
    Worker --> JiraConnector
    JiraConnector <--> Jira[Jira Cloud]

    API --> SheetConnector[Spreadsheet Connector]
    Worker --> SheetConnector

    API --> MessageConnector[Messaging Adapter]
    Worker --> MessageConnector
    MessageConnector --> Email[Email / Microsoft Graph]

    Worker --> Report[Report Generator]
    Report --> Files[PPTX / PDF / XLSX]
```

The API and worker use the same domain packages and may be built from the same source repository and image family, with separate process commands.

## 5. Logical layers

### Experience

- Role workspaces
- Portfolio and project dashboards
- Update pages
- Approval pages
- Leadership Q&A
- Administration
- Report preview

### Application

- Use-case orchestration
- Authorization
- Transaction boundaries
- Commands and queries
- Notifications
- Background-job coordination

### Domain

- Canonical Project Model
- Evidence and source authority
- Update obligations
- Health signals
- Recommendations
- Approval policies
- Action receipts

### Infrastructure

- PostgreSQL
- Graphile Worker
- Connector SDK wrappers
- AI-provider adapter
- Email and report generation
- Logging and telemetry
- Container deployment

## 6. Deployment boundary

A standard customer deployment owns:

- Application containers
- PostgreSQL database
- Customer configuration
- Identity-provider registration
- Jira and Microsoft connector credentials
- AI provider key or private endpoint
- Backup location
- Logs and monitoring

The product vendor supplies:

- Signed images
- Migrations
- Configuration schema
- Deployment scripts
- Release notes
- Support and upgrade packages
- Optional source access according to contract

## 7. Synchronous and asynchronous work

### Synchronous

- Authentication
- Dashboard queries
- Update submission
- Approval
- Leadership question initiation
- Configuration validation

### Asynchronous

- Source synchronization
- Webhook processing
- Reminder and escalation
- AI extraction where slow
- Leadership answer completion
- Report generation
- External write execution
- Reconciliation
- Retention and maintenance

## 8. Architecture guardrails

- Do not expose the raw database or connector client to AI.
- Do not put source authority in prompts.
- Do not use embeddings for authoritative dates, status, owners, costs or permissions.
- Do not call an LLM for deterministic calculations.
- Do not make external side effects in the same unguarded step as interpretation.
- Do not make the web interface responsible for enforcing permissions.
- Do not create independent customer variants.
