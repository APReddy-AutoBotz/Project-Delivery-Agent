# Foundation acceptance image register

Reviewed 2026-09-06 for isolated synthetic development under EXEC-003. These pins
identify publisher manifests; they do not approve commercial distribution or
certify every operating-system package license. No images are pushed by this work.

| Image | Manifest SHA-256 | Purpose | Publisher / application license |
|---|---|---|---|
| node:24.19.0-bookworm-slim | a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df | Node 24 build and API/worker runtime | [Node official image](https://github.com/nodejs/docker-node); Node MIT and bundled notices |
| pgvector/pgvector:0.8.6-pg17-bookworm | cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f | Isolated bundled/external PostgreSQL with vector availability | [pgvector](https://github.com/pgvector/pgvector); PostgreSQL license |
| caddy:2.11.4-alpine | 5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 | TLS ingress and static web | [Caddy](https://github.com/caddyserver/caddy); Apache-2.0 |
| quay.io/keycloak/keycloak:26.7.3 | ff4257d0d64efbe99ed1ddfaf07765cc3c36dc7518bf8324d41961327f441c54 | Controlled test identity provider only | [Keycloak](https://www.keycloak.org/server/containers); Apache-2.0 |

Replace Node behind the documented Node 24 interface, Caddy behind standard HTTPS
reverse proxy behavior, and Keycloak with any registered compatible OIDC provider.
PostgreSQL remains the approved platform; pgvector is used only for availability
verification here and is not used for structured delivery facts. The controller
owns pin review, upgrade validation and vulnerability disposition.

## Packaging decision

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
