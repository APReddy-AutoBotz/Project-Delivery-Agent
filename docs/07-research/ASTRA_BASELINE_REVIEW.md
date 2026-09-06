# Astra Baseline Review

Review date: 2026-09-06
Input: GitHub main `affdbaedadac9f16b49c00c37b4117552bad2902`
Gate: [Issue #1](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/1)
Scope: documentation implementation contract, not a production security certification.

## Recommendation

Proceed to EPIC-01 after the corrected candidate receives a separate non-author
review, its remote checks pass and this review PR is merged. No P0 finding was
identified. The blocking P1 design/traceability findings below have corrections in
the candidate. Product tests remain planned and the product is not release-ready.
Implementation completion remains 0 of 5 R0 stories and 0 of 33 R1 stories at this gate.

## Repository and validation evidence

The workspace initially held an older Git bundle, ZIP and checksum manifest.
Both SHA256 values matched. Restored bundle HEAD was `0eb61161fb8699050ee1ef62bcec51e7a315cd32`;
GitHub main had newer split requirements, acceptance and story catalogs. The
review branch was created from fetched live main, with no user changes present.
The repository is public, as reported by GitHub; no visibility change is made.

Saved `gh` authentication failed with HTTP 401. The GitHub connector accessed
Issue #1, and existing Windows Git credentials successfully authenticated a
noninteractive push dry-run. GitHub operations can therefore proceed without a
new credential or modifying stored authentication. No secret is recorded here.

Initial system-Python validation exited 1 because PyYAML was unavailable. With
the existing pinned PyYAML 6.0.2 installed locally, unchanged baseline validation
exited 0: `Validated 245 requirements, 67 acceptance criteria and 38 stories.`
It warned that 87 R1 Must requirements lacked direct acceptance criteria.

Corrected catalogs contain 245 requirements, 91 acceptance criteria, 38 stories
and 135 planned test specifications, with no R1 Must direct-coverage gap. The
validator now checks approved status, source files, ancestry, test references,
bidirectional ownership and each story's own requirement coverage. Thirteen
negative/positive validator regression tests pass. Remote review/check evidence
must be recorded on the PR for its final SHA, rather than inferred from this text.

## Specialist review assignments

Three parallel read-only assignments covered the nine requested perspectives:

| Assignment | Perspectives | Result |
|---|---|---|
| baseline_product | A PMO, B product/personas/UX, I commercial/pilot | Owner-response permissions and R1 scope contradictions; no blocking commercial/legal choice |
| baseline_architecture | D solution/domain/data/integrations, E AI/grounding/oversight, F security/privacy/deployment | Satisfaction, retry, unknown-outcome, model approval and restore-replay corrections |
| baseline_quality | C requirements/traceability, G QA/evaluation/recovery, H licensing/maintainability | Acceptance gaps, unowned criteria, validator and recovery inventory corrections |

Root owns all edits and Git operations. A separate non-author reviewer reviews
the immutable final candidate; root self-review is additional evidence only.

## Findings and dispositions

P0 blocks implementation; P1 must be resolved for R1; P2 may follow the first
vertical slice; P3 is a future improvement. The blocking column describes impact
before correction. Each resolution is a design/contract resolution; its product
behavior must still pass the linked acceptance tests during implementation.

| ID | Severity | Documents / requirements | Problem and impact | Correction | R1 blocking | Owner | Resolution / disposition |
|---|---|---|---|---|---|---|---|
| ASTRA-001 | P1 | Controller; DOCUMENT_CONTROL; NFR-MNT-004 | Routine authorization and mandatory PO baseline approval are ambiguous, risking a stall or unsupported approval claim. | Record explicit PO delegation and evidence gates. | Yes | Root / PO | Resolved in DOCUMENT_CONTROL and DECISION_LOG; review/check/merge remain mandatory. |
| ASTRA-002 | P1 | Roadmap; dependency map; NFR-SEC-001/004; TR-AUTH-001; STORY-005 | Security described as a late hardening epic leaves no enforced foundation gate before real data. | Require OIDC, scope, encrypted secrets and denial tests in EPIC-01. | Yes | Security / engineering | Resolved in ADR-010, delivery plan and AC-AUTH-001/002, AC-SEC-001. |
| ASTRA-003 | P1 | FR-EVD-003; DATA_MODEL; AGENT_BEHAVIOR; TR-AI-003 | One enum loses origin or hides simultaneous staleness/conflict. | Independent provenance, freshness and conflict, with deterministic display and frozen report assessment. | Yes | Domain / AI | Resolved in ADR-009, requirements, claim contract, AC-EVD-002 and GOLDEN-013. |
| ASTRA-004 | P2 | Controller; EXEC-001 | Assumes checkout and valid CLI auth; supplied artifacts are older than live main. | Verify hashes, restore safely, fetch live refs and try installed connector/credentials; retain blocked remote gates if inaccessible. | No | Delivery | Resolved in controller and actual bootstrap evidence. |
| ASTRA-005 | P2 | Controller; CONTRIBUTING; NFR-MNT-004 | Self-review is described as independent and is not tied to a final commit. | Separate non-author reviewer, exact base/head, re-review changed candidate and expected-head merge. | No | QA / delivery | Resolved in controller and contribution contract; enforce on this PR. |
| ASTRA-006 | P1 | WORKFLOW_ARCHITECTURE; FR-UPD-010; AC-UPD-006 | Information satisfaction waits for external-write receipt, causing reminders after a valid update. | Transactionally satisfy confirmed facts and suppress reminders; track optional write independently. | Yes | Engagement | Resolved; FAIL-027 covers delayed/failed write and partial responses. |
| ASTRA-007 | P1 | APPROVAL_AND_WRITEBACK; FR-APP-007/008; FR-WRB-005/008 | Retry bypasses preflight; expiry, access, source and mode may change during backoff. | Retry through every current preflight check. | Yes | Controlled action | Resolved in lifecycle, AC-WRB-002 and FAIL-025. |
| ASTRA-008 | P1 | INTEGRATION_ARCHITECTURE; FR-WRB-004/007/008; NFR-REL-001 | Local idempotency does not identify a remote appended comment after lost acknowledgement. | Stable approved marker/digest, persisted attempt start, atomic claim, exact-target reconciliation and manual recovery for uncertainty. | Yes | Connectors | Resolved in comment contract and AC-WRB-002; remote exactly-once is explicitly not claimed. |
| ASTRA-009 | P1 | AGENT_BEHAVIOR; ADR-007; FR-APP-004/005; TR-AI-002 | Model-callable approval could impersonate human consent through a PM session. | Remove approval from model registry and bind human decision to immutable proposal revision. | Yes | AI / security | Resolved in tool contract, AC-AI-001 and GOLDEN-014. |
| ASTRA-010 | P1 | DEPLOYMENT_AND_OPERATIONS; TR-DEP-004; NFR-REL-001 | Restoring an old backup can replay a Jira action whose receipt occurred after backup. | Start outbound-disabled, reconcile remote markers, suppress completed actions and review uncertain cases. | Yes | Operations | Resolved in restore quarantine, AC-DEP-003 and FAIL-026. |
| ASTRA-011 | P1 | RBAC_AND_PERMISSIONS; FR-UPD-004/006/008 | PM/lead owner has read-only response permission and cannot satisfy their assigned request. | Request-scoped submit/correct capability for authorized owner/delegate, independent of broad role. | Yes | Product / security | Resolved in permission matrix and AC-UPD-009. |
| ASTRA-012 | P1 | PRD; FRD; scope; roadmap; OD-003/006/007/008 | R1 differs on write fields, Q&A scope, PowerPoint, calendar and contradiction rules. | Comment-only writes, one-project Q&A, required editable PPT, weekday/quiet-hour cadence and two deterministic contradictions; advanced features deferred. | Yes | Product / architecture | Resolved across catalogs, prose, use cases, golden scenarios and ADR-010. |
| ASTRA-013 | P1 | Requirements/traceability; all R1 Must; STORY-001..038 | 87 Must requirements lack direct criteria; ten P0 criteria have no story owner; recovery tests are outside structured gates. | Add coherent behavioral criteria, story ownership and explicit planned-test inventory including all 28 recovery scenarios. | Yes | BA / QA | Resolved: 91 criteria, 135 test specifications, zero direct Must gaps. No product test claimed executed. |
| ASTRA-014 | P1 | validate_documentation.py; NFR-MNT-004 | Validator allows approved coverage gaps and ignores missing tests, source files and mismatched story coverage. | Enforce approval-sensitive checks and regression cases. | Yes | QA / tooling | Resolved with 13 validator tests and CI invocation. |
| ASTRA-015 | P2 | AC-UPD-005; GOLDEN-005/006/011 | Ambiguous reply maps to wrong scenario; later-release scenario can distort R1 denominator. | Map GOLDEN-006, register eligible tests and exclude later GOLDEN-011. | No | AI QA | Resolved in traceability and test strategy. |
| ASTRA-016 | P2 | BR-001/002/003/012; PR-015; pilot metrics | Pilot value lacks explicit measurement ownership/windows/denominators. | Define aggregate calculation fixtures and customer-agreed observation evidence. | No | Product / PMO | Resolved in AC-PIL-001 and pilot metrics; commercial improvement remains unproven until a pilot. |

## Architecture, scope and open-source decisions

Retain TypeScript, React/Vite, NestJS, PostgreSQL, repository interfaces, Graphile
Worker and bounded provider-neutral AI. No microservices, Redis, Kubernetes,
general automation platform or agent framework is justified for R1. pgvector is
optional until semantic retrieval is needed. Approve the existing ADR direction
under the recorded delegation and add ADR-009/010 for the corrected contracts.

No external repository content was copied. Existing license policy is sufficient;
runtime adoption still requires exact version/license/maintenance evidence and
notices. The development validator uses the already pinned PyYAML. Approved
architecture choices do not imply an unverified package version is approved.

## Residual risks and readiness

- These are planned contracts, not working application features or production assurance.
- Jira comment preflight read plus POST is not an atomic field update. R1 comments disclose their as-of base; field writes are deferred pending a stronger connector contract.
- Live OIDC/Jira/AI/email credentials and customer policy are required for opt-in integration validation. Synthetic fixtures permit foundation development.
- Actual customer pricing, legal terms and pilot success remain commercial evidence gates.
- Repository branch protection and required checks must be inspected remotely; a missing platform protection rule never waives the controller's validation gate.

Consistency assessment: the identified material contradictions have explicit
corrections. Implementation readiness: conditional on the final review/check/merge
gate. Product release readiness: not met. Numeric readiness scores would imply
unmeasured confidence and are intentionally not used.

## Next coherent task

Merge the reviewed baseline, complete Issue #1 with evidence, merge the R0/R1
master plan and grouped implementation issues, then implement EPIC-01 in a focused
branch with meaningful API, database, identity and browser validation.

## Separate candidate review dispositions

Non-author `review_baseline_candidate` reviewed base affdbae through candidate
26cadc6bb8daf27a7b4b1bf777335895b41a85c7 and requested three corrections:

1. Foundation outbound guard ownership: added AC-SEC-003 to STORY-005; STORY-035 verifies/extends that existing control.
2. Missing eligible golden tests: registered GOLDEN-009 and GOLDEN-012 against source-change and role-advice criteria.
3. Mandatory baseline files: restored checks and added a negative regression case.

All three were corrected. The separate reviewer approved exact candidate
`5f37c657293e41627b4e8fe1caf93c52b50bce17` before merge. Final totals are 245 requirements, 91 criteria,
38 stories and 135 planned test specifications; 13 validator tests pass.
The user approved public publication on 2026-09-06. [PR #2](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/2)
passed its remote checks and merged as `70378ed816958ef24c0576e3c1a4dd45b73d9e34`;
Issue #1 is closed. PUBLICATION_RECORD.md records subsequent plan/foundation
merges. The earlier automatic publication block is resolved.
