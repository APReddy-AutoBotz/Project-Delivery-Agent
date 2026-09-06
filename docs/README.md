# Documentation Home

This directory is the authoritative human-readable baseline for the Project Delivery Assurance Agent.

**Baseline:** v0.1 Approved candidate (effective after Issue #1 review PR merge)
**Product:** Project Delivery Assurance Agent  
**Approval authority:** Product Owner

## Recommended reading paths

### Executive and product review

1. [Vision and Strategy](01-business-product/VISION_AND_STRATEGY.md)
2. [Business Requirements Document](01-business-product/BRD.md)
3. [Product Requirements Document](01-business-product/PRD.md)
4. [Product Scope](01-business-product/PRODUCT_SCOPE.md)
5. [Success Metrics](01-business-product/SUCCESS_METRICS.md)

### Business analyst and implementation planning

1. [Functional Requirements](02-requirements/FRD.md)
2. [Agent Behavior](02-requirements/AGENT_BEHAVIOR.md)
3. [Source Authority Model](02-requirements/SOURCE_AUTHORITY_MODEL.md)
4. [Update Cadence and Escalation](02-requirements/UPDATE_CADENCE_AND_ESCALATION.md)
5. [Approval and Write-back](02-requirements/APPROVAL_AND_WRITEBACK.md)
6. [Release 1 Vertical Slice](04-delivery/RELEASE-1-VERTICAL-SLICE.md)
7. [Epics and Stories](04-delivery/EPICS_AND_STORIES.md)
8. [Acceptance Criteria](04-delivery/ACCEPTANCE_CRITERIA.md)

### Technical and architecture review

1. [Technical Requirements](02-requirements/TRD.md)
2. [Non-Functional Requirements](02-requirements/NFR.md)
3. [Solution Architecture](03-architecture/SOLUTION_ARCHITECTURE.md)
4. [Domain Architecture](03-architecture/DOMAIN_ARCHITECTURE.md)
5. [Data Model](03-architecture/DATA_MODEL.md)
6. [Integration Architecture](03-architecture/INTEGRATION_ARCHITECTURE.md)
7. [AI and Grounding Architecture](03-architecture/AI_AND_GROUNDING_ARCHITECTURE.md)
8. [Workflow Architecture](03-architecture/WORKFLOW_ARCHITECTURE.md)
9. [Security and Privacy](03-architecture/SECURITY_AND_PRIVACY.md)
10. [Deployment and Operations](03-architecture/DEPLOYMENT_AND_OPERATIONS.md)
11. [Architecture Decision Records](03-architecture/adr/README.md)

### QA, security, and acceptance review

1. [Test Strategy](05-quality/TEST_STRATEGY.md)
2. [Agent Evaluation Strategy](05-quality/AGENT_EVALUATION_STRATEGY.md)
3. [Golden Test Scenarios](05-quality/GOLDEN_TEST_SCENARIOS.md)
4. [Threat Model](05-quality/THREAT_MODEL.md)
5. [Failure and Recovery Tests](05-quality/FAILURE_AND_RECOVERY_TESTS.md)
6. [Definition of Done](05-quality/DEFINITION_OF_DONE.md)

### Commercial and deployment review

1. [Commercial Model](06-commercial-deployment/COMMERCIAL_MODEL.md)
2. [Customer Hosting Model](06-commercial-deployment/CUSTOMER_HOSTING_MODEL.md)
3. [Source Access Licensing](06-commercial-deployment/SOURCE_ACCESS_LICENSING.md)
4. [Support and Upgrades](06-commercial-deployment/SUPPORT_AND_UPGRADES.md)
5. [Pilot Model](06-commercial-deployment/PILOT_MODEL.md)
6. [Pilot Success Metrics](06-commercial-deployment/PILOT_SUCCESS_METRICS.md)

## Directory purpose

| Directory | Purpose |
|---|---|
| `00-governance` | Document control, glossary, assumptions, decisions, change control, and traceability. |
| `01-business-product` | Business problem, product direction, users, scope, use cases, and success measures. |
| `02-requirements` | Functional, technical, non-functional, access, agent, cadence, approval, and reporting requirements. |
| `03-architecture` | System design, data, integrations, AI grounding, workflows, security, deployment, and ADRs. |
| `04-delivery` | Roadmap, Release 1 scope, implementation backlog, dependencies, acceptance criteria, and demo. |
| `05-quality` | Test strategy, agent evaluations, security threats, failure recovery, and completion standards. |
| `06-commercial-deployment` | Customer-hosted delivery, licensing, pilots, support, upgrades, and commercial assumptions. |
| `07-research` | Market review, competitor analysis, public-repository research, and open-source decisions. |

## Authority and change control

- The [Document Index](00-governance/DOCUMENT_INDEX.md) records the baseline documents and their state.
- Machine-readable requirement authority is maintained in [`../requirements/requirements.yaml`](../requirements/requirements.yaml).
- Requirement-to-acceptance/test mapping is maintained in [`../requirements/traceability.yaml`](../requirements/traceability.yaml).
- Material changes follow [Change Control](00-governance/CHANGE_CONTROL.md).
- Open decisions must be recorded in [Open Decisions](00-governance/OPEN_DECISIONS.md) rather than resolved silently during implementation.
- Baseline approval follows the Product Owner delegation and exact-candidate review/check/merge gate in DOCUMENT_CONTROL.md.

## Documentation validation

From the repository root:

```bash
python -m pip install -r requirements-dev.txt
python scripts/validate_documentation.py
```

Do not manually renumber requirement, acceptance-criteria, story, or test IDs. Stable IDs are required for issue, PR, implementation, and test traceability.
