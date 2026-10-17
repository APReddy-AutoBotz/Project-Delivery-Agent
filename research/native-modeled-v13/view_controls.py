"""First-party modeled actual-copy controls; synthetic bytes never executed."""
import hashlib
import json
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fixed_tool_view", Path(__file__).with_name("tool_view.py"))
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)

ROOTS = {"zig", "lib/std", "lib/compiler", "lib/compiler_rt", "lib/compiler_rt.zig", "lib/ubsan_rt.zig", "lib/include", "lib/libc/musl",
    "lib/libc/include/generic-musl", "lib/libc/include/x86_64-linux-musl", "lib/libc/include/any-linux-any", "lib/libc/include/x86-linux-any"}
GROUPS = {
    "lib/include/": ("limits.h", "stdarg.h", "stddef.h", "stdint.h"),
    "lib/libc/include/generic-musl/": ("dirent.h", "errno.h", "fcntl.h", "limits.h", "signal.h", "stdint.h", "stdio.h", "string.h", "sys/prctl.h", "sys/resource.h", "sys/stat.h", "sys/syscall.h", "sys/vfs.h", "sys/wait.h", "time.h", "unistd.h"),
    "lib/libc/include/x86_64-linux-musl/": ("bits/alltypes.h", "bits/syscall.h"),
    "lib/libc/include/any-linux-any/": ("linux/filter.h", "linux/seccomp.h", "linux/audit.h", "linux/close_range.h", "linux/magic.h", "linux/ptrace.h", "linux/sched.h", "linux/types.h", "linux/bpf_common.h", "linux/elf-em.h", "linux/posix_types.h", "linux/stddef.h", "linux/const.h", "asm/types.h", "asm-generic/types.h", "asm-generic/int-ll64.h", "asm-generic/posix_types.h", "asm-generic/bitsperlong.h"),
    "lib/libc/include/x86-linux-any/": ("asm/bitsperlong.h", "asm/posix_types.h", "asm/posix_types_64.h", "asm/ptrace.h", "asm/ptrace-abi.h", "asm/processor-flags.h")}
HEADERS = {prefix + name for prefix, names in GROUPS.items() for name in names}
EXCLUDED = "lib/libc/include/any-linux-any/linux/unresolved-fixture.h"


# Canonical ordinal identities refer to the preserved V8 source order.
VIEW_GROUPS = (('g01', (1, 2)), ('g02', (3,)), ('g03', (4,)), ('g04', (5,)), ('g05', (6,)), ('g06', (7,)), ('g07', (8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26)), ('g08', (27, 28, 29, 30, 31, 32, 33, 34, 35, 36)), ('g09', (37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50)), ('g10', (51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62)), ('g11', (63, 64, 65, 66, 67, 68, 69, 70, 71)))


def run(owned, group):
    assert type(group) is str and group in {name for name, _ in VIEW_GROUPS}
    selected = next(values for name, values in VIEW_GROUPS if name == group)
    expected_names = tuple("view-" + str(value).zfill(3) for value in selected)
    count, completed = 0, []

    def record(ordinal):
        nonlocal count
        assert type(ordinal) is int and ordinal in selected
        name = "view-" + str(ordinal).zfill(3)
        assert name not in completed
        completed.append(name)
        count += 1

    if group == "g01":
        assert len(ROOTS) == 12 and len(HEADERS) == 46
        record(1)

    def fixture(parent, complete):
        source = parent / "source"
        source.mkdir()
        data = {root if root in {"zig", "lib/compiler_rt.zig", "lib/ubsan_rt.zig"} else root + "/fixture.txt":
                b"SYNTHETIC NONEXECUTABLE FIXTURE\n" for root in ROOTS}
        data.update({name: b"SYNTHETIC HEADER FIXTURE\n" for name in HEADERS})
        data[EXCLUDED] = b"SYNTHETIC UNRESOLVED EXCLUSION\n"
        fixture_roots, fixture_headers = ROOTS, HEADERS
        if not complete:
            data = {name: data[name] for name in ("zig", "lib/include/stddef.h", EXCLUDED)}
            fixture_roots = {"zig", "lib/include", "lib/libc/include/any-linux-any"}
            fixture_headers = {"lib/include/stddef.h"}
        entries = []
        for name, payload in sorted(data.items()):
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            entries.append([name, len(payload), hashlib.sha256(payload).hexdigest(), name == EXCLUDED])
        owner = V.ToolView(source, parent / "tool-view", entries, sorted(fixture_roots), sorted(fixture_headers), lambda: None)
        return owner, data

    def refused(owner):
        try:
            owner.construct()
        except (V.ViewRefused, OSError, RuntimeError):
            pass
        else:
            raise AssertionError("invalid view completed")
        assert owner.failed and not owner.completed and not owner.opened
        assert owner.charged == owner.verified + owner.uncertain
        try:
            owner.construct()
        except V.ViewRefused:
            pass
        else:
            raise AssertionError("view construction retried")

    with tempfile.TemporaryDirectory(prefix="view-controls-", dir=owned) as temporary:
        base = Path(temporary)

        def fresh(name, complete=False):
            parent = base / name
            parent.mkdir()
            return fixture(parent, complete)

        if group == "g01":
            owner, data = fresh("healthy", complete=True)
            view = owner.construct()
            actual = {p.relative_to(view).as_posix() for p in view.rglob("*") if p.is_file()}
            assert actual == set(data) - {EXCLUDED} and HEADERS.issubset(actual)
            assert len(ROOTS) == 12 and len(HEADERS) == 46 and not (view / EXCLUDED).exists()
            assert not (view / "LICENSE").exists() and (view / "zig").read_bytes() == data["zig"]
            assert owner.completed and not owner.failed and owner.charged == owner.verified == owner.total
            assert owner.uncertain == 0 and not owner.opened and not owner.close_uncertainties
            assert all((view / name).read_bytes() == payload for name, payload in data.items() if name != EXCLUDED)
            record(2)

        for fault, reason in (("missing", "view missing selected source"),
                              ("hash", "view file size/hash mismatch"),
                              ("size", "view pinned size before first read"),
                              ("directory", "view planned file replaced by directory"),
                              ("symlink", "view source census kind")):
            if group != {'missing': 'g02', 'hash': 'g03', 'size': 'g04', 'directory': 'g05', 'symlink': 'g06'}[fault]:
                continue
            healthy, _ = fresh("ubsan-baseline-" + fault, complete=True)
            healthy.construct()
            assert healthy.completed and not healthy.failed
            owner, _ = fresh("ubsan-" + fault, complete=True)
            target = owner.source / "lib/ubsan_rt.zig"
            if fault == "missing":
                target.unlink()
            elif fault == "hash":
                value = target.read_bytes()
                target.write_bytes(b"X" + value[1:])
            elif fault == "size":
                target.write_bytes(target.read_bytes() + b"X")
            else:
                target.unlink()
                if fault == "directory":
                    target.mkdir()
                else:
                    target.symlink_to(owner.source / "zig")
            try:
                owner.construct()
            except V.ViewRefused as error:
                assert str(error) == reason
            else:
                raise AssertionError("invalid UBSan view completed")
            assert owner.failed and not owner.completed and not owner.opened
            record({'missing': 3, 'hash': 4, 'size': 5, 'directory': 6, 'symlink': 7}[fault])

        if group == "g07":
            for name in ("../escape", "/absolute", "lib//double", "lib/./dot", "lib/a/../dot", "lib\\backslash", "C:drive", "", "lib/\x00nul"):
                try:
                    V.safe_path(name)
                except V.ViewRefused:
                    record(8 + ('../escape', '/absolute', 'lib//double', 'lib/./dot', 'lib/a/../dot', 'lib\\backslash', 'C:drive', '', 'lib/\x00nul').index(name))
                else:
                    raise AssertionError("unsafe view path")

            for fault in ("missing", "extra", "size", "hash", "source-link", "ancestor-link", "source-hardlink", "source-directory", "existing-view", "existing-view-link"):
                owner, data = fresh(fault)
                name = "lib/include/stddef.h"
                target = owner.source / name
                if fault == "missing":
                    target.unlink()
                elif fault == "extra":
                    target.with_name("extra.h").write_bytes(b"extra")
                elif fault == "size":
                    target.write_bytes(b"changed size")
                elif fault == "hash":
                    target.write_bytes(b"X" * len(data[name]))
                elif fault == "source-link":
                    target.unlink()
                    target.symlink_to(owner.source / "zig")
                elif fault == "ancestor-link":
                    directory = owner.source / "lib/include"
                    moved = owner.source / "original-include"
                    directory.rename(moved)
                    directory.symlink_to(moved, target_is_directory=True)
                elif fault == "source-hardlink":
                    target.with_name("outside-alias").hardlink_to(target)
                elif fault == "source-directory":
                    target.unlink()
                    target.mkdir()
                elif fault == "existing-view":
                    owner.destination.mkdir()
                else:
                    owner.destination.symlink_to(owner.source, target_is_directory=True)
                refused(owner)
                record(17 + ('missing', 'extra', 'size', 'hash', 'source-link', 'ancestor-link', 'source-hardlink', 'source-directory', 'existing-view', 'existing-view-link').index(fault))

        if group == "g08":
            for fault in ("zero", "short", "partial-throw", "full-throw"):
                owner, data = fresh("write-" + fault)
                original = V.os.write
                target_name = next(iter(owner.included))
                trace = []

                def write(descriptor, payload):
                    if owner.opened.get(descriptor) == "destination:" + target_name:
                        trace.append(len(payload))  # every raw entry before any fault/refusal
                        assert len(trace) == 1
                        if fault == "zero":
                            return 0
                        if fault == "short":
                            return original(descriptor, payload[:1])
                        original(descriptor, payload[:1] if fault == "partial-throw" else payload)
                        raise OSError("modeled uncertain write")
                    return original(descriptor, payload)

                with patch.object(V.os, "write", write):
                    refused(owner)
                assert trace == [len(data[target_name])] and owner.uncertain == len(data[target_name])
                assert owner.charged == owner.verified + owner.uncertain and owner.charged <= owner.total
                assert (owner.destination / target_name).exists()
                record(27 + ('zero', 'short', 'partial-throw', 'full-throw').index(fault))

            owner, data = fresh("close-uncertainty")
            original_close = V.os.close
            trace = []

            def close(descriptor):
                role = owner.close_attempts[-1]
                trace.append((descriptor, role))  # EVERY raw entry before the injected outcome
                if len(trace) == 1:
                    original_close(descriptor)
                    raise OSError("modeled full close then throw")
                return original_close(descriptor)

            with patch.object(V.os, "close", close):
                refused(owner)
            assert trace and sum(descriptor == trace[0][0] for descriptor, role in trace) == 1
            assert owner.close_uncertainties == [trace[0][1]]
            assert owner.close_attempts.count(trace[0][1]) == 1
            record(31)

            for phase in ("source-census", "copy", "readback", "close", "destination-census"):
                owner, data = fresh("expiry-" + phase)
                expired = [False]

                def guard():
                    if expired[0]:
                        raise V.ViewRefused("modeled same absolute deadline expired")

                owner.guard = guard
                method = {"source-census": "_source_census", "copy": "_copy", "readback": "_hash",
                          "close": "_close", "destination-census": "_destination_census"}[phase]
                actual_method = getattr(owner, method)

                def after(*args):
                    result = actual_method(*args)
                    if phase != "readback" or args[0] == owner.destination:
                        expired[0] = True
                    return result

                with patch.object(owner, method, after):
                    refused(owner)
                assert expired[0]
                record(32 + ('source-census', 'copy', 'readback', 'close', 'destination-census').index(phase))

        if group == "g09":
            for fault in ("destination-extra", "destination-hash", "destination-link", "destination-hardlink", "destination-mode"):
                owner, data = fresh(fault)
                original_census = owner._destination_census

                def changed():
                    owner.destination.chmod(0o755)
                    target = owner.destination / "zig"
                    if fault == "destination-extra":
                        (owner.destination / "unexpected").write_bytes(b"extra")
                    elif fault == "destination-hash":
                        target.chmod(0o644)
                        target.write_bytes(b"X" * len(data["zig"]))
                        target.chmod(0o555)
                    elif fault == "destination-link":
                        target.unlink()
                        target.symlink_to(owner.source / "zig")
                    elif fault == "destination-hardlink":
                        (base / (fault + "-alias")).hardlink_to(target)
                    else:
                        target.chmod(0o755)
                    owner.destination.chmod(0o555)
                    return original_census()

                with patch.object(owner, "_destination_census", changed):
                    refused(owner)
                record(37 + ('destination-extra', 'destination-hash', 'destination-link', 'destination-hardlink', 'destination-mode').index(fault))

            owner, data = fresh("pre-entry-capacity")
            owner.acquisition_limit = 0
            with patch.object(V.os, "open", side_effect=AssertionError("capacity entered native open")) as opened:
                refused(owner)
            assert opened.call_count == 0 and owner.acquisitions == 0
            record(42)

            owner, data = fresh("numeric-collision")
            descriptor = owner._acquire("/", V.os.O_RDONLY | V.os.O_DIRECTORY, "original-owned-directory")
            raw_close = V.os.close
            with patch.object(V.os, "open", return_value=descriptor) as opened, \
                 patch.object(V.os, "close", side_effect=AssertionError("ambiguous numeric handle closed")) as closed:
                try:
                    owner._acquire("/", V.os.O_RDONLY | V.os.O_DIRECTORY, "supplied-collision")
                except V.ViewRefused:
                    pass
                else:
                    raise AssertionError("numeric collision admitted")
                owner._close_all()
                assert opened.call_count == 1 and closed.call_count == 0
            assert descriptor not in owner.opened and owner.failed
            assert owner.acquisition_uncertainties == [{"role": "supplied-collision", "descriptor": descriptor,
                                                       "priorRole": "original-owned-directory"}]
            raw_close(descriptor)  # control-only disposal of the known supplied alias after external assertions
            record(43)

            owner, data = fresh("known-closed-reuse")
            first = owner._acquire("/", V.os.O_RDONLY | V.os.O_DIRECTORY, "known-first")
            owner._close(first)
            actual_open, actual_close = V.os.open, V.os.close

            def reused(*args, **kwargs):
                value = actual_open(*args, **kwargs)
                if value != first:
                    V.os.dup2(value, first)
                    actual_close(value)
                return first

            with patch.object(V.os, "open", reused):
                second = owner._acquire("/", V.os.O_RDONLY | V.os.O_DIRECTORY, "known-second")
            assert second == first and owner.opened[second] == "known-second"
            owner._close(second)
            assert not owner.failed and not owner.opened and not owner.acquisition_uncertainties
            record(44)

            for fault in ("short-read", "read-throw", "read-budget"):
                owner, data = fresh(fault)
                raw_read = V.os.read
                trace = []
                if fault == "read-budget":
                    owner.read_capacity = 0

                def read(descriptor, size):
                    trace.append((descriptor, size))  # observe before injected failure
                    if fault == "read-throw":
                        raise OSError("modeled read outcome unknown")
                    if fault == "short-read":
                        return raw_read(descriptor, 1)
                    raise AssertionError("read budget entered native read")

                with patch.object(V.os, "read", read):
                    refused(owner)
                assert len(trace) == (0 if fault == "read-budget" else 1)
                assert owner.read_charged == owner.read_verified + owner.read_uncertain
                assert owner.read_charged <= owner.read_capacity
                record(45 + ('short-read', 'read-throw', 'read-budget').index(fault))

            for fault in ("same-bytes-before-readback", "same-bytes-before-census", "same-bytes-at-census-hash"):
                owner, data = fresh(fault)
                actual_hash = owner._hash
                actual_census = owner._destination_census
                trace = []
                in_final_census = [False]

                def replacement(name):
                    trace.append(name)
                    assert len(trace) == 1
                    target = owner.destination / name
                    target.parent.chmod(0o755)
                    target.rename(base / (fault + "-original"))
                    target.write_bytes(data[name])
                    target.chmod(0o555 if name == "zig" else 0o444)
                    target.parent.chmod(0o555)

                def before_hash(base_path, name, expected):
                    if base_path == owner.destination and not trace and fault != "same-bytes-before-census" and \
                            (fault != "same-bytes-at-census-hash" or in_final_census[0]):
                        replacement(name)
                    return actual_hash(base_path, name, expected)

                def before_census():
                    in_final_census[0] = True
                    if fault == "same-bytes-before-census":
                        replacement("zig")
                    return actual_census()

                with patch.object(owner, "_hash", before_hash), patch.object(owner, "_destination_census", before_census):
                    refused(owner)
                assert len(trace) == 1 and not owner.completed
                record(48 + ('same-bytes-before-readback', 'same-bytes-before-census', 'same-bytes-at-census-hash').index(fault))

        if group == "g10":
            for fault in ("duplicate", "unsorted", "foreign-root", "negative-size", "excluded-type", "excluded-sentinel", "aggregate", "file-count", "directory-count"):
                owner, data = fresh("invalid-plan-" + fault)
                rows = [[name, *row] for name, row in owner.entries.items()]
                if fault == "duplicate":
                    rows.append(rows[-1].copy())
                elif fault == "unsorted":
                    rows.reverse()
                elif fault == "foreign-root":
                    rows.append(["outside", 0, hashlib.sha256(b"").hexdigest(), False])
                    rows.sort()
                elif fault == "negative-size":
                    rows[0][1] = -1
                elif fault == "excluded-type":
                    rows[0][3] = 1
                elif fault == "excluded-sentinel":
                    next(row for row in rows if row[0] == "lib/include/stddef.h")[3] = True
                elif fault == "aggregate":
                    next(row for row in rows if row[0] == "zig")[1] = V.ToolView.MAX_BYTES
                attribute = "MAX_FILES" if fault == "file-count" else "MAX_DIRS"
                maximum = 1 if fault in {"file-count", "directory-count"} else getattr(V.ToolView, attribute)
                with patch.object(V.ToolView, attribute, maximum):
                    try:
                        V.ToolView(owner.source, owner.destination, rows, owner.roots, owner.sentinels, lambda: None)
                    except V.ViewRefused:
                        pass
                    else:
                        raise AssertionError("invalid view plan admitted")
                record(51 + ('duplicate', 'unsorted', 'foreign-root', 'negative-size', 'excluded-type', 'excluded-sentinel', 'aggregate', 'file-count', 'directory-count').index(fault))

            for fault in ("source-directory-capacity", "source-census-capacity", "write-capacity"):
                owner, data = fresh(fault)
                if fault == "source-directory-capacity":
                    owner.MAX_DIRS = 0
                elif fault == "source-census-capacity":
                    owner.MAX_FILES = 0
                else:
                    owner.total = 0
                with patch.object(V.os, "write", side_effect=AssertionError("capacity entered native write")) as written:
                    refused(owner)
                assert written.call_count == 0 and owner.charged == 0
                record(60 + ('source-directory-capacity', 'source-census-capacity', 'write-capacity').index(fault))

        if group == "g11":
            for fault in ("intermediate-symlink", "intermediate-directory-replacement"):
                owner, data = fresh(fault)
                actual_census = owner._source_census
                trace = []

                def changed_ancestor():
                    actual_census()
                    trace.append("after-complete-source-census")
                    directory = owner.source / "lib/include"
                    retained = base / (fault + "-original")
                    directory.rename(retained)
                    if fault == "intermediate-symlink":
                        directory.symlink_to(retained, target_is_directory=True)
                    else:
                        directory.mkdir()
                        for leaf in retained.iterdir():
                            leaf.rename(directory / leaf.name)

                with patch.object(owner, "_source_census", changed_ancestor):
                    refused(owner)
                assert trace == ["after-complete-source-census"] and not owner.completed
                record(63 + ('intermediate-symlink', 'intermediate-directory-replacement').index(fault))

            for fault in ("directory-mode", "mode-during-readback", "growth-before-read"):
                owner, data = fresh(fault)
                actual_hash = owner._hash
                actual_open = owner._open
                actual_census = owner._destination_census
                trace = []

                def drift_hash(base_path, name, expected):
                    if base_path == owner.destination and not trace:
                        trace.append(name)
                        (base_path / name).chmod(0o755)
                    return actual_hash(base_path, name, expected)

                def drift_open(base_path, name, destination=False):
                    result = actual_open(base_path, name, destination)
                    if base_path == owner.source and not destination and not trace:
                        trace.append(name)
                        with (base_path / name).open("ab") as stream:
                            stream.write(b"X")
                    return result

                def drift_directory():
                    trace.append("lib")
                    (owner.destination / "lib").chmod(0o755)
                    return actual_census()

                method, callback = ("_destination_census", drift_directory) if fault == "directory-mode" else \
                    ("_hash", drift_hash) if fault == "mode-during-readback" else ("_open", drift_open)
                with patch.object(owner, method, callback):
                    refused(owner)
                assert len(trace) == 1 and not owner.completed
                record(65 + ('directory-mode', 'mode-during-readback', 'growth-before-read').index(fault))

            for fault in ("directory-mode-after-entry", "empty-directory-mode-after-entry"):
                owner, data = fresh(fault)
                actual_hash, actual_census, actual_directory = owner._hash, owner._destination_census, owner._ordinary_dir
                in_census, trace = [False], []

                def census():
                    in_census[0] = True
                    return actual_census()

                def hash_after_entry(base_path, name, expected):
                    if in_census[0] and base_path == owner.destination and not trace and fault == "directory-mode-after-entry":
                        trace.append("lib")
                        (owner.destination / "lib").chmod(0o755)
                    return actual_hash(base_path, name, expected)

                def directory_after_entry(path):
                    result = actual_directory(path)
                    if in_census[0] and path == owner.destination / "lib/libc/include/any-linux-any" and not trace and fault == "empty-directory-mode-after-entry":
                        trace.append("empty-any-linux-root")
                        path.chmod(0o755)
                    return result

                with patch.object(owner, "_destination_census", census), patch.object(owner, "_hash", hash_after_entry), \
                     patch.object(owner, "_ordinary_dir", directory_after_entry):
                    refused(owner)
                assert len(trace) == 1 and not owner.completed
                record(68 + ('directory-mode-after-entry', 'empty-directory-mode-after-entry').index(fault))

            for fault in ("source-scandir-error", "empty-output-scandir-error"):
                owner, data = fresh(fault)
                if fault == "source-scandir-error":
                    target = owner.source / "lib/include/hidden-extra"
                    target.mkdir()
                    (target / "unlisted.h").write_bytes(b"UNLISTED SELECTED FILE")
                else:
                    target = owner.destination / "lib/libc/include/any-linux-any"
                actual_scandir, trace = V.os.scandir, []

                def scandir(path):
                    if Path(path) == target:
                        trace.append(str(path))  # every matching real scan entry before error
                        raise PermissionError("modeled scandir failure")
                    return actual_scandir(path)

                with patch.object(V.os, "scandir", scandir):
                    refused(owner)
                assert trace == [str(target)] and owner.failed and not owner.completed
                record(70 + ('source-scandir-error', 'empty-output-scandir-error').index(fault))

    assert tuple(completed) == expected_names and count == len(selected)
    return dict(schema=1, status="SUPPLIED_TOOL_VIEW_CONTROLS_PASS", group=group, cases=count,
                names=completed, realCompilerImageNativeInvocations=0, nativeQualification=False)


if __name__ == "__main__":
    assert len(sys.argv) == 3
    print(json.dumps(run(Path(sys.argv[1]), sys.argv[2]), separators=(",", ":"), sort_keys=True))
