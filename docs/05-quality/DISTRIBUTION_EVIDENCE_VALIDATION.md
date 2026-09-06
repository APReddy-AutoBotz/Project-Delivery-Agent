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

Each target gets native Syft and SPDX 2.3 SBOMs, a full Grype report, observed
original notice bytes, image filesystem identity and a review inventory. The
validator checks the ordered image filesystem layers, hashed image configuration,
scanner versions, SPDX package correspondence, scan source, vulnerability database
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

`artifacts/distribution-evidence.json` is published only after every target passes
evidence validation. The same run directory contains all source reports and a
SHA-256 file manifest. `node scripts/check-distribution.mjs --evidence-only`
rejects missing, changed, unexpected or unsafe file references. The default check
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

## Remaining release gates

STORY-004 / CI-MNT-004 are still in progress/planned. R0 remains 3/5 and R1 0/33.
Complete adoption/registry integrity review, OS and transitive license decisions,
missing original notices, Node's bundled components, compiled pgvector and Caddy
dependencies, distributed lower layers, vulnerability triage/remediation and
trusted release signing remain required. The existing acceptance runner continues
to emit `distributionAccepted: false`; collection never pushes an image or
activates customer services. Raw scanner matches are not validated exploit paths.

## Impact and recovery

Private application manifests identify the existing foundation version 0.1.0;
browser builds add static inventory/notice assets. CI adds development-only pinned
tools and report artifacts. Business behavior, runtime dependency versions,
permission policy, schema, migration history and connector scopes are unchanged.
Revert this tooling/build/workflow increment through review to roll back; no
database rollback is required. The recovered local database/preview is preserved.
