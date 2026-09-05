# Threat Model

## Protected assets

- Customer project data
- Evidence and documents
- Connector credentials
- AI provider credentials
- User sessions
- Approval authority
- External source-system integrity
- Audit and action receipts
- Customer configuration
- Proprietary product code and rules

## Threat actors

- Unauthorized external user
- Authorized user exceeding intended access
- Compromised contributor account
- Malicious source content
- Compromised connector credential
- Misconfigured service account
- Supply-chain attacker
- Accidental administrator error
- AI model producing unsafe output

## Key threats and controls

| Threat | Example | Primary controls |
|---|---|---|
| Cross-project data leakage | Leadership answer includes another project | Server authorization, evidence filters, negative tests |
| Prompt injection | Jira comment instructs agent to send data | Untrusted-data separation, bounded tools, output validation |
| Unauthorized write | Read-only user changes forecast | Approval authority and connector allowlist |
| Replay | Webhook repeated | Signature, event ID, idempotency |
| Duplicate side effect | Retry adds two comments | Idempotency key and reconciliation |
| Secret exposure | Token in logs | Redaction, secret storage, logging policy |
| SSRF | Source content contains internal URL | URL allowlist and no arbitrary fetch tool |
| Stale approval | Source changes after approval | Proposal expiry and preflight revision check |
| Evidence tampering | Current fact changed without history | Versioning, append-only audit, hashes |
| Dependency compromise | Malicious package update | Lockfile, scanning, SBOM, approved dependency list |
| Broken tenant scope | Query omits customer condition | Repository/service guard, integration tests, optional DB defense |
| Privileged system admin | Infrastructure admin reads projects | Separation of operational and business access |
| Model hallucination | Invented delay cause | Claim schema, evidence validation, unknown behavior |
| Excessive data routing | Full document sent to model | Data minimization and routing policy |
| Email link theft | Update link forwarded | Expiry, recipient binding, authentication for sensitive cases |

## STRIDE summary

### Spoofing

- OIDC
- signed sessions
- webhook validation
- verified sender mapping

### Tampering

- source revisions
- content hashes
- append-only receipts
- database constraints

### Repudiation

- actor identity
- approvals
- correlation IDs
- action receipts

### Information disclosure

- scoped authorization
- evidence access
- redaction
- data routing policy

### Denial of service

- rate limiting
- queue isolation
- bounded AI calls
- connector backoff

### Elevation of privilege

- server-side RBAC
- approval matrix
- service policy
- no raw connector tools

## Security review triggers

A new threat-model review is required when:

- Adding a connector
- Adding a new write operation
- Changing authentication
- Exposing MCP
- Adding document ingestion
- Adding vendor telemetry
- Adding multi-tenancy
- Enabling automatic customer communication
