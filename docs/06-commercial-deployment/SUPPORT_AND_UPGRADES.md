# Support and Upgrades

## Support scope

Standard maintenance should cover:

- Product defect correction
- Security fixes
- Supported connector compatibility
- Minor-version upgrades
- Release notes
- Deployment images
- Migration scripts
- Documentation updates
- Defined support hours

## Exclusions unless contracted

- Customer infrastructure operation
- Unsupported database or runtime
- Unreviewed source modifications
- Customer network or identity defects
- Third-party outage
- New connector
- Major customer-specific workflow
- Data cleansing
- Historical migration
- Major-version implementation
- Premium response time

## Version policy

Example:

- Current major version: full support
- Previous major version: security and critical fixes for defined period
- Older versions: upgrade assistance only
- Patch versions: backward-compatible defect/security fixes
- Minor versions: backward-compatible features and connector updates
- Major versions: may include migration and commercial upgrade terms

## Upgrade package

Each supported release includes:

- Image digest and signature
- SBOM
- Third-party notices
- Compatibility matrix
- Migration scripts
- Preflight checks
- Backup requirement
- Upgrade steps
- Validation steps
- Recovery/rollback instructions
- Known issues

## Connector compatibility

API providers change over time. Annual maintenance is required to fund:

- Authentication changes
- Endpoint changes
- New rate limits
- Field and schema changes
- Webhook changes
- Security requirements
- Deprecation handling

## Support diagnostics

Provide a redacted support bundle containing:

- Product version
- Configuration schema version
- Migration version
- Health state
- Connector error classes
- Job failures
- Correlation IDs
- Sanitized logs
- No secrets
- No unrestricted project data by default

## Project update cadence migration

The cadence migration only adds defaults-backed columns to immutable project-update policy revisions. Historical revisions start with no reminders, no escalation recipient and no quiet-hours interval. Roll back an application by deploying code that ignores these columns; preserve the additive schema and revision data for a forward fix. Do not edit prior migration files or rewrite immutable policy revisions.

Schedule previews are transient. They do not enqueue work or send messages. A denied or stale-revision preview requires the administrator to assess the current policy and confirm the PM responsibility and current project or portfolio read grant before retrying.
