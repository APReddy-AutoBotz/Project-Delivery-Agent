# Project evidence workflow validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6).
Plan: [EXEC-006](../04-delivery/exec-plans/EXEC-006-project-evidence-workflow.md).
Status: Implemented candidate; final validation, independent review and CI pending.
Target: AC-EVD-001/002/003 and AC-ADM-003, STORY-011 and part of STORY-012.
Requirements: FR-EVD-001/002/003/004/005/006/007/009/010/012, FR-ADM-005,
NFR-SEC-001/004 and TR-API-001. No new criterion or story is accepted by this record.

## User and administrator workflow

Open an authorized project and its **Project evidence** section. Choose a literal
fact type from the paged catalogue, or enter a new key to open its empty history.
Keys belong to the project; they do not link or update a canonical child or date.
History retains each original typed value, statement, source/evidence identifiers,
confirmer and timestamps. History paging freezes its upper revision; the fact
catalogue pages live metadata. Neither page supplies the assessment's inputs.

A project manager, portfolio manager or PMO administrator with a matching current
scope can enter a text, number, boolean, date or empty statement. Review the exact
value, original statement and UTC times, then confirm. Attribution and observation
time come from the server. On an uncertain response, retry the same reviewed
request. A conflict requires a fresh review. Leaving the project or losing access
clears private drafts. A transient failure hides and disables them while keeping
the reviewed request in memory for a safe retry.

Statements initially remain private to their confirmer. A PMO administrator can
choose **Manage source readers**, inspect the saved revision, and review an exact
replacement of the state and reader subject IDs. Readers also need current project
permission. An uncertain access-save response requires closing, reloading and
comparing the saved state before another explicit replacement.

PMO administrators can configure an explicit authority rule. The form replaces the
whole rule with one tier covering human-statement sources, including approval,
validity and conflict behavior; it does not preserve undisplayed tiers. The active
rule display retains all configured tiers and separates published versus active
revisions. Human confirmation cannot supply APPROVED status. No default authority
is installed. Disabling or scheduling a rule changes only subsequent assessments
at the applicable time; earlier history and saved results remain immutable.

Choose **Capture new assessment** to use the server's current clock, complete
bounded history and applicable policy. The saved result displays provenance,
freshness, conflict, authority reasons, expiry and the original fact target/time.
Every saved result is historical, including CURRENT-at-capture. An elapsed validity
warning never rewrites those saved dimensions. A copied link contains only IDs and
requires current authentication and scope; current source restrictions withhold
copied results. The reconciliation signal does not create a PM request.

## Verification boundaries

The nine strict REST operations are in the generated OpenAPI contract. Inputs
reject spoofed provenance/actors/clocks; outputs discriminate available content
from redaction. A currently authorized empty fact returns an empty page, while
denied or unknown projects return the same fixed 404. Capabilities require a
matching identity role and current project/portfolio grant. No operational role
gains implicit evidence access. OIDC remapping and all replay paths reauthorize.

`tests/project-evidence.integration.test.ts` exercises real HTTP/PostgreSQL:
typed history and paging, changed values, current/revoked scopes, source states,
immutable captures, policy changes, expiry/conflict, concurrency and role remapping.
`tests/evidence-api-errors.test.ts`, `tests/evidence-responses.test.ts` and the
complete API contract suite verify bounded shapes and sanitized failure output.
`tests/e2e/project-evidence.spec.ts` exercises four real browser journeys for
review/retry, authority and historical links, disclosure/session loss and uncertain
source-access replacement. Synthetic screenshots accompany successful CI evidence.

The packaged customer helper uses real TLS/OIDC and the shipped API in both
bundled and external PostgreSQL profiles. It retains bounded original response
projections and screenshot hashes, reopens the saved link after application
recreation, then checks revocation in the same session. All mutations precede the
backup projection. Quarantined restore compares the complete 31-table projection;
it does not enable runtime access on the restored target. Host receipt validation
has no package dependency before the images are built.

Native development history: initial absent canonical tables in the preserved
local database caused setup failures. Its synthetic operator grant fixture had
run; no schema reset/migration or data deletion was applied there. Browser testing
then used a separate migrated synthetic database. Failed runs remain private.
The first unconstrained unit run had two existing process-startup timeouts under
concurrent load; final validation uses bounded workers without relaxing deadlines.

## Impact and remaining scope

No database migration, table, grant or connector scope is added. All four existing
migration files remain unchanged. The web shares domain types through an erased
workspace import, enforced by the architecture check; no external runtime version
changes. No AI call, external write or real-data activation is introduced.

AC-EVD-004/GOLDEN-003 canonical milestone/work-item reconciliation, full STORY-012,
trusted ingestion, PM engagement, leadership Q&A and reporting remain pending.
The five distribution/customer release gates remain open. Recovery is a compatible
application revert preserving additive evidence or the existing encrypted backup
restore into a fresh quarantined target.
