# EXEC-045: XLSX preview and reviewed proposals

Status: implementation in progress; not accepted. This extends the approved
spreadsheet journey under FR-CON-006/007 and Issue #7. AC-CON-005's CSV
alternative is accepted at the software-behavior level; this work adds no
criterion or story credit.
The local candidate will be reconciled to current main and independently
reviewed before publication. Original19/20
capture remains stopped, and OD-013/014 remain in force. Spreadsheet saves
remain reviewed import proposals and do not publish canonical facts.

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

The existing path labels and hashes CSV. Do not convert a workbook to CSV and
reuse its receipt as if the original upload were CSV. Design a truthful versioned
XLSX receipt and request hash binding the original workbook digest, selected
sheet, parser contract, baseline and configuration/mapping revisions. Preserve
stable customer/source/sheet/row identity, immutable project binding, replay and
collision rules, current source-reader authorization, retention and historical
CSV proofs. Any required database changes must be additive and include runtime
ACL, upgrade, backup and restore verification. The reviewed import remains an
explicit selection of eligible proposal rows, not a fact or independent
verification of the workbook's upstream origin.

## Required validation

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
Its finite capture diagnostic reported one aborted request in the identity
phase; its cause is unknown. This second failure neither reproduces nor resolves
the restore failure, and does not by itself establish a disclosure. No session
guard was weakened.

Retain CSV regression and grid equivalence tests. Add genuine and adversarial
workbooks covering archive expansion, malformed XML/relationships, formulas,
hidden/merged/sparse cells, Unicode, dates, numeric precision and exact bounds;
prove process timeout, cancellation, memory and concurrency behavior. Add
native role, scope, revocation, stale-configuration, replay, selected-row,
rollback, retention, clean/upgrade and recovery checks, plus a real browser
upload-preview-save journey and stale-session suppression. Complete independent
design/security and exact-candidate reviews, hosted checks, expected-head merge
and actual post-merge verification before any acceptance decision.
