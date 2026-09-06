# Public publication and implementation record

Date: 2026-09-06. Product Owner approved public publication in the implementation
task. This record reports observed Git/GitHub state and keeps partial delivery
separate from story acceptance.

## Repository and review

The initial workspace contained a verified Git bundle/ZIP without a checkout.
The restored bundle head was `0eb6116`; live main was reconciled at `affdbae`.
No existing user changes were overwritten. Public origin remains
`APReddy-AutoBotz/Project-Delivery-Agent`; repository visibility was not changed.

Specialist agents `baseline_product` and `baseline_quality` covered product/PMO/
commercial and requirements/QA/licensing. The controller covered architecture,
AI and security. `review_baseline_candidate` independently reviewed the exact
baseline, plan and foundation candidates and their fixes. This is agent review,
not a separate human GitHub approval.

The review resolved baseline scope/traceability contradictions, human-only
approval, security dependency order, orthogonal fact state, uncertain-write and
restore behavior. Foundation review/regressions resolved malformed outbound
policy, truncated GCM tags, database/Docker target inheritance, secret-safe errors,
retained protected UI data and reads after final-grant revocation. No blocking
P0/P1/P2 finding remains within the reviewed partial foundation scope.

## Verified PRs, commits and checks

| PR | Branch | Exact reviewed head | Verified merge | Passing PR workflow |
|---|---|---|---|---|
| [#2](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/2) | `docs/astra-baseline-review-v0.1` | `5f37c657293e41627b4e8fe1caf93c52b50bce17` | `70378ed816958ef24c0576e3c1a4dd45b73d9e34` | [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34024786300) |
| [#3](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/3) | `plan/release-1-master-plan` | `3a7ead53dd15165b81250eac9abf0d17d9ec1fef` | `e153d1bd4c3fe52baafef65e5bb58246123ca614` | [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34024861372) |
| [#4](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/4) | `feature/platform-foundation` | `6cec7f05ab5f6d4b14b4c24460985791c5863160` | `e29b9842b9d4d8db8ec32bf91409a71e869e160a` | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025145071), [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025145004) |

Logical author commits are `26cadc6`, `5f37c65`, `3a7ead5`, `aca4a2e`, and
`6cec7f0`. The follow-up `docs/foundation-publication-evidence` branch reconciles
status and traceability after these observed merges; its own PR/check record is
available in GitHub. Merged source branches are retained for review provenance.

Automatic checks on the merged foundation `e29b984` also passed:
[foundation validation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025283948)
and [documentation validation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34025283952).

## Published backlog

Issue [#1](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/1) is closed with completed baseline criteria and
review/check evidence. All implementation issues remain open.

| Release milestone | Link |
|---|---|
| R0 – Platform Foundation | [Milestone 1](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/milestone/1) |
| R1 – Closed-Loop Delivery Assurance | [Milestone 2](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/milestone/2) |
| R2 – Microsoft Enterprise Collaboration | [Milestone 3](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/milestone/3) |
| R3 – Portfolio Intelligence | [Milestone 4](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/milestone/4) |

| Epic | Release | Issue |
|---|---|---|
| EPIC-01 | R0 | [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5) |
| EPIC-03 | R1 | [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6) |
| EPIC-02 | R1 | [#7](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7) |
| EPIC-04 | R1 | [#8](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/8) |
| EPIC-05 | R1 | [#9](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/9) |
| EPIC-06 | R1 | [#10](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/10) |
| EPIC-07 | R1 | [#11](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/11) |
| EPIC-08 | R1 | [#12](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/12) |
| EPIC-09 | R1 | [#13](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/13) |
| EPIC-10 | R1 | [#14](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/14) |

All 38 stories now link to their published issue. STORY-001..005 link to the
partial foundation PR/evidence and remain in progress. R0 accepted 0/5 (0%);
R1 accepted 0/33 (0%). This fixed denominator does not treat a merged partial PR
as a finished story.

## Implementation, validation and limits

Files changed include root workspace/CI, `apps/web`, `apps/api`, `apps/worker`,
`packages/domain`, `packages/platform`, `packages/data`, tests, local scripts,
generated OpenAPI, adoption inventory and requirement/governance/evidence docs.
PR diffs are the exact file inventory.

The foundation provides scoped synthetic sign-in/projects, access administration,
audit, worker health, encrypted credential primitives and default outbound denial.
Local and Ubuntu CI results: 13 unit/security tests, seven database/API tests and
five browser workflows passed (25 total); clean/repeat migration, restore, six
workspace builds, lint/typecheck, frozen install and dependency audit passed.
Documentation validation covered 245 requirements, 91 criteria, 38 stories and
135 specifications; all 13 validator tests passed. Two catalog test specifications
have implementation evidence and 133 remain planned. No AI evaluation or live
customer connector test is claimed.

Approved packages use exact versions and permissive license evidence. No external
repository code was copied. Patched `deepmerge-ts` 8.0.0 and `mysql2` 3.23.1 tooling
overrides resolved observed advisories; full distribution SBOM/notices and image
scans remain open. See FOUNDATION_VALIDATION.md and DEPENDENCIES.json.

No customer connector scope, production database or outbound customer action was
enabled. Revert code through review; restore the synthetic backup into a separate
database with its separately retained encryption key and outbound disabled. The
runbook and executed recovery evidence remain in LOCAL_DEVELOPMENT.md and
FOUNDATION_VALIDATION.md.

Publication authorization is resolved. Automatic approval review initially
rejected public export, then allowed the branches/PRs after explicit user approval.
A separate backlog rejection was resolved by verifying the user's original
milestone/issue instructions and the identical already-public draft blob
`206e7088586acdb1f5a0e854a831bdfbbca69083`; the reviewed retry was approved.

The next coherent task is the remaining customer-hosted foundation under
[Issue #5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5): required component stack and contract evidence,
pgvector availability, application containers/external DB/TLS, distribution
license and scan gates, and production identity/secret configuration. Customer
IdP registration/policy is needed for customer-specific interoperability; a
controlled synthetic IdP can support development meanwhile. Keep real sources
disabled until this foundation gate is satisfied. Then proceed to the canonical
model/evidence ledger in [Issue #6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
