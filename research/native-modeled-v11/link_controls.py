"""EXEC-016: synthetic exact-vector controls; no compiler or external calls."""
import copy
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("link_inputs", Path(__file__).with_name("link_inputs.py"))
L = importlib.util.module_from_spec(spec)
spec.loader.exec_module(L)


def run():
    count = 0
    runtime = ["/work/global-cache/o/" + digit * 32 + "/" + name for digit, name in
               (("1", "crt1.o"), ("2", "libubsan_rt.a"), ("3", "libc.a"), ("4", "libcompiler_rt.a"))]
    rows = {path: dict(path=path, bytes=100, sha256="a" * 64) for path in runtime}
    prefix = ["ld.lld", "--error-limit=0", "-mllvm", "-float-abi=hard", "--entry", "_start",
              "-z", "stack-size=16777216", "--build-id=none", "--image-base=16777216",
              "--gc-sections", "--eh-frame-hdr", "-znow", "-m", "elf_x86_64", "-static",
              "-o", "/work/runtime-preparation"]
    payload = (" ".join(prefix + [runtime[0], "/work/policy.o", "/work/policy-controls.o", runtime[1],
                                   "--as-needed", runtime[2], runtime[3]]) + "\n").encode()
    fixed_wraps = ("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs", "readdir", "closedir",
                   "getrlimit", "setrlimit", "prctl", "syscall")

    def baseline():
        value = L.decode(payload)
        assert value["runtimePaths"] == runtime and value["words"] == payload.decode().strip().split(" ")
        assert value["stackBytes"] == value["imageBase"] == 16777216
        return value

    def deny(action, reason):
        nonlocal count
        baseline()  # parser baseline must pass outside any interception
        try:
            action()
        except ValueError as error:
            assert str(error) == reason
        else:
            raise AssertionError("invalid link fixture accepted")
        count += 1

    for model, objects in (("policy", ["/work/policy.o", "/work/policy-controls.o"]),
                           ("installer", ["/work/policy.o", "/work/policy-install-controls.o"]),
                           ("state", ["/work/state.o", "/work/state-controls.o"])):
        plan = L.final_plan(model, payload, rows)
        wanted = ["/tool/zig", "ld.lld", "--emit-relocs", "--icf=none", "--no-relax", "--no-pie",
                  "--Map=/work/" + model + ".map"]
        if model == "installer":
            wanted += ["--wrap=" + name for name in fixed_wraps]
        wanted += ["--error-limit=0", "-mllvm", "-float-abi=hard", "--entry", "_start", "-z",
                   "stack-size=16777216", "--build-id=none", "--image-base=16777216", "--gc-sections",
                   "--eh-frame-hdr", "-znow", "-m", "elf_x86_64", "-static", "-o", "/work/" + model + "-model",
                   runtime[0]] + objects + [runtime[1], "--as-needed", runtime[2], runtime[3]]
        assert plan["argv"] == wanted and plan["runtimeInputs"] == [rows[p] for p in runtime]
        assert plan["preparationOutputRetainedAsModel"] is False and plan["nativeQualification"] is False
        assert not any("unresolved" in word or word.startswith("@") for word in plan["argv"])
        assert "/work/runtime-preparation" not in plan["argv"]
        actual_wraps = [word for word in plan["argv"] if word.startswith("--wrap=")]
        assert actual_wraps == (["--wrap=" + name for name in fixed_wraps] if model == "installer" else [])
        count += 1
    assert L.verify_unchanged(payload, rows, copy.deepcopy(rows)) == [rows[p] for p in runtime]
    count += 1
    # Uninterpreted archive/diagnostic lines cannot add flags to the actual plan.
    other = b"ar rcs /work/opaque-data.a opaque-data.o\n" + payload
    assert L.final_plan("policy", other, rows) == L.final_plan("policy", payload, rows)
    count += 1
    isolated = L.final_plan("installer", payload, rows)
    isolated["argv"][0] = "changed caller-owned result"
    isolated["runtimeInputs"][0]["bytes"] = 101
    assert rows[runtime[0]]["bytes"] == 100
    assert L.final_plan("installer", payload, rows)["argv"][0] == "/tool/zig"
    assert L.final_plan("installer", payload, rows)["runtimeInputs"][0]["bytes"] == 100
    count += 1
    for bad in ("not bytes", b"", b"x" * 65537):
        deny(lambda bad=bad: L.decode(bad), "link dump byte budget")
    for bad in (payload[:-1], payload + b"\0", payload.replace(b" _start", b"\t_start"),
                payload.replace(b"_start", b"\xffstart"), payload.replace(b"\n", b"\r\n")):
        deny(lambda bad=bad: L.decode(bad), "link dump ASCII output framing")
    for bad in (b"\n" + payload, b"x" * 8193 + b"\n" + payload, b"opaque\n" * 256 + payload):
        deny(lambda bad=bad: L.decode(bad), "link dump line budget")
    for bad in (payload + payload, b" " + payload, b"no linker here\n"):
        deny(lambda bad=bad: L.decode(bad), "link dump exactly one embedded linker vector")
    deny(lambda: L.decode(payload.replace(b"ld.lld", b"ld.lldx", 1)), "link dump exact embedded linker identity")
    for bad in (payload.replace(b" _start", b"  _start"), payload.replace(b"_start", b"x" * 1025)):
        deny(lambda bad=bad: L.decode(bad), "link dump token budget")
    for before, after in ((b"--entry _start ", b""), (b"stack-size=16777216", b"stack-size=33554432"),
                          (b"--image-base=16777216", b"--image-base=2097152"),
                          (b"--gc-sections ", b""), (b"--eh-frame-hdr ", b""), (b"-znow ", b""),
                          (b"elf_x86_64", b"elf_i386"), (b"-static", b"-pie"),
                          (b"/work/runtime-preparation", b"/work/policy-model"),
                          (b"/work/policy-controls.o", b"/work/state-controls.o")):
        bad = payload.replace(before, after, 1)
        deny(lambda bad=bad: L.decode(bad), "link dump fixed option sequence")
    for before, after in ((runtime[0], runtime[0].replace("crt1.o", "crti.o")),
                          (runtime[0], runtime[0].replace("/work/", "/foreign/")),
                          (runtime[0], runtime[0].replace("/o/", "/o/../o/")),
                          (runtime[0], runtime[0].replace("/o/", "/o//")),
                          (runtime[1], runtime[1].replace("libubsan_rt.a", "libcompiler_rt.a")),
                          (runtime[2], "@/work/options.rsp"),
                          (runtime[3], runtime[3] + ";bad")):
        bad = payload.replace(before.encode(), after.encode(), 1)
        deny(lambda bad=bad: L.decode(bad), "link dump fixed runtime input role")
    deny(lambda: L.decode(payload.replace((runtime[1] + " ").encode(), b"")), "link dump fixed runtime input role")
    deny(lambda: L.decode(payload[:-1] + b" --unresolved-symbols=ignore-all\n"), "link dump trailing options or inputs")
    for path in runtime:
        local = path.replace("/global-cache/", "/local-cache/")
        bad_payload = payload.replace(path.encode(), local.encode(), 1)
        bad_rows = copy.deepcopy(rows)
        bad_rows[local] = dict(bad_rows.pop(path), path=local)
        deny(lambda bad_payload=bad_payload, bad_rows=bad_rows: L.final_plan("policy", bad_payload, bad_rows),
             "link dump fixed runtime input role")
    for path in runtime:
        bad_rows = copy.deepcopy(rows)
        del bad_rows[path]
        deny(lambda bad_rows=bad_rows: L.final_plan("policy", payload, bad_rows), "link runtime input not observed")
    for key, value in (("bytes", True), ("bytes", 0), ("bytes", 33554433), ("sha256", "b" * 63),
                        ("sha256", "A" * 64), ("path", runtime[0] + ".other")):
        bad_rows = copy.deepcopy(rows)
        bad_rows[runtime[0]][key] = value
        deny(lambda bad_rows=bad_rows: L.final_plan("policy", payload, bad_rows), "link runtime observed identity")
    deny(lambda: L.final_plan("observer", payload, rows), "link fixed model identity")
    deny(lambda: L.final_plan("policy", payload, []), "link bounded decoded cache rows")
    for key, value in (("sha256", "b" * 64), ("bytes", 101)):
        later = copy.deepcopy(rows)
        later[runtime[1]][key] = value
        deny(lambda later=later: L.verify_unchanged(payload, rows, later), "link runtime observed identity changed")

    class EqualitySpy:
        def __init__(self, hash_value=0):
            self.armed = False
            self.equalities = self.hashes = 0
            self.hash_value = hash_value

        def __hash__(self):
            if self.armed:
                self.hashes += 1
            return self.hash_value

        def __eq__(self, other):
            if self.armed:
                self.equalities += 1
            return True

    spy = EqualitySpy()
    bad_rows = copy.deepcopy(rows)
    bad_rows[runtime[0]]["path"] = spy
    spy.armed = True
    deny(lambda: L.final_plan("policy", payload, bad_rows), "link runtime observed identity")
    assert spy.equalities == spy.hashes == 0
    spy = EqualitySpy(hash(runtime[0]))
    bad_rows = {spy: rows[runtime[0]]}
    bad_rows.update({key: value for key, value in rows.items() if key != runtime[0]})
    spy.armed = True
    deny(lambda: L.final_plan("policy", payload, bad_rows), "link bounded decoded cache rows")
    assert spy.equalities == spy.hashes == 0
    spy = EqualitySpy(hash("path"))
    bad_rows = copy.deepcopy(rows)
    bad_rows[runtime[0]] = {spy: runtime[0], "bytes": 100, "sha256": "a" * 64}
    spy.armed = True
    deny(lambda: L.final_plan("policy", payload, bad_rows), "link runtime observed identity")
    assert spy.equalities == spy.hashes == 0
    oversized = copy.deepcopy(rows)
    oversized[runtime[0]]["extra"] = "not a selected identity field"
    deny(lambda: L.final_plan("policy", payload, oversized), "link runtime observed identity")
    boundary = copy.deepcopy(rows)
    boundary.update({"unselected-" + str(index): {} for index in range(2044)})
    assert len(boundary) == 2048
    assert L.final_plan("policy", payload, boundary) == L.final_plan("policy", payload, rows)
    count += 1
    boundary["unselected-over-bound"] = {}
    assert len(boundary) == 2049
    deny(lambda: L.final_plan("policy", payload, boundary), "link bounded decoded cache rows")
    print("Link input controls passed: " + str(count) + "; compiler/process/container calls: 0")
    return count


if __name__ == "__main__":
    run()
