# ADR-004: Use a Customer-Controlled AI Provider Abstraction

Status: Proposed baseline  
Date: 2026-09-05

## Context

Customers may prefer OpenAI, Azure OpenAI, Anthropic, Bedrock, Vertex AI, a private endpoint or no external AI. The product must not lock domain logic to one model.

## Decision

Use a first-party AI-provider interface. The initial TypeScript implementation may use the Vercel AI SDK for provider adapters, streaming and structured outputs. Persist provider-neutral AI-run metadata.

## Consequences

Positive:

- BYOK and private endpoints
- Easier provider replacement
- Model choice by task
- Reduced commercial lock-in

Negative:

- Provider capabilities differ
- Prompts and evaluations must be portable
- Full parity is not guaranteed

## Guardrails

- Domain code does not import provider SDK types.
- Critical extraction uses validated schemas.
- Deterministic features operate without AI.
- Model-specific features require capability detection.
- Customer data policy decides permitted routing.
