# ADR-014: Evidence for distribution review

Status: Accepted under delegated controller authority; exact implementation review required
Date: 2026-09-06
Requirements: NFR-SEC-010, NFR-MNT-004, TR-TEST-001, TR-TEST-002; AC-MNT-004

## Decision

Collect evidence from the immutable images that passed production acceptance:
API, worker, web, operations and the pinned bundled PostgreSQL/pgvector image.
The controlled identity provider and acceptance tool image are test fixtures and
are not part of the proposed customer distribution.

Use checksum-pinned Syft and Grype development executables, Apache-2.0, outside
application images. Syft produces native and SPDX 2.3 JSON; Grype scans that exact
native SBOM with a hash-validated vulnerability database no older than five days.
Keep the complete findings, including unfixed findings. Do not load ambient scanner
configuration, ignore rules, VEX files or environment overrides. Scanning is serial
to limit disk and memory use. No images or attestations are pushed.

Verify image filesystem layer identity, scanner versions, scan source, package
coverage and database freshness. Preserve exact lockfile bytes, package inventory,
observed license/notice content and hashes of all evidence. Include a separate
build-generated inventory and original notices for components bundled into static
browser assets, which filesystem scanners cannot reliably infer from minified JS.

CI must fail on missing, malformed, mismatched or stale evidence. A completed scan
may still contain release blockers: license review, missing notices, unresolved
vulnerabilities and release signing. Record these explicitly; successful evidence
collection never constitutes commercial approval. A separate release-readiness
check must refuse an incomplete review. STORY-004 remains open until AC-MNT-004's
complete rejection and release-review contract is independently proven.

## 2026-09-07 amendment: runtime tools and distributed layers

PR #24 established evidence from the accepted runtime filesystems. Retain that
scope for current application/browser reconciliation and add independent
`all-layers` native/SPDX/Grype reports for every customer image. Validate each
tool's reported scope and immutable source, and retain file IDs and supplying
layer IDs for original notices and finding package locations. Schema version 2
requires both report sets; older evidence cannot satisfy the expanded gate.

The API/worker use the same pinned Node filesystem with unused global npm,
Corepack and Yarn payloads/commands removed in a preparation stage. Copy that
clean filesystem into a fresh `scratch` stage so removed bytes are absent from
its distributed graph. Explicitly retain PATH, Node version, production mode,
the node user/group, working directory and entrypoint. Keep OS package metadata
and original notices. The operations image receives the unchanged Node bundled
notice alongside its existing copied binary. Require exact Node version/notice
hash and absence of package-manager records, payloads and commands in both scopes.

This follows the publisher's [package-manager-free runtime guidance](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md#smaller-images-without-npmyarn)
and [Docker stage isolation](https://docs.docker.com/build/building/multi-stage/).
It adds no new OS image or runtime version. Full packaged acceptance must prove
execution, TLS, permissions, shutdown and recovery on the resulting image IDs.
All-layer scanner coverage remains distinct from complete attribution review;
legal approval, unresolved findings and trusted signing continue to block release.

## Original consequences

This adds build and review tooling, not a runtime service or new connector. Existing
Debian/Alpine images contain components requiring explicit review under
OPEN_SOURCE_POLICY.md. Do not infer legal approval from the base-image publisher's
license or from the scanner's classification. The first evidence increment does
not implement trusted release signing or waive legal/product approval.

Revert the tooling/workflow changes to roll back. No database migration or data
rollback is needed. Preserve the local database and run production validation in
isolated projects or CI.

Sources: [Anchore tools and licenses](https://oss.anchore.com/docs/projects/),
[SBOM formats](https://oss.anchore.com/docs/guides/sbom/formats/),
[Syft configuration](https://oss.anchore.com/docs/reference/syft/configuration/),
[Grype configuration](https://oss.anchore.com/docs/reference/grype/configuration/).
