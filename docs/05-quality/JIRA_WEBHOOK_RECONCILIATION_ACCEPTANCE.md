# Jira webhook and reconciliation software acceptance

Status: software acceptance decision; effective after this reviewed acceptance increment merges.
Date: 2026-10-22
Story: STORY-008 / EPIC-02
Issue: https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7
Plan: [EXEC-019](../04-delivery/exec-plans/EXEC-019-ingestion-assurance-handoff.md)
Requirements: FR-CON-004, FR-CON-005, FR-CON-010, NFR-REL-001, NFR-SEC-006
Criteria: AC-CON-004 and AC-CON-007

## Scope and authority

The implementation controller has delegated authority under DOCUMENT_CONTROL.md
and IMPLEMENTATION_CONTROLLER.md to accept completed software stories after their
requirements, original evidence, independent review and merge gates pass. This
record accepts the complete software contract, subject to the metadata gates below.

The approved master plan permits shared synthetic provider fixtures. This record
covers the webhook/reconciliation software contract. Live Jira credentials and
customer activation remain separately gated. STORY-007's OAuth and comment-read
requirements are outside STORY-008. Reviewed source/import values remain proposals;
this story does not authorize canonical publication or outbound material writes.

## Complete requirement evidence

| Requirement | Executed original behavior |
| --- | --- |
| FR-CON-004 | Jira events pass real raw-body authenticity middleware and durable runtime repositories. Invalid signatures and malformed bodies produce no domain effect. |
| FR-CON-005 | Scheduled reconciliation recovers a deliberately missed update with the persisted cursor/configuration and reports safe connector health. |
| FR-CON-010 | Identical webhook delivery reuses the original receipt/job and produces one observation, assessment and total downstream obligation. An unchanged provider revision preserves its first observation; a later changed input reuses the applicable obligation while each new assessment binds its own new preview. Canonical version counts do not change. |
| NFR-REL-001 | Native tests exercise rollback, lost response, retry, concurrent scans, fixed cohorts, stale fencing, five actual child exits, exhaustion, current-source revocation and quarantined populated restore. Singular durable effects survive replay/restart. |
| NFR-SEC-006 | Actual webhook boundaries validate authenticity and bind event-ID/body-digest replay deduplication. Signed internal tasks separately validate timestamp windows and nonce binding. Current customer/project/source/service scope is rechecked at each use. |

Original tests include `tests/connector-runtime-auth.test.ts`,
`tests/connector-runtime.integration.test.ts` and
`tests/ingestion-reassessment.integration.test.ts`. INT-CON-004 sends identical
webhook bytes/headers twice through the real routes/tasks and asserts total
obligation count, not only the number of active obligations. It also proves exact
reused IDs, immutable first observation, unchanged canonical versions and absence
of private proposal values from the assessment view. Recovery and upgrade probes
are in `scripts/acceptance/ingestion-reassessment.mjs` and
`scripts/acceptance/ingestion-assurance-upgrade.mjs`.

## Immutable source and merge

- Reviewed candidate: `fbad59b97f444ba6b8a69bf8767d8a4e14b950d4`.
- Reviewed tree: `1a6115c0f6100723cd0f31507bd6d0e37e6dbdbc`.
- [PR #112](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/112)
  merged as `58da66bcb4d2db78b5d7f3e1e6adf8ffdaced758`.
- Actual ordered parents: `7f70063d8a689d66042de93b2537402538eb8423`, then
  `fbad59b97f444ba6b8a69bf8767d8a4e14b950d4`. The actual tree exactly equals
  the reviewed tree. Proposed merge d1a66b70 also matched these parents/tree.
- Independent non-author source/coverage review and complete candidate gates are
  recorded in [the review record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/112#issuecomment-6333066106)
  and [the merge gate record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/112#issuecomment-6333410352).

## Executed gates

Exact-candidate [Foundation 39725089999](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39725089999)
and [Documentation 39725089928](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39725089928)
pass. This includes 1,855 units, 200 native tests, 44 browser tests, clean/repeat
migration25, independent exact 85-table inventory, fresh role-absent/API-only
bootstrap and exact 85-table quarantined recovery. Packaged production and both
bundled/external customer profiles pass install, upgrade and restore; distribution
evidence and its complete file manifest pass without approving release signing.

Local corrected validation also passes 1,855 units/107 files, all 27 stricter
privilege-probe regressions, native 200 tests/15 files, exact 85-table/ledger restore
with all 14 proof families and 116 reassessment rows, three browser journeys,
OpenAPI, lint/types/build/architecture/registration/documentation checks. Earlier
failed and interrupted runs remain retained without full-suite passing credit.
The first hosted candidate failed missing-role bootstrap and arbitrary credential
selection; independently reviewed corrections passed all subsequent candidate gates.

Post-merge [Foundation 39727701669](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39727701669)
and [Documentation 39727701670](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/39727701670)
pass on the actual merge. Both native verification and production/customer/
distribution jobs succeeded. Independent complete-story audits find no remaining
behavioral gap in this story's canonical requirements. The delegated controller
records software acceptance, effective only after this documentation increment's
independent exact-candidate review, required checks and verified merge. Those
metadata gates do not replace the already successful implementation gates.

## Compatibility and limits

Migration25 adds one business table (85 total) and three policy controls. All 24
previously released migration bytes are unchanged. API privileges are finite;
worker business-table privileges remain zero; backup reads history. Revert the
application through review while retaining compatible schema/history. Restore to
a separate quarantined database with API/worker CONNECT denied; no application
starts until current permissions and retained claim/lineage state are revalidated.

OD-013/014, disabled public OAuth/live activation/comment reads, reviewed-proposal
import behavior, all five release/security/customer holds and the stopped
Original19/20 research capture remain in force. Issue #7 and STORY-006/007/009 stay
open. This record makes no live Jira, email delivery or release readiness claim.
