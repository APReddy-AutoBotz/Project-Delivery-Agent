"""EXEC-016/TR-DEP-004: bounded first-party derived research input construction.

The entrypoint authenticates the fixed plan before constructing this object.
This module creates no process, network, license or operational admission.
"""
from collections import deque
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat


class ViewRefused(RuntimeError):
    pass


def require(value, reason):
    if not value:
        raise ViewRefused(reason)


def safe_path(value):
    require(type(value) is str and 0 < len(value) <= 1024 and
            all(32 <= ord(c) <= 126 for c in value) and "\\" not in value and ":" not in value,
            "view bounded ASCII relative path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and str(path) == value and
            all(part not in ("", ".", "..") for part in value.split("/")), "view path normalization")
    return path


class ToolView:
    MAX_BYTES = 256 * 1024 * 1024
    MAX_FILES = 100000
    MAX_DIRS = 10000
    CHUNK = 65536

    def __init__(self, source, destination, entries, roots, sentinels, guard):
        self.source, self.destination = Path(source), Path(destination)
        self.guard = guard
        self.entries = {}
        self.roots = tuple(roots)
        self.sentinels = tuple(sentinels)
        require(0 < len(entries) <= self.MAX_FILES and len(self.roots) == len(set(self.roots)),
                "view plan count/roots")
        for root in self.roots:
            safe_path(root)
        previous = None
        for row in entries:
            require(type(row) is list and len(row) == 4, "view row schema")
            name, size, digest, excluded = row
            safe_path(name)
            require(previous is None or previous < name, "view sorted unique rows")
            previous = name
            require(type(size) is int and 0 <= size <= self.MAX_BYTES and type(excluded) is bool and
                    type(digest) is str and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest),
                    "view row identity schema")
            require(sum(name == root or name.startswith(root + "/") for root in self.roots) == 1,
                    "view exact unambiguous selected root")
            self.entries[name] = (size, digest, excluded)
        self.included = {name: row for name, row in self.entries.items() if not row[2]}
        require(self.included and len(self.sentinels) == len(set(self.sentinels)) and
                all(name in self.included for name in self.sentinels), "view mandatory included sentinels")
        self.total = sum(row[0] for row in self.included.values())
        require(self.total <= self.MAX_BYTES, "view aggregate capacity")
        self.dirs = {""}
        for name in self.included:
            self.dirs.update(str(p) for p in PurePosixPath(name).parents if str(p) != ".")
        for root in self.roots:
            if root not in self.entries:
                self.dirs.add(root)
                self.dirs.update(str(p) for p in PurePosixPath(root).parents if str(p) != ".")
        require(len(self.dirs) <= self.MAX_DIRS, "view directory capacity")
        self.started = self.failed = self.completed = False
        self.charged = self.verified = self.uncertain = self.copied_files = 0
        self.read_bytes = 0
        self.read_capacity = sum(row[0] for row in self.entries.values()) + 3 * self.total + len(self.entries) + 3 * len(self.included)
        self.read_charged = self.read_verified = self.read_uncertain = 0
        self.acquisitions = self.acquisition_pending = 0
        maximum_depth = max(len(PurePosixPath(name).parts) for name in self.entries)
        self.acquisition_limit = (len(self.entries) + 4 * len(self.included) + 2 * len(self.dirs)) * 4 * (
            len(self.source.parts) + len(self.destination.parts) + maximum_depth + 2)
        self.opened = {}
        self.close_attempts, self.close_uncertainties = deque(maxlen=32), []
        self.close_count = 0
        self.acquisition_uncertainties = []
        self.destination_inodes = {}
        self.directories_frozen = False
        self.source_inodes, self.source_directories, self.destination_directories = {}, {}, {}

    def _ordinary_dir(self, path):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_uid == os.getuid(),
                "view ordinary owned ancestor directory")
        if path == self.source or self.source in path.parents:
            name = path.relative_to(self.source).as_posix()
            identity = (info.st_dev, info.st_ino)
            require(name not in self.source_directories or self.source_directories[name] == identity,
                    "view source directory identity drift")
            require(name in self.source_directories or len(self.source_directories) < self.MAX_DIRS,
                    "view source directory capacity")
            self.source_directories.setdefault(name, identity)
        return info

    def _file_info(self, base, name):
        parent = self._walk_dir(base / PurePosixPath(name).parent)
        try:
            info = os.stat(PurePosixPath(name).name, dir_fd=parent, follow_symlinks=False)
        finally:
            self._close(parent)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(),
                "view regular owned nonalias file")
        return info

    @staticmethod
    def _identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
                info.st_mode, info.st_nlink, info.st_uid)

    def _acquire(self, path, flags, role, mode=0o600, directory=None):
        self.guard()
        require(not self.failed and len(self.opened) + self.acquisition_pending + len(self.acquisition_uncertainties) +
                len(self.close_uncertainties) < 4 and self.acquisitions < self.acquisition_limit,
                "view pre-acquisition descriptor capacity")
        self.acquisition_pending += 1  # reserve one acquisition BEFORE native entry
        self.acquisitions += 1
        try:
            descriptor = os.open(path, flags | os.O_CLOEXEC | os.O_NOFOLLOW, mode, dir_fd=directory)
        except BaseException:
            self.failed = True  # reservation remains charged; no returned handle is invented
            raise
        if type(descriptor) is not int or descriptor < 0 or descriptor in self.opened:
            previous = self.opened.pop(descriptor, None) if type(descriptor) is int else None
            self.acquisition_uncertainties.append(dict(role=role, descriptor=descriptor, priorRole=previous))
            self.failed = True
            raise ViewRefused("view descriptor acquisition collision/uncertainty")
        self.opened[descriptor] = role  # custody before any returned-handle inspection
        self.acquisition_pending -= 1
        self.guard()
        return descriptor

    def _walk_dir(self, path):
        path = Path(path)
        require(path.is_absolute() and path.anchor == "/" and ".." not in path.parts,
                "view exact absolute directory anchor")
        descriptor = self._acquire("/", os.O_RDONLY | os.O_DIRECTORY, "directory:/")
        try:
            cursor = Path("/")
            for part in path.parts[1:]:
                next_descriptor = self._acquire(part, os.O_RDONLY | os.O_DIRECTORY,
                                               "directory:" + part, directory=descriptor)
                previous, descriptor = descriptor, next_descriptor
                self._close(previous)
                cursor = cursor / part
                self._known_directory(cursor, os.fstat(descriptor))
            info = os.fstat(descriptor)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid(),
                    "view anchored owned directory")
            self._known_directory(path, info)
            return descriptor
        except BaseException:
            if descriptor in self.opened:
                self._close(descriptor)
            raise

    def _known_directory(self, path, info):
        require(stat.S_ISDIR(info.st_mode), "view anchored ordinary directory")
        for base, known in ((self.source, self.source_directories), (self.destination, self.destination_directories)):
            if path == base or base in path.parents:
                name = path.relative_to(base).as_posix()
                if name in known:
                    require(known[name] == (info.st_dev, info.st_ino) and info.st_uid == os.getuid(),
                            "view anchored directory identity drift")
                    if base == self.destination and self.directories_frozen:
                        require(stat.S_IMODE(info.st_mode) == 0o555, "view frozen directory mode drift")

    def _open(self, base, name, destination=False):
        parent = self._walk_dir(base / PurePosixPath(name).parent)
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL if destination else os.O_RDONLY
            descriptor = self._acquire(PurePosixPath(name).name, flags,
                ("destination:" if destination else "source:") + name, directory=parent)
        finally:
            self._close(parent)
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(),
                "view acquired ordinary owned nonalias file")
        self.guard()
        return descriptor, info

    def _close(self, descriptor):
        role = self.opened.pop(descriptor)  # detach ownership BEFORE once-close acquisition
        self.close_attempts.append(role)
        self.close_count += 1
        try:
            os.close(descriptor)
        except BaseException:
            self.close_uncertainties.append(role)
            self.failed = True
            raise
        self.guard()

    def _close_all(self):
        errors = []
        for descriptor in list(self.opened):
            try:
                self._close(descriptor)
            except BaseException as error:
                errors.append(error)
        if errors:
            self.failed = True
            raise ViewRefused("view close or deadline uncertainty") from errors[0]

    def _hash(self, base, name, expected):
        before = self._file_info(base, name)
        require(before.st_size == expected[0], "view pinned size before first read")
        if base == self.destination:
            require(stat.S_IMODE(before.st_mode) == (0o555 if name == "zig" else 0o444) and
                    (before.st_dev, before.st_ino) == self.destination_inodes.get(name),
                    "view readback original created identity/final mode")
        descriptor = None
        try:
            descriptor, opened = self._open(base, name)
            require(self._identity(before) == self._identity(opened), "view source acquisition changed")
            digest, size = hashlib.sha256(), 0
            while True:
                chunk = self._read(descriptor, expected[0] - size)
                if not chunk:
                    break
                size += len(chunk)
                require(size <= expected[0], "view read exceeded expected file")
                digest.update(chunk)
            require(size == expected[0] and digest.hexdigest() == expected[1], "view file size/hash mismatch")
            final_handle = os.fstat(descriptor)
            final_path = self._file_info(base, name)
            require(self._identity(opened) == self._identity(final_handle) == self._identity(final_path),
                    "view read identity changed")
            if base == self.destination:
                require((final_handle.st_dev, final_handle.st_ino) == self.destination_inodes.get(name) and
                        stat.S_IMODE(final_handle.st_mode) == (0o555 if name == "zig" else 0o444),
                        "view final readback original created identity/mode")
            self.guard()
        finally:
            self._close_all()
        return before

    def _read(self, descriptor, remaining):
        require(not self.failed and remaining >= 0, "view failed or negative remaining read")
        requested = min(self.CHUNK, remaining) if remaining else 1  # exactly one admitted EOF probe
        self.guard()
        require(self.read_charged + requested <= self.read_capacity, "view pre-entry read capacity")
        self.read_charged += requested
        self.read_uncertain += requested
        chunk = os.read(descriptor, requested)
        require(type(chunk) is bytes and len(chunk) <= requested, "view native read result")
        self.read_charged -= requested - len(chunk)
        self.read_verified += len(chunk)
        self.read_uncertain -= requested
        self.read_bytes += len(chunk)
        self.guard()
        require(len(chunk) == (requested if remaining else 0), "view short read or excess EOF payload")
        return chunk

    def _source_census(self):
        require(not self.source.is_symlink() and self.source.resolve(strict=True) == self.source,
                "view canonical source root")
        self._ordinary_dir(self.source)
        seen, identities, count = set(), set(), 0
        for parent, dirs, files in os.walk(self.source, followlinks=False, onerror=self._scan_error):
            self.guard()
            self._ordinary_dir(Path(parent))
            for leaf in sorted(dirs + files):
                self.guard()
                count += 1
                require(count <= self.MAX_FILES, "view source census capacity")
                path = Path(parent) / leaf
                info = path.lstat()
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), "view source census kind")
                name = path.relative_to(self.source).as_posix()
                if not any(name == root or name.startswith(root + "/") for root in self.roots):
                    continue
                if stat.S_ISDIR(info.st_mode):
                    require(name not in self.entries, "view planned file replaced by directory")
                    self._ordinary_dir(path)
                    continue
                require(name in self.entries and name not in seen, "view extra/duplicate selected source")
                identity = (info.st_dev, info.st_ino)
                require(identity not in identities, "view selected source alias")
                identities.add(identity)
                seen.add(name)
                verified = self._hash(self.source, name, self.entries[name])
                self.source_inodes[name] = (verified.st_dev, verified.st_ino)
        require(seen == set(self.entries), "view missing selected source")
        for root in self.roots:
            if root not in self.entries:
                self._ordinary_dir(self.source / root)
        self.guard()

    def _scan_error(self, error):
        self.failed = True
        raise ViewRefused("view directory census scan failed") from error

    def _copy(self, name, expected):
        before = self._file_info(self.source, name)
        require(before.st_size == expected[0] and (before.st_dev, before.st_ino) == self.source_inodes.get(name),
                "view copy pinned size/source census identity before read")
        try:
            source, opened = self._open(self.source, name)
            require(self._identity(before) == self._identity(opened), "view copy source changed before entry")
            destination, output = self._open(self.destination, name, destination=True)
            require(output.st_size == 0, "view exclusive output not empty")
            created_inode = (output.st_dev, output.st_ino)
            self.destination_inodes[name] = created_inode
            digest, count = hashlib.sha256(), 0
            while True:
                chunk = self._read(source, expected[0] - count)
                if not chunk:
                    break
                require(count + len(chunk) <= expected[0] and self.charged + len(chunk) <= self.total,
                        "view prospective payload capacity")
                self.charged += len(chunk)
                self.uncertain += len(chunk)  # uncertainty remains charged on short/throw/full-then-throw
                written = os.write(destination, chunk)
                require(written == len(chunk), "view short write; no retry")
                self.verified += len(chunk)
                self.uncertain -= len(chunk)
                digest.update(chunk)
                count += len(chunk)
                self.guard()
            require(count == expected[0] and digest.hexdigest() == expected[1], "view copied source hash mismatch")
            require(self._identity(opened) == self._identity(os.fstat(source)) ==
                    self._identity(self._file_info(self.source, name)), "view copy source identity drift")
            os.fsync(destination)
            self.guard()
            os.fchmod(destination, 0o555 if name == "zig" else 0o444)
            self.guard()
            final_handle = os.fstat(destination)
            final_path = self._file_info(self.destination, name)
            require(self._identity(final_handle) == self._identity(final_path) and
                    stat.S_IMODE(final_handle.st_mode) == (0o555 if name == "zig" else 0o444) and
                    created_inode == (final_handle.st_dev, final_handle.st_ino),
                    "view created destination identity replaced")
            require(created_inode != (opened.st_dev, opened.st_ino), "view source/destination alias")
        finally:
            self._close_all()
        verified = self._hash(self.destination, name, expected)
        require((verified.st_dev, verified.st_ino) == created_inode, "view readback adopted replacement")
        self.copied_files += 1
        self.guard()

    def _destination_census(self):
        dirs, files, identities = {""}, set(), set()
        for parent, directory_names, file_names in os.walk(self.destination, followlinks=False, onerror=self._scan_error):
            self.guard()
            self._ordinary_dir(Path(parent))
            for leaf in sorted(directory_names + file_names):
                self.guard()
                path = Path(parent) / leaf
                name = path.relative_to(self.destination).as_posix()
                info = path.lstat()
                require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), "view output census kind")
                if stat.S_ISDIR(info.st_mode):
                    require(name in self.dirs and name not in dirs, "view extra/duplicate output directory")
                    require(stat.S_IMODE(info.st_mode) == 0o555, "view output directory mode")
                    self._known_directory(path, info)
                    dirs.add(name)
                else:
                    require(name in self.included and name not in files, "view extra/excluded output file")
                    require(stat.S_IMODE(info.st_mode) == (0o555 if name == "zig" else 0o444), "view output mode")
                    require((info.st_dev, info.st_ino) not in identities, "view output inode alias")
                    require((info.st_dev, info.st_ino) == self.destination_inodes.get(name),
                            "view output census adopted replacement")
                    identities.add((info.st_dev, info.st_ino))
                    files.add(name)
                    self._hash(self.destination, name, self.included[name])
        require(stat.S_IMODE(self.destination.lstat().st_mode) == 0o555, "view output root directory mode")
        self._known_directory(self.destination, self.destination.lstat())
        require(files == set(self.included) and dirs == self.dirs, "view exact output namespace")
        for name in sorted(self.dirs):
            self.guard()
            descriptor = self._walk_dir(self.destination / name)
            try:
                self._known_directory(self.destination / name, os.fstat(descriptor))
            finally:
                self._close(descriptor)
        require(self.charged == self.verified == self.total and self.uncertain == 0 and
                self.copied_files == len(self.included), "view final copy accounting")
        require(self.read_charged == self.read_verified == self.read_bytes and self.read_uncertain == 0 and
                self.read_bytes == sum(row[0] for row in self.entries.values()) + 3 * self.total,
                "view final read schedule/accounting")
        self.guard()

    def construct(self):
        require(not self.started, "view construction already spent")
        self.started = True
        try:
            self.guard()
            self._source_census()
            require(not self.destination.exists() and not self.destination.is_symlink() and
                    self.destination.parent.resolve(strict=True) == self.destination.parent,
                    "view fixed absent canonical destination")
            self._ordinary_dir(self.destination.parent)
            for name in sorted(self.dirs, key=lambda x: (x.count("/"), x)):
                self.guard()
                target = self.destination / name
                parent = self._walk_dir(target.parent)
                try:
                    os.mkdir(target.name, mode=0o755, dir_fd=parent)
                finally:
                    self._close(parent)
                info = self._ordinary_dir(self.destination / name)
                self.destination_directories[(self.destination / name).relative_to(self.destination).as_posix()] = (info.st_dev, info.st_ino)
                self.guard()
            for name, expected in self.included.items():
                self._copy(name, expected)
            for name in sorted(self.dirs, key=lambda x: (x.count("/"), x), reverse=True):
                self.guard()
                descriptor = self._walk_dir(self.destination / name)
                try:
                    os.fchmod(descriptor, 0o555)
                finally:
                    self._close(descriptor)
                self.guard()
            self.directories_frozen = True
            self._destination_census()
            require(not self.failed and not self.opened and not self.close_uncertainties and
                    not self.acquisition_uncertainties and self.acquisition_pending == 0,
                    "view ownership or close uncertainty")
            self.guard()
            self.completed = True  # only after actual independent readback/census/clock checks
            return self.destination
        except BaseException:
            self.failed, self.completed = True, False
            self._close_all()
            raise
