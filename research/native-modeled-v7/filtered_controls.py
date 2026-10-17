"""Modeled wrapper callthrough. All external responses below are supplied.

Production create_view, unchanged license algorithm, compiler/image/archive and
inherited ELF/model bodies are explicitly substituted. No native evidence.
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


def run(owned):
    count = 0
    with tempfile.TemporaryDirectory(prefix="filtered-modeled-", dir=owned) as temporary:
        parent = Path(temporary)
        workspace = parent / "workspace"
        packet = workspace / "research/native-modeled-v7"
        packet.mkdir(parents=True)
        source = Path(__file__).resolve().parent
        manifest = json.loads((source / "packet.json").read_text())
        assert manifest["schema"] == 1 and len(manifest["files"]) == 23
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
        actual_decode = F.C.decode
        raw_write = Path.write_bytes
        initial = dict(schema=1, stage="INITIAL_EMPTY", roots=["/work/local-cache", "/work/global-cache"],
                       files=[], directories=[], totalBytes=0)
        final = dict(schema=1, stage="FINAL_AFTER_FIXED_PRODUCERS", roots=["/work/local-cache", "/work/global-cache"],
                     files=[dict(path="/work/global-cache/libc.a", bytes=5, sha256=hashlib.sha256(b"model").hexdigest())],
                     directories=["/work/global-cache"], totalBytes=5)
        container_id = "a" * 64
        scripts = (("driver-controls", "driver_controls.py", b"Driver modeled controls passed: 306; network/process/container calls: 0\n"),
                   ("view-controls", "view_controls.py", b"Tool view controls passed: 66; compiler/image/native calls: 0\n"),
                   ("cache-controls", "cache_controls.py", b"Cache controls passed: 59; compiler/image/native calls: 0\n"),
                   ("elf-controls", "elf_controls_v2.py", b"ELF modeled controls passed: 1; native executions: 0\n"),
                   ("filtered-controls", "filtered_controls.py", b"Filtered driver controls passed: 43; real external calls: 0\n"))

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
            runner_temp = parent / name
            runner_temp.mkdir()
            fixture = runner_temp / "pdaa-native-modeled-v7"
            clock = [1000.0]
            state = dict(phase="BODY", commands=[], owners=[], cleanupEntries=[], finalizers=0, modelEntries=0,
                         archiveEntries=0, viewEntries=0, raw=[], decodes=[], faultDeliveries=[], faultReached=False, expectedCreate=None)

            def command(owner, identity, argv, seconds, cleanup=False, capture_result=None):
                state["commands"].append((identity, list(argv), seconds, cleanup))  # every entry before response/refusal
                owner.guard(0 if cleanup else 20)
                D.check(not any(e.get("id") == identity for e in owner.events), "modeled command identity reused")
                matching = [row for row in scripts if row[0] == identity]
                if matching:
                    index = scripts.index(matching[0])
                    assert [c[0] for c in state["commands"][:index + 1]] == [r[0] for r in scripts[:index + 1]]
                    assert argv == [sys.executable, "-I", "-S", "-B", str(packet / matching[0][1]), str(owner.fixture)]
                    assert seconds == 5 and not cleanup and capture_result is None
                    payload = matching[0][2]
                    ok = name != "prerequisite-failure"
                elif identity == "build-create":
                    assert argv == state["expectedCreate"] and seconds == 5 and not cleanup and capture_result is not None
                    payload, ok = (container_id + "\n").encode(), True
                elif identity == "build-start":
                    assert argv == ["/usr/bin/docker", "start", container_id] and seconds == 5 and not cleanup
                    payload, ok = b"modeled-start\n", True
                elif identity in ("runtime-cache-initial", "runtime-cache-final"):
                    first = identity.endswith("initial")
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                                    "/usr/local/bin/node", "-e", F.C.INITIAL_SCRIPT if first else F.C.FINAL_SCRIPT]
                    assert seconds == 5 and not cleanup and capture_result is None
                    payload = json.dumps(initial if first else final, separators=(",", ":")).encode()
                    ok = name != ("initial-inquiry-failure" if first else "final-inquiry-failure")
                    if not first and name == "final-json-failure":
                        payload = payload.replace(b'"schema":1', b'"schema":1,"schema":1', 1)
                elif identity in F.PRODUCERS:
                    expected, limit = producer_request(identity, ["/usr/bin/docker", "exec", "--workdir", "/work", container_id], delivered=True)
                    assert argv == expected and seconds == limit and not cleanup and capture_result is None
                    if identity.startswith("compile-"):
                        assert "-fuse-ld=lld" not in argv and "-Werror" in argv and "-c" in argv
                    if identity.startswith("link-"):
                        assert argv.count("-fuse-ld=lld") == 1 and "-c" not in argv
                    payload, ok = b"explicitly supplied modeled compiler outcome\n", True
                elif identity == "artifact-source-snapshot":
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                                    "/usr/local/bin/node", "-e", "MODELED ARTIFACT BODY NEVER EXECUTED"]
                    payload, ok = b"[]\n", True
                elif identity == "inspect-owner-" + owner.name + "-build":
                    assert argv == ["/usr/bin/docker", "inspect", "--format", '{{.Id}} {{index .Config.Labels "com.pdaa.modeled"}}', container_id]
                    assert seconds == 2 and cleanup
                    payload, ok = (container_id + " " + owner.name + "\n").encode(), True
                    if name == "ownership-refusal":
                        state["faultReached"] = True
                        payload = (container_id + " wrong-modeled-label\n").encode()
                elif identity == "remove-" + owner.name + "-build":
                    assert argv == ["/usr/bin/docker", "rm", "--force", container_id] and seconds == 3 and cleanup
                    payload, ok = b"modeled-removed\n", True
                    if name == "remove-failure":
                        state["faultReached"] = True
                        ok = False
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
                        (name == "initial-inquiry-failure" and identity == "runtime-cache-initial") or \
                        (name in {"final-inquiry-failure", "final-json-failure"} and identity == "runtime-cache-final"):
                    # Delivery follows all supplied-boundary assertions and actual receipt calls.
                    state["faultDeliveries"].append(dict(id=identity, ok=ok, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True
                if identity == "runtime-cache-initial" and name == "initial-return-expiry" or \
                        identity == "runtime-cache-final" and name == "final-return-expiry":
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
                owner.events.append(dict(id="supplied-minimal-control-view", production4875RowBodyExercised=False))
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
                owner.models_passed = True  # explicitly supplied model outcome, not actual model execution
                owner.events.append(dict(id="supplied-model-success-boundary", realModelExecutions=0))
                owner.save()

            def build_body(owner, view, licensed):
                container_name = owner.name + "-build"
                create = owner.docker_base(container_name)
                create += ["--mount", "type=bind,src=" + str(packet / "native") + ",dst=/src,readonly",
                           "--mount", "type=bind,src=" + str(view) + ",dst=/tool,readonly",
                           "--entrypoint", "/usr/local/bin/node", D.IMAGE, "-e", "setInterval(()=>{},1000)"]
                state["expectedCreate"] = list(create)
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
                producer_order = list(F.PRODUCERS[1:])
                if name == "wrong-producer-order":
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
                assert owner.command("artifact-source-snapshot", execute + ["/usr/local/bin/node", "-e", "MODELED ARTIFACT BODY NEVER EXECUTED"], 5)[0]
                if name == "repeat-final":
                    state["faultReached"] = True
                    owner.snapshot_cache(container_id, initial=False)
                owner.remove(container_name)  # actual inspect/capture/remove custody before reconciliation
                artifacts = owner.fixture / "modeled-artifacts"
                artifacts.mkdir()
                header = "VMA".rjust(16) + " " + "LMA".rjust(16) + "     Size Align Out     In      Symbol\n"
                for model, units in D.LINKS.items():
                    bodies = ["        /work/" + unit + ".o:(.text)" for unit in units]
                    bodies.append("        /work/global-cache/libc.a(member.o):(.text)")
                    if name == "map-failure":
                        state["faultReached"] = True
                        bodies.append("        relative.o:(.text)")
                    text = header + "".join(f"{0:16x} {0:16x} {1:8x} {1:5d} " + body + "\n" for body in bodies)
                    (artifacts / (model + ".map")).write_bytes(text.encode())
                owner.inspect_then_models(artifacts)

            def save(owner):
                result = actual_save(owner)
                if name == "cache-ready-save-expiry" and owner.cache_initial is not None and owner.cache_final is None and not state["faultReached"]:
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
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
                       GITHUB_REF="refs/heads/codex/native-modeled-research-v7", GITHUB_RUN_ID="87654321", GITHUB_RUN_ATTEMPT="1",
                       PDAA_PACKET_SHA256=hashlib.sha256(packet_bytes).hexdigest(), GITHUB_SHA="MODELED_NO_PUBLICATION")
            error = None
            with patch.dict(os.environ, env), patch.object(sys, "argv", [str(packet / "filtered_driver.py"), str(packet)]), \
                 patch.object(D.time, "monotonic", side_effect=lambda: clock[0]), \
                 patch.object(D.subprocess, "Popen", side_effect=AssertionError("real process entry prohibited")) as process, \
                 patch.object(D.urllib.request, "build_opener", side_effect=AssertionError("real archive entry prohibited")) as network, \
                 patch.object(D.Attempt, "command", command), patch.object(D.Attempt, "download_extract", archive), \
                 patch.object(F.C, "decode", decode), \
                 patch.object(F.FilteredAttempt, "create_view", create_view), patch.object(D.Attempt, "licenses", license_algorithm), \
                 patch.object(D.Attempt, "build", build_body), patch.object(D.Attempt, "inspect_then_models", model_boundary), \
                 patch.object(F.FilteredAttempt, "cleanup_after_attempt", cleanup), patch.object(F.FilteredAttempt, "finalize", finalize), \
                 patch.object(F.FilteredAttempt, "save", save), patch.object(Path, "write_bytes", write):
                try:
                    F.main()
                except BaseException as caught:
                    error = caught
                assert process.call_count == network.call_count == 0
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
            if name == "healthy":
                assert error is None and owner.terminal_complete and owner.success and not owner.failed
                assert state["modelEntries"] == state["finalizers"] == 1 and receipt["status"] == "PASS_FILTERED_MODELED_ONLY"
                assert [row[0] for row in state["commands"][:5]] == [r[0] for r in scripts]
                assert owner.view_builder.completed and owner.cache_initial and owner.cache_final
            else:
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete, (name, error, state)
                assert receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE"
                assert state["faultReached"], (name, error, state)
                if name in {"prerequisite-failure", "initial-inquiry-failure", "final-inquiry-failure", "final-json-failure"}:
                    assert len(state["faultDeliveries"]) == 1
                    delivered = state["faultDeliveries"][0]
                    if name == "prerequisite-failure":
                        assert delivered["id"] == "driver-controls" and delivered["ok"] is False
                        assert type(error) is D.Refused and str(error) == "filtered fixed prerequisite controls failed"
                        assert state["decodes"] == []
                    elif name in {"initial-inquiry-failure", "final-inquiry-failure"}:
                        assert delivered["id"] == ("runtime-cache-initial" if name.startswith("initial") else "runtime-cache-final")
                        assert delivered["ok"] is False and type(error) is D.Refused
                        assert str(error) == "bounded fixed runtime cache inquiry failed"
                        assert len(state["decodes"]) == (0 if name.startswith("initial") else 1)
                        assert all(row["initial"] and not row["refused"] for row in state["decodes"])
                    else:
                        assert delivered["id"] == "runtime-cache-final" and delivered["ok"] is True
                        assert type(error) is ValueError and str(error) == "cache duplicate decoded JSON key"
                        assert len(state["decodes"]) == 2 and state["decodes"][0]["initial"] and not state["decodes"][0]["refused"]
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
                if name.startswith("compile-vector-"):
                    assert type(error) is D.Refused and str(error) == "fixed original compile-only argument vector"
                    assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                        "compiler-version", "clang-version", "inspect-owner-" + owner.name + "-build",
                        "remove-" + owner.name + "-build", "final-container-census"]
                    assert owner.cache_initial is not None and owner.cache_final is None
                    assert not any(identity.startswith(("compile-", "link-")) for identity in command_ids)
                if name.startswith("compile-boundary-"):
                    assert type(error) is D.Refused and str(error) == "fixed compile-only licensed owned-container boundary"
                    assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                        "compiler-version", "clang-version", "inspect-owner-" + owner.name + "-build",
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
                    assert set(observed) == set(F.PRODUCERS) and observed != list(F.PRODUCERS)
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
                        producers = ["build-create", "build-start", "runtime-cache-initial"] + list(F.PRODUCERS) + ["runtime-cache-final"]
                        if name != "final-return-expiry":
                            producers += ["artifact-source-snapshot"]
                        assert command_ids == [row[0] for row in scripts] + producers + [
                            "inspect-owner-" + owner.name + "-build", "remove-" + owner.name + "-build", "final-container-census"]
                        assert owner.cache_initial is not None and (owner.cache_final is not None) is (name != "final-return-expiry")
                        assert len(state["decodes"]) == 2 and not any(row["refused"] for row in state["decodes"])
                        if name == "cleanup-save-expiry":
                            assert len(state["raw"]) == 3 and not owner.receipt_uncertain
                        if name == "terminal-save-expiry":
                            assert len(state["raw"]) == 2 and not owner.receipt_uncertain
            count += 1

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
    return count


if __name__ == "__main__":
    assert len(sys.argv) == 2
    print("Filtered driver controls passed: " + str(run(Path(sys.argv[1]))) + "; real external calls: 0")
