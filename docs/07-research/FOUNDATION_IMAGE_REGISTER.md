# Foundation acceptance image register

Reviewed 2026-09-06 for isolated synthetic development under EXEC-003. These pins
identify publisher manifests; they do not approve commercial distribution or
certify every operating-system package license. No images are pushed by this work.

| Image | Manifest SHA-256 | Purpose | Publisher / application license |
|---|---|---|---|
| node:24.22.3-bookworm-slim | 873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530 | Build, API, worker, operations and XLSX images | [Node official image](https://github.com/nodejs/docker-node), Node MIT and bundled notices |
| pgvector/pgvector:0.8.7-pg17-bookworm | b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd | Bundled PostgreSQL 17.12, external profile fixture and operations clients | [pgvector](https://github.com/pgvector/pgvector); PostgreSQL license |
| caddy:2.11.9-alpine | 003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 | TLS ingress and static web | [Caddy](https://github.com/caddyserver/caddy); Apache-2.0 |
| golang:1.26.11-alpine3.23 | 23f198931d4bd83b4f5a613bd75656257ae8bf832dcbc2db80e1050b5219ca2a | Build-only toolchain for Caddy 2.11.9 | [Go official image](https://github.com/docker-library/golang); Go BSD-3-Clause |
| quay.io/keycloak/keycloak:26.7.3 | ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54 | Controlled test identity provider only | [Keycloak](https://www.keycloak.org/server/containers); Apache-2.0 |

Replace Node behind the documented Node 24 interface, Caddy behind standard HTTPS
reverse proxy behavior, and Keycloak with any registered compatible OIDC provider.
PostgreSQL remains the approved platform; pgvector is used only for availability
verification here and is not used for structured delivery facts. The controller
owns pin review, upgrade validation and vulnerability disposition.

## Packaging decision

The web runtime builds the published Caddy 2.11.9 module with Go 1.26.11,
`GOTOOLCHAIN=local`, `CGO_ENABLED=0` and the published Caddy module selection.
The Alpine 3.24 filesystem takes the rebuilt binary and checksum-pinned Alpine
zlib and OpenSSL security updates before copying into a fresh `scratch` graph.
Compose preserves the Caddy command, runtime paths, non-root user and ports.
[Caddy release](https://github.com/caddyserver/caddy/releases/tag/v2.11.9) ·
[Go releases](https://go.dev/doc/devel/release) · [Alpine security database](https://secdb.alpinelinux.org/v3.24/)

Set Caddy's upstream-supported `CustomVersion` linker value to `v2.11.9` because
direct module installation otherwise reports `unknown`. Assert the command's
output during the build; compiler/module evidence is checked independently of
this display value.

Retain the `nobadger,nomysql,nopgx` build tags used for the existing HTTPS gateway.
Direct installation without these tags includes additional storage drivers;
binary comparison caught that discrepancy before acceptance. Require the same
tags in binary build metadata as part of both distribution-scope checks.

Original Caddy and Go LICENSE bytes are copied from the downloaded module and
toolchain. `scripts/distribution/runtime-policy.json` requires their exact hashes
and the Caddy/Go versions in both image scopes, rejecting additional older copies.
This increment does not approve other bundled components, OS packages or remaining
distribution findings. The build runs bounded upstream TLS regression tests;
packaged acceptance remains necessary to verify the served application.

pnpm 11.19 modern deploy derives a frozen deployment lockfile. Legacy deploy
re-resolves dependencies and is not used. Injected workspace packages synchronize
compiled output after build. Exact package metadata hooks omit optional Prisma
CLI/TypeScript generator peers from `@prisma/client@7.10.0`, and the optional
TypeScript configuration loader from `cosmiconfig@8.3.6`. Actual runtime dependencies
and original upstream files remain unchanged. The CLI remains a root development
dependency. The worker declares an empty JSON `graphile-worker` configuration;
runtime images accept no arbitrary configuration/code mounts. Tests must verify
the real worker heartbeat with TypeScript absent.

`scripts/inspect-runtime.mjs` enumerates physical packages, checks dependency-link
containment and compiled entrypoints, rejects build-only tools and emits an
observed inventory. This is a packaging guard, not a completed license gate.

## Unresolved distribution gates

STORY-004 remains open. Before a distributable release, compare the entire observed
inventory and registry integrities against reviewed records, collect all original
and nested license/notice files plus bundled notices, generate release SBOMs,
scan final immutable images and disposition findings. The static web assets need
their own complete notice bundle. Debian/Alpine OS licenses require their own
review under OPEN_SOURCE_POLICY.md; upstream application licenses do not cover
every base-image package.

Prisma CLI's development closure contains Studio branding conditions and an EPL
dependency. Neither belongs in an application image. A proposed minimal migration
package also has a transitive BlueOak notice requiring policy review; it has not
been adopted. This increment uses the existing CLI only in its development test
image. The operations target now reuses the pinned PostgreSQL/pgvector image and Node 24
binary, plus the existing approved pg/Graphile/platform dependencies. It packages
the reviewed SQL migration set and excludes Prisma CLI/Studio. Complete OS and
transitive distribution review still applies to this additional target.

The next evidence collector is described in [DISTRIBUTION_EVIDENCE_VALIDATION.md](../05-quality/DISTRIBUTION_EVIDENCE_VALIDATION.md). It binds native/SPDX SBOMs, complete scanner findings, observed notice bytes and browser bundle records to accepted immutable images. Evidence collection does not close the distribution gates above.

## Runtime package-manager removal and Node attribution

### Web transfer-tool boundary

The 2026-09-08 web increment retains the Caddy/Go/base pins and removes curl using
the installed APK database without a network package refresh. The inspected
dependency graph identifies nine removable packages: curl, libcurl, brotli-libs,
c-ares, libidn2, libpsl, libunistring, nghttp2-libs and zstd-libs. Verify that exact
set on the candidate image and that every retained package version is unchanged.

BusyBox wget still supplies the HTTP loopback healthcheck. Caddy's pure-Go build
handles HTTPS and API/static routing. APK/libapk, CA tooling and ssl_client still
require OpenSSL and other shared libraries; retain those components and their
inventory. Removal occurs before the scratch copy so discarded bytes are absent
from lower layers. Remaining OS, Go and browser dependencies retain their own
license, notice and vulnerability review gates. No new dependency is adopted.

API and worker images copy the
prepared Node filesystem into a fresh layer graph after removing unused npm,
Corepack and Yarn payloads and command links. The build and acceptance stages
retain their development tools. Both runtime and all-layer scans enforce the
customer tooling boundary; the full customer acceptance suite remains required.

Node's original `/usr/local/LICENSE` is preserved in API/worker and copied to
`/usr/local/share/doc/node/LICENSE` in operations. Its 157609 bytes and SHA-256
`5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace` match the
[publisher's v24.22.3 source notice](https://raw.githubusercontent.com/nodejs/node/e63cab040c09d43ceef8cb35508c40044614e906/LICENSE).
The machine-readable runtime policy enforces this hash and version. Preserving
the complete notice does not certify complete binary component reconciliation or
resolve the separate OS/transitive legal review.

PR #24's reported npm closure matches include [undici](https://github.com/nodejs/undici/security/advisories/GHSA-vxpw-j846-p89q)
and [node-tar](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m).
Removing unused package-manager copies narrows the shipped inventory; Node's
own embedded libraries and all remaining scanner matches stay subject to review.

## Compiled Go source notices

The Go notice collector uses the Caddy binary hash and module identities
recorded in `scripts/distribution/caddy-modules.json`. The helper runs in the
build stage with network disabled. It verifies exact module ZIP h1 values
against the compiled metadata and committed inventory, then writes the original
notices and index under `/usr/share/caddy/modules/`. The final image retains
those files and the compiled gateway.

Both Syft scopes must contain the sole pinned Caddy binary, all compiled
non-stdlib modules, the expected standard library and every original notice byte.
Notice paths, hashes, file IDs and supplying layers are reconciled independently;
the Go and Caddy LICENSE files retain their established paths. The complete
immutable customer acceptance suite still gates the candidate.

Module-source attribution remains distinct from legal approval or proof of
package/platform/asset applicability. See the adoption register and ADR-014 for
the recorded custom-term review obligations. No database, permission, connector
or runtime behavior change is intended; rollback is a reviewed packaging revert.

## Npm notice capture and attribution

The npm increment changes scanner capture and evidence reconciliation only. The
existing three README files in @tokenizer/token, pg-types and pgpass already occur
in the API/worker/operations images. Their complete original bytes enter the
notice artifacts through exact capture paths, bound to reviewed lock-integrity
and file-hash pins. The five RxJS entrypoints retain their original scanner
records and use the existing parent LICENSE.txt under verified physical ownership.

Both image scopes retain target/image/package/manifest/file/layer identities and
reject missing bytes, source drift or cross-package/cross-layer notice borrowing.
No runtime package or base-image version changes, and no Dockerfile package-copy
step is added. Actual scanner capture and full immutable candidate acceptance
remain required; an old image with incompatible application metadata is not valid
new evidence. Schema 4 archives the npm policy and repeats attribution checks on
downloaded reports. This does not approve the remaining image licensing,
vulnerability dispositions, distributed layers or release signing.

## Node binary metadata and source coverage

The Node evidence increment retains the same runtime image pins and executable:
125,989,464 bytes, SHA-256
`bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12`.
The complete original notice above is unchanged. A reviewed source policy indexes
its preamble and 44 source sections and pins all 29 observed process metadata
keys. Node built-ins remain separate from application npm inventory.

Each accepted API/worker/operations image is probed directly after native binary
and notice validation, with networking disabled and bounded nonroot read-only
execution. Raw stdout and complete command/image/policy receipts are archived;
both scope reviews are reconstructed from retained originals. Operations' binary
and notice belong to different valid supplying layers, each retained explicitly.
Runtime package-manager exclusion checks still apply to the actual filesystem
even when Node's original embedded build configuration mentions npm/Corepack.

This adds evidence tooling only. Source correspondence and metadata do not prove
a reproducible build, complete linked-code census or legal applicability. The
policy and validation documentation preserve missing/unversioned/source-only/data
attribution as review work, alongside the existing vulnerability/signing gates.

## Node supplemental notice packaging

The supplemental increment retains the Node/base-image pins and executable above.
A separate stage fetches four checksum-pinned original Node source files, then
verifies and extracts notices with networking disabled. Only nbytes's complete
LICENSE, 149 SQLite original source comments and their index enter API, worker
and operations under `/usr/local/share/doc/node/supplements/`. Full parent sources
and build helpers remain outside the customer image graph.

This changes image identities through added attribution files. Both scope scans
must show the expected namespace, original byte hashes and independent supplying
layers, with unchanged Node executable, original root notice and process metadata.
Packaged acceptance must use the fresh image identities for both customer profiles.
The same supplemental policy and original evidence replay are required in the
73-file schema-6 bundle. ncrypto, linked-source applicability and full distribution
review remain unresolved. Roll back with a reviewed packaging/policy revert;
no database migration or connector permission recovery is needed.
