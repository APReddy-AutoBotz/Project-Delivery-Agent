# EXEC-054 Node runtime security release

- Requirements: NFR-SEC-010 and NFR-REL-004
- Acceptance: AC-MNT-004
- GitHub issue: [#14](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/14)

Update the pinned Node 24 Bookworm Slim image to 24.22.3 across the build,
API, worker, operations, acceptance and XLSX paths. This release includes the
Node 24.22.1 fixes and the additional 24.22.3 fixes for the selected scanner
findings. [Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1) and
[Node 24.22.3](https://nodejs.org/en/blog/release/v24.22.3)

Authenticate the source and Linux x64 archives with the release team's signed
checksums and the published signer fingerprint
`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`. Bind the binary, process metadata,
original notice, supplemental attribution and embedded resources to that release.
The official image recipe verifies the same Linux archive before it extracts
the binary to `/usr/local/bin/node`.
[Release keys](https://github.com/nodejs/release-keys) and
[official image recipe](https://github.com/nodejs/docker-node/blob/1274f3ee37d4d0e59d308ea25b83d9e21e4db862/24/bookworm-slim/Dockerfile)

Run the existing distribution validators and required hosted image checks.
Confirm the scanner disposition from the rebuilt image evidence and compare it
with the selected Node findings on the prior image. Review any remaining
findings on the new image before distribution. For rollback, rebuild from the
prior reviewed release revision and record the reintroduced Node exposure.
