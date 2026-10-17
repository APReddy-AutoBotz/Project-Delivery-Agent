"""EXEC-016/TR-DEP-004 supplied controls. SOURCE ONLY until full packet approval.

Exercise the production Transfer.execute body using real exclusive private host
files, real descriptor hashes and supplied private process/selector boundaries.
No Docker invocation is made by this control program. Fault delivery is checked
separately from production refusal; a callback assertion never counts as a fault.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location("private_transfer_control_subject", ROOT / "artifact_transfer.py")
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)
REAL = {name: getattr(os, name) for name in ("open", "read", "write", "close", "fstat", "stat", "set_blocking")}
CASES = []
ORIGINAL_CASE_NAMES = ('payload-boundary-0', 'payload-boundary-1', 'payload-boundary-65535', 'payload-boundary-65536', 'payload-boundary-65537', 'payload-boundary-1048576', 'payload-boundary-33554432', 'fragmented-positive-short-writes', 'stderr-eof-first', 'eof-before-child-completion', 'existing-file', 'directory-mode', 'directory-replaced', 'open-before-output', 'open-after-output', 'selector-before', 'selector-after', 'selector-fd-collision', 'popen-before', 'popen-after', 'same-pipe', 'bad-pid', 'pipe-fd-collision', 'register-stdout', 'register-stderr', 'nonblocking', 'select', 'unregister-stdout', 'unregister-stderr', 'read-stdout', 'read-stderr', 'invalid-read', 'write-before', 'write-zero', 'write-negative', 'write-bool', 'write-too-large', 'write-after-full', 'close-output-before', 'close-output-after-reuse', 'readback', 'changed-readback', 'poll', 'wait', 'readback-pipe-alias', 'readback-selector-alias', 'close-stdout', 'close-stderr', 'selector-close', 'child-remains-live', 'pipes-remain-open', 'deadline-write', 'deadline-read-stdout', 'fstat-output', 'write-after-partial', 'truncated', 'extra-byte', 'wrong-hash', 'stderr-private', 'stderr-overflow', 'nonzero-exit', 'snapshot-negative-0', 'snapshot-negative-1', 'snapshot-negative-2', 'snapshot-negative-3', 'snapshot-negative-4', 'snapshot-negative-5', 'snapshot-negative-6', 'snapshot-negative-7', 'snapshot-negative-8', 'snapshot-negative-9', 'snapshot-negative-10', 'snapshot-negative-11', 'snapshot-wanted-73', 'snapshot-wanted-74', 'snapshot-wanted-75', 'snapshot-aggregate-overflow', 'snapshot-aggregate-exact-and-isolated', 'constructor-admission-0', 'constructor-admission-1', 'constructor-admission-2', 'constructor-admission-3', 'constructor-admission-4', 'constructor-admission-5', 'constructor-admission-6', 'constructor-admission-7', 'constructor-admission-8', 'constructor-admission-9', 'constructor-admission-10', 'constructor-admission-11', 'constructor-admission-12', 'constructor-admission-13', 'constructor-admission-14', 'constructor-admission-15', 'constructor-admission-16', 'constructor-admission-17', 'constructor-admission-18', 'constructor-admission-19', 'constructor-admission-20', 'constructor-admission-21', 'constructor-admission-22', 'prospective-capacity-native', 'prospective-capacity-logical', 'prospective-capacity-acquisitions', 'metadata-one-attempt-0', 'metadata-one-attempt-1', 'metadata-one-attempt-True', 'metadata-one-attempt--1', 'metadata-one-attempt-throw', 'metadata-one-attempt-full', 'retained-resource-termination-objects', 'retained-resource-termination-group', 'swallowed-cleanup-assertion-is-control-failure', 'live-child-cleanup-None', 'live-child-cleanup-kill', 'live-child-cleanup-wait')
DIAGNOSTIC_CASE_NAMES = ('diag-count-0', 'diag-count-115', 'diag-count-116', 'diag-count-bool', 'diag-count-negative', 'diag-count-overflow', 'diag-count-float', 'diag-count-hostile', 'diag-phase-unknown', 'diag-phase-hostile', 'diag-phase-initial', 'diag-phase-summary', 'diag-prefix-0', 'diag-prefix-115', 'diag-prefix-116', 'diag-prefix-expanded', 'diag-prefix-nonlist', 'diag-prefix-hostile', 'diag-prefix-foreign', 'diag-prefix-reordered', 'diag-fail-write-zero', 'diag-fail-write-short', 'diag-fail-write-boolean', 'diag-fail-write-negative', 'diag-fail-write-impossible', 'diag-fail-write-throw', 'diag-fail-write-full-throw', 'diag-fail-write-full', 'diag-pass-write-zero', 'diag-pass-write-short', 'diag-pass-write-boolean', 'diag-pass-write-negative', 'diag-pass-write-impossible', 'diag-pass-write-throw', 'diag-pass-write-full-throw', 'diag-pass-write-full', 'diag-pass-serialize', 'diag-fail-serialize', 'diag-pass-oversize', 'diag-catalog-incomplete', 'diag-catalog-reordered', 'diag-catalog-complete', 'diag-publish-twice', 'diag-publish-swallow', 'diag-swallowed-write', 'diag-swallowed-serialize', 'diag-progress-error', 'diag-no-publish', 'diag-terminal-return-objects', 'diag-terminal-return-group', 'diag-terminal-clock', 'diag-primary-clock')
CONTAINER = "a" * 64
SENTINEL = b"\x00PRIVATE-BINARY-\xff\xfe-NEVER-PUBLIC\x80\n"


def check(value):
    if not value:
        raise AssertionError("CONTROL_ASSERTION")


def case(name, body):
    body()
    CASES.append(name)


def payload(size):
    return (SENTINEL * (size // len(SENTINEL) + 1))[:size]


class Pipe:
    def __init__(self, harness, role, descriptor):
        self.h, self.role, self.descriptor = harness, role, descriptor
        self.close_calls = 0
        self.fileno = harness.checked(self.fileno)
        self.close = harness.checked(self.close)

    def fileno(self):
        return self.descriptor

    def close(self):
        self.close_calls += 1
        check(self.close_calls == 1)
        check(not (self.h.cleanup_assertion and self.role == "stdout"))
        self.h.calls.append(("pipe-close", self.role))
        self.h.inject("close-" + self.role)


class Process:
    def __init__(self, harness):
        self.h, self.pid, self.returncode = harness, 456789, None
        self.stdout = Pipe(harness, "stdout", 1000001)
        self.stderr = Pipe(harness, "stderr", 1000002)
        self.polls = self.kills = self.waits = 0
        for name in ("poll", "kill", "wait"):
            setattr(self, name, harness.checked(getattr(self, name)))
        if harness.fault == "same-pipe":
            self.stderr = self.stdout
            harness.delivered = True
        if harness.fault == "bad-pid":
            self.pid = True
            harness.delivered = True
        if harness.fault == "pipe-fd-collision":
            self.stdout.descriptor = harness.output_fd
            harness.delivered = True

    def poll(self):
        self.polls += 1
        self.h.calls.append(("poll",))
        self.h.inject("poll")
        if self.h.fault == "child-remains-live" and not self.kills:
            self.h.delivered = True
            self.h.now += 30.0
            return None
        if self.polls > self.h.exit_delay:
            self.returncode = self.h.returncode
        return self.returncode

    def kill(self):
        self.kills += 1
        check(self.kills == 1)
        self.h.calls.append(("kill",))
        self.h.inject("kill")
        self.returncode = -9

    def wait(self, *, timeout):
        check(type(timeout) is float and 0 < timeout <= 100)
        self.waits += 1
        self.h.calls.append(("wait",))
        self.h.inject("wait")
        self.returncode = self.h.returncode if self.returncode is None else self.returncode
        return self.returncode


class Selector:
    def __init__(self, harness):
        self.h, self.entries, self.closes = harness, {}, 0
        for name in ("fileno", "register", "unregister", "select", "close"):
            setattr(self, name, harness.checked(getattr(self, name)))

    def fileno(self):
        if self.h.fault == "selector-fd-collision":
            self.h.delivered = True
            return self.h.output_fd
        return 1000003

    def register(self, stream, events, role):
        check(type(stream) is Pipe and stream.role == role and events == T.selectors.EVENT_READ and role not in self.entries)
        self.entries[role] = SimpleNamespace(fileobj=stream, data=role)
        self.h.calls.append(("register", role))
        self.h.inject("register-" + role)

    def unregister(self, stream):
        check(self.entries[stream.role].fileobj is stream)
        del self.entries[stream.role]
        self.h.calls.append(("unregister", stream.role))
        self.h.inject("unregister-" + stream.role)

    def select(self, timeout):
        check(type(timeout) is float and 0 <= timeout <= 0.02)
        self.h.calls.append(("select",))
        self.h.inject("select")
        if self.h.fault == "pipes-remain-open":
            self.h.delivered = True
            self.h.now += 30.0
            return []
        order = ("stderr", "stdout") if self.h.stderr_first else ("stdout", "stderr")
        return [(self.entries[role], T.selectors.EVENT_READ) for role in order if role in self.entries]

    def close(self):
        self.closes += 1
        check(self.closes == 1)
        self.h.calls.append(("selector-close",))
        self.h.inject("selector-close")


class Harness:
    def __init__(self, data, *, expected=None, fault=None, stderr=b"", fragment=65536,
                 short_write=None, stderr_first=False, exit_delay=0, returncode=0, cleanup_assertion=False, cleanup_fault=None):
        self.data, self.expected = data, data if expected is None else expected
        self.fault, self.stderr, self.fragment, self.short_write = fault, stderr, fragment, short_write
        self.stderr_first, self.exit_delay, self.returncode = stderr_first, exit_delay, returncode
        self.cleanup_assertion = cleanup_assertion
        self.cleanup_fault, self.cleanup_delivered = cleanup_fault, False
        self.positions = {"stdout": 0, "stderr": 0}
        self.now, self.delivered, self.output_fd = 10.0, False, None
        self.calls, self.callback_errors, self.native_closes = [], [], {}
        self.raw_entries = []
        self.supplied_returned_read_bytes = self.read_boundary_attempts = 0
        self.live_fds, self.output_close_calls = set(), 0
        self.process = self.selector = self.transfer = None
        self.patchers = []

    def checked(self, function):
        def call(*args, **kwargs):
            self.raw_entries.append(function.__qualname__)
            if function.__name__ == "read":
                self.read_boundary_attempts += 1
            try:
                result = function(*args, **kwargs)
                if function.__name__ == "read" and type(result) is bytes:
                    self.supplied_returned_read_bytes += len(result)
                return result
            except AssertionError:
                self.callback_errors.append("CALLBACK_ASSERTION")
                raise
        return call

    def inject(self, point):
        if self.cleanup_fault == point and not self.cleanup_delivered:
            self.cleanup_delivered = True
            raise OSError(SENTINEL.decode("latin1"))
        if self.fault == point and not self.delivered:
            self.delivered = True
            raise OSError(SENTINEL.decode("latin1"))
        if self.fault == "deadline-" + point and not self.delivered:
            self.delivered = True
            self.now = 100.0

    def open(self, path, flags, mode=0o777, *, dir_fd=None):
        role = next(reversed(self.transfer.pending))
        check(self.transfer.pending[role] == 1 and flags & os.O_NOFOLLOW and flags & os.O_NONBLOCK and
              flags & os.O_CLOEXEC and mode == 0o600)
        if role == "output":
            check(path == "policy.o" and dir_fd in self.transfer.fds and flags & os.O_EXCL and flags & os.O_CREAT)
        self.calls.append(("open", role))
        self.inject("open-before-" + role)
        descriptor = REAL["open"](path, flags, mode, dir_fd=dir_fd)
        self.live_fds.add(descriptor)
        if role == "output":
            self.output_fd = descriptor
        if role == "readback" and self.fault == "readback-pipe-alias" and not self.delivered:
            self.delivered = True
            return 1000001
        if role == "readback" and self.fault == "readback-selector-alias" and not self.delivered:
            self.delivered = True
            return 1000003
        if self.fault == "open-after-" + role and not self.delivered:
            # Supplied actual acquisition then throw. Control retains sole orphan
            # custody until subject completion; production must retain reservation.
            self.orphan_fd = descriptor
            self.delivered = True
            raise OSError(SENTINEL.decode("latin1"))
        if self.fault == "deadline-open-" + role and not self.delivered:
            self.delivered, self.now = True, 100.0
        return descriptor

    def read(self, descriptor, wanted):
        check(type(wanted) is int and 1 <= wanted <= 65536 and self.transfer.read_uncertain >= wanted)
        role = "stdout" if descriptor == 1000001 else "stderr" if descriptor == 1000002 else None
        self.calls.append(("read", role or self.transfer.fds[descriptor]))
        if role is None:
            block = REAL["read"](descriptor, wanted)
            if self.transfer.fds[descriptor] == "readback":
                self.inject("readback")
            return block
        self.inject("read-" + role)
        data = self.data if role == "stdout" else self.stderr
        start = self.positions[role]
        block = data[start:start + min(wanted, self.fragment)]
        self.positions[role] += len(block)
        if self.fault == "invalid-read" and role == "stdout" and not self.delivered:
            self.delivered = True
            return bytearray(block)
        return block

    def write(self, descriptor, block):
        check(descriptor == self.output_fd and type(block) is memoryview and 0 < len(block) <= 65536 and
              self.transfer.write_uncertain == len(block) and
              self.transfer.written + self.transfer.write_uncertain <= self.transfer.size)
        self.calls.append(("write", len(block)))
        self.inject("write-before")
        if self.fault in ("write-zero", "write-negative", "write-bool", "write-too-large") and not self.delivered:
            self.delivered = True
            return {"write-zero": 0, "write-negative": -1, "write-bool": True, "write-too-large": len(block) + 1}[self.fault]
        count = min(len(block), self.short_write) if self.short_write else len(block)
        actual = REAL["write"](descriptor, block[:count])
        check(actual == count)
        if self.fault in ("write-after-partial", "write-after-full") and not self.delivered:
            check(self.fault != "write-after-partial" or actual < len(block))
            self.delivered = True
            raise OSError(SENTINEL.decode("latin1"))
        self.inject("write")
        return actual

    def close(self, descriptor):
        check(descriptor not in self.transfer.fds and "fd-" + str(descriptor) in self.transfer.uncertain_closes)
        self.native_closes[descriptor] = self.native_closes.get(descriptor, 0) + 1
        self.calls.append(("fd-close", descriptor))
        if descriptor == self.output_fd:
            self.output_close_calls += 1
            self.inject("close-output-before")
        REAL["close"](descriptor)
        self.live_fds.remove(descriptor)
        if descriptor == self.output_fd and self.fault == "close-output-after-reuse" and not self.delivered:
            # Force exact numeric reuse after actual close, retain separately.
            alias = REAL["open"](self.alias_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            check(alias == descriptor)
            self.live_fds.add(alias)
            self.alias_fd = alias
            self.delivered = True
            raise OSError(SENTINEL.decode("latin1"))

    def fstat(self, descriptor):
        info = REAL["fstat"](descriptor)
        self.calls.append(("fstat", self.transfer.fds[descriptor]))
        self.inject("fstat-" + self.transfer.fds[descriptor])
        if self.fault == "changed-readback" and self.transfer.fds[descriptor] == "readback" and not self.delivered:
            self.delivered = True
            fields = {name: getattr(info, name) for name in ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")}
            fields["st_ino"] += 1
            return SimpleNamespace(**fields)
        return info

    def set_blocking(self, descriptor, value):
        check(descriptor in (1000001, 1000002) and value is False)
        self.calls.append(("nonblocking", descriptor))
        self.inject("nonblocking")

    def popen(self, argv, **kwargs):
        check(self.transfer.pending["process"] == 3 and self.transfer.native_pending["process"] == 7 and
            self.transfer.native_fd_peak_reserved <= 16 and argv == ["/usr/bin/docker", "exec", "--workdir", "/work",
            CONTAINER, "/usr/local/bin/node", "-e", (ROOT / "artifact_reader.js").read_bytes().decode("ascii"), "--", "policy.o",
            str(len(self.expected)), hashlib.sha256(self.expected).hexdigest()])
        check(kwargs == dict(stdin=T.subprocess.DEVNULL, stdout=T.subprocess.PIPE, stderr=T.subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(self.transfer.directory.parent)},
            close_fds=True, start_new_session=False, bufsize=0))
        self.calls.append(("popen",))
        self.inject("popen-before")
        self.process = Process(self)
        self.inject("popen-after")
        return self.process

    def make_selector(self):
        check(self.transfer.pending["selector"] == 1)
        self.calls.append(("selector",))
        self.inject("selector-before")
        self.selector = Selector(self)
        self.inject("selector-after")
        return self.selector

    def run(self):
        with tempfile.TemporaryDirectory(prefix="private-transfer-controls-") as temporary:
            parent = Path(temporary)
            parent.chmod(0o700)
            directory = parent / "artifacts"
            directory.mkdir(mode=0o700)
            fixture_info, directory_info = parent.stat(), directory.stat()
            fixture_identity = (fixture_info.st_dev, fixture_info.st_ino)
            directory_identity = (directory_info.st_dev, directory_info.st_ino)
            self.alias_path = str(parent / "alias")
            if self.fault == "existing-file":
                (directory / "policy.o").write_bytes(SENTINEL)
                self.delivered = True
            if self.fault == "directory-mode":
                directory.chmod(0o755)
                self.delivered = True
            if self.fault == "directory-replaced":
                directory.rename(parent / "original-artifacts")
                directory.mkdir(mode=0o700)
                self.delivered = True
            self.transfer = T.Transfer(str(directory), CONTAINER, "policy.o", len(self.expected),
                                       hashlib.sha256(self.expected).hexdigest(), 100.0, fixture_identity, directory_identity)
            bindings = [(os, name, self.checked(getattr(self, name))) for name in
                        ("open", "read", "write", "close", "fstat", "set_blocking")]
            bindings += [(T.subprocess, "Popen", self.checked(self.popen)),
                         (T.selectors, "DefaultSelector", self.checked(self.make_selector)),
                         (T.time, "monotonic", lambda: self.now),
                         (T.time, "sleep", lambda _: setattr(self, "now", self.now + 0.01))]
            try:
                for target, name, value in bindings:
                    p = patch.object(target, name, value)
                    p.start()
                    self.patchers.append(p)
                self.report = self.transfer.execute()
            finally:
                for p in reversed(self.patchers):
                    p.stop()
            # Inspect private bytes externally, after all subject progress.
            self.actual = (directory / "policy.o").read_bytes() if (directory / "policy.o").is_file() else None
            self.metadata = json.dumps(self.report, allow_nan=False).encode("ascii")
            check(len(self.metadata) <= 4096 and SENTINEL not in self.metadata and b"PRIVATE-BINARY" not in self.metadata)
            if self.fault == "close-output-after-reuse":
                # Reuse remained live through production cleanup.
                check(self.output_close_calls == 1 and REAL["fstat"](self.alias_fd).st_size == 0)
            # Cleanup here is independent control fixture custody, never subject
            # recovery. Track actual descriptor generations, including orphans.
            for descriptor in self.live_fds:
                REAL["close"](descriptor)
            check(not self.callback_errors)
            check(self.report["returnedReadBytes"] == self.supplied_returned_read_bytes and
                  self.report["readAttempts"] == self.read_boundary_attempts)
            if self.process is not None:
                check(self.process.kills <= 1 and self.process.waits <= 1 and
                      self.process.stdout.close_calls <= 1 and self.process.stderr.close_calls <= 1)
                if self.transfer.process_admitted and self.fault not in ("popen-after", "same-pipe", "pipe-fd-collision"):
                    expired = self.now >= 100.0
                    expected_stdout = 0 if expired or self.fault == "readback-pipe-alias" else 1
                    expected_stderr = 0 if expired else 1
                    check(self.process.stdout.close_calls == expected_stdout and self.process.stderr.close_calls == expected_stderr)
                    if not expired:
                        close_order = [entry[1] for entry in self.calls if entry[0] == "pipe-close"]
                        check(close_order == (["stderr"] if expected_stdout == 0 else ["stdout", "stderr"]))
            if self.selector is not None:
                check(self.selector.closes <= 1)
                expected_selector = 0 if self.now >= 100.0 or self.fault in ("selector-after", "selector-fd-collision", "readback-selector-alias") else 1
                check(self.selector.closes == expected_selector)
            return self


def positive(size, **kwargs):
    h = Harness(payload(size), **kwargs).run()
    r = h.report
    check(r["status"] == "VERIFIED_PRIVATE_PENDING_BUILDER_RETIREMENT" and r["code"] == "NONE" and
          r["nativeQualification"] is False and r["ownedResourcesClosed"] is True and
          r["childClosedKnown"] is True and r["stdoutEof"] is True and r["stderrEof"] is True and
          r["uncertainWriteBytes"] == r["uncertainReadBytes"] == 0 and
          r["nativePendingReservations"] == {} and r["nativeFdBudget"] == 16 and r["nativeFdPeakReserved"] == 13 and
          r["expectedBytes"] == r["receivedBytes"] == r["verifiedWriteBytes"] == size and h.actual == payload(size) and
          r["hostSha256"] == r["streamSha256"] == hashlib.sha256(h.actual).hexdigest())
    check(h.process.kills == 0 and h.process.waits == 1 and h.selector.closes == 1 and
          h.process.stdout.close_calls == h.process.stderr.close_calls == 1)


def negative(fault, code, **kwargs):
    h = Harness(payload(71), fault=fault, **kwargs).run()
    check(h.delivered and h.report["status"] == "TRANSFER_FAILED" and h.report["code"] == code)
    if fault.startswith("write-"):
        check(h.report["uncertainWriteBytes"] > 0 and sum(name == "write" for name, *_ in h.calls) == 1)
    if fault.startswith(("open-before-", "open-after-", "popen-", "selector-before", "selector-after")):
        check(h.report["pendingAcquisitions"])
    if fault == "close-output-after-reuse":
        check(h.report["uncertainCloseRoles"] and not h.report["ownedResourcesClosed"])
    if fault in ("same-pipe", "pipe-fd-collision", "bad-pid"):
        check(h.process.stdout.close_calls == h.process.stderr.close_calls == 0 and h.selector.closes == 1)
    if fault == "readback-pipe-alias":
        check(h.process.stdout.close_calls == 0 and h.process.stderr.close_calls == 1 and h.selector.closes == 1 and
              h.report["pendingAcquisitions"] == {"readback": 1} and
              h.report["nativePendingReservations"] == {"readback": 1} and
              h.report["uncertainCloseRoles"] == ["fd-alias-stdout"])
    if fault == "readback-selector-alias":
        check(h.process.stdout.close_calls == h.process.stderr.close_calls == 1 and h.selector.closes == 0 and
              h.report["pendingAcquisitions"] == {"readback": 1} and
              h.report["nativePendingReservations"] == {"readback": 1} and
              h.report["uncertainCloseRoles"] == ["fd-alias-selector"])
    if fault == "deadline-read-stdout":
        check(h.report["receivedBytes"] == h.report["verifiedWriteBytes"] == 0 and
              h.report["returnedReadBytes"] == (ROOT / "artifact_reader.js").stat().st_size + 71 and
              h.report["readAttempts"] == 3 and h.report["uncertainReadBytes"] == 0)


def assertion_recorder_control():
    h = Harness(payload(71), fault="register-stdout", cleanup_assertion=True)
    try:
        h.run()
    except AssertionError:
        check(h.delivered and h.report["code"] == "BOUNDARY_FAILURE" and
              h.callback_errors == ["CALLBACK_ASSERTION"] and "Pipe.close" in h.raw_entries)
    else:
        check(False)
    CASES.append("swallowed-cleanup-assertion-is-control-failure")


def live_child_cleanup_controls():
    for fault in (None, "kill", "wait"):
        h = Harness(payload(71), fault="register-stdout", exit_delay=10, cleanup_fault=fault).run()
        check(h.delivered and h.report["status"] == "TRANSFER_FAILED" and h.report["code"] == "BOUNDARY_FAILURE" and
              h.process.polls == 1 and h.process.kills == 1 and h.process.waits == (0 if fault == "kill" else 1) and
              h.report["childClosedKnown"] is (fault is None) and h.cleanup_delivered is (fault is not None))
        CASES.append("live-child-cleanup-" + str(fault))


def snapshot_controls():
    good = b'[{"name":"policy.o","bytes":3,"sha256":"' + b"b" * 64 + b'"}]'
    check(T.decode_snapshot(good, ("policy.o",)) == [{"name": "policy.o", "bytes": 3, "sha256": "b" * 64}])
    bad = [good.replace(b'"bytes":3', token) for token in
           (b'"bytes":true', b'"bytes":-1', b'"bytes":33554433', b'"bytes":3.0', b'"bytes":NaN',
            b'"bytes":3,"bytes":3', b'"bytes":3,"by\\u0074es":3')]
    bad += [good.replace(b"policy.o", b"../policy.o"), good.replace(b"bbb", b"BBB", 1),
            good[:-2] + b',"extra":0}]', b"[" + good[1:-1] + b"," + good[1:-1] + b"]", good + b"garbage"]
    for index, item in enumerate(bad):
        try:
            T.decode_snapshot(item, ("policy.o",))
        except (T.Refused, ValueError):
            CASES.append("snapshot-negative-" + str(index))
        else:
            check(False)
    for wanted in (("policy.d", "policy.o"), ("policy.o", "policy.o"), ["policy.o"]):
        try:
            T.decode_snapshot(good, wanted)
        except T.Refused as error:
            check(error.code == "ADMISSION")
            CASES.append("snapshot-wanted-" + str(len(CASES)))
        else:
            check(False)
    rows = [{"name": name, "bytes": T.maximum(name), "sha256": "b" * 64} for name in T.NAMES]
    try:
        T.decode_snapshot(json.dumps(rows).encode("ascii"), T.NAMES)
    except T.Refused as error:
        check(error.code == "CAPACITY")
        CASES.append("snapshot-aggregate-overflow")
    else:
        check(False)
    excess = sum(row["bytes"] for row in rows) - 268435456
    for row in reversed(rows):
        reduction = min(row["bytes"], excess)
        row["bytes"] -= reduction
        excess -= reduction
    admitted = T.decode_snapshot(json.dumps(rows).encode("ascii"), T.NAMES)
    check(sum(row["bytes"] for row in admitted) == 268435456)
    rows[0]["bytes"] = 0
    check(admitted[0]["bytes"] > 0)
    CASES.append("snapshot-aggregate-exact-and-isolated")


def constructor_controls():
    good = ["/private/artifacts", CONTAINER, "policy.o", 0, "b" * 64, 100.0, (1, 2), (1, 3)]
    bad = [(0, value) for value in ("relative", "/private/../artifacts", "/private//artifacts", "/private/artifacts/", "/")]
    bad += [(1, value) for value in ("A" * 64, "a" * 63, True)]
    bad += [(2, value) for value in ("../policy.o", "other.o", True)]
    bad += [(3, value) for value in (-1, True, 33554433, 0.0)]
    bad += [(4, "B" * 64), (5, float("nan")), (5, float("inf")), (5, 100),
            (6, (True, 2)), (6, [1, 2]), (7, (1, -1)), (7, (1,))]
    for index, (position, value) in enumerate(bad):
        args = list(good)
        args[position] = value
        try:
            T.Transfer(*args)
        except T.Refused as error:
            check(error.code == "ADMISSION")
        else:
            check(False)
        CASES.append("constructor-admission-" + str(index))


def capacity_controls():
    for fault in ("native", "logical", "acquisitions"):
        subject = T.Transfer("/private/artifacts", CONTAINER, "policy.o", 0, "b" * 64, 100.0, (1, 2), (1, 3))
        if fault == "native":
            subject.native_pending["prior-unknown"] = 14
        elif fault == "logical":
            subject.pending["prior-unknown"] = 8
        else:
            subject.acquisitions = 80
        with patch.object(T.time, "monotonic", lambda: 10.0):
            try:
                subject.reserve("test")
            except T.Refused as error:
                check(error.code == "CAPACITY")
            else:
                check(False)
        check("test" not in subject.pending and "test" not in subject.native_pending)
        CASES.append("prospective-capacity-" + fault)


def terminal_fixture(kind):
    class Retained:
        def __del__(self):
            os.write(1, b"FINALIZER_REENTERED\n")
    class SuppliedTransfer:
        def __init__(self, *args):
            self.complete, self.child_closed, self.process = False, True, None
            self.pending, self.native_pending, self.fds, self.objects = {}, {}, {}, {}
            self.uncertain_closes = {"supplied-retained-object": Retained()}
            if kind == "group":
                self.pending["process"] = 3
                self.native_pending["process"] = 7
        def execute(self):
            return dict(schema=1, status="TRANSFER_FAILED", code="UNCERTAIN_CLOSURE")
    T.Transfer = SuppliedTransfer
    # Keep auxiliary controls in their existing outer owned group. Supply only
    # main's leader identity and validate the exact killpg request before its
    # fixture effect terminates this auxiliary process. This is not native group
    # qualification or a new detached control session.
    own_pid, real_kill = os.getpid(), os.kill
    T.os.getpgrp = lambda: own_pid
    T.os.getsid = lambda value: own_pid if value == 0 else -1
    def supplied_killpg(group, sig):
        check(group == own_pid and sig == signal.SIGKILL)
        real_kill(own_pid, signal.SIGKILL)
    T.os.killpg = supplied_killpg
    sys.argv = ["artifact_transfer.py", str(Path(os.environ["HOME"]) / "artifacts"), CONTAINER,
                "policy.o", "0", hashlib.sha256(b"").hexdigest(), str(time.monotonic() + 2), "0", "1", "0", "2"]
    # The real main body must terminate before retained-object finalization.
    raise SystemExit(T.main())


def terminal_controls():
    with tempfile.TemporaryDirectory(prefix="private-terminal-controls-") as temporary:
        env = {"PATH": "/usr/bin:/bin", "HOME": temporary, "LANG": "C", "LC_ALL": "C"}
        for kind, returncode in (("objects", 71), ("group", -9)):
            result = subprocess.run([sys.executable, "-I", "-S", "-B", str(Path(__file__).resolve()), "--terminal-" + kind],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                close_fds=True, start_new_session=False, timeout=2, check=False)
            check(result.returncode == returncode and result.stderr == b"" and
                  result.stdout == b'{"schema":1,"status":"TRANSFER_FAILED","code":"UNCERTAIN_CLOSURE"}\n')
            CASES.append("retained-resource-termination-" + kind)


def emit_controls():
    for result in (0, 1, True, -1, "throw", "full"):
        calls = []
        def write(descriptor, data):
            check(descriptor == 1 and type(data) is bytes and data == b'{"schema":1}\n')
            calls.append(len(data))
            if result == "throw":
                raise OSError(SENTINEL.decode("latin1"))
            return len(data) if result == "full" else result
        with patch.object(os, "write", write):
            actual = T.emit({"schema": 1})
        check(actual is (result == "full") and len(calls) == 1)
        CASES.append("metadata-one-attempt-" + str(result))


# Source fragment only. Combined into the next immutable component by inert IO.
ENTRY_PHASES = frozenset(("INITIAL", "TRANSFER_CASES", "SNAPSHOT", "CONSTRUCTOR",
    "CAPACITY", "EMIT", "TERMINAL", "ASSERTION_RECORDER", "LIVE_CHILD_CLEANUP", "DIAGNOSTIC", "SUMMARY"))
ORIGINAL_WORK_PHASES = ENTRY_PHASES - {"INITIAL", "DIAGNOSTIC", "SUMMARY"}


def failure_document(phase, completed):
    phase = phase if type(phase) is str and phase in ENTRY_PHASES else "UNKNOWN"
    count = completed if type(completed) is int and 0 <= completed <= 116 else None
    next_ordinal = count + 1 if count is not None and count < 116 and phase in ORIGINAL_WORK_PHASES else None
    return dict(schema=1, status="SUPPLIED_CONTROLS_FAILED", phase=phase,
                completedOriginalCases=count, nextOriginalOrdinal=next_ordinal)


def completed_original_count():
    if type(CASES) is not list:
        return None
    count = min(len(CASES), 116)
    prefix = CASES[:count]
    if not all(type(name) is str for name in prefix) or tuple(prefix) != ORIGINAL_CASE_NAMES[:count]:
        return None
    return count


class ControlPublisher:
    def __init__(self):
        self.phase, self.attempted, self.pass_published, self.denied = "INITIAL", False, False, False

    def publish_pass(self):
        if self.attempted:
            self.denied, self.pass_published = True, False
            check(False)
        self.attempted = True  # before serialization or a possibly effective write
        check(type(CASES) is list and all(type(name) is str for name in CASES))
        value = dict(schema=1, status="SUPPLIED_CONTROLS_PASS", cases=len(CASES), names=list(CASES),
                     realDockerInvocations=0, nativeQualification=False)
        payload = (json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode("ascii")
        check(0 < len(payload) <= 16384)
        count = os.write(1, payload)
        check(type(count) is int and count == len(payload))
        self.pass_published = True


def finish_controls(publisher):
    check(type(CASES) is list and all(type(name) is str for name in CASES) and
          tuple(CASES) == ORIGINAL_CASE_NAMES + DIAGNOSTIC_CASE_NAMES)
    publisher.phase = "SUMMARY"
    publisher.publish_pass()


def ordinary_entry():
    publisher = ControlPublisher()
    try:
        main(publisher)
        check(publisher.attempted is True and publisher.pass_published is True and publisher.denied is False)
        return 0
    except BaseException:
        if not publisher.attempted:
            publisher.attempted = True
            try:
                completed = completed_original_count()
            except BaseException:
                completed = None
            T.emit(failure_document(publisher.phase, completed))
        return 71


def terminal_entry(kind):
    try:
        terminal_fixture(kind)
    except BaseException:
        pass
    # Only the genuine worker low-level71/kill-9 can satisfy its parent. A
    # returned/raised fixture is always a distinct failure, with no extra emit.
    return 72


class DiagnosticError(Exception):
    def __init__(self, observations):
        self.observations = observations

    def __str__(self):
        self.observations.append("str")
        return SENTINEL.decode("latin1")

    def __repr__(self):
        self.observations.append("repr")
        return SENTINEL.decode("latin1")

    @property
    def code(self):
        self.observations.append("code")
        raise AssertionError("PRIVATE_PROPERTY_FORMATTING")


def observe_entry(*, phase="TRANSFER_CASES", completed=0, action="fail", outcome="full", serialization_failure=False, progress_failure=False, serialization_oversize=False):
    owners, writes, effects, callback_errors, formatting, boundary_states = [], [], [], [], [], []
    calls = dict(body=0, delivered=0, progress=0, writerFault=0, serializeFault=0, secondPublish=0, swallowed=0)
    hostile = DiagnosticError(formatting)
    def supplied_main(publisher):
        calls["body"] += 1
        owners.append(publisher)
        publisher.phase = phase
        calls["delivered"] += 1
        if action == "fail":
            raise hostile
        if action == "return":
            return
        if action == "catalog":
            finish_controls(publisher)
            return
        if action == "pass-swallow":
            try:
                publisher.publish_pass()
            except BaseException:
                calls["swallowed"] += 1
            return
        publisher.publish_pass()
        if action in ("twice","twice-swallow"):
            calls["secondPublish"] += 1
            try:
                publisher.publish_pass()
            except AssertionError:
                if action != "twice-swallow":
                    raise
                calls["swallowed"] += 1
    def supplied_progress():
        calls["progress"] += 1
        if progress_failure:
            raise hostile
        return completed
    def supplied_write(descriptor, data):
        writes.append((descriptor, data))  # raw entry precedes validation/fault
        boundary_states.append(("write",owners[0].attempted,owners[0].pass_published,owners[0].denied))
        try:
            check(descriptor == 1 and type(data) is bytes and 0 < len(data) <= 16384)
        except AssertionError:
            callback_errors.append("CALLBACK_ASSERTION")
            raise
        calls["writerFault"] += 1
        if outcome in ("full", "full-throw"):
            effects.append(data)  # separately observed supplied full effect
        elif outcome == "short":
            effects.append(data[:1])
        if outcome in ("throw", "full-throw"):
            raise hostile
        return len(data) if outcome == "full" else {"zero": 0, "short": 1, "boolean": True, "negative": -1,
                                                    "impossible": len(data) + 1}[outcome]
    original_dumps = json.dumps
    def supplied_dumps(value, *args, **kwargs):
        target="SUPPLIED_CONTROLS_FAILED" if serialization_failure=="failure" else "SUPPLIED_CONTROLS_PASS"
        if (serialization_failure or serialization_oversize) and type(value) is dict and value.get("status") == target:
            calls["serializeFault"] += 1
            boundary_states.append(("serialize",owners[0].attempted,owners[0].pass_published,owners[0].denied))
            if serialization_oversize:
                return "x"*16384
            raise hostile
        return original_dumps(value, *args, **kwargs)
    with patch.dict(globals(), main=supplied_main, completed_original_count=supplied_progress), \
            patch.object(os, "write", supplied_write), patch.object(json, "dumps", supplied_dumps):
        result = ordinary_entry()
    check(len(owners) == 1 and calls["body"] == calls["delivered"] == 1 and not callback_errors and formatting == [])
    check(all(attempted is True and published is False and denied is False for _,attempted,published,denied in boundary_states))
    return dict(result=result, publisher=owners[0], writes=writes, effects=effects, calls=calls)


def diagnostic_entry_case(phase, completed, expected_phase, expected_count, expected_next):
    observed = observe_entry(phase=phase, completed=completed)
    expected = dict(schema=1, status="SUPPLIED_CONTROLS_FAILED", phase=expected_phase,
                    completedOriginalCases=expected_count, nextOriginalOrdinal=expected_next)
    check(observed["result"] == 71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False)
    check(observed["calls"]["progress"] == observed["calls"]["writerFault"] == 1 and len(observed["writes"]) == 1)
    data = observed["writes"][0][1]
    check(json.loads(data) == expected and len(data) <= 4096 and SENTINEL not in data and b"PRIVATE-BINARY" not in data)


def diagnostic_writer_case(outcome, *, passing=False):
    observed = observe_entry(completed=115, action="pass" if passing else "fail", outcome=outcome)
    check(len(observed["writes"]) == observed["calls"]["writerFault"] == 1)
    data = observed["writes"][0][1]
    result = json.loads(data)
    check(observed["publisher"].attempted is True and observed["calls"]["serializeFault"] == 0)
    if passing:
        check(observed["calls"]["progress"] == 0 and result == dict(schema=1, status="SUPPLIED_CONTROLS_PASS",
            cases=len(CASES), names=CASES, realDockerInvocations=0, nativeQualification=False))
        check(observed["result"] == (0 if outcome == "full" else 71) and
              observed["publisher"].pass_published is (outcome == "full"))
    else:
        check(observed["calls"]["progress"] == 1 and observed["result"] == 71 and observed["publisher"].pass_published is False)
        check(result == dict(schema=1,status="SUPPLIED_CONTROLS_FAILED",phase="TRANSFER_CASES",
                             completedOriginalCases=115,nextOriginalOrdinal=116))
    check(SENTINEL not in data and b"PRIVATE-BINARY" not in data)
    check(observed["effects"] == ([data] if outcome in ("full","full-throw") else [data[:1]] if outcome=="short" else []))


def diagnostic_serialization_case():
    observed = observe_entry(action="pass", serialization_failure=True)
    check(observed["result"] == 71 and observed["publisher"].attempted is True and
          observed["publisher"].pass_published is False and observed["writes"] == [] and
          observed["calls"]["progress"] == observed["calls"]["writerFault"] == 0 and observed["calls"]["serializeFault"] == 1)


def diagnostic_failure_serialization_case():
    observed=observe_entry(serialization_failure="failure")
    check(observed["result"]==71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False and
          observed["writes"]==[] and observed["calls"]["progress"]==1 and observed["calls"]["serializeFault"]==1)


def diagnostic_oversize_case():
    observed=observe_entry(action="pass",serialization_oversize=True)
    check(observed["result"]==71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False and
          observed["writes"]==[] and observed["calls"]["progress"]==0 and observed["calls"]["serializeFault"]==1)


def diagnostic_catalog_case(kind):
    names=list(ORIGINAL_CASE_NAMES+DIAGNOSTIC_CASE_NAMES)
    if kind=="incomplete":
        names.pop()
    elif kind=="reordered":
        names[-2:]=reversed(names[-2:])
    with patch.dict(globals(),CASES=names):
        observed=observe_entry(phase="DIAGNOSTIC",completed=116,action="catalog")
        check(len(observed["writes"])==1)
        result=json.loads(observed["writes"][0][1])
        if kind=="complete":
            check(observed["result"]==0 and observed["publisher"].pass_published is True and
                  result==dict(schema=1,status="SUPPLIED_CONTROLS_PASS",cases=len(names),names=names,
                               realDockerInvocations=0,nativeQualification=False))
        else:
            check(observed["result"]==71 and observed["publisher"].pass_published is False and
                  result==dict(schema=1,status="SUPPLIED_CONTROLS_FAILED",phase="DIAGNOSTIC",
                               completedOriginalCases=116,nextOriginalOrdinal=None))


def diagnostic_repeat_case(swallow=False):
    observed = observe_entry(action="twice-swallow" if swallow else "twice")
    check(observed["result"] == 71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False and
          observed["publisher"].denied is True and
          len(observed["writes"]) == observed["calls"]["writerFault"] == 1 and observed["calls"]["progress"] == 0)
    check(observed["calls"]["secondPublish"]==1 and observed["calls"]["swallowed"]==int(swallow))
    check(json.loads(observed["writes"][0][1])["status"] == "SUPPLIED_CONTROLS_PASS")


def diagnostic_swallowed_publish_case(serialization):
    observed=observe_entry(action="pass-swallow",serialization_failure=serialization,outcome="full-throw")
    check(observed["result"]==71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False and
          observed["publisher"].denied is False and observed["calls"]["swallowed"]==1 and observed["calls"]["progress"]==0)
    check(observed["calls"]["serializeFault"]==int(serialization) and len(observed["writes"])==int(not serialization))
    check(observed["effects"]==([] if serialization else [observed["writes"][0][1]]))


def diagnostic_progress_case():
    observed=observe_entry(completed=115,progress_failure=True)
    check(observed["result"]==71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False and
          observed["calls"]["progress"]==1 and len(observed["writes"])==1)
    check(json.loads(observed["writes"][0][1])==dict(schema=1,status="SUPPLIED_CONTROLS_FAILED",phase="TRANSFER_CASES",
        completedOriginalCases=None,nextOriginalOrdinal=None))


def diagnostic_no_publish_case():
    observed=observe_entry(phase="SUMMARY",completed=116,action="return")
    check(observed["result"]==71 and observed["publisher"].attempted is True and observed["publisher"].pass_published is False and
          observed["calls"]["progress"]==1 and len(observed["writes"])==1)
    check(json.loads(observed["writes"][0][1])==dict(schema=1,status="SUPPLIED_CONTROLS_FAILED",phase="SUMMARY",
        completedOriginalCases=116,nextOriginalOrdinal=None))


def diagnostic_prefix_case(value, expected):
    with patch.dict(globals(),CASES=value):
        observed=completed_original_count()
    check(observed==expected and (type(observed) is int if expected is not None else observed is None))


def terminal_return_case(kind):
    writes, exits, kills = [], [], []
    def supplied_write(descriptor, data):
        writes.append((descriptor, data))
        return len(data)
    def supplied_exit(code):
        exits.append(code)  # deliberately RETURN; no actual process termination
    def supplied_kill(pid, sig):
        kills.append((pid, sig))  # installed before fixture captures real_kill
    # Restore fixture-assigned globals only after the actual returned result.
    with patch.object(T, "Transfer", T.Transfer), patch.object(os,"getpgrp",os.getpgrp), \
            patch.object(os,"getsid",os.getsid), patch.object(os,"killpg",os.killpg), \
            patch.object(os,"kill",supplied_kill), patch.object(os,"_exit",supplied_exit), \
            patch.object(os,"write",supplied_write), patch.object(sys,"argv",list(sys.argv)):
        result = terminal_entry(kind)
        check(result == 72 and exits == [71] and kills == ([(os.getpid(),signal.SIGKILL)] if kind == "group" else []))
        check(writes == [(1,b'{"schema":1,"status":"TRANSFER_FAILED","code":"UNCERTAIN_CLOSURE"}\n'),
                         (1,b'FINALIZER_REENTERED\n')])
    captured = b"".join(data for _, data in writes)
    requests, supplied_faults, created_parents = [], [], []
    target = "--terminal-" + kind
    healthy = b'{"schema":1,"status":"TRANSFER_FAILED","code":"UNCERTAIN_CLOSURE"}\n'
    def supplied_run(argv, **kwargs):
        requests.append((argv,kwargs))
        if argv[-1] == target:
            supplied_faults.append(target)
            return SimpleNamespace(returncode=result,stdout=captured,stderr=b"")
        return SimpleNamespace(returncode=71,stdout=healthy,stderr=b"")
    original_cases = CASES
    original_temporary = tempfile.TemporaryDirectory
    def recorded_temporary(*args, **kwargs):
        value = original_temporary(*args, **kwargs)
        created_parents.append((args,kwargs,value.name))
        return value
    # Parent's supplied healthy prefix is separate fixture data, never counted
    # as another actual original case or a new auxiliary process.
    private_cases=[]
    with patch.dict(globals(),CASES=private_cases), patch.object(subprocess,"run",supplied_run), \
            patch.object(tempfile,"TemporaryDirectory",recorded_temporary):
        refused=False
        try:
            terminal_controls()
        except AssertionError:
            refused=True
        check(refused and supplied_faults == [target] and len(private_cases) == (1 if kind == "group" else 0))
    check(CASES is original_cases and len(requests)==(2 if kind=="group" else 1))
    check(len(created_parents)==1 and created_parents[0][:2]==((),dict(prefix="private-terminal-controls-")))
    expected_selectors=["--terminal-objects","--terminal-group"] if kind=="group" else ["--terminal-objects"]
    for (argv,kwargs),selector in zip(requests,expected_selectors):
        check(argv==[sys.executable,"-I","-S","-B",str(Path(__file__).resolve()),selector] and
              kwargs==dict(stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                  env={"PATH":"/usr/bin:/bin","HOME":created_parents[0][2],"LANG":"C","LC_ALL":"C"},
                  close_fds=True,start_new_session=False,timeout=2,check=False))
        check(len(argv)==6 and argv[:5]==[sys.executable,"-I","-S","-B",str(Path(__file__).resolve())] and
              argv[-1] in ("--terminal-objects","--terminal-group") and kwargs["start_new_session"] is False and
              kwargs["timeout"]==2 and kwargs["check"] is False and kwargs["close_fds"] is True)


def terminal_clock_case(primary):
    h=Harness(payload(71),fault="register-stdout" if primary else None)
    entries=[]
    original_cleanup=T.Transfer.cleanup
    def supplied_cleanup(subject):
        entries.append(subject)
        if primary:
            h.now=100.0
        original_cleanup(subject)
        if not primary:
            h.now=100.0
    with tempfile.TemporaryDirectory(prefix="transfer-terminal-clock-") as temporary:
        parent=Path(temporary)
        parent.chmod(0o700)
        directory=parent/"artifacts"
        directory.mkdir(mode=0o700)
        pinfo,dinfo=parent.stat(),directory.stat()
        h.alias_path=str(parent/"alias")
        h.transfer=T.Transfer(str(directory),CONTAINER,"policy.o",71,hashlib.sha256(h.expected).hexdigest(),100.0,
            (pinfo.st_dev,pinfo.st_ino),(dinfo.st_dev,dinfo.st_ino))
        bindings=[(os,n,h.checked(getattr(h,n))) for n in ("open","read","write","close","fstat","set_blocking")]
        bindings += [(T.subprocess,"Popen",h.checked(h.popen)),(T.selectors,"DefaultSelector",h.checked(h.make_selector)),
            (T.time,"monotonic",lambda:h.now),(T.time,"sleep",lambda _:setattr(h,"now",h.now+0.01)),
            (T.Transfer,"cleanup",supplied_cleanup)]
        try:
            for obj,name,value in bindings:
                p=patch.object(obj,name,value)
                p.start()
                h.patchers.append(p)
            report=h.transfer.execute()
            check(entries==[h.transfer] and h.now==100.0 and h.transfer.failed is True and h.transfer.complete is False and
                  report["status"]=="TRANSFER_FAILED" and report["code"]==("BOUNDARY_FAILURE" if primary else "DEADLINE"))
            check(not h.callback_errors and report["returnedReadBytes"]==h.supplied_returned_read_bytes and
                  report["readAttempts"]==h.read_boundary_attempts)
            if primary:
                check(h.delivered and report["ownedResourcesClosed"] is False and report["childClosedKnown"] is False and
                      set(h.transfer.objects)=={"stdout","stderr","selector"} and len(h.transfer.fds)==2 and
                      h.process.polls==h.process.kills==h.process.waits==0 and h.selector.closes==0 and
                      h.process.stdout.close_calls==h.process.stderr.close_calls==0)
            else:
                check(not h.delivered and report["ownedResourcesClosed"] is True and report["childClosedKnown"] is True and
                      report["hostSha256"]==hashlib.sha256(h.expected).hexdigest() and h.live_fds==set() and
                      h.process.kills==0 and h.process.waits==1 and h.selector.closes==1 and
                      h.process.stdout.close_calls==h.process.stderr.close_calls==1)
        finally:
            for p in reversed(h.patchers):
                p.stop()
        # Independent fixture cleanup only after all subject/clock assertions;
        # original100.0 clock is never repaired and no subject close is retried.
        for descriptor in h.live_fds:
            REAL["close"](descriptor)


def diagnostic_controls():
    hostile_calls=[]
    hostile=DiagnosticError(hostile_calls)
    rows=(
        ("diag-count-0","TRANSFER_CASES",0,"TRANSFER_CASES",0,1),
        ("diag-count-115","TRANSFER_CASES",115,"TRANSFER_CASES",115,116),
        ("diag-count-116","TRANSFER_CASES",116,"TRANSFER_CASES",116,None),
        ("diag-count-bool","TRANSFER_CASES",True,"TRANSFER_CASES",None,None),
        ("diag-count-negative","TRANSFER_CASES",-1,"TRANSFER_CASES",None,None),
        ("diag-count-overflow","TRANSFER_CASES",117,"TRANSFER_CASES",None,None),
        ("diag-count-float","TRANSFER_CASES",0.0,"TRANSFER_CASES",None,None),
        ("diag-count-hostile","TRANSFER_CASES",hostile,"TRANSFER_CASES",None,None),
        ("diag-phase-unknown","outside",0,"UNKNOWN",0,None),
        ("diag-phase-hostile",hostile,115,"UNKNOWN",115,None),
        ("diag-phase-initial","INITIAL",0,"INITIAL",0,None),
        ("diag-phase-summary","SUMMARY",116,"SUMMARY",116,None),
    )
    for name,phase,count,ep,ec,en in rows:
        case(name,lambda phase=phase,count=count,ep=ep,ec=ec,en=en:diagnostic_entry_case(phase,count,ep,ec,en))
    check(hostile_calls==[])
    prefix_rows=(
        ("diag-prefix-0",[],0),
        ("diag-prefix-115",list(ORIGINAL_CASE_NAMES[:115]),115),
        ("diag-prefix-116",list(ORIGINAL_CASE_NAMES),116),
        ("diag-prefix-expanded",list(ORIGINAL_CASE_NAMES)+["diag-extra"],116),
        ("diag-prefix-nonlist",ORIGINAL_CASE_NAMES,None),
        ("diag-prefix-hostile",[hostile],None),
        ("diag-prefix-foreign",["foreign"],None),
        ("diag-prefix-reordered",list(reversed(ORIGINAL_CASE_NAMES[:2])),None),
    )
    for name,value,expected in prefix_rows:
        case(name,lambda value=value,expected=expected:diagnostic_prefix_case(value,expected))
    check(hostile_calls==[])
    for passing,prefix in ((False,"diag-fail-write-"),(True,"diag-pass-write-")):
        for outcome in ("zero","short","boolean","negative","impossible","throw","full-throw","full"):
            case(prefix+outcome,lambda outcome=outcome,passing=passing:diagnostic_writer_case(outcome,passing=passing))
    case("diag-pass-serialize",diagnostic_serialization_case)
    case("diag-fail-serialize",diagnostic_failure_serialization_case)
    case("diag-pass-oversize",diagnostic_oversize_case)
    case("diag-catalog-incomplete",lambda:diagnostic_catalog_case("incomplete"))
    case("diag-catalog-reordered",lambda:diagnostic_catalog_case("reordered"))
    case("diag-catalog-complete",lambda:diagnostic_catalog_case("complete"))
    case("diag-publish-twice",diagnostic_repeat_case)
    case("diag-publish-swallow",lambda:diagnostic_repeat_case(True))
    case("diag-swallowed-write",lambda:diagnostic_swallowed_publish_case(False))
    case("diag-swallowed-serialize",lambda:diagnostic_swallowed_publish_case(True))
    case("diag-progress-error",diagnostic_progress_case)
    case("diag-no-publish",diagnostic_no_publish_case)
    case("diag-terminal-return-objects",lambda:terminal_return_case("objects"))
    case("diag-terminal-return-group",lambda:terminal_return_case("group"))
    case("diag-terminal-clock",lambda:terminal_clock_case(False))
    case("diag-primary-clock",lambda:terminal_clock_case(True))


def main(publisher):
    publisher.phase = "TRANSFER_CASES"
    for size in (0, 1, 65535, 65536, 65537, 1048576, 33554432):
        case("payload-boundary-" + str(size), lambda size=size: positive(size))
    case("fragmented-positive-short-writes", lambda: positive(65537, fragment=137, short_write=17))
    case("stderr-eof-first", lambda: positive(65537, stderr_first=True))
    case("eof-before-child-completion", lambda: positive(71, exit_delay=3))
    faults = {
        "existing-file": "BOUNDARY_FAILURE", "directory-mode": "DIRECTORY_IDENTITY",
        "directory-replaced": "DIRECTORY_IDENTITY",
        "open-before-output": "BOUNDARY_FAILURE", "open-after-output": "BOUNDARY_FAILURE",
        "selector-before": "BOUNDARY_FAILURE", "selector-after": "BOUNDARY_FAILURE",
        "selector-fd-collision": "FD_IDENTITY", "popen-before": "BOUNDARY_FAILURE", "popen-after": "BOUNDARY_FAILURE",
        "same-pipe": "PIPE_IDENTITY", "bad-pid": "PIPE_IDENTITY", "pipe-fd-collision": "PIPE_IDENTITY",
        "register-stdout": "BOUNDARY_FAILURE", "register-stderr": "BOUNDARY_FAILURE",
        "nonblocking": "BOUNDARY_FAILURE", "select": "BOUNDARY_FAILURE", "unregister-stdout": "BOUNDARY_FAILURE",
        "unregister-stderr": "BOUNDARY_FAILURE", "read-stdout": "BOUNDARY_FAILURE", "read-stderr": "BOUNDARY_FAILURE",
        "invalid-read": "READ_RESULT", "write-before": "BOUNDARY_FAILURE", "write-zero": "WRITE_RESULT",
        "write-negative": "WRITE_RESULT", "write-bool": "WRITE_RESULT", "write-too-large": "WRITE_RESULT",
        "write-after-full": "BOUNDARY_FAILURE", "close-output-before": "BOUNDARY_FAILURE",
        "close-output-after-reuse": "BOUNDARY_FAILURE", "readback": "BOUNDARY_FAILURE",
        "changed-readback": "FILE_IDENTITY", "poll": "BOUNDARY_FAILURE", "wait": "UNCERTAIN_CLOSURE",
        "readback-pipe-alias": "FD_IDENTITY", "readback-selector-alias": "FD_IDENTITY",
        "close-stdout": "UNCERTAIN_CLOSURE", "close-stderr": "UNCERTAIN_CLOSURE", "selector-close": "UNCERTAIN_CLOSURE",
        "child-remains-live": "DEADLINE", "pipes-remain-open": "DEADLINE", "deadline-write": "DEADLINE",
        "deadline-read-stdout": "DEADLINE", "fstat-output": "BOUNDARY_FAILURE",
    }
    for fault, code in faults.items():
        case(fault, lambda fault=fault, code=code: negative(fault, code))
    case("write-after-partial", lambda: negative("write-after-partial", "BOUNDARY_FAILURE", short_write=7))
    for name, actual, expected, stderr, returncode, code in (
        ("truncated", payload(70), payload(71), b"", 0, "TRUNCATED_OR_CHANGED"),
        ("extra-byte", payload(72), payload(71), b"", 0, "STDOUT_EXCESS"),
        ("wrong-hash", b"x" * 71, payload(71), b"", 0, "TRUNCATED_OR_CHANGED"),
        ("stderr-private", payload(71), payload(71), SENTINEL, 0, "CHILD_RESULT"),
        ("stderr-overflow", payload(71), payload(71), payload(65537), 0, "STDERR_EXCESS"),
        ("nonzero-exit", payload(71), payload(71), b"", 2, "CHILD_RESULT"),
    ):
        h = Harness(actual, expected=expected, stderr=stderr, returncode=returncode).run()
        check(h.report["status"] == "TRANSFER_FAILED" and h.report["code"] == code)
        CASES.append(name)
    publisher.phase = "SNAPSHOT"
    snapshot_controls()
    publisher.phase = "CONSTRUCTOR"
    constructor_controls()
    publisher.phase = "CAPACITY"
    capacity_controls()
    publisher.phase = "EMIT"
    emit_controls()
    publisher.phase = "TERMINAL"
    terminal_controls()
    publisher.phase = "ASSERTION_RECORDER"
    assertion_recorder_control()
    publisher.phase = "LIVE_CHILD_CLEANUP"
    live_child_cleanup_controls()
    check(tuple(CASES) == ORIGINAL_CASE_NAMES)
    publisher.phase = "DIAGNOSTIC"
    diagnostic_controls()
    finish_controls(publisher)


if __name__ == "__main__":
    if sys.argv[1:] in (["--terminal-objects"], ["--terminal-group"]):
        raise SystemExit(terminal_entry(sys.argv[1].removeprefix("--terminal-")))
    raise SystemExit(ordinary_entry())
