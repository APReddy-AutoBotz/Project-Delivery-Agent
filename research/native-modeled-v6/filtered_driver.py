"""EXEC-016/TR-DEP-004: fixed filtered compiler/model research entrypoint.

Source freeze and independent full-packet reviews govern any execution.
No operational/native qualification, application installation or license waiver.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent


def fixed_module(name, expected, identity):
    path = HERE / name
    if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise RuntimeError("exact reviewed filtered helper required: " + name)
    spec = importlib.util.spec_from_file_location(identity, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


D = fixed_module("host_driver.py", "1e762d24376b1ced6e3f5e23215e274e48f03051726eb5037d73d67d8f1802ad", "filtered_historical_driver")
V = fixed_module("tool_view.py", "ea790cd2d46172f3590b8598bfb3d6f5387d2e44b2fd8b03507c66bc01f4323e", "filtered_view_helper")
C = fixed_module("cache_provenance.py", "2ca9eda9c4e306b834c9dff39a75a32d7b6f207dd9fb3e8f3ea1c337ae841f8a", "filtered_cache_helper")
PLAN_SHA = "b19afad668740338215c525741339674d58b0204a9195eefc6f29a1596ae7aca"
PRODUCERS = ("compiler-version", "clang-version") + tuple("compile-" + unit for unit in D.UNITS) + tuple("link-" + name for name in D.LINKS)


class FilteredAttempt(D.Attempt):
    def __init__(self, packet, fixture):
        self.receipt_verified, self.receipt_uncertain = {}, {}
        self.view_builder = self.view_ready = None
        self.license_passed = self.finalization_attempted = self.terminal_complete = False
        self.cache_initial = self.cache_final = None
        super().__init__(packet, fixture)

    def write_receipt(self, name, payload, maximum=D.LIMIT):
        D.check(re.fullmatch(r"[a-z0-9-]+\.(?:json|txt)", name), "filtered owned receipt name")
        path = self.receipts / name
        D.check(name not in self.receipt_uncertain and (name in self.receipt_verified or not path.exists()),
                "filtered uncertain/unowned receipt cannot be rewritten")
        D.check(len(payload) <= maximum and self.receipt_bytes + len(payload) <= 16 * D.LIMIT,
                "filtered prospective receipt capacity")
        self.receipt_bytes += len(payload)
        self.receipt_uncertain[name] = len(payload)
        count = path.write_bytes(payload)
        D.check(count == len(payload), "filtered short receipt write")
        self.receipt_bytes -= self.receipt_verified.get(name, 0)
        self.receipt_verified[name] = len(payload)
        del self.receipt_uncertain[name]

    def save(self):
        if "attempt.json" in self.receipt_uncertain:
            self.failed, self.success, self.terminal_complete = True, False, False
        builder = self.view_builder
        value = dict(status="PASS_FILTERED_MODELED_ONLY" if self.terminal_complete and self.success and not self.failed else
                "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE", elapsedSeconds=D.time.monotonic() - self.started,
            events=self.events, containerCustody=self.containers, licenseGate=self.license_gate,
            licenseGatePassed=self.license_passed, modelsPassed=self.models_passed,
            compilerHostCommandEntryObserved=any(e.get("id") in PRODUCERS and e.get("hostPid") for e in self.events),
            finalizationAttempted=self.finalization_attempted, receiptUncertainties=dict(self.receipt_uncertain),
            view=None if builder is None else dict(completed=builder.completed, failed=builder.failed,
                chargedBytes=builder.charged, verifiedBytes=builder.verified, uncertainBytes=builder.uncertain,
                readChargedBytes=builder.read_charged, readVerifiedBytes=builder.read_verified,
                readUncertainBytes=builder.read_uncertain, payloadReads=builder.read_bytes,
                copiedFiles=builder.copied_files, acquisitions=builder.acquisitions,
                acquisitionPending=builder.acquisition_pending, acquisitionUncertainties=builder.acquisition_uncertainties,
                closeCount=builder.close_count, closeUncertainties=builder.close_uncertainties),
            nativeQualification=False, applicationCopy=False, acceptedStories="5/38 unchanged")
        payload = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
        self.write_receipt("modeled-failure.json" if "attempt.json" in self.receipt_uncertain else "attempt.json", payload)

    def create_view(self, original):
        self.guard()
        D.check(self.view_builder is None and original == self.fixture / "tools" / D.TOP,
                "fixed original quarantine and one view constructor")
        raw = (self.packet / "tool-view-identities.json").read_bytes()
        D.check(len(raw) == 583462 and hashlib.sha256(raw).hexdigest() == PLAN_SHA, "exact frozen literal view partition")
        plan = json.loads(raw)
        D.check(plan["selectedFiles"] == 4875 and plan["includedFiles"] == 4818 and plan["excludedFiles"] == 57 and
                plan["includedBytes"] == 214275122 and plan["excludedBytes"] == 422834 and len(plan["entries"]) == 4875,
                "fixed view partition capacities")
        inventory = json.loads((self.receipts / "tool-inventory.json").read_text())
        D.check(inventory["entries"] == 19363 and inventory["payloadBytes"] == 344238754 and
                inventory["compilerSha256"] == plan["compilerSha256"] ==
                "2858dc89dbbfdd08cceda1b841e7fd0a793a1a67b49f150bc3d0d1de44ed7f51", "fresh archive identity")
        notice = original / "LICENSE"
        D.check(not notice.is_symlink() and notice.is_file() and notice.stat().st_size == 1080 and
                D.sha(notice) == "5c537d6853e005298a285d508cff9ac7192cea23576c840d485b2b586a7ff177",
                "separate retained Zig publisher notice")
        self.guard()
        scope = json.loads((self.packet / "license-scope.json").read_text())
        builder = V.ToolView(original, self.fixture / "tool-view", plan["entries"],
                             [r["path"] for r in scope["roots"]], scope["requiredHeaders"], self.guard)
        self.view_builder = builder
        D.check(builder.total == 214275122 and len(builder.included) == 4818 and len(builder.dirs) == 365 and
                builder.read_capacity == 857542651, "fixed derived view schedule")
        view = builder.construct()
        self.guard()
        D.check(builder.completed and not builder.failed and view == self.fixture / "tool-view", "actual completed view required")
        self.view_ready = object()
        self.events.append(dict(id="filtered-view", status="COMPLETED_DERIVED_RESEARCH_VIEW_NO_LICENSE_ADMISSION",
            includedFiles=4818, excludedFiles=57, bytes=214275122, directories=365,
            identityManifestSha256=PLAN_SHA, originalEvidenceSealSha256=plan["originalEvidenceSealSha256"],
            rootNotice="Original quarantine only; outside exact4818view", originalQuarantineReadAsData=True))
        self.save()
        self.guard()
        return view

    def licenses(self, view):
        self.guard()
        D.check(self.view_ready is not None and self.view_builder.completed and view == self.view_builder.destination,
                "license gate accepts only completed fixed view")
        licensed = super().licenses(view)
        self.guard()
        D.check(set(licensed) == set(self.view_builder.included) and all(
            licensed[name]["sha256"] == row[1] for name, row in self.view_builder.included.items()),
            "unchanged license gate exact derived input identity")
        self.license_passed = True
        self.save()
        self.guard()
        return licensed

    def snapshot_cache(self, container, initial):
        self.guard()
        D.check(self.license_passed and self.view_ready is not None and any(
            row["id"] == container and row["name"] == self.name + "-build" and not row["removed"]
            for row in self.containers), "cache inquiry exact owned build container")
        D.check(self.cache_initial is None if initial else self.cache_initial is not None and self.cache_final is None,
                "cache inquiry once-only ordering")
        identity = "runtime-cache-initial" if initial else "runtime-cache-final"
        observed = None if initial else C.producer_chain(self.events, PRODUCERS)
        argv = ["/usr/bin/docker", "exec", "--workdir", "/work", container, "/usr/local/bin/node", "-e",
                C.INITIAL_SCRIPT if initial else C.FINAL_SCRIPT]
        ok, payload = D.Attempt.command(self, identity, argv, 5)
        D.check(ok, "bounded fixed runtime cache inquiry failed")
        rows = C.decode(payload, initial)
        self.guard()
        if initial:
            self.cache_initial = dict(container=container, payloadSha256=hashlib.sha256(payload).hexdigest())
        else:
            D.check(self.cache_initial["container"] == container, "cache container identity changed")
            self.cache_final = dict(container=container, rows=rows, producerObservations=observed,
                firstObservedAfter=next((e["id"] for e in reversed(observed) if e["hostCommandEntryObserved"]), None),
                payloadSha256=hashlib.sha256(payload).hexdigest())
        self.save()
        self.guard()

    def command(self, identity, argv, seconds, cleanup=False, capture_result=None):
        if identity == "compiler-version":
            D.check(argv[:4] == ["/usr/bin/docker", "exec", "--workdir", "/work"] and
                    len(argv) == 7 and argv[5:] == ["/tool/zig", "version"], "fixed first compiler entry")
            self.snapshot_cache(argv[4], initial=True)
        if identity == "artifact-source-snapshot":
            D.check(argv[:4] == ["/usr/bin/docker", "exec", "--workdir", "/work"] and len(argv) == 8,
                    "fixed cache final observation boundary")
            self.snapshot_cache(argv[4], initial=False)
        return super().command(identity, argv, seconds, cleanup, capture_result)

    def build(self, view, licensed):
        self.guard()
        D.check(self.license_passed and self.view_ready is not None and self.view_builder.completed and
                not self.view_builder.failed and view == self.view_builder.destination and
                set(licensed) == set(self.view_builder.included), "build only exact licensed completed view")
        return super().build(view, licensed)

    def inspect_then_models(self, artifacts):
        self.guard()
        D.check(self.cache_initial is not None and self.cache_final is not None and
                self.cache_final["producerObservations"] == [dict(id=name, status="PASSED", hostCommandEntryObserved=True) for name in PRODUCERS] and
                all(row["removed"] for row in self.containers), "closed fixed producers and retired build required")
        maps = {}
        for name, units in D.LINKS.items():
            raw = (artifacts / (name + ".map")).read_bytes()
            maps[name] = C.map_inputs(raw, self.cache_final["rows"], {"/work/" + unit + ".o" for unit in units})
        value = dict(status="FRESH_CACHE_INPUTS_OBSERVED_AFTER_FIXED_PRODUCERS_RECONCILED_WITH_MAPS",
            initialSnapshotSha256=self.cache_initial["payloadSha256"], finalSnapshotSha256=self.cache_final["payloadSha256"],
            producerObservations=self.cache_final["producerObservations"], firstObservedAfter=self.cache_final["firstObservedAfter"],
            maps=maps, exactPerProcessProductionProved=False, derivedViewIdentitySha256=PLAN_SHA, nativeQualification=False)
        self.write_receipt("cache-provenance.json", json.dumps(value, indent=2).encode() + b"\n")
        self.guard()
        return super().inspect_then_models(artifacts)

    def cleanup_after_attempt(self):
        try:
            self.cleanup()
            D.check(not self.receipt_uncertain and all(row["removed"] for row in self.containers) and
                    not any(event.get("id") in {"unresolved-cleanup", "unresolved-container-census", "census-exception"}
                            for event in self.events), "filtered actual cleanup closure or receipts incomplete")
        except BaseException as error:
            self.failed, self.success, self.terminal_complete = True, False, False
            self.events.append(dict(id="filtered-cleanup-failure", type=type(error).__name__, reason=str(error)[:256]))
            self.save()
            raise

    def finalize(self):
        D.check(not self.finalization_attempted, "filtered finalization spent")
        self.finalization_attempted = True
        try:
            self.guard(0)
            D.check(self.success and not self.failed and self.models_passed and self.license_passed and
                    self.view_builder is not None and self.view_builder.completed and not self.view_builder.failed and
                    not self.receipt_uncertain and all(row["removed"] for row in self.containers),
                    "filtered models or closure incomplete")
            self.terminal_complete = True
            self.save()
            self.guard(0)
            D.check(self.terminal_complete and self.success and not self.failed and not self.receipt_uncertain,
                    "filtered terminal receipt incomplete")
        except BaseException as error:
            self.failed, self.success, self.terminal_complete = True, False, False
            self.events.append(dict(id="filtered-terminal-failure", type=type(error).__name__, reason=str(error)[:256]))
            self.save()
            raise


def main():
    D.check(sys.platform == "linux" and os.uname().machine == "x86_64" and sys.version_info[:2] == (3, 12),
            "filtered nominated Linux x86_64 Python3.12")
    D.check(len(sys.argv) == 2 and os.getuid() != 0 and D.pwd.getpwuid(os.getuid()).pw_name == "runner",
            "filtered fixed arguments/account")
    packet = Path(sys.argv[1]).resolve(strict=True)
    D.check(Path(sys.argv[1]).absolute() == packet == Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True) /
            "research/native-modeled-v6", "filtered fixed packet root")
    D.check(os.environ.get("GITHUB_REPOSITORY") == "APReddy-AutoBotz/Project-Delivery-Agent" and
            os.environ.get("GITHUB_REF") == "refs/heads/codex/native-modeled-research-v6" and
            os.environ.get("GITHUB_RUN_ATTEMPT") == "1" and re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")),
            "filtered exact destination/initial attempt")
    manifest_path = packet / "packet.json"
    D.check(manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_size <= D.LIMIT and
            D.sha(manifest_path) == os.environ.get("PDAA_PACKET_SHA256"), "filtered exact workflow-bound packet")
    manifest = json.loads(manifest_path.read_text())
    expected = {"host_driver.py", "elf_inspect.py", "elf_controls_v2.py", "driver_controls.py", "license-scope.json",
        "LLVM-LICENSE.txt", "README.md", "filtered_driver.py", "tool_view.py", "view_controls.py",
        "cache_provenance.py", "cache_controls.py", "tool-view-identities.json", "filtered_controls.py"}
    expected |= {"native/" + D.BASE + unit + ".c" for unit in D.UNITS}
    expected |= {"native/" + D.BASE + unit + ".h" for unit in ("policy", "state", "observer")}
    D.check(set(manifest) == {"schema", "files"} and type(manifest["schema"]) is int and manifest["schema"] == 1 and
            type(manifest["files"]) is list and len(manifest["files"]) == len(expected) == 23, "filtered exact packet schema")
    seen = set()
    for row in manifest["files"]:
        D.check(type(row) is dict and set(row) == {"path", "bytes", "sha256"} and row["path"] in expected and
                row["path"] not in seen and type(row["bytes"]) is int and 0 <= row["bytes"] <= D.LIMIT and
                type(row["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), "filtered exact frozen file row")
        path = packet / row["path"]
        D.check(path.is_file() and not path.is_symlink() and path.resolve(strict=True) == path and
                path.stat().st_size == row["bytes"] and D.sha(path) == row["sha256"], "filtered frozen source identity")
        seen.add(row["path"])
    fixture = Path(os.environ["RUNNER_TEMP"]) / "pdaa-native-modeled-v6"
    attempt = FilteredAttempt(packet, fixture)
    try:
        attempt.events.append(dict(id="host", uname=list(os.uname()), python=sys.version,
            executable=str(Path(sys.executable).resolve()), executableSha256=D.sha(Path(sys.executable).resolve()),
            workflowCommit=os.environ.get("GITHUB_SHA")))
        for identity, script, expression in (
            ("driver-controls", "driver_controls.py", rb"Driver modeled controls passed: 306; network/process/container calls: 0\n"),
            ("view-controls", "view_controls.py", rb"Tool view controls passed: 66; compiler/image/native calls: 0\n"),
            ("cache-controls", "cache_controls.py", rb"Cache controls passed: 59; compiler/image/native calls: 0\n"),
            ("elf-controls", "elf_controls_v2.py", rb"ELF modeled controls passed: [1-9][0-9]*; native executions: 0\n"),
            ("filtered-controls", "filtered_controls.py", rb"Filtered driver controls passed: 34; real external calls: 0\n")):
            ok, output = attempt.command(identity, [sys.executable, "-I", "-S", "-B", str(packet / script), str(fixture)], 5)
            D.check(ok and re.fullmatch(expression, output), "filtered fixed prerequisite controls failed")
        original = attempt.download_extract()
        view = attempt.create_view(original)
        licensed = attempt.licenses(view)
        attempt.build(view, licensed)
    except BaseException as error:
        attempt.failed, attempt.success, attempt.terminal_complete = True, False, False
        attempt.events.append(dict(id="filtered-failure", type=type(error).__name__, reason=str(error)[:512]))
        attempt.save()
        raise
    finally:
        attempt.cleanup_after_attempt()
    attempt.finalize()


if __name__ == "__main__":
    main()
