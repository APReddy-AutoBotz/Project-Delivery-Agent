# ADR-008: TypeScript-First Product

Status: Accepted  
Date: 2026-09-05

## Context

Low maintenance and limited technical involvement are priorities. A mixed frontend/backend language stack would increase tooling, hiring and debugging overhead.

## Decision

Use TypeScript for the web application, API, worker, connectors, AI tools and report generation. Permit isolated sidecars only when a mature capability is not reasonably available in TypeScript.

## Consequences

Positive:

- Shared types and schemas
- One main toolchain
- Strong Codex support
- Easier developer transfer
- Large integration ecosystem

Negative:

- Some document and data tooling is stronger in Python
- CPU-heavy analytics may require later services
- Runtime type validation is still required

## Guardrails

- Use Zod or equivalent at external boundaries.
- Keep optional Python tools isolated behind HTTP or job interfaces.
- Do not add a second runtime for convenience alone.
