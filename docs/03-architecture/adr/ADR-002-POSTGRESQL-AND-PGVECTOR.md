# ADR-002: Use PostgreSQL and pgvector

Status: Proposed baseline  
Date: 2026-09-05

## Context

The product needs transactional operational data, durable workflows, versioned evidence, audit history and semantic retrieval.

## Decision

Use PostgreSQL as the primary database. Use pgvector within PostgreSQL for approved semantic retrieval of unstructured evidence.

## Consequences

Positive:

- One database to operate
- Strong transactions and constraints
- Durable workflow state
- Standard customer-hosting options
- Structured and vector data can share authorization metadata

Negative:

- Very large document-search workloads may later need a dedicated system
- Vector tuning requires care
- PostgreSQL operations remain a customer responsibility in self-hosted deployments

## Guardrails

- Structured authoritative fields do not depend on vector retrieval.
- Embeddings inherit source access and retention.
- Product code remains compatible with standard PostgreSQL.
- Supabase-specific runtime services are optional, not required.
