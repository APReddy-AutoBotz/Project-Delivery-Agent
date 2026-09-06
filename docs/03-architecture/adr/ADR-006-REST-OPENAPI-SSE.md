# ADR-006: REST, OpenAPI and Server-Sent Events

Status: Accepted
Date: 2026-09-05

## Context

The product needs maintainable APIs, connector-friendly contracts and streamed conversational responses. GraphQL would add flexibility but also schema and authorization complexity.

## Decision

Use REST APIs documented through OpenAPI. Use Server-Sent Events for streamed agent responses in Release 1.

## Consequences

Positive:

- Familiar enterprise integration
- Clear generated contracts
- Straightforward testing
- SSE is simpler than bidirectional sockets for current needs

Negative:

- Some screens may require multiple endpoints
- SSE is one-way after connection
- Future real-time collaboration may need another mechanism

## Guardrails

- Version externally consumed APIs.
- Use correlation IDs.
- Generate client types where practical.
- Add WebSockets only through an approved need and design.
