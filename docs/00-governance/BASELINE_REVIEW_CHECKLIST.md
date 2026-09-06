# Baseline Review Checklist

## Product review

- [ ] Problem and target buyer are clear.
- [ ] Product is positioned as delivery assurance, not only reporting.
- [ ] Release 1 scope is small enough to complete.
- [ ] Explicit non-goals are accepted.
- [ ] Relationship with AvalaOS is accepted.
- [ ] Success and pilot metrics are measurable.

## Requirements review

- [ ] Business requirements are approved.
- [ ] Release 1 Must requirements are understood.
- [ ] Every Release 1 implementation story has acceptance criteria.
- [ ] Remaining detailed criteria will be added before the relevant story begins.
- [ ] RBAC and project scoping match expected customer use.
- [ ] Agent behavior and prohibited actions are accepted.
- [ ] Source-authority examples reflect real PMO practice.
- [ ] Reminder and escalation defaults are acceptable.

## Architecture review

- [ ] Modular monolith accepted.
- [ ] TypeScript-first stack accepted.
- [ ] PostgreSQL and pgvector accepted.
- [ ] Graphile Worker accepted.
- [ ] AI provider abstraction accepted.
- [ ] Customer-hosted single-tenant model accepted.
- [ ] Human approval for material writes accepted.
- [ ] Jira plus spreadsheet is sufficient for R1.

## Security review

- [ ] Customer/project/evidence authorization is explicit.
- [ ] Connector and AI secrets remain customer-controlled.
- [ ] Prompt injection and bounded-tool controls are explicit.
- [ ] Action receipts and preflight checks are explicit.
- [ ] Employee-performance scoring is excluded.
- [ ] Shadow mode is mandatory for onboarding.

## Delivery review

- [ ] Critical path and stories are coherent.
- [ ] Demo scenario proves the complete loop.
- [ ] Failure and recovery scenarios are sufficient.
- [ ] Definition of Done is accepted.
- [ ] Backup, restore and upgrade are included in R1.
- [ ] GitHub issue and PR templates are usable.

## Before implementation begins

1. Push `docs/baseline-v0.1` to the intended repository.
2. Open a documentation baseline pull request.
3. Run the Astra review prompt.
4. Resolve P0 findings and product-owner decisions.
5. Approve the selected ADRs.
6. Mark the Release 1 requirements as approved in YAML.
7. Merge or tag the approved baseline.
8. Generate R0 and R1 GitHub issues from stories.
9. Start `EPIC-01` only.
