# ADR-005: Customer-Hosted, Single-Tenant First

Status: Accepted
Date: 2026-09-05

## Context

The intended commercial proposition emphasizes customer control, BYOK, data security and deployment inside the customer environment.

## Decision

Each production customer receives a logically single-tenant deployment. The customer owns infrastructure, data and credentials. The vendor supplies licensed product images, configuration, upgrades and support.

## Consequences

Positive:

- Strong customer control
- Clear data boundary
- Easier procurement for some regulated buyers
- Customer-owned integrations and AI usage

Negative:

- Many deployments must be supported
- Upgrade coordination is harder than SaaS
- Operational diagnostics require good tooling
- Product analytics may be limited

## Guardrails

- One common code line.
- Signed versioned images.
- Configuration export and validation.
- No mandatory vendor telemetry.
- Support access only under explicit customer control.
