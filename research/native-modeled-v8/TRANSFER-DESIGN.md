# Private artifact transfer component V4 (source only)

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
Neither control suite has run. Source-case arithmetic is not runtime evidence.

The complete future root integration must still authenticate exact builder and
producer/snapshot/transfer order; reserve each whole expected size before entry,
respect32MiB/1MiB/256MiB; strictly admit worker metadata plus successful command
status; independently recheck private host identities/hashes; poison incomplete
transfer and retain storage reservations without retry; retire the exact builder
before maps/ELF/models; only then set executable modes. No mounted output,
broader UID/privilege, timeout extension, fallback, relaxed link/ELF checks or
weakened sanitization is proposed. All8 old research allowances remain consumed.

This bounded source component grants no candidate execution, new allowance,
publication, app copy, hosted/customer qualification, merge or acceptance.
