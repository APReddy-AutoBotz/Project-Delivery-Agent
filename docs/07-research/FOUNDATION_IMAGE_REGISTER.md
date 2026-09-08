# Foundation acceptance image register

Reviewed 2026-09-06 for isolated synthetic development under EXEC-003. These pins
identify publisher manifests; they do not approve commercial distribution or
certify every operating-system package license. No images are pushed by this work.

| Image | Manifest SHA-256 | Purpose | Publisher / application license |
|---|---|---|---|
| node:24.19.0-bookworm-slim | a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df | Node 24 build and API/worker runtime | [Node official image](https://github.com/nodejs/docker-node); Node MIT and bundled notices |
| pgvector/pgvector:0.8.6-pg17-bookworm | cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f | Isolated bundled/external PostgreSQL with vector availability | [pgvector](https://github.com/pgvector/pgvector); PostgreSQL license |
| caddy:2.11.4-alpine | 5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 | TLS ingress and static web | [Caddy](https://github.com/caddyserver/caddy); Apache-2.0 |
| golang:1.26.8-alpine3.23 | 33ce311e5eecedee48ec1b84419c1306e9fbd71009f0d5c3f2a6904b579c1ecc | Build-only toolchain for the existing Caddy 2.11.4 release | [Go official image](https://github.com/docker-library/golang); Go BSD-3-Clause |
| quay.io/keycloak/keycloak:26.7.3 | ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54 | Controlled test identity provider only | [Keycloak](https://www.keycloak.org/server/containers); Apache-2.0 |

Replace Node behind the documented Node 24 interface, Caddy behind standard HTTPS
reverse proxy behavior, and Keycloak with any registered compatible OIDC provider.
PostgreSQL remains the approved platform; pgvector is used only for availability
verification here and is not used for structured delivery facts. The controller
owns pin review, upgrade validation and vulnerability disposition.

## Packaging decision

The web runtime now uses a local build of the published Caddy 2.11.4 module with
Go 1.26.8, `GOTOOLCHAIN=local`, `CGO_ENABLED=0` and its unchanged upstream module
selection. The [official image source](https://github.com/docker-library/golang/tree/f47489bcbda87966b421340c536f39a34d00b45f/1.26/alpine3.23)
and registry manifest establish the toolchain pin above. The existing Alpine
filesystem is prepared with the replacement binary and copied into a fresh
`scratch` graph. Preserve Caddy's command, PATH, XDG paths and working directory;
Compose continues to select the non-root user and ports. This is a product build,
not the publisher's original Caddy binary.

Set Caddy's upstream-supported `CustomVersion` linker value to `v2.11.4` because
direct module installation otherwise reports `unknown`. Assert the command's
output during the build; compiler/module evidence is checked independently of
this display value.

Retain the publisher's `nobadger,nomysql,nopgx` build tags from its
[release configuration](https://github.com/caddyserver/caddy/blob/v2.11.4/.goreleaser.yml).
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

The 2026-09-07 increment retains the exact image pins above. API/worker copy the
prepared Node filesystem into a fresh layer graph after removing unused npm,
Corepack and Yarn payloads and command links. The build and acceptance stages
retain their development tools. Both runtime and all-layer scans enforce the
customer tooling boundary; the full customer acceptance suite remains required.

Node's original `/usr/local/LICENSE` is preserved in API/worker and copied to
`/usr/local/share/doc/node/LICENSE` in operations. Its 157606 bytes and SHA-256
`148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5` match the
[publisher's v24.19.0 source notice](https://raw.githubusercontent.com/nodejs/node/cdc1b38d40cb567b7ad0b39c86addf830a0af0ae/LICENSE).
The machine-readable runtime policy enforces this hash and version. Preserving
the complete notice does not certify complete binary component reconciliation or
resolve the separate OS/transitive legal review.

PR #24's reported npm closure matches include [undici](https://github.com/nodejs/undici/security/advisories/GHSA-vxpw-j846-p89q)
and [node-tar](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m).
Removing unused package-manager copies narrows the shipped inventory; Node's
own embedded libraries and all remaining scanner matches stay subject to review.

## Compiled Go source notices

The Go notice increment retains every image/compiler/module pin and requires
the unchanged Caddy binary hash recorded in `scripts/distribution/caddy-modules.json`.
A first-party standard-library Go helper runs in the existing build stage with
network disabled. It verifies exact module ZIP h1 values against compiled build
metadata and the committed inventory, then preserves 197 original files plus an
index under `/usr/share/caddy/modules/`. Source archives, extracted module caches
and helper executables are excluded from the final graph.

Both Syft scopes must contain the sole pinned Caddy binary, all 144 non-stdlib
module identities, the expected standard library and every original notice byte.
Notice paths, hashes, file IDs and supplying layers are reconciled independently;
the old root-notices-only image cannot satisfy the new gate. Existing Go/Caddy
LICENSE paths and all runtime package versions remain unchanged. The complete
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
