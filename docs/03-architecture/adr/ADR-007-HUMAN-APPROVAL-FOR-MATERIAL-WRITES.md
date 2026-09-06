# ADR-007: Human Approval for Material Writes

Status: Accepted
Date: 2026-09-05

## Context

Natural-language updates may be ambiguous. Project dates, status and customer communication have material consequences.

## Decision

Require the configured human approval for material writes in Release 1. Low-risk reminders may run automatically after policy activation. Baseline, financial and customer-facing changes remain outside autonomous execution.

## Consequences

Positive:

- Preserves accountability
- Builds customer trust
- Reduces harmful automation
- Creates clear evidence and audit

Negative:

- Adds user steps
- May slow high-volume updates
- Requires useful approval UX

## Guardrails

- Approval diff
- Proposal expiry
- Preflight source recheck
- Allowlisted operations
- Action receipt
- No bulk material approval in R1
- Shadow mode
