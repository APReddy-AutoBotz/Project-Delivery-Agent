# EXEC-008: Durable generic scalar conflict reconciliation requests

Status: In progress (Implementation Candidate for Issue #6, EPIC-03, STORY-012, AC-EVD-004, FAIL-009, GOLDEN-003).
Owner: Implementation engineer. Last updated: 2026-09-20.
Requirement IDs: FR-ADM-005, FR-EVD-001, FR-EVD-002, FR-EVD-003, FR-EVD-004, FR-EVD-006, FR-EVD-007, FR-EVD-010, FR-EVD-012, FR-MOD-001, FR-MOD-002, FR-MOD-004, FR-MOD-005, FR-MOD-007.
GitHub issue: #6; target R1, STORY-012, AC-EVD-004 / GOLDEN-003 / FAIL-009.
Applicable decisions: ADR-001, ADR-002, ADR-003, ADR-006, ADR-007, ADR-008, ADR-009, ADR-010, ADR-012, ADR-013, ADR-014.

---

## 1. Exact Scope

This increment completes the remaining technical portion of Issue #6, EPIC-03, STORY-012, and AC-EVD-004:
- When two applicable authoritative sources disagree on a scalar fact, both values are retained and the fact is marked `CONFLICTING`.
- A pure, deterministic domain resolver calculates `reconciliationRequired = true` under an applicable `REQUEST_RECONCILIATION` policy.
- A durable, deduplicated scalar reconciliation request is created from an authorized sealed assessment.
- Assignment routes to an explicitly configured project manager responsibility with matching grant, or persists as durable `UNASSIGNED`.
- Scoped API and executive UI (Sapphire & Frost design system) deliver safe proof summaries without selecting a winner or disclosing restricted evidence.
- A later non-conflicting sealed reassessment can transition the request to `RESOLVED` while preserving immutable historical proof.

### Out of Scope
- Issue #5 and Release 1 distribution/signing gates.
- Issue #7 and subsequent epics.
- Outbound connector writes (Jira, Slack, Teams, Email).
- External human approval tools or AI model writes.
- Modifying existing released migrations (1-6).
- Rewriting milestone reconciliation history or faking milestone entities for scalar facts.

---

## 2. Existing Architecture to Reuse

- **Deterministic Resolver**: `resolveSourceAuthority` in `packages/domain/src/source-authority.ts` remains pure and deterministic.
- **Fact Assessment Ledger**: `FactAssessment`, `FactAssessmentVersion`, `FactAssessmentConflict`, and `FactAuthorityConflict` in `packages/data/src/authority-persistence.ts`.
- **Authorization & Responsibility Routing**: `authorizeReconciliation` in `packages/data/src/reconciliation-authorization.ts` locks projects and grants in `ReadCommitted` isolation and inspects configured `PROJECT_MANAGER` responsibility.
- **Idempotency & Auditing Pattern**: `AuditEvent` linking, hash verification, and transactional receipts.

---

## 3. Proposed Data Model (Architecture A)

Architecture A implements a generic scalar reconciliation aggregate alongside the milestone aggregate. This preserves all existing foreign keys, does not require fake milestone references, and leaves migrations 1-6 immutable.

### Additive Migration 7: `202609130001_scalar_reconciliation_requests`
1. `FactAssessment`:
   - Add column `reconciliationCheckId uuid UNIQUE`.
   - Add constraint `FactReconciliationAssessment_owner_key` UNIQUE (`customerId`, `projectId`, `factId`, `id`, `reconciliationCheckId`).
2. `ScalarReconciliationRequest`:
   - `id`: uuid PRIMARY KEY
   - `customerId`: uuid NOT NULL
   - `projectId`: uuid NOT NULL
   - `factId`: uuid NOT NULL
   - `factType`: varchar(96) NOT NULL
   - `originalAssessmentId`: uuid NOT NULL UNIQUE
   - `originCommandId`: uuid NOT NULL UNIQUE
   - `policyRevisionId`: uuid NOT NULL
   - `contributorHash`: char(64) NOT NULL
   - `contributorIdentity`: text NOT NULL
   - `createdBy`: varchar(256) NOT NULL
   - `createdAt`: timestamptz(3) NOT NULL
   - `state`: varchar(16) NOT NULL DEFAULT 'OPEN' (values: 'OPEN', 'RESOLVED')
   - `resolvedAssessmentId`: uuid
   - `auditEventId`: uuid NOT NULL UNIQUE
   - `sealed`: boolean NOT NULL DEFAULT false
   - Constraints:
     - `ScalarReconciliationRequest_scope_key`: UNIQUE (`customerId`, `projectId`, `id`)
     - `ScalarReconciliationRequest_proof_key`: UNIQUE (`customerId`, `projectId`, `originalAssessmentId`)
     - `ScalarReconciliationRequest_birth_key`: UNIQUE (`customerId`, `projectId`, `id`, `originCommandId`, `originalAssessmentId`)
     - `ScalarReconciliationRequest_business_key`: UNIQUE (`customerId`, `projectId`, `factId`, `policyRevisionId`, `contributorHash`)
     - Foreign keys to `ProjectFact`, `FactAssessment`, `AuthorityPolicyRevision`, `AuditEvent`.
3. `ScalarReconciliationCheck`:
   - `id`: uuid PRIMARY KEY
   - `customerId`: uuid NOT NULL
   - `projectId`: uuid NOT NULL
   - `factId`: uuid NOT NULL
   - `subject`: varchar(256) NOT NULL
   - `idempotencyKey`: varchar(128) NOT NULL
   - `requestHash`: char(64) NOT NULL
   - `assessmentId`: uuid NOT NULL UNIQUE
   - `requestId`: uuid
   - `outcome`: varchar(16) NOT NULL ('NO_REQUEST', 'CREATED', 'REUSED', 'RESOLVED')
   - `occurredAt`: timestamptz(3) NOT NULL
   - `auditEventId`: uuid NOT NULL UNIQUE
   - Constraints:
     - `ScalarReconciliationCheck_retry_key`: UNIQUE (`customerId`, `projectId`, `factId`, `subject`, `idempotencyKey`)
     - `ScalarReconciliationCheck_owner_key`: UNIQUE (`customerId`, `projectId`, `factId`, `assessmentId`, `id`)
     - `ScalarReconciliationCheck_birth_key`: UNIQUE (`customerId`, `projectId`, `factId`, `requestId`, `id`, `assessmentId`)
     - Foreign keys to `FactAssessment`, `ScalarReconciliationRequest`, `AuditEvent`.
4. `ScalarReconciliationAssignment`:
   - `id`: uuid PRIMARY KEY
   - `customerId`: uuid NOT NULL
   - `projectId`: uuid NOT NULL
   - `requestId`: uuid NOT NULL
   - `revision`: integer NOT NULL
   - `expectedRevision`: integer NOT NULL
   - `previousAssignmentId`: uuid
   - `kind`: varchar(16) NOT NULL ('INITIAL', 'REFRESH')
   - `recipientSubject`: varchar(256)
   - `responsibilityId`: uuid
   - `reason`: varchar(32) NOT NULL ('ASSIGNED', 'NO_CONFIGURED_PM', 'AMBIGUOUS_CONFIGURED_PM', 'PM_SCOPE_UNAVAILABLE')
   - `actor`: varchar(256) NOT NULL
   - `occurredAt`: timestamptz(3) NOT NULL
   - `auditEventId`: uuid NOT NULL UNIQUE
   - `idempotencyKey`: varchar(128)
   - `requestHash`: char(64)
   - `grantId`: uuid, `grantCustomerId`: uuid, `grantSubject`: varchar(256), `grantScopeType`: varchar(16), `grantScopeId`: uuid, `grantRole`: varchar(32)
   - Constraints:
     - `ScalarReconciliationAssignment_revision_key`: UNIQUE (`customerId`, `projectId`, `requestId`, `revision`)
     - `ScalarReconciliationAssignment_predecessor_key`: UNIQUE (`customerId`, `projectId`, `requestId`, `revision`, `id`)
     - `ScalarReconciliationAssignment_retry_key`: UNIQUE (`customerId`, `projectId`, `requestId`, `actor`, `idempotencyKey`)
5. Postgres COMMIT triggers:
   - `valid_scalar_reconciliation_assignment`
   - `valid_scalar_reconciliation_request`
   - `valid_scalar_reconciliation_check`

---

## 4. Authorization Model

- **Append & Command Role**: Requires `project_manager`, `portfolio_manager`, or `pmo_admin` on the project scope.
- **Management Queue (`/manage`)**: Requires `project_manager`, `portfolio_manager`, or `pmo_admin`. Enables viewing unassigned requests.
- **Recipient Queue**: Filtered strictly to requests where `recipientSubject === actor.subject`.
- **Proof Withholding**: Current source access is re-checked on every delivery. If a user loses reader access to an underlying source, the request remains visible but the specific value/evidence is redacted with `visibility: 'restricted'`.

---

## 5. Deduplication & Concurrency

- **Deterministic Hash**: `contributorHash = sha256(contributorIdentity)` where `contributorIdentity` serializes sorted contributing version IDs, evidence IDs, conflict IDs, and policy revision.
- **Database Unique Constraint**: `UNIQUE (customerId, projectId, factId, policyRevisionId, contributorHash)`.
- **Concurrent Execution**: Serialized in transaction; duplicate logical conflict attempts return `REUSED` with existing request details without creating duplicate assignments or audit entries.
- **Crash Recovery**: Transactions rollback cleanly if uncommitted; committed requests survive process restart and re-deliver atomically.

---

## 6. Assignment Rules

- Handled via `authorizeReconciliation`:
  - Single configured `PROJECT_MANAGER` responsibility + valid active `project_manager` grant &rarr; `ASSIGNED`.
  - Zero configured PM responsibilities &rarr; `NO_CONFIGURED_PM` (durable `UNASSIGNED`).
  - More than one configured PM &rarr; `AMBIGUOUS_CONFIGURED_PM` (durable `UNASSIGNED`).
  - Configured PM lacks active grant &rarr; `PM_SCOPE_UNAVAILABLE` (durable `UNASSIGNED`).
- Refreshing assignment produces audited append-only revision.

---

## 7. Request Lifecycle

- **OPEN**: Created upon detection of unresolved scalar conflict under `REQUEST_RECONCILIATION`.
- **RESOLVED**: Transitioned when an authorized user submits an assessment proof showing the conflict has resolved under the applicable authority rule.
- History and audit events are strictly append-only.

---

## 8. API Endpoints

- `POST /api/projects/:id/facts/:factType/reconciliation-checks`: Create or check scalar reconciliation request.
- `GET /api/projects/:id/scalar-reconciliation-requests`: List assigned requests for caller.
- `GET /api/projects/:id/scalar-reconciliation-requests/manage`: List all requests including unassigned for managers.
- `GET /api/projects/:id/scalar-reconciliation-requests/:requestId`: Retrieve request detail with safe proof.
- `POST /api/projects/:id/scalar-reconciliation-requests/:requestId/assignment`: Refresh assignment.
- `POST /api/projects/:id/scalar-reconciliation-requests/:requestId/resolve`: Reassess and resolve open request.

---

## 9. Visual Architecture: Deep Sapphire + Frost Enterprise System

Binding tokens applied across evidence and scalar reconciliation components:
- Primary Brand Anchor: Deep Sapphire `#0F3460`
- Surface & Highlight Tint: Frost `#EEF2FF`
- App Canvas: Crisp Off-White `#F8FAFC`
- Card/Panel: Pure White `#FFFFFF`
- Architectural Border: `#E2E8F0`
- Badges/Pills: Frost background `#EEF2FF` with border `#C7D2FE`
- Focus Rings: Indigo Focus `#4F46E5`
- Ambient Elevation: `rgba(15, 52, 96, 0.04)`

---

## 10. Tests & Verification

- Unit tests: Domain schemas, check result, status transitions, discriminator validation.
- Integration tests: Database migrations (prefix upgrade from 6), concurrent requests, unassigned vs assigned, grant revocation, audit retention, recovery rehearsal.
- API contract tests: OpenAPI validation, status codes (400, 401, 404, 409, 503).
- Playwright E2E: Assigned workflow, unassigned workflow, restricted evidence redaction, resolved workflow, screenshots.
