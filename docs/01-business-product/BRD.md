# Business Requirements Document

## 1. Purpose

This document defines the business problem, expected outcomes, stakeholders, business requirements and commercial constraints for the Project Delivery Assurance Agent.

## 2. Business background

Project teams commonly use a combination of work-management tools, spreadsheets, email, chat and presentation files. These systems capture parts of delivery reality but do not ensure that project information is current, consistent or decision-ready.

Project managers and PMOs therefore spend time:

- Requesting updates
- Sending reminders
- Reconciling contradictory sources
- Preparing project and portfolio reports
- Explaining delays to leadership
- Following up on risks, dependencies and decisions
- Updating several systems with the same information

Leadership may receive late or overly optimistic status information. A green project status can conceal overdue critical work, repeated sprint carryover or unresolved dependencies.

## 3. Business problem statement

The organisation lacks an always-on, governed mechanism that:

- Monitors project delivery information across approved sources
- Identifies what is missing, stale or contradictory
- Engages the responsible person for clarification
- Follows up until the update is received or escalated
- Recommends an appropriate delivery intervention
- Applies approved updates to the right system
- Provides leadership with current, evidence-backed explanations
- Publishes consistent management views from the same verified fact set

## 4. Business objectives

| ID | Objective |
|---|---|
| BO-001 | Reduce manual time spent requesting, consolidating and reporting project updates. |
| BO-002 | Increase the percentage of projects with current and complete status information. |
| BO-003 | Detect risks, delays and dependency problems earlier. |
| BO-004 | Improve confidence in leadership reporting and explanations. |
| BO-005 | Preserve existing project-management investments and avoid forced tool migration. |
| BO-006 | Provide customer-controlled deployment and AI routing. |
| BO-007 | Maintain human accountability for material delivery commitments and governance records. |
| BO-008 | Create a repeatable product that can be configured for multiple customers without code forks. |

## 5. Stakeholders

| Stakeholder | Interest |
|---|---|
| Leadership and sponsors | Current delivery position, causes, decisions and intervention needs |
| Head of PMO | Portfolio visibility, reporting quality and governance compliance |
| Program and project managers | Reduced administrative work and actionable follow-up |
| Scrum masters | Sprint health, blockers, carryover and missing team updates |
| Team leads | Ownership, technical dependencies and unresolved decisions |
| Contributors | Focused requests rather than broad repetitive reminders |
| IT and security | Least-privilege access, deployment control, audit and privacy |
| Product owner | Commercial viability, reusability and maintainability |
| Customer procurement/legal | Licence, support, data protection and source-access rights |

## 6. Business requirements

| ID | Requirement | Priority |
|---|---|---:|
| BR-001 | The product must reduce manual effort spent collecting and consolidating project updates. | Must |
| BR-002 | The product must improve the freshness and completeness of project information. | Must |
| BR-003 | The product must identify delivery risk and delay signals before formal reporting where evidence allows. | Must |
| BR-004 | Leadership answers and reports must be traceable to approved sources. | Must |
| BR-005 | The product must work with existing project and collaboration tools rather than requiring their replacement. | Must |
| BR-006 | The product must support customer-hosted deployment and customer-controlled AI-provider configuration. | Must |
| BR-007 | Material changes to external systems must remain governed, permission-aware and auditable. | Must |
| BR-008 | Update cadence, escalation, health rules, terminology and report formats must be configurable. | Must |
| BR-009 | The product must provide role-relevant support to PMs, scrum masters, team leads, PMO and leadership. | Should |
| BR-010 | The product must be maintainable as one common product without customer-specific branches. | Must |
| BR-011 | The product must support gradual adoption through read-only and shadow modes. | Must |
| BR-012 | The product must measure operational and business value during pilots. | Must |
| BR-013 | The product must avoid employee-performance scoring or unsupported blame attribution. | Must |
| BR-014 | The product must operate usefully when AI features are disabled or temporarily unavailable. | Should |
| BR-015 | The product must support formal snapshots for steering, customer reporting and audit while retaining a live view. | Should |

## 7. Business rules

1. Different project fields may have different authoritative sources.
2. A source conflict must not be silently resolved.
3. The latest record is not automatically authoritative if it lacks approval or comes from a lower-authority source.
4. Material write-back requires the correct approval unless an explicit policy classifies the change as low risk.
5. The product must distinguish recorded facts, human confirmations and agent inferences.
6. Leadership answers must respect the user’s project and portfolio access.
7. A non-response must follow the configured escalation path and must not be treated as confirmation.
8. Project health calculations must be deterministic and explainable.
9. AI may draft or interpret but must not independently change project commitments.
10. Customer data and deployment environment remain customer-owned.
11. The customer may receive source access only under a separate commercial licence.
12. Generic improvements to the core product remain reusable product IP unless a contract explicitly states otherwise.

## 8. Constraints

- Early resources are limited; low operational complexity is required.
- Release 1 must focus on Jira Cloud and spreadsheet inputs.
- The product must not depend on a mandatory external SaaS control plane.
- AI usage may be restricted by customer policy.
- Connector permissions and API limits vary by customer.
- Customer field names, statuses and reporting practices differ.
- Formal legal documents require specialist counsel.
- The initial event showcase may use synthetic data only.

## 9. Expected business outcomes

- Less PM and PMO administration
- Faster update completion
- Fewer stale project records
- Earlier escalation of material blockers
- Faster response to leadership questions
- More consistent reports
- Improved evidence and auditability
- Reduced duplication between project tools and reporting packs
- Commercially repeatable customer implementations

## 10. Business risks

| Risk | Impact | Mitigation |
|---|---|---|
| Native PM tools add similar features | Reduced differentiation | Focus on cross-tool governance, evidence and customer hosting |
| Poor source data produces poor conclusions | Loss of trust | Freshness, conflict handling and human confirmation |
| Agent reminders feel intrusive | Low adoption | Configurable tone, quiet hours, role-based policies and shadow mode |
| Customers require extensive customisation | Maintenance burden | Configuration-first product and controlled extension points |
| Integration permissions delay pilots | Schedule impact | Read-only spreadsheet demo path and early access checklist |
| AI produces an incorrect explanation | Management risk | Structured facts, claim checking, citations and uncertainty labels |
| One-time licence produces unstable revenue | Commercial risk | Annual maintenance and paid connector/customisation services |

## 11. Success conditions

The business case is validated when at least one design partner completes a paid pilot and the pilot demonstrates measurable improvement in update timeliness, reporting effort, evidence coverage or leadership response time.

See `docs/06-commercial-deployment/PILOT_SUCCESS_METRICS.md`.
