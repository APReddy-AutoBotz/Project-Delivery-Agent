# Documentation Index

**Baseline:** v0.1 Approved candidate (effective after Issue #1 review PR merge)
**Baseline date:** 2026-09-05  
**Product:** Project Delivery Assurance Agent  
**Approval authority:** Product Owner

## Document states

- **Draft:** Under active preparation and review.
- **Reviewed:** Specialist review completed; findings resolved or recorded.
- **Approved:** Binding implementation baseline.
- **Superseded:** Retained for history but no longer authoritative.

## Reading paths

### Product and business review

1. `docs/01-business-product/VISION_AND_STRATEGY.md`
2. `docs/01-business-product/BRD.md`
3. `docs/01-business-product/PRD.md`
4. `docs/01-business-product/PRODUCT_SCOPE.md`
5. `docs/01-business-product/PERSONAS_AND_JOURNEYS.md`
6. `docs/01-business-product/USE_CASE_CATALOG.md`
7. `docs/01-business-product/SUCCESS_METRICS.md`

### Functional and technical review

1. `docs/02-requirements/FRD.md`
2. `docs/02-requirements/NFR.md`
3. `docs/02-requirements/TRD.md`
4. `docs/02-requirements/RBAC_AND_PERMISSIONS.md`
5. `docs/02-requirements/AGENT_BEHAVIOR.md`
6. `docs/02-requirements/SOURCE_AUTHORITY_MODEL.md`
7. `docs/02-requirements/UPDATE_CADENCE_AND_ESCALATION.md`
8. `docs/02-requirements/APPROVAL_AND_WRITEBACK.md`
9. `docs/02-requirements/REPORTING_REQUIREMENTS.md`

### Architecture review

1. `docs/03-architecture/SOLUTION_ARCHITECTURE.md`
2. `docs/03-architecture/DOMAIN_ARCHITECTURE.md`
3. `docs/03-architecture/DATA_MODEL.md`
4. `docs/03-architecture/INTEGRATION_ARCHITECTURE.md`
5. `docs/03-architecture/AI_AND_GROUNDING_ARCHITECTURE.md`
6. `docs/03-architecture/WORKFLOW_ARCHITECTURE.md`
7. `docs/03-architecture/SECURITY_AND_PRIVACY.md`
8. `docs/03-architecture/DEPLOYMENT_AND_OPERATIONS.md`
9. Architecture Decision Records under `docs/03-architecture/adr/`

### Release 1 implementation review

1. `docs/04-delivery/PRODUCT_ROADMAP.md`
2. `docs/04-delivery/RELEASE-1-VERTICAL-SLICE.md`
3. `docs/04-delivery/EPICS_AND_STORIES.md`
4. `docs/04-delivery/ACCEPTANCE_CRITERIA.md`
5. `docs/04-delivery/DEPENDENCY_MAP.md`
6. `docs/04-delivery/EVENT_DEMO_SCENARIO.md`
7. `docs/05-quality/TEST_STRATEGY.md`
8. `docs/05-quality/GOLDEN_TEST_SCENARIOS.md`
9. `docs/05-quality/DEFINITION_OF_DONE.md`

## Baseline document register

| Area | Document | Version | Status |
|---|---|---:|---|
| Governance | DOCUMENT_CONTROL.md | 0.1 | Draft |
| Governance | GLOSSARY.md | 0.1 | Draft |
| Governance | ASSUMPTIONS.md | 0.1 | Draft |
| Governance | TRACEABILITY_MATRIX.md | 0.1 | Draft |
| Governance | CHANGE_CONTROL.md | 0.1 | Draft |
| Governance | OPEN_DECISIONS.md | 0.1 | Draft |
| Governance | BASELINE_REVIEW_CHECKLIST.md | 0.1 | Draft |
| Product | VISION_AND_STRATEGY.md | 0.1 | Draft |
| Product | BRD.md | 0.1 | Draft |
| Product | PRD.md | 0.1 | Draft |
| Product | PRODUCT_SCOPE.md | 0.1 | Draft |
| Product | PERSONAS_AND_JOURNEYS.md | 0.1 | Draft |
| Product | USE_CASE_CATALOG.md | 0.1 | Draft |
| Product | SUCCESS_METRICS.md | 0.1 | Draft |
| Requirements | FRD.md | 0.1 | Draft |
| Requirements | NFR.md | 0.1 | Draft |
| Requirements | TRD.md | 0.1 | Draft |
| Requirements | RBAC_AND_PERMISSIONS.md | 0.1 | Draft |
| Requirements | AGENT_BEHAVIOR.md | 0.1 | Draft |
| Requirements | SOURCE_AUTHORITY_MODEL.md | 0.1 | Draft |
| Requirements | UPDATE_CADENCE_AND_ESCALATION.md | 0.1 | Draft |
| Requirements | APPROVAL_AND_WRITEBACK.md | 0.1 | Draft |
| Requirements | REPORTING_REQUIREMENTS.md | 0.1 | Draft |
| Architecture | SOLUTION_ARCHITECTURE.md | 0.1 | Draft |
| Architecture | DOMAIN_ARCHITECTURE.md | 0.1 | Draft |
| Architecture | DATA_MODEL.md | 0.1 | Draft |
| Architecture | INTEGRATION_ARCHITECTURE.md | 0.1 | Draft |
| Architecture | AI_AND_GROUNDING_ARCHITECTURE.md | 0.1 | Draft |
| Architecture | WORKFLOW_ARCHITECTURE.md | 0.1 | Draft |
| Architecture | SECURITY_AND_PRIVACY.md | 0.1 | Draft |
| Architecture | DEPLOYMENT_AND_OPERATIONS.md | 0.1 | Draft |
| Delivery | PRODUCT_ROADMAP.md | 0.1 | Draft |
| Delivery | RELEASE-1-VERTICAL-SLICE.md | 0.1 | Draft |
| Delivery | EPICS_AND_STORIES.md | 0.1 | Draft |
| Delivery | ACCEPTANCE_CRITERIA.md | 0.1 | Draft |
| Delivery | DEPENDENCY_MAP.md | 0.1 | Draft |
| Delivery | EVENT_DEMO_SCENARIO.md | 0.1 | Draft |
| Quality | TEST_STRATEGY.md | 0.1 | Draft |
| Quality | AGENT_EVALUATION_STRATEGY.md | 0.1 | Draft |
| Quality | GOLDEN_TEST_SCENARIOS.md | 0.1 | Draft |
| Quality | THREAT_MODEL.md | 0.1 | Draft |
| Quality | FAILURE_AND_RECOVERY_TESTS.md | 0.1 | Draft |
| Quality | DEFINITION_OF_DONE.md | 0.1 | Draft |
| Commercial | COMMERCIAL_MODEL.md | 0.1 | Draft |
| Commercial | CUSTOMER_HOSTING_MODEL.md | 0.1 | Draft |
| Commercial | SOURCE_ACCESS_LICENSING.md | 0.1 | Draft |
| Commercial | SUPPORT_AND_UPGRADES.md | 0.1 | Draft |
| Commercial | PILOT_MODEL.md | 0.1 | Draft |
| Commercial | PILOT_SUCCESS_METRICS.md | 0.1 | Draft |
| Research | MARKET_AND_COMPETITOR_REVIEW.md | 0.1 | Draft |
| Research | GITHUB_REPOSITORY_REVIEW.md | 0.1 | Draft |
| Research | OPEN_SOURCE_ADOPTION_REGISTER.md | 0.1 | Draft |
| Research | REJECTED_ALTERNATIVES.md | 0.1 | Draft |
| Research | ASTRA_REVIEW_PROMPT.md | 0.1 | Draft |

## Machine-readable controls

- `requirements/requirements.yaml` is the canonical structured requirement register.
- `requirements/traceability.yaml` maps requirements to acceptance criteria and planned tests.
- `requirements/glossary.yaml` contains terms intended for validation and tooling.
- `scripts/validate_documentation.py` validates IDs, references and indexed files.

## Implementation-control additions

- `docs/04-delivery/IMPLEMENTATION_MASTER_PLAN.md`: approved and merged implementation sequence.
- `docs/04-delivery/IMPLEMENTATION_STATUS.md`: merged partial progress versus accepted stories.
- `docs/04-delivery/exec-plans/EXEC-002-platform-foundation.md`: foundation scope and evidence.
- `docs/04-delivery/exec-plans/EXEC-003-customer-hosted-foundation.md`: production boundary implementation and remaining release gates.
- `docs/03-architecture/adr/ADR-011-FOUNDATION-DEPLOYMENT-BOUNDARIES.md`: approved native component and production transport boundaries.
- `docs/03-architecture/adr/ADR-012-EXECUTABLE-FOUNDATION-CONTRACTS.md`: runtime REST contracts, import boundaries and foundation acceptance gates.
- `docs/03-architecture/adr/ADR-013-FOUNDATION-OPERATIONS.md`: provisioning, migration, encrypted backup, quarantined restore and restart boundaries.
- `docs/07-research/FOUNDATION_IMAGE_REGISTER.md`: pinned acceptance images and unresolved distribution review.
- `docs/05-quality/FOUNDATION_VALIDATION.md`: executed checks, boundaries and review fixes.
- `docs/05-quality/PRODUCTION_BOUNDARY_VALIDATION.md`: production TLS/OIDC increment and scoped validation evidence.
- `docs/05-quality/FOUNDATION_CONTRACT_VALIDATION.md`: executable module/API/database contracts and STORY-001/002 acceptance evidence.
- `docs/06-commercial-deployment/LOCAL_DEVELOPMENT.md`: reproducible synthetic setup and recovery.
- `docs/03-architecture/OPENAPI_FOUNDATION.json`: generated REST contract.
- `docs/07-research/DEPENDENCIES.json`: exact adopted package inventory.

- `docs/04-delivery/IMPLEMENTATION_CONTROLLER.md`: corrected authorized controller.
- `docs/04-delivery/exec-plans/EXEC-001-baseline-review.md`: review execution/evidence.
- `docs/03-architecture/adr/ADR-009-ORTHOGONAL-FACT-STATE.md`: fact dimensions.
- `docs/03-architecture/adr/ADR-010-FOUNDATION-AND-R1-GATES.md`: security and scope.
- `requirements/traceability/acceptance-baseline-gates.yaml`: missing behavioral gates.
- `requirements/traceability/tests.yaml`: planned test inventory, distinct from executed evidence.

- `docs/07-research/ASTRA_BASELINE_REVIEW.md`: findings and conditional implementation recommendation.

The original register rows above record the 2026-09-05 draft baseline. The R0/R1
implementation contract is superseded by the 2026-09-06 approval record in
DOCUMENT_CONTROL.md; future-release and commercial planning remains draft.

- `docs/04-delivery/PUBLICATION_RECORD.md`: approved public publication, exact review/merge/check evidence, backlog links and remaining acceptance.

- `docs/06-commercial-deployment/FOUNDATION_OPERATIONS.md`: reference composition, release jobs, backup/restore and recovery limits.
- `docs/05-quality/FOUNDATION_OPERATIONS_VALIDATION.md`: operations increment scope, validation and remaining acceptance gates.
