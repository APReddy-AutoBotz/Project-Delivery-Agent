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

## Consequences

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
