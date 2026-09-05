# Machine-Readable Requirements

This directory contains the structured requirement and traceability controls used alongside the human-readable documents under `docs/`.

## Files

| File | Purpose |
|---|---|
| `requirements.yaml` | Canonical manifest that lists the versioned requirement catalog files. |
| `catalog/*.yaml` | Full business, product, functional, technical, and non-functional requirement records, split by domain for maintainability. |
| `traceability.yaml` | Canonical manifest for the traceability catalogs. |
| `traceability/*.yaml` | Acceptance-criteria and story mappings, split for maintainability. |
| `glossary.yaml` | Controlled terms used by validation and future tooling. |

## Stable identifiers

Requirement identifiers must not be reused or silently renumbered. Examples include:

```text
BR-001
PR-004
FR-UPD-001
TR-JIRA-003
NFR-SEC-007
AC-UPD-006
E2E-UPD-006
```

The expected traceability path is:

```text
Business requirement
→ Product requirement
→ Functional/technical/non-functional requirement
→ Acceptance criterion
→ Test
→ GitHub issue
→ Pull request
→ Release evidence
```

## Change rules

When changing a material requirement:

1. Update the applicable human-readable document.
2. Update `requirements.yaml`.
3. Update `traceability.yaml`.
4. Update acceptance criteria and tests.
5. Record the decision or assumption when applicable.
6. Run the documentation validator.

Do not implement a missing requirement by silently adding behavior only in code.
