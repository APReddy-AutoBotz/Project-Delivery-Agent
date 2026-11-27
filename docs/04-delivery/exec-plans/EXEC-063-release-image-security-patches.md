# EXEC-063: Patch the packaged database and web images

Status: In Progress
Requirement IDs: NFR-SEC-010, AC-MNT-004 and TR-DEP-001.
GitHub issue: [#5](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/issues/5).
Target release: R0 and R1
Last updated: 2026-11-27

The Product Owner included patch updates for the packaged PostgreSQL/pgvector,
Caddy and Go images. The distribution evidence from the reviewed delivery
candidate shows outdated Perl and OpenSSL in the database and operations
images, and outdated Alpine libraries and Go modules in the web image.
[Baseline image evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/45988833473/artifacts/15194631068)

Keep PostgreSQL on major version 17 and retain the database and web deployment
contracts. Verify published image digests and installed package versions.
Refresh the exact Caddy binary, module inventory and notice anchors using the
existing collector. Recheck the applicability of existing dispositions against
the rebuilt files and preserve unresolved findings in the scanner evidence.

The PostgreSQL 17.12 and pgvector 0.8.7 image contains Debian Perl
`5.36.0-7+deb12u4` and OpenSSL `3.0.22-1~deb12u2`. Install Alpine's signed
zlib `1.4-r0` and OpenSSL `3.5.9-r1` libraries in the Caddy 2.11.9 image
using pinned SHA-256 digests. Compile Caddy with Go 1.26.11 and its published
module graph. That graph uses `golang.org/x/net` v0.60.0. The separate finding
that requires v0.62.0 remains open in the disposition review.
[PostgreSQL 17.12 compatibility notes](https://www.postgresql.org/docs/release/17.12/) ·
[Debian Perl fix](https://security-tracker.debian.org/tracker/CVE-2026-12087) ·
[Debian OpenSSL fix](https://security-tracker.debian.org/tracker/CVE-2026-75803) ·
[Alpine security database](https://secdb.alpinelinux.org/v3.24/) ·
[Go patch release history](https://go.dev/doc/devel/release)

The local Linux amd64 cross-build produced Caddy binary SHA-256
`00f78eb97113b27aa920e5cafbfe00ebd33d99b101fcf471d53c3447b6a702cc`.
The repository collector verified 147 compiled modules, their ZIP identities
and 201 original attribution files. The hosted build checks the same binary
and notice inventory in the packaged image.

Run the existing packaged customer profile and distribution checks. Compare
the targeted old and new package copies in the rebuilt scans. A source or pin
change takes effect after the reviewed images pass the required hosted checks.
The release review still covers inventory, licensing, findings, distributed
layers and signing. Keep the prior reviewed pins available for recovery and
record any exposures they would restore.
