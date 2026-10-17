"""EXEC-016/AC-HLT-003/TR-DEP-004 guarded file-owner supplied controls.

SOURCE ONLY until exact whole-packet review and a fresh research allowance.
The real HostFiles bodies use real private files/descriptors and supplied,
externally checked native boundaries. No Docker/compiler/native qualification.
Fixture teardown is control-owned and never counts as subject closure evidence.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("guarded_host_files_control_subject", ROOT / "host_files.py")
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)
REAL = {name: getattr(os, name) for name in ("open", "read", "close", "fstat", "stat", "fchmod", "scandir", "dup2")}
SENTINEL = b"\x00PRIVATE-HOST-BYTES-\xff\xfe-NEVER-PUBLIC\x80\n"
CASES = []


def check(value):
    if not value:
        raise AssertionError("CONTROL_ASSERTION")


def payload(size):
    return (SENTINEL * (size // len(SENTINEL) + 1))[:size]


def case(name, body):
    body()
    CASES.append(name)


def changed(info, **values):
    fields = {key: getattr(info, key) for key in
              ("st_dev", "st_ino", "st_mode", "st_uid", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")}
    fields.update(values)
    return SimpleNamespace(**fields)


class Census:
    def __init__(self, harness, iterator):
        self.h, self.iterator, self.calls, self.closes = harness, iterator, 0, 0
        self.close = harness.checked(self.close)

    def __next__(self):
        # Special method dispatch uses the class method, so the class body also
        # records entry/assertions; no supplied object-method assertion is lost.
        return self.h.checked(self.advance)()

    def advance(self):
        self.h.native("iterator-next")
        self.calls += 1
        check(self.calls <= 19 and self.h.owner.opaque_directory_slots == 1 and
              self.h.owner.census_attempted and self.h.owner.objects.get("iterator") is self)
        self.h.point("next-before")
        if self.h.namespace == "missing" and self.calls == 18:
            self.h.delivered = True
            raise StopIteration
        try:
            entry = next(self.iterator)
        except StopIteration:
            self.h.point("next-eof")
            raise
        self.h.point("next-after")
        if self.h.namespace == "duplicate" and self.calls == 2:
            self.h.delivered = True
            return SimpleNamespace(name=self.h.first_name)
        self.h.first_name = entry.name if self.calls == 1 else self.h.first_name
        return entry

    def close(self):
        self.h.native("iterator-close", cleanup=True)
        self.closes += 1
        check(self.closes == 1)
        self.h.point("iterator-close-before")
        result = self.iterator.close()
        self.h.point("iterator-close-after")
        return result


class Harness:
    def __init__(self, owned, size=71, *, name="policy.o", fault=None, fragment=65536, namespace=None):
        self.temporary = tempfile.TemporaryDirectory(prefix="guarded-files-", dir=owned)
        self.fixture = Path(self.temporary.name)
        self.fixture.chmod(0o700)
        self.artifacts, self.tool = self.fixture / "artifacts", self.fixture / "tool-view"
        self.artifacts.mkdir(mode=0o700)
        self.tool.mkdir(mode=0o700)
        (self.tool / "lib").mkdir(mode=0o700)
        self.name, self.data = name, payload(size)
        self.expected, self.fault, self.fragment, self.namespace = self.data, fault, fragment, namespace
        self.now, self.end = 10.0, 12.0
        self.delivered, self.assertion_fault = False, False
        self.calls, self.raw_entries, self.callback_errors = [], [], []
        self.live, self.roles, self.retained, self.closed_generations, self.foreign = {}, {}, [], {}, set()
        self.eof_generations, self.mode_generations = set(), set()
        self.directory_effect_done = False
        self.independent_fault_delivered = False
        self.close_attempts = {}
        self.generation = self.returned = self.read_attempts = 0
        # Only the explicit lifetime-capacity fixture seeds historical charge.
        # It is not a native acquisition, closure, refund or automatic baseline.
        self.acquisition_seed = 0
        self.guard_epoch = self.normal_epoch = self.cleanup_epoch = self.last_native_epoch = 0
        self.iterator = None
        self.first_name = None
        self.mutations = {}
        self.boundary_counts = {}
        entries = {}
        for leaf in H.NAMES:
            data = self.data if leaf == name else b"owned-" + leaf.encode("ascii")
            target = self.artifacts / leaf
            target.write_bytes(data)
            target.chmod(0o600)
            info = target.lstat()
            entries[leaf] = (len(data), hashlib.sha256(data).hexdigest(), None, 0o600)
        for leaf, data, mode in (("zig", b"supplied-zig", 0o555), ("lib/header.h", b"supplied-header", 0o444)):
            target = self.tool / leaf
            target.write_bytes(data)
            target.chmod(mode)
        (self.tool / "lib").chmod(0o555)
        self.tool.chmod(0o555)
        fixture_info, artifact_info = self.fixture.lstat(), self.artifacts.lstat()
        self.owner = H.HostFiles(str(self.fixture), (fixture_info.st_dev, fixture_info.st_ino),
                                self.checked(self.normal), self.checked(self.cleanup), self.checked(self.clock))
        self.owner.add_scope("artifacts", str(self.artifacts), {"": (artifact_info.st_dev, artifact_info.st_ino, 0o700)}, entries)
        for leaf in H.NAMES:
            info = (self.artifacts / leaf).lstat()
            self.owner.bind_artifact(leaf, (info.st_dev, info.st_ino))
        directories = {}
        for leaf in ("", "lib"):
            info = (self.tool / leaf).lstat()
            directories[leaf] = (info.st_dev, info.st_ino, 0o555)
        tool_entries = {}
        for leaf in ("zig", "lib/header.h"):
            target = self.tool / leaf
            data, info = target.read_bytes(), target.lstat()
            tool_entries[leaf] = (len(data), hashlib.sha256(data).hexdigest(), (info.st_dev, info.st_ino), stat.S_IMODE(info.st_mode))
        self.owner.add_scope("tool", str(self.tool), directories, tool_entries)

    def checked(self, function):
        def call(*args, **kwargs):
            self.raw_entries.append(function.__qualname__)
            try:
                return function(*args, **kwargs)
            except AssertionError:
                self.callback_errors.append("CALLBACK_ASSERTION")
                raise
        return call

    def clock(self):
        return self.now

    def normal(self):
        self.guard_epoch += 1
        self.normal_epoch = self.guard_epoch
        if self.now >= 100.0:
            raise H.Refused("GUARD")

    def cleanup(self):
        self.guard_epoch += 1
        self.cleanup_epoch = self.guard_epoch
        if self.assertion_fault:
            self.delivered = True
            check(False)
        if self.now >= 120.0:
            raise H.Refused("GUARD")

    def native(self, role, cleanup=False):
        epoch = self.cleanup_epoch if cleanup else self.normal_epoch
        check(epoch > self.last_native_epoch)
        self.last_native_epoch = epoch
        self.calls.append("native-" + role)

    def point(self, name):
        self.calls.append(name)
        self.boundary_counts[name] = self.boundary_counts.get(name, 0) + 1
        mutation = self.mutations.pop(name, None)
        if mutation is not None:
            mutation()
            self.delivered = True
        if self.delivered:
            return
        if self.fault == name:
            self.delivered = True
            self.independent_fault_delivered = True
            if name == "read-data-before" and getattr(self, "arm_cleanup_assertion_on_read", False):
                self.assertion_fault = True
            raise OSError(SENTINEL.decode("latin1"))
        if self.fault == "copy-deadline-" + name:
            self.delivered, self.now = True, self.end
        if self.fault == "normal-deadline-" + name:
            self.delivered, self.now = True, 100.0
        if self.fault == "cleanup-deadline-" + name:
            self.delivered, self.now = True, 120.0

    def open(self, path, flags, mode=0o777, *, dir_fd=None):
        self.native("open")
        check(self.owner.pending and flags & os.O_CLOEXEC and flags & os.O_NOFOLLOW and flags & os.O_NONBLOCK and
              not flags & (os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_RDWR) and mode == 0o777)
        role = next(reversed(self.owner.pending))
        check(role in ("directory", "next-directory", "file") and self.owner.pending[role] == 1)
        used = len(self.owner.opened) + len(self.owner.pending) + len(self.owner.uncertain) + self.owner.opaque_directory_slots
        check(used <= 4 and self.owner.peak_slots <= 4)
        check((role == "directory" and path == "/" and dir_fd is None) or
              (role != "directory" and type(path) is str and "/" not in path and dir_fd in self.owner.opened))
        self.point("open-" + role + "-before")
        if role == "file" and self.fault == "opened-inode-substitution" and not self.delivered:
            self.delivered = True
            path = "state.o"  # anchored path remains the original valid policy.o
        value = REAL["open"](path, flags, dir_fd=dir_fd)
        self.generation += 1
        self.live[value] = self.generation
        self.roles[value] = role
        if role == "file" and self.fault in ("fd-stdio", "fd-alias") and not self.delivered:
            self.delivered = True
            return 1 if self.fault == "fd-stdio" else dir_fd
        self.point("open-" + role + "-after")
        return value

    def fstat(self, descriptor):
        self.native("fstat")
        check(descriptor in self.owner.opened and descriptor in self.live)
        role = self.owner.opened[descriptor]
        self.point("fstat-" + role + "-before")
        result = REAL["fstat"](descriptor)
        self.point("fstat-" + role + "-after")
        if role == "file" and self.fault in ("wrong-owner", "wrong-links", "wrong-size", "wrong-mode", "wrong-kind") and not self.delivered:
            self.delivered = True
            alterations = {"wrong-owner": dict(st_uid=result.st_uid + 1), "wrong-links": dict(st_nlink=2),
                "wrong-size": dict(st_size=result.st_size + 1), "wrong-mode": dict(st_mode=stat.S_IFREG | 0o644),
                "wrong-kind": dict(st_mode=stat.S_IFIFO | 0o600)}
            return changed(result, **alterations[self.fault])
        return result

    def stat(self, path, *, dir_fd=None, follow_symlinks=True):
        self.native("stat")
        check(follow_symlinks is False and type(path) is str)
        role = "file" if dir_fd is not None else "directory"
        check((dir_fd in self.owner.opened and "/" not in path) if dir_fd is not None else
              path in (str(self.artifacts), str(self.tool), str(self.tool / "lib")))
        self.point("stat-" + role + "-before")
        result = REAL["stat"](path, dir_fd=dir_fd, follow_symlinks=False)
        self.point("stat-" + role + "-after")
        return result

    def read(self, descriptor, wanted):
        self.native("read")
        check(descriptor in self.live and self.owner.opened.get(descriptor) == "file" and
              type(wanted) is int and 1 <= wanted <= 65536 and self.owner.read_uncertain >= wanted and
              self.owner.read_charged <= H.READ_LIMIT and self.owner.read_attempts == self.read_attempts + 1)
        self.read_attempts += 1
        role = "eof" if wanted == 1 and self.returned >= len(self.expected) else "data"
        self.point("read-" + role + "-before")
        result = REAL["read"](descriptor, min(wanted, self.fragment))
        self.point("read-" + role + "-after")
        if self.fault in ("read-bool", "read-bytearray", "read-too-large") and not self.delivered:
            self.delivered = True
            return {"read-bool": True, "read-bytearray": bytearray(result), "read-too-large": b"x" * (wanted + 1)}[self.fault]
        self.returned += len(result)
        if result == b"" and wanted == 1:
            self.eof_generations.add(self.live[descriptor])
        return result

    def fchmod(self, descriptor, mode):
        self.native("fchmod")
        check(descriptor in self.live and descriptor in self.owner.opened and type(mode) is int and mode in (0o444, 0o555))
        role = "file" if self.owner.opened[descriptor] == "file" else "directory"
        info = REAL["fstat"](descriptor)
        check(stat.S_IMODE(info.st_mode) == (0o600 if role == "file" else 0o700))
        if role == "directory":
            check(mode == 0o555 and self.owner.census_api_completed and
                  all(row["mode"] in (0o444, 0o555) and row["identity"] is not None
                      for (scope, _), row in self.owner.rows.items() if scope == "artifacts"))
        self.point("chmod-" + role + "-before")
        result = REAL["fchmod"](descriptor, mode)
        self.mode_generations.add(self.live[descriptor])
        if role == "directory":
            self.directory_effect_done = True
        self.point("chmod-" + role + "-after")
        return result

    def close(self, descriptor):
        self.native("close", cleanup=True)
        check(descriptor in self.live and descriptor not in self.owner.opened and
              self.owner.uncertain.get("fd-" + str(descriptor)) == descriptor)
        generation = self.live[descriptor]
        role = self.roles[descriptor]
        check(self.closed_generations.get(generation, 0) == 0 and descriptor not in self.foreign)
        specific = "file" if role == "file" else "published-directory" if self.directory_effect_done else "walk-directory"
        self.close_attempts[generation] = self.close_attempts.get(generation, 0) + 1
        check(self.close_attempts[generation] == 1)
        if specific == "file" and "close-file-" in (self.fault or ""):
            check(generation in self.eof_generations)
        self.point("close-" + specific + "-before")
        self.point("close-before")
        result = REAL["close"](descriptor)
        del self.live[descriptor]
        self.closed_generations[generation] = 1
        if self.fault in ("close-after-reuse", "close-file-after-reuse") and not self.delivered and (self.fault == "close-after-reuse" or role == "file"):
            replacement = REAL["open"](str(self.artifacts / "state.o"), os.O_RDONLY | os.O_CLOEXEC)
            if replacement != descriptor:
                REAL["dup2"](replacement, descriptor, inheritable=False)
                REAL["close"](replacement)
            self.foreign.add(descriptor)
            self.delivered = True
            raise OSError(SENTINEL.decode("latin1"))
        self.point("close-after")
        self.point("close-" + specific + "-after")
        return result

    def scandir(self, descriptor):
        self.native("scandir")
        check(descriptor in self.live and self.owner.census_attempted and
              self.owner.opaque_directory_slots == 1 and self.owner.pending.get("iterator") == 1 and
              self.owner.peak_slots <= 4 and self.iterator is None)
        self.point("scandir-before")
        actual = REAL["scandir"](descriptor)
        self.retained.append(actual)
        self.iterator = Census(self, actual)
        self.point("scandir-after")
        return self.iterator

    def run(self, action, *, expected=None):
        patchers = [patch.object(H.os, name, self.checked(getattr(self, name))) for name in REAL if name != "dup2"]
        for patcher in patchers:
            patcher.start()
        self.error, self.result = None, None
        try:
            try:
                self.result = action(self)
            except H.Refused as error:
                self.error = error
        finally:
            for patcher in reversed(patchers):
                patcher.stop()
        self.report = self.owner.report()
        check(not self.callback_errors)
        check(self.owner.read_returned == self.returned and self.owner.read_attempts == self.read_attempts)
        check(self.owner.read_charged >= self.owner.read_returned and self.owner.read_uncertain >= 0 and
              self.owner.peak_slots <= 4 and all(count == 1 for count in self.closed_generations.values()))
        check(all(count == 1 for count in self.close_attempts.values()) and
              set(self.closed_generations) <= set(self.close_attempts) and
              set(range(1, self.generation + 1)) == set(self.live.values()) | set(self.closed_generations))
        public = json.dumps(self.report, sort_keys=True) + ("" if self.error is None else str(self.error))
        check("PRIVATE-HOST-BYTES" not in public and "NEVER-PUBLIC" not in public and
              (self.error is None or (type(self.error) is H.Refused and str(self.error) in H.REASONS and self.error.__cause__ is None)))
        if expected is None:
            check(self.error is None and not self.owner.failed and not self.owner.unsafe() and not self.live)
        else:
            check(self.error is not None and str(self.error) in expected and self.owner.failed)
            # Every observed returned descriptor is independently accounted for.
            # Known cleanup must complete unless its original cleanup clock or
            # checked callback failed. Pending acquisitions/ambiguous closes may
            # retain only their actual orphan generations, never ordinary known
            # owner.opened entries hidden by later control teardown.
            cleanup_blocked = self.now >= 120.0 or self.callback_errors
            if not cleanup_blocked:
                check(not self.owner.opened and not self.owner.objects)
            unresolved = bool(self.owner.pending or self.owner.uncertain)
            if not unresolved and not cleanup_blocked:
                check(not self.live and not self.foreign and type(self.acquisition_seed) is int and
                      self.acquisition_seed in (0, H.ACQUISITION_LIMIT) and
                      self.owner.acquisitions == self.acquisition_seed + len(self.closed_generations) + self.owner.opaque_directory_slots)
            check(set(self.closed_generations).isdisjoint(self.live.values()))
        return self

    def dispose(self):
        # Separate fixture teardown, after all observations. It never changes
        # the subject's clock, report, ownership or uncertainty accounting.
        for value in self.retained:
            value.close()
        for descriptor in set(self.live) | self.foreign:
            REAL["close"](descriptor)
        self.live.clear()
        self.foreign.clear()
        self.artifacts.chmod(0o700)
        self.tool.chmod(0o700)
        (self.tool / "lib").chmod(0o700)
        self.temporary.cleanup()


def access(h):
    return h.owner.access("artifacts", h.name, end=h.end)


def positive(owned, size, *, fragment=65536, capture=False, name="policy.o"):
    h = Harness(owned, size, fragment=fragment, name=name)
    try:
        h.run(lambda item: item.owner.access("artifacts", name, capture=capture, end=item.end))
        check(h.result == (hashlib.sha256(h.data).hexdigest(), h.data if capture else None) and
              h.owner.rows[("artifacts", name)]["identity"] == H.identity((h.artifacts / name).lstat()) and
              h.report["returnedReadBytes"] == size and h.report["readCharged"] == size and
              h.report["readAttempts"] == (size + fragment - 1) // fragment + 1 and
              h.report["opaqueDirectoryNativeSlotsRetained"] == 0 and h.report["pythonBoundaryResourcesClosed"])
    finally:
        h.dispose()


def negative(owned, fault, expected=("BOUNDARY_FAILURE",), *, action=access, namespace=None):
    h = Harness(owned, fault=fault, namespace=namespace)
    try:
        h.run(action, expected=expected)
        check(h.delivered and h.owner.rows[("artifacts", h.name)]["identity"] is None)
        before = (len(h.raw_entries), h.read_attempts, len(h.calls))
        try:
            h.owner.access("artifacts", h.name, end=h.end)
        except H.Refused:
            pass
        else:
            check(False)
        check(h.read_attempts == before[1] and len(h.raw_entries) == before[0] and len(h.calls) == before[2])
        if fault in ("close-before", "close-after", "close-after-reuse", "open-file-before", "open-file-after",
                     "open-directory-before", "open-directory-after", "open-next-directory-before", "open-next-directory-after", "fd-stdio", "fd-alias"):
            check(h.owner.unsafe() and not h.report["pythonBoundaryResourcesClosed"])
        if fault == "close-after-reuse":
            check(len(h.foreign) == 1)
            descriptor = next(iter(h.foreign))
            check(stat.S_ISREG(REAL["fstat"](descriptor).st_mode))
        if fault in ("read-data-before", "read-data-after"):
            check(h.report["uncertainReadBytes"] == 71 and h.report["readCharged"] == 71)
    finally:
        h.dispose()


def changed_file(owned, kind):
    h = Harness(owned)
    target = h.artifacts / h.name
    try:
        if kind == "hash":
            target.write_bytes(b"x" * 71)
        elif kind == "truncated":
            h.mutations["fstat-file-after"] = lambda: target.write_bytes(h.data[:-1])
        elif kind == "growth":
            h.mutations["read-eof-before"] = lambda: target.write_bytes(h.data + b"x")
        elif kind == "symlink":
            target.unlink()
            target.symlink_to("state.o")
        elif kind == "fifo":
            target.unlink()
            os.mkfifo(target, 0o600)
        elif kind == "hardlink":
            os.link(target, h.artifacts / "alias.o")
        elif kind == "parent-mode":
            h.artifacts.chmod(0o755)
        elif kind == "fixture-mode":
            h.fixture.chmod(0o755)
        elif kind == "path-replacement":
            def replace():
                alternate = h.artifacts / "replacement"
                alternate.write_bytes(h.data)
                alternate.chmod(0o600)
                alternate.replace(target)
            h.mutations["stat-file-before"] = replace
        elif kind == "content-after-read":
            old_time = target.lstat().st_mtime_ns
            def mutate_content():
                target.write_bytes(b"x" * 71)
                distinct = old_time + 2000000000
                os.utime(target, ns=(distinct, distinct), follow_symlinks=False)
                check(REAL["stat"](str(target), follow_symlinks=False).st_mtime_ns != old_time)
            h.mutations["read-eof-after"] = mutate_content
        else:
            check(False)
        expected = {"hash": "HASH_OR_EOF", "truncated": "TRUNCATED", "growth": "HASH_OR_EOF", "symlink": "BOUNDARY_FAILURE",
            "fifo": "FILE_IDENTITY", "hardlink": "FILE_IDENTITY", "parent-mode": "DIRECTORY_IDENTITY",
            "fixture-mode": "FIXTURE_IDENTITY", "path-replacement": "FILE_CHANGED", "content-after-read": "FILE_CHANGED"}[kind]
        h.run(access, expected=(expected,))
        check(not h.mutations and h.owner.rows[("artifacts", h.name)]["identity"] is None)
    finally:
        h.dispose()


def mode_positive(owned, name):
    h = Harness(owned, name=name)
    try:
        mode = 0o555 if name.endswith("-model") else 0o444
        h.run(lambda item: item.owner.access("artifacts", name, mode=mode))
        actual = (h.artifacts / name).lstat()
        check(stat.S_IMODE(actual.st_mode) == mode and h.owner.rows[("artifacts", name)]["identity"] == H.identity(actual) and
              h.owner.rows[("artifacts", name)]["mode"] == mode and h.calls.count("chmod-file-after") == 1)
    finally:
        h.dispose()


def namespace_positive(owned, publish=False):
    h = Harness(owned)
    try:
        def body(item):
            paths = item.owner.namespace()
            check(paths == tuple(item.artifacts / name for name in H.NAMES))
            if publish:
                for name in H.NAMES:
                    item.owner.access("artifacts", name, mode=0o555 if name.endswith("-model") else 0o444)
                item.owner.publish_directory()
                item.owner.access("artifacts", "policy-model")
                item.owner.access("artifacts", "policy.d", capture=True)
            return paths
        # Read accounting covers all18 inputs and the two later consumers.
        h.expected = b""
        h.run(body)
        check(h.iterator.calls == 19 and h.iterator.closes == 1 and h.owner.census_attempted and
              h.report["censusApiCompleted"] and h.report["directoryPythonCloses"] == 1 and
              h.report["opaqueDirectoryNativeSlotsRetained"] == 1 and not h.report["kernelDirectoryCloseResultObserved"] and
              h.report["pythonBoundaryResourcesClosed"] and not h.report["nativeQualification"])
        if publish:
            check(stat.S_IMODE(h.artifacts.lstat().st_mode) == 0o555 and
                  h.owner.scopes["artifacts"]["directories"][""][2] == 0o555 and
                  stat.S_IMODE(h.fixture.lstat().st_mode) == 0o700 and
                  h.calls.index("chmod-directory-before") > max(index for index, value in enumerate(h.calls) if value == "chmod-file-after"))
        before = len(h.raw_entries)
        try:
            h.owner.namespace()
        except H.Refused:
            pass
        else:
            check(False)
        check(len(h.raw_entries) == before and h.owner.opaque_directory_slots == 1)
    finally:
        h.dispose()


def namespace_negative(owned, kind):
    h = Harness(owned, namespace=kind)
    try:
        if kind == "extra":
            (h.artifacts / "unexpected").write_bytes(b"extra")
        h.run(lambda item: item.owner.namespace(), expected=("NAMESPACE",))
        check(h.owner.census_attempted and h.owner.opaque_directory_slots == 1 and not h.owner.census_api_completed and
              h.iterator.calls <= 19 and h.iterator.closes == 1)
    finally:
        h.dispose()


def directory_mode_negative(owned, fault):
    h = Harness(owned)
    try:
        def prepare(item):
            item.owner.namespace()
            for name in H.NAMES:
                item.owner.access("artifacts", name, mode=0o555 if name.endswith("-model") else 0o444)
        h.run(prepare)
        witnessed = h.owner.census_directory_identity
        h.fault = fault
        h.run(lambda item: item.owner.publish_directory(),
              expected=("GUARD",) if fault.startswith("normal-deadline-") else ("BOUNDARY_FAILURE",))
        check(h.delivered and h.owner.census_directory_identity == witnessed and
              h.owner.scopes["artifacts"]["directories"][""][2] == 0o700 and
              stat.S_IMODE(h.artifacts.lstat().st_mode) == (0o700 if fault == "chmod-directory-before" else 0o555) and
              h.owner.failed and not h.owner.unsafe())
    finally:
        h.dispose()


def registration_controls(owned):
    h = Harness(owned)
    try:
        anchor = h.fixture.lstat()
        owner = H.HostFiles(str(h.fixture), (anchor.st_dev, anchor.st_ino), h.normal, h.cleanup, h.clock)
        directory = h.artifacts.lstat()
        directories = {"": (directory.st_dev, directory.st_ino, 0o700)}
        rows = {"policy.o": (1, "a" * 64, None, 0o600), "state.o": (1, "INVALID", None, 0o600)}
        try:
            owner.add_scope("artifacts", str(h.artifacts), directories, rows)
        except H.Refused as error:
            check(str(error) == "ROW")
        else:
            check(False)
        check(owner.rows == {} and owner.scopes == {} and not owner.unsafe())
        rows.pop("state.o")
        owner.add_scope("artifacts", str(h.artifacts), directories, rows)
        rows["policy.o"] = (0, "b" * 64, None, 0o600)
        directories[""] = (0, 0, 0o700)
        check(owner.rows[("artifacts", "policy.o")]["size"] == 1 and
              owner.scopes["artifacts"]["directories"][""] == (directory.st_dev, directory.st_ino, 0o700))
        owner.bind_artifact("policy.o", (directory.st_dev, directory.st_ino))
        try:
            owner.bind_artifact("policy.o", (directory.st_dev, directory.st_ino))
        except H.Refused as error:
            check(str(error) == "BIND")
        else:
            check(False)
        check(not h.live)
    finally:
        h.dispose()


def tool_positive(owned):
    h = Harness(owned)
    try:
        h.expected = b"supplied-header"
        h.run(lambda item: item.owner.access("tool", "lib/header.h"))
        check(h.result == (hashlib.sha256(h.expected).hexdigest(), None) and
              h.report["returnedReadBytes"] == len(h.expected) and h.owner.rows[("tool", "lib/header.h")]["identity"] is not None)
    finally:
        h.dispose()


def capacity(owned, kind):
    h = Harness(owned)
    try:
        if kind == "slots":
            h.owner.pending.update({"prior-" + str(index): 1 for index in range(4)})
        elif kind == "opaque":
            h.owner.pending.update({"prior-" + str(index): 1 for index in range(3)})
            h.owner.opaque_directory_slots = 1
        elif kind == "acquisitions":
            # Supplied historical lifetime charge; no native resource is invented.
            h.acquisition_seed = H.ACQUISITION_LIMIT
            h.owner.acquisitions = H.ACQUISITION_LIMIT
        elif kind == "reads":
            h.owner.read_charged = H.READ_LIMIT - 70
        elif kind == "operations":
            h.owner.operations = H.OPERATION_LIMIT
        else:
            check(False)
        if kind == "operations":
            before = len(h.raw_entries)
            try:
                h.owner.access("artifacts", h.name)
            except H.Refused as error:
                check(str(error) == "OPERATION")
            else:
                check(False)
            check(len(h.raw_entries) == before)
        else:
            h.run(access, expected=("FD_CAPACITY", "READ_CAPACITY"))
            check(h.read_attempts == 0)
            if kind == "acquisitions":
                # Observe the genuine cap refusal BEFORE deliberate oracle corruption.
                check(type(h.error) is H.Refused and h.error.args == ("FD_CAPACITY",) and
                      h.owner.acquisitions == h.acquisition_seed == H.ACQUISITION_LIMIT and
                      h.report["acquisitions"] == H.ACQUISITION_LIMIT and
                      h.owner.failed and not h.owner.busy and h.owner.operations == 1 and
                      h.owner.end == h.end == 12.0 and h.now == 10.0 and h.result is None and
                      h.generation == h.returned == h.read_attempts == h.owner.closes == 0 and
                      h.owner.read_charged == h.owner.read_returned == h.owner.read_uncertain == 0 and
                      h.owner.peak_slots == h.owner.opaque_directory_slots == 0 and
                      not h.calls and not h.close_attempts and not h.closed_generations and
                      not h.live and not h.foreign and not h.owner.opened and not h.owner.objects and
                      not h.owner.pending and not h.owner.uncertain and h.iterator is None and
                      not h.mode_generations and not h.eof_generations and
                      all(row["identity"] is None for row in h.owner.rows.values()))
                before = (len(h.raw_entries), len(h.calls), h.now, h.owner.operations)
                try:
                    access(h)
                except H.Refused as error:
                    check(type(error) is H.Refused and error.args == ("OPERATION",))
                else:
                    check(False)
                check((len(h.raw_entries), len(h.calls), h.now, h.owner.operations) == before and
                      h.owner.acquisitions == H.ACQUISITION_LIMIT and not h.owner.busy)
                # Deliberately add ONE unbacked charge AFTER measuring correct refusal.
                # The unchanged private seed must not hide this real mismatch.
                # No counter/clock is reset or refunded, and no closure is fabricated.
                h.owner.acquisitions += 1
                try:
                    h.run(access, expected=("OPERATION",))
                except AssertionError as error:
                    check(error.args == ("CONTROL_ASSERTION",) and not h.callback_errors and
                          type(h.error) is H.Refused and h.error.args == ("OPERATION",) and
                          h.acquisition_seed == H.ACQUISITION_LIMIT and
                          h.owner.acquisitions == H.ACQUISITION_LIMIT + 1 and
                          h.report["acquisitions"] == H.ACQUISITION_LIMIT + 1 and
                          (len(h.raw_entries), len(h.calls), h.now, h.owner.operations) == before and
                          not h.live and not h.foreign and not h.owner.opened and not h.owner.objects and
                          not h.owner.pending and not h.owner.uncertain and
                          not h.close_attempts and not h.closed_generations and
                          h.owner.failed and not h.owner.busy and h.owner.end == 12.0)
                else:
                    check(False)
    finally:
        h.dispose()


def admission(owned):
    for index, (scope, name, options) in enumerate((
        ("artifacts", "../policy.o", {}), ("artifacts", "unknown.o", {}),
        ("tool", "lib/header.h", {"capture": True}), ("artifacts", "policy.o", {"capture": True}),
        ("artifacts", "policy.o", {"mode": 0o555}), ("artifacts", "policy-model", {"mode": 0o444}),
        ("artifacts", "policy.o", {"end": float("nan")}), ("artifacts", "policy.o", {"end": 12}),
    )):
        h = Harness(owned)
        try:
            before = len(h.raw_entries)
            try:
                h.owner.access(scope, name, **options)
            except H.Refused as error:
                check(str(error) in ("ACCESS", "OPERATION"))
            else:
                check(False)
            check(len(h.raw_entries) == before and not h.live and h.read_attempts == 0)
            CASES.append("access-admission-" + str(index))
        finally:
            h.dispose()


def assertion_recorder(owned):
    h = Harness(owned, fault="read-data-before")
    h.arm_cleanup_assertion_on_read = True
    try:
        try:
            h.run(access, expected=("BOUNDARY_FAILURE",))
        except AssertionError:
            check(h.delivered and h.independent_fault_delivered and h.boundary_counts.get("read-data-before") == 1 and
                  h.callback_errors and any(name.endswith("cleanup") for name in h.raw_entries) and h.owner.failed)
        else:
            check(False)
    finally:
        h.dispose()


def final_file_close(owned, fault, flavor):
    name = "policy.d" if flavor == "capture" else "policy.o"
    h = Harness(owned, name=name, fault=fault)
    try:
        mode = 0o444 if flavor == "mode" else None
        code = "DEADLINE" if fault.startswith("copy-deadline-") else "RESOURCE_UNCERTAINTY"
        h.run(lambda item: item.owner.access("artifacts", name, capture=flavor == "capture", mode=mode, end=item.end), expected=(code,))
        row = h.owner.rows[("artifacts", name)]
        check(h.delivered and h.result is None and row["identity"] is None and row["mode"] == 0o600 and
              h.report["returnedReadBytes"] == len(h.data) and h.report["uncertainReadBytes"] == 0 and
              h.boundary_counts.get("stat-file-after") == (2 if mode is not None else 1) and
              h.calls.count("close-file-before") == 1 and not h.owner.opened)
        check(stat.S_IMODE((h.artifacts / name).lstat().st_mode) == (mode or 0o600))
        if mode is not None:
            check(h.mode_generations and h.calls.index("chmod-file-after") < h.calls.index("close-file-before"))
        if fault.startswith("copy-deadline-"):
            check(h.now == h.end and not h.owner.unsafe() and not h.live and not h.foreign)
        else:
            check(h.owner.unsafe() and bool(h.owner.uncertain))
        if fault == "close-file-after-reuse":
            check(len(h.foreign) == 1 and stat.S_ISREG(REAL["fstat"](next(iter(h.foreign))).st_mode))
    finally:
        h.dispose()


def final_directory_close(owned, fault):
    h = Harness(owned)
    try:
        def prepare(item):
            item.owner.namespace()
            for name in H.NAMES:
                item.owner.access("artifacts", name, mode=0o555 if name.endswith("-model") else 0o444)
        h.run(prepare)
        original_expectation = h.owner.scopes["artifacts"]["directories"][""]
        h.fault = fault
        h.run(lambda item: item.owner.publish_directory(), expected=("GUARD",) if fault.startswith("normal-") else ("RESOURCE_UNCERTAINTY",))
        check(h.delivered and h.result is None and h.directory_effect_done and h.owner.scopes["artifacts"]["directories"][""] == original_expectation and
              stat.S_IMODE(h.artifacts.lstat().st_mode) == 0o555 and h.calls.count("close-published-directory-before") == 1 and
              h.calls.index("chmod-directory-after") < h.calls.index("close-published-directory-before") and not h.owner.opened)
        if fault.startswith("normal-"):
            check(h.now == 100.0 and not h.owner.unsafe() and not h.live)
        else:
            check(h.owner.unsafe() and h.owner.uncertain)
    finally:
        h.dispose()


def expired_entry(owned):
    h = Harness(owned)
    try:
        h.now = h.end
        h.run(access, expected=("DEADLINE",))
        check(not h.owner.busy and h.owner.failed and h.owner.operations == 1 and h.owner.end == h.end and
              h.now == h.end and h.owner.acquisitions == 0 and h.owner.read_attempts == 0 and not h.calls)
    finally:
        h.dispose()


def main(owned):
    for size in (0, 1, 65535, 65536, 65537, 1048576, 33554432):
        case("actual-file-hash-" + str(size), lambda size=size: positive(owned, size))
    case("actual-short-positive-reads", lambda: positive(owned, 65537, fragment=137))
    case("private-dependency-capture-1MiB", lambda: positive(owned, 1048576, capture=True, name="policy.d"))
    case("private-map-capture", lambda: positive(owned, 65537, capture=True, name="policy.map"))
    case("actual-nested-tool-header", lambda: tool_positive(owned))
    for fault in ("open-directory-before", "open-directory-after", "open-next-directory-before", "open-next-directory-after",
                  "open-file-before", "open-file-after", "read-data-before", "read-data-after", "read-eof-before", "read-eof-after",
                  "fstat-file-before", "fstat-file-after", "stat-file-before", "stat-file-after", "close-before", "close-after", "close-after-reuse"):
        case(fault, lambda fault=fault: negative(owned, fault))
    for fault, code in (("opened-inode-substitution", "FILE_IDENTITY"), ("fd-stdio", "FD_IDENTITY"), ("fd-alias", "FD_IDENTITY"),
        ("wrong-owner", "FILE_IDENTITY"), ("wrong-links", "FILE_IDENTITY"), ("wrong-size", "FILE_IDENTITY"),
        ("wrong-mode", "FILE_IDENTITY"), ("wrong-kind", "FILE_IDENTITY"),
        ("read-bool", "READ_RESULT"), ("read-bytearray", "READ_RESULT"), ("read-too-large", "READ_RESULT")):
        case(fault, lambda fault=fault, code=code: negative(owned, fault, (code,)))
    for point in ("open-file-after", "fstat-file-after", "read-data-after", "read-eof-after", "stat-file-after", "close-after"):
        for clock, code in (("copy", "DEADLINE"), ("normal", "GUARD"), ("cleanup", "GUARD")):
            # Cleanup-only expiry is delivered after an actual close. Earlier
            # boundaries also cross the original normal clock, which takes priority.
            expected = (code, "RESOURCE_UNCERTAINTY") if clock == "cleanup" else (code,)
            fault = clock + "-deadline-" + point
            case(fault, lambda fault=fault, expected=expected: negative(owned, fault, expected))
    for kind in ("hash", "truncated", "growth", "symlink", "fifo", "hardlink", "parent-mode", "fixture-mode", "path-replacement", "content-after-read"):
        case("actual-file-change-" + kind, lambda kind=kind: changed_file(owned, kind))
    for name in ("policy.o", "policy-model"):
        case("measured-actual-mode-" + name.replace(".", "-"), lambda name=name: mode_positive(owned, name))
    for fault in ("chmod-file-before", "chmod-file-after", "copy-deadline-chmod-file-after"):
        expected = ("DEADLINE",) if fault.startswith("copy-") else ("BOUNDARY_FAILURE",)
        case(fault, lambda fault=fault, expected=expected: negative(owned, fault, expected,
             action=lambda item: item.owner.access("artifacts", item.name, mode=0o444, end=item.end)))
    case("bounded-real-census", lambda: namespace_positive(owned))
    case("actual-directory-mode-last-and-later-consumers", lambda: namespace_positive(owned, publish=True))
    for kind in ("extra", "missing", "duplicate"):
        case("namespace-" + kind, lambda kind=kind: namespace_negative(owned, kind))
    for fault in ("chmod-directory-before", "chmod-directory-after", "normal-deadline-chmod-directory-after"):
        case(fault, lambda fault=fault: directory_mode_negative(owned, fault))
    for point in ("scandir-before", "scandir-after", "next-before", "next-after", "next-eof", "iterator-close-before", "iterator-close-after"):
        for prefix in ("", "normal-deadline-"):
            fault = prefix + point
            case(fault, lambda fault=fault, prefix=prefix: negative(owned, fault, ("GUARD",) if prefix else ("BOUNDARY_FAILURE",),
                 action=lambda item: item.owner.namespace()))
    for kind in ("slots", "opaque", "acquisitions", "reads", "operations"):
        case("prospective-capacity-" + kind, lambda kind=kind: capacity(owned, kind))
    admission(owned)
    case("scope-registration-atomic-and-private-copy-once-bind", lambda: registration_controls(owned))
    case("swallowed-callback-assertion-is-control-failure", lambda: assertion_recorder(owned))
    for flavor in ("digest", "capture", "mode"):
        for fault in ("close-file-before", "close-file-after", "close-file-after-reuse", "copy-deadline-close-file-after"):
            case(flavor + "-final-" + fault, lambda flavor=flavor, fault=fault: final_file_close(owned, fault, flavor))
    for fault in ("close-published-directory-before", "close-published-directory-after", "normal-deadline-close-published-directory-after"):
        case("final-" + fault, lambda fault=fault: final_directory_close(owned, fault))
    case("expired-entry-clears-busy-without-resetting-end", lambda: expired_entry(owned))
    check(len(CASES) == len(set(CASES)))
    print(json.dumps(dict(schema=1, status="SUPPLIED_HOST_FILES_CONTROLS_PASS", cases=len(CASES), names=CASES,
                         realDockerInvocations=0, nativeQualification=False), separators=(",", ":")))


if __name__ == "__main__":
    try:
        check(len(sys.argv) == 2 and Path(sys.argv[1]).is_dir())
        main(sys.argv[1])
    except BaseException:
        print('{"schema":1,"status":"SUPPLIED_HOST_FILES_CONTROLS_FAILED"}')
        raise SystemExit(71)
