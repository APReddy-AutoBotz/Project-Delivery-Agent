# Astra Documentation Review Prompt

Use this prompt after the documentation baseline is pushed to GitHub.

```text
Act as an independent enterprise product review board.

Review the complete Project Delivery Assurance Agent documentation baseline.
Do not rewrite the product from scratch and do not implement code.

Use specialist subagents for:

1. PMO and project-delivery operations
2. Product and user experience
3. Enterprise solution architecture
4. Data, integrations and source-of-truth design
5. Agentic AI, grounding, evaluations and human oversight
6. Security, privacy and customer-hosted deployment
7. Open-source licensing and long-term maintainability
8. QA, failure recovery and production readiness
9. Commercial packaging and pilot viability

Review for:

- Contradictions between BRD, PRD, FRD, TRD, NFR and architecture
- Missing business or functional requirements
- Requirements without acceptance criteria
- Acceptance criteria without tests
- Ambiguous source authority
- Unsafe agent autonomy
- Unsupported leadership claims
- Missing failure and recovery paths
- Customer-hosting gaps
- Vendor lock-in
- Unnecessary technical complexity
- Open-source licensing risks
- Missing audit and approval controls
- Weak differentiation
- Release 1 scope that should be removed
- Long-term capabilities that are missing
- Requirements that may create employee-surveillance risk
- Anything that prevents Codex from implementing predictably

Produce only:

docs/07-research/ASTRA_BASELINE_REVIEW.md

Classify every finding as P0, P1, P2 or P3.

For each finding include:

- Finding ID
- Related requirement or document
- Problem
- Business or technical impact
- Recommended correction
- Whether it blocks Release 1
- Suggested owner

Add these final sections:

- Cross-document consistency score
- Release 1 readiness score
- Top 10 blocking actions
- Requirements requiring Product Owner decision
- Architecture decisions requiring confirmation
- Documents that are sufficiently complete and should not be rewritten

Do not directly change approved requirements or architecture.
Do not copy external repository content.
```
