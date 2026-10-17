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


def main():
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
    snapshot_controls()
    constructor_controls()
    capacity_controls()
    emit_controls()
    terminal_controls()
    assertion_recorder_control()
    live_child_cleanup_controls()
    print(json.dumps(dict(schema=1, status="SUPPLIED_CONTROLS_PASS", cases=len(CASES), names=CASES,
                         realDockerInvocations=0, nativeQualification=False), separators=(",", ":")))


if __name__ == "__main__":
    try:
        if sys.argv[1:] in (["--terminal-objects"], ["--terminal-group"]):
            terminal_fixture(sys.argv[1].removeprefix("--terminal-"))
        else:
            main()
    except BaseException:
        # Never expose fixture binary, arbitrary subject errors or tracebacks.
        print('{"schema":1,"status":"SUPPLIED_CONTROLS_FAILED"}')
        raise SystemExit(71)
