# Product Scope

## Product boundary

The product sits above operational project tools and collaboration channels.

```text
Operational systems store work and project records.
The Project Delivery Assurance Agent verifies, coordinates, advises and explains.
```

## In scope by product layer

### Project Truth Layer

- Tool-neutral project model
- Source synchronization
- Field mapping
- Source authority
- Fact classification
- Evidence links
- Freshness and confidence
- Conflict detection
- Historical versions

### Delivery Assurance Layer

- Update due detection
- Contextual update collection
- Reminders and escalation
- Deterministic health signals
- Contradiction detection
- PM and team recommendations
- Human approval
- Controlled write-back
- Action receipts

### Experience and Enterprise Layer

- Role workspaces
- Leadership Q&A
- Portfolio dashboard
- Email and in-app notifications
- PowerPoint/PDF snapshots
- OIDC and RBAC
- Customer-hosted deployment
- BYOK and private model endpoints
- Audit and operational administration

## Release boundaries

| Capability | R1 | R2 | R3+ |
|---|---:|---:|---:|
| Jira Cloud | Yes | Expanded | Mature |
| Excel/CSV | Yes | Expanded templates | Mature |
| Email with secure update link | Yes | Outlook reply capture | Mature |
| Microsoft Teams | No | Yes | Mature |
| SharePoint/OneDrive | No | Yes | Mature |
| Evidence ledger | Yes | Expanded | Mature |
| Source authority | Yes | Expanded | Mature |
| Update reminders | Yes | Multiple policies | Mature |
| Controlled write-back | Limited | Expanded | Mature |
| Leadership Q&A | Project level | Portfolio level | Cross-system |
| PowerPoint/PDF | Basic template | Customer templates | Template marketplace |
| Contradiction detection | One or two rules | Portfolio rules | Methodology library |
| Cross-project dependencies | Limited/manual | Initial | Advanced |
| Other PM tools | No | No | Phased |
| MCP exposure | No | Evaluate | Optional |
| AvalaOS integration | No | Design only | Optional |

## Explicit non-goals

- Competing with Jira as a work-item tracker
- Becoming a full PPM financial system
- Making employment decisions
- Monitoring individual activity as a productivity score
- Replacing professional project judgement
- Automatically assigning blame
- Writing to every connected system by default
- Centralizing customer credentials in a vendor-operated service
- Custom customer code branches

## Standalone relationship with AvalaOS

The project remains separate because AvalaOS focuses on evaluating, governing, delivering and proving automation or AI initiatives. The new product focuses on day-to-day delivery assurance across projects.

Future integration may exchange:

- Approved initiatives
- Delivery milestones
- Risks and decisions
- Outcome evidence
- Benefit-realization status

The integration must use APIs or events rather than shared database tables.
