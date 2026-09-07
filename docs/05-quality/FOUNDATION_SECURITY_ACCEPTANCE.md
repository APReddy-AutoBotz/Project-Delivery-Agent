# Foundation security criterion acceptance

Date: 2026-09-07
Issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5)
Story: STORY-005, R0 / EPIC-01
Authority: delegated implementation controller under DOCUMENT_CONTROL.md
State: Conditional criterion decision; story remains in progress

## Decision and effective gate

Accept the five criteria below only when the portfolio authorization candidate
passes independent non-author review of its exact commit, all required remote
checks, downloaded immutable evidence verification and merge. The PR and Issue #5
must record the actual reviewed/merged commits, checks and evidence before the
criterion checkboxes change. This document alone does not claim those gates passed.

The independent `review_baseline_candidate` audit checked the remaining generic
foundation evidence. Root retains implementation and Git ownership; separate
security/runtime and QA reviewers assess the final immutable candidate. Their
assessments are Codex reviews, not GitHub account approvals. The Product Owner is
currently the repository's sole contributor.

| Criterion | Requirements | Executed evidence supporting the decision |
|---|---|---|
| AC-ADM-001: configuration without code changes | FR-ADM-001/002 | PR #27: `tests/identity-configuration.test.ts`, `scripts/acceptance/customer-identity.mjs`, `customer-identity-host.mjs` and the run-bound remapping receipt; operator metadata and role mapping remove/restore administrative access for the same valid token on an unchanged API image. See OIDC_CONFIGURATION_VALIDATION.md. |
| AC-AUTH-001: production identity and session denial | FR-ADM-001/002, TR-AUTH-001/002/003 | `tests/identity-boundary.test.ts`, `production-config.test.ts`, packaged PKCE/JWKS, logout/replay/invalid-state and disabled development login; PR #28 adds original-token natural expiry, five fixed API denials and protected browser cleanup. See OIDC_EXPIRY_VALIDATION.md. |
| AC-AUTH-002: project/portfolio grants and revocation | FR-ADM-003, NFR-SEC-001, TR-DATA-003 | Existing project HTTP/repository and browser grant/revoke cases plus the new two-portfolio matrix in `tests/database.integration.test.ts`; exact inclusion/exclusion, valid unauthorized writes, unchanged grants/audit and correlated successful audit records. See PORTFOLIO_AUTHORIZATION_VALIDATION.md. |
| AC-SEC-001: encrypted storage and disclosure | NFR-SEC-004/005, TR-DEP-003 | `tests/security.test.ts`, `identity-boundary.test.ts`, `production-config.test.ts`, database ciphertext storage; PR #26's API/log/startup/browser/asset/export disclosure tests and both packaged customer profiles. Wrong/missing keys and altered ciphertext fail closed. See FOUNDATION_SECURITY_VALIDATION.md. |
| AC-SEC-003: bounded outbound guard | FR-APP-010, FR-ADM-009, NFR-SEC-001 | PR #26: `tests/outbound-boundary.test.ts` and `security.test.ts` verify bound server configuration/current-policy readers, zero recording-adapter dispatches while blocked, shadow defaults, revocation and invocation-override denial. The factory/readers are not exposed as model tools. See FOUNDATION_SECURITY_VALIDATION.md. |

AC-MNT-002 is assessed separately for STORY-004. Its existing CI-MNT-002 execution
is now registered against NFR-MNT-004 and TR-TEST-001/002. The foundation workflow
runs build, lint, types, Vitest and implemented Playwright journeys on every PR;
the documentation workflow validates changed documentation/requirements and its
13 negative approval/traceability regressions. Failed steps propagate a failed job;
there is no continue-on-error or alternate success path. The controller requires
passing applicable checks at the exact reviewed head before merge. PR #26's recorded
failed production attempts demonstrate that passing other jobs did not permit merge;
PR #28 supplies verified successful foundation/documentation execution. This
criterion decision has the same pending exact-review/CI/evidence/merge gate as the
five security criteria; it does not accept STORY-004 or AC-MNT-004.

The portfolio matrix runs through the real HTTP server and PostgreSQL using the
guarded synthetic development identity. Separate packaged acceptance supplies real
OIDC evidence; neither substitutes for the other. The full candidate must retain
the 17 packaged groups, both customer database profiles, strict expiry/remapping
receipts and complete disclosure evidence.

## Story and release limits

STORY-005 remains `in_progress`. The Definition of Done requires no critical/high
security finding. Unresolved image scanner matches have not received the necessary
applicability and severity assessment; raw matches do not prove exploitability,
but their unresolved state cannot establish that review condition. No waiver is
inferred from the separate STORY-004 distribution work or this criterion decision.
Perform a bounded package/image/CVE assessment and remediate confirmed high/critical
findings before reassessing story acceptance. Preserve complete private evidence
and publish only the authorized review status.

Customer-specific IdP registration, infrastructure/key policy and activation remain
separate customer gates. They are not prerequisites for these controlled generic
criteria. No actual model-tool registry or live connector exists yet: its future
integration must prove that the factory/readers remain inaccessible and enforce its
own approval, preflight, receipt and reconciliation contracts.

Distribution acceptance remains false. Inventory/adoption, license/notices,
vulnerability dispositions, distributed layers and trusted signing remain open.
After the effective gates, Issue #5 may check these five security criteria and
AC-MNT-002, retaining 11/12 checked criteria with AC-MNT-004 open. Both STORY-004/005
and Issue #5 stay open. R0 remains 3/5 accepted
stories (60%); R1 remains 0/33 (0%).

## Verification record and recovery

The final PR record supplies the candidate, merge, CI run and downloaded evidence
identities after verification. It must distinguish completed criterion evidence
from the unresolved story/release gates above. Prior verified records are linked
from the configuration, expiry and security validation documents.

This increment changes tests and evidence only, with no application policy,
dependency, database migration or connector scope change. Recover with a reviewed
revert and reassess the affected criterion evidence; no database rollback is needed.
