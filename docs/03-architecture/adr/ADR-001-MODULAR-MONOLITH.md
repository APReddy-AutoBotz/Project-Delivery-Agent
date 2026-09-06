# ADR-001: Use a Modular Monolith

Status: Accepted  
Date: 2026-09-05

## Context

The product has many business capabilities but limited initial engineering and operations capacity. Early microservices would add deployment, networking, consistency, tracing and support complexity.

## Decision

Build one logical backend organized into domain modules. Run the interactive API and background worker as separate processes from the same repository and shared packages.

## Consequences

Positive:

- Simpler customer deployment
- Easier Codex and developer understanding
- Atomic PostgreSQL transactions
- Lower support burden
- Clear future extraction points

Negative:

- Module boundaries require discipline
- Independent scaling is limited initially
- A badly structured monolith could become tightly coupled

## Guardrails

- Domain modules expose explicit interfaces.
- External SDKs remain in infrastructure adapters.
- No circular package dependencies.
- Cross-module communication uses application services or domain events.
- Extract a service only after a measured need and an approved ADR.
