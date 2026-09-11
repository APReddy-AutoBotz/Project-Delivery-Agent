# Canonical project creation and detail validation

Issue: [#6](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/6)
Plan: [EXEC-005](../04-delivery/exec-plans/EXEC-005-canonical-project-workflow.md)
Story/criterion/test: STORY-010 / AC-MOD-001 / INT-MOD-001.
Requirements: FR-MOD-001/002/004/005/007; adjacent FR-MOD-003/006,
NFR-SEC-001/004 and TR-API-001. Authority regression: FR-EVD-003/010.
Status: Implementation and candidate validation in progress; acceptance pending.

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
Failure logs are retained. Packaged execution, immutable candidate review and CI
are pending; native results alone do not complete those gates.
No story is accepted by this in-progress report. R0 remains 3/5 and R1 0/33 until
verified merge and an explicit acceptance decision. Issue #6 retains its remaining
evidence and reconciliation criteria; all five release/distribution gates stay open.
