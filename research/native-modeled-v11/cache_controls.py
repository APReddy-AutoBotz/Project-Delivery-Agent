"""Pure cache-receipt/map modeled controls; fixed scripts are source only here."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("fixed_cache_provenance", Path(__file__).with_name("cache_provenance.py"))
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


def run():
    count = 0
    empty = dict(schema=1, stage="INITIAL_EMPTY", roots=list(C.ROOTS), files=[], directories=[], totalBytes=0)
    assert C.decode(json.dumps(empty).encode(), True) == {}
    count += 1
    final = dict(schema=1, stage="FINAL_AFTER_FIXED_PRODUCERS", roots=list(C.ROOTS),
        directories=["/work/global-cache", "/work/global-cache/o", "/work/global-cache/o/model"],
        files=[dict(path="/work/global-cache/o/model/libc.a", bytes=5, sha256=hashlib.sha256(b"model").hexdigest())], totalBytes=5)
    rows = C.decode(json.dumps(final).encode(), False)
    assert set(rows) == {"/work/global-cache/o/model/libc.a"}
    count += 1
    for fault in ("schema-bool", "schema-extra", "wrong-stage", "wrong-roots", "preseed", "duplicate-file", "duplicate-dir",
                  "missing-parent", "bytes-bool", "wrong-total", "large-file", "large-total", "bad-hash", "foreign-path", "traversal",
                  "directory-as-file", "control-character", "missing-field", "wrong-files-type", "wrong-dirs-type", "nested-file-directory", "sum-over-cap"):
        value, initial = copy.deepcopy(final), False
        if fault == "schema-bool":
            value["schema"] = True
        elif fault == "schema-extra":
            value["extra"] = True
        elif fault == "wrong-stage":
            value["stage"] = "PASS"
        elif fault == "wrong-roots":
            value["roots"].append("/host")
        elif fault == "preseed":
            value["stage"], initial = "INITIAL_EMPTY", True
        elif fault == "duplicate-file":
            value["files"].append(copy.deepcopy(value["files"][0]))
        elif fault == "duplicate-dir":
            value["directories"].append(value["directories"][-1])
        elif fault == "missing-parent":
            value["directories"].remove("/work/global-cache/o")
        elif fault == "bytes-bool":
            value["files"][0]["bytes"] = True
        elif fault == "wrong-total":
            value["totalBytes"] = 6
        elif fault == "large-file":
            value["files"][0]["bytes"] = value["totalBytes"] = 33554433
        elif fault == "large-total":
            value["totalBytes"] = 268435457
        elif fault == "bad-hash":
            value["files"][0]["sha256"] = "x" * 64
        elif fault == "foreign-path":
            value["files"][0]["path"] = "/original/quarantine/libc.a"
        elif fault == "traversal":
            value["files"][0]["path"] = "/work/global-cache/o/../model/libc.a"
        elif fault == "directory-as-file":
            value["files"][0]["path"] = "/work/global-cache"
        elif fault == "control-character":
            value["files"][0]["path"] = "/work/global-cache/o/model/li\nbc.a"
        elif fault == "missing-field":
            del value["files"][0]["sha256"]
        elif fault == "wrong-files-type":
            value["files"] = {}
        elif fault == "wrong-dirs-type":
            value["directories"] = {}
        elif fault == "nested-file-directory":
            value["directories"].append(value["files"][0]["path"])
        else:
            value["files"] = [dict(path="/work/global-cache/o/model/lib" + str(i) + ".a", bytes=33554432,
                                   sha256=hashlib.sha256(b"synthetic size identity only").hexdigest()) for i in range(9)]
            value["totalBytes"] = 9 * 33554432
        try:
            C.decode(json.dumps(value).encode(), initial)
        except ValueError:
            count += 1
        else:
            raise AssertionError("invalid cache receipt admitted: " + fault)
    encoded = json.dumps(final, separators=(",", ":")).encode()
    for raw in (encoded.replace(b'"schema":1', b'"schema":1,"schema":1', 1),
                encoded.replace(b'"schema":1', b'"schema":1,"\\u0073chema":1', 1),
                encoded.replace(b'"bytes":5', b'"bytes":5,"bytes":5', 1),
                encoded.replace(b'"totalBytes":5', b'"totalBytes":NaN', 1),
                encoded.replace(b'"totalBytes":5', b'"totalBytes":Infinity', 1),
                encoded.replace(b'"totalBytes":5', b'"totalBytes":-Infinity', 1)):
        try:
            C.decode(raw, False)
        except ValueError:
            count += 1
        else:
            raise AssertionError("ambiguous or nonfinite cache JSON admitted")
    first_party = {"/work/recognition-lifecycle-policy.o"}
    header = "VMA".rjust(16) + " " + "LMA".rjust(16) + "     Size Align Out     In      Symbol\n"

    def model_map(*bodies):
        # Labeled synthetic fixed-format rows; no generated linker output exists yet.
        return (header + "".join(f"{0:16x} {0:16x} {1:8x} {1:5d} " + body + "\n" for body in bodies)).encode("ascii")

    good_input = "        /work/recognition-lifecycle-policy.o:(.text)"
    healthy = model_map(".text", good_input, "        /work/global-cache/o/model/libc.a(member.o):(.text)",
                        "                modeled_symbol", "        <internal>:(.symtab)")
    assert C.map_inputs(healthy, rows, first_party) == sorted(first_party | set(rows))
    count += 1
    for payload in (b"", b"\0", model_map(".text", "                no_inputs"), model_map("        /usr/lib/libc.a(member.o):(.text)"),
                    model_map("        /original/quarantine/libc.a(member.o):(.text)"),
                    model_map("        /work/global-cache/o/unknown.o:(.text)"),
                    model_map("        /work/global-cache/o/../model/libc.a(member.o):(.text)"),
                    model_map("        /work/global-cache//o/model/libc.a(member.o):(.text)"),
                    model_map("        /work/foreign-first-party.o:(.text)"),
                    model_map("        /work/global-cache/o/model/libc.a.suffix:(.text)")):
        try:
            C.map_inputs(payload, rows, first_party)
        except ValueError:
            count += 1
        else:
            raise AssertionError("unexplained map input admitted")
    for unknown in ("        relative.o:(.text)", "        /usr/lib/unexplained.so:(.text)",
                    "        /work/global-cache/o/model/foreign.bin:(.text)", "        relative.a(member.o):(.text)",
                    "        /work/global-cache/o/model/libc.a(../member.o):(.text)",
                    "        /work/global-cache/o/model/libc.a(member.o):(.text) trailing",
                    "        /work/recognition-lifecycle-policy.o:(.text) relative.o:(.text)",
                    "       /work/recognition-lifecycle-policy.o:(.text)",
                    "unrecognized-output-token", "        unknown input row"):
        try:
            C.map_inputs(model_map(good_input, unknown), rows, first_party)
        except ValueError:
            count += 1
        else:
            raise AssertionError("mixed unrecognized map input disappeared")
    expected = ("compiler-version", "clang-version", "compile-policy", "link-policy")
    events = [dict(id=name, status="PASSED", hostPid=1) for name in expected]
    assert C.producer_chain(events, expected) == [dict(id=name, status="PASSED", hostCommandEntryObserved=True) for name in expected]
    count += 1
    for fault in ("missing", "duplicate", "in-progress", "skip-compile", "bad-host-pid"):
        supplied = copy.deepcopy(events)
        if fault == "missing":
            supplied.pop()
        elif fault == "duplicate":
            supplied.append(copy.deepcopy(supplied[-1]))
        elif fault == "in-progress":
            supplied[-1]["status"] = "ATTEMPTED"
        elif fault == "skip-compile":
            supplied[2] = dict(id="compile-policy", status="SKIPPED_FAILED_DEPENDENCY")
        else:
            supplied[-1]["hostPid"] = True
        try:
            C.producer_chain(supplied, expected)
        except ValueError:
            count += 1
        else:
            raise AssertionError("incomplete producer chain admitted")
    failed = copy.deepcopy(events)
    failed[2]["status"] = "FAILED"
    failed[-1] = dict(id="link-policy", status="SKIPPED_FAILED_DEPENDENCY")
    result = C.producer_chain(failed, expected)
    assert result[-1] == dict(id="link-policy", status="SKIPPED_FAILED_DEPENDENCY", hostCommandEntryObserved=False)
    count += 1
    assert "directory.readSync()!==null" in C.INITIAL_SCRIPT
    assert "fs.constants.O_NOFOLLOW" in C.FINAL_SCRIPT and "fs.closeSync(fd)" in C.FINAL_SCRIPT
    assert "FINAL_AFTER_FIXED_PRODUCERS" in C.FINAL_SCRIPT
    count += 1  # source contract, not Node runtime validation
    return count


if __name__ == "__main__":
    assert len(sys.argv) == 2
    print("Cache controls passed: " + str(run()) + "; compiler/image/native calls: 0")
