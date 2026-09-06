# Document Control

## Baseline information

| Field | Value |
|---|---|
| Product | Project Delivery Assurance Agent |
| Baseline version | 0.1 |
| State | Approved candidate; effective after Issue #1 review PR merge |
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
6. The Product Owner or explicitly delegated implementation controller approves the baseline under the gate below.

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

## Delegated approval and merge gate

On 2026-09-06 the Product Owner instructed the implementation controller to apply
the five reviewed corrections and start implementation, following the supplied
autonomous controller authorization. This delegates routine baseline and ADR
approval to the root controller after specialist review and validation. It does
not delegate material commercial/legal choices, unavailable credentials, or
irreversible effects outside the repository/development environment.

Approval is conditional on the corrected candidate: no unresolved P0 or blocking
R1 P1 finding, direct R1 Must acceptance coverage, registered planned tests,
coherent story scope, accepted implementation ADRs, a separate non-author review
of the exact candidate SHA and passing checks for that SHA. An approved document
is an implementation contract, not evidence that the product is implemented.
Issue #1 stays open until its review PR is merged and every gate item is evidenced.
The controller may prepare independent local work during an access outage, but
must not represent remote approval, review, checks or merge as complete.

## 2026-09-06 approval record

The controller accepts the corrected R0/R1 implementation contract under the
Product Owner delegation. This candidate's approval becomes effective only after
its independent review, passing remote checks and review PR merge. R1 structured
requirements are approved as contracts; future-release requirements remain draft.
Commercial/legal documents remain planning positions. See ASTRA_BASELINE_REVIEW
and the linked PR for findings, exact review SHA and validation evidence.
