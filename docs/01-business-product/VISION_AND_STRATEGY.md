# Vision and Strategy

## Vision

Project leaders should be able to trust the current delivery position without manually assembling information from multiple tools or repeatedly chasing people for updates.

## Mission

Build a customer-hosted delivery assurance agent that keeps project information current, coordinates follow-up, recommends practical interventions, performs controlled updates and explains delivery status using traceable evidence.

## Product category

The product is a **Project Delivery Assurance and PMO Intelligence layer**.

It is not:

- A replacement for Jira, ClickUp, Trello, Microsoft Project or other work-management tools
- A general chatbot over project documents
- A report generator that merely summarizes whatever was last recorded
- An autonomous project manager
- An employee-surveillance or performance-ranking system

## Strategic problem

Most organisations already have project data, but it is fragmented and incomplete:

- Work items are in Jira or another PM tool.
- Portfolio data is often maintained in spreadsheets.
- Risks and decisions are discussed in email, Teams or meetings.
- Project managers manually chase updates and prepare management reports.
- Leadership receives a polished status but cannot easily verify why a project is delayed.
- Reported health may conflict with objective delivery signals.
- Important risks may be discussed informally but never entered into the formal RAID record.

The product addresses the gap between **data storage** and **trusted delivery coordination**.

## Strategic pillars

### 1. Project truth

Create a field-level, evidence-backed view rather than treating one system or one narrative as universally authoritative.

### 2. Accountability without administration

Ask the correct person a focused question, follow up according to policy, and stop reminders when a valid response is received.

### 3. Early intervention

Detect stale data, delivery drift, dependency slippage and contradictions before the next steering report.

### 4. Governed action

Convert natural-language updates into proposed structured changes, require the appropriate approval and create a complete action receipt.

### 5. Explainability

Answer leadership questions with evidence, timestamps, freshness and explicit uncertainty.

### 6. Customer control

Support customer-hosted deployment, least-privilege connectors and customer-selected AI routing.

### 7. Tool independence

Work above existing delivery systems and avoid forcing a broad platform migration.

## Strategic differentiation

The product must combine capabilities that are usually separate:

- Cross-tool canonical project model
- Project Fact and Evidence Ledger
- Source Authority Matrix
- Contextual update requests
- Configurable reminders and escalation
- Deterministic delivery-health signals
- Role-specific recommendations
- Approval diff and controlled write-back
- Leadership Q&A with claim-level evidence
- Live dashboard and formal report snapshots
- Customer-hosted and BYOK deployment
- Shadow mode for safe adoption

No single feature is sufficiently defensible. The integrated assurance loop is the product.

## Initial customer segment

Primary early targets:

- Consulting and IT services firms
- Automation and transformation teams
- Shared-service organisations
- Internal PMOs
- Product and engineering portfolios
- Regulated or security-conscious organisations
- Organisations managing approximately 15 to 200 active projects
- Teams using Jira plus spreadsheets or multiple project tools

## Buyer and champion

Likely economic buyers:

- Head of PMO
- Delivery Director
- Transformation Director
- COO
- CIO
- Program Director

Likely internal champions:

- PMO Manager
- Portfolio Manager
- Senior Project Manager
- Delivery Operations Lead

## Long-term product direction

The long-term platform has three layers:

1. **Project Truth Layer**  
   Connectors, canonical model, evidence ledger and source authority.

2. **Delivery Assurance Layer**  
   Freshness, health, contradiction detection, engagement, escalation, advice and controlled action.

3. **Experience and Enterprise Layer**  
   Role workspaces, leadership Q&A, dashboards, reports, administration, deployment and audit.

## Relationship with AvalaOS

The product remains standalone initially.

Potential future relationship:

```text
AvalaOS evaluates and governs transformation initiatives
                         |
                         v
Project Delivery Assurance Agent coordinates and assures delivery
                         |
                         v
AvalaOS receives outcome and benefit evidence
```

The products may share design principles and APIs but must retain separate repositories, deployment packages and commercial SKUs until a validated integration need exists.

## North-star outcome

> Leadership can ask, “What is delayed, why, what is being done, and what evidence supports that answer?” and receive a current, permission-aware answer without asking the PMO to assemble it manually.
