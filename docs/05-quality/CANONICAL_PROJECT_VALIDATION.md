# Canonical project creation and detail validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6)
Plan: [EXEC-005](../04-delivery/exec-plans/EXEC-005-canonical-project-workflow.md)
Story/criterion/test: STORY-010 / AC-MOD-001 / INT-MOD-001.
Requirements: FR-MOD-001/002/004/005/007; adjacent FR-MOD-003/006,
NFR-SEC-001/004 and TR-API-001. Authority regression: FR-EVD-003/010.
Status: Accepted after independently reviewed PR #45 merge; other evidence/release gates remain open.

## Verified completion

[PR #45](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/45)
merged candidate `1bbc01e08fcaf0d9b9754ad31f8f934694807162` as
`ea65e37954f728b1e9a4a018cc944ad08019810a` at 2026-09-11T16:39:05Z, with tree
`73101af0e4ad2bca9422c396bb44ba7911d671e3`. The
[public gate record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/45#issuecomment-5637625710) binds independent immutable source review,
source/build audit, both original-artifact reviews and all five root readers.
[Foundation 34617274839](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34617274839)
and [Documentation 34617274810](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34617274810)
passed for that candidate: 753 unit tests, 77 database/API cases, 14 browser cases,
seven package builds, 19 packaged groups, both customer profiles, three populated
upgrade prefixes and 31-table recovery. All 48 reviewed raw Git files and the
ordered merge parents were verified after merge.

Under delegated controller authority, AC-MOD-001 and STORY-010 are accepted.
The API/browser create and retrieve hierarchy, responsibilities, dates, reported
health and scoped manual source mappings. Missing data remains unknown and mappings
remain unverified configuration. Issue #6 stays open for its five other criteria.
Accepted stories: R0 3/5 (60%); R1 1/33 (3.0%). This is story acceptance, not customer
release approval. The five inventory/licensing/vulnerability/layer/signing release
gates remain open; current scans have 832 High/Critical observations, 112 validated
dispositions and 720 unresolved occurrences. Four added libxml2 observations and
other reviewed feed metadata differences grant no new disposition.

The first candidate's failed distribution collection is retained. The replacement
accepts only two exact reviewed advisory descriptions and passed fresh CI/review.
No runtime dependency or connector scope changed. The additive fourth migration
preserves all three released migrations. Recovery retains additive history during
a compatible application revert or uses the matching reviewed release to restore
into a fresh quarantined target. Next is the scoped fact-history and historical-
assessment API/UI journey; no real-data or outbound activation is implied.


## User workflow

Sign in with a configured PMO Administrator or Portfolio Manager identity and a
matching current portfolio grant. In Projects, choose **Create project**, select
the existing portfolio and optionally create/select a programme. Enter the code,
name, description and reported status. Add responsibilities, sprints, milestones,
work items, required work links, risks/assumptions/issues/dependencies/decisions/actions
and source references as needed. Optional baseline, planned, forecast and actual
start/end dates remain separate; blank dates mean unknown. Child references link
only records entered for this project. Responsibilities label people and confer no
application permission.

Choose **Review project** to inspect the entered details, then **Create project**.
The saved project opens with its persisted delivery structure. An uncertain retry
retains the same request key. Signing out or losing the session removes the draft
and protected cache. Local synthetic setup provides a PMO administrator persona
with an explicit portfolio grant. Customer installations use configured OIDC roles
and grants; production development login remains unavailable.

Reported status is unassessed. Source references are manually supplied configuration
with credential-free HTTPS links; this workflow retrieves no source content and
does not claim verification, freshness or source authority. Creation is immutable.
Updating/reparenting saved records, ingestion, reconciliation, approvals and evidence
display follow in subsequent EXEC-004 workflows.

## Authorization and contracts

GET `/api/project-setup`, POST `/api/portfolios/:id/programmes` and POST
`/api/projects` require current matching PMO/portfolio-manager portfolio authority.
A project-only grant cannot create a sibling project. GET `/api/projects/:id/canonical`
also permits current matching leadership and project-manager grants on that project
or portfolio. Operational and contributor roles confer no canonical access.
External mappings are withheld completely from ordinary project readers; only a
current matching PMO/portfolio-manager scope can read them. Authorization is checked
before idempotency replay, and responses are rebuilt from currently permitted data.

The server owns UUIDs, actor, timestamps, typed receipt and creation revision.
Strict schemas reject unknown fields, invalid Gregorian dates, reversed pairs,
duplicate references and foreign child references. Limits are 50 per collection,
200 total child rows, 100 portfolios/programmes per setup list with truncation flags,
and the existing 100 KB request parser. Generated OpenAPI and success-response
validation cover all four new routes. Existing six-field project summaries and
legacy IDs remain compatible; unconfigured details explicitly return unknown dates.

## Database and recovery

The additive fourth migration creates ten tables: Programme, CanonicalProject,
ProjectResponsibility, Sprint, Milestone, WorkItem, RequiredWorkItem, RaidItem,
CanonicalSourceMapping and CanonicalCreationReceipt. Composite foreign keys enforce
customer/project ownership and same-portfolio programme membership. Creation inserts
the aggregate, typed receipt and minimal audit in one transaction. A one-time seal
checks declared collection counts; child insertion locks the parent and rejects
post-seal changes. Deferred guards reject actual COMMIT without a complete receipt
and seal. Existing canonical base-project content and all new history are immutable.

The actual API database role receives SELECT/INSERT plus column-only UPDATE(sealed)
on CanonicalProject. The worker receives no new business privileges; backup receives
SELECT. Acceptance inspects every table/column privilege and grant option and tests
actual API and worker connections. Owner-role mutation probes verify triggers as
well as runtime denials. No connector permission or runtime dependency is added.

All three released migration files remain unchanged. The new migration also caches
two immutable authority-result JSON arrays once during integrity validation. The
independently reviewed equivalent function retains every predicate, exception,
10-second transaction limit and both seal/delivery validation calls. The original
1,000-version boundary failure was diagnosed as P2028; a rollback-only comparison
matched 37 saved fixtures and reduced one local predicate measurement from 5,948 to
1,484 ms. Those timings are diagnostic, not a deployment performance guarantee.

Genuine upgrade fixtures start from each populated released migration prefix (1, 2
and 3), compare all prior rows and full migration-ledger prefixes, and then apply
and repeat the fourth migration. Both shipped customer profiles additionally test
same-release recreation. Encrypted recovery compares all 31 business tables and
the full migration ledger before deliberate valid/rejected COMMIT probes. Restored
runtime connections remain quarantined, and the running source stays unchanged.

Use the matching reviewed release to restore a backup into a fresh quarantined
target, or retain additive history during a compatible application revert. There
is no destructive down migration. Existing local `/pdaa`, its volume and Docker
disk are preserved; native rehearsals use separately named test/restore databases.

## Evidence and remaining gates

Executable evidence is in `tests/canonical-project.test.ts`,
`tests/canonical-project.integration.test.ts`, `tests/api-contract.test.ts`,
`tests/e2e/canonical-project.spec.ts`, the shared canonical acceptance helper,
`scripts/test-database.mjs`, `scripts/rehearse-recovery.mjs` and both packaged
acceptance profiles. Prior authority hostile/1,000-to-1,001 boundary tests remain
mandatory. Browser cases exercise full creation/reload, source withholding,
revocation cache removal, invalid dates, session-loss draft cleanup and legacy detail.

Native validation passed 739 unit tests, 77 database/API cases, all seven builds,
typechecks, architecture, OpenAPI, 31-table recovery, all 38 dependency records and
the package audit. Unit files ran serially on the local host; no safety limit was
relaxed. The final full 14-case browser suite passed, including six canonical
cases after UI review fixes: lost-response replay across unchanged editing,
programme retry and retained selection when a simulated capped setup response
omits the new programme, and visible validation of edited child references.
Programme/project writes in these cases use the real local API and database.

Synthetic workflow screenshots: [desktop delivery structure](assets/canonical-project-desktop.png)
and [mobile project view](assets/canonical-project-mobile.png).

Initial verification exposed the prior authority timeout, an import cycle and two
subprocess tests that timed out under parallel host load. Browser attempts found
incorrect test selectors and a startup navigation timeout. Independent UI review
identified the selection/reference/retry issues above; regression fixes now pass.
Failure logs are retained. Initial candidate `5709392` received independent source
approval and passed native CI plus packaged execution. Distribution collection then
rejected changed Debian advisory wording; the finite metadata correction and its
primary evidence are recorded in ADR-014; all 101 focused Perl tests pass, including
14 added description/retention/rejection cases. The verified completion record above
confirms that replacement source review, full CI, original-artifact gates and merge
subsequently passed. Issue #6 retains its five other evidence and reconciliation
criteria; all five release/distribution gates stay open.
