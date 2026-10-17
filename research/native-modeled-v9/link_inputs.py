"""EXEC-016/TR-DEP-004: finite Zig0.15.2 preparation-vector decoder.

Source-only draft. No execution, imports of other candidate helpers, shell,
cache discovery, compiler invocation or operational admission. A future driver
must authenticate the producer, same-container ordering and snapshot itself.
"""
import re

MODELS = {"policy": ("policy", "policy-controls"),
          "installer": ("policy", "policy-install-controls"),
          "state": ("state", "state-controls")}
WRAPS = ("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs", "readdir", "closedir",
         "getrlimit", "setrlimit", "prctl", "syscall")
PREPARATION_OUTPUT = "/work/runtime-preparation"
RUNTIME_NAMES = ("crt1.o", "libubsan_rt.a", "libc.a", "libcompiler_rt.a")
PATH = re.compile(r"/work/global-cache/o/[0-9a-f]{32}/([A-Za-z0-9_.+-]+)")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def decode(payload):
    """Admit one complete unquoted dump; never interpret it as shell text.

    The preparation link is the fixed policy pair, not an installer/model run.
    Unknown source-version layouts must stop before direct LLD entry.
    """
    require(type(payload) is bytes and 0 < len(payload) <= 65536, "link dump byte budget")
    require(payload.endswith(b"\n") and
            all(byte == 10 or 32 <= byte <= 126 for byte in payload), "link dump ASCII output framing")
    lines = payload[:-1].split(b"\n")
    require(len(lines) <= 256 and all(0 < len(line) <= 8192 for line in lines), "link dump line budget")
    # Runtime archive construction can emit other bounded diagnostic lines.
    # They remain opaque data and can never supply any argv/input authority.
    top = [line for line in lines if line.startswith(b"ld.lld")]
    require(len(top) == 1, "link dump exactly one embedded linker vector")
    text = top[0].decode("ascii")
    words = text.split(" ")
    require(1 <= len(words) <= 96 and all(0 < len(word) <= 1024 for word in words), "link dump token budget")
    require(words[0] == "ld.lld", "link dump exact embedded linker identity")
    # Complete tagged-source schema for the unchanged COMMON -O0 C driver.
    # These are source-derived defaults, not observed historical V7 values.
    cursor = 1

    def take(expected):
        nonlocal cursor
        require(words[cursor:cursor + len(expected)] == list(expected), "link dump fixed option sequence")
        cursor += len(expected)

    take(("--error-limit=0", "-mllvm", "-float-abi=hard", "--entry", "_start",
          "-z", "stack-size=16777216", "--build-id=none", "--image-base=16777216",
          "--gc-sections", "--eh-frame-hdr", "-znow", "-m", "elf_x86_64", "-static",
          "-o", PREPARATION_OUTPUT))
    output_position = cursor - 1
    runtime = []

    def runtime_input(basename):
        nonlocal cursor
        require(cursor < len(words), "link dump runtime input absent")
        path = words[cursor]
        match = PATH.fullmatch(path)
        require(match is not None and match.group(1) == basename, "link dump fixed runtime input role")
        require(path not in runtime, "link dump duplicate runtime path")
        runtime.append(path)
        cursor += 1

    runtime_input("crt1.o")
    object_position = cursor
    take(("/work/policy.o", "/work/policy-controls.o"))
    runtime_input("libubsan_rt.a")
    take(("--as-needed",))
    runtime_input("libc.a")
    runtime_input("libcompiler_rt.a")
    require(cursor == len(words), "link dump trailing options or inputs")
    require(len(set(runtime)) == 4, "link dump runtime cardinality")
    return dict(words=words, runtimePaths=runtime, outputPosition=output_position,
                objectPosition=object_position, stackBytes=16777216, imageBase=16777216)


def final_plan(model, payload, cache_rows):
    """Produce argv as data after binding every emitted runtime file identity.

    This is observation binding, not exact per-process production proof. The
    driver must establish initial-empty, the fixed preparation command, fresh
    pre-final observations and final unchanged snapshots/closed producers.
    """
    require(type(model) is str and model in MODELS, "link fixed model identity")
    value = decode(payload)
    require(type(cache_rows) is dict and len(cache_rows) <= 2048 and
            all(type(key) is str for key in cache_rows), "link bounded decoded cache rows")
    inputs = []
    for path in value["runtimePaths"]:
        require(path in cache_rows, "link runtime input not observed")
        row = cache_rows[path]
        require(type(row) is dict and len(row) == 3 and all(type(key) is str for key in row) and
                set(row) == {"path", "bytes", "sha256"} and type(row["path"]) is str and row["path"] == path and
                type(row["bytes"]) is int and 0 < row["bytes"] <= 33554432 and
                type(row["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", row["sha256"]),
                "link runtime observed identity")
        inputs.append(dict(row))
    require(sum(row["bytes"] for row in inputs) <= 268435456, "link runtime aggregate bytes")
    argv = value["words"][1:]
    argv[value["outputPosition"] - 1] = "/work/" + model + "-model"
    at = value["objectPosition"] - 1
    argv[at:at + 2] = ["/work/" + unit + ".o" for unit in MODELS[model]]
    # Direct embedded LLD owns these options. Zig's cc parser must not parse
    # them. The final installer always has precisely the twelve fixed wraps.
    extra = ["--emit-relocs", "--icf=none", "--no-relax", "--no-pie", "--Map=/work/" + model + ".map"]
    if model == "installer":
        extra += ["--wrap=" + name for name in WRAPS]
    argv = ["/tool/zig", "ld.lld"] + extra + argv
    return dict(model=model, argv=argv, runtimeInputs=inputs,
                preparationOutputRetainedAsModel=False, exactPerProcessProductionProved=False,
                nativeQualification=False)


def verify_unchanged(payload, earlier_rows, later_rows):
    """Compare complete observed identities, without claiming continuous custody."""
    earlier = final_plan("policy", payload, earlier_rows)["runtimeInputs"]
    later = final_plan("policy", payload, later_rows)["runtimeInputs"]
    require(earlier == later, "link runtime observed identity changed")
    return earlier
