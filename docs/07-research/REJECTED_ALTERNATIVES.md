# Rejected or Deferred Alternatives

## Full PM platform fork

Examples: Plane, OpenProject, Leantime

Decision: Reject as foundation.

Reason:

- Product would drift into replacing Jira.
- Large code and deployment footprint.
- Copyleft licensing concerns for proprietary distribution.
- High maintenance.
- Most existing features are outside the intended assurance layer.

## n8n as embedded engine

Decision: Reject as product core.

Reason:

- Commercial licence limitations require careful agreement.
- Customer-hosted redistribution model is not assumed safe.
- Business state and evidence would be split across a general workflow platform.
- Harder to guarantee action receipts and domain constraints.

Allowed use:

- Internal prototype only, followed by first-party implementation.

## Activepieces as embedded engine

Decision: Defer/reject for R1.

Reason:

- Very large general-purpose platform.
- Mixed open and enterprise areas.
- Adds unnecessary infrastructure and upgrade responsibility.
- Connector concepts may be studied without embedding the platform.

## Early microservices

Decision: Reject.

Reason:

- Unnecessary network, deployment and consistency complexity.
- Harder customer installation.
- Higher operational burden.

Revisit only with measured scaling or team-boundary evidence.

## Kubernetes as default

Decision: Reject for R1.

Reason:

- Many target customers can operate a simpler container package.
- Kubernetes support can be added for enterprise deployments later.

## Separate vector database

Decision: Reject for R1.

Reason:

- pgvector is sufficient for initial evidence retrieval.
- Another service adds cost, security boundary and maintenance.

## Multi-agent swarm

Decision: Reject for R1.

Reason:

- Most product flows are explicit business workflows.
- Multiple autonomous agents complicate debugging, evaluation and authorization.
- Use role-specific policies over one evidence engine.

## Python backend

Decision: Reject for core.

Reason:

- TypeScript across web, API, worker and connectors reduces maintenance.
- Python sidecars remain possible for specialized document extraction.

## Next.js for the core application

Decision: Defer.

Reason:

- Core product is an authenticated application with no SEO requirement.
- React/Vite static assets simplify customer hosting.
- A separate public marketing site may use Next.js later.

## Supabase-specific product architecture

Decision: Reject as mandatory.

Reason:

- Demonstration hosting may use Supabase.
- Production product must support standard PostgreSQL and customer identity.
- Avoid mandatory Supabase Auth, Edge Functions or Realtime.

## Direct MCP-only Jira integration

Decision: Reject as internal architecture.

Reason:

- Deterministic synchronization, source authority and safe write-back need first-party connector control.
- MCP may be offered later as an external interface.
