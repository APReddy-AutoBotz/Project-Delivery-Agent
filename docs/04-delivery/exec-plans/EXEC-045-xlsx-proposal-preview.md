# EXEC-045: XLSX preview and reviewed proposals

Status: implementation in progress; not accepted. This extends the approved
spreadsheet journey under FR-CON-006/007/008 and Issue #7. AC-CON-005's CSV
alternative is already accepted; this work adds no criterion or story credit.
The initial local base is PR #141 head `ce4b865eed43a1a40d994443775d24529160f624`;
reconcile actual main and required gates before publication. Original19/20
capture remains stopped, and OD-013/014 remain in force. Spreadsheet saves
remain reviewed import proposals and do not publish canonical facts.

## Current increment

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

Retain CSV regression and grid equivalence tests. Add genuine and adversarial
workbooks covering archive expansion, malformed XML/relationships, formulas,
hidden/merged/sparse cells, Unicode, dates, numeric precision and exact bounds;
prove process timeout, cancellation, memory and concurrency behavior. Add
native role, scope, revocation, stale-configuration, replay, selected-row,
rollback, retention, clean/upgrade and recovery checks, plus a real browser
upload-preview-save journey and stale-session suppression. Complete independent
design/security and exact-candidate reviews, hosted checks, expected-head merge
and actual post-merge verification before any acceptance decision.
