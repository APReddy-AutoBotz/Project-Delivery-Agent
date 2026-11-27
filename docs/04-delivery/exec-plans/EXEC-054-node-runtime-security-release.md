# EXEC-054: Node runtime security release

Status: Completed
Owner: Implementation controller
Requirement IDs: NFR-SEC-010
GitHub issue: [#14](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/14)
Target release: R1
Last updated: 2026-11-27

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

The prior release images used Node 24.19.0. The rebuilt images use Node
24.22.3, which includes the 24.22.1 and 24.22.3 fixes for the selected findings.
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

The first packaged run found Debian Perl `5.36.0-7+deb12u4`, the fixed version
for CVE-2026-8376. Keep its scanner findings in the evidence without applying the
older binary's architecture disposition. [Debian security tracker](https://security-tracker.debian.org/tracker/CVE-2026-8376)

## Decisions made

Use the official multi-platform image digest and retain the existing Node major
version and Bookworm base family. Verify the supported Linux x64 release profile.

## Risks and mitigations

The new base may change bundled libraries and system packages. Reconcile the
actual runtime and layer inventories and review remaining findings before release.

## Validation evidence

The focused distribution suites and hosted candidate checks passed. The
candidate archive binds the rebuilt API, worker and operations binaries to
Node 24.22.3. Its six scans contain zero of the 11 selected earlier Node findings.
[Candidate checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45924480774) ·
[Candidate scanner archive](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45924480774/artifacts/15167335278)

The post-merge archive binds the rebuilt images to merge
`439a9d33c7d8d61153c02ce735dc5b6cbc7a75a9` and the reviewed tree
`ac26fdcd376241971b1ad2a17537c697ecf01c1e`. Its SHA-256 is
`b899631da5348121073ba7a46229b9fe01e7228fb477c6b08cb9ef503f3d77fd`.
The runtime and all-layer scans of API, worker and operations contain zero
of the 11 selected findings and zero high or critical Node binary findings.
[Main Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927372795) ·
[Main Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927372739) ·
[Main scanner archive](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45927372795/artifacts/15167976372)

## Completion summary

[PR #221](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/221)
merged the pinned runtime update and both post-merge workflows passed.
Commercial distribution still requires inventory, license and notice,
remaining vulnerability, distributed-layer, and trusted signing reviews.
