# Contributing

This repository is documentation-first and proprietary. Contributions are accepted only from authorised collaborators and must preserve requirement traceability, security boundaries, and product scope.

## Before starting

1. Read `AGENTS.md`.
2. Read `docs/00-governance/DOCUMENT_INDEX.md`.
3. Locate the applicable requirement IDs in `requirements/requirements.yaml`.
4. Read the linked architecture decisions and acceptance criteria.
5. Confirm that the work is in the approved release scope.
6. Create an ExecPlan under `docs/04-delivery/exec-plans/` when required by `PLANS.md`.

## Branch naming

Use one of the following forms:

```text
docs/<topic>
feature/<requirement-or-capability>
fix/<defect-or-requirement>
security/<topic>
chore/<topic>
```

Examples:

```text
feature/fr-upd-001-overdue-update-detection
feature/jira-connector
security/project-access-enforcement
docs/astra-baseline-review
```

## Commit guidance

Use focused commits with an explanatory subject:

```text
docs: clarify source authority conflict handling
feat: implement overdue update detector
fix: stop reminders after confirmed response
test: add duplicate webhook recovery scenario
security: enforce project scope in leadership queries
```

## Pull requests

Every implementation PR must identify:

- requirement IDs;
- architecture documents and ADRs followed;
- acceptance criteria satisfied;
- tests added or updated;
- security, data, connector, AI, and deployment impact;
- migration and rollback requirements;
- screenshots or recordings for user-facing changes; and
- validation commands and results.

Use `.github/pull_request_template.md` and do not remove sections without explanation.

## Documentation changes

A material documentation change must update all affected locations, including where applicable:

- human-readable BRD, PRD, FRD, TRD, NFR, or architecture document;
- `requirements/requirements.yaml`;
- `requirements/traceability.yaml`;
- acceptance criteria and test scenarios;
- decision log or ADR;
- roadmap, release scope, or dependency map; and
- document version/status register.

Do not solve conflicts by changing only one document.

## Open-source and external material

Follow `OPEN_SOURCE_POLICY.md`.

- Prefer published dependencies over copied source.
- Do not vendor entire external repositories.
- Do not use unlicensed or incompatible code.
- Record every runtime dependency in the adoption register.
- Keep external reference research clean-room and implementation-independent.

## Required validation

For the current documentation baseline:

```bash
python -m pip install -r requirements-dev.txt
python scripts/validate_documentation.py
```

Once application code exists, the mandatory checks defined in `AGENTS.md` will include linting, type checking, automated tests, builds, and relevant browser or integration tests.

## Review standard

A change is not complete merely because it works on the happy path. Review must cover:

- project-level authorisation;
- evidence provenance;
- stale and conflicting data;
- retry and idempotency behaviour;
- unknown external write outcomes;
- approval boundaries;
- audit receipts;
- failure recovery;
- customer-hosted deployment impact; and
- backward compatibility or migration.
