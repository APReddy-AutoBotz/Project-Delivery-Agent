# Historical source-authority resolver validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6)
Plan: [EXEC-004](../04-delivery/exec-plans/EXEC-004-canonical-model.md)
Partial requirements: FR-ADM-005, FR-EVD-003, FR-EVD-004, FR-EVD-006,
FR-EVD-007, FR-EVD-009, FR-EVD-010, FR-EVD-012; ADR-009/010.

## Implemented boundary

PR #43 merged as `9c97bf9` after the exact candidate, CI and both original-artifact
reviews passed. Both merged-main workflows also passed. Its
[completion record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/43#issuecomment-5609954850)
supersedes the historical premerge pending statements below. The next repository
integration is documented separately in
[AUTHORITY_PERSISTENCE_VALIDATION.md](AUTHORITY_PERSISTENCE_VALIDATION.md);
it does not change the historical scope claimed by this resolver increment.

`packages/domain/src/source-authority.ts` resolves one explicit historical fact
snapshot under a supplied immutable policy revision. Its strict contract includes
customer/project/fact type, policy recording/effective times, source type and
optional instance selectors, approval requirements, ordered fallback tiers,
per-selector validity and conflict behavior. No default customer authority matrix
is hardcoded. Missing or future policies cannot return a resolved value.

The temporal evaluator considers the complete revision set before authority,
approval or disclosure filters. A newer excluded source head never revives its
predecessor. Equal-time revisions remain ambiguous. Only authorized, valid,
approval-qualified, current SYSTEM_VERIFIED/HUMAN_CONFIRMED candidates can support
a resolved historical value. All equal-tier disagreements retain their values and
dependencies. A conflicting primary tier cannot be bypassed by a fallback.

A selected human fallback also checks higher-authority heads whose validity is
stale or unknown. A disagreement blocks resolution even when no previous conflict
was recorded. Previously recorded unresolved conflicts survive expiry, supersession
and policy changes. Provenance, freshness and conflict remain separate; historical
output is detached and deeply frozen. Reconciliation output is an internal intent
indicator only, with no recipient assignment, queue entry or external dispatch.

The approval contract represents one immutable initial decision with identity and
time. Before that time the state is pending. A rejected decision excludes the
candidate even when policy does not require approval. Mutable latest decisions,
revocation history and approval operations are outside this contract. Evidence
whose later approval history cannot be established must be UNVERIFIABLE until a
reviewed trusted adapter exists; callers cannot rewrite an earlier decision.

## Disclosure and limits

Evidence access is independent of evidence verification. Any RESTRICTED access or
non-VALID verification (REVOKED, DELETED or UNVERIFIABLE) blocks resolution and
redacts dependent versions to permitted version/evidence IDs and a revalidation
marker. Values, source record text, timestamps, origin and decision metadata are
omitted. All required evidence/source descriptors must be unique, complete and
in the same fact scope. Orphan and cross-scope descriptors are rejected.

The input explicitly states completeness; false produces INCOMPLETE with no
resolved value. Oversize or invalid snapshots return a fixed generic error with
no supplied values or nested parser cause. The bounded computation accepts at
most 1,000 versions and 1,000 conflict records, with an aggregate budget of 64,000
conflict evidence references checked before expanded arrays are allocated. Dense
higher-authority disagreements use one union of actual participants. Exceeding
the budget rejects the complete snapshot; it does not silently truncate.
This first component conservatively requires revalidation for any inaccessible
version supplied, including historical rows. A later trusted repository reader
must obtain a complete minimal set of stream heads and conflict dependencies.

This function is an internal computation, not an authorization boundary or a
current application fact service. The existing paginated/redacted history port
cannot supply its complete trusted inputs. Server authorization, active policy
selection, durable policy/assessment storage and fresh access checks before later
delivery remain required. No route, browser journey, model tool, migration,
database grant, connector scope or runtime dependency is added.

## Verification and recovery

The final focused suite passes 69 cases. It checks same-tier agreement and typed
disagreement, instance selection, fallback, policy timing/revision replay,
immutable approvals, unverified origins, late observations, supersession,
equal-time ambiguity, per-selector expiry boundaries, the newly discovered
higher-authority contradiction, retained stale human conflict, multi-evidence
redaction and malformed/incomplete snapshots. Source text is retained as data.

Independent design review identified the first-time contradictory human fallback
gap before implementation; the reviewed plan adds the higher-head check and
separate access/verification states. The design and tracked-plan gates passed.
Full native validation passes 685 tests in 28 files, lint, type checks, seven
builds, architecture/OpenAPI, 38 registered dependencies, documentation validation
and 13 documentation regressions. The first full run passed 682 of 683 cases;
the unchanged startup-disclosure child process produced no output within its
15-second timeout. An unchanged targeted retry passed, then the complete suite
with the two added resource-budget cases passed using one worker. Test assertions
and timeouts were not changed. The original failed log remains part of the record.
Independent pre-review also passed 26 additional edge probes and the 1,000-version
dense-conflict/aggregate-budget checks with no unresolved implementation finding.
Immutable-candidate review, CI and original packaged/artifact checks remain pending
at this premerge snapshot.

Files changed include the new domain evaluator/export and focused test suite,
EXEC-004, this validation record, the document index and the implementation/
publication records. PR42's historical pending gates are reconciled to its
verified merge and successful post-merge workflows. Existing migrations and data
remain unchanged. Recovery is a reviewed application revert to the prior version;
there is no new storage transformation or destructive down-migration.

This is partial evidence for AC-EVD-002/003/004 and AC-ADM-003. Policy storage,
canonical hierarchy, trusted ingestion, complete conflict/reconciliation workflows
and API/browser acceptance remain pending. R0 stays 3/5 and R1 stays 0/33 accepted
stories. Inventory, licence/notice, vulnerability disposition, distributed-layer
review and release signing remain open; no customer activation is approved.
