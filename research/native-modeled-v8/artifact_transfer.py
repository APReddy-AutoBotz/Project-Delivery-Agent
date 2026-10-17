"""EXEC-016/TR-DEP-004: fixed private transfer worker (unapproved draft).

The outer reviewed driver owns the original deadline, full storage reservation,
three-second process group and builder retirement. Binary data never enters a
receipt or this worker's stdout/stderr. No shell, mount or UID change exists.
"""
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import stat
import subprocess
import sys
import time

UNITS = ("policy", "policy-controls", "policy-install-controls", "state", "state-controls", "observer")
MODELS = ("policy", "installer", "state")
NAMES = tuple(unit + suffix for unit in UNITS for suffix in (".o", ".d")) + tuple(
    model + suffix for model in MODELS for suffix in ("-model", ".map"))
CHUNK, MAX_STDERR = 65536, 65536
MAX_HANDLES, MAX_ACQUISITIONS = 8, 80
NATIVE_FD_BUDGET, POPEN_TRANSIENT_FDS = 16, 7
READER_SHA256 = "29c2b4969a0a8fe18aaab89629bf1f46822698a18cc70b7d79438d280052710e"
REASONS = frozenset(("ADMISSION", "DEADLINE", "CAPACITY", "BOUNDARY_FAILURE", "FD_IDENTITY",
    "DIRECTORY_IDENTITY", "FILE_IDENTITY", "PIPE_IDENTITY", "READ_RESULT", "STDOUT_EXCESS",
    "STDERR_EXCESS", "WRITE_RESULT", "TRUNCATED_OR_CHANGED", "CHILD_RESULT", "UNCERTAIN_CLOSURE"))


class Refused(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(value, code):
    if not value:
        raise Refused(code)


def maximum(name):
    require(type(name) is str and name in NAMES, "ADMISSION")
    return 1048576 if name.endswith((".d", ".map")) else 33554432


def unique_pairs(items):
    value = {}
    for key, item in items:
        require(key not in value, "ADMISSION")
        value[key] = item
    return value


def no_constant(_):
    raise Refused("ADMISSION")


def decode_snapshot(payload, wanted):
    require(type(payload) is bytes and len(payload) <= 16384 and type(wanted) is tuple and len(wanted) <= 18 and
            all(type(name) is str and name in NAMES for name in wanted), "ADMISSION")
    require(wanted == tuple(name for name in NAMES if name in wanted), "ADMISSION")
    value = json.loads(payload, object_pairs_hook=unique_pairs, parse_constant=no_constant)
    require(type(value) is list and len(value) == len(wanted), "ADMISSION")
    result, total = [], 0
    for name, row in zip(wanted, value):
        require(type(row) is dict and len(row) == 3 and set(row) == {"name", "bytes", "sha256"} and
                type(row["name"]) is str and row["name"] == name and type(row["bytes"]) is int and
                0 <= row["bytes"] <= maximum(name) and type(row["sha256"]) is str and
                re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), "ADMISSION")
        total += row["bytes"]
        require(total <= 268435456, "CAPACITY")
        result.append(dict(row))
    return result


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


class Transfer:
    def __init__(self, directory, container, name, size, digest, deadline, fixture_identity, directory_identity):
        require(type(directory) is str and 0 < len(directory) <= 4096 and
                str(PurePosixPath(directory)) == directory and directory.startswith("/") and
                all(part not in ("", ".", "..") for part in directory.split("/")[1:]) and
                len(PurePosixPath(directory).parts) <= 64 and
                type(container) is str and re.fullmatch(r"[0-9a-f]{64}", container) and
                type(size) is int and 0 <= size <= maximum(name) and type(digest) is str and
                re.fullmatch(r"[0-9a-f]{64}", digest) and type(deadline) is float and
                math.isfinite(deadline), "ADMISSION")
        require(all(type(pair) is tuple and len(pair) == 2 and
                    all(type(value) is int and value >= 0 for value in pair)
                    for pair in (fixture_identity, directory_identity)), "ADMISSION")
        self.directory, self.container, self.name = Path(directory), container, name
        self.fixture_identity, self.directory_identity = fixture_identity, directory_identity
        self.size, self.expected, self.deadline = size, digest, deadline
        self.failed, self.code, self.complete = False, "BOUNDARY_FAILURE", False
        self.fds, self.objects, self.pending, self.uncertain_closes = {}, {}, {}, {}
        self.object_fds = {}
        self.acquisitions = self.closes = 0
        self.native_pending, self.native_fd_peak_reserved = {}, 3
        self.process = self.selector = None
        self.process_admitted = False
        self.selector_fd = None
        self.child_closed = False
        self.stdout_eof = self.stderr_eof = False
        self.received = self.written = self.write_uncertain = self.stderr_bytes = 0
        self.read_uncertain = 0
        self.returned_read_bytes = self.read_attempts = 0
        self.stdout_hash, self.stderr_hash = hashlib.sha256(), hashlib.sha256()
        self.host_hash = None
        self.opened_identity = None
        self.report_identity = None

    def guard(self, cleanup=False):
        require(time.monotonic() < self.deadline - (0 if cleanup else 0.1), "DEADLINE")
        require(cleanup or not self.failed, "BOUNDARY_FAILURE")

    def reserve(self, role, slots=1):
        self.guard()
        require(role not in self.pending and role not in self.objects and
                role not in self.uncertain_closes and self.acquisitions < MAX_ACQUISITIONS and
                len(self.fds) + len(self.objects) + sum(self.pending.values()) +
                len(self.uncertain_closes) + int(self.process is not None and not self.child_closed) + slots <= MAX_HANDLES, "CAPACITY")
        native_slots = POPEN_TRANSIENT_FDS if role == "process" else slots
        prospective = (3 + len(self.fds) + len(self.objects) + sum(self.native_pending.values()) +
                       len(self.uncertain_closes) + native_slots)
        require(role not in self.native_pending and prospective <= NATIVE_FD_BUDGET, "CAPACITY")
        self.pending[role] = slots
        self.native_pending[role] = native_slots
        self.native_fd_peak_reserved = max(self.native_fd_peak_reserved, prospective)
        self.acquisitions += 1

    def open_fd(self, path, flags, role, directory=None):
        self.reserve(role)
        result = os.open(path, flags | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        # Retain a returned acquisition before any further native inspection.
        if type(result) is not int or result < 3 or result in self.fds or result in self.object_fds.values():
            if type(result) is int and result in self.fds:
                self.uncertain_closes["collision"] = self.fds.pop(result)
            for owner in tuple(self.object_fds):
                if type(result) is int and self.object_fds[owner] == result:
                    del self.object_fds[owner]
                    self.uncertain_closes["fd-alias-" + owner] = self.objects.pop(owner)
            raise Refused("FD_IDENTITY")
        self.fds[result] = role
        del self.pending[role]
        del self.native_pending[role]
        self.guard()
        return result

    def close_fd(self, descriptor):
        self.guard(cleanup=True)
        role = self.fds.pop(descriptor)
        key = "fd-" + str(descriptor)
        self.uncertain_closes[key] = descriptor  # no retry after possible effect
        os.close(descriptor)
        del self.uncertain_closes[key]
        self.closes += 1

    def close_object(self, role):
        self.guard(cleanup=True)
        value = self.objects.pop(role)
        self.object_fds.pop(role, None)
        self.uncertain_closes[role] = value  # hold ambiguous objects, prevent GC reuse
        value.close()
        del self.uncertain_closes[role]
        self.closes += 1

    def anchored_directory(self):
        descriptor = self.open_fd("/", os.O_RDONLY | os.O_DIRECTORY, "directory")
        cursor = Path("/")
        for part in self.directory.parts[1:]:
            child = self.open_fd(part, os.O_RDONLY | os.O_DIRECTORY, "next-directory", descriptor)
            previous, descriptor = descriptor, child
            self.close_fd(previous)
            cursor = cursor / part
            info = self.fstat(descriptor)
            require(stat.S_ISDIR(info.st_mode), "DIRECTORY_IDENTITY")
            if cursor in (self.directory.parent, self.directory):
                require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700,
                        "DIRECTORY_IDENTITY")
                expected = self.directory_identity if cursor == self.directory else self.fixture_identity
                require((info.st_dev, info.st_ino) == expected, "DIRECTORY_IDENTITY")
        return descriptor

    def fstat(self, descriptor):
        self.guard()
        value = os.fstat(descriptor)
        self.guard()
        return value

    def path_stat(self, parent):
        self.guard()
        value = os.stat(self.name, dir_fd=parent, follow_symlinks=False)
        self.guard()
        return value

    def regular(self, info, size):
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1 and
                info.st_size == size and stat.S_IMODE(info.st_mode) == 0o600, "FILE_IDENTITY")

    def read(self, descriptor, wanted):
        self.guard()
        require(type(wanted) is int and 1 <= wanted <= CHUNK, "CAPACITY")
        self.read_uncertain += wanted
        self.read_attempts += 1
        block = os.read(descriptor, wanted)
        require(type(block) is bytes and len(block) <= wanted, "READ_RESULT")
        self.returned_read_bytes += len(block)
        self.read_uncertain -= wanted
        self.guard()
        return block

    def write(self, descriptor, block):
        offset = 0
        while offset < len(block):
            self.guard()
            offered = len(block) - offset
            require(self.written + self.write_uncertain + offered <= self.size, "CAPACITY")
            self.write_uncertain += offered
            actual = os.write(descriptor, memoryview(block)[offset:])
            require(type(actual) is int and 0 < actual <= offered, "WRITE_RESULT")
            self.written += actual
            self.write_uncertain -= offered
            offset += actual
            self.guard()

    def start(self, reader):
        self.reserve("selector")
        self.selector = selectors.DefaultSelector()
        self.objects["selector"] = self.selector
        del self.pending["selector"]
        del self.native_pending["selector"]
        self.selector_fd = self.selector.fileno()
        if type(self.selector_fd) is not int or self.selector_fd < 3 or self.selector_fd in self.fds:
            self.uncertain_closes["invalid-selector"] = self.objects.pop("selector")
            if type(self.selector_fd) is int and self.selector_fd in self.fds:
                self.uncertain_closes["selector-fd-collision"] = self.fds.pop(self.selector_fd)
            raise Refused("FD_IDENTITY")
        self.object_fds["selector"] = self.selector_fd
        self.reserve("process", 3)
        argv = ["/usr/bin/docker", "exec", "--workdir", "/work", self.container,
                "/usr/local/bin/node", "-e", reader, "--", self.name, str(self.size), self.expected]
        env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "HOME": str(self.directory.parent)}
        self.guard()
        self.process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, close_fds=True, start_new_session=False, bufsize=0)
        # Keep the process immediately, including when later pipe inspection fails.
        self.pending["process"] = 2  # one of the three reserved results is held
        require(type(self.process.pid) is int and self.process.pid > 0, "PIPE_IDENTITY")
        self.process_admitted = True
        for role in ("stdout", "stderr"):
            stream = getattr(self.process, role)
            if stream is not None:
                self.objects[role] = stream
                self.pending["process"] -= 1
        if self.process.stdout is None or self.process.stderr is None or self.process.stdout is self.process.stderr:
            for role in ("stdout", "stderr"):
                if role in self.objects:
                    self.uncertain_closes["invalid-" + role] = self.objects.pop(role)
            raise Refused("PIPE_IDENTITY")
        pipe_fds = [self.process.stdout.fileno(), self.process.stderr.fileno()]
        if not (all(type(value) is int and value >= 3 and value not in self.fds and value != self.selector_fd
                    for value in pipe_fds) and len(set(pipe_fds)) == 2):
            for role in ("stdout", "stderr"):
                self.uncertain_closes["invalid-" + role] = self.objects.pop(role)
            for value in pipe_fds:
                if type(value) is int and value in self.fds:
                    self.uncertain_closes["pipe-fd-collision-" + str(value)] = self.fds.pop(value)
                if type(value) is int and value == self.selector_fd and "selector" in self.objects:
                    self.object_fds.pop("selector", None)
                    self.uncertain_closes["selector-alias"] = self.objects.pop("selector")
            raise Refused("PIPE_IDENTITY")
        del self.pending["process"]
        del self.native_pending["process"]
        self.object_fds.update(stdout=pipe_fds[0], stderr=pipe_fds[1])
        for role in ("stdout", "stderr"):
            stream = self.objects[role]
            self.guard()
            os.set_blocking(stream.fileno(), False)
            self.guard()
            self.selector.register(stream, selectors.EVENT_READ, role)
        self.guard()

    def collect(self, output):
        while not self.stdout_eof or not self.stderr_eof:
            self.guard()
            for key, _ in self.selector.select(min(0.02, max(0, self.deadline - time.monotonic() - 0.1))):
                self.guard()
                role = key.data
                require(role in ("stdout", "stderr") and key.fileobj is self.objects[role], "PIPE_IDENTITY")
                remaining = self.size - self.received if role == "stdout" else MAX_STDERR - self.stderr_bytes
                block = self.read(key.fileobj.fileno(), min(CHUNK, remaining + 1))
                if not block:
                    self.guard()
                    self.selector.unregister(key.fileobj)
                    self.guard()
                    if role == "stdout":
                        self.stdout_eof = True
                    else:
                        self.stderr_eof = True
                    continue
                if role == "stdout":
                    require(self.received + len(block) <= self.size, "STDOUT_EXCESS")
                    self.received += len(block)
                    self.stdout_hash.update(block)
                    self.write(output, block)
                else:
                    require(self.stderr_bytes + len(block) <= MAX_STDERR, "STDERR_EXCESS")
                    self.stderr_bytes += len(block)
                    self.stderr_hash.update(block)
        while True:
            self.guard()
            result = self.process.poll()
            self.guard()
            if result is not None:
                break
            time.sleep(min(0.01, max(0, self.deadline - time.monotonic() - 0.1)))
        self.child_closed = True
        require(self.process.returncode == 0 and self.stderr_bytes == 0, "CHILD_RESULT")
        require(self.received == self.written == self.size and self.stdout_hash.hexdigest() == self.expected,
                "TRUNCATED_OR_CHANGED")

    def verify(self, parent):
        self.guard()
        descriptor = self.open_fd(self.name, os.O_RDONLY, "readback", parent)
        before = self.fstat(descriptor)
        self.regular(before, self.size)
        require((before.st_dev, before.st_ino) == self.opened_identity, "FILE_IDENTITY")
        digest, count = hashlib.sha256(), 0
        while count < self.size:
            block = self.read(descriptor, min(CHUNK, self.size - count))
            require(block, "TRUNCATED_OR_CHANGED")
            count += len(block)
            digest.update(block)
        require(self.read(descriptor, 1) == b"" and digest.hexdigest() == self.expected, "TRUNCATED_OR_CHANGED")
        final = self.fstat(descriptor)
        path = self.path_stat(parent)
        require(file_identity(before) == file_identity(final) == file_identity(path), "FILE_IDENTITY")
        self.host_hash = digest.hexdigest()
        self.report_identity = dict(device=final.st_dev, inode=final.st_ino, uid=final.st_uid,
                                    mode=stat.S_IMODE(final.st_mode), bytes=final.st_size)
        self.close_fd(descriptor)
        self.guard()

    def cleanup(self):
        # Known unreaped child ownership prevents PID reuse while killing/waiting.
        if self.process is not None and self.process_admitted:
            try:
                self.guard(cleanup=True)
                if self.process.poll() is None:
                    self.guard(cleanup=True)
                    self.process.kill()
                self.guard(cleanup=True)
                self.process.wait(timeout=max(0.001, self.deadline - time.monotonic()))
                self.child_closed = True
            except BaseException:
                self.failed = True
                self.child_closed = False
        for role in ("stdout", "stderr", "selector"):
            if role in self.objects:
                try:
                    self.close_object(role)
                except BaseException:
                    self.failed = True
        for descriptor in list(self.fds):
            try:
                self.close_fd(descriptor)
            except BaseException:
                self.failed = True
        if self.pending or self.native_pending or self.uncertain_closes or self.fds or self.objects or not self.child_closed:
            self.failed = True

    def load_reader(self):
        path = Path(__file__).with_name("artifact_reader.js")
        descriptor = self.open_fd(str(path), os.O_RDONLY, "reader-source")
        before = self.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1 and
                0 < before.st_size <= 16384, "ADMISSION")
        data = bytearray()  # fixed first-party program, never artifact payload
        while len(data) < before.st_size:
            block = self.read(descriptor, min(CHUNK, before.st_size - len(data)))
            require(block, "ADMISSION")
            data.extend(block)
        require(self.read(descriptor, 1) == b"", "ADMISSION")
        final = self.fstat(descriptor)
        self.guard()
        final_path = path.lstat()
        self.guard()
        require(file_identity(before) == file_identity(final) == file_identity(final_path) and
                hashlib.sha256(data).hexdigest() == READER_SHA256, "ADMISSION")
        self.close_fd(descriptor)
        return data.decode("ascii")

    def execute(self):
        try:
            self.guard()
            reader = self.load_reader()
            parent = self.anchored_directory()
            output = self.open_fd(self.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, "output", parent)
            before = self.fstat(output)
            self.regular(before, 0)
            self.opened_identity = (before.st_dev, before.st_ino)
            self.start(reader)
            self.collect(output)
            self.close_fd(output)
            self.verify(parent)
            self.guard()
        except BaseException as error:
            self.failed = True
            self.code = error.code if type(error) is Refused and type(error.code) is str and error.code in REASONS else "BOUNDARY_FAILURE"
        finally:
            self.cleanup()
        try:
            self.guard(cleanup=True)
            require(not self.failed and not self.pending and not self.native_pending and not self.uncertain_closes and self.child_closed and
                    self.stdout_eof and self.stderr_eof and self.host_hash == self.expected and not self.write_uncertain and
                    not self.read_uncertain, "UNCERTAIN_CLOSURE")
            self.complete = True
        except BaseException as error:
            self.failed = True
            if self.code == "BOUNDARY_FAILURE" and type(error) is Refused:
                self.code = error.code
        return self.report()

    def report(self):
        return dict(schema=1, status="VERIFIED_PRIVATE_PENDING_BUILDER_RETIREMENT" if self.complete else "TRANSFER_FAILED",
            code="NONE" if self.complete else self.code, name=self.name, container=self.container,
            expectedBytes=self.size, receivedBytes=self.received, verifiedWriteBytes=self.written,
            uncertainWriteBytes=self.write_uncertain, uncertainReadBytes=self.read_uncertain,
            returnedReadBytes=self.returned_read_bytes, readAttempts=self.read_attempts,
            streamSha256=self.stdout_hash.hexdigest(), hostSha256=self.host_hash,
            stderrBytes=self.stderr_bytes, stderrSha256=self.stderr_hash.hexdigest(),
            stdoutEof=self.stdout_eof, stderrEof=self.stderr_eof,
            childClosedKnown=self.child_closed, acquisitions=self.acquisitions, closes=self.closes,
            pendingAcquisitions=dict(self.pending), uncertainCloseRoles=sorted(self.uncertain_closes),
            nativePendingReservations=dict(self.native_pending), nativeFdBudget=NATIVE_FD_BUDGET,
            nativeFdPeakReserved=self.native_fd_peak_reserved,
            ownedResourcesClosed=not self.fds and not self.objects and not self.pending and not self.native_pending and not self.uncertain_closes,
            hostIdentity=self.report_identity, nativeQualification=False)


def emit(value):
    # One metadata attempt only. Do not print a traceback or retry a partial write.
    try:
        payload = (json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n").encode("ascii")
        if len(payload) > 4096:
            return False
        count = os.write(1, payload)
        return type(count) is int and count == len(payload)
    except BaseException:
        return False


def main():
    transfer = None
    try:
        require(sys.platform == "linux" and sys.version_info[:2] == (3, 12) and os.getuid() != 0 and
                os.getpid() == os.getpgrp() == os.getsid(0) and len(sys.argv) == 11, "ADMISSION")
        directory, container, name, size_text, digest, end_text, fixture_dev, fixture_ino, directory_dev, directory_ino = sys.argv[1:]
        require(directory == str(Path(os.environ["HOME"]) / "artifacts") and
                re.fullmatch(r"0|[1-9][0-9]{0,8}", size_text), "ADMISSION")
        deadline = float(end_text)
        require(math.isfinite(deadline) and time.monotonic() < deadline <= time.monotonic() + 3, "ADMISSION")
        require(all(re.fullmatch(r"0|[1-9][0-9]{0,19}", value) for value in
                    (fixture_dev, fixture_ino, directory_dev, directory_ino)), "ADMISSION")
        transfer = Transfer(directory, container, name, int(size_text), digest, deadline,
                            (int(fixture_dev), int(fixture_ino)), (int(directory_dev), int(directory_ino)))
        report = transfer.execute()
    except BaseException:
        report = dict(schema=1, status="TRANSFER_FAILED", code="ADMISSION")
    if transfer is not None and transfer.complete:
        try:
            transfer.guard(cleanup=True)
        except BaseException:
            transfer.complete, transfer.failed, transfer.code = False, True, "DEADLINE"
            report = transfer.report()
    emitted = emit(report)
    if transfer is not None and ("process" in transfer.pending or not transfer.child_closed and transfer.process is not None):
        # Never release the live outer group leader while an inner client may
        # remain. The original D.command owns the enclosing three-second cap.
        try:
            os.killpg(os.getpid(), signal.SIGKILL)
        except BaseException:
            while True:
                try:
                    signal.pause()  # outer owner's fixed deadline kills this group
                except BaseException:
                    pass
    if transfer is not None and (transfer.pending or transfer.native_pending or transfer.uncertain_closes or
                                  transfer.fds or transfer.objects):
        # Avoid Python teardown/finalizers for ambiguously closed owned objects.
        # Child/group uncertainty above instead retains the outer group leader.
        try:
            os._exit(71)
        except BaseException:
            while True:
                try:
                    signal.pause()
                except BaseException:
                    pass
    if transfer is not None and transfer.complete and emitted:
        try:
            transfer.guard(cleanup=True)
            return 0
        except BaseException:
            pass
    return 71


if __name__ == "__main__":
    raise SystemExit(main())
