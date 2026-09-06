# ADR-009: Preserve fact origin independently of assessed state

Status: Accepted under delegated baseline approval; implementation gated by Issue #1
Date: 2026-09-06
Requirement IDs: FR-EVD-003, FR-EVD-004, FR-EVD-006, FR-EVD-007, FR-QA-005, TR-AI-003

## Context

A single enum cannot represent a human-confirmed statement that is stale and
conflicting. Overwriting origin destroys attribution; hiding a qualifier can
mislead leadership. No production schema exists yet.

## Decision

## Orthogonal fact state (ADR-009)

Persist provenance on each immutable fact version as SYSTEM_VERIFIED,
HUMAN_CONFIRMED, AGENT_INFERENCE or UNKNOWN. It records origin, so it survives
expiry and contradictory evidence. Calculate freshness (CURRENT, STALE, UNKNOWN)
and conflict (NONE, CONFLICTING) separately using policy and an explicit as-of time.
Never mutate a historical version just because time passes. Freeze these assessed
dimensions, the policy revision and as-of time in a report/answer claim.

A primary display classification is CONFLICTING when unresolved, otherwise STALE
when expired, otherwise UNKNOWN when freshness is unknown, otherwise provenance.
Show all dimensions alongside that label. Only current, unconflicted,
authority-permitted SYSTEM_VERIFIED or HUMAN_CONFIRMED claims may be presented as
settled facts. Human confirmation establishes attribution; it does not override
source authority. A stale, conflicting human statement retains all three states.

## Alternatives and consequences

Reject mutually exclusive storage and an unvalidated bag of tags. Typed dimensions
preserve source history with one deterministic presentation rule. Existing six
display labels remain available; consumers also receive every dimension. Freshness
is assessed from effective/observed/valid-until dates and the versioned policy;
unknown validity yields UNKNOWN, never CURRENT. Conflict evidence stays linked.
No new service, embedding dependency or licence is introduced. A future API change
must migrate clients explicitly; initial migrations can implement this directly.
