"""Modeled wrapper callthrough. All external responses below are supplied.

Production create_view, unchanged license algorithm and compiler/image/archive
processes are explicitly supplied. Old43 orchestration cases retain a short
build/model boundary; additional inherited cases call the actual build/model
bodies with supplied process outputs. No native evidence.
Actual packet authentication, minimal ToolView construction, wrapper hooks,
container intent/create-capture/remove/cleanup, receipts and finalizer run.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

FILTERED_CONTROL_COUNT = 78
# Independent literal source-order case oracle, not read from F's runtime plan.
FILTERED_CASE_NAMES = ('healthy', 'prerequisite-failure', 'archive-failure', 'view-failure', 'license-failure', 'wrong-container', 'repeat-initial', 'missing-producer', 'initial-inquiry-failure', 'final-inquiry-failure', 'final-json-failure', 'map-failure', 'snapshot-without-license', 'snapshot-without-readiness', 'snapshot-after-removal', 'final-before-initial', 'wrong-producer-order', 'repeat-final', 'ownership-refusal', 'remove-failure', 'census-failure', 'compile-vector-missing-linker-option', 'compile-vector-duplicate-linker-option', 'compile-vector-wrong-source', 'compile-boundary-unlicensed', 'compile-boundary-unready', 'compile-boundary-no-initial', 'compile-boundary-final-present', 'compile-boundary-wrong-container', 'compile-boundary-retired', 'cleanup-write-short', 'cleanup-write-partial', 'cleanup-write-full-throw', 'terminal-write-short', 'terminal-write-partial', 'terminal-write-full-throw', 'view-return-expiry', 'initial-return-expiry', 'final-return-expiry', 'cache-ready-save-expiry', 'after-cleanup-expiry', 'cleanup-save-expiry', 'terminal-save-expiry', 'inherited-healthy', 'host-control-result-grammar', 'inherited-elf-bad-policy.o', 'inherited-elf-bad-policy-controls.o', 'inherited-elf-bad-policy-install-controls.o', 'inherited-elf-bad-state.o', 'inherited-elf-bad-state-controls.o', 'inherited-elf-bad-observer.o', 'inherited-elf-bad-policy-model', 'inherited-elf-bad-installer-model', 'inherited-elf-bad-state-model', 'inherited-copy-worker-end', 'inherited-copy-save-end', 'inherited-copy-settlement-end', 'inherited-retirement-expiry', 'inherited-source-dependency-expiry', 'inherited-first-model-hash-expiry', 'inherited-second-model-hash-expiry', 'view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership')
VIEW_GROUP_ORACLE = (('g01', ('view-001', 'view-002')), ('g02', ('view-003',)), ('g03', ('view-004',)), ('g04', ('view-005',)), ('g05', ('view-006',)), ('g06', ('view-007',)), ('g07', ('view-008', 'view-009', 'view-010', 'view-011', 'view-012', 'view-013', 'view-014', 'view-015', 'view-016', 'view-017', 'view-018', 'view-019', 'view-020', 'view-021', 'view-022', 'view-023', 'view-024', 'view-025', 'view-026')), ('g08', ('view-027', 'view-028', 'view-029', 'view-030', 'view-031', 'view-032', 'view-033', 'view-034', 'view-035', 'view-036')), ('g09', ('view-037', 'view-038', 'view-039', 'view-040', 'view-041', 'view-042', 'view-043', 'view-044', 'view-045', 'view-046', 'view-047', 'view-048', 'view-049', 'view-050')), ('g10', ('view-051', 'view-052', 'view-053', 'view-054', 'view-055', 'view-056', 'view-057', 'view-058', 'view-059', 'view-060', 'view-061', 'view-062')), ('g11', ('view-063', 'view-064', 'view-065', 'view-066', 'view-067', 'view-068', 'view-069', 'view-070', 'view-071')))
FILTERED_GROUP_ORACLE = (('f01', ('healthy', 'prerequisite-failure', 'archive-failure', 'view-failure', 'license-failure', 'wrong-container', 'repeat-initial', 'missing-producer', 'initial-inquiry-failure', 'final-inquiry-failure', 'final-json-failure', 'map-failure', 'snapshot-without-license', 'snapshot-without-readiness', 'snapshot-after-removal', 'final-before-initial', 'wrong-producer-order', 'repeat-final', 'ownership-refusal', 'remove-failure', 'census-failure')), ('f02', ('compile-vector-missing-linker-option', 'compile-vector-duplicate-linker-option', 'compile-vector-wrong-source', 'compile-boundary-unlicensed', 'compile-boundary-unready', 'compile-boundary-no-initial', 'compile-boundary-final-present', 'compile-boundary-wrong-container', 'compile-boundary-retired', 'cleanup-write-short', 'cleanup-write-partial', 'cleanup-write-full-throw', 'terminal-write-short', 'terminal-write-partial', 'terminal-write-full-throw', 'view-return-expiry', 'initial-return-expiry', 'final-return-expiry', 'cache-ready-save-expiry', 'after-cleanup-expiry', 'cleanup-save-expiry', 'terminal-save-expiry')), ('f03', ('inherited-healthy', 'host-control-result-grammar')), ('f04', ('inherited-elf-bad-policy.o', 'inherited-elf-bad-policy-controls.o', 'inherited-elf-bad-policy-install-controls.o')), ('f05', ('inherited-elf-bad-state.o', 'inherited-elf-bad-state-controls.o', 'inherited-elf-bad-observer.o')), ('f06', ('inherited-elf-bad-policy-model', 'inherited-elf-bad-installer-model', 'inherited-elf-bad-state-model')), ('f07', ('inherited-copy-worker-end', 'inherited-copy-save-end', 'inherited-copy-settlement-end', 'inherited-retirement-expiry', 'inherited-source-dependency-expiry', 'inherited-first-model-hash-expiry', 'inherited-second-model-hash-expiry')), ('f08', ('view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership')))
NEW_GROUP_CASES = ('view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership')


def run(owned, group):
    assert type(group) is str and group in {name for name, _ in FILTERED_GROUP_ORACLE}
    selected = next(names for name, names in FILTERED_GROUP_ORACLE if name == group)
    count, completed = 0, []

    def complete(name):
        nonlocal count
        assert name in selected and name not in completed
        completed.append(name)
        count += 1
    with tempfile.TemporaryDirectory(prefix="filtered-modeled-", dir=owned) as temporary:
        parent = Path(temporary)
        workspace = parent / "workspace"
        packet = workspace / "research/native-modeled-v9"
        packet.mkdir(parents=True)
        source = Path(__file__).resolve().parent
        manifest = json.loads((source / "packet.json").read_text())
        assert manifest["schema"] == 1 and len(manifest["files"]) == 34
        for row in manifest["files"]:
            payload = (source / row["path"]).read_bytes()
            assert len(payload) == row["bytes"] and hashlib.sha256(payload).hexdigest() == row["sha256"]
            target = packet / row["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
        packet_bytes = (source / "packet.json").read_bytes()
        (packet / "packet.json").write_bytes(packet_bytes)
        spec = importlib.util.spec_from_file_location("modeled_staged_filtered_entry", packet / "filtered_driver.py")
        F = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(F)
        D = F.D  # exactly the staged entrypoint's actual module, never another helper instance
        actual_cleanup, actual_finalize, actual_save = F.FilteredAttempt.cleanup_after_attempt, F.FilteredAttempt.finalize, F.FilteredAttempt.save
        actual_build, actual_inspect = D.Attempt.build, D.Attempt.inspect_then_models
        actual_copy_valid, actual_artifact_hash = F.FilteredAttempt.artifact_copy_valid, F.FilteredAttempt.artifact_hash
        raw_is_file = Path.is_file
        actual_decode = F.C.decode
        raw_write = Path.write_bytes
        initial = dict(schema=1, stage="INITIAL_EMPTY", roots=["/work/local-cache", "/work/global-cache"],
                       files=[], directories=[], totalBytes=0)
        runtime_root = "/work/global-cache/o/" + "a" * 32
        runtime_paths = [runtime_root + "/" + leaf for leaf in ("crt1.o", "libubsan_rt.a", "libc.a", "libcompiler_rt.a")]
        final = dict(schema=1, stage="FINAL_AFTER_FIXED_PRODUCERS", roots=["/work/local-cache", "/work/global-cache"],
                     files=[dict(path=path, bytes=5, sha256=hashlib.sha256(b"model").hexdigest()) for path in sorted(runtime_paths)],
                     directories=["/work/global-cache", "/work/global-cache/o", runtime_root], totalBytes=20)
        prefix = ["--error-limit=0", "-mllvm", "-float-abi=hard", "--entry", "_start", "-z", "stack-size=16777216",
                  "--build-id=none", "--image-base=16777216", "--gc-sections", "--eh-frame-hdr", "-znow", "-m", "elf_x86_64", "-static"]
        preparation = (" ".join(["ld.lld"] + prefix + ["-o", "/work/runtime-preparation", runtime_paths[0],
            "/work/policy.o", "/work/policy-controls.o", runtime_paths[1], "--as-needed", runtime_paths[2], runtime_paths[3]]) + "\n").encode("ascii")
        container_id = "a" * 64
        def supplied_result(status, size, family):
            return json.dumps(dict(schema=1, status=status, cases=size, names=[family + "-" + str(index) for index in range(size)],
                                   realDockerInvocations=0, nativeQualification=False), separators=(",", ":")).encode("ascii")

        def group_result(status, group_name, names, external_field):
            return json.dumps(dict(schema=1, status=status, group=group_name, cases=len(names), names=list(names),
                                   **{external_field: 0}, nativeQualification=False), separators=(",", ":")).encode("ascii")
        scripts = [("driver-controls", "driver_controls.py", b"Driver modeled controls passed: 309; network/process/container calls: 0\n", ())]
        scripts += [("view-controls-" + group_name, "view_controls.py",
                     group_result("SUPPLIED_TOOL_VIEW_CONTROLS_PASS", group_name, names, "realCompilerImageNativeInvocations"), (group_name,))
                    for group_name, names in VIEW_GROUP_ORACLE]
        scripts += [
            ("cache-controls", "cache_controls.py", b"Cache controls passed: 59; compiler/image/native calls: 0\n", ()),
            ("elf-controls", "elf_controls_v2.py", b"ELF modeled controls passed: 1; native executions: 0\n", ()),
            ("elf-bss-controls", "elf_bss_controls.py", b"ELF BSS controls passed: 43; native executions: 0\n", ()),
            ("link-input-controls", "link_controls.py", b"Link input controls passed: 66; compiler/process/container calls: 0\n", ()),
            ("transfer-controls", "transfer_controls.py", supplied_result("SUPPLIED_CONTROLS_PASS", 116, "transfer-supplied"), ()),
            ("host-file-controls", "host_files_controls.py", supplied_result("SUPPLIED_HOST_FILES_CONTROLS_PASS", 125, "host-supplied"), ())]
        scripts += [("filtered-controls-" + group_name, "filtered_controls.py",
                     group_result("SUPPLIED_FILTERED_DRIVER_CONTROLS_PASS", group_name, names, "realExternalInvocations"), (group_name,))
                    for group_name, names in FILTERED_GROUP_ORACLE]
        assert len(scripts) == 26 and len({row[0] for row in scripts}) == 26


        def final_request(model, execute):
            # Independent literal oracle. Do not ask L.final_plan to generate
            # the expected argv for the transformation under test.
            options = ["--emit-relocs", "--icf=none", "--no-relax", "--no-pie", "--Map=/work/" + model + ".map"]
            if model == "installer":
                options += ["--wrap=" + item for item in ("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs", "readdir", "closedir",
                            "getrlimit", "setrlimit", "prctl", "syscall")]
            return execute + ["/tool/zig", "ld.lld"] + options + prefix + ["-o", "/work/" + model + "-model", runtime_paths[0]] + \
                ["/work/" + unit + ".o" for unit in D.LINKS[model]] + [runtime_paths[1], "--as-needed", runtime_paths[2], runtime_paths[3]]

        def container_profile(owner, name):
            # Pure independent argv oracle. Calling product docker_base would
            # consume custody intent a second time and invalidate the fixture.
            cpus = sorted(os.sched_getaffinity(0))[:2]
            assert cpus
            return ["/usr/bin/docker", "create", "--name", name, "--label", "com.pdaa.modeled=" + owner.name,
                "--user", "1000:1000", "--read-only", "--network", "none", "--ipc", "none", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "32",
                "--cpus", "2", "--cpuset-cpus", ",".join(map(str, cpus)), "--ulimit", "nofile=128:128", "--ulimit", "core=0:0",
                "--log-driver", "none", "--env", "HOME=/work", "--env", "LANG=C", "--env", "LC_ALL=C", "--env", "PATH=/usr/bin:/bin",
                "--env", "TMPDIR=/work", "--env", "ZIG_LIB_DIR=/tool/lib", "--env", "ZIG_LOCAL_CACHE_DIR=/work/local-cache",
                "--env", "ZIG_GLOBAL_CACHE_DIR=/work/global-cache", "--tmpfs",
                "/work:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=0700"]

        def producer_request(identity, execute, delivered=False):
            if identity == "compiler-version":
                return execute + ["/tool/zig", "version"], 5
            if identity == "clang-version":
                return execute + ["/tool/zig", "cc", "--version"], 5
            if identity.startswith("compile-"):
                unit = identity[len("compile-"):]
                assert unit in D.UNITS and D.COMMON.count("-fuse-ld=lld") == 1
                common = [word for word in D.COMMON if not delivered or word != "-fuse-ld=lld"]
                return execute + common + D.INCLUDES + ["-Wall", "-Wextra", "-Werror", "-MD", "-MF", "/work/" + unit + ".d",
                    "-c", "/src/" + D.BASE + unit + ".c", "-o", "/work/" + unit + ".o"], 30
            model = identity[len("link-"):]
            assert identity.startswith("link-") and model in D.LINKS
            argv = D.COMMON + ["-static", "-no-pie", "-Wl,--gc-sections", "-Wl,--emit-relocs", "-Wl,--icf=none",
                              "-Wl,--no-relax", "-Wl,-Map,/work/" + model + ".map"]
            if model == "installer":
                argv += ["-Wl,--wrap=" + boundary for boundary in D.WRAPS]
            argv += ["/work/" + unit + ".o" for unit in D.LINKS[model]] + ["-o", "/work/" + model + "-model"]
            return execute + argv, 30

        def scenario(name):
            nonlocal count
            if name not in selected:
                return
            runner_temp = parent / name
            runner_temp.mkdir()
            fixture = runner_temp / "pdaa-native-modeled-v9"
            clock = [1000.0]
            state = dict(phase="BODY", commands=[], owners=[], cleanupEntries=[], finalizers=0, modelEntries=0,
                         archiveEntries=0, viewEntries=0, raw=[], decodes=[], faultDeliveries=[], faultReached=False, expectedCreate=None,
                         callbackErrors=[], rawCallbacks=[], workerEntries=[], sourceCopyChecks=[], modelStarts=[], hashEntries=[], metadataProbes=[])
            inherited = name.startswith("inherited-")
            header = "VMA".rjust(16) + " " + "LMA".rjust(16) + "     Size Align Out     In      Symbol\n"
            artifact_payloads = {}
            for unit in D.UNITS:
                artifact_payloads[unit + ".o"] = b"\x00PRIVATE-SUPPLIED-OBJECT-\xff" + unit.encode("ascii")
                artifact_payloads[unit + ".d"] = (unit + ".o: /tool/lib/include/stddef.h /src/" + D.BASE + unit + ".c\n").encode("ascii")
            for model, units in D.LINKS.items():
                artifact_payloads[model + "-model"] = b"\x00PRIVATE-SUPPLIED-MODEL-\xfe" + model.encode("ascii")
                bodies = ["        /work/" + unit + ".o:(.text)" for unit in units]
                bodies.append("        " + runtime_paths[2] + "(member.o):(.text)")
                if name == "map-failure":
                    bodies.append("        relative.o:(.text)")
                artifact_payloads[model + ".map"] = (header + "".join(
                    f"{0:16x} {0:16x} {1:8x} {1:5d} " + body + "\n" for body in bodies)).encode("ascii")
            source_rows = [dict(name=leaf, bytes=len(artifact_payloads[leaf]), sha256=hashlib.sha256(artifact_payloads[leaf]).hexdigest())
                           for leaf in F.T.NAMES]

            def checked(function):
                def invoke(*args, **kwargs):
                    state["rawCallbacks"].append(function.__name__)
                    try:
                        return function(*args, **kwargs)
                    except AssertionError:
                        state["callbackErrors"].append(function.__name__)
                        raise
                return invoke

            def command(owner, identity, argv, seconds, cleanup=False, capture_result=None):
                state["commands"].append((identity, list(argv), seconds, cleanup))  # every entry before response/refusal
                owner.guard(0 if cleanup else 20)
                assert not any(e.get("id") == identity for e in owner.events), "modeled command identity reused"
                matching = [row for row in scripts if row[0] == identity]
                if matching:
                    state["prerequisiteOwner"] = owner
                    index = scripts.index(matching[0])
                    assert [c[0] for c in state["commands"][:index + 1]] == [r[0] for r in scripts[:index + 1]]
                    assert argv == [sys.executable, "-I", "-S", "-B", str(packet / matching[0][1]), str(owner.fixture)] + list(matching[0][3])
                    assert seconds == 5 and not cleanup and capture_result is None
                    payload = matching[0][2]
                    if name == "host-control-result-grammar" and identity == "host-file-controls":
                        value = json.loads(payload)
                        value["names"][0] = "invalid.policy.o"
                        payload = json.dumps(value, separators=(",", ":")).encode("ascii")

                    grouped_target = ("filtered-controls-f08" if name == "filtered-group-wrong-membership" else
                                      "view-controls-g11" if name == "view-group-incomplete-last" else "view-controls-g01")
                    if name in NEW_GROUP_CASES and identity == grouped_target:
                        value = json.loads(payload)
                        if name == "view-group-wrong-selector":
                            value["group"] = "g02"
                        elif name == "view-group-bad-count":
                            value["cases"] -= 1
                        elif name == "view-group-boolean-count":
                            value["cases"] = True
                        elif name == "view-group-duplicate-name":
                            value["names"][1] = value["names"][0]
                        elif name in ("view-group-foreign-name", "filtered-group-wrong-membership"):
                            value["names"][0] = "foreign-control"
                        elif name == "view-group-reverse-names":
                            value["names"].reverse()
                        elif name == "view-group-unknown-status":
                            value["status"] = "UNKNOWN"
                        elif name == "view-group-extra-field":
                            value["extra"] = False
                        elif name == "view-group-nonzero-calls":
                            value["realCompilerImageNativeInvocations"] = 1
                        elif name == "view-group-native-true":
                            value["nativeQualification"] = True
                        elif name == "view-group-incomplete-last":
                            value["names"].pop()
                        payload = json.dumps(value, separators=(",", ":")).encode("ascii")
                        if name == "view-group-duplicate-key":
                            payload = b'{"schema":1,' + payload[1:]
                        elif name == "view-group-malformed-json":
                            payload = b"{"
                    ok = name != "prerequisite-failure" and not (name == "view-group-command-failure" and identity == grouped_target)
                elif identity == "docker-version":
                    assert inherited and argv == ["/usr/bin/docker", "version", "--format", "{{json .}}"] and seconds == 5 and not cleanup
                    payload, ok = b"{}\n", True
                elif identity == "image-pull":
                    assert inherited and argv == ["/usr/bin/docker", "pull", "--platform", "linux/amd64", D.IMAGE] and seconds == 90 and not cleanup
                    payload, ok = b"supplied image pull\n", True
                elif identity == "image-identity":
                    assert inherited and argv == ["/usr/bin/docker", "image", "inspect", "--format", "{{.Os}} {{.Architecture}} {{.Size}} {{.Id}}", D.IMAGE]
                    assert seconds == 5 and not cleanup
                    payload, ok = b"linux amd64 1 sha256:" + b"a" * 64 + b"\n", True
                elif identity == "build-create":
                    assert argv == state["expectedCreate"] and seconds == 5 and not cleanup and capture_result is not None
                    payload, ok = (container_id + "\n").encode(), True
                elif identity == "build-start":
                    assert argv == ["/usr/bin/docker", "start", container_id] and seconds == 5 and not cleanup
                    payload, ok = b"modeled-start\n", True
                elif identity in ("runtime-cache-initial", "runtime-cache-pre-final", "runtime-cache-final"):
                    first = identity.endswith("initial")
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                                    "/usr/local/bin/node", "-e", F.C.INITIAL_SCRIPT if first else F.C.FINAL_SCRIPT]
                    assert seconds == 5 and not cleanup and capture_result is None
                    payload = json.dumps(initial if first else final, separators=(",", ":")).encode()
                    ok = not ((first and name == "initial-inquiry-failure") or
                              (identity == "runtime-cache-final" and name == "final-inquiry-failure"))
                    if identity == "runtime-cache-final" and name == "final-json-failure":
                        payload = payload.replace(b'"schema":1', b'"schema":1,"schema":1', 1)
                elif identity == "reader-controls":
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                        "/usr/local/bin/node", "-e", (packet / "artifact_reader_controls.js").read_bytes().decode("ascii"), "--",
                        (packet / "artifact_reader.js").read_bytes().decode("ascii")] and seconds == 5 and not cleanup and capture_result is None
                    reader_names = ["reader-source-identity-" + str(index) for index in range(3)]
                    reader_names += ["size-" + str(size) for size in (0, 1, 65535, 65536, 65537, 1048576, 33554432)]
                    reader_names += ["write-order-" + order for order in ("sync", "drain-before-return", "callback-before-drain", "drain-before-callback")]
                    reader_names += ["open-throw", "invalid-fd", "fstat-throw", "initial-kind", "initial-uid", "initial-links", "initial-size",
                        "read-throw", "short-read", "invalid-read", "extra-byte", "changed-fstat", "changed-path", "lstat-throw", "close-throw",
                        "write-throw", "write-invalid-result", "callback-error", "stream-error", "stream-close", "gap-error", "wrong-hash", "destroy-throw"]
                    reader_names += ["argv-" + str(index) for index in range(37, 46)]
                    payload, ok = json.dumps(dict(schema=1, status="SUPPLIED_READER_CONTROLS_PASS", cases=46, names=reader_names,
                        realArtifactReads=0, nativeQualification=False), separators=(",", ":")).encode("ascii"), True
                elif identity == "runtime-preparation":
                    expected = ["/usr/bin/docker", "exec", "--workdir", "/work", "--env", "ZIG_VERBOSE_LINK=1", container_id]
                    expected += D.COMMON + ["-static", "-no-pie", "-Wl,--gc-sections", "/work/policy.o", "/work/policy-controls.o",
                                            "-o", "/work/runtime-preparation"]
                    assert argv == expected and seconds == 30 and not cleanup and capture_result is None
                    payload, ok = preparation, True
                elif identity in F.PRODUCERS:
                    expected, limit = producer_request(identity, ["/usr/bin/docker", "exec", "--workdir", "/work", container_id], delivered=True)
                    if identity.startswith("link-"):
                        expected = final_request(identity[len("link-"):], ["/usr/bin/docker", "exec", "--workdir", "/work", container_id])
                    assert argv == expected and seconds == limit and not cleanup and capture_result is None
                    if identity.startswith("compile-"):
                        assert "-fuse-ld=lld" not in argv and "-Werror" in argv and "-c" in argv
                    if identity.startswith("link-"):
                        assert "-fuse-ld=lld" not in argv and "-c" not in argv and argv[5:7] == ["/tool/zig", "ld.lld"]
                    payload, ok = (b"0.15.2\n" if identity == "compiler-version" else b"clang version 20.1.8\n" if identity == "clang-version" else
                                   b"explicitly supplied modeled compiler outcome\n"), True
                elif identity == "artifact-source-snapshot":
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                                    "/usr/local/bin/node", "-e", F.fixed_source_snapshot_script()]
                    assert seconds == 5 and not cleanup and capture_result is None
                    if name == "map-failure":
                        state["faultReached"] = True
                    payload, ok = json.dumps(source_rows, separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("copy-"):
                    index = int(identity[len("copy-"):])
                    row = source_rows[index]
                    leaf, target = row["name"], owner.fixture / "artifacts" / row["name"]
                    end = owner.transfer_ends[leaf]
                    assert argv == [sys.executable, "-I", "-S", "-B", str(packet / "artifact_transfer.py"), str(target.parent),
                        container_id, leaf, str(row["bytes"]), row["sha256"], repr(end),
                        *(str(value) for value in owner.fixture_identity), *(str(value) for value in owner.artifact_directory_identity)]
                    assert seconds == 3 and not cleanup and capture_result is None and end == min(owner.deadline - 20, clock[0] + 2.5)
                    assert (owner.transfer_attempts == [item["name"] for item in source_rows[:index + 1]] and
                        owner.transfer_unsettled[leaf] == row["bytes"] and leaf not in owner.transfer_verified and
                        owner.transfer_charged == sum(item["bytes"] for item in source_rows[:index + 1]))
                    state["workerEntries"].append((leaf, end, owner.transfer_charged))
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
                    try:
                        assert os.write(descriptor, artifact_payloads[leaf]) == row["bytes"]
                        info = os.fstat(descriptor)
                    finally:
                        os.close(descriptor)
                    report = dict(schema=1, status="VERIFIED_PRIVATE_PENDING_BUILDER_RETIREMENT", code="NONE", name=leaf, container=container_id,
                        expectedBytes=row["bytes"], receivedBytes=row["bytes"], verifiedWriteBytes=row["bytes"], uncertainWriteBytes=0,
                        uncertainReadBytes=0, returnedReadBytes=2 * row["bytes"] + (packet / "artifact_reader.js").stat().st_size, readAttempts=5,
                        streamSha256=row["sha256"], hostSha256=row["sha256"], stderrBytes=0, stderrSha256=hashlib.sha256(b"").hexdigest(),
                        stdoutEof=True, stderrEof=True, childClosedKnown=True, acquisitions=1, closes=1, pendingAcquisitions={}, uncertainCloseRoles=[],
                        nativePendingReservations={}, nativeFdBudget=16, nativeFdPeakReserved=13, ownedResourcesClosed=True,
                        hostIdentity=dict(device=info.st_dev, inode=info.st_ino, uid=info.st_uid, mode=info.st_mode & 0o777, bytes=info.st_size),
                        nativeQualification=False)
                    payload, ok = json.dumps(report, separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("inspect-owner-"):
                    custody = next(row for row in owner.containers if "inspect-owner-" + row["name"] == identity)
                    assert argv == ["/usr/bin/docker", "inspect", "--format", '{{.Id}} {{index .Config.Labels "com.pdaa.modeled"}}', custody["id"]]
                    assert seconds == 2 and cleanup
                    payload, ok = (custody["id"] + " " + owner.name + "\n").encode(), True
                    if name == "ownership-refusal":
                        state["faultReached"] = True
                        payload = (container_id + " wrong-modeled-label\n").encode()
                elif identity.startswith("remove-"):
                    custody = next(row for row in owner.containers if "remove-" + row["name"] == identity)
                    assert argv == ["/usr/bin/docker", "rm", "--force", custody["id"]] and seconds == 3 and cleanup
                    payload, ok = b"modeled-removed\n", True
                    if name == "remove-failure":
                        state["faultReached"] = True
                        ok = False
                elif identity == "elf-inspection":
                    assert inherited and argv == [sys.executable, "-I", "-S", "-B", str(packet / "elf_inspect.py"), str(owner.fixture / "artifacts")]
                    assert seconds == 10 and not cleanup and capture_result is None
                    hashes = {row["name"]: row["sha256"] for row in source_rows if row["name"].endswith((".o", "-model"))}
                    if name.startswith("inherited-elf-bad-"):
                        leaf = name[len("inherited-elf-bad-"):]
                        assert leaf in hashes
                        hashes[leaf] = "0" * 64
                        state["faultReached"] = True
                    payload, ok = json.dumps(dict(status="INSPECTED_MODELS_ONLY", hashes=hashes, wrappedEdges=[], observerLinked=False,
                                                  nativeQualification=False), separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("model-create-"):
                    model = identity[len("model-create-"):]
                    assert inherited and model in D.LINKS and seconds == 5 and not cleanup and capture_result is not None
                    expected = container_profile(owner, owner.name + "-" + model)
                    expected += ["--mount", "type=bind,src=" + str(owner.fixture / "artifacts") + ",dst=/models,readonly",
                                 "--entrypoint", "/models/" + model + "-model", D.IMAGE]
                    assert argv == expected
                    payload, ok = (({"policy": "b", "installer": "c", "state": "d"}[model] * 64) + "\n").encode("ascii"), True
                elif identity.startswith("model-exit-"):
                    model = identity[len("model-exit-"):]
                    custody = next(row for row in owner.containers if row["name"] == owner.name + "-" + model)
                    assert inherited and argv == ["/usr/bin/docker", "inspect", "--format", "{{json .State}}", custody["id"]] and seconds == 2 and not cleanup
                    payload, ok = b'{"Status":"exited","ExitCode":0,"OOMKilled":false,"Error":""}', True
                elif identity.startswith("model-"):
                    model = identity[len("model-"):]
                    custody = next(row for row in owner.containers if row["name"] == owner.name + "-" + model)
                    assert inherited and argv == ["/usr/bin/docker", "start", "--attach", custody["id"]] and seconds == 5 and not cleanup
                    state["modelStarts"].append(model)
                    payload = {"policy": b"Native policy modeled controls passed: 83; structural checks: 1; policy installs: 0\n",
                        "installer": b"Native installer modeled cases passed: 35; kernel installs: 0\n",
                        "state": b"Native lifecycle modeled checks passed: 1; kernel observer calls: 0\n"}[model]
                    ok = True
                elif identity == "final-container-census":
                    assert argv == ["/usr/bin/docker", "ps", "--all", "--quiet", "--filter", "label=com.pdaa.modeled=" + owner.name]
                    assert seconds == 3 and cleanup
                    payload, ok = ((container_id + "\n").encode() if any(not row["removed"] for row in owner.containers) else b""), True
                    if name == "census-failure":
                        state["faultReached"] = True
                        payload = b"UNEXPECTED_MODELED_OWNED_CONTAINER\n"
                else:
                    raise AssertionError("unexpected supplied command: " + identity)
                row = dict(id=identity, argv=argv, status="ATTEMPTED", suppliedModeledResponse=True)
                owner.events.append(row)
                owner.save()
                row.update(status="PASSED" if ok else "FAILED", hostPid=111, returncode=0 if ok else 1)
                if capture_result is not None:
                    capture_result(row["status"], row["returncode"], payload)
                owner.write_receipt(identity + ".txt", payload)
                owner.save()
                if (name == "prerequisite-failure" and identity == "driver-controls") or \
                        (name == "host-control-result-grammar" and identity == "host-file-controls") or \
                        (name == "initial-inquiry-failure" and identity == "runtime-cache-initial") or \
                        (name in {"final-inquiry-failure", "final-json-failure"} and identity == "runtime-cache-final"):
                    # Delivery follows all supplied-boundary assertions and actual receipt calls.
                    state["faultDeliveries"].append(dict(id=identity, ok=ok, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True

                if name in NEW_GROUP_CASES and identity == grouped_target and name != "view-group-receipt-expiry":
                    state["faultDeliveries"].append(dict(id=identity, ok=ok, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True
                    if name == "view-group-return-expiry":
                        clock[0] = owner.deadline - 20
                if identity == "runtime-cache-initial" and name == "initial-return-expiry" or \
                        identity == "runtime-cache-final" and name == "final-return-expiry":
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                if name == "inherited-copy-worker-end" and identity == "copy-0":
                    state["faultReached"] = True
                    clock[0] = owner.transfer_ends["policy.o"]
                if name == "inherited-retirement-expiry" and identity == "remove-" + owner.name + "-build":
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                return ok, payload

            def decode(payload, is_initial):
                observation = dict(initial=is_initial, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
                state["decodes"].append(observation)
                try:
                    result = actual_decode(payload, is_initial)
                except BaseException as error:
                    observation.update(refused=True, type=type(error).__name__, reason=str(error))
                    raise
                observation["refused"] = False
                return result

            def archive(owner):
                state["archiveEntries"] += 1
                owner.guard()
                if name == "archive-failure":
                    state["faultReached"] = True
                    raise D.Refused("supplied archive boundary failed; no retrieval")
                return owner.fixture / "tools" / D.TOP

            def create_view(owner, original):
                state["viewEntries"] += 1
                owner.guard()
                original.mkdir(parents=True)
                values = {"zig": b"NONEXECUTABLE SYNTHETIC COMPILER BYTES\n", "lib/include/stddef.h": b"SYNTHETIC HEADER\n",
                          "lib/include/excluded.h": b"SYNTHETIC EXCLUSION\n"}
                entries = []
                for relative, payload in sorted(values.items()):
                    path = original / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(payload)
                    entries.append([relative, len(payload), hashlib.sha256(payload).hexdigest(), relative.endswith("excluded.h")])
                if name == "view-failure":
                    state["faultReached"] = True
                    (original / "lib/include/unplanned.h").write_bytes(b"unplanned")
                owner.view_builder = F.V.ToolView(original, owner.fixture / "tool-view", entries,
                    ["zig", "lib/include"], ["lib/include/stddef.h"], owner.guard)
                view = owner.view_builder.construct()
                owner.view_ready = object()
                owner.events.append(dict(id="supplied-minimal-control-view", production4876RowBodyExercised=False))
                owner.save()
                if name == "view-return-expiry":
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                return view

            def license_algorithm(owner, view):
                owner.guard()
                if name == "license-failure":
                    state["faultReached"] = True
                    raise D.Refused("supplied unchanged-license boundary refused")
                return {relative: dict(sha256=row[1]) for relative, row in owner.view_builder.included.items()}

            def model_boundary(owner, artifacts):
                state["modelEntries"] += 1
                owner.guard()
                if inherited:
                    return actual_inspect(owner, artifacts)
                owner.models_passed = True  # explicitly supplied model outcome, not actual model execution
                owner.events.append(dict(id="supplied-model-success-boundary", realModelExecutions=0))
                owner.save()

            def build_body(owner, view, licensed):
                state["currentOwner"] = owner
                container_name = owner.name + "-build"
                create = container_profile(owner, container_name)
                create += ["--mount", "type=bind,src=" + str(packet / "native") + ",dst=/src,readonly",
                           "--mount", "type=bind,src=" + str(view) + ",dst=/tool,readonly",
                           "--entrypoint", "/usr/local/bin/node", D.IMAGE, "-e", "setInterval(()=>{},1000)"]
                state["expectedCreate"] = list(create)
                if inherited:
                    return actual_build(owner, view, licensed)
                assert owner.docker_base(container_name) == container_profile(owner, container_name)
                assert owner.create(container_name, "build-create", create)
                assert owner.containers[-1]["id"] == container_id  # real capture_result custody
                assert owner.command("build-start", ["/usr/bin/docker", "start", container_id], 5)[0]
                if name == "wrong-container":
                    state["faultReached"] = True
                    owner.snapshot_cache("b" * 64, initial=True)
                if name in {"snapshot-without-license", "snapshot-without-readiness", "snapshot-after-removal", "final-before-initial"}:
                    state["faultReached"] = True
                    if name == "snapshot-without-license":
                        owner.license_passed = False  # supplied invalid state at the actual snapshot boundary
                    elif name == "snapshot-without-readiness":
                        owner.view_ready = None
                    elif name == "snapshot-after-removal":
                        owner.remove(container_name)
                    owner.snapshot_cache(container_id, initial=name != "final-before-initial")
                execute = ["/usr/bin/docker", "exec", "--workdir", "/work", container_id]
                assert owner.command("compiler-version", execute + ["/tool/zig", "version"], 5)[0]
                if name == "repeat-initial":
                    state["faultReached"] = True
                    owner.snapshot_cache(container_id, initial=True)
                producer_order = list(F.COMPILE_PRODUCERS[1:]) + ["link-" + model for model in D.LINKS]
                if name == "wrong-producer-order":
                    state["faultReached"] = True
                    producer_order[-2], producer_order[-1] = producer_order[-1], producer_order[-2]
                for identity in producer_order:
                    if name == "missing-producer" and identity == "compile-policy":
                        state["faultReached"] = True
                        continue
                    request, limit = producer_request(identity, execute)
                    if identity == "compile-policy" and name.startswith("compile-boundary-"):
                        state["faultReached"] = True
                        if name == "compile-boundary-unlicensed":
                            owner.license_passed = False
                        elif name == "compile-boundary-unready":
                            owner.view_ready = None
                        elif name == "compile-boundary-no-initial":
                            owner.cache_initial = None
                        elif name == "compile-boundary-final-present":
                            owner.cache_final = {}
                        elif name == "compile-boundary-wrong-container":
                            owner.cache_initial = dict(container="b" * 64)
                        elif name == "compile-boundary-retired":
                            owner.remove(container_name)
                        else:
                            raise AssertionError("unexpected compile-boundary control")
                    if identity == "compile-policy" and name in {"compile-vector-missing-linker-option", "compile-vector-duplicate-linker-option", "compile-vector-wrong-source"}:
                        state["faultReached"] = True
                        if name == "compile-vector-missing-linker-option":
                            request.remove("-fuse-ld=lld")
                        elif name == "compile-vector-duplicate-linker-option":
                            request.append("-fuse-ld=lld")
                        else:
                            request[request.index("/src/" + D.BASE + "policy.c")] = "/src/" + D.BASE + "state.c"
                    assert owner.command(identity, request, limit)[0]
                if name == "wrong-producer-order":
                    state["faultReached"] = True
                artifacts = owner.fixture / "artifacts"
                artifacts.mkdir(mode=0o755)
                assert owner.command("artifact-source-snapshot", execute + ["/usr/local/bin/node", "-e", F.fixed_source_snapshot_script()], 5)[0]
                if name == "repeat-final":
                    state["faultReached"] = True
                    owner.snapshot_cache(container_id, initial=False)
                for index, row in enumerate(source_rows):
                    path = artifacts / row["name"]
                    assert owner.command("copy-" + str(index), ["/usr/bin/docker", "cp", container_id + ":/work/" + row["name"], str(path)], 3)[0]
                    assert owner.artifact_copy_valid(path, row)
                owner.remove(container_name)  # actual inspect/capture/remove custody before reconciliation
                owner.after_build_retirement(artifacts)
                for path in owner.artifact_paths(artifacts):
                    owner.artifact_mode(path, 0o555 if path.name.endswith("-model") else 0o444)
                owner.after_artifact_modes(artifacts)
                owner.inspect_then_models(artifacts)

            def save(owner):
                result = actual_save(owner)
                if name == "cache-ready-save-expiry" and owner.cache_initial is not None and owner.cache_final is None and not state["faultReached"]:
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                if name in ("inherited-copy-save-end", "inherited-copy-settlement-end") and not state["faultReached"] and "policy.o" in owner.transfer_reports:
                    settled = "policy.o" in owner.transfer_verified
                    if settled is (name == "inherited-copy-settlement-end"):
                        state["faultReached"] = True
                        clock[0] = owner.transfer_ends["policy.o"]
                return result

            def copy_valid(owner, path, row):
                result = actual_copy_valid(owner, path, row)
                state["sourceCopyChecks"].append(row["name"])
                return result

            def artifact_hash(owner, path):
                state["hashEntries"].append((path.name, owner.artifact_retired, len(owner.containers)))
                if name in ("inherited-first-model-hash-expiry", "inherited-second-model-hash-expiry") and path.name == "policy-model" and owner.artifact_retired:
                    target_count = 1 if name == "inherited-first-model-hash-expiry" else 2
                    observed = sum(leaf == "policy-model" and retired for leaf, retired, _ in state["hashEntries"])
                    if observed == target_count:
                        state["faultReached"] = True
                        clock[0] = owner.deadline - 20
                return actual_artifact_hash(owner, path)

            def is_file(path):
                result = raw_is_file(path)
                if name == "inherited-source-dependency-expiry" and path == packet / "native" / (D.BASE + "policy.c") and state["owners"] == []:
                    # Manifest authentication also probes this path. Only the
                    # actual post-publication dependency phase may deliver it.
                    if state.get("currentOwner") is not None and state["currentOwner"].artifact_directory_published:
                        state["metadataProbes"].append(str(path))
                        state["faultReached"] = True
                        clock[0] = state["currentOwner"].deadline - 20
                return result

            def cleanup(owner):
                state["owners"].append(owner)
                state["cleanupEntries"].append(dict(failed=owner.failed, success=owner.success, terminal=owner.terminal_complete))
                state["phase"] = "CLEANUP"
                result = actual_cleanup(owner)
                if name == "after-cleanup-expiry":
                    state["faultReached"] = True
                    clock[0] = owner.deadline
                return result

            def finalize(owner):
                state["finalizers"] += 1
                state["phase"] = "FINALIZE"
                return actual_finalize(owner)

            def write(path, payload):

                if name == "view-group-receipt-expiry" and path == fixture / "receipts/view-controls-g01.txt":
                    result = raw_write(path, payload)
                    state["faultDeliveries"].append(dict(id="view-controls-g01", ok=True, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True
                    clock[0] = state["prerequisiteOwner"].deadline - 20
                    return result
                target_phase = "CLEANUP" if name.startswith("cleanup-write-") or name == "cleanup-save-expiry" else "FINALIZE"
                targeted = path == fixture / "receipts/attempt.json" and state["phase"] == target_phase and \
                    (name.startswith("cleanup-write-") or name.startswith("terminal-write-") or name in {"cleanup-save-expiry", "terminal-save-expiry"})
                if not targeted:
                    return raw_write(path, payload)
                state["raw"].append(dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
                                         payload=payload, prefix=payload[:1], oldBytes=path.stat().st_size if path.exists() else 0))
                if len(state["raw"]) > 1:
                    return raw_write(path, payload)  # independently counted, never an unobserved retry
                state["faultReached"] = True
                if name.endswith("-short"):
                    return raw_write(path, payload[:1])
                if name.endswith("-partial"):
                    raw_write(path, payload[:1])
                    raise OSError("supplied partial receipt uncertainty")
                if name.endswith("-full-throw"):
                    raw_write(path, payload)
                    raise OSError("supplied full receipt uncertainty")
                result = raw_write(path, payload)
                clock[0] = state["owners"][0].deadline
                return result

            env = dict(GITHUB_WORKSPACE=str(workspace), RUNNER_TEMP=str(runner_temp), GITHUB_REPOSITORY="APReddy-AutoBotz/Project-Delivery-Agent",
                       GITHUB_REF="refs/heads/codex/native-modeled-research-v9", GITHUB_RUN_ID="87654321", GITHUB_RUN_ATTEMPT="1",
                       PDAA_PACKET_SHA256=hashlib.sha256(packet_bytes).hexdigest(), GITHUB_SHA="MODELED_NO_PUBLICATION")
            error = None
            with patch.dict(os.environ, env), patch.object(sys, "argv", [str(packet / "filtered_driver.py"), str(packet)]), \
                 patch.object(D.time, "monotonic", side_effect=lambda: clock[0]), \
                 patch.object(D.subprocess, "Popen", side_effect=AssertionError("real process entry prohibited")) as process, \
                 patch.object(D.urllib.request, "build_opener", side_effect=AssertionError("real archive entry prohibited")) as network, \
                 patch.object(D.Attempt, "command", checked(command)), patch.object(D.Attempt, "download_extract", checked(archive)), \
                 patch.object(F.C, "decode", checked(decode)), \
                 patch.object(F.FilteredAttempt, "create_view", checked(create_view)), patch.object(D.Attempt, "licenses", checked(license_algorithm)), \
                 patch.object(D.Attempt, "build", checked(build_body)), patch.object(D.Attempt, "inspect_then_models", checked(model_boundary)), \
                 patch.object(F.FilteredAttempt, "cleanup_after_attempt", checked(cleanup)), patch.object(F.FilteredAttempt, "finalize", checked(finalize)), \
                 patch.object(F.FilteredAttempt, "save", checked(save)), patch.object(Path, "write_bytes", checked(write)), \
                 patch.object(F.FilteredAttempt, "artifact_copy_valid", checked(copy_valid)), \
                 patch.object(F.FilteredAttempt, "artifact_hash", checked(artifact_hash)), patch.object(Path, "is_file", checked(is_file)):
                try:
                    F.main()
                except BaseException as caught:
                    error = caught
                assert process.call_count == network.call_count == 0
            assert state["callbackErrors"] == [], (name, state["callbackErrors"])
            assert len(state["owners"]) == len(state["cleanupEntries"]) == 1, (name, str(error), state)
            owner = state["owners"][0]
            command_ids = [row[0] for row in state["commands"]]
            assert owner.deadline == owner.started + 600 and owner.receipt_bytes == sum(owner.receipt_verified.values()) + sum(owner.receipt_uncertain.values())
            receipt_path = owner.receipts / ("modeled-failure.json" if "attempt.json" in owner.receipt_uncertain else "attempt.json")
            receipt = json.loads(receipt_path.read_text())
            assert receipt["nativeQualification"] is receipt["applicationCopy"] is False
            if name in {"ownership-refusal", "remove-failure"}:
                assert len(owner.containers) == 1 and owner.containers[0]["removeAttempted"] and not owner.containers[0]["removed"]
            else:
                assert all(row["removed"] and row["removeAttempted"] for row in owner.containers)
            if inherited:
                assert owner.deadline == owner.started + 600 and owner.receipt_bytes == sum(owner.receipt_verified.values()) + sum(owner.receipt_uncertain.values())
                if name == "inherited-healthy":
                    assert error is None and owner.terminal_complete and owner.success and not owner.failed
                    assert state["modelEntries"] == state["finalizers"] == 1 and state["modelStarts"] == list(D.LINKS)
                    assert receipt["status"] == "PASS_FILTERED_MODELED_ONLY" and len(owner.containers) == 4
                    assert state["sourceCopyChecks"] == list(F.T.NAMES) and len(state["workerEntries"]) == 18
                    assert [leaf for leaf, retired, _ in state["hashEntries"] if retired] == [model + "-model" for model in D.LINKS for _ in range(2)]
                    assert not owner.transfer_unsettled and set(owner.transfer_verified) == set(F.T.NAMES)
                    assert owner.artifact_retired and owner.artifact_directory_published and not owner.host_files.unsafe() and not owner.host_files.failed
                    assert len(state["decodes"]) == 3 and not any(row["refused"] for row in state["decodes"])
                else:
                    assert state["faultReached"] and error is not None and owner.failed and not owner.success and not owner.terminal_complete
                    assert receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE" and state["finalizers"] == 0
                    assert state["cleanupEntries"][0]["failed"] and not state["modelStarts"]
                    if name.startswith("inherited-elf-bad-"):
                        assert type(error) is D.Refused and str(error) == "ELF hashes bind actual independently verified source artifacts"
                        assert state["modelEntries"] == 1 and len(owner.containers) == 1
                        assert not any(identity.startswith("model-create-") for identity in command_ids)
                    elif name in ("inherited-copy-worker-end", "inherited-copy-save-end", "inherited-copy-settlement-end"):
                        expected = {"inherited-copy-worker-end": "original copy end after worker",
                            "inherited-copy-save-end": "original copy end after transfer receipt",
                            "inherited-copy-settlement-end": "original copy end after closed verification and receipt"}[name]
                        assert type(error) is D.Refused and str(error) == expected
                        assert clock[0] == owner.transfer_ends["policy.o"] == owner.started + 2.5
                        assert owner.transfer_attempts == ["policy.o"] and owner.transfer_unsettled == {"policy.o": source_rows[0]["bytes"]}
                        assert owner.transfer_charged == source_rows[0]["bytes"] and not owner.transfer_verified and state["sourceCopyChecks"] == []
                        assert len(state["workerEntries"]) == 1 and state["modelEntries"] == 0 and not owner.host_files.unsafe()
                        assert not any(identity in command_ids for identity in ("copy-1", "elf-inspection", "model-create-policy"))
                    else:
                        assert type(error) is D.Refused and str(error) == "research deadline" and clock[0] == owner.deadline - 20
                        assert len(state["workerEntries"]) == 18 and not owner.transfer_unsettled
                        if name == "inherited-retirement-expiry":
                            assert not owner.artifact_retired and owner.artifact_mode_attempts == [] and not owner.host_files.census_attempted
                            assert state["modelEntries"] == 0 and owner.host_files.operations == 18
                        elif name == "inherited-source-dependency-expiry":
                            assert state["metadataProbes"] == [str(packet / "native" / (D.BASE + "policy.c"))]
                            assert state["modelEntries"] == 0 and "elf-inspection" not in command_ids and owner.artifact_directory_published
                        else:
                            assert name in ("inherited-first-model-hash-expiry", "inherited-second-model-hash-expiry")
                            assert state["modelEntries"] == 1 and len(owner.containers) == (1 if name.startswith("inherited-first") else 2)
                            assert command_ids.count("model-create-policy") == (0 if name.startswith("inherited-first") else 1)
                            assert command_ids.count("model-policy") == 0
                # Control-owned fixture teardown happens after every evidence
                # assertion and does not alter subject witnesses or clocks.
                directory = owner.fixture / "artifacts"
                if directory.exists():
                    directory.chmod(0o700)
                complete(name)
                return

            if name in NEW_GROUP_CASES:
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete
                assert state["faultReached"] and len(state["faultDeliveries"]) == 1
                target = ("filtered-controls-f08" if name == "filtered-group-wrong-membership" else
                          "view-controls-g11" if name == "view-group-incomplete-last" else "view-controls-g01")
                index = next(i for i, row in enumerate(scripts) if row[0] == target)
                assert command_ids == [row[0] for row in scripts[:index + 1]]
                delivered = state["faultDeliveries"][0]
                assert delivered["id"] == target
                original_output = (owner.receipts / (target + ".txt")).read_bytes()
                assert len(original_output) == delivered["bytes"] and hashlib.sha256(original_output).hexdigest() == delivered["sha256"]
                assert state["archiveEntries"] == state["viewEntries"] == state["modelEntries"] == state["finalizers"] == 0
                assert state["workerEntries"] == state["sourceCopyChecks"] == [] and owner.containers == []
                assert state["cleanupEntries"][0]["failed"] and receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE"
                assert not any(row.get("id") == "prerequisite-control-coverage" for row in receipt["events"])
                if name in ("view-group-return-expiry", "view-group-receipt-expiry"):
                    assert type(error) is D.Refused and str(error) == "research deadline"
                    assert clock[0] == owner.deadline - 20
                elif name == "view-group-command-failure":
                    assert type(error) is D.Refused and str(error) == "filtered fixed prerequisite controls command failed"
                    assert delivered["ok"] is False
                elif name == "view-group-duplicate-key":
                    assert type(error) is F.T.Refused and str(error) == "ADMISSION"
                elif name == "view-group-malformed-json":
                    assert type(error) is json.JSONDecodeError and error.msg == "Expecting property name enclosed in double quotes"
                else:
                    assert type(error) is D.Refused and str(error) == "complete supplied grouped controls result"
                complete(name)
                return
            if name == "healthy":
                assert error is None and owner.terminal_complete and owner.success and not owner.failed
                assert state["modelEntries"] == state["finalizers"] == 1 and receipt["status"] == "PASS_FILTERED_MODELED_ONLY"
                assert [row[0] for row in state["commands"][:len(scripts)]] == [r[0] for r in scripts]
                assert owner.view_builder.completed and owner.cache_initial and owner.cache_final
                assert owner.cache_pre_final and owner.reader_controls_passed and owner.runtime_inputs == [
                    next(row for row in final["files"] if row["path"] == path) for path in runtime_paths]
                assert state["sourceCopyChecks"] == list(F.T.NAMES) and len(state["workerEntries"]) == 18
                assert owner.transfer_charged == sum(row["bytes"] for row in source_rows) and not owner.transfer_unsettled
                assert set(owner.transfer_verified) == set(F.T.NAMES) and owner.artifact_retired and owner.artifact_directory_published
                assert not owner.host_files.failed and not owner.host_files.unsafe() and owner.host_files.opaque_directory_slots == 1
            else:
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete, (name, error, state)
                assert receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE"
                assert state["faultReached"], (name, error, state)
                if name in {"prerequisite-failure", "initial-inquiry-failure", "final-inquiry-failure", "final-json-failure"}:
                    assert len(state["faultDeliveries"]) == 1
                    delivered = state["faultDeliveries"][0]
                    if name == "prerequisite-failure":
                        assert delivered["id"] == "driver-controls" and delivered["ok"] is False
                        assert type(error) is D.Refused and str(error) == "filtered fixed prerequisite controls command failed"
                        assert state["decodes"] == []
                    elif name in {"initial-inquiry-failure", "final-inquiry-failure"}:
                        assert delivered["id"] == ("runtime-cache-initial" if name.startswith("initial") else "runtime-cache-final")
                        assert delivered["ok"] is False and type(error) is D.Refused
                        assert str(error) == "bounded fixed runtime cache inquiry failed"
                        assert len(state["decodes"]) == (0 if name.startswith("initial") else 2)
                        assert all(not row["refused"] for row in state["decodes"])
                        if name.startswith("final"):
                            assert [row["initial"] for row in state["decodes"]] == [True, False]
                    else:
                        assert delivered["id"] == "runtime-cache-final" and delivered["ok"] is True
                        assert type(error) is ValueError and str(error) == "cache duplicate decoded JSON key"
                        assert len(state["decodes"]) == 3 and state["decodes"][0]["initial"] and not state["decodes"][0]["refused"]
                        assert state["decodes"][1]["initial"] is False and not state["decodes"][1]["refused"]
                        observed = state["decodes"][-1]
                        assert observed["initial"] is False and observed["refused"] is True and observed["type"] == "ValueError"
                        assert observed["reason"] == "cache duplicate decoded JSON key"
                        assert observed["sha256"] == delivered["sha256"] and observed["bytes"] == delivered["bytes"]
                late = name.startswith(("cleanup-write-", "terminal-write-")) or name in {"after-cleanup-expiry", "cleanup-save-expiry", "terminal-save-expiry", "census-failure"}
                assert state["cleanupEntries"][0]["failed"] is (not late), (name, state["cleanupEntries"])
                if name.startswith(("cleanup-write-", "terminal-write-")):
                    assert len(state["raw"]) == 1 and "attempt.json" in owner.receipt_uncertain
                    assert owner.receipt_verified["attempt.json"] == state["raw"][0]["oldBytes"]
                    assert owner.receipt_uncertain["attempt.json"] == state["raw"][0]["bytes"]
                    original = (owner.receipts / "attempt.json").read_bytes()
                    if name.endswith(("-short", "-partial")):
                        assert original == state["raw"][0]["prefix"] and len(original) == 1
                    else:
                        assert original == state["raw"][0]["payload"] and len(original) == state["raw"][0]["bytes"]
                        assert hashlib.sha256(original).hexdigest() == state["raw"][0]["sha256"]
                if name.startswith("cleanup-write-"):
                    assert state["finalizers"] == 0
                if name in {"ownership-refusal", "remove-failure", "census-failure"}:
                    assert state["finalizers"] == 0
                    assert command_ids.count("inspect-owner-" + owner.name + "-build") == 1
                    assert command_ids.count("remove-" + owner.name + "-build") == (0 if name == "ownership-refusal" else 1)
                    assert command_ids.count("final-container-census") == 1
                if not late:
                    assert state["modelEntries"] == state["finalizers"] == 0
                else:
                    assert state["modelEntries"] == 1
                    assert state["finalizers"] == (0 if name.startswith("cleanup-write-") or name == "census-failure" else 1)
                if name == "prerequisite-failure":
                    assert state["archiveEntries"] == state["viewEntries"] == 0
                if name == "host-control-result-grammar":
                    assert type(error) is D.Refused and str(error) == "complete supplied private-file controls result"
                    assert state["archiveEntries"] == state["viewEntries"] == 0 and state["workerEntries"] == []
                    assert command_ids == [row[0] for row in scripts if row[1] != "filtered_controls.py"] and len(state["faultDeliveries"]) == 1
                if name.startswith("compile-vector-"):
                    assert type(error) is D.Refused and str(error) == "fixed original compile-only argument vector"
                    assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                        "reader-controls", "compiler-version", "clang-version", "inspect-owner-" + owner.name + "-build",
                        "remove-" + owner.name + "-build", "final-container-census"]
                    assert owner.cache_initial is not None and owner.cache_final is None
                    assert not any(identity.startswith(("compile-", "link-")) for identity in command_ids)
                if name.startswith("compile-boundary-"):
                    assert type(error) is D.Refused and str(error) == "fixed compile-only licensed owned-container boundary"
                    assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                        "reader-controls", "compiler-version", "clang-version", "inspect-owner-" + owner.name + "-build",
                        "remove-" + owner.name + "-build", "final-container-census"]
                    assert (owner.cache_initial is None) is (name == "compile-boundary-no-initial")
                    assert (owner.cache_final is not None) is (name == "compile-boundary-final-present")
                    if name == "compile-boundary-wrong-container":
                        assert owner.cache_initial["container"] == "b" * 64
                    assert not any(identity.startswith(("compile-", "link-")) for identity in command_ids)
                if name in {"wrong-container", "repeat-initial", "missing-producer", "initial-inquiry-failure", "final-inquiry-failure", "final-json-failure", "map-failure"}:
                    assert state["modelEntries"] == 0
                if name == "wrong-container":
                    assert command_ids.count("build-create") == command_ids.count("build-start") == 1
                    assert command_ids.count("runtime-cache-initial") == command_ids.count("compiler-version") == 0
                if name in {"snapshot-without-license", "snapshot-without-readiness", "snapshot-after-removal", "final-before-initial"}:
                    assert command_ids.count("runtime-cache-initial") == command_ids.count("runtime-cache-final") == 0
                    assert command_ids.count("compiler-version") == 0
                if name == "repeat-initial":
                    assert owner.cache_initial is not None and command_ids.count("runtime-cache-initial") == 1
                if name == "missing-producer":
                    assert owner.cache_initial is not None and command_ids.count("runtime-cache-final") == 0
                    assert command_ids.count("compile-policy") == 0
                if name == "wrong-producer-order":
                    observed = [identity for identity in command_ids if identity in F.PRODUCERS]
                    assert observed == list(F.COMPILE_PRODUCERS) + ["runtime-preparation", "link-policy"]
                    assert owner.link_requests == ["policy"] and type(error) is D.Refused
                    assert str(error) == "fixed final link dispatch order and original command cap"
                    assert command_ids.count("runtime-cache-final") == 0
                if name == "repeat-final":
                    assert owner.cache_final is not None and command_ids.count("runtime-cache-final") == 1
                if name == "initial-inquiry-failure":
                    assert command_ids.count("runtime-cache-initial") == 1 and owner.cache_initial is None
                    assert command_ids.count("compiler-version") == 0
                if name in {"final-inquiry-failure", "final-json-failure"}:
                    assert command_ids.count("runtime-cache-final") == 1 and owner.cache_final is None
                    assert command_ids.count("artifact-source-snapshot") == 0
                if name == "map-failure":
                    assert owner.cache_final is not None and command_ids.count("artifact-source-snapshot") == 1
                if "expiry" in name:
                    assert type(error) is D.Refused and str(error) == "research deadline", (name, error, state)
                    assert clock[0] == owner.deadline - (0 if late else 20), "test must not repair or extend the exact crossed clock"
                    if name == "view-return-expiry":
                        assert command_ids == [row[0] for row in scripts]
                        assert state["archiveEntries"] == state["viewEntries"] == 1 and owner.view_builder.completed
                        assert not owner.license_passed and owner.cache_initial is owner.cache_final is None
                    elif name in {"initial-return-expiry", "cache-ready-save-expiry"}:
                        assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                            "inspect-owner-" + owner.name + "-build", "remove-" + owner.name + "-build", "final-container-census"]
                        assert (owner.cache_initial is not None) is (name == "cache-ready-save-expiry") and owner.cache_final is None
                        assert len(state["decodes"]) == 1 and state["decodes"][0]["initial"] and not state["decodes"][0]["refused"]
                    else:
                        producers = ["build-create", "build-start", "runtime-cache-initial", "reader-controls"] + list(F.COMPILE_PRODUCERS)
                        producers += ["runtime-preparation", "runtime-cache-pre-final"] + ["link-" + model for model in D.LINKS] + ["runtime-cache-final"]
                        if name != "final-return-expiry":
                            producers += ["artifact-source-snapshot"]
                        if late:
                            producers += ["copy-" + str(index) for index in range(18)]
                        assert command_ids == [row[0] for row in scripts] + producers + [
                            "inspect-owner-" + owner.name + "-build", "remove-" + owner.name + "-build", "final-container-census"]
                        assert owner.cache_initial is not None and (owner.cache_final is not None) is (name != "final-return-expiry")
                        assert len(state["decodes"]) == 3 and not any(row["refused"] for row in state["decodes"])
                        if name == "cleanup-save-expiry":
                            assert len(state["raw"]) == 3 and not owner.receipt_uncertain
                        if name == "terminal-save-expiry":
                            assert len(state["raw"]) == 2 and not owner.receipt_uncertain
            complete(name)
            directory = owner.fixture / "artifacts"
            if directory.exists():
                directory.chmod(0o700)

        for name in ("healthy", "prerequisite-failure", "archive-failure", "view-failure", "license-failure", "wrong-container",
                     "repeat-initial", "missing-producer", "initial-inquiry-failure", "final-inquiry-failure", "final-json-failure", "map-failure",
                     "snapshot-without-license", "snapshot-without-readiness", "snapshot-after-removal", "final-before-initial", "wrong-producer-order", "repeat-final",
                     "ownership-refusal", "remove-failure", "census-failure",
                     "compile-vector-missing-linker-option", "compile-vector-duplicate-linker-option", "compile-vector-wrong-source",
                     "compile-boundary-unlicensed", "compile-boundary-unready", "compile-boundary-no-initial",
                     "compile-boundary-final-present", "compile-boundary-wrong-container", "compile-boundary-retired",
                     "cleanup-write-short", "cleanup-write-partial", "cleanup-write-full-throw",
                     "terminal-write-short", "terminal-write-partial", "terminal-write-full-throw",
                     "view-return-expiry", "initial-return-expiry", "final-return-expiry", "cache-ready-save-expiry",
                     "after-cleanup-expiry", "cleanup-save-expiry", "terminal-save-expiry"):
            scenario(name)
        scenario("inherited-healthy")
        scenario("host-control-result-grammar")
        for leaf in tuple(unit + ".o" for unit in D.UNITS) + tuple(model + "-model" for model in D.LINKS):
            scenario("inherited-elf-bad-" + leaf)
        for name in ("inherited-copy-worker-end", "inherited-copy-save-end", "inherited-copy-settlement-end",
                     "inherited-retirement-expiry", "inherited-source-dependency-expiry",
                     "inherited-first-model-hash-expiry", "inherited-second-model-hash-expiry"):
            scenario(name)
        for name in NEW_GROUP_CASES:
            scenario(name)
    assert tuple(completed) == selected and count == len(selected)
    return dict(schema=1, status="SUPPLIED_FILTERED_DRIVER_CONTROLS_PASS", group=group, cases=count,
                names=completed, realExternalInvocations=0, nativeQualification=False)


if __name__ == "__main__":
    assert len(sys.argv) == 3
    print(json.dumps(run(Path(sys.argv[1]), sys.argv[2]), separators=(",", ":"), sort_keys=True))
