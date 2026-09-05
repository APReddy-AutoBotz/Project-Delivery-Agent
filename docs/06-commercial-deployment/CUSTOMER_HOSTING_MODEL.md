# Customer Hosting Model

## Standard model

The customer deploys the product inside its controlled environment.

Customer owns:

- Project data
- Database
- Infrastructure
- Domain and TLS
- Identity-provider configuration
- Connector credentials
- AI provider credentials and usage
- Backups
- Operational logs

Vendor retains:

- Core product IP
- Generic connectors and framework
- Reusable templates
- Generic improvements
- Release packaging
- Product roadmap

## Deployment tiers

### Standard customer-hosted

- Signed container images
- Docker Compose or approved container deployment
- Configuration access
- Customer data ownership
- No core repository access
- Annual maintenance required for supported upgrades

### Enterprise source access

- Restricted repository or source package
- Internal-use licence
- No resale or third-party hosting
- Customer changes outside support unless reviewed
- Higher licence and maintenance fee

### Escrow

- Source held by an agreed escrow provider
- Release only under defined continuity events
- No routine customer modification rights

## Customer prerequisites

- Supported Linux or container environment
- PostgreSQL
- OIDC identity provider
- Network access to configured external systems
- Jira integration registration or account
- AI endpoint or no-AI decision
- Email channel
- Backup location
- Named technical and business owners

## Network patterns

- Outbound-only access preferred where possible
- Inbound webhook endpoint protected by customer ingress
- Optional polling-only mode if webhooks are not allowed
- Customer proxy support
- Configurable certificate trust
- No mandatory vendor callback service

## Support access

Vendor access to production must be:

- Explicitly approved
- Time-bound
- Least privilege
- Logged
- Revocable
- Covered by the commercial and data-processing agreement

A support bundle should allow diagnosis without transferring full customer content where possible.
