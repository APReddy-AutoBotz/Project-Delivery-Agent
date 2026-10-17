"""EXEC-016/TR-DEP-004: bounded guarded research-owner file access.

Unreviewed source draft. No process, network, arbitrary path discovery or native
qualification. Four incremental owner slots, separate from the transfer worker.
Only authenticated dependency/map bytes can leave this private owner.
"""
import hashlib
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat

UNITS = ("policy", "policy-controls", "policy-install-controls", "state", "state-controls", "observer")
NAMES = tuple(unit + suffix for unit in UNITS for suffix in (".o", ".d")) + tuple(
    model + suffix for model in ("policy", "installer", "state") for suffix in ("-model", ".map"))
CHUNK = 65536
READ_LIMIT = 2 * 1024 * 1024 * 1024
# Six <=1MiB dependency files can contain only finitely many nonempty /tool/
# tokens. This conservative ceiling includes54 fixed file operations plus the
# once-ever census and directory publication (56 fixed owner operations).
OPERATION_LIMIT = 64 + 6 * 1048576 // 7
ACQUISITION_LIMIT = OPERATION_LIMIT * 256
REASONS = frozenset(("PATH", "FIXTURE", "GUARD", "SCOPE", "DIRECTORIES", "ARTIFACT_NAME", "ROW", "ROW_INODE", "ROW_PARENT",
    "BIND", "FD_CAPACITY", "OPAQUE_ITERATOR_LIVE", "FD_IDENTITY", "READ_CAPACITY", "READ_RESULT", "DIRECTORY_DEPTH",
    "DIRECTORY_KIND", "FIXTURE_IDENTITY", "DIRECTORY_IDENTITY", "POISONED", "DEADLINE", "OPERATION", "RESOURCE_UNCERTAINTY",
    "ACCESS", "FILE_ADMISSION", "FILE_IDENTITY", "TRUNCATED", "HASH_OR_EOF", "FILE_CHANGED", "MODE_IDENTITY", "PARENT_CHANGED",
    "NAMESPACE", "CENSUS_ONCE", "DIRECTORY_CHANGED", "DIRECTORY_ADMISSION", "DIRECTORY_MODE", "CLOSE_RESULT", "BOUNDARY_FAILURE"))


class Refused(ValueError):
    pass


def require(value, code):
    if not value:
        raise Refused(code)


def reason(error):
    return error.args[0] if type(error) is Refused and len(error.args) == 1 and type(error.args[0]) is str and error.args[0] in REASONS else "BOUNDARY_FAILURE"


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def relative(name):
    require(type(name) is str and 0 < len(name) <= 1024 and
            all(32 <= ord(char) <= 126 for char in name) and "\\" not in name and ":" not in name and
            str(PurePosixPath(name)) == name and not name.startswith("/") and
            all(part not in ("", ".", "..") for part in name.split("/")), "PATH")
    return name


class HostFiles:
    def __init__(self, fixture, fixture_identity, normal_guard, cleanup_guard, clock):
        require(type(fixture) is str and fixture.startswith("/") and str(PurePosixPath(fixture)) == fixture and
                0 < len(fixture) <= 4096 and len(PurePosixPath(fixture).parts) <= 64 and
                all(part not in ("", ".", "..") for part in fixture.split("/")[1:]), "FIXTURE")
        require(type(fixture_identity) is tuple and len(fixture_identity) == 2 and
                all(type(item) is int and item >= 0 for item in fixture_identity), "FIXTURE")
        require(all(callable(item) for item in (normal_guard, cleanup_guard, clock)), "GUARD")
        self.fixture, self.fixture_identity = Path(fixture), fixture_identity
        self.normal_guard, self.cleanup_guard, self.clock = normal_guard, cleanup_guard, clock
        self.scopes, self.rows = {}, {}
        self.failed, self.busy = False, False
        self.end = None
        self.opened, self.objects, self.pending, self.uncertain = {}, {}, {}, {}
        self.operations = self.acquisitions = self.closes = 0
        self.read_charged = self.read_returned = self.read_uncertain = self.read_attempts = 0
        self.peak_slots = self.opaque_directory_slots = 0
        self.directory_python_closes = 0
        self.census_attempted = self.census_api_completed = False
        self.census_directory_identity = None

    def guard(self, cleanup=False):
        if cleanup:
            self.cleanup_guard()
        else:
            try:
                self.normal_guard()
                require(not self.failed, "POISONED")
                require(self.end is None or self.clock() < self.end, "DEADLINE")
            except BaseException as error:
                self.failed = True
                raise Refused(reason(error)) from None

    def add_scope(self, scope, root, directories, entries):
        self.guard()
        require(type(scope) is str and scope in ("artifacts", "tool") and scope not in self.scopes and
                not self.busy and type(root) is str and Path(root) == self.fixture / ("artifacts" if scope == "artifacts" else "tool-view") and
                type(directories) is dict and 1 <= len(directories) <= 365 and "" in directories and
                type(entries) is dict and 1 <= len(entries) <= (18 if scope == "artifacts" else 4819), "SCOPE")
        copied, copied_rows = {}, {}
        for name, expected in directories.items():
            require(type(name) is str and (name == "" or relative(name)) and type(expected) is tuple and len(expected) == 3 and
                    all(type(value) is int and value >= 0 for value in expected) and expected[2] == (0o700 if scope == "artifacts" else 0o555),
                    "DIRECTORIES")
            copied[name] = tuple(expected)
        for name, row in entries.items():
            relative(name)
            require(scope != "artifacts" or name in NAMES, "ARTIFACT_NAME")
            require(type(row) is tuple and len(row) == 4, "ROW")
            size, digest, inode, mode = row
            maximum = (1048576 if name.endswith((".d", ".map")) else 33554432) if scope == "artifacts" else 268435456
            require(type(size) is int and 0 <= size <= maximum and type(digest) is str and
                    re.fullmatch(r"[0-9a-f]{64}", digest) and type(mode) is int and
                    mode == (0o600 if scope == "artifacts" else 0o555 if name == "zig" else 0o444), "ROW")
            require(inode is None and scope == "artifacts" or type(inode) is tuple and len(inode) == 2 and
                    all(type(value) is int and value >= 0 for value in inode), "ROW_INODE")
            parent = PurePosixPath(name).parent.as_posix()
            require(("" if parent == "." else parent) in copied, "ROW_PARENT")
            copied_rows[(scope, name)] = dict(size=size, digest=digest, inode=inode, mode=mode, identity=None)
        self.guard()
        self.rows.update(copied_rows)
        self.scopes[scope] = dict(root=Path(root), directories=copied)

    def bind_artifact(self, name, inode):
        self.guard()
        require(type(name) is str and ("artifacts", name) in self.rows and type(inode) is tuple and len(inode) == 2 and
                all(type(value) is int and value >= 0 for value in inode), "BIND")
        row = self.rows[("artifacts", name)]
        require(row["inode"] is None and not self.busy, "BIND")
        row["inode"] = tuple(inode)

    def reserve(self, role):
        self.guard()
        # Iterator ownership/pending/uncertainty all refer to its one opaque
        # native slot; it is never returned to capacity after census entry.
        used = (len(self.opened) + sum(role != "iterator" for role in self.pending) +
                sum(role != "iterator" for role in self.uncertain) + self.opaque_directory_slots)
        if role == "iterator":
            require(not self.census_attempted and not self.opaque_directory_slots, "CENSUS_ONCE")
        require(role not in self.pending and role not in self.objects and role not in self.uncertain and
                used < 4 and self.acquisitions < ACQUISITION_LIMIT, "FD_CAPACITY")
        self.pending[role] = 1
        self.acquisitions += 1
        self.peak_slots = max(self.peak_slots, used + 1)

    def open(self, path, flags, role, parent=None):
        require(not self.objects, "OPAQUE_ITERATOR_LIVE")
        self.reserve(role)
        value = os.open(path, flags | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        if type(value) is not int or value < 3 or value in self.opened:
            if type(value) is int and value in self.opened:
                self.uncertain["collision"] = self.opened.pop(value)
            raise Refused("FD_IDENTITY")
        self.opened[value] = role
        del self.pending[role]
        self.guard()
        return value

    def close(self, descriptor):
        self.guard(cleanup=True)
        self.opened.pop(descriptor)
        key = "fd-" + str(descriptor)
        self.uncertain[key] = descriptor
        result = os.close(descriptor)
        require(result is None, "CLOSE_RESULT")
        del self.uncertain[key]
        self.closes += 1
        self.guard(cleanup=True)

    def close_iterator(self):
        self.guard(cleanup=True)
        value = self.objects.pop("iterator")
        self.uncertain["iterator"] = value
        result = value.close()
        require(result is None, "CLOSE_RESULT")
        del self.uncertain["iterator"]
        # CPython ignores closedir's native result. Conservatively keep one
        # incremental native-capacity slot until process termination; no kernel
        # closure/actual native resource qualification follows from Python close.
        self.directory_python_closes += 1
        self.guard(cleanup=True)

    def boundary(self, function, *args, **kwargs):
        self.guard()
        value = function(*args, **kwargs)
        self.guard()
        return value

    def directory(self, scope, parent_name=""):
        base = self.scopes[scope]
        target = base["root"] / parent_name
        require(len(target.parts) <= 128, "DIRECTORY_DEPTH")
        descriptor = self.open("/", os.O_RDONLY | os.O_DIRECTORY, "directory")
        cursor = Path("/")
        for part in target.parts[1:]:
            child = self.open(part, os.O_RDONLY | os.O_DIRECTORY, "next-directory", descriptor)
            self.close(descriptor)
            descriptor, cursor = child, cursor / part
            info = self.boundary(os.fstat, descriptor)
            require(stat.S_ISDIR(info.st_mode), "DIRECTORY_KIND")
            if cursor == self.fixture:
                require((info.st_dev, info.st_ino) == self.fixture_identity and info.st_uid == os.getuid() and
                        stat.S_IMODE(info.st_mode) == 0o700, "FIXTURE_IDENTITY")
            if cursor == base["root"] or base["root"] in cursor.parents:
                name = cursor.relative_to(base["root"]).as_posix()
                name = "" if name == "." else name
                require(name in base["directories"] and (info.st_dev, info.st_ino, stat.S_IMODE(info.st_mode)) == base["directories"][name] and
                        info.st_uid == os.getuid(), "DIRECTORY_IDENTITY")
        return descriptor

    def read(self, descriptor, wanted):
        self.guard()
        require(type(wanted) is int and 1 <= wanted <= CHUNK and self.read_charged + wanted <= READ_LIMIT, "READ_CAPACITY")
        self.read_charged += wanted
        self.read_uncertain += wanted
        self.read_attempts += 1
        value = os.read(descriptor, wanted)
        require(type(value) is bytes and len(value) <= wanted, "READ_RESULT")
        self.read_returned += len(value)
        self.read_charged -= wanted - len(value)
        self.read_uncertain -= wanted
        self.guard()
        return value

    def begin(self, end):
        require(not self.busy and not self.failed and self.operations < OPERATION_LIMIT and
                (end is None or type(end) is float and math.isfinite(end)), "OPERATION")
        self.busy, self.end = True, end
        self.operations += 1
        try:
            self.guard()
        except BaseException:
            self.busy = False
            raise

    def finish(self):
        errors = []
        if "iterator" in self.objects:
            try:
                self.close_iterator()
            except BaseException as error:
                errors.append(error)
        for descriptor in tuple(self.opened):
            try:
                self.close(descriptor)
            except BaseException as error:
                errors.append(error)
        if errors or self.opened or self.objects or self.pending or self.uncertain or self.read_uncertain:
            self.failed = True
            raise Refused("RESOURCE_UNCERTAINTY") from None

    def access(self, scope, name, *, capture=False, mode=None, end=None):
        """Return digest/private bytes only after full independent verification."""
        require(type(scope) is str and type(name) is str and (scope, name) in self.rows and type(capture) is bool and
                (not capture or scope == "artifacts" and name.endswith((".d", ".map"))) and
                (mode is None or scope == "artifacts" and type(mode) is int and mode == (0o555 if name.endswith("-model") else 0o444)), "ACCESS")
        row = self.rows[(scope, name)]
        require(row["inode"] is not None and (mode is None or row["mode"] == 0o600), "FILE_ADMISSION")
        self.begin(end)
        proposed, failure = None, None
        try:
            parent_name = PurePosixPath(name).parent.as_posix()
            parent = self.directory(scope, "" if parent_name == "." else parent_name)
            leaf = PurePosixPath(name).name
            descriptor = self.open(leaf, os.O_RDONLY, "file", parent)
            before = self.boundary(os.fstat, descriptor)
            require(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_nlink == 1 and
                    before.st_size == row["size"] and (before.st_dev, before.st_ino) == row["inode"] and
                    stat.S_IMODE(before.st_mode) == row["mode"] and
                    (row["identity"] is None or identity(before) == row["identity"]), "FILE_IDENTITY")
            parent_before = self.boundary(os.fstat, parent)
            digest, total, private = hashlib.sha256(), 0, bytearray() if capture else None
            while total < row["size"]:
                block = self.read(descriptor, min(CHUNK, row["size"] - total))
                require(block, "TRUNCATED")
                total += len(block)
                digest.update(block)
                if capture:
                    private.extend(block)
            require(self.read(descriptor, 1) == b"" and digest.hexdigest() == row["digest"], "HASH_OR_EOF")
            final = self.boundary(os.fstat, descriptor)
            path = self.boundary(os.stat, leaf, dir_fd=parent, follow_symlinks=False)
            require(identity(before) == identity(final) == identity(path), "FILE_CHANGED")
            if mode is not None:
                self.boundary(os.fchmod, descriptor, mode)
                final = self.boundary(os.fstat, descriptor)
                path = self.boundary(os.stat, leaf, dir_fd=parent, follow_symlinks=False)
                require(identity(final) == identity(path) and (final.st_dev, final.st_ino) == row["inode"] and
                        final.st_size == row["size"] and final.st_uid == before.st_uid and final.st_nlink == 1 and
                        stat.S_ISREG(final.st_mode) and stat.S_IMODE(final.st_mode) == mode and
                        final.st_mtime_ns == before.st_mtime_ns, "MODE_IDENTITY")
            proposed = identity(final)
            parent_final = self.boundary(os.fstat, parent)
            parent_path = self.boundary(os.stat, str(self.scopes[scope]["root"] / ("" if parent_name == "." else parent_name)),
                                        follow_symlinks=False)
            require(identity(parent_before) == identity(parent_final) == identity(parent_path), "PARENT_CHANGED")
            self.guard()
        except BaseException as error:
            self.failed = True
            failure = reason(error)
        finally:
            try:
                self.finish()
            except BaseException as error:
                failure = failure or reason(error)
            finally:
                self.busy = False
        if failure is not None:
            raise Refused(failure) from None
        self.guard()
        # Publish a new full identity/mode only after actual close and final clock.
        row["identity"], row["mode"] = proposed, row["mode"] if mode is None else mode
        self.end = None
        return (digest.hexdigest(), bytes(private) if capture else None)

    def namespace(self):
        """One bounded Python census. Its opaque native slot stays charged."""
        require(not self.census_attempted and "artifacts" in self.scopes and
                set(name for scope, name in self.rows if scope == "artifacts") == set(NAMES), "NAMESPACE")
        self.begin(None)
        proposed, failure = None, None
        try:
            descriptor = self.directory("artifacts")
            before = self.boundary(os.fstat, descriptor)
            self.reserve("iterator")  # includes CPython's hidden duplicate FD
            self.census_attempted, self.opaque_directory_slots = True, 1
            iterator = os.scandir(descriptor)
            self.objects["iterator"] = iterator
            del self.pending["iterator"]
            self.guard()
            names = set()
            for index in range(19):
                self.guard()
                try:
                    entry = next(iterator)
                except StopIteration:
                    self.guard()
                    break
                self.guard()
                name = entry.name
                require(index < 18 and type(name) is str and name in NAMES and name not in names, "NAMESPACE")
                names.add(name)
            require(names == set(NAMES), "NAMESPACE")
            self.close_iterator()
            final = self.boundary(os.fstat, descriptor)
            path = self.boundary(os.stat, str(self.scopes["artifacts"]["root"]), follow_symlinks=False)
            require(identity(before) == identity(final) == identity(path), "DIRECTORY_CHANGED")
            proposed = identity(final)
        except BaseException as error:
            self.failed = True
            failure = reason(error)
        finally:
            try:
                self.finish()
            except BaseException as error:
                failure = failure or reason(error)
            finally:
                self.busy = False
        if failure is not None:
            raise Refused(failure) from None
        self.guard()
        self.census_api_completed = True
        self.census_directory_identity = proposed
        return tuple(self.scopes["artifacts"]["root"] / name for name in NAMES)

    def publish_directory(self):
        """Last mode transition, after all18 actual per-file mode witnesses."""
        require(self.census_api_completed and self.census_directory_identity is not None and
                all(row["identity"] is not None and row["mode"] == (0o555 if name.endswith("-model") else 0o444)
                    for (scope, name), row in self.rows.items() if scope == "artifacts"), "DIRECTORY_ADMISSION")
        self.begin(None)
        proposed, failure = None, None
        try:
            descriptor = self.directory("artifacts")
            before = self.boundary(os.fstat, descriptor)
            require(identity(before) == self.census_directory_identity, "DIRECTORY_CHANGED")
            self.boundary(os.fchmod, descriptor, 0o555)
            final = self.boundary(os.fstat, descriptor)
            path = self.boundary(os.stat, str(self.scopes["artifacts"]["root"]), follow_symlinks=False)
            require(identity(final) == identity(path) and stat.S_ISDIR(final.st_mode) and
                    (final.st_dev, final.st_ino, final.st_uid, final.st_nlink, final.st_size, final.st_mtime_ns) ==
                    (before.st_dev, before.st_ino, before.st_uid, before.st_nlink, before.st_size, before.st_mtime_ns) and
                    stat.S_IMODE(final.st_mode) == 0o555, "DIRECTORY_MODE")
            proposed = (final.st_dev, final.st_ino, 0o555)
        except BaseException as error:
            self.failed = True
            failure = reason(error)
        finally:
            try:
                self.finish()
            except BaseException as error:
                failure = failure or reason(error)
            finally:
                self.busy = False
        if failure is not None:
            raise Refused(failure) from None
        self.guard()
        self.scopes["artifacts"]["directories"][""] = proposed

    def unsafe(self):
        return bool(self.opened or self.objects or self.pending or self.uncertain)

    def report(self):
        return dict(failed=self.failed, operations=self.operations, acquisitions=self.acquisitions,
            closes=self.closes, incrementalSlotLimit=4, peakReservedSlots=self.peak_slots,
            readLimit=READ_LIMIT, readCharged=self.read_charged, returnedReadBytes=self.read_returned,
            uncertainReadBytes=self.read_uncertain, readAttempts=self.read_attempts,
            pending=dict(self.pending), uncertainRoles=sorted(self.uncertain),
            pythonBoundaryResourcesClosed=not self.unsafe(),
            opaqueDirectoryNativeSlotsRetained=self.opaque_directory_slots,
            directoryPythonCloses=self.directory_python_closes,
            censusApiCompleted=self.census_api_completed,
            kernelDirectoryCloseResultObserved=False, nativeQualification=False)
