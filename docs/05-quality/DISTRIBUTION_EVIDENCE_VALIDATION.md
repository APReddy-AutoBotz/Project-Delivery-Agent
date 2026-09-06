# Distribution evidence validation

Requirements: NFR-SEC-010, NFR-MNT-004, TR-TEST-001/002; AC-MNT-004;
OPEN_SOURCE_POLICY; STORY-004; Issue #5; ADR-014; EXEC-003.

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
IDs; findings retain the supplying package locations. Current application/browser
reconciliation consumes only the runtime view. The
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

`artifacts/distribution-evidence.json` schema version 2 is published only after every target passes
evidence validation. The same run directory contains all source reports and a
SHA-256 file manifest. `node scripts/check-distribution.mjs --evidence-only`
requires both scopes and rejects missing, changed, unexpected or unsafe file references. The default check
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
