# Implementation Status

Updated: 2026-09-06

## Published and merged work

The Product Owner explicitly approved public publication on 2026-09-06.
The independently reviewed baseline, master plan and partial foundation merged
in dependency order after their GitHub Actions passed:

| Increment | Pull request | Reviewed candidate | Merge commit |
|---|---|---|---|
| Corrected baseline | [#2](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/2) | `5f37c65` | `70378ed` |
| Implementation master plan | [#3](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/3) | `3a7ead5` | `e153d1b` |
| Synthetic foundation | [#4](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/4) | `6cec7f0` | `e29b984` |

[Issue #1](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/1) is closed with evidence. Four milestones and ten
implementation issues exist; the full mapping is in
[PUBLICATION_RECORD.md](PUBLICATION_RECORD.md). No implementation issue is closed.

## Implemented and verified foundation

- React/Vite web, NestJS API, Graphile Worker and PostgreSQL schema/migrations/seed.
- OIDC validation, synthetic-only local login, scoped access grants/revocation,
  encrypted credential primitives and append-only audit protection.
- Protected browser data disappears after denial; final-grant revocation returns
  an explicit repository denial; current-token expiry clears the session/cache.
- Local and [remote foundation validation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025145071)
  passed: 13 unit/security/health tests, seven real database/API tests, five
  Chromium workflows, clean/repeat migration, complete restore, all six workspace
  builds, lint, typecheck and dependency audit.
- Documentation validation: 245 requirements, 91 criteria, 38 stories and 135
  test specifications; no direct R1 Must coverage gap; 13 validator tests passed.
- Two registered identity test specifications have implementation evidence;
  133 remain planned. The 25 executed application tests are a separate count.
- The independent reviewer approved exact `6cec7f0` for this partial synthetic
  increment. Product release and customer deployment have not been accepted.

## Accepted implementation completion

| Release | Accepted merged stories | Total approved stories | Completion |
|---|---:|---:|---:|
| R0 | 0 | 5 | 0% |
| R1 | 0 | 33 | 0% |

All five R0 stories are in progress. Merge of a partial implementation does not
close a complete story contract. [Issue #5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5) remains open:

| Story | Remaining completion work |
|---|---|
| STORY-001 | Candidate adds Tailwind/component layer; registered architecture/OpenAPI boundary evidence remains |
| STORY-002 | Candidate verifies pgvector and restricted migrations; register merged evidence before acceptance |
| STORY-003 | Candidate adds controlled OCI/TLS/external-DB acceptance; supported customer deployment and operations artifact remains |
| STORY-004 | Enforced license/inventory/notices gates, SBOM and distribution-image scans |
| STORY-005 | Candidate verifies controlled OIDC/browser/API scopes and file secrets; remaining negative cases, complete disclosure checks and customer-specific validation remain |

## Customer-hosted boundary candidate

EXEC-003 adds native Tailwind controls, file-based production secrets, shared
verified database TLS, configured OIDC scopes/logout, separate application images
and isolated Keycloak acceptance. The precommit run passed all eight production
check groups after initialization/repeat migration of both TLS databases. Native
validation passes 20 unit/security/policy tests, seven database/API tests and seven
browser workflows, plus migration/recovery, build, lint, typecheck and audit.

The direct dependency register is now enforced and physical runtime packaging
rejects CLI/Studio/TypeScript build dependencies. Complete notices, transitive/OS
license review, SBOM and final image vulnerability gates remain open. No additional
story is accepted. See [PRODUCTION_BOUNDARY_VALIDATION.md](../05-quality/PRODUCTION_BOUNDARY_VALIDATION.md)
for the exact scope and artifact contract. Candidate publication/review/checks are
still pending; earlier merged work above remains the accepted published state.

## Gates and next coherent increment

Publication, baseline approval and the master-plan merge gates are complete.
The next coherent task is the remaining EPIC-01 customer-hosted foundation:
complete the required web stack, application containers, database/pgvector
availability, production configuration and CI distribution gates, then validate
the identity/deployment boundary with a controlled IdP before any real source is
enabled. Customer-specific interoperability needs the customer's IdP registration
and policy. Synthetic fixtures remain available without those credentials.

Follow [EXEC-003](exec-plans/EXEC-003-customer-hosted-foundation.md). Real Jira/AI/email,
source writes and reports remain unimplemented. No new connector scopes were
requested or enabled. Once the foundation gate is accepted, proceed to the
canonical model and evidence ledger in [Issue #6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
