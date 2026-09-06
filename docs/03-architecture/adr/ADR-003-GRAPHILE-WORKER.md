# ADR-003: Use Graphile Worker for Background Work

Status: Accepted  
Date: 2026-09-05

## Context

The product needs schedules, reminders, escalations, synchronization, retries and report generation. Introducing Redis, Kafka or a separate workflow platform would increase operations.

## Decision

Use Graphile Worker with PostgreSQL for Release 1 background jobs. Keep authoritative workflow state in domain tables.

## Consequences

Positive:

- No additional queue datastore
- Durable restart-safe jobs
- TypeScript ecosystem
- Simple customer deployment
- Good fit with transactional outbox

Negative:

- Complex long-running orchestration may require more domain code
- PostgreSQL queue load must be monitored
- Multi-region requirements may later exceed the design

## Guardrails

- Workers are idempotent.
- Job retries are bounded.
- Domain state is not inferred from job existence.
- Human waits are represented by durable state and `next_action_at`.
- Temporal or another engine requires measured need and a new ADR.
