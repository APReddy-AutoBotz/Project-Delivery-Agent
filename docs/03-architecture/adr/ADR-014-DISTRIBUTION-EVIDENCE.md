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

## 2026-09-08 amendment: compiled Go module notices

Require schema version 3 evidence with the committed `caddy-modules.json`
inventory and Go notice reconciliation in both image scopes. The pinned inventory
contains Caddy plus 143 compiled dependency coordinates, versions and h1 values,
and 197 original notice paths/sizes/hashes. Bind it to the unchanged compiled
binary, compiler and build settings. Updates to any pin require review.

Use a first-party helper with the existing Go standard library in the build stage.
Read compiled build information, then read each exact cached module ZIP directly
under Docker `RUN --network=none`. Independently compute the Go h1 over sorted
archive names and original file contents and compare with both compiled metadata
and the pinned inventory. Also record ZIP SHA-256 as transport evidence. Do not
trust `.ziphash`, `.info`, an extracted cache copy or a `go mod download` response
as fresh byte authentication. The initial offline metadata lookup failed despite
available ZIPs; direct reads avoid requiring transitive version metadata or a new
network request. No additional GoModSum or checksum-database proof is claimed.

Discover root/nested attribution text, including LICENSE/LICENCE, NOTICE,
COPYRIGHT, COPYING, AUTHORS, PATENTS, third-party names and LICENSES directories.
Exclude source/binary formats and JSON: the verified mergo `testdata/license.json`
is test data, not attribution. Check all discovered paths and bytes against the
pin, preserve original bytes under module-specific directories, and write the
index last. A module with no matching notices must be explicitly recorded as
missing. The present inventory has attribution for every module. Reject unsafe
paths, duplicates, links, unsupported text and bounded size/count overruns.

Ship only notices and the index at `/usr/share/caddy/modules/`. Original Caddy/Go
root notices remain unchanged. Syft captures these files without license
enrichment; first-party reconciliation verifies the sole expected binary, exact
modules/h1 values and every original file/digest/layer against the trusted
inventory. Missing nested files fail even when removed from the index too.
Repeat this validation when checking retained evidence, not only at collection.

This is a module-source notice superset. It does not determine which nested asset,
platform or source-header terms apply to compiled code, approve license choices,
complete standard-library/generated-data attribution, or waive existing release
gates. No runtime module is added or upgraded. Roll back with a reviewed
packaging/evidence revert; no schema, data or connector recovery is needed.

Sources: [Go module cache and ZIP contract](https://go.dev/ref/mod),
[compiled build information](https://pkg.go.dev/debug/buildinfo),
[Go h1 content hashing](https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash).

## Original consequences

### 2026-09-08 amendment: supplemental Node source notices

Require schema 6 with `node-supplemental.json` added to the 72-file manifest. A
separate build stage fetches only four exact files from the reviewed Node commit:
nbytes LICENSE and SQLite's amalgamation/two headers. Bound HTTPS requests to
30 seconds and their pinned decoded byte lengths, refuse redirects, and verify
full original SHA-256 values. Source policies and original files are read through
bounded regular-file descriptors, checking exact sizes before allocating buffers.

Repeat authentication and extraction with networking disabled. A stateful C
comment reader skips strings, character literals, line comments and logical
backslash-newline splices while retaining original byte positions. Its exact
attribution-marker discovery must match all 149 reviewed SQLite comment spans.
Preserve nbytes's complete original LICENSE and every original SQLite comment,
without normalization, deduplication or added newline. Complete comments can
include explanatory examples; they are source extracts, not a generated licence.
Write the index only after all parent sources, ranges and output hashes validate.

Only those 150 notices and their index enter customer images, under
`/usr/local/share/doc/node/supplements/`. Source files, source cache and helper
remain in build stages. The existing Node executable, root LICENSE, dependency
versions and runtime metadata remain unchanged. The operations copies may have
independent valid supplying layers. No runtime code or service is introduced.

Both image scopes must contain exactly the expected original files and index in
that namespace. Verify regular-file identities, full captured original bytes,
source/index/policy digests, accepted Node binary and each supplying layer.
Required source roots and occurrence counts are bound to component keys, so
coherently empty policies cannot claim coverage. Retained evidence replays these
checks alongside the original Node, npm, Go and runtime-tooling contracts.
Reviewed extract pins and build authentication support parent-source attribution;
retained image reports do not contain complete parent source files or a signed
build attestation. They must not claim to reconstruct the source-to-binary build.

Supplemental source coverage for nbytes and SQLite is separate from the three
literal root-notice gaps. ncrypto remains unresolved; root Node or OpenSSL text
must not automatically stand in as its component notice. Conditional, platform,
header, data and linked-code applicability remain review work. Full licensing,
vulnerability dispositions, layer review and signing continue to block release.
Rollback is a reviewed packaging/policy revert without database or scope changes.

### 2026-09-08 amendment: Node binary metadata and original source coverage

Require schema 5, adding the reviewed `node-components.json` policy and separate
raw Node metadata/command receipts for API, worker and operations. Retain the
current Node 24.19.0 executable, image pins and complete original LICENSE. Pin the
executable path/size/SHA-256, reviewed metadata snapshot and exact Node source
commit/file hashes. Partition the unchanged notice into its root preamble and
all 44 original top-level sections, preserving original byte offsets/hashes,
headings and source paths. Validate the partition against the actual notice text,
so removing an unreferenced section and merging its span into a neighbour fails.

Before executing a probe, require the sole classified Node binary and original
notice to match their physical files and accepted image layers. Detect extra
observed executable copies, including renamed identical bytes and lower-layer
copies. Operations stores binary and notice in different valid layers; verify
each supplying layer independently. Source/config hashes and ordered filesystem
layers remain bound to the accepted immutable image and scanner scope.

Run only the fixed direct Node metadata expression in a uniquely named ephemeral
container. Disable pulling and networking; use nonroot execution, read-only root,
no mounts, dropped capabilities, no-new-privileges, bounded resources and timeout,
and reset NODE_OPTIONS/NODE_PATH. Override the application entrypoint and working
directory. Retain exact stdout and a receipt containing target/run/image, binary
and policy hashes, complete argv and stdout digest/size. Clean up the owned probe
container after command failure. The probe starts no application or connector.

Require every metadata key/value/type, feature and embedded build configuration
to match the reviewed snapshot. Keep original V8/zlib suffixes, ABI/data keys and
empty disabled QUIC values. Build configuration that mentions installed npm or
Corepack does not override actual verified package-manager removal. Use Node
component identities tied to binary/source/image evidence, separately from
application npm records. Native Syft/SPDX and vulnerability observations remain
unchanged; this increment does not add inferred npm coordinates to scanner input.

Retained verification repeats original binary/notice/section, metadata and receipt
validation in both scopes, compares derived review objects and replays the
existing runtime-tooling exclusions for every target. It retains npm/Go replay.
All 72 evidence files remain hashed; schema 4 cannot satisfy the new contract.

This records source correspondence and runtime metadata, not a reproducible
source-to-binary build or signed execution attestation. The 24 notice sections
without dedicated version keys retain unresolved shipped membership. Three
versioned libraries (nbytes, ncrypto and sqlite) have no literal root-notice
section; keep their component-source attribution unresolved. ICU-related data
attribution and nested/platform/header applicability remain open. Full licensing,
vulnerability dispositions and trusted release signing are separate requirements.
No dependency, image package contents, database, permission or connector scope is
changed. Rollback is a reviewed collector/policy revert without database recovery.

### 2026-09-08 amendment: npm original files and parent attribution

Require schema 4 evidence, retaining `npm-notices.json` alongside the unchanged
Go inventory. The reviewed npm policy pins four existing package coordinates,
exact lock integrity, publisher archive references/hashes, original root manifest
hashes and notice paths/sizes/hashes. It also pins the five versionless RxJS
entrypoint manifests. The original publisher archives were checksum-verified
against the lockfile; collection performs no remote enrichment or archive fetch.

Capture only the three selected README paths in addition to existing notice
globs. Validate their full original UTF-8 bytes, size, digest, regular-file identity
and supplying layer before adding them to the notice bundle. Pin manifest
metadata hashes to reviewed publisher originals; manifest text is not required
as a new notice artifact. Root and embedded manifests cannot disappear together
with their report entries: the selected source policy remains mandatory.

Apply application lock and notice reconciliation to API, worker and operations in
both squashed and all-layer scopes. Retain each scanner package/manifest/layer
occurrence, even when coordinates or notice contents repeat. Associate ordinary
captured notices with their nearest physical manifest without crossing a nested
node_modules boundary. Only reviewed source-pinned embedded manifests may inherit
their uniquely enclosing locked parent's notice, in the same supplying layer;
preserve child-specific files too. Other versionless manifests remain explicit
and do not gain an automatic license exemption. Keep direct capture observations
separate from confirmed source/parent attribution and leave native SBOM fields
unchanged.

The downloaded-evidence checker replays this calculation from native image/file
reports and archived lockfile bytes, compares the derived lock inventory, original
notice bundles and both recorded review objects, and rejects mismatches. Schema 3
cannot satisfy this expanded gate. Hash manifests and source-tree binding remain
evidence-integrity controls; trusted signing and commercial release approval are
separate open work. This increment adds no runtime dependency, Dockerfile change,
schema or connector scope. Rollback is a reviewed collector/policy revert.

### Web transfer-tool removal

The 2026-09-08 increment removes unused curl and its orphan libraries with
`apk del --no-network curl` in the existing web preparation stage. Copy the
resulting filesystem into the fresh final graph, retaining truthful APK metadata.
The shipped HTTP loopback healthcheck uses BusyBox wget; the gateway uses the
existing Caddy build with `CGO_ENABLED=0`. Preserve shared libraries, the trust
store, supported serving configuration and original Go/Caddy notices.

Both image scopes reject removed package names/source origins and corresponding
command/library paths, including copies outside standard locations. Verification
must show the exact expected package deletion set, unchanged retained versions,
unchanged Caddy binary and passing immutable packaged acceptance. Do not infer
exploitability or commercial acceptance from package presence or removal.

### Web build toolchain and layer evidence

The 2026-09-07 web increment retains Caddy 2.11.4 and the existing Alpine image
pin but rebuilds its published module with a pinned Go 1.26.8 build-only image.
Use `GOTOOLCHAIN=local` and preserve upstream module selection. Copy the prepared
filesystem into a fresh layer graph so the replaced binary is not distributed in
lower layers. Require the selected compiler and Caddy release for every observed
copy, plus exact original Go/Caddy notices. Upstream bounded TLS regressions and
both customer-profile acceptance runs must pass on the resulting candidate.
These checks extend evidence integrity without waiving open release-review gates.

Revert the packaging/policy changes to restore the prior development build.
No database migration, data rollback or connector permission change is involved;
customer release still requires its independent security and distribution gates.

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
