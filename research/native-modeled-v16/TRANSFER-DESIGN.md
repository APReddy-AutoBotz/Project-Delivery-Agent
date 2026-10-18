# Private artifact transfer component V6 (source only)

Requirements: EXEC-016 / AC-HLT-003 / TR-DEP-004 / NFR-REL-002 /
NFR-SEC-001/005. No operational native admission or accepted-story credit.

This component replaces the failed Docker cp transport. Its worker is the only
binary collector. The existing root command receives bounded JSON metadata;
binary stdout/stderr are private, and no artifact path belongs to receipts or
the upload set. The root must authenticate every source asset before use.

## Fixed worker boundary

One existing D.command copy-N entry, cap three seconds, launches the pinned
Python 3.12 worker in its original owned group. Arguments after the program are:
absolute fixture/artifacts directory, exact builder ID, fixed name, canonical
size, full lowercase hash, absolute deadline, fixture device/inode, and artifact
directory device/inode. These identities come from actual parent creation.
The deadline is no later than the original attempt pre-cleanup boundary or the
original per-command cap, with conservative dispatch margin. No new origin.

The worker authenticates the fixed reader asset against its embedded full hash.
It anchors directory traversal with no-follow descriptors and requires both
parent-created identities, host UID and mode0700 before creating output with
O_EXCL, no-follow, nonblocking protection and mode0600. It retains returned
resources before later inspection; later descriptor opens check the complete
ordinary/pipe/selector numeric ownership index. No acquisition or close retries
after uncertain effect. Known successful closure permits numeric reuse.

The child vector is exactly Docker exec /work /usr/local/bin/node -e fixed reader
-- fixed name/size/hash, without shell, TTY, stdin attachment or changed UID.
Its only environment is PATH=/usr/bin:/bin, LANG=C, LC_ALL=C and authenticated
fixture HOME. Ambient Docker contexts/configuration are not inherited.
start_new_session=False keeps it in the outer worker's original group.

## Resource and byte accounting

Eight logical retained handles and eighty acquisition entries are separate
limits from a sixteen-native-descriptor budget, which includes inherited
stdio3. Before Popen, seven transient native slots are reserved: DEVNULL1,
stdout/stderr pipe ends4 and exec-error pipe ends2. The nominal source-derived
reserved peak is13 including stdio; this is not a measured peak. The seven-slot
reservation survives ambiguous Popen outcomes and is reclassified only after
successful returned-process and pipe identity admission. The parent command's
separate process-group inventory remains required.

No payload accumulation occurs in the worker. A read uses at most65536 bytes,
remaining expected stdout plus one excess byte, or bounded stderr plus one
overflow byte. Reads prospectively reserve capacity. returnedReadBytes records
validated actual returned counts across reader-source, pipes and readback,
before the post-call deadline guard. receivedBytes/verifiedWriteBytes describe
accepted stdout and confirmed host writes; uncertainReadBytes and
uncertainWriteBytes retain possible effects. Thus a deadline may leave returned
bytes that were never processed. Stderr contributes only count/hash and must be
empty for success. Positive short writes advance by their actual count; zero,
boolean, impossible or thrown results refuse without a new write.

Writer closure precedes readback. Readback requires the original inode/device,
regular host-owned single-link mode0600 exact size, full rehash, EOF, and stable
descriptor/path metadata. Both private pipes must reach EOF and the client must
exit zero before the limited result VERIFIED_PRIVATE_PENDING_BUILDER_RETIREMENT.
All known resources must close exactly once within the same deadline.

The Node reader retains one65536-byte buffer and one outstanding stdout write.
The buffer is not reused until callback and required drain, in either order;
listeners precede write and permanent error/close handlers cover gaps. It admits
whole canonical size/hash strings, UID1000, regular/single-link source, exact
size, full digest, EOF and stable descriptor/path metadata. Failure never emits
exception text and never explicitly retries ambiguous close. No process.exit
can truncate a pending success chunk.

## Terminal ownership

Metadata uses one at-most4096-byte os.write attempt. A partial/failed emit or
terminal deadline crossing cannot return zero. Unknown process acquisition or
closure kills the worker's own still-live enclosing group. If that fails, strong
references remain held until the original outer group deadline terminates it.
Any other unresolved native/handle custody uses low-level os._exit(71), retaining
objects through termination so Python finalizers cannot retry ambiguous close.
Failure of low-level termination likewise retains references until outer kill.
This does not prove engine-side exec termination; exact builder retirement is
mandatory even following successful private transfer.

## Controls and remaining integration

transfer_controls.py imports the production worker only in a future reviewed
hosted packet. It runs actual Transfer.execute against real private files and
real host writes/rehashes, with supplied process/selector/pipe boundaries.
Callbacks assert complete arguments/reservations separately from fault markers;
callback assertions cannot satisfy a production-refusal expectation. Controls
wrap every supplied OS/factory/object method in the external assertion recorder
and record raw entry before validation. A deliberate swallowed cleanup assertion
must fail the control. Returned-read counters are compared with independent
boundary facts for every case, including a deadline crossed during stdout read.
External closure counts require alias-owner closes zero and known owners at
most once. A still-live child before expiry exercises kill/wait plus independent
kill-throw and wait-throw uncertainty cases, without new retry or cleanup time.
These assertions are source only. Controls
include payload size edges through32MiB, positive short writes, fragments,
EOF/child orderings, stderr/privacy sentinels, changed identities, directory
replacement, readback aliases, acquisition/close uncertainties, actual numeric
reuse after an ambiguous close, capacity and strict snapshot denial. Two bounded
first-party auxiliary control processes run actual main terminal branches with
supplied unresolved custody and group identity/kill boundaries; they remain in
the original outer group and execute no Docker client or native model. The group
kill fixture validates exact arguments then kills only its own auxiliary PID;
it does not establish actual native process-group qualification.

artifact_reader_controls.js receives the separately authenticated fixed reader
text as its sole Node -e argument (no mounted control/source files or artifact
reads). It checks that argument's UTF-8 byte length and embedded full source hash
without lossy encoding, with three independent alternate-source refusals, then evaluates the
actual separate source in a VM with
supplied fs/process and actual crypto. It reads no artifacts, validates exact
filesystem arguments, checks pending buffer immutability and callback/drain
orders (including callback and drain on separate scheduling turns with an
independent awaiting-drain gate), input grammar, source identity, EOF/hash, close-once, stream failures,
and private exception text. Per-case bounded timers detect an unsettled promise.
This new V5 component has not run. Original V9 Python failure is retained below;
the Node suite was not reached. Source-case arithmetic is not runtime evidence.

The complete future root integration must still authenticate exact builder and
producer/snapshot/transfer order; reserve each whole expected size before entry,
respect32MiB/1MiB/256MiB; strictly admit worker metadata plus successful command
status; independently recheck private host identities/hashes; poison incomplete
transfer and retain storage reservations without retry; retire the exact builder
before maps/ELF/models; only then set executable modes. No mounted output,
broader UID/privilege, timeout extension, fallback, relaxed link/ELF checks or
weakened sanitization is proposed. All ten old research allowances remain consumed.

This bounded source component grants no candidate execution, new allowance,
publication, app copy, hosted/customer qualification, merge or acceptance.


## Retained V5 source design (superseded diagnostic proposal)

The V9 initial hosted attempt failed the Python transfer controls with rc71 and
only the original fixed49-byte failure record. It establishes no internal case,
cause or partial passing count. All ten original allowances are consumed. The
complete V9 source and original evidence remain immutable.

This new isolated source version latches the first primary execute failure
separately from the default display code. A BOUNDARY_FAILURE from an ordinary
boundary exception remains the first failure even when the terminal closure
check necessarily also refuses. Cleanup-only failure still classifies as
UNCERTAIN_CLOSURE, and a terminal clock crossing without an earlier primary
failure remains DEADLINE. No success, failed flag, close, custody, pending
reservation, uncertainty, whole-size charge or original clock predicate is
relaxed. The worker metadata schema stays exactly29 fields.

All original116 Python cases,44 fault-map expectations, fixtures, externally
checked assertions, callback error recorder, live-child cleanup and terminal
auxiliary cases are preserved. Reader and46 Node controls are unchanged. New
failure output is one at-most4096-byte T.emit attempt with fixed schema/status,
fixed phase vocabulary, bounded completedCases0..116 and nextOriginalOrdinal1..116
or null. Null means no next original ordinal is available. A nonnull value is the NEXT
planned original ordinal after counted completions, not an identified active
case: helper setup or teardown may fail between completions. This progress location
does not grant passing-suite credit, fault-delivery proof or a cause. No
exception text/type/repr, arbitrary path, binary sentinel, stack trace or extra
process/network call is emitted. A failed or short diagnostic write cannot
return success or cause another output attempt.

The ordinary main result has a publication-attempt latch set before the original
PASS print. If serialization or a possibly partial PASS write raises, the catch
exits71 without a second diagnostic document. The six existing mocked worker
emit probes and both actual auxiliary T.main terminal fixtures retain their
original emission, expected bytes, return-code and no-finalizer assertions.
Unexpected return from either real terminal fixture still fails the parent
control. The catch adds no low-level exit or group-kill shortcut.

This component is source only. It grants no execution, public effect, new
allowance, retry, application copy, native qualification or dependency adoption.
A complete new root packet must bind exact worker/control hashes and retain
every other component, original clock, allowance, effect and evidence gate.


## V6 ordinary entry, controlled publication and explicit new coverage

V5 complete source coverage was withheld by both authentic reports because the
new diagnostic/publisher paths had no direct controls. V5 is retained unchanged.
V6 keeps the same source-sound25526-byte worker/first-primary latch, exact reader
and46 Node controls, all116 old Python cases/names/fixtures/assertions and both
genuine real-main auxiliary processes. No V9 historical cause is identified.

The ordinary zero-argument entry owns a new private publisher for that call.
Its publication intent is consumed before serialization or any stdout write.
Only one complete exact catalog and a known full integer write permit pass.
Repeated publication clears pass admission and poisons the owner, including if
the body swallows that refusal. Ordinary failure exits71; no second diagnostic
can follow a possibly effective PASS write. PASS uses one write under the
existing root16384-byte control-result bound. Failure uses actual unchanged
worker T.emit with4096 bound. No low-level exit/kill shortcut exists here.

Failure metadata is fixed schema/status/phase/completedOriginalCases/NEXT ordinal.
Counter is exact int0..116 or null; invalid Boolean/negative/overflow/type becomes
null, never an invented observed zero. Unknown phase becomes UNKNOWN. NEXT is
1..116 only for admitted original-work phase/count<116, otherwise null. It is
NEXT planned progress, not active case/cause/pass credit. The actual original
progress observer independently validates the canonical first116-name prefix;
new control suffixes never inflate original completion. No arbitrary exception
text/type/repr/property/path/argv/private payload is formatted.

A separate terminal entry returns distinct72 on any unexpected return/raise from
the unchanged actual terminal fixture. It emits nothing and calls no native
exit/kill itself. Only genuine worker71/-9 can satisfy the existing parent.

Fifty-two new explicitly named controls follow the original116, giving168.
They call actual ordinary entry/formatter/publisher and actual failure T.emit,
with only clearly supplied suite/progress/serialization/raw-writer boundaries.
Every raw write/fault is independently witnessed before validation; callback
assertions and hostile str/repr/property accesses are externally required0.
Counts0/115/116, invalid count/phase, actual canonical prefix observations, eight
failure writer outcomes and eight PASS outcomes, serialization, repeated/swallowed
publication refusals, failed progress observations and absent publication have
fixed independent result/state/output oracles. Full-effect-then-throw is retained
separately from pre-effect throw; no observed state/clock is repaired.

Two returned-terminal regressions call actual terminal entry+original fixture+
actual T.main with only native kill/_exit supplied as RETURN boundaries installed
before fixture capture. Actual attempts and destructor marker are retained;
none is claimed zero or genuine termination. The real captured72/output is then
refused by actual parent terminal_controls with a supplied process result (and
explicit supplied healthy objects prefix only to reach group). No extra actual
child or detached group is launched. The original two genuine auxiliaries stay
unchanged. Raising termination stubs is forbidden because main would retain
ownership in its original pause-until-outer-kill path.

Two additional real-file execute fixtures preserve original100.0 clock: healthy
actual cleanup returns before terminal crossing/no-primary DEADLINE; earlier
register BOUNDARY_FAILURE followed by crossing before actual cleanup retains
that first code and truthful unclosed custody. All assertions precede separate
control-owned FD disposal; original Harness.run and all old bodies remain exact.

All168/46 are UNRUN source declarations. No new auxiliary processes, per-command
cap, research/copy origin, resource limit or output authority is granted. Added
finite fixtures/metadata work still consumes the original5-second command and
600/20 overall bounds; no wall-fit claim. Future full wrapper integration must
explicitly update strict168-case admission/oracles/catalog/hash/workflow bindings.
All ten previous allowances remain consumed. No complete-packet/execution/new
allowance/effect/native/appcopy/adoption/PR/merge/acceptance approval follows.
