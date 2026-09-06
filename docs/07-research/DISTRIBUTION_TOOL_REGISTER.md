# Distribution evidence tools

Requirements: NFR-SEC-010, NFR-MNT-004; AC-MNT-004; ADR-014; Issue #5.

Reviewed 2026-09-06 for development/CI evidence collection only. Neither executable
is copied into an application image or distributed to customers. No upstream
implementation source is copied or modified. The controller owns pin review and
replacement through the versioned JSON/SPDX file boundary.

| Tool | Exact version | License | Purpose and publisher |
|---|---|---|---|
| Syft | 1.51.1 | Apache-2.0 | Image package, file and license inventory; [release](https://github.com/anchore/syft/releases/tag/v1.51.1), [license](https://github.com/anchore/syft/blob/v1.51.1/LICENSE) |
| Grype | 0.118.0 | Apache-2.0 | Scan exact SBOMs using a current vulnerability database; [release](https://github.com/anchore/grype/releases/tag/v0.118.0), [license](https://github.com/anchore/grype/blob/v0.118.0/LICENSE) |

Both releases were published on 2026-08-27. `scripts/distribution/tools.json`
pins Windows/Linux x64 archive SHA-256 values verified against publisher release
metadata. The installer checks archive bytes on every use, extracts only the
named executable and LICENSE, and never runs a downloaded shell installer.
Other platforms fail explicitly. Tool archives and the vulnerability database
stay under the project's ignored `tmp/distribution-tools` directory.

Grype must successfully check for database updates, verify its checksum and reject
databases older than 120 hours. Complete findings are retained, including unfixed
findings and upstream kernel-header matches; no ignore rules or VEX are loaded.
The collector strips inherited scanner settings and supplies explicit checked-in
configuration. Native Syft JSON retains file-level evidence; SPDX 2.3 is also
produced for interchange. [Scanner configuration](https://oss.anchore.com/docs/reference/grype/configuration/),
[SBOM formats](https://oss.anchore.com/docs/guides/sbom/formats/).

The tools do not prove package reachability, license compatibility, complete
binary-bundled attribution or release authenticity. Findings and missing notices
remain review work under OPEN_SOURCE_POLICY.md. Current scans cover the runtime
filesystem; deleted lower-layer material requires additional distribution review.
No legal approval, vulnerability exception or trusted signing identity is inferred.
