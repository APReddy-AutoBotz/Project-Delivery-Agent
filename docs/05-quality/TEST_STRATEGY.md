# Test Strategy

## Quality objective

Prove that the product is correct, permission-aware, evidence-grounded, restart-safe and safe around external actions.

## Test layers

### Unit tests

Test deterministic domain behavior:

- Date and business-day calculations
- Freshness
- Source authority
- Conflict state
- Health rules
- Obligation state transitions
- Approval policy
- Action risk class
- Idempotency
- Claim validation

### Integration tests

Test:

- PostgreSQL repositories and migrations
- Graphile Worker jobs
- Jira connector against mock and controlled sandbox
- Spreadsheet import
- Outbox processing
- AI adapter with fixtures
- Report generation
- OIDC and role mapping
- Audit receipts

### Contract tests

Every connector must pass common tests:

- Connection health
- Project visibility
- Cursor behavior
- Stable record identity
- Duplicate event handling
- Rate-limit response
- Expired credential
- Permission failure
- Read-only mode
- Preflight and write result
- Unknown outcome reconciliation

### End-to-end tests

Use Playwright for:

- Login and authorized navigation
- Spreadsheet mapping
- Project dashboard
- Contextual update request
- Secure response
- Confirmation
- Approval diff
- Source-change conflict
- PM action queue
- Leadership Q&A
- Report preview
- Shadow mode
- Cross-project access denial

### AI evaluations

Use golden scenarios for:

- Structured extraction
- Ambiguity detection
- Fact/inference separation
- Citation coverage
- Conflict disclosure
- Unsupported-answer behavior
- Prompt injection
- Role-specific recommendation
- No blame attribution

### Security tests

- Authorization matrix
- Insecure direct object reference
- CSRF and session controls
- Secret leakage
- Webhook replay
- SSRF and unsafe URL handling
- File validation
- Prompt injection
- External-write allowlist
- Evidence deep-link access
- Cross-customer isolation if multi-customer test data exists

### Deployment tests

- Clean installation
- External PostgreSQL
- Migration
- Backup
- Restore
- Upgrade
- Recovery after failed migration
- Worker restart
- AI-disabled mode
- Connector-disabled mode

## Test data

Use synthetic data designed around named scenarios:

- Healthy project
- Stale update
- Persistent blocker
- Cross-team dependency
- Reported Green with objective concern
- Conflicting milestone state
- Unknown delay cause
- Ambiguous owner response
- Source changed after approval
- Unauthorized project

Do not use real customer data in public demos or general CI.

## Environments

| Environment | Purpose |
|---|---|
| Local | Development and unit/integration tests |
| CI | Repeatable automated validation with mocks and containers |
| Demo | Synthetic event demonstration |
| Sandbox | Controlled Jira and email integration testing |
| Customer test | Customer configuration, UAT and security validation |
| Customer production | Approved release only |

## Release gates

A Release 1 candidate must have:

- 100% P0 acceptance criteria passing
- No critical or high unresolved security defect
- No cross-project data leakage
- No material external write without required approval
- No duplicate write in idempotency tests
- Successful backup and restore
- Successful AI-disabled core flow
- Grounding evaluation at or above the approved threshold
- Documented known limitations
- Rollback or recovery plan

## Test evidence

Pull requests must link:

- Requirement IDs
- Test names
- CI run
- Screenshots or report samples for UI/output
- Manual verification where automation is not feasible
- Security or failure scenarios added
