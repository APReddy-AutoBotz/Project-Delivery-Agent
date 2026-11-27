# EXEC-055: Forge Jira staging connection

Status: In Progress
Owner: Implementation controller
Requirement IDs: FR-CON-001, FR-CON-009, FR-CON-012, AC-CON-001 (partial)
GitHub issue: [#7](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/7)
Target release: R1
Last updated: 2026-11-27

## Objective

Prove that a Jira site administrator can configure a customer-owned HTTPS
remote for an approved staging installation and verify access to one test Jira
project. Use this evidence to inform OD-013.

## In scope

Register a Forge staging app and use an administrator-configured remote for a
scheduled project access check. Pin the installation, environment, endpoint
and a private test project in the customer deployment. Verify one real staging invocation
after target approval.

## Out of scope

Public onboarding, production distribution, live Jira sync and writes, Jira
comments, retention policy, and any acceptance claim for the entire Jira story.

## Current state

The existing Jira runtime has synthetic evidence and a separate OAuth 2.0
credential refresh flow. OD-013 and OD-014 govern live activation and comments.
The selected Forge prototype needs an authenticated developer session, a
registered app, an approved Jira test site and a customer-owned test endpoint.

## Proposed design

A Forge scheduled trigger calls an opt-in API route at the remote selected by
the test site administrator. The customer API verifies the signed invocation
against Atlassian's commercial JWKS and the operator's single staging binding.
It uses the opaque Forge app system token once against Jira's fixed cloud API
to confirm the configured project ID. The route returns only a probe outcome.
[Forge remote verification](https://developer.atlassian.com/platform/forge/remote/essentials/)
and [customer-managed remotes](https://developer.atlassian.com/platform/forge/customer-managed-egress-and-remotes/)
describe the platform contract.

## Files and modules expected to change

The API owns the route and opt-in configuration. Platform owns Forge invocation
verification. The Jira connector owns the project read and reuses its bounded
JSON and provider error handling. The registered Forge app supplies the trigger
and remote configuration.

## Data model or migration impact

The probe operates without database access, ingestion or schema changes.

## Security and privacy impact

The route is absent by default. An enabled route accepts an exact commercial
Forge staging binding. It checks the intended app, installation, module and
Jira site before the system token can be used. Tokens, request bodies and Jira
project data are excluded from responses and logs. The app uses read scopes.
The API retains recent outcomes by invocation ID until the FIT expires to avoid
repeating reads on duplicate delivery. Provider `Retry-After` temporarily
pauses outbound requests for the staging binding.

## Connector and permission impact

The planned app scopes are `read:app-system-token` and the documented read scopes
for Get project. The binding restricts the probe to one identified project on the
approved site. The Forge endpoint key is `jira-staging-project-probe`. The signed
trigger grants access to the probe only.

## Open-source dependency impact

The customer endpoint uses the existing `jose`, `zod` and Jira connector packages.

## Implementation stages

1. Build and locally verify the opt-in customer endpoint.
2. Register the Forge app after developer sign-in and configure the manifest.
3. Validate the app, install it in staging on the approved site and confirm the
   scheduled probe at the customer endpoint.

## Test and evaluation plan

Use signed synthetic invocations to verify authorization, one permitted read,
duplicate delivery, expiration, provider permission failure and rate limiting.
After site approval, record the registered app identity, configured route and
redacted real staging result. Keep both proofs distinct in the release record.

The staging operator can add `deploy/customer/forge-jira-staging.yaml` to the
reference Compose files and set `PDAA_FORGE_JIRA_STAGING_FILE` to a local JSON
file. Supply `appId`, `environmentId` and `installationId` as full Atlassian
resource identifiers, `cloudId` as the Jira site UUID, and `jiraProjectId` as a
string containing the private test project's numeric API ID. Obtain these
values through the trusted Forge and Jira administration interfaces. The file
contains identifiers and accepts no credentials.

The configured remote must forward HTTPS `POST /api/webhooks/forge/jira-staging`
and both Forge authentication headers to the API without logging the headers.
The API needs HTTPS egress to `forge.cdn.prod.atlassian-dev.net` and
`api.atlassian.com`. A verified request returns `200` with `status: reachable`
after the Jira read. Requests to the default deployment receive `404`.

## Rollback and recovery

Remove `PDAA_FORGE_JIRA_STAGING_FILE` from the API and restart it to disable the
route. The Jira test site administrator can uninstall the staging app or revoke
its customer-managed remote. Restarting the API clears transient probe state.

## Progress log

- 2026-11-27. Approved staging prototype and verified the current Forge remote
  contract. Developer CLI sign-in is pending.
- 2026-11-27. Implemented the disabled-by-default endpoint and staging-only
  Compose override. Focused synthetic checks passed.

## Decisions made

Use a scheduled remote trigger and a single explicitly bound Jira project for
the first proof. Keep the customer endpoint opt-in and use a commercial Forge
staging environment. The real test site and endpoint require confirmation.

## Risks and mitigations

The scheduled trigger has a five-second deadline. Bound both JWKS retrieval and
the Jira read. Keep Forge configuration in staging, where the configurable
egress setting is reversible. Clear the deployment opt-in if it is unavailable.

## Validation evidence

Focused local tests passed for signed context mismatches, expiry, duplicate
delivery, the bound Jira read, incorrect project identity, denied access, and
provider rate limiting. Real staging evidence is pending app registration and
an approved test target.

## Completion summary

Pending a successful real staging invocation.
