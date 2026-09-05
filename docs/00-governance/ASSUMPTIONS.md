# Assumptions

## Business assumptions

- Initial customers are small and mid-sized consulting firms, IT services firms, transformation teams, shared services and internal PMOs.
- Early customers already use Jira, spreadsheets or both and do not want to replace those systems.
- Customers experience recurring effort in chasing updates, reconciling information, preparing leadership reports and explaining delays.
- Customer-hosted deployment and customer-controlled AI routing are important differentiators for regulated or security-conscious buyers.
- The product will be sold as licensed software plus implementation, support and optional enhancements rather than as a low-cost consumer SaaS tool.
- The working product name is temporary and may change before commercial launch.

## Product assumptions

- The product assists PMs and leadership; it does not replace accountable project roles.
- Reporting is an output of the assurance loop, not the complete product.
- One field may have a different authoritative source from another field.
- Some essential delivery context exists only in human updates and cannot be inferred safely from Jira.
- Material source-system changes require approval in the early releases.
- The first demonstrable value comes from Jira plus spreadsheet integration, not from supporting many incomplete connectors.
- The user interface must provide action queues as well as conversational Q&A.

## Technical assumptions

- The product will use a TypeScript-first modular monolith.
- Release 1 will be deployable as OCI containers through Docker Compose or a compatible runtime.
- PostgreSQL will store operational data, evidence, workflow state and audit history.
- The initial product will use direct REST integrations for deterministic synchronization and controlled writes.
- MCP may be exposed later as an external interaction interface but will not replace the internal connector architecture.
- AI providers are replaceable and selected by customer configuration.
- The system must still provide deterministic monitoring and reporting features when AI is disabled.
- Customer-specific differences are configuration, not code forks.

## Release 1 assumptions

- Jira Cloud is the first live PM-system connector.
- Excel or CSV is the first portfolio input format.
- Email plus a secure update page is the first human update channel.
- Microsoft Teams and full Microsoft Graph reply capture follow after the core loop works.
- PowerPoint generation is included as a management output but PowerPoint ingestion is deferred.
- A synthetic portfolio can be used for the event demonstration.
- The target demo may be used for prospect conversations in Amsterdam during October 2026.

## Assumptions requiring validation

| ID | Assumption | Validation method |
|---|---|---|
| ASM-001 | PMOs will pay for update accountability, not only report generation. | Prospect interviews and paid pilot proposal |
| ASM-002 | Customer hosting materially improves purchase confidence. | Security and procurement interviews |
| ASM-003 | Jira plus spreadsheet covers enough first-customer scenarios. | Review real project-reporting samples |
| ASM-004 | PMs will approve structured write-back proposals. | Usability testing |
| ASM-005 | Leadership values evidence-backed Q&A enough to use it regularly. | Pilot usage and interview data |
| ASM-006 | Role-specific recommendations are useful without being intrusive. | PM, scrum master and team lead testing |
| ASM-007 | Customer-specific field mappings can be handled through configuration. | Two or more pilot configurations |
