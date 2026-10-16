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
        license_tool = parent / "license-tool"
        license_tool.mkdir()
        for row in scope["roots"]:
            path = license_tool / row["path"]
            if row["path"] == "zig" or row["path"].endswith(".zig"):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("// original publisher source; no contrary file terms\n")
            else:
                path.mkdir(parents=True, exist_ok=True)
        header = license_tool / "lib/include/stddef.h"
        header.write_text("// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception\n")
        for relative in scope["requiredHeaders"]:
            path = license_tool / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("/* SPDX-License-Identifier: GPL-2.0 WITH Linux-syscall-note */\n")
        licensing = D.Attempt(license_packet, parent / "licensing")
        records = licensing.licenses(license_tool)
        assert records["zig"]["licenseSource"] == "reviewed-authenticated-publisher-root"
        assert records[scope["requiredHeaders"][0]]["licenseExpressions"] == ["GPL-2.0 WITH Linux-syscall-note "]
        count += 1
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
