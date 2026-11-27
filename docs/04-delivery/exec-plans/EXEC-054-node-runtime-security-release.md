# EXEC-054: Node runtime security release

Status: In Progress
Owner: Implementation controller
Requirement IDs: NFR-SEC-010
GitHub issue: [#14](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/14)
Target release: R1
Last updated: 2026-11-26

## Objective

Address the selected Node scanner findings and revalidate distribution evidence
under AC-MNT-004 and the repository's open-source policy.

## In scope

Upgrade the official Node Bookworm Slim image across the build, API, worker,
operations, acceptance and XLSX paths. Refresh evidence bound to the shipped
binary and original source.

## Out of scope

Commercial distribution, trusted signing and dispositions for unrelated scanner
findings continue through their release gates.

## Current state

The previous main image uses Node 24.19.0. The 24.22.3 release includes the
Node 24.22.1 fixes and the additional 24.22.3 fixes for the selected findings.
[Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1) and
[Node 24.22.3](https://nodejs.org/en/blog/release/v24.22.3)

## Proposed design

Authenticate the source and Linux x64 archives with the release team's signed
checksums and the published signer fingerprint
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. Bind the binary, process metadata,
original notice, supplemental attribution and embedded resources to that release.
The official image recipe verifies the same Linux archive before it extracts
the binary to `/usr/local/bin/node`.
[Release keys](https://github.com/nodejs/release-keys) and
[official image recipe](https://github.com/nodejs/docker-node/blob/1274f3ee37d4d0e59d308ea25b83d9e21e4db862/24/bookworm-slim/Dockerfile)

## Files and modules expected to change

Update the Node pins in three Dockerfiles, the existing distribution policies and
selected-source size check, and the corresponding notice and deployment records.

## Data model or migration impact

The existing application schema and migration sequence apply to the rebuilt images.

## Security and privacy impact

The patched runtime replaces the Node binary in the existing restricted containers.
The existing distribution probes verify exact binaries, notices and source bytes.

## Connector and permission impact

The rebuilt application uses existing connector scopes and role checks.

## Open-source dependency impact

The upstream Node release updates libraries bundled in its binary. Refresh the
attribution inventory and retain explicit review of original notice applicability.

## Implementation stages

1. Verify publisher and registry provenance.
2. Refresh the image and evidence pins.
3. Review the immutable candidate and verify the rebuilt image set.

## Test and evaluation plan

Run the existing distribution validators and required hosted image checks.
Confirm the scanner disposition from the rebuilt image evidence and compare it
with the selected Node findings on the prior image.

## Rollback and recovery

Rebuild from the prior reviewed release revision if the new image cannot be
validated. Record the reintroduced Node exposure before considering distribution.

## Progress log

Verified the signed archive checksums, official image digest and Linux binary.
Refreshed the existing policies and compared all 22 pinned files to the immutable
publisher source.

## Decisions made

Use the official multi-platform image digest and retain the existing Node major
version and Bookworm base family. Verify the supported Linux x64 release profile.

## Risks and mitigations

The new base may change bundled libraries and system packages. Reconcile the
actual runtime and layer inventories and review remaining findings before release.

## Validation evidence

The existing focused distribution suites pass with the regenerated pins. Hosted
results for the exact reviewed tree and the rebuilt image scan are pending.

## Completion summary

The candidate contains the pinned runtime update. Merge and the release evidence
checkpoint depend on the remaining checks.
