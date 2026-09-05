# ExecPlan Standard

An ExecPlan is required for work that is long-running, touches more than one major module, changes the database, adds a connector, changes permissions, changes agent autonomy, adds a material external write, introduces a runtime dependency, changes deployment or requires migration.

ExecPlans live under:

```text
docs/04-delivery/exec-plans/
```

## Required format

```markdown
# <Plan ID>: <Title>

Status: Draft | Approved | In Progress | Blocked | Completed
Owner:
Requirement IDs:
GitHub issue:
Target release:
Last updated:

## Objective

## In scope

## Out of scope

## Current state

## Proposed design

## Files and modules expected to change

## Data model or migration impact

## Security and privacy impact

## Connector and permission impact

## Open-source dependency impact

## Implementation stages

## Test and evaluation plan

## Rollback and recovery

## Progress log

## Decisions made

## Risks and mitigations

## Validation evidence

## Completion summary
```

## Planning rules

- The plan must be self-contained.
- Reference requirement IDs rather than restating them inconsistently.
- Record decisions as they are made, not only at the end.
- Update progress after each meaningful implementation stage.
- Separate facts from assumptions.
- Include failure paths and rollback.
- Do not use an ExecPlan to bypass a missing product decision.
- Any scope change must identify affected requirements and documents.
