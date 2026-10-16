"""Inventory-only first-party controls. External execution/network edges denied."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("fixed_inventory", Path(__file__).with_name("inventory_driver.py"))
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)


def run(owned):
    count = 0
    roots = {"zig", "lib/std", "lib/compiler", "lib/compiler_rt", "lib/compiler_rt.zig", "lib/include", "lib/libc/musl",
        "lib/libc/include/generic-musl", "lib/libc/include/x86_64-linux-musl", "lib/libc/include/any-linux-any", "lib/libc/include/x86-linux-any"}
    groups = {
        "lib/include/": ("limits.h", "stdarg.h", "stddef.h", "stdint.h"),
        "lib/libc/include/generic-musl/": ("dirent.h", "errno.h", "fcntl.h", "limits.h", "signal.h", "stdint.h", "stdio.h", "string.h", "sys/prctl.h", "sys/resource.h", "sys/stat.h", "sys/syscall.h", "sys/vfs.h", "sys/wait.h", "time.h", "unistd.h"),
        "lib/libc/include/x86_64-linux-musl/": ("bits/alltypes.h", "bits/syscall.h"),
        "lib/libc/include/any-linux-any/": ("linux/filter.h", "linux/seccomp.h", "linux/audit.h", "linux/close_range.h", "linux/magic.h", "linux/ptrace.h", "linux/sched.h", "linux/types.h", "linux/bpf_common.h", "linux/elf-em.h", "linux/posix_types.h", "linux/stddef.h", "linux/const.h", "asm/types.h", "asm-generic/types.h", "asm-generic/int-ll64.h", "asm-generic/posix_types.h", "asm-generic/bitsperlong.h"),
        "lib/libc/include/x86-linux-any/": ("asm/bitsperlong.h", "asm/posix_types.h", "asm/posix_types_64.h", "asm/ptrace.h", "asm/ptrace-abi.h", "asm/processor-flags.h")}
    required = {prefix + name for prefix, names in groups.items() for name in names}
    assert len(roots) == 11 and len(required) == 46
    count += 1
    for raw in (b"MIT", b"LGPL-2.1 WITH Linux-syscall-note ", b"MIT OR AGPL-3.0-only", b"LicenseRef-Unknown",
                b"DocumentRef-X:LicenseRef-Y", b"(MIT AND BSD-2-Clause) OR ISC", b"MIT" + b" " * 509,
                b"(" * 16 + b"MIT" + b")" * 16, b"(" + b" AND ".join([b"MIT"] * 64) + b")"):
        text, atoms = I.syntax_atoms(raw)
        assert text.encode() == raw and atoms
        count += 1
    for raw in (b"MIT OR", b"MIT * ignored", b"()", b"MIT MIT", b"(MIT", b"MIT)", b"MIT AND AND ISC",
                b"(MIT OR ISC) WITH Linux-syscall-note", b"MIT WITH", b"MIT\xff", b"M\xc4\xb0T", b"MIT\n",
                b"MIT" + b" " * 510, b"(" * 17 + b"MIT" + b")" * 17,
                b"((" + b" AND ".join([b"MIT"] * 64) + b"))", b")" * 257, b""):
        try:
            I.syntax_atoms(raw)
        except I.D.Refused:
            count += 1
        else:
            raise AssertionError("malformed/bounded inventory syntax admitted")
    with patch.dict(os.environ, {"GITHUB_RUN_ID": "321", "GITHUB_RUN_ATTEMPT": "1"}), \
         tempfile.TemporaryDirectory(prefix="inventory-controls-", dir=owned) as temporary, \
         patch.object(I.D.subprocess, "Popen", side_effect=AssertionError("inventory process entry")) as popen, \
         patch.object(I.D.urllib.request, "build_opener", side_effect=AssertionError("inventory network entry")) as network:
        parent = Path(temporary)
        packet, tool = parent / "packet", parent / "tool"
        packet.mkdir()
        tool.mkdir()
        for name in ("license-scope.json", "LLVM-LICENSE.txt"):
            (packet / name).write_bytes(Path(__file__).with_name(name).read_bytes())
        scope = json.loads((packet / "license-scope.json").read_text())
        assert {r["path"] for r in scope["roots"]} == roots and set(scope["requiredHeaders"]) == required
        count += 1
        for relative in sorted(roots):
            path = tool / relative
            if relative in {"zig", "lib/compiler_rt.zig"}:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"original synthetic nonexecutable publisher input\n")
            else:
                path.mkdir(parents=True, exist_ok=True)
        for relative in sorted(required):
            path = tool / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            expression = b"Apache-2.0 WITH LLVM-exception" if relative.startswith("lib/include/") else \
                b"GPL-2.0 WITH Linux-syscall-note" if "/any-linux-any/" in relative or "/x86-linux-any/" in relative else b"MIT"
            path.write_bytes(b"/* SPDX-License-Identifier: " + expression + b" */\n")

        def scanned(name):
            owner = I.InventoryAttempt(packet, parent / name)
            owner.inventory(tool)
            owner.cleanup()
            owner.finalize()
            receipt = json.loads((owner.receipts / "attempt.json").read_text())
            data = (owner.receipts / "inventory-files.txt").read_bytes()
            rows = [json.loads(line) for line in data.splitlines()]
            assert receipt["inventoryComplete"] and not receipt["licenseGatePassed"] and not receipt["compilerInvoked"]
            assert not receipt["modelsPassed"] and receipt["containerCustody"] == [] and receipt["inventoryOnly"]
            assert receipt["inventoryRecords"] == len(rows) and receipt["inventoryBytes"] == len(data)
            assert receipt["inventorySha256"] == hashlib.sha256(data).hexdigest()
            return receipt, {r["path"]: r for r in rows}

        receipt, rows = scanned("healthy")
        assert receipt["status"] == "INVENTORY_ONLY_COMPLETE_NO_ADMISSION" and receipt["unresolvedFiles"] == 0
        assert required.issubset(rows)
        count += 1
        cgroup = tool / "lib/libc/include/any-linux-any/linux/cgroupstats.h"
        unknown = tool / "lib/include/unknown.h"
        alternative = tool / "lib/libc/include/any-linux-any/linux/unknown.h"
        later = tool / "lib/std/zz-after.zig"
        cgroup.write_bytes(b"/* SPDX-License-Identifier: LGPL-2.1 WITH Linux-syscall-note */\nGNU Lesser General Public License\n")
        unknown.write_bytes(b"// SPDX-License-Identifier: LicenseRef-Unknown\n")
        alternative.write_bytes(b"// SPDX-License-Identifier: MIT OR AGPL-3.0-only\n")
        later.write_bytes(b"// SPDX-License-Identifier: MIT\n")
        receipt, rows = scanned("unresolved")
        assert receipt["status"] == "INVENTORY_ONLY_COMPLETE_WITH_UNRESOLVED" and receipt["unresolvedFiles"] == 3
        assert receipt["unresolvedExpressions"] == 3 and "lib/std/zz-after.zig" in rows
        observation = rows[cgroup.relative_to(tool).as_posix()]
        assert observation["fileSha256"] == hashlib.sha256(cgroup.read_bytes()).hexdigest()
        expression = observation["expressions"][0]
        assert expression["expression"] == "LGPL-2.1 WITH Linux-syscall-note " and expression["policyObservation"] == "UNRESOLVED"
        assert expression["expressionSha256"] == hashlib.sha256(b"LGPL-2.1 WITH Linux-syscall-note ").hexdigest()
        count += 1
        bad = tool / "lib/include/aa-malformed.h"
        for index, raw in enumerate((b"MIT OR", b"MIT\xff", b"MIT */", b"MIT" + b" " * 510)):
            bad.write_bytes(b"// SPDX-License-Identifier: " + raw + b"\n")
            owner = I.InventoryAttempt(packet, parent / ("bad-" + str(index)))
            try:
                owner.inventory(tool)
            except I.D.Refused:
                owner.failed = True
                before = dict(owner.license_gate)
                owner.cleanup()
                receipt = json.loads((owner.receipts / "attempt.json").read_text())
                assert receipt["status"] == "INVENTORY_ONLY_FAILED_OR_INCOMPLETE" and not receipt["inventoryComplete"]
                assert receipt["licenseGate"] == before and before["stage"] == "INVENTORY_EXPRESSION"
                assert before["fileSha256"] == hashlib.sha256(bad.read_bytes()).hexdigest()
                assert before["expressionSha256"] == hashlib.sha256(raw).hexdigest()
                assert (owner.receipts / "inventory-files.txt").is_file()  # prior/partial evidence retained
                count += 1
            else:
                raise AssertionError("malformed inventory did not stop")
        bad.unlink()
        sentinel = tool / "lib/libc/include/x86-linux-any/asm/ptrace.h"
        saved = sentinel.read_bytes()
        sentinel.unlink()
        missing = I.InventoryAttempt(packet, parent / "missing-sentinel")
        try:
            missing.inventory(tool)
        except I.D.Refused as error:
            assert str(error) == "inventory required 46 headers"
            missing.failed = True
            missing.cleanup()
            assert not missing.inventory_complete and missing.license_gate["stage"] == "INVENTORY_SENTINELS"
            count += 1
        else:
            raise AssertionError("required inventory sentinel missing")
        sentinel.write_bytes(saved)
        root = tool / "lib/compiler"
        root.rmdir()
        root.write_bytes(b"not a directory")
        wrong_kind = I.InventoryAttempt(packet, parent / "wrong-kind")
        try:
            wrong_kind.inventory(tool)
        except I.D.Refused as error:
            assert str(error) == "inventory mandatory root kind/absence"
            wrong_kind.failed = True
            wrong_kind.cleanup()
            assert wrong_kind.license_gate == dict(stage="INVENTORY_ROOT", path="lib/compiler")
            count += 1
        else:
            raise AssertionError("wrong root kind accepted")
        root.unlink()
        root.mkdir()
        bad.write_bytes(b"// SPDX-License-Identifier: MIT\n" * 17)
        too_many = I.InventoryAttempt(packet, parent / "too-many-annotations")
        try:
            too_many.inventory(tool)
        except I.D.Refused as error:
            assert str(error) == "inventory per-file SPDX count"
            too_many.failed = True
            too_many.cleanup()
            assert not too_many.inventory_complete
            count += 1
        else:
            raise AssertionError("per-file annotation budget ignored")
        bad.unlink()
        actual_open = Path.open
        for fault in ("short", "partial-throw"):
            owner = I.InventoryAttempt(packet, parent / ("write-" + fault))
            class FaultyOutput:
                def __init__(self, handle):
                    self.handle = handle
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    self.handle.close()
                def write(self, payload):
                    if fault == "partial-throw":
                        self.handle.write(payload[:1])
                        raise OSError("injected after one retained byte")
                    return 0
            def fault_open(path, *args, **kwargs):
                handle = actual_open(path, *args, **kwargs)
                return FaultyOutput(handle) if path == owner.receipts / "inventory-files.txt" else handle
            with patch.object(Path, "open", fault_open):
                before = owner.receipt_bytes
                try:
                    owner.inventory(tool)
                except (I.D.Refused, OSError):
                    assert owner.receipt_bytes > before and owner.inventory_records == 0 and not owner.inventory_complete
                    owner.failed = True
                    owner.cleanup()
                    receipt = json.loads((owner.receipts / "attempt.json").read_text())
                    assert receipt["status"] == "INVENTORY_ONLY_FAILED_OR_INCOMPLETE"
                    assert (owner.receipts / "inventory-files.txt").stat().st_size == (1 if fault == "partial-throw" else 0)
                    count += 1
                else:
                    raise AssertionError("inventory short/uncertain write accepted")
        # Advance the real owner clock at completed I/O boundaries, calling
        # actual inventory/cleanup/finalization. No fresh timeout is granted.
        actual_sha = I.D.sha
        for edge in ("last-input-hash", "record-write", "inventory-flush", "inventory-readback", "readiness-save", "cleanup-save", "terminal-save"):
            owner = I.InventoryAttempt(packet, parent / ("expiry-" + edge))
            tick = [owner.started]
            actual_save = owner.save
            def timed_sha(path):
                result = actual_sha(path)
                if (edge == "last-input-hash" and path == tool / "zig") or \
                   (edge == "inventory-readback" and path == owner.receipts / "inventory-files.txt"):
                    tick[0] = owner.deadline - 20
                return result
            phase = ["collect"]
            class FlushExpiry:
                def __init__(self, handle):
                    self.handle = handle
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    self.handle.close()
                def write(self, payload):
                    written = self.handle.write(payload)
                    if edge == "record-write":
                        tick[0] = owner.deadline - 20
                    return written
                def flush(self):
                    self.handle.flush()
                    if edge == "inventory-flush":
                        tick[0] = owner.deadline - 20
            def timed_open(path, *args, **kwargs):
                handle = actual_open(path, *args, **kwargs)
                return FlushExpiry(handle) if edge in {"record-write", "inventory-flush"} and \
                    path == owner.receipts / "inventory-files.txt" and args == ("xb",) else handle
            def timed_save():
                if (edge == "readiness-save" and owner.inventory_collected and phase[0] == "collect") or \
                   (edge == "cleanup-save" and phase[0] == "cleanup") or \
                   (edge == "terminal-save" and owner.inventory_complete):
                    tick[0] = owner.deadline
                actual_save()
            with patch.object(I.D.time, "monotonic", side_effect=lambda: tick[0]), \
                 patch.object(I.D, "sha", side_effect=timed_sha), patch.object(owner, "save", side_effect=timed_save), \
                 patch.object(Path, "open", timed_open):
                try:
                    owner.inventory(tool)
                    phase[0] = "cleanup"
                    owner.cleanup()
                    phase[0] = "terminal"
                    owner.finalize()
                except I.D.Refused as error:
                    assert str(error) == "research deadline"
                    if owner.finalization_attempted:
                        # Inspect product-owned poison and its terminal receipt
                        # BEFORE any test-side assignment or diagnostic write.
                        assert owner.failed and not owner.inventory_complete
                        receipt = json.loads((owner.receipts / "attempt.json").read_text())
                        assert any(event["id"] == "inventory-terminal-failure" for event in receipt["events"])
                    else:
                        # Model main's collection-error handler, which owns
                        # failure before terminal finalization has begun.
                        owner.failed = True
                        owner.inventory_complete = False
                        owner.cleanup()
                        receipt = json.loads((owner.receipts / "attempt.json").read_text())
                    assert receipt["status"] == "INVENTORY_ONLY_FAILED_OR_INCOMPLETE"
                    assert not receipt["inventoryComplete"] and not owner.success
                    assert receipt["elapsedSeconds"] >= 580
                    assert not receipt["compilerInvoked"] and not receipt["licenseGatePassed"]
                    count += 1
                else:
                    raise AssertionError("expired inventory finalized: " + edge)
        actual_write_bytes = Path.write_bytes
        for fault in ("short", "partial-throw", "complete-throw"):
            owner = I.InventoryAttempt(packet, parent / ("receipt-" + fault))
            target = owner.receipts / "probe.txt"
            def receipt_fault(path, payload):
                if path != target:
                    return actual_write_bytes(path, payload)
                written = actual_write_bytes(path, payload if fault == "complete-throw" else payload[:1])
                if fault != "short":
                    raise OSError("injected after actual receipt write")
                return written
            with patch.object(Path, "write_bytes", receipt_fault):
                try:
                    owner.write_receipt("probe.txt", b"abc")
                except (I.D.Refused, OSError):
                    assert owner.receipt_bytes == 3
                    assert target.read_bytes() == (b"abc" if fault == "complete-throw" else b"a")
                    owner.failed = True
                    owner.cleanup()
                    receipt = json.loads((owner.receipts / "attempt.json").read_text())
                    assert receipt["status"] == "INVENTORY_ONLY_FAILED_OR_INCOMPLETE"
                    assert owner.receipt_bytes >= target.stat().st_size + (owner.receipts / "attempt.json").stat().st_size
                    count += 1
                else:
                    raise AssertionError("short/uncertain receipt admitted")
        for logical in ("attempt.json", "driver-controls.txt", "tool-inventory.json"):
            for fault in ("short", "partial-throw"):
                owner = I.InventoryAttempt(packet, parent / ("logical-" + logical.replace(".", "-") + "-" + fault))
                target = owner.receipts / logical
                def logical_fault(path, payload):
                    if path != target:
                        return actual_write_bytes(path, payload)
                    written = actual_write_bytes(path, payload[:1])
                    if fault == "partial-throw":
                        raise OSError("injected actual logical receipt write")
                    return written
                with patch.object(Path, "write_bytes", logical_fault):
                    try:
                        if logical == "attempt.json":
                            owner.save()
                        elif logical == "driver-controls.txt":
                            with patch.object(I.D.subprocess, "Popen") as process_factory, \
                                 patch.object(I.D.selectors, "DefaultSelector") as select, \
                                 patch.object(I.D.os, "read", side_effect=[b"ok\n", b""]), \
                                 patch.object(I.D.os, "killpg") as kill:
                                process, selector = process_factory.return_value, select.return_value
                                process.pid, process.returncode = 987, 0
                                process.poll.return_value = 0
                                selector.get_map.side_effect = [{1: 1}, {1: 1}, {}]
                                selector.select.return_value = [(SimpleNamespace(fileobj=process.stdout), None)]
                                try:
                                    owner.command("driver-controls", [sys.executable, "-I", "-S", "-B",
                                        str(packet / "driver_controls.py"), str(owner.fixture)], 5)
                                finally:
                                    process_factory.assert_called_once()
                                    process.wait.assert_called_once()
                                    kill.assert_not_called()
                        else:
                            owner.write_receipt("tool-inventory.json", b'{"original":"bounded"}\n')
                    except (I.D.Refused, OSError):
                        assert logical in owner.receipt_uncertain and owner.receipt_uncertain[logical] > 1
                        retained_charge = owner.receipt_bytes
                        owner.failed = True
                        owner.cleanup()
                        diagnostic = owner.receipts / ("inventory-failure.json" if logical == "attempt.json" else "attempt.json")
                        saved = json.loads(diagnostic.read_text())
                        assert saved["status"] == "INVENTORY_ONLY_FAILED_OR_INCOMPLETE"
                        assert logical in saved["receiptUncertainties"] and target.stat().st_size == 1
                        assert owner.receipt_bytes >= retained_charge
                        with patch.object(Path, "write_bytes", side_effect=AssertionError("uncertain path rewritten")):
                            try:
                                owner.write_receipt(logical, b"replacement")
                            except I.D.Refused as error:
                                assert str(error) == "inventory uncertain receipt cannot be rewritten"
                            else:
                                raise AssertionError("uncertain logical receipt reused")
                        count += 1
                    else:
                        raise AssertionError("logical receipt uncertainty accepted")
        # Actual fixed main orchestration, with only its two process and archive
        # boundaries supplied. Fault originates inside production cleanup.
        outer_packet = Path(__file__).resolve().parent
        original_init, original_cleanup = I.InventoryAttempt.__init__, I.InventoryAttempt.cleanup
        for fault in ("short", "partial-throw", "complete-throw"):
            run_temp = parent / ("main-cleanup-" + fault)
            run_temp.mkdir()
            captured, cleanup_calls, commands, extraction_calls = [], [], [], []
            phase, fault_sizes, old_receipt_sizes = ["running"], [], []
            def capture_init(owner, *args):
                original_init(owner, *args)
                captured.append(owner)
            def supplied_command(owner, identity, argv, seconds, cleanup=False, capture_result=None):
                commands.append(identity)
                return True, (b"Driver modeled controls passed: 306; network/process/container calls: 0\n"
                    if identity == "driver-controls" else b"Inventory controls passed: 1; compiler/image/native calls: 0\n")
            def supplied_extract(owner):
                extraction_calls.append(1)
                owner.events.append(dict(id="modeled-extraction-boundary", status="SUPPLIED_SYNTHETIC_INPUT"))
                return tool
            def marked_cleanup(owner):
                cleanup_calls.append(1)
                old_receipt_sizes.append((owner.receipts / "attempt.json").stat().st_size)
                phase[0] = "cleanup"
                return original_cleanup(owner)
            def cleanup_receipt_fault(path, payload):
                if captured and phase[0] == "cleanup" and path == captured[0].receipts / "attempt.json":
                    fault_sizes.append(len(payload))
                    if len(fault_sizes) > 1:
                        raise AssertionError("observed repeated raw cleanup receipt write")
                    written = actual_write_bytes(path, payload if fault == "complete-throw" else payload[:1])
                    if fault != "short":
                        raise OSError("injected cleanup receipt uncertainty")
                    return written
                return actual_write_bytes(path, payload)
            environment = dict(GITHUB_WORKSPACE=str(outer_packet.parents[1]), RUNNER_TEMP=str(run_temp),
                GITHUB_REPOSITORY="APReddy-AutoBotz/Project-Delivery-Agent",
                GITHUB_REF="refs/heads/codex/native-inventory-research-v1", GITHUB_RUN_ID="654",
                GITHUB_RUN_ATTEMPT="1", GITHUB_SHA="f" * 40,
                PDAA_PACKET_SHA256=hashlib.sha256((outer_packet / "packet.json").read_bytes()).hexdigest())
            with patch.dict(os.environ, environment), patch.object(sys, "argv", [str(outer_packet / "inventory_driver.py"), str(outer_packet)]), \
                 patch.object(I.InventoryAttempt, "__init__", capture_init), \
                 patch.object(I.D.Attempt, "command", supplied_command), \
                 patch.object(I.InventoryAttempt, "download_extract", supplied_extract), \
                 patch.object(I.InventoryAttempt, "cleanup", marked_cleanup), \
                 patch.object(Path, "write_bytes", cleanup_receipt_fault):
                try:
                    I.main()
                except (I.D.Refused, OSError):
                    assert len(captured) == len(cleanup_calls) == len(extraction_calls) == len(fault_sizes) == len(old_receipt_sizes) == 1
                    assert commands == ["driver-controls", "inventory-controls"]
                    owner = captured[0]
                    assert owner.failed and not owner.inventory_complete and not owner.finalization_attempted
                    original = owner.receipts / "attempt.json"
                    assert original.stat().st_size == (fault_sizes[0] if fault == "complete-throw" else 1)
                    assert owner.receipt_uncertain["attempt.json"] == fault_sizes[0]
                    assert owner.receipt_verified["attempt.json"] == old_receipt_sizes[0] > 0
                    assert owner.receipt_bytes == owner.inventory_bytes + sum(owner.receipt_verified.values()) + sum(owner.receipt_uncertain.values())
                    diagnostic = json.loads((owner.receipts / "inventory-failure.json").read_text())
                    assert diagnostic["status"] == "INVENTORY_ONLY_FAILED_OR_INCOMPLETE"
                    assert diagnostic["receiptUncertainties"]["attempt.json"] == fault_sizes[0]
                    assert any(event["id"] == "inventory-cleanup-failure" for event in diagnostic["events"])
                    count += 1
                else:
                    raise AssertionError("cleanup-origin receipt failure escaped as success")
        blocked = I.InventoryAttempt(packet, parent / "blocked")
        for name in ("docker_base", "create", "remove", "build", "inspect_then_models"):
            try:
                getattr(blocked, name)("not admitted")
            except I.D.Refused:
                count += 1
            else:
                raise AssertionError("prohibited inventory capability returned")
        for identity, argv in (("image-pull", ["/usr/bin/docker", "pull"]),
                ("driver-controls", [sys.executable, "-I", "-S", "-B", "alternate.py", str(blocked.fixture)])):
            try:
                blocked.command(identity, argv, 5)
            except I.D.Refused:
                count += 1
            else:
                raise AssertionError("unreviewed inventory command")
        popen.assert_not_called()
        network.assert_not_called()
    print("Inventory controls passed: " + str(count) + "; compiler/image/native calls: 0")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("one owned fixture required")
    run(sys.argv[1])
