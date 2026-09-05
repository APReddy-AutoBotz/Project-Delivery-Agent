# Document Control

## Baseline information

| Field | Value |
|---|---|
| Product | Project Delivery Assurance Agent |
| Baseline version | 0.1 |
| State | Draft |
| Baseline date | 2026-09-05 |
| Product owner | AP |
| Intended repository | `APReddy-AutoBotz/Project-Delivery-Agent` |
| Intended branch | `docs/baseline-v0.1` |

## Purpose

The documentation baseline is the implementation contract for Codex, developers, reviewers and testers. It prevents product behaviour from being invented during implementation and maintains a visible link from business need to code and tests.

## Versioning

Use semantic document baselines:

- `0.x` for discovery and pre-release baselines
- `1.0` for the first approved commercial baseline
- Minor versions for backward-compatible requirement additions or clarifications
- Major versions for material changes to product boundaries, architecture or commercial deployment

Each document change must be committed to Git and reviewed through a pull request.

## Approval

A document may move to **Approved** only when:

1. Blocking review findings are resolved.
2. Related requirements are represented in `requirements/requirements.yaml`.
3. Conflicts with other documents are resolved.
4. Acceptance criteria exist for Release 1 requirements.
5. Security and autonomy implications are documented.
6. The Product Owner approves the baseline.

## Change history

| Version | Date | Change | Status |
|---:|---|---|---|
| 0.1 | 2026-09-05 | Initial documentation baseline | Draft |

## Review responsibilities

| Review area | Required perspective |
|---|---|
| Business and PMO | PMO leader or experienced delivery manager |
| Product | Product manager and user-experience reviewer |
| Architecture | Enterprise solution and data architect |
| AI | Agentic AI, grounding and evaluation specialist |
| Security | Security and privacy reviewer |
| Delivery | Engineering and QA reviewer |
| Commercial | Licensing, deployment and support reviewer |

A single person may cover more than one perspective during early product development, but the review outcome must still address each area.
