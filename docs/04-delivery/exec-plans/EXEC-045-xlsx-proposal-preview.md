# EXEC-045: XLSX preview and reviewed proposals

Status: the packaged XLSX browser and recovery stages have merged. This
extends the approved spreadsheet journey under FR-CON-006/007 and Issue #7.
The existing software acceptance of AC-CON-005 uses the CSV alternative.
Customer-release review remains open.
Original19/20 capture remains stopped, and OD-013/014 remain in force.
Spreadsheet saves remain reviewed import proposals. Canonical facts retain
their existing source-authority and approval rules.

## Current increment

PR #144 merged as `d344d3b83c11a8991d608016be13c77599386673`; its reviewed
head `9e0b9f62913b4de014f92b79075d24fa2a1bf14c` and actual merge share tree
`bab4d725cb201a8ce12c979b0d7f22ae42305a27`, with ordered merge parents
`56688d3e58dccd66883753eb17ffe1992d18ad7d` and that head. Candidate Foundation
`41231014184` and Documentation `41231014207` passed. Actual post-merge
Foundation `41233129454` and Documentation `41233129581` were still running at
this checkpoint. The earlier Foundation browser failure remains documented in
EXEC-046; this merge does not enable the unranked API/view or accept a story.

An unwired synthetic interpreter accepts one explicitly declared visible sheet,
whose exact name equals the mapping, with contiguous physical coordinates and
literal text cells. It rejects omitted or unsupported declarations and applies
the decoded-cell byte limit during traversal before invoking the grid mapper.
This deliberately rejects multi-sheet inputs; it is a smaller experimental
subset than the eventual selected-sheet requirement. Its declarations are
caller assertions, not proof about a workbook's ZIP/XML parts, formulas, hidden
content, encryption or external references. It neither accepts workbook files
nor creates a receipt or persists anything. Bounds do not prevent a caller from
allocating a large descriptor before the function is called, and arbitrary
in-process Proxy traps are not isolated. A future adapter must prove descriptor
fidelity and enforce independent input, memory, concurrency and deployment
isolation limits. Formula-like literal handling is inherited from mapped text
fields and is not a general spreadsheet-injection guarantee.
The focused Node 24 CSV, grid and synthetic descriptor suites passed 70 tests,
including the combined 1,001-row by 64-column declaration and exact decoded
byte boundary. These local unit tests are not workbook or runtime-isolation
evidence and do not accept an XLSX criterion.

The deterministic CSV mapping and row comparison now share an internal routine
with a separately validated, bounded string-grid entry point. CSV configuration,
baseline and parsing precedence and its existing output are unchanged. The grid
path checks dense own-data arrays, exact headers, rectangular rows, valid Unicode,
dimensions, per-cell limits and aggregate UTF-8 content before mapping, and copies
the accepted arrays. Focused CSV/grid tests passed locally; these tests do not
parse a workbook, prove process isolation or establish source provenance.

This grid is not an untrusted-workbook security boundary: arbitrary in-process
JavaScript Proxy traps and property-heavy objects can still execute or allocate
while being inspected. A future adapter must supply bounded decoded data from an
independently reviewed isolation boundary. Grid data row index zero maps to
physical worksheet row 2 only if the selected sheet's first physical row is the
header and all intervening rows are preserved. The saved receipt ordinal is a
separate one-based data-row ordinal. Do not silently shift sparse coordinates or
equate the two.

## Required workbook and persistence work

The offline XLSX archive reader provides the first byte-level step towards
FR-CON-006/007. It uses pinned yauzl 3.4.0 for central and local ZIP headers and
Node 24 for bounded raw DEFLATE and CRC-32. It copies at most 1 MiB of input
and admits at most 64 ASCII XML or relationship parts, at most 4 MiB per part
and 8 MiB of total expanded content. A part must account for its complete
declared compressed extent and match its actual length and CRC. The single-
disk archive has no comments, extra fields or ZIP64, uses stored or DEFLATE
entries. Data descriptors must carry the ZIP record signature and match the
sizes and CRC. Local records tile the bytes before the exact central directory. Case-insensitive
duplicate names, file/directory name collisions, nonfile entries, unsupported
methods and inconsistencies reject the entire archive.

The checked workbook fixture was authored with the Codex spreadsheet bundle
26.1116.12010. Its Portfolio sheet contains one header row and two fictional
rows with literal text IDs and forecast dates. The exported workbook has
SHA-256 `ea4fb60074ed77ef1de8af80a620ef87e4e07247cab57cb894d107f96a4895f4`.
Tests compare the digest of each expanded part with an independent
standard-library ZIP read. Fixtures also cover the allowed ZIP record forms
and finite bounds. CRC detects corruption
and establishes no authenticity. The archive reader neither interprets
relationships and XML nor proves a workbook's suitability for mapping. It
opens no filesystem entries and returns exact opaque part bytes only to its
offline caller. This synchronous inflate is for the offline boundary only.
The live path needs independently validated XML/OPC semantics, a killable
worker with resource bounds and pre/post authorization, and durable receipts
bound to the original workbook and selected mapping before any import.

### Offline worksheet semantics

The offline worksheet decoder builds on the archive reader for FR-CON-006/007.
Its first supported profile is a minimal Transitional SpreadsheetML package
with one visible worksheet and optional plain shared strings. The workbook,
package relationships, worksheet relationship ID, exact configured sheet name
and part content types must agree. All admitted archive members must belong to
this graph. The profile requires physical row 1 to be the header and contiguous,
rectangular coordinates. A cell contains explicit inline text or a canonical
index into the plain shared-string table. When present, shared-string count
attributes must agree with the actual table and total inline and shared cells.
Expanded string uses count against the grid byte limit. Leading zeroes, XML
text and Unicode are preserved. Unsupported
OOXML escape sequences, cached string types, formulas, hidden rows and sheets,
merges, external relationships, metadata outside this profile and missing
coordinates are rejected. Dates use literal text and the existing mapped date
validator.

The tests construct workbook ZIP bytes from the accepted OPC profile and pass
decoded cells through the existing proposal mapper. The archive-only exporter
fixture is outside the semantic profile because it has styles, theme and a
different cell storage type. General Excel producer interoperability and a
user-facing export template still require evidence.

The offline decoder checks fatal UTF-8 and XML 1.0, rejects DTDs and matches
expanded names. The archive bounds each XML part before parsing. An attribute
or text token can allocate before its callback, and a bounded worksheet tree
can be resident in memory. Live activation requires proven killable isolation
and resource bounds, receipt binding to original bytes, and current
authorization before processing and again under persistence locks.

See the [SpreadsheetML structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document)
and [ECMA-376 OPC specification](https://ecma-international.org/publications-and-standards/standards/ecma-376/).

### Explicit Excel text profile

The separately selected offline `excel-text-v1` profile supports the observed
Excel 16.0 text-only workbook variant. Local ZIP growth hints are allowed only
on the five named package metadata parts, with the observed 256- or 512-byte
zero-filled reservations and exact header, signature and length checks. The
central directory, payload sizes, contiguous local extents, expansion and CRC
checks still apply. See ECMA-376 Part 2 §7.3.8.

The profile admits two closed package shapes for one visible worksheet and plain
shared strings. The native shape carries ten parts, including the exact verified
style and theme pair. The normalized text-only shape carries eight parts and
omits both presentation parts, relationships and overrides. Partial or orphaned
presentation data fails validation. Only the bounded metadata forms are admitted, including
the local path hint in one namespace-resolved compatibility branch. The decoder
discards document properties, revision data and path hints. The required sheet
name, dimension and row spans agree with the actual grid. Every cell uses a
plain shared string and a physical coordinate in the dense rectangle. The
portable profile remains independently selectable and the parser never selects
a profile by retrying a rejected workbook.

Two locally saved Excel workbooks proved exact text, leading-zero identities and
physical row order. A copy with synthetic project IDs produced two typed date
proposals through the existing mapper. A first-party normalized XLSX fixture
assembled in unit tests exercises the same decoder and mapper. It also checks
closed package graphs, sheet and coordinate consistency, literal cell rules and
presentation rejection. Native Office files and their metadata stay private.
Native producer evidence comes from the separate pinned local run.

This is a restricted offline producer profile. Other Excel presentation defaults,
numeric cells, additional sheets, custom style forms and complex workbook
features remain outside it. This increment adds no runtime dependencies,
connector scope or migrations. Reverting the incremental offline reader
commit restores the portable profile without data recovery. Deployment
isolation, current authorization and durable workbook-specific receipt
binding gate live use.

[PR #174](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/174)
merged the Excel-text profile as `21cd953eccb5d10fe328bac4159cbdc0a876c34a`.
The reviewed candidate `71bf7ad62a7539bf7ae15b33a39154063a614672` and the
actual merge share tree `bbe0d21294e7f00af77798bd2c65689817877a4a`. Candidate
Foundation `44421751918` and Documentation `44421752314` passed, as did
actual-main Foundation `44426387519` and Documentation `44426387717`.
Independent source and original-evidence reviews passed. The profile stays offline.

### Packaged parser isolation fixture

The next increment exercises the offline parser in a disposable Linux Compose
project on Foundation runners. A dedicated unprivileged decoder and an inert
caller use a pathname socket in one per-project named volume. The caller mounts
the volume read-only. Its shared group can traverse the directory and connect.
A UID outside that group is denied. The fixture uses filesystem ownership and
container process identities to establish this case. Socket peer credentials
for a future API require separate evidence.

The decoder starts with loopback-only networking, a read-only root, no
capabilities, no-new-privileges, 256 MiB memory with no swap, a half-CPU quota
and 32 tasks. The code observes cgroup v2 settings inside both participants.
The build context stages only the reviewed offline decoder, fixture sources,
and their four already locked dependencies. The fixture has no customer
configuration, secrets, product volumes, database connection or image
publication. Synthetic wire cases exercise the portable and normalized
Excel-text profiles. See Docker's [none network driver](https://docs.docker.com/engine/network/drivers/none/)
and [runtime resource limits](https://docs.docker.com/engine/containers/resource_constraints/).

One connection can occupy the decoder slot. The server holds it through
request EOF, child execution and bounded local write completion. The caller
applies a separate deadline before accepting a complete correlated frame.
Tests pause the receiver to verify incomplete output at the server deadline.
Emitting a response requires a clean child close. An interrupted group retires the
container after an attempted group kill. A controlled descendant reports that
it started before the timeout test checks terminal container state. An
occupied endpoint is refused and only a fresh project volume is used for the
replacement. The runner removes its own resources before emitting a finite
evidence record. Limits observed here establish fixture settings. CPU and
memory exhaustion and a compromised child or supervisor require separate
tests. The socket owner still has the decoder volume mounted.

The fixture uses no application, auth or receipt surface. Acceptance and
release totals remain open. Removing this fixture and its Foundation job
requires no application rollback or database recovery. Live use still needs
proof on both customer deployments, transactional reauthorization and durable
workbook-specific receipts.

An unregistered local slot model exercises admission around the synthetic frame
codec. It reserves declared input bytes before pulling a queued stream, limits
one local lease, checks an absolute monotonic deadline, correlates a response
to the job and generation, and quarantines every leased attempt until the
broker-observed pulls, exchange and iterator cleanup have settled and an injected trusted reset
acknowledges the broker-selected next generation. A timed-out caller can return
while ignored cancellation leaves the slot and reservation quarantined. Close
permanently prevents further leases; once observed work settles it releases its
own job references. It does not prove physical cleanup. The
bounded process-local counter prevents reuse within one slot instance, not across
process restarts or replicas. Up to 65,536 yielded input chunks, including empty
ones, are permitted; an additional iterator call is needed to observe EOF.

This model trusts its in-process codec, stream, port and reset adapters to return
control. It cannot interrupt synchronous JavaScript, certify a reset, identify a
peer, constrain other replicas or account for caller/transport-owned allocations.
For a single active job, the broker owns up to 1 MiB for accumulated input; the
experimental request encoder also makes bounded payload and frame copies of up to
1 MiB each plus its header, while the response decoder may allocate up to 4 MiB.
These figures do not include runtime overhead, incoming chunks, transport buffers,
or the opaque response after it is handed to the caller. Reservation is a limit
on declared queued and active input, not a total process-memory guarantee. The
slot has no production transport, process supervisor, upload route, authorization,
parser, provenance or receipt. Sheet names and workbook bytes are sensitive even
when the worker receives no actor or customer ID. Real customer inputs remain
disabled until the separately reviewed deployment and semantic gates below pass.

The framing dependency merged as `bd5da79e61864263a37041089c68b67a30812d7a`.
Its actual post-merge Foundation run `41267998578` and Documentation run
`41267998589` passed. This slot model still requires independent final review
and fresh current-base hosted validation; those results do not approve workbook
input or close any release hold.

An additional unconnected synthetic framing codec models one frame per
half-closed stream. A four-byte big-endian length precedes a canonical
ECMAScript JSON/UTF-8 array header and a binary payload. Request and response
tags are distinct; their lowercase 32-hex job and generation identifiers are
syntax only. Request headers also bind parser token and exact sheet; responses
must match independently supplied job/generation and use `OK` with a nonempty
body or `REJECTED` with an empty body. Header bytes are limited to 4,096,
request payloads to 1 MiB, responses to 4 MiB, and each decoder to 65,536 push
calls including empty chunks. The decoder allocates bounded buffers, requires
exact EOF, rejects noncanonical/malformed/trailing frames and never returns a
partial payload. It copies incoming views and releases its references on
completion or failure; this is not a claim of physical memory erasure.

This deliberately limits supported fragmentation and rejects foreign-realm
Uint8Array objects and all shared buffers; integration would need to normalize
input and account for external chunks, encoded frame copies and per-slot memory.
Identifiers do not prove randomness, freshness, peer identity or authorization.
The codec opens no socket and supplies no deadline, kill/reset mechanism,
backpressure, cross-replica admission, descriptor validation or proof that a
parser interpreted bytes faithfully. It is not a production protocol or
isolation boundary; Proxy side effects and caller-allocated input are outside
its guarantees. The focused Node 24 CSV, grid, descriptor, identity, baseline,
selection and framing suites passed 118 synthetic tests, including independent
fixed vectors, split/EOF and work bounds, malformed/correlation cases, and
copied hostile byte views. Scoped domain typecheck and lint passed. Real
deployment tests and an independently enforced slot lifecycle remain required
before any upload path is enabled.

A further unconnected synthetic selection simulation hashes a separately
domain-tagged full manifest, distinct from the synthetic preview-request
identity. The manifest contains asserted customer/source/sheet, configuration
and mapping revisions, parser token, parent ID, workbook digest, baseline tag and
digest, project list, and every contiguous receipt ordinal with its state,
operation, safe error codes, project/key, content-availability assertion and
typed proposals. Exact ordered JSON/UTF-8 bytes are bounded to 1 MiB. The
simulator deep-copies both manifest and selection before awaiting WebCrypto,
computes the manifest SHA-256 from its private bytes, requires exact asserted
scope/parent/digest and sorted unique nonempty ordinals, and returns detached
synthetic CREATE/UPDATE/UNCHANGED plans only if every selected row is ACCEPTED,
error-free and asserted available. Unavailable rows cannot carry proposal
content; an UNCHANGED row may have no proposals. A mixed selection fails whole.

This simulation checks only its narrowly specified caller assertions. It does
not establish an authorized actor, a sealed parent or real retention, native
proposal hashes, source revision/projection links, mapping compatibility,
workbook identity or source truth. Workbook and baseline digests are asserted,
not recomputed from real data. The asserted project list is not authorization.
It is not a production receipt/replay contract or a sandbox for Proxy traps or
already allocated input. No API, parser, persistence, fact publication or story
acceptance follows. The focused Node 24 CSV, grid, descriptor, identity,
baseline and simulation suites passed 105 synthetic tests; exact-candidate
review, parent merges and hosted validation remain required.

An additional unconnected synthetic baseline codec encodes an ordered JSON-array
tuple in ECMAScript UTF-8 with domain `pdaa.synthetic.xlsx.baseline.v1`, exact
customer/source/sheet and a positive 32-bit mapping revision. It distinguishes
ABSENT from PRESENT with zero rows and includes every ordered row key, project,
field type and typed value. Revision is passed to the existing baseline schema
as its canonical decimal string; negative zero and nonfinite numbers are
rejected. The serializer measures actual escaped JSON bytes, punctuation and
UTF-8 before joining output and rejects anything over 1 MiB. Equal semantic
baselines in a different order intentionally yield different synthetic bytes.

The caller supplies the root scope and rows: the codec cannot establish their
original scope, config compatibility, required fields, project membership,
workbook contents, authority or authorization. The baseline schema alone admits
`empty` typed values even though spreadsheet mappings cannot declare that type.
The stricter synthetic customer/source UUID format and integer revision do not
change existing CSV rules; row project IDs use the existing baseline schema.
This is not a production wire format or a sandbox against Proxy traps or input
already allocated by a caller. A future manifest and selection simulation must
bind and validate its own asserted context and outcomes; real retained receipts
still need independently reviewed transactional and provenance design.
The focused Node 24 CSV, descriptor, identity and baseline suites passed 89
synthetic tests. No workbook parser, API, persistence or story acceptance is
introduced by this codec. The first scoped lint invocation could not find ESLint
in this worktree; a retry using the existing workspace ESLint and configuration
passed. Domain typecheck and documentation validation passed.

An additional, unconnected identity experiment emits synthetic UTF-8 bytes, not
receipts. The preview format is the ECMAScript `JSON.stringify` serialization of
the fixed array `["pdaa.synthetic.xlsx.preview.v1", customerId, sourceId,
workbookDigest, sheet, parserContract, configRevision, mappingRevision, baseline]`.
Baseline is exactly `["ABSENT"]` or `["PRESENT", digest]`. The distinct selection
array is `["pdaa.synthetic.xlsx.selection.v1", customerId, sourceId,
parentReceiptId, previewDigest, rowOrdinals]`. UUIDs and SHA-256-shaped values
must be lowercase canonical text; this experiment admits RFC-variant UUID
versions 1 through 8 only and does not claim parity with all existing UUID
sentinels. Revisions are positive 32-bit integers, and
row ordinals are unique ascending one-based data-row ordinals 1 through 1000.
There is no Unicode normalization; sheet text is preserved exactly. In the
synthetic single-sheet dense subset, the physical worksheet row equals the
data-row ordinal plus one; the experiment does not prove a real workbook's
coordinates.

Every digest and receipt ID in this local experiment is asserted by its caller.
It computes no workbook hash, establishes no authority or eligibility, performs
no authorization and saves nothing. The baseline digest has no approved real
canonicalization contract yet. Before production use, a future service must
compute digests from original accepted bytes and validated retained state, bind
the exact parent preview and eligible outcomes, and recheck scope and revisions
under lock. Synthetic vectors do not alter historical CSV identities or prove
replay behavior. The separate domains and examples are experimental, not a
stable production wire format.

Support an explicitly selected visible worksheet whose exact name matches the
saved mapping. Define and present restrictions on hidden rows/columns, merged
cells, sparse coordinates, formulas including cached/shared/array formulas,
external relationships, encrypted or macro-enabled archives, malformed cells,
unsupported workbook types, date epochs and ambiguous numeric identity. A
first implementation may accept only a documented safe subset, reject the whole
workbook on structural ambiguity, and require ISO date text. It must never
evaluate formulas, fetch external links, infer source truth or silently truncate.

Authenticate and establish current project/source-reader scope before expensive
parsing, then repeat full authorization and configuration/mapping checks under
the existing transaction locks before any write. Bound compressed and actual
inflated bytes, entry count, per-entry output, XML structure/text, shared strings,
sheets, rows, columns, cells, output bytes, execution time and concurrency. A
killable isolation boundary must be reviewed for filesystem, network, secrets,
memory and cancellation behavior in the actual customer deployment; a worker
thread or declared ZIP size alone is not proof of those properties. Preserve
generic errors without untrusted workbook content in logs.

An unwired repository preparation seam checks every configured project's current
write grant and source-reader membership, and returns a detached, bounded CSV
fixture snapshot. A separate call rechecks current permissions and revisions
after simulated work. The caller must supply a freshly authenticated actor and
retain the snapshot and source binding in trusted server memory. A matching
snapshot is forgeable and does not establish that earlier authorization or a
parse occurred; revoke/regrant between checks can be missed. Any eventual write
must reauthorize under its own transaction locks. Success is read-only; a
`DENIED` inside the existing wrapper writes a sanitized denial audit, and audit
failure fails closed. Existing preflight reads the source row internally and can
load corrupt persisted scopes before schema bounds; no physical read bound or
deadlock-freedom claim follows. Origin must not enter worker/client payloads or
logs. Native tests for this new seam have not yet run locally and hosted
validation is required before merge. It does not accept workbooks, parse files,
create receipts or publish facts.

No parser or dependency is approved by this increment. The upstream
[yauzl documentation](https://github.com/thejoshwolfe/yauzl/blob/master/README.md)
describes streaming entry-size verification but requires caller-provided
zip-bomb limits; the upstream [saxes project](https://github.com/lddubeau/saxes)
is archived and documents XML-parser limitations. Their licenses and exact
versions, transitive dependencies, notices, vulnerabilities and operational
behavior require independent review before adoption. Do not infer acceptance
from these references or adopt a package solely because its license is permissive.
At the local research checkpoint, registry metadata identified yauzl 3.4.0 and
its pend 1.2.0 dependency as MIT, and saxes 6.0.0 as ISC with xmlchars 2.2.0
MIT. This metadata is not a security or distribution clearance; no package has
been added to the application manifests or lockfile. Node 24's [permission documentation](https://github.com/nodejs/node/blob/v24.x/doc/api/permissions.md)
explicitly does not promise protection against malicious code; do not present a
Node permission flag or ordinary worker thread as the required isolation boundary.

A local synthetic-only archive probe illustrated additional work: the toy
scanner rejected a duplicate name, simple formula tag, DOCTYPE and one expanded
entry over its reduced limit, but accepted a bad CRC and a disagreement between
local and central ZIP filenames. These narrow fixtures neither implement XLSX
nor demonstrate archive security. Validate integrity, relationships, workbook
semantics and actual deployment isolation before enabling any file adapter.

### Immutable XLSX receipt binding

FR-CON-006/007 and Issue #7 require a distinct workbook receipt. The
server-side binding component uses three versioned UTF-8 JSON tuples
and SHA-256. Native XLSX storage will use distinct receipt kinds and byte identity.
Existing CSV receipts retain their original proof contracts.

- The request hash binds the customer, source, authenticated subject, command
  key, supplied configuration and mapping revisions, exact selected sheet,
  immutable parser contract, original byte length and original byte digest.
  A bounded, owned copy provides the input to both hashing and the decoder.
  The adapter will map the persisted `portable-v1` contract to the offline
  reader's `portable` selector. `excel-text-v1` has the same name in both.
  Authorization and admission precede workbook capture. On an existing
  command, use the original parser contract and original request binding
  before new-command revision checks. Reauthorize current and original
  project scope and current source readers before disclosing the result.
  An exact retry uses the finalized result without parsing again. A different
  input binding under the same key conflicts after authorization.
- The preview context hash binds the minted receipt ID, request hash, complete
  sorted project scope and ordered outcomes to the baseline used under lock.
  A verified genesis has an explicit tag. A retained baseline pins its receipt
  ID, sequence and state hash even when it has zero rows. Unavailable,
  corrupt or expired history blocks a new comparison. An advance of the
  baseline changes the context hash while the original request hash stays
  available for replay.
- The selection hash binds the selecting subject and command key to the
  finalized parent context, source scope and unique ascending eligible
  parent ordinals. An eligible ordinal identifies a preview data row, and
  the dense worksheet's physical row is its ordinal plus one. The
  selection subject can differ from the preview subject under the existing
  spreadsheet authorization rules. The transaction checks current grants,
  exact record/projection lineage, live retained content and current
  revisions before a new save. Old metadata can remain replayable after
  lawful redaction if current authorization and proof checks pass.

Contexts store safe row states, ordered error codes, opaque row hashes and
record, revision and projection references with immutable content digests.
The binding contains no raw workbook, cell values or mutable authorization
or availability flags. Values under review remain proposals. Workbook
identity does not establish the upstream authority of a source.

The local component computes and validates these immutable bindings.
The companion mapper checks the workbook request against the authorized
mapping snapshot and uses retained hashed identities with the existing
spreadsheet comparison rules. Workbook row hashes have their own domain
and preserve exact sheet and row-key text. Both offline decoder profiles
exercise this path with actual synthetic workbook bytes. A missing
baseline fails closed even though a verified empty baseline permits new
rows. Renamed or moved identities retain the existing review safeguards.
An accepted identity with only empty optional values can retain a
`NONE` outcome and an empty proposal hash. Selection excludes that row.
The local migration adds PostgreSQL equivalents of the three tuple hashes.
The migration owner can evaluate a bounded receipt projection and compare its
digest with the TypeScript result. Clean and populated upgrade rehearsals check
parity, and restore tests exercise the owner-only grants after `pg_restore`
recreates the functions. The database inventory remains at 87 business tables.
Customer recovery uses the preceding release and its pre-upgrade backup.

The next native storage increment must bind those digests to actual retained
rows, source scope and record lineage under lock. Exact retry, revocation,
retention and recovery of the resulting receipts remain launch gates before
adding an application entry point. Original19/20 capture stays stopped.

### Native workbook source and initial comparison state

The local migration 31 adds an immutable workbook source family selected by the
migration owner. The source, workbook mapping, PMO authorization, audit and
empty comparison state are committed together. Activation binds the exact sheet,
parser profile and mapping revision. The application role uses the legacy
source configuration and receipt contracts while workbook activation is dormant.

Workbook comparison state has a dedicated UTF-8 digest domain. Its sorted
identities and mapped-field projection references use the same structural
rules as the CSV comparison, including carry-forward and stable record and
project identity. PostgreSQL computes the empty state directly from the sealed
mapping. Recovery validates the stored genesis and reconstructs the finite
function and table grants. The preview receipt writer and comparison history
append still require a native transaction and dedicated validation.

### Native preview receipts and retained comparison state

Migration 32 adds a private `XLSX_PREVIEW` receipt path for the migration owner.
Each context binds the workbook digest, its exact predecessor, the captured
project scope and the stored outcome and projection revisions. It writes the
context and advances the comparison head in the same transaction. A rejected
append rolls back the receipt, audit, scope and state. Fresh appends verify
live retained projection content. Historical validation verifies the immutable
proof after lawful redaction and walks every context during restore.

The synthetic validation fixture creates a valued result, an update with
partial field carry-forward, and an empty result that retains the prior state.
It checks the native hashes against TypeScript, rolls back a forged overlay and
checks an earlier receipt after later previews advance the head. Receipt birth
locks projects and grants before retention, source and head. The fixtures verify
serialization, lawful redaction, grant revocation and restore rejection of
corruption in an older context or captured project scope.

### Exact native preview retry

Migration 33 adds an internal, read-only receipt probe for the API database
login. The service checks authenticated actor role claims against live grants
and source readers for the current and captured project scopes before hashing
workbook bytes. The retry uses the retained parser contract and submitted
request fields. It returns the prior receipt only when the fingerprint and
immutable context match. Advancing the comparison head or changing the source
configuration leaves an exact retry available while access remains current.

The synthetic acceptance fixture uses a direct API login and checks exact
retry, changed bytes and request metadata, configuration and grant changes,
contention, and the absence of comparison writes. Bootstrap and restore
reconstruct the finite function grant. Packaged restore checks that grant in
quarantine. A separate synthetic PostgreSQL copy permits a direct API login
for replay across restore, lawful redaction and context corruption checks.

An internal fresh-command decision reads only the parser contract from the
exact sealed XLSX configuration while the authorization transaction still
holds the source lock. The decision uses the existing API database grant and
leaves workbook bytes untouched. A retry returns the stored receipt metadata.
The synthetic API-login fixture checks both results, denied access, stale
request fields and stable comparison state.

### Trusted workbook comparison baseline

The database-owner loader reauthorizes the actor and locks projects, grants,
retention, source and head in the native append order. It verifies the sealed
mapping, current predecessor and full captured project scope before loading
projection values. Genesis and a finalized empty head remain distinct. Each
returned value binds to an authorized project, exact record and projection,
and the field and type in the head dictionary. Bounds apply to the referenced
content and the serialized baseline. A changed configuration, missing proof,
or expired or redacted value makes the baseline unavailable.

This read uses the existing database-owner transaction and creates no
receipt. Its result stays inside the transaction that will consume it. Native
fixtures verify genesis, retained empty state, partial carry-forward, role
denial, stale configuration, redaction and restore.

### API-role native workbook preview transaction

Migration 34 adds two fixed database calls for the existing API login. The
repository checks exact replay before reserving a decoder slot. For a fresh
command it copies the bounded workbook and decodes it outside the database
transaction. In one short transaction, the first call reauthorizes the actor,
locks the source and complete comparison scope, and loads the sealed mapping
and retained fields. The in-process mapper derives safe outcomes and a separate
versioned row-content digest from normalized cell values.

The finalizer rechecks authorization, exact configuration, live retention
and the predecessor before writing proposal content, outcomes, audit, receipt
and head atomically. A command that raced during decode leaves the write
transaction and repeats exact replay. The database receives only typed
proposals, safe outcomes and hashes. The native append guard checks the result.
The acceptance fixture uses the actual API login with a bounded synthetic
decoder adapter. It exercises capture, deduplication, grant revocation during
decode, atomic rollback, and reconstruction of the finite grants at restore.

The preview writer checks cancellation when its write transaction begins,
after the locked snapshot is available and after the finalizer returns
inside that transaction. Cancellation observed at these points leaves no
preview receipt or head advance. If cancellation arrives after the
transaction callback returns, resolve an uncertain outcome through the
existing exact retry. The database deadlines still bound pending SQL.
The native fixture signals cancellation at each boundary, including after
the finalizer has written a receipt inside the transaction, and checks
that the transaction rolls back.

The API-owned client uses the selected sheet, sealed parser profile and
owned bytes. It checks the decoder credentials before sending bytes, binds
the bounded response to a one-use correlation ID, and retires after an
unconfirmed transport or cleanup failure. Exact retry resolves the durable
receipt ahead of decoder admission.

### Decoder-only runtime package

An allowlisted context stages the parser, worker, supervisor and socket
service with the four locked parser packages. Its manifest binds the staged
file contents, package lock and Dockerfile. A separate Compose project
validates the built image with networking disabled, a read-only root,
dedicated identity, a private cgroup and fixed resource limits.
The one-shot initializer prepares the volume before the decoder starts.
Callers use a read-only socket mount.

The service stops admission on shutdown and removes its ownership marker
after the active exchange and socket close settle. An abnormal stop leaves
an occupied volume requiring a trusted replacement. The runtime-image
check uses synthetic workbooks for both profiles, verifies the manifest
and the read-only caller boundary, and checks clean and abnormal restart.

### Opt-in customer API attachment

The XLSX customer overlay selects a dedicated API image with the
root-owned peer-checking executable and mounts the decoder's socket
volume read-only. The API verifies its service identity and the
fixed mount and executable metadata at startup. The native bridge
checks the connected decoder UID and GID before forwarding bytes.
The decoder carries no network or database configuration. The API
keeps the existing production database role and uses the sealed
parser profile.

The synthetic customer rehearsal uses the existing bundled and
external PostgreSQL configurations. It loads the production API
composition, uses both workbook profiles over the packaged bridge,
and checks the database login, TLS, exact retry, mismatched bytes
and proposal-only persistence. The owner verifier independently
checks native receipt integrity and canonical fact state. Foundation
collects finite evidence after both disposable projects are removed.

## Native XLSX integration evidence

[PR #176](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/176)
merged reviewed head `e0b14d6d509de9e0d3a2e7369e0746a45884513e` into
`main` as `4ac6f7e3b8a94263179a9d1eba7a1611added8df`. The hosted test merge
`02eb8f9d8a75803c63613bb9207f8baf54262dea` and the actual merge have tree
`bdc1de96ae89c6ac4e2a810968ed748dc75458ee` and ordered parents
`3a36bfaedab6c55bf96edee3cbd3ced9ed74b113` and the reviewed head.
Independent source and packaged-evidence reviews passed. Candidate
[Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44651027234)
and [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44651027190)
passed, as did post-merge
[Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44654290914)
and [Documentation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44654290969).

The native repository provides a bounded, authorized source catalogue, a safe
preview receipt reader and idempotent selected-row proposal persistence.
Migration 35 adds the reviewed-import path, migration 36 adds the preview
receipt read path and migration 37 adds the source catalogue. Hosted checks
cover migrations, standalone recovery and production-boundary recovery. The
[packaged bridge evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44651027234/artifacts/14591027931)
verifies both workbook profiles under bundled and external PostgreSQL, API-role
TLS, read-only socket access, wrong-peer denial, exact replay and unchanged
canonical facts. The separate
[isolation evidence](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44651027234/artifacts/14590457441)
covers resource limits, caller identity and decoder restart behavior.

Earlier [Foundation run 44576485049](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44576485049)
failed bundled bridge preparation after provisioning and stopped standalone
recovery on an unregistered XLSX history table. The fixture correction checks
the provisioned customer and verifies the XLSX history guards in standalone
and populated packaged restore. The same initial run also failed the external
restore session guard after reporting one autovacuum worker. The guard stayed
strict. The successful final run establishes recovery for that run.
The [next bridge run](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44598797090/job/135824265543)
reported a failure at the provisioned-customer check. Passing the verified
database transport to the fixture pool corrected that configuration error.
[Run 44639876834](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44639876834)
passed the bridge and failed the dependency audit. The final candidate pins
patched Effect `3.22.2` for Prisma tooling and passes the same audit.

### Catalogue query deadlines

The source catalogue applies authorization before its 50-source page boundary.
A sparse reader can therefore scan beyond one page. The repository applies
fixed statement and lock deadlines in a read transaction and returns a finite
persistence failure on contention. The synthetic operations rehearsal adds 52
genesis sources, skips the first for the test reader, and verifies both pages,
read recovery after the test lock clears, and restored genesis validity.

The application API and browser stages below cover workbook upload and
selected-row save with authorization, cancellation and stale-session tests.

### Mapping and reviewed receipt details

The application needs the sealed column-to-field mapping associated with the
preview rather than the source's latest configuration. Migration 38 adds a
bounded details read by source and preview receipt. It reuses the native page
reader's current and captured scope checks, lock order, retention-policy check,
and integrity validation. The read returns the exact mapping revision and a
finite mapping projection. If the preview has a reviewed import, it also
returns the linked receipt ID, creation time, and reviewed row count. Reopening
the preview can recover that summary without retaining the import command key.
The details database call is available only to the API login. Clean,
partial-role, upgrade, and restore paths retain their finite grant checks.
This step prepares the read model for the application routes.

### Application API and upload intake

The XLSX-specific catalogue, preview, outcome pages, mapping and review
details, and explicit save routes share the published API contract. HTTP
activation is separately default-off. An enabled customer API must initialize
the existing isolated decoder and peer checks successfully.

Authentication and the eligible role check run before upload intake. The
streaming parser accepts a single workbook of at most 1,048,576 bytes and
four unique command fields. The encoded body cap is 1,064,960 bytes. Two
per-process leases and a ten-second upload deadline bound local buffering.
The selected sheet travels as canonical base64url of its exact UTF-8 bytes.
The repository rechecks sealed mapping and project scope before decode and
before writing. A disconnect cancels the request's write path while an
admitted decoder exchange settles under its own deadline and cleanup rules.
Exact authorized retry can return the durable receipt ahead of fresh decoder
admission. The packaged browser rehearsal below exercises the opt-in routes.

### Browser upload and review

Data imports offers Excel to API-eligible project managers, portfolio managers
and PMO administrators. PMO administrators can switch between the existing CSV
workflow and Excel. Access to the source catalogue and receipts remains scoped
by the server. A disabled API returns the generic unavailable state.

An authorized user selects a configured source, previews the workbook, reads
the sealed mapping and validation outcomes, and selects rows across receipt
pages. The save stores reviewed proposals for the existing approval path.
Uncertain writes can be retried with the original in-memory command, workbook
bytes or selection. Changing source or authenticated view aborts the old
request and clears its local draft. The browser submits a fixed workbook
filename and keeps bytes, display values and command keys out of browser
storage. To reopen a retained preview after reload, select its source and
enter its preview receipt ID. The protected details call can recover a linked
reviewed import receipt using that ID.

The browser contract tests exercise the UI and intercepted API responses.
The isolated customer rehearsal keeps the direct bridge checks and adds a
Chromium journey through the packaged Caddy proxy, OIDC sign-in, API and
decoder. The verifier receives a synthetic CA, login and workbooks. For each
database profile and each workbook parser profile, the journey previews a
changed workbook, checks an invalid row, selects across two pages, saves
reviewed proposals and reopens the linked receipt. A temporary browser
observer forwards the original upload and save unchanged. The rehearsal
verifies the captured workbook bytes, replays both requests over HTTPS and
checks receipt denial under an authenticated account outside the source scope.

A separate owner process verifies that each profile has exactly one new
preview and reviewed receipt despite replay. It checks the exact workbook
digest, parent receipt, selected rows, retained proposals and unchanged
canonical fact digest. The shipped backup client encrypts that database and
the shipped restore client restores it to a fresh database on the same
disposable server. The owner repeats the receipt checks against the restored
database and verifies quarantine and the finite receipt-reader grants.
The job publishes finite results after both customer database profiles pass.

## Merged browser and recovery evidence

Each stage had independent source and coverage reviews. Foundation and
Documentation passed on every reviewed head and actual merge listed below.
The merge trees matched the reviewed trees with the expected ordered parents.

| Stage | Reviewed head | Main merge | Candidate checks | Main checks |
| --- | --- | --- | --- | --- |
| Catalogue bounds and preview cancellation [#177](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/177) | [181cd30](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/181cd30ee432e403bdd1aad7152eea8b0044949a) | [85768aa](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/85768aa5ac1d98aa7ba35936052b7337028d05f2) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44867239290), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44867239287) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44869457654), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44869457585) |
| Sealed mapping and receipt details [#178](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/178) | [3ac8531](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/3ac85315129d247eca4dd5874ef5a060947e818c) | [6b527b4](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/6b527b424eac18ce30fdde00f3cff23a155dfe63) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44879060430), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44879060444) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44881511254), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44881511180) |
| Authenticated XLSX routes [#179](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/179) | [9bb0b9c](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/9bb0b9cdc44a4d18a301e523ec80970bbb6b24b0) | [d7db36f](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/d7db36f3b83601e3eda0504333e577788bf149ac) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44887188241), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44887188276) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44889455771), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44889455723) |
| Packaged browser workflow [#180](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/180) | [49bce1c](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/49bce1ceedbaebcaa4a5e1faf35e722c7f75168b) | [4c11ee0](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/4c11ee06caad5dcedd3d3644ffe9730898f88284) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44894152563), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44894152513) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44896563394), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44896563418) |
| Encrypted browser receipt recovery [#181](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/pull/181) | [23d6f14](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/23d6f145d63d331c8990c21df7987f58e0909dff) | [a900a1a](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/commit/a900a1ab71fc7ead3c1da593c17b1794d80ce015) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44898740467), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44898740430) | [Foundation](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44901175712), [Docs](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44901175691) |

PR #181's recovery merge `a900a1ab71fc7ead3c1da593c17b1794d80ce015` has
tree `84bf7c1a74def642f8a605390271c4799b58a05c`. Its first parent is the
browser merge `4c11ee06caad5dcedd3d3644ffe9730898f88284` and its second
parent is reviewed head `23d6f145d63d331c8990c21df7987f58e0909dff`.

The packaged Chromium run used trusted synthetic TLS and OIDC, the customer
proxy, the restricted API role, and the isolated decoder. In bundled and
external PostgreSQL, it exercised both supported workbook profiles and two
reviewed imports per database profile. The journey showed the sealed mapping,
an invalid row and selectable proposal rows before saving. It verified exact
upload and save replay, protected receipt reload, out-of-scope denial, and unchanged
canonical facts. The packaged receipt before adding recovery records the
browser-specific results. [PR #180 main browser artifact](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44896563394/artifacts/14704657165).

The backup and restore used the shipped clients. The independent owner
verified receipt linkage, selected rows, retained proposals, workbook and
context integrity, canonical facts, quarantine, and finite reader grants in
each fresh restored database. The exact-head and actual-merge ZIP digests
were checked against GitHub's metadata and both finite results were read.
[PR #181 candidate recovery artifact](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44898740467/artifacts/14704879237) ·
[PR #181 main recovery artifact](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44901175712/artifacts/14706361228).

The first PR #179 run passed 323 browser cases and failed the programme
retry test when its generic alert locator matched two messages. The
reviewed test update waited for the original-key retry state, and the full
suite passed on the updated head and merge. The historical restore failures
below retain their recorded scope. [First PR #179 Foundation run](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/44885405382).

The XLSX results extend the software evidence for the configured
spreadsheet workflow. The accepted story count uses the existing CSV
acceptance. The XLSX HTTP switch defaults to disabled. Issue #7,
customer-release review and all five distribution holds remain open.
Original19/20 capture remains stopped.

## Required validation

PR #153 Foundation run [41262214531](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/41262214531)
passed verification but failed the external customer restore at
`sessions_before_commit_other_sessions`. Its finite diagnostic reported one
other same-database backend, classified non-client with a non-null type. The
backend identity and cause remain unknown; cleanup was not independently proven.
The zero-session guard was not weakened. The run tested synthetic merge
`3e0777f729a4a52a1075bf05f5a5e9b25cf1ddc5` against the former stacked base,
with the same tree as the then-retargeted merge
`ab9347cdb08ea8277ce64beb8405ee1fceff92f4` but different parents. Later
documentation and base updates changed the tree. It is a failed run, not
current-base acceptance; a fresh complete run is required.

Later superseded PR #153 Foundation run [41263826625](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/41263826625)
passed verification but failed the bundled customer restore at
`sessions_before_commit_other_sessions`. Its finite diagnostic reported one
other same-database backend, classified non-client with a non-null type. The
backend identity and cause remain unknown; cleanup was not independently proven.
It tested synthetic merge `1a46124a341dc8739b160b0076d11a5bd48cc92f` of
head `e699088246f59e003592f2c3ce08a1b2f4081583` against the then-main base
`eb7ffc570fa565aec8727ad4563811696531841e`. This separate failure does not
establish a common cause with other restore failures, and a later pass cannot
explain it or replace current-candidate checks.

The earlier PR #145 candidate `228880f43c0fdb640e3f83537d7feaf038dd6e82`
had a successful verify job but failed its synthetic customer external restore
in Foundation run [41233262839](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/41233262839),
attempt 1, at `sessions_before_commit_other_sessions`. That diagnostic reports a
positive safe-integer count of other target-database backends at the final
pre-commit check; the sanitized log does not identify the backend, count or
cause, or prove that cleanup completed. The failure path is designed to roll
back and retain quarantine. Earlier generic restore failures cannot be assumed
to share this cause. The single unchanged failed-job rerun (attempt 2, job
`124637888803`) failed earlier in packaged acceptance at the SEC-AUTH-001
identity-expiry `scalar-proof-disclosure` check and did not reach the restore.
Its finite capture diagnostic reported one request in the phase labeled
`identity`, with a best-effort post-failure accessor classifying it as aborted.
That historical phase covered response identity and later eligibility checks;
the request and cause are unknown. This second failure neither reproduces nor resolves
the restore failure, and does not by itself establish a disclosure. No session
guard was weakened.

PR #151 Foundation run [41249318263](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/41249318263)
passed its verify job but failed the external customer restore at
`sessions_before_commit_other_sessions`. Its finite diagnostic reported one
other same-database backend, classified non-client with a non-null type. It did
not identify the backend or cause, establish a relationship to earlier failures,
or independently prove rollback or quarantine cleanup. The failure path attempts
rollback and retains quarantine; the zero-session guard remains unchanged. The
run tested synthetic merge `056e77ab0eeb74b25767a73f23b7e26a49c89e6f` before the
PR was retargeted to main, with the same then-reviewed tree. A fresh full run
against the current-base candidate is required; a later pass cannot explain this
failure.

PR #156 candidate `ba2f52f5383e2969c6520024b74f5493e0729d5d` failed its
production-boundary job `124688225333` in Foundation run
[41252329821](https://github.com/APReddy-AutoBotz/Project-Delivery-Agent/actions/runs/41252329821)
at SEC-AUTH-001 `scalar-proof-disclosure`, before restore. The finite diagnostic
reported `settle_health`, one request, `pm_queue`, `GET` and `eligibility`, with
best-effort post-failure classifications of `aborted` and `2xx`. The expected
identity-provider token response had been observed for scanning; this is not a
token-disclosure finding. Capture was incomplete, so neither disclosure nor its
absence is established. The cause is unknown, and matching diagnostic categories
do not prove the same cause as other runs. The separate verify job was still
running when recorded. A later passing run does not erase this failure.

Retain CSV regression and grid equivalence tests. Add genuine and adversarial
workbooks covering archive expansion, malformed XML/relationships, formulas,
hidden/merged/sparse cells, Unicode, dates, numeric precision and exact bounds;
prove process timeout, cancellation, memory and concurrency behavior. Add
native role, scope, revocation, stale-configuration, replay, selected-row,
rollback, retention, clean/upgrade and recovery checks, plus a real browser
upload-preview-save journey and stale-session suppression. Complete independent
design/security and exact-candidate reviews, hosted checks, expected-head merge
and actual post-merge verification before any acceptance decision.
