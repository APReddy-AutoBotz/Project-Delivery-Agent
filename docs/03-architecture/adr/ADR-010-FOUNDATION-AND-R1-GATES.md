# ADR-010: Enforce foundation security and bounded R1 workflows

Status: Accepted under delegated baseline approval; implementation gated by Issue #1
Date: 2026-09-06
Requirement IDs: FR-ADM-001, FR-ADM-002, FR-ADM-003, NFR-SEC-001, NFR-SEC-004, TR-AUTH-001, FR-UPD-010, FR-WRB-001, FR-WRB-004

## Context and decision

## Foundation security gate

EPIC-01 must deliver production OIDC validation, configurable user/group mappings,
server-enforced project/portfolio scope, service-identity separation, encrypted
credential storage, configuration validation and redacted audit/log output.
Negative tests must deny invalid/expired identities, cross-project direct API
access, revoked scope and production development login. Synthetic demo identity
is explicitly enabled only for local synthetic data. Shadow mode starts enabled.
Real-data ingestion, messaging and write-back depend on this gate. EPIC-10 performs
release verification and hardening of controls already present in every increment.

## Approved R1 scope decisions (2026-09-06)

- External project writes: approved Jira comments only; non-baseline field writes move to R2.
- Q&A: one explicitly resolved authorized project per answer; multi-project/portfolio analysis remains R3. Portfolio dashboards may list authorized projects.
- Reporting: editable PowerPoint required; PDF is optional and cannot substitute for PowerPoint.
- Cadence: weekday calculations, IANA time zones and quiet hours in R1; customer holiday calendars in R2.
- Health: stale/missing updates, blocker age, overdue work, GREEN-versus-critical-signal and completed-milestone-versus-open-work rules in R1; advanced propagation later.
- Basic OIDC user/group role mapping and enforced scope are foundation work; later enterprise administration extends them.

These decisions resolve OD-003/006/007/008 and conflicting earlier release wording.

## Workflow invariants

Human approval is absent from model tools and binds an immutable proposal revision.
Satisfying confirmed update facts stops their reminders without waiting for Jira.
Every external attempt persists its start, rechecks all preflight controls, and
reconciles uncertainty before retry. Restores quarantine outbound execution until
remote reconciliation. Comments use stable markers and an explicit as-of base;
the product does not claim Jira provides atomic compare-and-swap for comment POST.

## Alternatives and consequences

Reject end-of-release authentication retrofits and immediate field writes. This
adds early security verification but avoids unsafe intermediate deployments and
unnecessary R1 connector concurrency complexity. Keep TypeScript, PostgreSQL,
Graphile Worker and bounded AI adapters; no additional infrastructure, vendor
control plane or licence change. Extend operation allowlists in a later reviewed
ADR and connector contract tests without replacing the domain architecture.
