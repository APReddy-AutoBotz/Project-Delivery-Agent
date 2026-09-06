# ADR-012: Executable foundation contracts

Status: Accepted under delegated controller authority; exact implementation review required
Date: 2026-09-06
Requirement IDs: TR-STACK-001, TR-STACK-003, TR-STACK-005, TR-API-001, NFR-MNT-002, NFR-MNT-005

## Decision

Use the installed Zod runtime schemas as the source for request validation,
successful response validation and OpenAPI 3.0 schema generation. Register every
Nest controller operation; application startup rejects omitted/extra contracts.
Validate successful responses before serialization and fail with a generic 500
when repository results violate the contract. Convert dates explicitly to wire
strings. Normalize exceptions to fixed error bodies, including parser 400/413/415
failures, without reflecting request or infrastructure details. Document these
errors and test actual HTTP serialization independently
with development-only Ajv and ajv-formats. CI compares the generated document to
the committed export without rewriting it.

Use the installed TypeScript parser to check source imports and workspace
dependency cycles. Domain code can depend only on the approved Zod primitive,
with no infrastructure SDK or Node runtime imports. Cross-package imports use
declared workspace public package names; reject relative/deep imports and alias
configuration that could bypass this boundary. API/worker main.ts are composition
roots; database wiring belongs there, and worker tasks depend on a narrow domain
heartbeat repository port. First-party source remains TypeScript. These static
checks enforce repository conventions, not a sandbox against arbitrary code.

## Scope and consequences

No new delivery model, connector, external action or customer deployment is added.
Existing migration evidence is made explicit with schema/constraint assertions.
CI-FND-001 and INT-DATA-001 can become implemented specifications once their
executable evidence passes. STORY-001/002 acceptance requires the corrected
candidate's independent review, passing required CI and merge. Distribution,
customer installation and the other R0 story contracts remain separate gates.

Sources: [Zod JSON Schema](https://zod.dev/json-schema),
[Nest interceptors](https://docs.nestjs.com/interceptors),
[Ajv](https://github.com/ajv-validator/ajv/tree/v8.20.0).
