# Definition of Done

A story is done only when all applicable conditions are met.

## Requirements

- Requirement IDs are listed.
- Acceptance criteria are satisfied.
- Scope matches the approved release.
- Any requirement change is approved and documented.

## Design

- Applicable architecture documents and ADRs are followed.
- New architecture decisions have an ADR.
- Customer-specific behavior is configuration, not a fork.
- Failure and recovery paths are designed.

## Implementation

- Code is typed and follows module boundaries.
- External SDKs remain inside adapters.
- Authorization is enforced server-side.
- AI tools are bounded.
- External writes use approval, preflight and receipts as required.
- Audit events are implemented.
- Secrets are not logged or committed.

## Testing

- Unit tests pass.
- Integration tests pass.
- Contract tests pass for connector changes.
- Playwright tests pass for user journeys.
- Golden AI scenarios pass where applicable.
- Security and negative tests pass.
- Migration and recovery are tested.
- AI-disabled fallback is tested where applicable.

## Documentation

- User or admin behavior is documented.
- OpenAPI is updated.
- Configuration schema is updated.
- Open-source register is updated for dependencies.
- Deployment or upgrade notes are updated.
- Screenshots or sample outputs are attached for visible changes.

## Validation

Required repository checks pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
python scripts/validate_documentation.py
```

## Review

- No unresolved P0/P1 review finding.
- No critical/high security finding.
- Product Owner accepts user-visible behavior where required.
- Rollback or recovery is documented.

## Completion statement

The pull request states:

- Requirements implemented
- Tests and evidence
- Security impact
- Data/migration impact
- Connector scope impact
- Known limitations
- Recovery method
