# EXEC-053 Atlas source intake

- Requirements: BR-004, BR-005, PR-001, PR-002, PR-003, PR-004, PR-005, PR-006
- Acceptance: Jira portion of AC-PRO-001 and E2E-HERO-001
- GitHub issue: [#14](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/14)

Run the existing Jira read-only sync against a local, synthetic transport for
Atlas. Reuse the sync fixture from GOLDEN-003. Seed the sealed Atlas canonical
mapping from the same issue key, update timestamp and synthetic site. Require the
saved connector receipt to match that project, issue and revision before starting
the Atlas demo. The saved browser journey checks that a scoped leader can read
the connector receipt and that the delay answer cites the matching mapping.

The fixture maps the synthetic Jira status `To Do` to the open Atlas blocker.
It uses the isolated demo customer's own ingestion retention and reader grants.
The spreadsheet intake and field authority in this same journey are still needed
for E2E-HERO-001 acceptance.

Validate the existing Jira adapter, the current Atlas browser journey and the
packaged GOLDEN-003 proof through their existing checks. Revert this change and
start a fresh disposable demo database to roll back. No schema or production
connector configuration changes are required.
