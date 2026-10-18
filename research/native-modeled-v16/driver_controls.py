"""EXEC-016 research driver controls; network/process/container edges mocked."""
import hashlib
import importlib.util
import io
import json
import lzma
import os
from pathlib import Path
import sys
import tarfile
import tempfile
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("driver", Path(__file__).with_name("host_driver.py"))
D = importlib.util.module_from_spec(spec)
spec.loader.exec_module(D)


def archive(extra=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, payload, kind in (("LICENSE", b"MIT License; Zig contributors", tarfile.REGTYPE),
                                    ("zig", b"not an executable", tarfile.REGTYPE),
                                    ("lib/libc/musl/COPYRIGHT", b"musl as a whole is licensed under standard MIT terms", tarfile.REGTYPE)) + tuple(extra):
            info = tarfile.TarInfo(D.TOP + "/" + name)
            info.size, info.type = len(payload), kind
            if kind == tarfile.SYMTYPE:
                info.linkname = "../../../escape"
                info.size = 0
            tar.addfile(info, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)
    return lzma.compress(output.getvalue())


class Response(io.BytesIO):
    status = 200
    url = D.ARCHIVE


def basic_records(prefix=""):
    return [(prefix + D.TOP + "/LICENSE", b"MIT License; Zig contributors", tarfile.REGTYPE),
            (prefix + D.TOP + "/zig", b"not an executable", tarfile.REGTYPE),
            (prefix + D.TOP + "/lib/libc/musl/COPYRIGHT",
             b"musl as a whole is licensed under standard MIT terms", tarfile.REGTYPE)]


def record_header(name, payload, kind):
    info = tarfile.TarInfo(name)
    info.size, info.type = len(payload), kind
    if kind in (tarfile.LNKTYPE, tarfile.SYMTYPE):
        info.linkname = "../../../escape"
    header = info.tobuf(format=tarfile.GNU_FORMAT if kind == tarfile.GNUTYPE_LONGNAME else tarfile.USTAR_FORMAT,
                        encoding="utf-8", errors="strict")
    if kind == tarfile.DIRTYPE and name in (".", "./"):
        # tobuf appends '/' to directory '.'. Preserve BOTH admitted raw forms.
        header = bytearray(header)
        raw_name = name.encode("ascii")
        header[:100] = raw_name + b"\0" * (100 - len(raw_name))
        header = checksum_header(header)
    return header


def raw_archive(records):
    # Manual framing permits malformed entries without TarFile normalizing them.
    data = bytearray()
    previous_longname = False
    for name, payload, kind in records:
        data.extend(gnu_short_header(name, payload, kind) if previous_longname and kind != tarfile.GNUTYPE_LONGNAME
                    else record_header(name, payload, kind))
        data.extend(payload)
        data.extend(b"\0" * ((-len(payload)) % 512))
        previous_longname = kind == tarfile.GNUTYPE_LONGNAME
    return lzma.compress(bytes(data) + b"\0" * 1024)


def checksum_header(header):
    result = bytearray(header)
    result[148:156] = b"        "
    result[148:156] = ("%06o\0 " % sum(result)).encode("ascii")
    return bytes(result)


def gnu_short_header(name, payload, kind):
    # Faithful ordinary GNU header: the following name field is truncated to
    # 100 bytes, with no USTAR prefix splitting or automatic extra extension.
    header = bytearray(record_header(name[:100], payload, kind))
    header[:100] = name.encode("ascii")[:100].ljust(100, b"\0")
    header[257:265] = tarfile.GNU_MAGIC
    header[345:500] = b"\0" * 155
    return checksum_header(header)


def run(owned_directory):
    count = 0

    def accept(action):
        nonlocal count
        action()
        count += 1

    def deny(action):
        nonlocal count
        try:
            action()
        except (D.Refused, lzma.LZMAError, EOFError, tarfile.TarError, FileExistsError):
            count += 1
            return
        raise AssertionError("driver refusal missing: " + str(count + 1))

    def extract(parent, data, name="attempt", expected=None):
        attempt = D.Attempt(Path(__file__).parent, parent / name)
        response = Response(data)
        with patch.object(D, "ARCHIVE_SHA", expected or hashlib.sha256(data).hexdigest()), \
             patch.object(D, "ARCHIVE_SIZE", len(data)), \
             patch.object(D.urllib.request, "build_opener") as opener, \
             patch.object(D.subprocess, "Popen", side_effect=AssertionError("unexpected process")):
            opener.return_value.open.return_value = response
            tool = attempt.download_extract()
            assert (tool / "zig").read_bytes() == b"not an executable"
            assert opener.call_count == 1 and opener.return_value.open.call_count == 1
        return attempt, tool

    with patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}), \
         tempfile.TemporaryDirectory(prefix="driver-controls-", dir=owned_directory) as location:
        parent = Path(location)
        good = archive()
        attempt, tool = extract(parent, good)
        count += 1
        # Explicit path grammar, through the actual extractor/frombuf boundary.
        for index, records in enumerate((basic_records("./"),
                [(".", b"", tarfile.DIRTYPE)] + basic_records(),
                [("./", b"", tarfile.DIRTYPE)] + basic_records("./"))):
            if records[0][0] in (".", "./"):
                encoded_root = record_header(*records[0])
                assert encoded_root[:100].split(b"\0", 1)[0] == records[0][0].encode("ascii")
                parsed_root = tarfile.TarInfo.frombuf(encoded_root, "utf-8", "strict")
                assert parsed_root.name == "." and parsed_root.type == tarfile.DIRTYPE and parsed_root.size == 0
            accepted, accepted_tool = extract(parent, raw_archive(records), "admitted-spelling-" + str(index))
            assert accepted_tool == accepted.fixture / "tools" / D.TOP
            assert not (accepted.fixture / "tools" / "escape").exists()
            count += 1

        def diagnostic_refusal(data, identity, ordinal, offset, expected_stage, expected_header):
            nonlocal count
            refused = D.Attempt(Path(__file__).parent, parent / identity)
            with patch.object(D, "ARCHIVE_SHA", hashlib.sha256(data).hexdigest()), \
                 patch.object(D, "ARCHIVE_SIZE", len(data)), \
                 patch.object(D.urllib.request, "build_opener") as opener, \
                 patch.object(D.subprocess, "Popen", side_effect=AssertionError("unexpected archive process")) as popen:
                opener.return_value.open.return_value = Response(data)
                try:
                    refused.download_extract()
                except (D.Refused, tarfile.TarError, UnicodeDecodeError) as error:
                    refused.failed = True
                    refused.events.append(dict(id="failure", type=type(error).__name__))
                    refused.save()
                else:
                    raise AssertionError("actual archive refusal missing: " + identity)
                recorded = next(r for r in refused.events if r["id"] == "archive")["lastHeader"]
                assert recorded["ordinal"] == ordinal and recorded["logicalOffset"] == offset
                assert recorded["stage"] == expected_stage and recorded["bytes"] == len(expected_header)
                assert recorded["sha256"] == hashlib.sha256(expected_header).hexdigest()
                assert recorded["nameHex"] == expected_header[:100].hex()
                assert recorded["prefixHex"] == expected_header[345:500].hex()
                assert recorded["typeHex"] == expected_header[156:157].hex()
                assert len(json.dumps(recorded, ensure_ascii=True).encode()) <= 4096
                frozen_diagnostic = json.dumps(recorded, sort_keys=True)
                refused.cleanup()
                saved = json.loads((refused.receipts / "attempt.json").read_text())
                persisted = next(r for r in saved["events"] if r["id"] == "archive")["lastHeader"]
                assert json.dumps(persisted, sort_keys=True) == frozen_diagnostic
                assert saved["status"] == "FAILED_OR_INCOMPLETE" and not saved["modelsPassed"]
                assert opener.call_count == 1 and opener.return_value.open.call_count == 1
                popen.assert_not_called()
            assert not (refused.fixture / "escape").exists()
            count += 1
            return recorded

        # Refusals identify the actual second header after payload AND padding.
        first = basic_records()[0]
        bad_paths = (D.TOP + "/../escape", "././" + D.TOP + "/escape", "/" + D.TOP + "/escape",
                     D.TOP + "/dot/./escape", D.TOP + "/zero//escape", D.TOP + "/back\\escape",
                     "other-root/escape", D.TOP + "/control\nname")
        for index, name in enumerate(bad_paths):
            bad = (name, b"x", tarfile.REGTYPE)
            diagnostic_refusal(raw_archive([first, bad]), "diagnostic-path-" + str(index),
                               2, 1024, "PATH", record_header(*bad))
        alias = ("./" + D.TOP + "/LICENSE", b"duplicate", tarfile.REGTYPE)
        diagnostic_refusal(raw_archive([first, alias]), "canonical-alias", 2, 1024,
                           "DUPLICATE", record_header(*alias))
        roots = ((".", b"", tarfile.REGTYPE), ("./", b"x", tarfile.DIRTYPE),
                 (".//", b"", tarfile.DIRTYPE))
        for index, bad in enumerate(roots):
            diagnostic_refusal(raw_archive([bad]), "diagnostic-root-" + str(index),
                               1, 0, "PATH", record_header(*bad))
        root = (".", b"", tarfile.DIRTYPE)
        diagnostic_refusal(raw_archive([root, root]), "repeated-root", 2, 512,
                           "PATH", record_header(*root))
        diagnostic_refusal(raw_archive([first, root]), "late-root", 2, 1024,
                           "PATH", record_header(*root))
        for index, kind in enumerate((tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.XHDTYPE, tarfile.XGLTYPE,
                                     tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK,
                                     tarfile.GNUTYPE_SPARSE, tarfile.FIFOTYPE, tarfile.CHRTYPE)):
            bad = (D.TOP + "/metadata", b"", kind)
            diagnostic_refusal(raw_archive([bad]), "diagnostic-type-" + str(index),
                               1, 0, "LONGNAME_HEADER" if kind == tarfile.GNUTYPE_LONGNAME else "TYPE", record_header(*bad))
        for index, kind in enumerate((tarfile.SYMTYPE, tarfile.XHDTYPE)):
            bad = (".", b"", kind)
            diagnostic_refusal(raw_archive([bad]), "root-type-" + str(index),
                               1, 0, "TYPE", record_header(*bad))
        valid_header = record_header(*first)
        malformed = bytearray(valid_header)
        malformed[0] ^= 1
        diagnostic_refusal(lzma.compress(bytes(malformed) + b"\0" * 1024), "checksum", 1, 0,
                           "HEADER_PARSE", bytes(malformed))
        malformed[0] = 255
        malformed = checksum_header(malformed)
        diagnostic_refusal(lzma.compress(malformed + b"\0" * 1024), "encoding", 1, 0,
                           "HEADER_PARSE", malformed)
        diagnostic_refusal(lzma.compress(valid_header[:127]), "short-header", 1, 0,
                           "HEADER_PARSE", valid_header[:127])
        payload = first[1]
        wrong_padding = valid_header + payload + b"x" + b"\0" * (511 - len(payload)) + b"\0" * 1024
        diagnostic_refusal(lzma.compress(wrong_padding), "nonzero-padding", 1, 0,
                           "PADDING", valid_header)

        def long_records(name, payload=b"long file", kind=tarfile.REGTYPE):
            extension = ("././@LongLink", name.encode("ascii") + b"\0", tarfile.GNUTYPE_LONGNAME)
            following = (name[:100], payload, kind)
            return [extension, following]

        long_file = D.TOP + "/lib/" + "f" * 110
        long_dir = D.TOP + "/lib/" + "d" * 110 + "/"
        boundary = D.TOP + "/lib/" + "a" * 240 + "/"
        boundary += "b" * (512 - len(boundary))
        for index, (name, kind) in enumerate(((long_file, tarfile.REGTYPE), ("./" + long_file, tarfile.REGTYPE),
                                             (long_dir, tarfile.DIRTYPE), (boundary, tarfile.REGTYPE))):
            records = long_records(name, b"" if kind == tarfile.DIRTYPE else b"long file", kind)
            following_header = gnu_short_header(*records[1])
            assert following_header[:100] == name.encode("ascii")[:100].ljust(100, b"\0")
            assert following_header[257:265] == tarfile.GNU_MAGIC and following_header[156:157] == kind
            after = (D.TOP + "/after", b"after long name", tarfile.REGTYPE)
            accepted, accepted_tool = extract(parent, raw_archive(basic_records() + records + [after]), "gnu-long-" + str(index))
            canonical = name[2:] if name.startswith("./") else name
            target = accepted.fixture / "tools" / canonical.rstrip("/")
            assert target.is_dir() if kind == tarfile.DIRTYPE else target.read_bytes() == b"long file"
            assert not (accepted.fixture / "tools" / records[1][0].rstrip("/")).exists()
            assert (accepted_tool / "after").read_bytes() == b"after long name"
            count += 1
        next_long_file = long_file + "-second"
        accepted, accepted_tool = extract(parent,
            raw_archive(basic_records() + long_records(long_file) + long_records(next_long_file)), "gnu-two-independent")
        assert (accepted.fixture / "tools" / long_file).read_bytes() == b"long file"
        assert (accepted.fixture / "tools" / next_long_file).read_bytes() == b"long file"
        count += 1
        mismatch = long_records(long_file)
        mismatch[1] = ("other-root/ignored-short-name", b"long file", tarfile.REGTYPE)
        accepted, accepted_tool = extract(parent, raw_archive(basic_records() + mismatch), "gnu-ignored-short-name")
        assert (accepted.fixture / "tools" / long_file).read_bytes() == b"long file"
        assert not (accepted.fixture / "tools" / "other-root").exists()
        count += 1

        def assert_origin(recorded, name, ordinal=1, offset=0):
            payload = name.encode("ascii") + b"\0"
            origin = recorded["longNameOrigin"]
            assert origin == dict(ordinal=ordinal, logicalOffset=offset,
                headerSha256=hashlib.sha256(record_header("././@LongLink", payload, tarfile.GNUTYPE_LONGNAME)).hexdigest(),
                payloadBytes=len(payload), payloadSha256=hashlib.sha256(payload).hexdigest())
            assert recorded["effectiveName"] == name

        for index, name in enumerate((D.TOP + "/../escape", "././" + D.TOP + "/escape", "/" + D.TOP + "/escape",
                                      D.TOP + "/zero//escape", "other-root/escape", D.TOP + "/back\\escape")):
            records = long_records(name)
            recorded = diagnostic_refusal(raw_archive(records), "gnu-path-" + str(index), 2, 1024,
                                         "PATH", gnu_short_header(*records[1]))
            assert_origin(recorded, name)
        unsafe_name = D.TOP + "/../escape"
        records = long_records(unsafe_name)
        records[1] = (D.TOP + "/safe-short", b"must not be written", tarfile.REGTYPE)
        recorded = diagnostic_refusal(raw_archive(records), "gnu-unsafe-effective-safe-short", 2, 1024,
                                     "PATH", gnu_short_header(*records[1]))
        assert bytes.fromhex(recorded["nameHex"]).split(b"\0", 1)[0] == (D.TOP + "/safe-short").encode("ascii")
        assert recorded["parsedName"] == D.TOP + "/safe-short"
        assert_origin(recorded, unsafe_name)
        assert not list((parent / "gnu-unsafe-effective-safe-short" / "tools").iterdir())
        alias_name = "./" + D.TOP + "/LICENSE"
        records = long_records(alias_name)
        recorded = diagnostic_refusal(raw_archive([first] + records), "gnu-alias", 3, 2048,
                                     "DUPLICATE", gnu_short_header(*records[1]))
        assert_origin(recorded, alias_name, 2, 1024)
        valid_extension = long_records(long_file)[0]
        for index, successor in enumerate((valid_extension,
                (D.TOP + "/link", b"", tarfile.GNUTYPE_LONGLINK),
                (D.TOP + "/pax", b"", tarfile.XHDTYPE),
                (D.TOP + "/sparse", b"", tarfile.GNUTYPE_SPARSE),
                (D.TOP + "/symlink", b"", tarfile.SYMTYPE),
                (D.TOP + "/areg/", b"", tarfile.AREGTYPE))):
            recorded = diagnostic_refusal(raw_archive([valid_extension, successor]), "gnu-successor-" + str(index),
                2, 1024, "LONGNAME_HEADER" if successor[2] == tarfile.GNUTYPE_LONGNAME else "TYPE",
                record_header(*successor) if successor[2] == tarfile.GNUTYPE_LONGNAME else gnu_short_header(*successor))
            assert_origin(recorded, long_file)
        for size in (511, 512, 513):
            name = "other-root/" + "a" * 240 + "/"
            name += "b" * (size - 1 - len(name))
            records = long_records(name)
            recorded = diagnostic_refusal(raw_archive(records), "gnu-offset-" + str(size),
                2, 512 + ((size + 511) // 512) * 512, "PATH", gnu_short_header(*records[1]))
            assert_origin(recorded, name)
        recorded = diagnostic_refusal(raw_archive([valid_extension]), "gnu-dangling", 2, 1024,
                                     "LONGNAME_DANGLING", b"\0" * 512)
        assert_origin(recorded, long_file)
        for index, payload in enumerate((b"", b"\0", b"x" * 513 + b"\0", b"missing terminator",
                                         b"interior\0NUL\0", b"\xff\0", b"line\nname\0")):
            bad = ("././@LongLink", payload, tarfile.GNUTYPE_LONGNAME)
            diagnostic_refusal(raw_archive([bad]), "gnu-payload-" + str(index), 1, 0,
                               "LONGNAME_SIZE" if not 2 <= len(payload) <= 513 else "LONGNAME_PAYLOAD", record_header(*bad))
        extension_header = record_header(*valid_extension)
        extension_payload = valid_extension[1]
        diagnostic_refusal(lzma.compress(extension_header + extension_payload[:-1]), "gnu-short-payload", 1, 0,
                           "LONGNAME_PAYLOAD", extension_header)
        bad_padding = extension_header + extension_payload + b"x" + b"\0" * (511 - len(extension_payload)) + b"\0" * 1024
        diagnostic_refusal(lzma.compress(bad_padding), "gnu-padding", 1, 0, "LONGNAME_PADDING", extension_header)
        following = bytearray(gnu_short_header(*long_records(long_file)[1]))
        following[0] ^= 1
        prefix = extension_header + extension_payload + b"\0" * ((-len(extension_payload)) % 512)
        recorded = diagnostic_refusal(lzma.compress(prefix + bytes(following) + b"\0" * 1024), "gnu-next-checksum",
                                     2, 1024, "HEADER_PARSE", bytes(following))
        assert_origin(recorded, long_file)
        following = gnu_short_header(*long_records(long_file)[1])[:127]
        recorded = diagnostic_refusal(lzma.compress(prefix + following), "gnu-next-truncated", 2, 1024,
                                     "HEADER_PARSE", following)
        assert_origin(recorded, long_file)
        for index, name in enumerate((".", D.TOP + "/lib/double//")):
            records = long_records(name, b"", tarfile.DIRTYPE)
            recorded = diagnostic_refusal(raw_archive(records), "gnu-directory-path-" + str(index), 2, 1024,
                                         "PATH", gnu_short_header(*records[1]))
            assert recorded["longNameOrigin"]["ordinal"] == 1
        deny(lambda: D.Attempt(Path(__file__).parent, parent / "attempt"))
        deny(lambda: extract(parent, good, "bad-sha", "0" * 64))
        for index, extra in enumerate((
            (("../escape", b"x", tarfile.REGTYPE),),
            (("LICENSE", b"duplicate", tarfile.REGTYPE),),
            (("link", b"", tarfile.SYMTYPE),),
            (("device", b"", tarfile.CHRTYPE),),
            (("dot/./file", b"x", tarfile.REGTYPE),),
            (("zero//file", b"x", tarfile.REGTYPE),))):
            deny(lambda index=index, extra=extra: extract(parent, archive(extra), "bad-path-" + str(index)))
        deny(lambda: extract(parent, good + b"trailing", "trailing-xz"))
        deny(lambda: extract(parent, good[:-3], "truncated-xz"))
        with patch.object(D.urllib.request.HTTPRedirectHandler, "redirect_request",
                          side_effect=AssertionError("redirect followed")):
            deny(lambda: D.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://unapproved.invalid"))
        denied = D.Attempt(Path(__file__).parent, parent / "expired")
        denied.deadline = D.time.monotonic() - 1
        with patch.object(D.subprocess, "Popen", side_effect=AssertionError("expired acquisition")):
            deny(lambda: denied.command("expired", ["unapproved"], 1))
        reused = D.Attempt(Path(__file__).parent, parent / "reused")
        reused.events.append(dict(id="once"))
        with patch.object(D.subprocess, "Popen", side_effect=AssertionError("repeated acquisition")):
            deny(lambda: reused.command("once", ["unapproved"], 1))
        late = D.Attempt(Path(__file__).parent, parent / "entry-expired-by-save")
        def expire():
            late.deadline = D.time.monotonic() - 1
        with patch.object(late, "save", side_effect=expire), \
             patch.object(D.subprocess, "Popen", side_effect=AssertionError("late effect after receipt")) as popen:
            deny(lambda: late.command("late", ["mock-only"], 1))
            popen.assert_not_called()
            count += 1
        late_download = D.Attempt(Path(__file__).parent, parent / "request-expired-by-save")
        def expire_request():
            late_download.deadline = D.time.monotonic() - 1
        with patch.object(late_download, "save", side_effect=expire_request), \
             patch.object(D.urllib.request, "build_opener") as opener:
            deny(lambda: late_download.download_extract())
            opener.return_value.open.assert_not_called()
            count += 1
        accept(lambda: reused.write_receipt("small.txt", b"ok"))
        accept(lambda: reused.write_receipt("small.txt", b"new"))
        assert reused.receipt_bytes == 3
        count += 1
        deny(lambda: reused.write_receipt("../escape.txt", b"no"))
        deny(lambda: reused.write_receipt("large.txt", b"x" * (D.LIMIT + 1)))
        # A selector failure after Popen must kill/wait the ACTUAL acquired group.
        cleanup = D.Attempt(Path(__file__).parent, parent / "selector-failure")
        with patch.object(D.subprocess, "Popen") as popen, \
             patch.object(D.selectors, "DefaultSelector", side_effect=RuntimeError("injected selector")), \
             patch.object(D.os, "killpg") as kill:
            process = popen.return_value
            process.pid, process.returncode = 321, None
            process.poll.return_value = None
            try:
                cleanup.command("selector-fault", ["mock-only"], 1)
            except RuntimeError:
                pass
            else:
                raise AssertionError("injected selector failure swallowed")
            kill.assert_called_once_with(321, D.signal.SIGKILL)
            process.wait.assert_called_once()
            assert cleanup.events[0]["hostPid"] == 321 and cleanup.events[0]["status"] == "DRIVER_EXCEPTION"
            count += 1
        # A create collision with the same label never admits an existing ID.
        ownership = D.Attempt(Path(__file__).parent, parent / "ownership")
        name = ownership.name + "-build"
        args = ownership.docker_base(name)
        assert "--network" in args and args[args.index("--network") + 1] == "none"
        assert "--read-only" in args and "--cap-drop" in args and "--pids-limit" in args
        count += 1
        with patch.object(ownership, "command", return_value=(False, b"name collision")) as command:
            assert ownership.create(name, "mock-create", args) is False
            count += 1
            deny(lambda: ownership.remove(name))
            assert command.call_count == 1
            count += 1
        admitted = "a" * 64
        deny(lambda: ownership.create(name, "mock-retry", args))
        ownership = D.Attempt(Path(__file__).parent, parent / "admitted-ownership")
        name = ownership.name + "-build"
        args = ownership.docker_base(name)
        def successful_create(*args, **kwargs):
            data = admitted.encode() + b"\n"
            kwargs["capture_result"]("PASSED", 0, data)
            return True, data
        with patch.object(ownership, "command", side_effect=successful_create):
            assert ownership.create(name, "mock-create-return", args)
            count += 1
        with patch.object(ownership, "command", return_value=(True, (admitted + " wrong-owner\n").encode())) as command:
            deny(lambda: ownership.remove(name))
            assert command.call_count == 1 and ownership.containers[0]["removeAttempted"]
            count += 1
            deny(lambda: ownership.remove(name))
        captured = D.Attempt(Path(__file__).parent, parent / "create-finalization-failure")
        captured_name = captured.name + "-build"
        captured_args = captured.docker_base(captured_name)
        write = captured.write_receipt
        def failed_receipt(name, payload, maximum=D.LIMIT):
            if name == "create-with-failed-receipt.txt":
                raise RuntimeError("injected receipt failure after actual create return")
            return write(name, payload, maximum)
        with patch.object(D.subprocess, "Popen") as popen, \
             patch.object(D.selectors, "DefaultSelector") as select, \
             patch.object(D.os, "read", side_effect=[admitted.encode() + b"\n", b""]), \
             patch.object(D.os, "killpg") as kill, patch.object(captured, "write_receipt", side_effect=failed_receipt):
            process, selector = popen.return_value, select.return_value
            process.pid, process.returncode = 567, 0
            process.poll.return_value = 0
            selector.get_map.side_effect = [{1: 1}, {1: 1}, {}]
            selector.select.return_value = [(SimpleNamespace(fileobj=process.stdout), None)]
            try:
                captured.create(captured_name, "create-with-failed-receipt", captured_args)
            except RuntimeError:
                assert captured.containers[0]["id"] == admitted
                process.wait.assert_called_once()
                kill.assert_not_called()
                captured.save()
                assert json.loads((captured.receipts / "attempt.json").read_text())["containerCustody"][0]["id"] == admitted
                count += 1
            else:
                raise AssertionError("create finalization failure swallowed")
        # Exercise the actual component gate, including authenticated publisher
        # inheritance, real UAPI expressions and explicit LLVM notice binding.
        license_packet = parent / "license-packet"
        license_packet.mkdir()
        for name in ("license-scope.json", "LLVM-LICENSE.txt"):
            (license_packet / name).write_bytes(Path(__file__).with_name(name).read_bytes())
        scope = json.loads((license_packet / "license-scope.json").read_text())
        # Independent tagged-Zig0.15.2 mapping/precedence expectations. Do not
        # derive these spellings from the production list or fixture roots.
        assert D.INCLUDES == ["-nostdinc", "-I/src", "-isystem", "/tool/lib/include",
            "-isystem", "/tool/lib/libc/include/x86_64-linux-musl",
            "-isystem", "/tool/lib/libc/include/generic-musl",
            "-isystem", "/tool/lib/libc/include/x86-linux-any",
            "-isystem", "/tool/lib/libc/include/any-linux-any"]
        assert D.COMMON[D.COMMON.index("-target") + 1] == "x86_64-linux-musl"
        count += 1
        arch_root = "lib/libc/include/x86-linux-any"
        arch_headers = [arch_root + "/asm/" + name for name in
                        ("bitsperlong.h", "posix_types.h", "posix_types_64.h", "ptrace.h", "ptrace-abi.h", "processor-flags.h")]
        expected_roots = {"zig", "lib/std", "lib/compiler", "lib/compiler_rt", "lib/compiler_rt.zig", "lib/ubsan_rt.zig", "lib/c.zig", "lib/c", "lib/include",
            "lib/libc/musl", "lib/libc/include/generic-musl", "lib/libc/include/x86_64-linux-musl",
            "lib/libc/include/x86-linux-any", "lib/libc/include/any-linux-any"}
        expected_headers = set(arch_headers)
        expected_groups = {
            "lib/include/": ("limits.h", "stdarg.h", "stddef.h", "stdint.h"),
            "lib/libc/include/generic-musl/": ("dirent.h", "errno.h", "fcntl.h", "limits.h", "signal.h", "stdint.h",
                "stdio.h", "string.h", "sys/prctl.h", "sys/resource.h", "sys/stat.h", "sys/syscall.h", "sys/vfs.h", "sys/wait.h", "time.h", "unistd.h"),
            "lib/libc/include/x86_64-linux-musl/": ("bits/alltypes.h", "bits/syscall.h"),
            "lib/libc/include/any-linux-any/": ("linux/filter.h", "linux/seccomp.h", "linux/audit.h", "linux/close_range.h",
                "linux/magic.h", "linux/ptrace.h", "linux/sched.h", "linux/types.h", "linux/bpf_common.h", "linux/elf-em.h",
                "linux/posix_types.h", "linux/stddef.h", "linux/const.h", "asm/types.h", "asm-generic/types.h",
                "asm-generic/int-ll64.h", "asm-generic/posix_types.h", "asm-generic/bitsperlong.h")}
        for prefix, leaves in expected_groups.items():
            expected_headers.update(prefix + leaf for leaf in leaves)
        assert {r["path"] for r in scope["roots"]} == expected_roots
        assert set(scope["requiredHeaders"]) == expected_headers and len(expected_headers) == 46
        assert next(r for r in scope["roots"] if r["path"] == arch_root)["component"] == "Linux-UAPI"
        count += 1
        license_tool = parent / "license-tool"
        license_tool.mkdir()
        for relative in sorted(expected_roots):
            path = license_tool / relative
            if relative in {"zig", "lib/compiler_rt.zig", "lib/ubsan_rt.zig", "lib/c.zig"}:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("// original publisher source; no contrary file terms\n")
            else:
                path.mkdir(parents=True, exist_ok=True)
        header = license_tool / "lib/include/stddef.h"
        header.write_text("// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception\n")
        for relative in sorted(expected_headers):
            path = license_tool / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            text = ("// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception\n" if relative.startswith("lib/include/")
                    else "/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */\n" if "/any-linux-any/" in relative or "/x86-linux-any/" in relative
                    else "/* original permissive musl public header; no contrary terms */\n")
            path.write_text(text)
        c_runtime_leaves = ('lib/c.zig', 'lib/c/common.zig', 'lib/c/inttypes.zig',
                            'lib/c/stdlib.zig', 'lib/c/string.zig', 'lib/c/strings.zig')
        for name in c_runtime_leaves:
            (license_tool / name).write_text("// synthetic publisher-root C runtime fixture " + name + "\n")
        licensing = D.Attempt(license_packet, parent / "licensing")
        records = licensing.licenses(license_tool)
        assert records["zig"]["licenseSource"] == "reviewed-authenticated-publisher-root"
        assert records[scope["requiredHeaders"][0]]["licenseExpressions"] == ["GPL-2.0 WITH Linux-syscall-note "]
        count += 1
        assert records["lib/ubsan_rt.zig"]["licenseSource"] == "reviewed-authenticated-publisher-root"
        assert records["lib/ubsan_rt.zig"]["licenseExpressions"] == ["MIT"]
        assert all(records[name]["licenseSource"] == "reviewed-authenticated-publisher-root" and
                   records[name]["licenseExpressions"] == ["MIT"] for name in c_runtime_leaves)
        count += 1  # NEW actual14-root/four-file license baseline; not fresh archive proof
        def exact_license_refusal(reason, expected_gate_override=None):
            nonlocal count
            with patch.object(D.subprocess, "Popen", side_effect=AssertionError("tool entry after license refusal")) as popen, \
                 patch.object(licensing, "command", side_effect=AssertionError("command after license refusal")) as command:
                try:
                    licensing.licenses(license_tool)
                except D.Refused as error:
                    assert str(error) == reason
                    licensing.failed = True
                    failure_gate = dict(licensing.license_gate)
                    licensing.cleanup()  # actual cleanup must preserve first failure evidence
                    saved = json.loads((licensing.receipts / "attempt.json").read_text())
                    assert saved["licenseGate"] == licensing.license_gate
                    if expected_gate_override is not None:
                        expected_gate = expected_gate_override
                    elif reason == "exact reviewed tool input roots":
                        expected_gate = dict(stage="ROOT_SCOPE", path=None)
                    elif reason == "actual bundled Clang-header notice applicability":
                        expected_gate = dict(stage="CLANG_HEADER_NOTICE", path="lib/include/stddef.h")
                    else:
                        expected_gate = dict(stage="DECLARED_ROOT" if reason.startswith("declared tool input ")
                            else "REQUIRED_HEADER" if reason.startswith("required bundled header unavailable:")
                            else "INPUT_INVENTORY", path=reason.split(": ", 1)[1])
                    assert saved["licenseGate"] == expected_gate
                    assert saved["licenseGate"] == failure_gate
                    assert saved["status"] == "FAILED_OR_INCOMPLETE"
                else:
                    raise AssertionError("actual license refusal missing: " + reason)
                popen.assert_not_called()
                command.assert_not_called()
            count += 1

        # Additional ordinary publisher leaf: missing, directory and symlink.
        ubsan = license_tool / "lib/ubsan_rt.zig"
        saved_ubsan = ubsan.read_bytes()
        ubsan.unlink()
        exact_license_refusal("declared tool input missing: lib/ubsan_rt.zig")
        ubsan.mkdir()
        exact_license_refusal("declared tool input kind mismatch: lib/ubsan_rt.zig")
        ubsan.rmdir()
        ubsan.symlink_to(license_tool / "zig")
        exact_license_refusal("declared tool input symlink refused: lib/ubsan_rt.zig")
        ubsan.unlink()
        ubsan.write_bytes(saved_ubsan)

        # NEW C ordinary-file root: preserve the three original UBSan cases above.
        c_zig = license_tool / "lib/c.zig"
        saved_c_zig = c_zig.read_bytes()
        c_zig.unlink()
        exact_license_refusal("declared tool input missing: lib/c.zig")
        c_zig.mkdir()
        exact_license_refusal("declared tool input kind mismatch: lib/c.zig")
        c_zig.rmdir()
        c_zig.symlink_to(license_tool / "zig")
        exact_license_refusal("declared tool input symlink refused: lib/c.zig")
        c_zig.unlink()
        c_zig.write_bytes(saved_c_zig)
        # NEW C directory root: actual missing/file/symlink at the genuine gate.
        c_directory = license_tool / "lib/c"
        saved_c_children = {path.name: path.read_bytes() for path in c_directory.iterdir()}
        assert len(saved_c_children) == 5
        for name in saved_c_children:
            (c_directory / name).unlink()
        c_directory.rmdir()
        exact_license_refusal("declared tool input missing: lib/c")
        c_directory.write_text("synthetic wrong directory-root kind\n")
        exact_license_refusal("declared tool input kind mismatch: lib/c")
        c_directory.unlink()
        c_directory.symlink_to(license_tool / "lib/std", target_is_directory=True)
        exact_license_refusal("declared tool input symlink refused: lib/c")
        c_directory.unlink()
        c_directory.mkdir()
        for name, payload in saved_c_children.items():
            (c_directory / name).write_bytes(payload)

        # Actual absent root/header refusals, not a self-populated success only.
        saved_arch = {name: (license_tool / name).read_bytes() for name in arch_headers}
        for name in arch_headers:
            (license_tool / name).unlink()
        (license_tool / arch_root / "asm").rmdir()
        (license_tool / arch_root).rmdir()
        old_root = license_tool / "lib/libc/include/x86_64-linux-any"
        old_root.mkdir()
        exact_license_refusal("declared tool input missing: " + arch_root)
        old_root.rmdir()
        (license_tool / arch_root / "asm").mkdir(parents=True)
        for name, data in saved_arch.items():
            (license_tool / name).write_bytes(data)
        for name in sorted(expected_headers):
            saved = (license_tool / name).read_bytes()
            (license_tool / name).unlink()
            exact_license_refusal("actual bundled Clang-header notice applicability" if name == "lib/include/stddef.h"
                                  else "required bundled header unavailable: " + name)
            (license_tool / name).write_bytes(saved)
        root = license_tool / arch_root
        held = root.with_name("x86-linux-any-held")
        root.rename(held)
        root.write_text("wrong root kind\n")
        exact_license_refusal("declared tool input kind mismatch: " + arch_root)
        root.unlink()
        root.symlink_to(held, target_is_directory=True)
        exact_license_refusal("declared tool input symlink refused: " + arch_root)
        root.unlink()
        held.rename(root)
        file_root = license_tool / "zig"
        saved = file_root.read_bytes()
        file_root.unlink()
        file_root.mkdir()
        exact_license_refusal("declared tool input kind mismatch: zig")
        file_root.rmdir()
        file_root.write_bytes(saved)
        scope_path = license_packet / "license-scope.json"
        scope_bytes = scope_path.read_bytes()
        wrong_scope = json.loads(scope_bytes)
        next(r for r in wrong_scope["roots"] if r["path"] == arch_root)["path"] = "lib/libc/include/x86_64-linux-any"
        scope_path.write_text(json.dumps(wrong_scope))
        exact_license_refusal("exact reviewed tool input roots")
        scope_path.write_bytes(scope_bytes)
        uapi = license_tool / arch_headers[0]
        saved = uapi.read_bytes()
        uapi.write_text("/* SPDX-License-Identifier: GPL-2.0-only */\n")
        def expression_gate(path, expression, policy_reason=None, complete=True):
            relative = path.relative_to(license_tool).as_posix()
            matching = [r for r in scope["roots"] if relative == r["path"] or relative.startswith(r["path"] + "/")]
            assert len(matching) == 1
            row = matching[0]
            file_data = path.read_bytes()
            raw = expression if isinstance(expression, bytes) else expression.encode()
            try:
                decoded, valid = raw.decode("utf-8", errors="strict"), True
            except UnicodeDecodeError:
                decoded, valid = None, False
            gate = dict(stage="SPDX_EXPRESSION", path=relative, fileBytes=len(file_data),
                fileSha256=hashlib.sha256(file_data).hexdigest(), component=row["component"], root=row["path"],
                expressionBytes=len(raw) if complete else None, expressionCharacters=len(decoded) if complete and valid else None,
                observedExpressionBytes=len(raw), expressionComplete=complete, expressionEncodingValid=valid if complete else None,
                expressionBytesExact=complete and len(raw) <= 512,
                expressionSha256=hashlib.sha256(raw).hexdigest() if complete else None,
                expressionExact=complete and valid and len(raw) <= 512)
            if complete and len(raw) <= 512:
                gate["expressionHex"] = raw.hex()
                if valid:
                    gate["expression"] = decoded
            else:
                gate["expressionPrefixHex"] = raw[:256].hex()
                if not complete:
                    gate["expressionFragmentSha256"] = hashlib.sha256(raw).hexdigest()
                    gate["expressionFragmentEncodingValid"] = valid
            if policy_reason is not None:
                gate["policyReason"] = policy_reason
            return gate
        exact_license_refusal("unreviewed tool input SPDX: " + arch_headers[0],
            expression_gate(uapi, "GPL-2.0-only ", "SPDX identifier policy"))
        uapi.write_bytes(saved)
        # Literal independent policy matrix: no global permissive-branch
        # shortcut, and no Linux exception admitted through a component label.
        old_forms = ["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "(Apache-2.0 WITH LLVM-exception)",
            "BSD-2-Clause", "BSD-3-Clause", "ISC", "GPL-2.0 WITH Linux-syscall-note", "GPL-2.0+ WITH Linux-syscall-note",
            "GPL-2.0-only WITH Linux-syscall-note", "GPL-2.0-or-later WITH Linux-syscall-note",
            "(GPL-2.0 WITH Linux-syscall-note) OR MIT", "((GPL-2.0 WITH Linux-syscall-note) OR BSD-3-Clause)",
            "((GPL-2.0 WITH Linux-syscall-note) OR BSD-2-Clause)", "GPL-2.0 WITH Linux-syscall-note OR BSD-2-Clause"]
        assert scope["previousExplicitSpdxRegressionForms"] == old_forms
        assert scope["spdxCompositionPolicy"] == dict(maxCharacters=512, maxBytes=512, maxTokens=256, maxNodes=128, maxDepth=16,
            nodeAccounting="one per licensed atom, binary operator and parenthesis group",
            compositionRoots=["lib/libc/include/any-linux-any", "lib/libc/include/x86-linux-any"],
            everyAlternativeRequired=True, canonicalCaseOnly=True, evidenceMaximumBytes=8192)
        count += 1
        tagged = "(GPL-2.0-only WITH Linux-syscall-note) OR MIT"
        positives = old_forms + [tagged, "MIT OR (GPL-2.0-only WITH Linux-syscall-note)",
            "((MIT OR BSD-2-Clause) AND (ISC OR Apache-2.0))", "MIT AND BSD-3-Clause OR ISC",
            "MIT OR BSD-3-Clause AND ISC", "\tMIT \t", "(" * 16 + "MIT" + ")" * 16,
            "MIT" + " " * 509, "(" + " AND ".join(["MIT"] * 64) + ")"]
        assert len(positives[-2]) == 512 and len(positives[-1]) == 509
        for root_name in ("lib/libc/include/any-linux-any", "lib/libc/include/x86-linux-any"):
            for expression in positives:
                assert D.spdx_terms(expression, "Linux-UAPI", root_name)
                count += 1
        for expression in old_forms[:7]:
            assert D.spdx_terms(expression, "Clang-headers", "lib/include")
            count += 1
        invalid = ["MIT OR AGPL-3.0-only", "MIT AND LicenseRef-Unknown", "MIT OR MIT OR Unknown",
            "GPL-2.0-only", "GPL-3.0-only WITH Linux-syscall-note", "LGPL-2.1-only", "AGPL-3.0-only",
            "GPL-2.0-only WITH LLVM-exception", "MIT WITH Linux-syscall-note", "Apache-2.0 WITH Unknown",
            "LicenseRef-Local", "DocumentRef-Other:MIT", "MIT OR", "MIT AND AND MIT", "OR MIT", "MIT MIT",
            "()", "(MIT", "MIT)", "MIT AND ()", "(MIT OR ISC) WITH Linux-syscall-note", "MIT WITH",
            "GPL-2.0 + WITH Linux-syscall-note", "MIT * discarded text", "MIT /* ignored? */", "MIT # trailing",
            "mit", "MIT or ISC", "MIT\nOR ISC", "MIT\r", "MIT\0", "M\u0130T", "MIT\x7f", "MIT\v",
            "(" * 17 + "MIT" + ")" * 17, "MIT" + " " * 510,
            "((" + " AND ".join(["MIT"] * 64) + "))", ")" * 257, ""]
        assert len(invalid[-3]) == 511  # 129 nodes, within the character ceiling
        for expression in invalid:
            deny(lambda expression=expression: D.spdx_terms(expression, "Linux-UAPI", "lib/libc/include/any-linux-any"))
        for base_name in ("GPL-2.0", "GPL-2.0+", "GPL-2.0-only", "GPL-2.0-or-later"):
            expression = base_name + " WITH Linux-syscall-note"
            for component, root_name in (("Linux-UAPI", "lib/include"), ("Clang-headers", "lib/libc/include/any-linux-any"),
                                         ("Linux-UAPI", "lib/libc/include/any-linux-any-extra")):
                deny(lambda expression=expression, component=component, root_name=root_name:
                     D.spdx_terms(expression, component, root_name))
        deny(lambda: D.spdx_terms("MIT AND ISC", "musl", "lib/libc/musl"))
        count += 1
        # Real component gate: exact expressions/hashes persisted before refusal,
        # and through the actual cleanup. No candidate binary or command entry.
        extra = license_tool / "lib/libc/include/any-linux-any/drm/pvr_drm.h"
        extra.parent.mkdir()
        extra.write_text("/* SPDX-License-Identifier: " + tagged + " */\n/* retained synthetic notice */\n")
        with patch.object(D.subprocess, "Popen", side_effect=AssertionError("unexpected license process")) as popen, \
             patch.object(licensing, "command", side_effect=AssertionError("unexpected license command")) as command:
            recorded = licensing.licenses(license_tool)[extra.relative_to(license_tool).as_posix()]
            assert recorded["licenseExpressions"] == [tagged + " "]
            assert recorded["sha256"] == hashlib.sha256(extra.read_bytes()).hexdigest()
            popen.assert_not_called()
            command.assert_not_called()
        count += 1
        for expression, reason in (("MIT OR AGPL-3.0-only", "SPDX identifier policy"),
                ("MIT * retained-invalid-tail", "SPDX token policy"), ("MIT OR", "SPDX missing operand"),
                ("MIT" + " " * 510, "SPDX character/length policy"), ("M\u0130T", "SPDX character/length policy")):
            extra.write_text("// SPDX-License-Identifier: " + expression + "\n", encoding="utf-8")
            exact_license_refusal("unreviewed tool input SPDX: " + extra.relative_to(license_tool).as_posix(),
                expression_gate(extra, expression, reason))
        # A marker at the bounded prefix edge is never accepted as a complete
        # short identifier when later source bytes might alter its expression.
        marker = "// SPDX-License-Identifier: MIT"
        extra.write_text(" " * (16384 - len(marker)) + marker + " OR AGPL-3.0-only\n")
        exact_license_refusal("truncated tool input SPDX: " + extra.relative_to(license_tool).as_posix(),
            expression_gate(extra, "MIT", complete=False))
        extra.write_bytes(b"// SPDX-License-Identifier: MIT\xff\n")
        exact_license_refusal("unreviewed tool input SPDX: " + extra.relative_to(license_tool).as_posix(),
            expression_gate(extra, b"MIT\xff", "SPDX expression encoding policy"))
        for framing in (b"// SPDX-License-Identifier: MIT */\n", b"SPDX-License-Identifier: MIT */\n",
                        b"// /* not a block\n// SPDX-License-Identifier: MIT */\n",
                        b'const char *s = "/*";\n// SPDX-License-Identifier: MIT */\n'):
            extra.write_bytes(framing)
            exact_license_refusal("unreviewed tool input SPDX: " + extra.relative_to(license_tool).as_posix(),
                expression_gate(extra, "MIT */", "SPDX token policy"))
        for framing in (b"// SPDX-License-Identifier: MIT\n", b"/* SPDX-License-Identifier: MIT */\n",
                        b"/*\n * SPDX-License-Identifier: MIT */\n"):
            extra.write_bytes(framing)
            with patch.object(D.subprocess, "Popen", side_effect=AssertionError("unexpected license process")) as popen, \
                 patch.object(licensing, "command", side_effect=AssertionError("unexpected license command")) as command:
                recorded = licensing.licenses(license_tool)[extra.relative_to(license_tool).as_posix()]
                assert recorded["licenseExpressions"] == ["MIT" if framing.startswith(b"//") else "MIT "]
                popen.assert_not_called()
                command.assert_not_called()
            count += 1
        for title in ("GNU LESSER PUBLIC LICENSE", "GNU LESSER GENERAL PUBLIC LICENSE", "GNU LIBRARY GENERAL PUBLIC LICENSE",
                      "GNU\nLESSER\tGENERAL PUBLIC\nLICENSE", "GNU\tLIBRARY GENERAL\nPUBLIC LICENSE"):
            extra.write_text("/* SPDX-License-Identifier: " + tagged + " */\n" + title + "\n")
            exact_license_refusal("unexcepted GPL/LGPL input", expression_gate(extra, tagged + " "))
        for text, reason, expression in (("/* SPDX-License-Identifier: " + tagged + " */\nGNU Affero General Public License\n", "contrary/unclassified input notice", tagged + " "),
            ("// SPDX-License-Identifier: MIT\nGNU GENERAL PUBLIC LICENSE\n", "unexcepted GPL/LGPL input", "MIT"),
            ("// SPDX-License-Identifier: MIT\nGNU\tGENERAL\nPUBLIC LICENSE\n", "unexcepted GPL/LGPL input", "MIT")):
            extra.write_text(text)
            exact_license_refusal(reason, expression_gate(extra, expression))
        extra.unlink()
        extra.parent.rmdir()
        notice = license_packet / "LLVM-LICENSE.txt"
        notice_data = notice.read_bytes()
        notice.unlink()
        deny(lambda: licensing.licenses(license_tool))
        notice.write_bytes(notice_data)
        contrary = license_tool / "lib/std/contrary.zig"
        for text in ("// proprietary license; may not redistribute\n", "// licensed under an unknown license\n",
                     "// SPDX-License-Identifier: LicenseRef-Unknown\n"):
            contrary.write_text(text)
            deny(lambda: licensing.licenses(license_tool))
        contrary.unlink()
        header.write_text("// missing required LLVM notice\n")
        deny(lambda: licensing.licenses(license_tool))
        for fault in ("inspection-failed", "inspection-timeout", "inspection-overflow"):
            inspection = D.Attempt(Path(__file__).parent, parent / fault)
            with patch.object(inspection, "command", return_value=(False, b"bounded modeled inspection refusal")), \
                 patch.object(inspection, "create", side_effect=AssertionError("model acquisition after refused inspection")) as create:
                deny(lambda: inspection.inspect_then_models(parent))
                create.assert_not_called()
                count += 1
        final = D.Attempt(Path(__file__).parent, parent / "final-census-failure")
        final.models_passed = True
        final.containers.append(dict(name="model", id=admitted, createAttempted=True, removeAttempted=True, removed=True))
        with patch.object(D.subprocess, "Popen") as popen, \
             patch.object(D.selectors, "DefaultSelector", side_effect=RuntimeError("injected census selector failure")), \
             patch.object(D.os, "killpg") as kill:
            process = popen.return_value
            process.pid, process.returncode = 678, None
            process.poll.return_value = None
            final.cleanup()
            saved = json.loads((final.receipts / "attempt.json").read_text())
            assert not final.success and saved["status"] == "FAILED_OR_INCOMPLETE" and final.failed
            assert any(r["id"] == "census-exception" for r in final.events)
            assert any(r["id"] == "final-container-census" and r["status"] == "DRIVER_EXCEPTION" for r in final.events)
            kill.assert_called_once_with(678, D.signal.SIGKILL)
            process.wait.assert_called_once()
            count += 1
        for fault in ("healthy", "timeout", "output-limit"):
            modeled = D.Attempt(Path(__file__).parent, parent / ("command-" + fault))
            with patch.object(D.subprocess, "Popen") as popen, \
                 patch.object(D.selectors, "DefaultSelector") as select, \
                 patch.object(D.os, "read") as read, patch.object(D.os, "killpg") as kill:
                process, selector = popen.return_value, select.return_value
                process.pid, process.returncode = 456, (0 if fault == "healthy" else -9)
                process.poll.return_value = process.returncode
                selector.select.return_value = [(SimpleNamespace(fileobj=process.stdout), None)]
                selector.get_map.side_effect = [{1: 1}, {1: 1}, {}] if fault == "healthy" else None
                selector.get_map.return_value = {1: 1}
                read.side_effect = [b"ok\n", b""] if fault == "healthy" else None
                read.return_value = b"x" * 65536
                if fault == "timeout":
                    tick = [modeled.started]
                    def advance():
                        tick[0] += 1
                        return tick[0]
                    with patch.object(D.time, "monotonic", side_effect=advance):
                        ok, output = modeled.command("once", ["mock-only"], 0.5)
                else:
                    ok, output = modeled.command("once", ["mock-only"], 5)
                expected = {"healthy": "PASSED", "timeout": "TIMEOUT", "output-limit": "OUTPUT_LIMIT"}[fault]
                assert modeled.events[0]["status"] == expected and ok == (fault == "healthy")
                assert len(output) <= D.LIMIT and process.wait.call_count == 1
                assert kill.call_count == (0 if fault == "healthy" else 1)
                count += 1
        # Actual inherited Python parent capture body; all process edges supplied.
        # The Node producer tests do not supply this evidence.
        for capture_fault in ("exact", "plus-one"):
            modeled = D.Attempt(Path(__file__).parent, parent / ("capture-boundary-" + capture_fault))
            payload = b"C" * 1048576
            blocks = [payload[offset:offset + 65536] for offset in range(0, len(payload), 65536)]
            blocks += [b""] if capture_fault == "exact" else [b"Z"]
            reads, selected, captured, killed = [], [], [], []
            frozen_tick = modeled.started + 1

            def retain(status, returncode, output):
                captured.append((status, returncode, output))

            with patch.object(D.subprocess, "Popen") as popen, \
                 patch.object(D.selectors, "DefaultSelector") as select, \
                 patch.object(D.os, "read") as read, patch.object(D.os, "killpg") as kill, \
                 patch.object(D.time, "monotonic", return_value=frozen_tick):
                process, selector = popen.return_value, select.return_value
                process.pid, process.returncode = 456, 0
                process.stdout.fileno.return_value = 43
                process.poll.side_effect = lambda: process.returncode
                selector.get_map.side_effect = lambda: {1: 1} if len(reads) < len(blocks) else {}

                def select_ready(timeout):
                    selected.append(timeout)
                    return [(SimpleNamespace(fileobj=process.stdout), D.selectors.EVENT_READ)]

                def raw_read(descriptor, maximum):
                    reads.append((descriptor, maximum))  # entry before supplied result
                    assert descriptor == 43 and maximum == 65536
                    return blocks[len(reads) - 1]

                def kill_group(pid, sig):
                    killed.append((pid, sig))
                    process.returncode = -9

                selector.select.side_effect = select_ready
                read.side_effect = raw_read
                kill.side_effect = kill_group
                ok, output = modeled.command("capture-boundary", ["supplied-output-only"], 5, capture_result=retain)
                call = popen.call_args
                assert call.args == (["supplied-output-only"],)
                assert call.kwargs == dict(stdin=D.subprocess.DEVNULL, stdout=D.subprocess.PIPE,
                    stderr=D.subprocess.STDOUT, env={"PATH": "/usr/bin:/bin", "HOME": str(modeled.fixture),
                    "LANG": "C", "LC_ALL": "C"}, start_new_session=True)
                assert popen.call_count == 1 and selector.register.call_count == 1
                selector.register.assert_called_once_with(process.stdout, D.selectors.EVENT_READ)
                assert read.call_count == len(reads) == len(selected) == 17
                assert reads == [(43, 65536)] * 17
                assert selector.unregister.call_count == (1 if capture_fault == "exact" else 0)
                if capture_fault == "exact":
                    selector.unregister.assert_called_once_with(process.stdout)
                selector.close.assert_called_once_with()
                process.stdout.close.assert_called_once_with()
                process.wait.assert_called_once()
                if capture_fault == "exact":
                    kill.assert_not_called()
                else:
                    kill.assert_called_once_with(456, D.signal.SIGKILL)
            status, rc = ("PASSED", 0) if capture_fault == "exact" else ("OUTPUT_LIMIT", -9)
            assert ok is (capture_fault == "exact") and output == payload
            assert captured == [(status, rc, payload)]
            assert killed == ([] if capture_fault == "exact" else [(456, D.signal.SIGKILL)])
            assert modeled.log_bytes == len(payload) == D.LIMIT == 1048576
            row = next(event for event in modeled.events if event["id"] == "capture-boundary")
            assert row["status"] == status and row["returncode"] == rc
            assert row["outputBytes"] == len(payload) and row["outputSha256"] == hashlib.sha256(payload).hexdigest()
            assert row["seconds"] == 5 and row["elapsedSeconds"] == 0
            assert (modeled.receipts / "capture-boundary.txt").read_bytes() == payload
            saved = json.loads((modeled.receipts / "attempt.json").read_bytes())
            assert next(event for event in saved["events"] if event["id"] == "capture-boundary") == row
            assert modeled.receipt_bytes == sum(path.stat().st_size for path in modeled.receipts.iterdir())
            assert len(modeled.events) == 1 and not modeled.success
            count += 1

        # No helper may emit a model invocation as its build-container command.
        assert set(D.LINKS) == {"policy", "installer", "state"} and all("observer" not in v for v in D.LINKS.values())
        assert len(D.UNITS) == 6 and len(D.WRAPS) == 12 and "-nostdinc" in D.INCLUDES
        count += 1
    print("Driver modeled controls passed: " + str(count) + "; network/process/container calls: 0")
    return count


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("one owned fixture directory required")
    run(sys.argv[1])
