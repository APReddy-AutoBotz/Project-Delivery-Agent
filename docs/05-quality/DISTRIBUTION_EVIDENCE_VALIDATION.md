# Distribution evidence validation

Requirements: NFR-SEC-010, NFR-MNT-004, TR-TEST-001/002; AC-MNT-004;
OPEN_SOURCE_POLICY; STORY-004; Issue #5; ADR-014; EXEC-003.

## Npm source notices and physical attribution, 2026-09-08

The current increment fixes twelve identified capture/attribution gaps in existing
image contents. Seven occurrences have complete original MIT notices in the
README files of @tokenizer/token 0.3.0, pg-types 2.2.0 and pgpass 1.0.5. Five API
RxJS entrypoint manifests already reconcile to locked rxjs 7.8.2, whose original
LICENSE.txt is captured. The new policy pins the four source coordinates, archive
integrity/provenance, root and embedded manifest hashes, exact targets and original
notice hashes/sizes. No generic license text or changed package files are added.

The checker requires captured original notice contents, regular-file metadata,
matching SHA-256/size and the correct physical package/layer. Manifest metadata
hashes are matched to the reviewed publisher archive originals. Each occurrence
retains target, image ID, scope, scanner package ID, original manifest and notice
file/layer identities. It reports named-file capture separately from source-pinned
README and parent attribution. Native UNKNOWN entrypoint versions and scanner
license observations remain unchanged; a zero missing-notice count is not legal
approval.

Both scopes perform application lock reconciliation and notice attribution.
Ordinary notice ownership follows the nearest physical manifest and cannot cross
node_modules boundaries. Reviewed embedded manifests may use only their unique
same-layer locked parent; child-specific notices are preserved too. Repeated
coordinates or identical texts do not collapse distinct image/layer occurrences.
Missing selected root/entrypoint manifests or notices fail even if report entries
are also omitted. Unknown inheritance remains uncollected rather than waived.

Schema 4 adds `npm-notices.json` to the 65-file manifest and retains the Go notice
contract. Downloaded validation replays the new calculation from native reports,
checks archived lockfile bytes against their derived inventory, and compares
original notice bundles and recorded review objects in both scopes. Tests cover
source/content/metadata changes, missing captures, wrong parents/versions/layers,
child-specific notices, nested unrelated packages, repeated occurrences,
noncanonical/duplicate/link paths and rewritten retained summaries.

All 75 focused distribution tests passed, including 17 npm cases. One initial
negative fixture reached the earlier retained-review consistency check; the
fixture now keeps that record consistent and proves the intended scope-attribution
denial. No production assertion was weakened. An older local image was rejected
by the existing application-inventory guard because its own workspace manifest
had no version; current diagnostic images were rebuilt for actual scanner checks.
All six current API/worker/operations scope scans passed, preserving original bytes
and resolving the eight/two/two direct-capture or parent-attribution gaps. These
are local diagnostics; BuildKit did not retain clean Git provenance, and full
immutable candidate acceptance remains required.

Local lint, typecheck, all 135 unit tests in 18 files, all seven workspace builds,
13 documentation regressions and documentation traceability passed. The source
register still contains 245 requirements, 91 criteria, 38 stories and 135 planned
test specifications. Required candidate CI, downloaded evidence verification and
an independent non-author review remain final merge gates. No image is pushed or
release approved.

Prior PR #32 completed independent review, all required CI and 64-file immutable
evidence verification before merge; its merged-main CI also passed. Its original
Go notice inventory and compiled binary remain unchanged in this increment.

## Implemented contract

After successful production and customer-composition acceptance, CI runs
`node scripts/collect-distribution.mjs`. It requires the same clean source SHA
and tree, both customer profiles and their exact accepted application/database
image identities. It scans five targets serially: API, worker, web, operations
and PostgreSQL/pgvector. Test-only acceptance and identity images are excluded
from the proposed customer distribution.

Each target gets separate runtime (`squashed`) and `all-layers` native Syft and
SPDX 2.3 SBOMs, full Grype reports, observed original notice bytes, image filesystem
identity and review inventories. Historical files retain their file and layer
IDs; findings retain the supplying package locations. Application/npm-notice and
Go reconciliation use both scopes; static-browser reconciliation uses the runtime view. The
validator checks the ordered image filesystem layers, hashed image configuration,
scanner versions and reported scope, SPDX package correspondence, scan source, vulnerability database
identity/freshness and absence of suppression. The full original lockfile and its
registry integrity inventory are retained. Build-observed runtime packages must
match scanner packages and exact lock entries; versionless embedded module
manifests retain their parent relationship and review-required state.

The Vite build records included npm modules, original nested notice files and
final asset hashes after CSS finalization. It includes Tailwind's generated-style
provenance explicitly. The web image contains the inventory and readable original
notices. Evidence validation compares every recorded asset with scanner file
hashes and rejects omitted JavaScript/CSS. A separate first-party browser SBOM is
scanned and converted to SPDX; it is not represented as scanner-discovered code.
Grype's file-source report does not echo file digests, so an invocation receipt
records its exact input/output hashes and the image-bound browser inventory hash.

`artifacts/distribution-evidence.json` schema version 3 is published only after every target passes
evidence validation. The same run directory contains all source reports and a
SHA-256 file manifest. `node scripts/check-distribution.mjs --evidence-only`
requires both scopes and rejects missing, changed, unexpected or unsafe file references. It
also revalidates both Go notice reports against their retained native SBOMs and
the exact `caddy-modules.json` inventory. Schema-2 evidence cannot satisfy this
expanded contract. The default check
refuses release: collection is not a completed license review, vulnerability
disposition or trusted signature. There is no option to approve distribution by
setting a boolean, emptying a blocker list or overriding scanner configuration.

## Validation state

Local diagnostic probes use an existing image and built browser assets; they
are not candidate acceptance. The pinned tools identified 385 packages and
captured 388 original notice files in the API probe, with 242 unreviewed scanner
matches. Eight browser components were scanned with zero matches in that probe.
These observations are version/database-specific and are not vulnerability
dispositions or release claims. Local lint/typecheck, all seven workspace builds,
architecture/OpenAPI/direct-dependency gates and 13 documentation regressions pass.
The new negative tests cover image/package substitution, stale or filtered scans,
missing notices, browser asset changes and lockfile reconciliation. Exact-candidate
remote artifacts are recorded after the required checks complete.

PR #24 merged reviewed `a720ec57f144864c4bd9fcae433ebfefdccf974b` as
`438cc13bd5d04d6253ad96c699fe0be09f3ea295` after independent approval and all
[matching checks](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34051843789).
Its downloaded schema-1 bundle has 37 verified files, five accepted image identities
and eight browser components. Exact source/tree, test results and observed counts
are in the [immutable acceptance record](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/24#issuecomment-5561360890).
Merged-main CI 34052815887/34052815843 also passed. This is historical evidence;
the schema-2 runtime/layer increment requires new accepted images and matching CI.

## Runtime packaging gate

API/worker preparation removes global npm/Corepack/Yarn payloads and commands.
The final runtime copies that cleaned filesystem into a fresh layer graph while
preserving its explicit execution configuration. Operations now retains Node's
original bundled notice. `scripts/distribution/runtime-policy.json` binds Node
24.19.0 to the unchanged publisher notice hash. Both scanner scopes reject a
missing/changed notice, unexpected Node version, package-manager package record,
global payload or command link, including material hidden by a later deletion.

Regression tests exercise scope substitution, missing file/package layer identity,
overwritten notices at the same path, retained commands/payloads, relocated tool
packages and notice/version drift. The local runtime-only probe is diagnostic;
the full production harness must still pass on the candidate images. No reported
match is waived, and remaining OS/ingress findings are not declared resolved.

The local runtime-only build passes restricted UID/GID 1000 execution and original
notice hash checks; both scopes report 93 packages, 101 notice files and 224
unresolved scanner matches. A real intermediate-stage negative control has no
package managers in its runtime view but retains them in lower layers: the runtime
check passes and the all-layer check rejects it. The fresh final runtime passes
both checks. These are diagnostic builds, not full candidate acceptance.
One existing local health test exceeded its 20-second timeout while scanner
processes were active. After scanning finished, the unchanged full unit suite
passed all 72 tests; no timeout or assertion was weakened. Matching remote
application and packaged checks remain required for the candidate.

## Remaining release gates

### Compiled Go notice increment

Requirements NFR-SEC-010 / AC-MNT-004; Issue #5, ADR-014 and EXEC-003. The pinned
inventory contains Caddy plus 143 compiled dependencies, with exact versions/h1
values and 197 original notice paths/hashes (994,442 bytes). The Go build helper
checks binary bytes/build metadata, independently rehashes exact cached ZIPs and
copies original attribution under network isolation. No source/cache/helper
executable is shipped. The index records ZIP SHA-256 separately from content h1;
neither cache metadata nor ZIP encoding is treated as a substitute for content
verification. All modules currently have matching attribution files.

The collector's Go tests cover original CRLF bytes, reordered/recompressed ZIPs,
source/notice/h1 tampering, nested-notice omission, unsafe/duplicate/link paths,
unsupported encoding/size, module replacement and compiler/settings drift.
JavaScript tests cover both scopes, module identities, altered original bytes,
omitted manifest/file pairs, mismatched binary/index/layers, extra lower-layer
copies, source leaks, inventory drift and rechecking retained reports. Identical
texts retain separate module identities. JSON/source files such as the verified
mergo `testdata/license.json` are excluded by the documented matcher.

The first local offline metadata lookup failed because `go mod download` attempted
a module lookup with `GOPROXY=off`. Direct exact-cache ZIP reads succeeded under
the same Docker network isolation while retaining independent compiled/pinned h1
checks. All five Go test groups passed, and the build collected the expected 144
modules and 197 files. The 58 JavaScript distribution tests passed. A diagnostic
image built before inventory formatting was correctly rejected for a stale
inventory-byte hash. After rebuilding with the formatted inventory, both native
image scopes passed: 144 modules and 197 original notices, unchanged package
versions/Caddy/BusyBox/trust-store/root-notice hashes, and rejection of the prior
root-notices-only image. The diagnostic runs used UID 1000, a read-only filesystem,
no network, dropped capabilities and no new privileges. They do not replace
complete immutable candidate CI acceptance.

Local lint, typecheck, all 118 unit tests in 17 files, seven workspace builds and
13 documentation regressions passed; the focused distribution suites passed 58
tests. Documentation validation covers 245 requirements, 91 criteria, 38 stories
and 135 test specifications. Default CI execution, packaged customer profiles,
all source-bound evidence files and a fresh non-author review remain final gates.

Schema 3 retains the exact module inventory in its file manifest and requires
image-bound Go notice reconciliation separately from npm `missingPackageNotices`.
Native scanner license observations remain unchanged and legal review stays
mandatory. This source-module superset does not establish which nested asset,
platform, header or generated-data terms apply. Complete repository, packaged
customer and downloaded artifact gates are required before merge; this increment
does not complete AC-MNT-004, vulnerability dispositions or trusted signing.

### Web transfer-tool increment

Requirements NFR-SEC-010 and AC-MNT-004, with NFR-SEC-003 compatibility retained;
Issue #5, ADR-014 and EXEC-003. Remove unused curl and the exact nine-package
closure recorded in FOUNDATION_IMAGE_REGISTER.md before copying the prepared
filesystem into the final web image. Preserve all retained versions, Caddy binary,
publisher tags/notices, BusyBox/wget and the trust store. The pure-Go compiler
contract is required so native-library assumptions remain explicit.

The focused distribution suite passes 47 tests. New negative controls cover
removed package/source records, relocated commands and libraries without package
records, missing policy and changed CGO settings. Positive controls retain the
health probe, trust store and shared OpenSSL libraries. Required final validation
includes the full repository suite, both image inventory scopes and both customer
profiles against this candidate's immutable images. Reject unexpected package
removals or upgrades and compare retained binary/notice hashes with PR #30.

Local lint, typecheck, all 107 unit tests, seven workspace builds, 13
documentation regressions and documentation validation passed. One initial
parallel run produced no startup-control output at its child-process time limit;
the unchanged isolated control and complete suite passed with two workers.
The final focused tests also passed after separating package-name and
package-origin controls. Default CI execution remains required before merge.

PR #31 subsequently merged reviewed `92f184d` as `d546e14` after all required
candidate checks, independent review and downloaded evidence verification passed.
Its final candidate run passed 107 unit, ten database/API, eight browser and
17 packaged groups; all 63 artifact hashes and both customer profiles verified.
Merged-main CI passed. The public PR record links the CI and review evidence.

Package removal is not an exploitability verdict. Keep complete scanner output
and all unresolved release gates; no suppression or legal waiver is introduced.
No database migration, connector scope or authorization change. Roll back through
a reviewed packaging revert, with no database recovery needed.

### Web runtime toolchain increment

PR #30 merged as `62bcbe6` after exact non-author review of `c7bbfb6`, successful
[foundation CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34148350613)
and matching documentation CI. All 63 artifact hashes, five image identities,
eight browser components, both customer profiles and 17 packaged groups verified.
CI passed 103 unit, ten database/API and eight browser tests, seven builds and
13 documentation regressions. Subsequent
[merged-main CI](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/34149934868)
also passed. These results do not close the remaining distribution gates.

Requirements NFR-SEC-003/010 and AC-MNT-004, tracked in Issue #5 and EXEC-003.
The web build retains Caddy 2.11.4 and its upstream module versions, uses the
pinned Go 1.26.8 toolchain and preserves original Caddy/Go notices. A fresh final
layer graph excludes the replaced binary. Both scanner scopes now require every
observed Caddy/Go copy to match the compiler/release policy and every protected
notice to match its original hash; missing evidence is rejected.

Local lint, typecheck, all 103 unit tests, all seven workspace builds, 13
documentation regressions and documentation validation passed. The first direct
module build reported an unknown Caddy display version; the build now supplies
the upstream-supported version linker field and asserts its output. Actual
module/compiler identity remains independently checked from binary metadata.

A binary dependency comparison also caught the publisher's omitted storage
backends. The build retains its `nobadger,nomysql,nopgx` tags; runtime evidence
rejects absent or changed tags. The final image must retain the original
dependency versions and contain no additional backend modules.

The build executes upstream TLS record-limit and adjacent protocol regressions
with a bounded timeout. These are toolchain tests, not a load test of a deployed
service. The focused distribution suite passed 43 tests, including old extra
runtime copies, missing compiler/module evidence, incorrect entrypoint and
missing/substituted notices. Full candidate repository, browser and both-profile
packaged checks remain required before merge. Their immutable image evidence
must match this candidate; earlier-image evidence cannot satisfy this change.

Detailed finding assessment is private. Remaining scanner observations and
release review gates are not waived. No database, authorization or connector
scope change is included. Restore the previous development image to roll back;
customer release requires independent acceptance of the selected image.

STORY-004 / CI-MNT-004 are still in progress/planned. R0 remains 3/5 and R1 0/33.
Complete adoption/registry integrity review, OS and transitive license decisions,
missing original notices, complete Node bundled component reconciliation, compiled
pgvector and Caddy dependencies, review of distributed lower layers, vulnerability triage/remediation and
trusted release signing remain required. The existing acceptance runner continues
to emit `distributionAccepted: false`; collection never pushes an image or
activates customer services. Raw scanner matches are not validated exploit paths.

## Impact and recovery

Private application manifests identify the existing foundation version 0.1.0;
browser builds add static inventory/notice assets. CI adds development-only pinned
tools and report artifacts. API/worker package-manager removal changes their
filesystem and image graph; operations adds the existing binary's original notice.
Business behavior, application dependency and Node/base-image versions,
permission policy, schema, migration history and connector scopes are unchanged.
Revert this tooling/build/workflow increment through review to roll back; no
database rollback is required. The recovered local database/preview is preserved.
