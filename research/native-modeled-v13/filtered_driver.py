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
import stat
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


D = fixed_module("host_driver.py", "b11734ab005b66538caf7746f14832208c09bb4bee36708e9549c3ea73214ec4", "filtered_historical_driver")
V = fixed_module("tool_view.py", "ea790cd2d46172f3590b8598bfb3d6f5387d2e44b2fd8b03507c66bc01f4323e", "filtered_view_helper")
C = fixed_module("cache_provenance.py", "2ca9eda9c4e306b834c9dff39a75a32d7b6f207dd9fb3e8f3ea1c337ae841f8a", "filtered_cache_helper")
L = fixed_module("link_inputs.py", "bf7f8856739f9b5a76bf34222e4eae3c8caff106cf599b3658ae64986b458417", "filtered_fixed_link_inputs")
T = fixed_module("artifact_transfer.py", "90be5f380783340e7fc531700915ca1b32343d63dcaecbeb0006c02a8edd9551", "filtered_private_artifact_transfer")
H = fixed_module("host_files.py", "f3ac5400bcf51809a11e11b27e4e7e861605adcd952ca4c0923e2ec9bc71246d", "filtered_guarded_host_files")
PLAN_SHA = "deccb9d19801447c219ff30666eeabcb9ec4ae5ba30cd15919b5c13dd37bdcd5"
COMPILE_PRODUCERS = ("compiler-version", "clang-version") + tuple("compile-" + unit for unit in D.UNITS)
PRODUCERS = COMPILE_PRODUCERS + ("runtime-preparation",) + tuple("link-" + name for name in D.LINKS)


def fixed_source_snapshot_script():
    # Exact inherited script, now admitted only for all18 successful producers.
    return ("const fs=require('fs'),c=require('crypto');const out=[];let total=0;"
        "for(const n of " + json.dumps(list(T.NAMES)) + "){const p='/work/'+n,s=fs.lstatSync(p);"
        "const max=n.endsWith('.d')||n.endsWith('.map')?1048576:33554432;"
        "if(!s.isFile()||s.size<0||s.size>max)throw Error('artifact bounds');"
        "total+=s.size;if(total>268435456)throw Error('aggregate artifacts');"
        "const b=fs.readFileSync(p);if(b.length!==s.size)throw Error('changed artifact');"
        "out.push({name:n,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')});}"
        "process.stdout.write(JSON.stringify(out)+'\\n');")


# Fixed independent caller membership, never supplied by a process result.
TRANSFER_CASE_NAMES = ('payload-boundary-0', 'payload-boundary-1', 'payload-boundary-65535', 'payload-boundary-65536', 'payload-boundary-65537', 'payload-boundary-1048576', 'payload-boundary-33554432', 'fragmented-positive-short-writes', 'stderr-eof-first', 'eof-before-child-completion', 'existing-file', 'directory-mode', 'directory-replaced', 'open-before-output', 'open-after-output', 'selector-before', 'selector-after', 'selector-fd-collision', 'popen-before', 'popen-after', 'same-pipe', 'bad-pid', 'pipe-fd-collision', 'register-stdout', 'register-stderr', 'nonblocking', 'select', 'unregister-stdout', 'unregister-stderr', 'read-stdout', 'read-stderr', 'invalid-read', 'write-before', 'write-zero', 'write-negative', 'write-bool', 'write-too-large', 'write-after-full', 'close-output-before', 'close-output-after-reuse', 'readback', 'changed-readback', 'poll', 'wait', 'readback-pipe-alias', 'readback-selector-alias', 'close-stdout', 'close-stderr', 'selector-close', 'child-remains-live', 'pipes-remain-open', 'deadline-write', 'deadline-read-stdout', 'fstat-output', 'write-after-partial', 'truncated', 'extra-byte', 'wrong-hash', 'stderr-private', 'stderr-overflow', 'nonzero-exit', 'snapshot-negative-0', 'snapshot-negative-1', 'snapshot-negative-2', 'snapshot-negative-3', 'snapshot-negative-4', 'snapshot-negative-5', 'snapshot-negative-6', 'snapshot-negative-7', 'snapshot-negative-8', 'snapshot-negative-9', 'snapshot-negative-10', 'snapshot-negative-11', 'snapshot-wanted-73', 'snapshot-wanted-74', 'snapshot-wanted-75', 'snapshot-aggregate-overflow', 'snapshot-aggregate-exact-and-isolated', 'constructor-admission-0', 'constructor-admission-1', 'constructor-admission-2', 'constructor-admission-3', 'constructor-admission-4', 'constructor-admission-5', 'constructor-admission-6', 'constructor-admission-7', 'constructor-admission-8', 'constructor-admission-9', 'constructor-admission-10', 'constructor-admission-11', 'constructor-admission-12', 'constructor-admission-13', 'constructor-admission-14', 'constructor-admission-15', 'constructor-admission-16', 'constructor-admission-17', 'constructor-admission-18', 'constructor-admission-19', 'constructor-admission-20', 'constructor-admission-21', 'constructor-admission-22', 'prospective-capacity-native', 'prospective-capacity-logical', 'prospective-capacity-acquisitions', 'metadata-one-attempt-0', 'metadata-one-attempt-1', 'metadata-one-attempt-True', 'metadata-one-attempt--1', 'metadata-one-attempt-throw', 'metadata-one-attempt-full', 'retained-resource-termination-objects', 'retained-resource-termination-group', 'swallowed-cleanup-assertion-is-control-failure', 'live-child-cleanup-None', 'live-child-cleanup-kill', 'live-child-cleanup-wait', 'diag-count-0', 'diag-count-115', 'diag-count-116', 'diag-count-bool', 'diag-count-negative', 'diag-count-overflow', 'diag-count-float', 'diag-count-hostile', 'diag-phase-unknown', 'diag-phase-hostile', 'diag-phase-initial', 'diag-phase-summary', 'diag-prefix-0', 'diag-prefix-115', 'diag-prefix-116', 'diag-prefix-expanded', 'diag-prefix-nonlist', 'diag-prefix-hostile', 'diag-prefix-foreign', 'diag-prefix-reordered', 'diag-fail-write-zero', 'diag-fail-write-short', 'diag-fail-write-boolean', 'diag-fail-write-negative', 'diag-fail-write-impossible', 'diag-fail-write-throw', 'diag-fail-write-full-throw', 'diag-fail-write-full', 'diag-pass-write-zero', 'diag-pass-write-short', 'diag-pass-write-boolean', 'diag-pass-write-negative', 'diag-pass-write-impossible', 'diag-pass-write-throw', 'diag-pass-write-full-throw', 'diag-pass-write-full', 'diag-pass-serialize', 'diag-fail-serialize', 'diag-pass-oversize', 'diag-catalog-incomplete', 'diag-catalog-reordered', 'diag-catalog-complete', 'diag-publish-twice', 'diag-publish-swallow', 'diag-swallowed-write', 'diag-swallowed-serialize', 'diag-progress-error', 'diag-no-publish', 'diag-terminal-return-objects', 'diag-terminal-return-group', 'diag-terminal-clock', 'diag-primary-clock')
VIEW_CONTROL_GROUPS = (('g01', ('view-001', 'view-002')), ('g02', ('view-003',)), ('g03', ('view-004',)), ('g04', ('view-005',)), ('g05', ('view-006',)), ('g06', ('view-007',)), ('g07', ('view-008', 'view-009', 'view-010', 'view-011', 'view-012', 'view-013', 'view-014', 'view-015', 'view-016', 'view-017', 'view-018', 'view-019', 'view-020', 'view-021', 'view-022', 'view-023', 'view-024', 'view-025', 'view-026')), ('g08', ('view-027', 'view-028', 'view-029', 'view-030', 'view-031', 'view-032', 'view-033', 'view-034', 'view-035', 'view-036')), ('g09', ('view-037', 'view-038', 'view-039', 'view-040', 'view-041', 'view-042', 'view-043', 'view-044', 'view-045', 'view-046', 'view-047', 'view-048', 'view-049', 'view-050')), ('g10', ('view-051', 'view-052', 'view-053', 'view-054', 'view-055', 'view-056', 'view-057', 'view-058', 'view-059', 'view-060', 'view-061', 'view-062')), ('g11', ('view-063', 'view-064', 'view-065', 'view-066', 'view-067', 'view-068', 'view-069', 'view-070', 'view-071')))
FILTERED_CONTROL_GROUPS = (('f01', ('healthy', 'prerequisite-failure', 'archive-failure', 'view-failure', 'license-failure', 'wrong-container', 'repeat-initial', 'missing-producer', 'initial-inquiry-failure', 'final-inquiry-failure', 'final-json-failure', 'map-failure', 'snapshot-without-license', 'snapshot-without-readiness', 'snapshot-after-removal', 'final-before-initial', 'wrong-producer-order', 'repeat-final', 'ownership-refusal', 'remove-failure', 'census-failure')), ('f02', ('compile-vector-missing-linker-option', 'compile-vector-duplicate-linker-option', 'compile-vector-wrong-source', 'compile-boundary-unlicensed', 'compile-boundary-unready', 'compile-boundary-no-initial', 'compile-boundary-final-present', 'compile-boundary-wrong-container', 'compile-boundary-retired', 'cleanup-write-short', 'cleanup-write-partial', 'cleanup-write-full-throw', 'terminal-write-short', 'terminal-write-partial', 'terminal-write-full-throw', 'view-return-expiry', 'initial-return-expiry', 'final-return-expiry', 'cache-ready-save-expiry', 'after-cleanup-expiry', 'cleanup-save-expiry', 'terminal-save-expiry')), ('f03', ('inherited-healthy', 'host-control-result-grammar')), ('f04', ('inherited-elf-bad-policy.o', 'inherited-elf-bad-policy-controls.o', 'inherited-elf-bad-policy-install-controls.o')), ('f05', ('inherited-elf-bad-state.o', 'inherited-elf-bad-state-controls.o', 'inherited-elf-bad-observer.o')), ('f06', ('inherited-elf-bad-policy-model', 'inherited-elf-bad-installer-model', 'inherited-elf-bad-state-model')), ('f07', ('inherited-copy-worker-end', 'inherited-copy-save-end', 'inherited-copy-settlement-end', 'inherited-retirement-expiry', 'inherited-source-dependency-expiry', 'inherited-first-model-hash-expiry', 'inherited-second-model-hash-expiry')), ('f08', ('view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership', 'transfer-catalog-foreign', 'transfer-catalog-reordered', 'transfer-catalog-duplicate')))


def grouped_control_result(output, status, group, expected_names, external_field):
    D.check(type(output) is bytes and 0 < len(output) <= 16384, "bounded supplied grouped controls result")
    result = json.loads(output, object_pairs_hook=T.unique_pairs, parse_constant=T.no_constant)
    D.check(type(result) is dict and set(result) == {"schema", "status", "group", "cases", "names", external_field, "nativeQualification"} and
            type(result["schema"]) is int and result["schema"] == 1 and result["status"] == status and
            type(result["group"]) is str and result["group"] == group and
            type(result["cases"]) is int and result["cases"] == len(expected_names) and
            type(result["names"]) is list and all(type(name) is str for name in result["names"]) and
            tuple(result["names"]) == expected_names and
            type(result[external_field]) is int and result[external_field] == 0 and result["nativeQualification"] is False,
            "complete supplied grouped controls result")
    return tuple(result["names"])


class FilteredAttempt(D.Attempt):
    def __init__(self, packet, fixture):
        self.receipt_verified, self.receipt_uncertain = {}, {}
        self.view_builder = self.view_ready = None
        self.license_passed = self.finalization_attempted = self.terminal_complete = False
        self.cache_initial = self.cache_final = None
        self.preparation_attempted, self.link_requests = False, []
        self.preparation_payload = self.cache_pre_final = None
        self.runtime_inputs = None
        self.reader_controls_passed = False
        self.artifact_snapshot = self.artifact_directory_identity = self.fixture_identity = None
        self.transfer_attempts, self.transfer_unsettled, self.transfer_verified = [], {}, {}
        self.transfer_charged = 0
        self.host_files = None
        self.transfer_reports, self.transfer_ends = {}, {}
        self.artifact_retired = self.artifact_directory_published = False
        self.artifact_mode_attempts = []
        super().__init__(packet, fixture)
        created = fixture.lstat()
        D.check(stat.S_ISDIR(created.st_mode) and stat.S_IMODE(created.st_mode) == 0o700 and created.st_uid == os.getuid(),
                "actual created fixture identity")
        self.fixture_identity = (created.st_dev, created.st_ino)
        self.host_files = H.HostFiles(str(fixture), self.fixture_identity, self.normal_file_guard, lambda: self.guard(0), D.time.monotonic)

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
            privateReaderControlsPassed=self.reader_controls_passed,
            hostFiles=None if self.host_files is None else self.host_files.report(),
            artifactDirectoryPublished=self.artifact_directory_published,
            privateTransfers=dict(attempted=list(self.transfer_attempts), chargedBytes=self.transfer_charged,
                unsettled=dict(self.transfer_unsettled), verified=dict(self.transfer_verified)),
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

    def admit_transfer_report(self, payload, row, container):
        """Strict root metadata admission; full wrapper review still pending."""
        D.check(type(payload) is bytes and 0 < len(payload) <= 4096, "private transfer bounded metadata")
        value = json.loads(payload, object_pairs_hook=T.unique_pairs, parse_constant=T.no_constant)
        keys = {"schema", "status", "code", "name", "container", "expectedBytes", "receivedBytes", "verifiedWriteBytes",
            "uncertainWriteBytes", "uncertainReadBytes", "returnedReadBytes", "readAttempts", "streamSha256", "hostSha256",
            "stderrBytes", "stderrSha256", "stdoutEof", "stderrEof", "childClosedKnown", "acquisitions", "closes",
            "pendingAcquisitions", "uncertainCloseRoles", "nativePendingReservations", "nativeFdBudget",
            "nativeFdPeakReserved", "ownedResourcesClosed", "hostIdentity", "nativeQualification"}
        D.check(type(value) is dict and set(value) == keys and type(value["schema"]) is int and value["schema"] == 1 and
                value["status"] == "VERIFIED_PRIVATE_PENDING_BUILDER_RETIREMENT" and value["code"] == "NONE" and
                value["name"] == row["name"] and value["container"] == container and
                value["streamSha256"] == value["hostSha256"] == row["sha256"], "private transfer exact identity/result")
        D.check(all(type(value[key]) is int and value[key] == row["bytes"] for key in
                    ("expectedBytes", "receivedBytes", "verifiedWriteBytes")) and
                all(type(value[key]) is int and value[key] == 0 for key in ("uncertainWriteBytes", "uncertainReadBytes", "stderrBytes")) and
                all(value[key] is True for key in ("stdoutEof", "stderrEof", "childClosedKnown", "ownedResourcesClosed")) and
                value["nativeQualification"] is False and value["stderrSha256"] == hashlib.sha256(b"").hexdigest() and
                type(value["pendingAcquisitions"]) is dict and not value["pendingAcquisitions"] and
                type(value["nativePendingReservations"]) is dict and not value["nativePendingReservations"] and
                type(value["uncertainCloseRoles"]) is list and not value["uncertainCloseRoles"],
                "private transfer complete counters/closure/no uncertainty")
        D.check(type(value["returnedReadBytes"]) is int and value["returnedReadBytes"] ==
                    2 * row["bytes"] + (self.packet / "artifact_reader.js").stat().st_size and
                type(value["readAttempts"]) is int and 5 <= value["readAttempts"] <= 2 * row["bytes"] + 16392 and
                type(value["acquisitions"]) is int and 1 <= value["acquisitions"] <= 80 and
                type(value["closes"]) is int and 1 <= value["closes"] <= 82 and
                type(value["nativeFdBudget"]) is int and value["nativeFdBudget"] == 16 and
                type(value["nativeFdPeakReserved"]) is int and value["nativeFdPeakReserved"] == 13,
                "private transfer exact source-derived resource envelope")
        info = value["hostIdentity"]
        D.check(type(info) is dict and set(info) == {"device", "inode", "uid", "mode", "bytes"} and
                all(type(item) is int and item >= 0 for item in info.values()) and info["uid"] == os.getuid() and
                info["mode"] == 0o600 and info["bytes"] == row["bytes"], "private transfer host identity metadata")
        return value

    def transfer_artifact(self, identity, argv, seconds, cleanup, capture_result):
        """Replace only exact inherited cp dispatch; never execute Docker cp."""
        charged_name = None
        try:
            self.guard()
            D.check(not self.failed and self.artifact_snapshot is not None and self.cache_final is not None and
                    self.artifact_directory_identity is not None and seconds == 3 and not cleanup and capture_result is None,
                    "private transfer original cap and complete fixed source admission")
            index = len(self.transfer_attempts)
            D.check(index < 18 and identity == "copy-" + str(index), "private transfer exact once-only next index")
            row = self.artifact_snapshot[index]
            name, container = row["name"], self.cache_final["container"]
            directory = self.fixture / "artifacts"
            D.check(argv == ["/usr/bin/docker", "cp", container + ":/work/" + name, str(directory / name)] and
                    any(item["id"] == container and item["name"] == self.name + "-build" and not item["removed"]
                        for item in self.containers) and self.transfer_charged + row["bytes"] <= 268435456,
                    "private transfer exact live owned builder/token/prospective full storage")
            self.transfer_attempts.append(name)
            self.transfer_charged += row["bytes"]
            self.transfer_unsettled[name] = row["bytes"]  # never refund on failure
            charged_name = name
            self.guard()
            end = min(self.deadline - 20, D.time.monotonic() + 2.5)
            D.check(end > D.time.monotonic() + 0.1, "private transfer original deadline remains")
            self.transfer_ends[name] = end  # immutable original end BEFORE worker entry
            args = [sys.executable, "-I", "-S", "-B", str(self.packet / "artifact_transfer.py"), str(directory),
                    container, name, str(row["bytes"]), row["sha256"], repr(end),
                    *(str(value) for value in self.fixture_identity), *(str(value) for value in self.artifact_directory_identity)]
            ok, payload = D.Attempt.command(self, identity, args, 3)
            D.check(ok, "private transfer worker command incomplete")
            self.guard()
            D.check(D.time.monotonic() < end, "original copy end after worker")
            report = self.admit_transfer_report(payload, row, container)
            info = report["hostIdentity"]
            self.host_files.bind_artifact(name, (info["device"], info["inode"]))
            self.transfer_reports[name] = dict(info)
            self.guard()
            D.check(D.time.monotonic() < end, "original copy end after metadata admission")
            self.save()
            self.guard()
            D.check(D.time.monotonic() < end, "original copy end after transfer receipt")
            return True, payload
        except BaseException:
            self.failed, self.success, self.terminal_complete = True, False, False
            if charged_name is not None:
                self.transfer_unsettled[charged_name] = row["bytes"]
                self.transfer_verified.pop(charged_name, None)
            raise

    def create_view(self, original):
        self.guard()
        D.check(self.view_builder is None and original == self.fixture / "tools" / D.TOP,
                "fixed original quarantine and one view constructor")
        raw = (self.packet / "tool-view-identities.json").read_bytes()
        D.check(len(raw) == 583926 and hashlib.sha256(raw).hexdigest() == PLAN_SHA, "exact frozen literal view partition")
        plan = json.loads(raw)
        D.check(plan["selectedFiles"] == 4876 and plan["includedFiles"] == 4819 and plan["excludedFiles"] == 57 and
                plan["includedBytes"] == 214297498 and plan["excludedBytes"] == 422834 and len(plan["entries"]) == 4876,
                "fixed view partition capacities")
        inventory = json.loads((self.receipts / "tool-inventory.json").read_text())
        D.check(inventory["entries"] == 19363 and inventory["payloadBytes"] == 344238754 and
                inventory["compilerSha256"] == plan["compilerSha256"] ==
                "2858dc89dbbfdd08cceda1b841e7fd0a793a1a67b49f150bc3d0d1de44ed7f51", "fresh archive identity")
        notice = original / "LICENSE"
        D.check(not notice.is_symlink() and notice.is_file() and notice.stat().st_size == 1080 and
                D.sha(notice) == "5c537d6853e005298a285d508cff9ac7192cea23576c840d485b2b586a7ff177",
                "separate retained Zig publisher notice")
        ubsan = original / "lib/ubsan_rt.zig"
        self.guard()
        D.check(not ubsan.is_symlink() and ubsan.is_file() and ubsan.stat().st_size == 22376 and
                D.sha(ubsan) == "64b6584844f6e3c4262ecc8831c8fd10f5be6c0ec3d54cc5b682936e60a7e053",
                "fresh original archive must independently authenticate sole new UBSan leaf before view construction")
        self.guard()
        scope = json.loads((self.packet / "license-scope.json").read_text())
        builder = V.ToolView(original, self.fixture / "tool-view", plan["entries"],
                             [r["path"] for r in scope["roots"]], scope["requiredHeaders"], self.guard)
        self.view_builder = builder
        D.check(builder.total == 214297498 and len(builder.included) == 4819 and len(builder.dirs) == 365 and
                builder.read_capacity == 857632159, "fixed derived view schedule")
        view = builder.construct()
        self.guard()
        D.check(builder.completed and not builder.failed and view == self.fixture / "tool-view", "actual completed view required")
        self.view_ready = object()
        self.events.append(dict(id="filtered-view", status="COMPLETED_DERIVED_RESEARCH_VIEW_NO_LICENSE_ADMISSION",
            includedFiles=4819, excludedFiles=57, bytes=214297498, directories=365,
            identityManifestSha256=PLAN_SHA, originalEvidenceSealSha256=plan["originalEvidenceSealSha256"],
            rootNotice="Original quarantine only; outside exact4819view", originalQuarantineReadAsData=True))
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
        self.host_files.add_scope("tool", str(view),
            {"" if name == "." else name: (*value, 0o555) for name, value in self.view_builder.destination_directories.items()},
            {name: (row[0], row[1], self.view_builder.destination_inodes[name], 0o555 if name == "zig" else 0o444)
             for name, row in self.view_builder.included.items()})
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
            D.check(self.cache_pre_final is not None and self.preparation_payload is not None,
                    "final cache requires authenticated preparation observation")
            L.verify_unchanged(self.preparation_payload, self.cache_pre_final["rows"], rows)
            self.cache_final = dict(container=container, rows=rows, producerObservations=observed,
                firstObservedAfter=next((e["id"] for e in reversed(observed) if e["hostCommandEntryObserved"]), None),
                payloadSha256=hashlib.sha256(payload).hexdigest())
        self.save()
        self.guard()

    def run_reader_controls(self, container):
        self.guard()
        D.check(not self.reader_controls_passed and self.cache_initial is not None and
                self.cache_initial["container"] == container and self.preparation_payload is None and
                not any(event.get("id") in PRODUCERS for event in self.events),
                "reader controls after empty observation before any compiler producer")
        reader = (self.packet / "artifact_reader.js").read_bytes()
        controls = (self.packet / "artifact_reader_controls.js").read_bytes()
        D.check(0 < len(reader) <= 16384 and hashlib.sha256(reader).hexdigest() == T.READER_SHA256 and
                0 < len(controls) <= 16384 and hashlib.sha256(controls).hexdigest() ==
                "c3e63da9f4370e7d57bd04063dbc0e44a90d7a68b7b5696826c4456eb4fd945e",
                "exact independent reader control/source text")
        self.guard()
        ok, payload = D.Attempt.command(self, "reader-controls", ["/usr/bin/docker", "exec", "--workdir", "/work", container,
            "/usr/local/bin/node", "-e", controls.decode("ascii"), "--", reader.decode("ascii")], 5)
        D.check(ok and 0 < len(payload) <= 8192, "bounded private reader controls command")
        value = json.loads(payload, object_pairs_hook=T.unique_pairs, parse_constant=T.no_constant)
        names = ["reader-source-identity-" + str(index) for index in range(3)]
        names += ["size-" + str(size) for size in (0, 1, 65535, 65536, 65537, 1048576, 33554432)]
        names += ["write-order-" + order for order in ("sync", "drain-before-return", "callback-before-drain", "drain-before-callback")]
        names += ["open-throw", "invalid-fd", "fstat-throw", "initial-kind", "initial-uid", "initial-links", "initial-size",
            "read-throw", "short-read", "invalid-read", "extra-byte", "changed-fstat", "changed-path", "lstat-throw", "close-throw",
            "write-throw", "write-invalid-result", "callback-error", "stream-error", "stream-close", "gap-error", "wrong-hash", "destroy-throw"]
        names += ["argv-" + str(index) for index in range(37, 46)]
        D.check(type(value) is dict and set(value) == {"schema", "status", "cases", "names", "realArtifactReads", "nativeQualification"} and
                type(value["schema"]) is int and value["schema"] == 1 and value["status"] == "SUPPLIED_READER_CONTROLS_PASS" and
                type(value["cases"]) is int and value["cases"] == 46 and value["names"] == names and
                type(value["realArtifactReads"]) is int and value["realArtifactReads"] == 0 and value["nativeQualification"] is False,
                "complete supplied reader controls result")
        self.guard()
        self.reader_controls_passed = True
        self.save()
        self.guard()

    def prepare_runtime(self, container):
        """One fixed source-supported preparation; no model or ELF admission.

        Mutable V8 integration draft. Full wrapper controls/freeze/review pending.
        """
        self.guard()
        D.check(self.reader_controls_passed and not self.preparation_attempted and self.preparation_payload is None and
                self.cache_pre_final is None and self.cache_initial is not None and self.cache_final is None and
                self.cache_initial["container"] == container and any(row["id"] == container and
                    row["name"] == self.name + "-build" and not row["removed"] for row in self.containers),
                "once-only preparation same live owned builder")
        observed = C.producer_chain(self.events, COMPILE_PRODUCERS)
        D.check(observed == [dict(id=name, status="PASSED", hostCommandEntryObserved=True) for name in COMPILE_PRODUCERS],
                "all six genuine compile producers required before preparation")
        self.preparation_attempted = True  # spent before any process entry
        argv = ["/usr/bin/docker", "exec", "--workdir", "/work", "--env", "ZIG_VERBOSE_LINK=1", container]
        argv += D.COMMON + ["-static", "-no-pie", "-Wl,--gc-sections", "/work/policy.o", "/work/policy-controls.o",
                            "-o", L.PREPARATION_OUTPUT]
        ok, payload = D.Attempt.command(self, "runtime-preparation", argv, 30)
        D.check(ok, "bounded fixed runtime preparation failed")
        self.guard()
        L.decode(payload)  # do not discover paths or repair an unknown schema
        self.preparation_payload = payload
        complete = C.producer_chain(self.events, COMPILE_PRODUCERS + ("runtime-preparation",))
        D.check(complete == [dict(id=name, status="PASSED", hostCommandEntryObserved=True)
                            for name in COMPILE_PRODUCERS + ("runtime-preparation",)],
                "closed preparation producer required before pre-final observation")
        ok, cache_payload = D.Attempt.command(self, "runtime-cache-pre-final",
            ["/usr/bin/docker", "exec", "--workdir", "/work", container, "/usr/local/bin/node", "-e", C.FINAL_SCRIPT], 5)
        D.check(ok, "bounded post-preparation cache observation failed")
        rows = C.decode(cache_payload, False)
        self.guard()
        plans = [L.final_plan(model, payload, rows) for model in D.LINKS]
        D.check(all(plan["runtimeInputs"] == plans[0]["runtimeInputs"] for plan in plans),
                "one authenticated runtime identity set for all final links")
        self.runtime_inputs = plans[0]["runtimeInputs"]
        self.cache_pre_final = dict(container=container, rows=rows, producerObservations=complete,
            observationStage="AFTER_PREPARATION_BEFORE_FINAL_LLD",
            payloadSha256=hashlib.sha256(cache_payload).hexdigest())
        self.events.append(dict(id="runtime-input-binding", status="AUTHENTICATED_OBSERVATIONS_ONLY",
            preparationSha256=hashlib.sha256(payload).hexdigest(),
            preFinalCacheSha256=self.cache_pre_final["payloadSha256"], runtimeInputs=self.runtime_inputs,
            exactPerProcessProductionProved=False, preparationOutputRetainedAsModel=False, nativeQualification=False))
        self.save()
        self.guard()

    def command(self, identity, argv, seconds, cleanup=False, capture_result=None):
        if type(identity) is str and identity.startswith("copy-"):
            return self.transfer_artifact(identity, argv, seconds, cleanup, capture_result)
        compile_units = {"compile-" + unit: unit for unit in D.UNITS}
        if identity in compile_units:
            self.guard()
            unit = compile_units[identity]
            D.check(self.license_passed and self.view_ready is not None and self.cache_initial is not None and
                    self.cache_final is None and any(row["id"] == self.cache_initial["container"] and
                    row["name"] == self.name + "-build" and not row["removed"] for row in self.containers),
                    "fixed compile-only licensed owned-container boundary")
            execute = ["/usr/bin/docker", "exec", "--workdir", "/work", self.cache_initial["container"]]
            expected = execute + D.COMMON + D.INCLUDES + ["-Wall", "-Wextra", "-Werror", "-MD", "-MF", "/work/" + unit + ".d",
                "-c", "/src/" + D.BASE + unit + ".c", "-o", "/work/" + unit + ".o"]
            D.check(argv == expected and seconds == 30 and not cleanup and capture_result is None and
                    D.COMMON.count("-fuse-ld=lld") == 1, "fixed original compile-only argument vector")
            # The actual V6 compiler rejected this link-only option under -Werror.
            # Keep every compile diagnostic and retain the existing LLD selection for links.
            position = len(execute) + D.COMMON.index("-fuse-ld=lld")
            argv = argv[:position] + argv[position + 1:]
        if identity in {"link-" + model for model in D.LINKS}:
            self.guard()
            model = identity[len("link-"):]
            D.check(self.license_passed and self.view_ready is not None and self.cache_initial is not None and
                    self.cache_final is None and seconds == 30 and not cleanup and capture_result is None and
                    len(self.link_requests) < len(D.LINKS) and list(D.LINKS)[len(self.link_requests)] == model,
                    "fixed final link dispatch order and original command cap")
            container = self.cache_initial["container"]
            execute = ["/usr/bin/docker", "exec", "--workdir", "/work", container]
            historical = D.COMMON + ["-static", "-no-pie", "-Wl,--gc-sections", "-Wl,--emit-relocs",
                "-Wl,--icf=none", "-Wl,--no-relax", "-Wl,-Map,/work/" + model + ".map"]
            if model == "installer":
                historical += ["-Wl,--wrap=" + boundary for boundary in D.WRAPS]
            historical += ["/work/" + unit + ".o" for unit in D.LINKS[model]] + ["-o", "/work/" + model + "-model"]
            D.check(argv == execute + historical, "complete inherited final link request required")
            self.link_requests.append(model)  # dispatch spent before preparation/process
            if not self.preparation_attempted:
                self.prepare_runtime(container)
            self.guard()
            D.check(self.preparation_payload is not None and self.cache_pre_final is not None and
                    self.cache_pre_final["container"] == container and any(row["id"] == container and
                    row["name"] == self.name + "-build" and not row["removed"] for row in self.containers),
                    "final LLD only same owned builder and authenticated preparation")
            plan = L.final_plan(model, self.preparation_payload, self.cache_pre_final["rows"])
            D.check(plan["runtimeInputs"] == self.runtime_inputs, "fixed admitted runtime identities")
            argv = execute + plan["argv"]
        if identity == "compiler-version":
            D.check(argv[:4] == ["/usr/bin/docker", "exec", "--workdir", "/work"] and
                    len(argv) == 7 and argv[5:] == ["/tool/zig", "version"], "fixed first compiler entry")
            self.snapshot_cache(argv[4], initial=True)
            self.run_reader_controls(argv[4])
        if identity == "artifact-source-snapshot":
            try:
                self.guard()
                D.check(self.artifact_snapshot is None and self.cache_initial is not None and self.cache_pre_final is not None and
                        self.link_requests == list(D.LINKS) and seconds == 5 and not cleanup and capture_result is None,
                        "once-only complete final producer snapshot boundary")
                container = self.cache_initial["container"]
                D.check(argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container,
                    "/usr/local/bin/node", "-e", fixed_source_snapshot_script()], "exact18-name source snapshot vector")
                observed = C.producer_chain(self.events, PRODUCERS)
                D.check(observed == [dict(id=name, status="PASSED", hostCommandEntryObserved=True) for name in PRODUCERS],
                        "all genuine final producer results required before transfer source observation")
                self.snapshot_cache(container, initial=False)
                ok, payload = super().command(identity, argv, seconds, cleanup, capture_result)
                D.check(ok, "private transfer complete source snapshot command")
                rows = T.decode_snapshot(payload, T.NAMES)
                self.guard()
                directory, fixture = self.fixture / "artifacts", self.fixture.lstat()
                D.check((fixture.st_dev, fixture.st_ino) == self.fixture_identity, "original fixture directory changed")
                created = directory.lstat()
                D.check(stat.S_ISDIR(created.st_mode) and created.st_uid == os.getuid() and
                        stat.S_IMODE(created.st_mode) == 0o755, "inherited newly created artifact directory")
                directory.chmod(0o700)
                self.guard()
                ready = directory.lstat()
                D.check((created.st_dev, created.st_ino) == (ready.st_dev, ready.st_ino) and
                        stat.S_IMODE(ready.st_mode) == 0o700, "private artifact directory admission")
                self.artifact_directory_identity = (ready.st_dev, ready.st_ino)
                self.artifact_snapshot = tuple(dict(row) for row in rows)
                self.host_files.add_scope("artifacts", str(directory), {"": (*self.artifact_directory_identity, 0o700)},
                    {row["name"]: (row["bytes"], row["sha256"], None, 0o600) for row in rows})
                self.save()
                self.guard()
                return ok, payload
            except BaseException:
                self.failed, self.success, self.terminal_complete = True, False, False
                raise
        return super().command(identity, argv, seconds, cleanup, capture_result)

    def normal_file_guard(self):
        try:
            D.check(not self.failed and not self.terminal_complete, "normal host file phase poisoned or complete")
            self.guard()
        except BaseException:
            self.failed, self.success, self.terminal_complete = True, False, False
            raise

    def host_file_call(self, function, *args, **kwargs):
        try:
            self.normal_file_guard()
            result = function(*args, **kwargs)
            self.normal_file_guard()
            return result
        except BaseException:
            self.failed, self.success, self.terminal_complete = True, False, False
            raise

    def artifact_name(self, path):
        D.check(self.artifact_snapshot is not None and type(path) is type(self.fixture) and
                path.parent == self.fixture / "artifacts" and path.name in T.NAMES,
                "fixed private artifact path")
        return path.name

    def artifact_hash(self, path):
        name = self.artifact_name(path)
        if self.artifact_retired:
            D.check(self.artifact_directory_published and name.endswith("-model") and name in self.transfer_verified,
                    "post-retirement model hash after frozen directory")
            return self.host_file_call(self.host_files.access, "artifacts", name)[0]
        try:
            self.normal_file_guard()
            D.check(name in self.transfer_reports and name in self.transfer_unsettled and
                    name not in self.transfer_verified and self.transfer_attempts[-1] == name,
                    "inherited independent copy hash before storage settlement")
            end = self.transfer_ends[name]
            digest, _ = self.host_file_call(self.host_files.access, "artifacts", name, end=end)
            D.check(D.time.monotonic() < end, "original copy end before settlement")
            row = next(row for row in self.artifact_snapshot if row["name"] == name)
            self.transfer_verified[name] = dict(bytes=row["bytes"], sha256=digest, hostIdentity=dict(self.transfer_reports[name]))
            del self.transfer_unsettled[name]
            self.save()
            self.normal_file_guard()
            D.check(D.time.monotonic() < end, "original copy end after closed verification and receipt")
            return digest
        except BaseException:
            self.failed, self.success, self.terminal_complete = True, False, False
            row = next((row for row in self.artifact_snapshot if row["name"] == name), None)
            if row is not None:
                self.transfer_unsettled[name] = row["bytes"]
                self.transfer_verified.pop(name, None)
            raise

    def artifact_copy_valid(self, path, row):
        # The actual owner observes regular kind, no-follow inode, exact size,
        # complete hash/EOF and close under the original stored copy end. No
        # unguarded inherited pathname probes may precede that verification.
        name = self.artifact_name(path)
        try:
            self.normal_file_guard()
            original = next(item for item in self.artifact_snapshot if item["name"] == name)
            D.check(not self.artifact_retired and row == original, "exact authenticated inherited copy row")
            digest = self.artifact_hash(path)
            observed = self.host_files.rows[("artifacts", name)]["identity"]
            D.check(observed is not None and stat.S_ISREG(observed[2]) and
                    observed[5] == row["bytes"] <= 32 * D.LIMIT and digest == row["sha256"],
                    "independent closed copy metadata and hash predicate")
            self.normal_file_guard()
            D.check(D.time.monotonic() < self.transfer_ends[name], "original copy end through inherited admission")
            return True
        except BaseException:
            self.failed, self.success, self.terminal_complete = True, False, False
            original = next((item for item in self.artifact_snapshot if item["name"] == name), None)
            if original is not None:
                self.transfer_unsettled[name] = original["bytes"]
                self.transfer_verified.pop(name, None)
            raise

    def after_build_retirement(self, artifacts):
        self.normal_file_guard()  # BEFORE any ordinary enumeration/read/mode
        D.check(not self.artifact_retired and artifacts == self.fixture / "artifacts" and
                self.transfer_attempts == list(T.NAMES) and set(self.transfer_verified) == set(T.NAMES) and
                not self.transfer_unsettled and all(row["removed"] for row in self.containers) and
                self.cache_final is not None and any(row["id"] == self.cache_final["container"] and
                    row["name"] == self.name + "-build" and row["removed"] for row in self.containers),
                "actual owned builder retirement and complete transfers before normal continuation")
        self.artifact_retired = True
        self.save()
        self.normal_file_guard()

    def artifact_paths(self, directory):
        D.check(self.artifact_retired and not self.artifact_directory_published and directory == self.fixture / "artifacts",
                "post-retirement fixed artifact census")
        return self.host_file_call(self.host_files.namespace)

    def artifact_mode(self, path, mode):
        name = self.artifact_name(path)
        D.check(self.artifact_retired and not self.artifact_directory_published and
                len(self.artifact_mode_attempts) < 18 and T.NAMES[len(self.artifact_mode_attempts)] == name and
                type(mode) is int and mode == (0o555 if name.endswith("-model") else 0o444), "fixed once-only artifact mode order")
        self.artifact_mode_attempts.append(name)
        self.host_file_call(self.host_files.access, "artifacts", name, mode=mode)

    def after_artifact_modes(self, artifacts):
        D.check(self.artifact_retired and not self.artifact_directory_published and artifacts == self.fixture / "artifacts" and
                self.artifact_mode_attempts == list(T.NAMES), "all actual file modes before directory publication")
        self.host_file_call(self.host_files.publish_directory)
        self.artifact_directory_published = True
        self.save()
        self.normal_file_guard()

    def artifact_data(self, path):
        name = self.artifact_name(path)
        D.check(self.artifact_retired and self.artifact_directory_published and name.endswith((".d", ".map")),
                "private text artifact only after retirement and frozen modes")
        return self.host_file_call(self.host_files.access, "artifacts", name, capture=True)[1]

    def tool_dependency_hash(self, path):
        D.check(self.artifact_retired and self.artifact_directory_published and self.license_passed and
                self.view_builder is not None and self.view_builder.completed and not self.view_builder.failed,
                "tool dependency only completed actual licensed view")
        name = path.relative_to(self.view_builder.destination).as_posix()
        D.check(path == self.view_builder.destination / name and name in self.view_builder.included,
                "tool dependency actual completed-view identity")
        return self.host_file_call(self.host_files.access, "tool", name)[0]

    def source_dependency_exists(self, path):
        self.normal_file_guard()
        D.check(type(path) is type(self.fixture) and path.parent == self.packet / "native" and
                path.name in {D.BASE + unit + suffix for unit in D.UNITS for suffix in (".c", ".h")},
                "fixed first-party dependency metadata path")
        result = path.is_file()
        self.normal_file_guard()
        return result

    def admit_elf_inspection(self, inspection):
        self.normal_file_guard()
        D.check(self.artifact_retired and self.artifact_directory_published and
                all(name in self.transfer_verified and digest == self.transfer_verified[name]["sha256"]
                    for name, digest in inspection["hashes"].items()), "ELF hashes bind actual independently verified source artifacts")

    def terminate_uncertain_host_files(self):
        if self.host_files is not None and self.host_files.unsafe():
            # Called only after original owned-container cleanup. Retain all
            # ambiguous objects until low-level exit; no Python finalizer retry.
            try:
                os._exit(71)
            except BaseException:
                try:
                    os.kill(os.getpid(), D.signal.SIGKILL)
                except BaseException:
                    while True:
                        try:
                            D.signal.pause()
                        except BaseException:
                            pass

    def build(self, view, licensed):
        self.guard()
        D.check(self.license_passed and self.view_ready is not None and self.view_builder.completed and
                not self.view_builder.failed and view == self.view_builder.destination and
                set(licensed) == set(self.view_builder.included), "build only exact licensed completed view")
        return super().build(view, licensed)

    def inspect_then_models(self, artifacts):
        self.guard()
        D.check(self.cache_initial is not None and self.cache_final is not None and
                self.reader_controls_passed and
                self.artifact_retired and self.artifact_directory_published and self.host_files is not None and
                not self.host_files.failed and not self.host_files.unsafe() and
                self.artifact_snapshot is not None and self.transfer_attempts == list(T.NAMES) and
                not self.transfer_unsettled and set(self.transfer_verified) == set(T.NAMES) and
                self.cache_final["producerObservations"] == [dict(id=name, status="PASSED", hostCommandEntryObserved=True) for name in PRODUCERS] and
                all(row["removed"] for row in self.containers), "closed fixed producers and retired build required")
        maps = {}
        for name, units in D.LINKS.items():
            raw = self.artifact_data(artifacts / (name + ".map"))
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
            files_failed = False
            if self.host_files is not None:
                try:
                    self.host_files.finish()
                except BaseException:
                    files_failed = True
            self.cleanup()
            D.check(not files_failed and (self.host_files is None or not self.host_files.unsafe()) and
                    not self.receipt_uncertain and all(row["removed"] for row in self.containers) and
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
                    self.reader_controls_passed and
                    self.artifact_retired and self.artifact_directory_published and self.host_files is not None and
                    not self.host_files.failed and not self.host_files.unsafe() and
                    self.host_files.census_api_completed and self.host_files.opaque_directory_slots == 1 and
                    self.view_builder is not None and self.view_builder.completed and not self.view_builder.failed and
                    self.artifact_snapshot is not None and self.transfer_attempts == list(T.NAMES) and
                    not self.transfer_unsettled and set(self.transfer_verified) == set(T.NAMES) and
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
            "research/native-modeled-v13", "filtered fixed packet root")
    D.check(os.environ.get("GITHUB_REPOSITORY") == "APReddy-AutoBotz/Project-Delivery-Agent" and
            os.environ.get("GITHUB_REF") == "refs/heads/codex/native-modeled-research-v13" and
            os.environ.get("GITHUB_RUN_ATTEMPT") == "1" and re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")),
            "filtered exact destination/initial attempt")
    manifest_path = packet / "packet.json"
    D.check(manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_size <= D.LIMIT and
            D.sha(manifest_path) == os.environ.get("PDAA_PACKET_SHA256"), "filtered exact workflow-bound packet")
    manifest = json.loads(manifest_path.read_text())
    expected = {"host_driver.py", "elf_inspect.py", "elf_controls_v2.py", "driver_controls.py", "license-scope.json",
        "LLVM-LICENSE.txt", "README.md", "filtered_driver.py", "tool_view.py", "view_controls.py",
        "cache_provenance.py", "cache_controls.py", "tool-view-identities.json", "filtered_controls.py"}
    expected |= {"elf_bss_controls.py", "link_inputs.py", "link_controls.py", "artifact_transfer.py", "artifact_reader.js",
                 "transfer_controls.py", "artifact_reader_controls.js", "TRANSFER-DESIGN.md",
                 "host_files.py", "host_files_controls.py", "HOST-FILES-DESIGN.md"}
    expected |= {"native/" + D.BASE + unit + ".c" for unit in D.UNITS}
    expected |= {"native/" + D.BASE + unit + ".h" for unit in ("policy", "state", "observer")}
    D.check(set(manifest) == {"schema", "files"} and type(manifest["schema"]) is int and manifest["schema"] == 1 and
            type(manifest["files"]) is list and len(manifest["files"]) == len(expected) == 34, "filtered exact packet schema")
    seen = set()
    for row in manifest["files"]:
        D.check(type(row) is dict and set(row) == {"path", "bytes", "sha256"} and row["path"] in expected and
                row["path"] not in seen and type(row["bytes"]) is int and 0 <= row["bytes"] <= D.LIMIT and
                type(row["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), "filtered exact frozen file row")
        path = packet / row["path"]
        D.check(path.is_file() and not path.is_symlink() and path.resolve(strict=True) == path and
                path.stat().st_size == row["bytes"] and D.sha(path) == row["sha256"], "filtered frozen source identity")
        seen.add(row["path"])
    fixture = Path(os.environ["RUNNER_TEMP"]) / "pdaa-native-modeled-v13"
    attempt = FilteredAttempt(packet, fixture)
    try:
        attempt.events.append(dict(id="host", uname=list(os.uname()), python=sys.version,
            executable=str(Path(sys.executable).resolve()), executableSha256=D.sha(Path(sys.executable).resolve()),
            workflowCommit=os.environ.get("GITHUB_SHA")))

        expected_view = tuple(name for _, names in VIEW_CONTROL_GROUPS for name in names)
        expected_filtered = tuple(name for _, names in FILTERED_CONTROL_GROUPS for name in names)
        D.check(expected_view == tuple("view-" + str(i).zfill(3) for i in range(1, 72)) and
                len(expected_filtered) == len(set(expected_filtered)) == 81,
                "fixed complete disjoint prerequisite control plan")
        requests = [("driver-controls", "driver_controls.py", (), rb"Driver modeled controls passed: 309; network/process/container calls: 0\n", None)]
        requests += [("view-controls-" + group, "view_controls.py", (group,), None,
                      ("SUPPLIED_TOOL_VIEW_CONTROLS_PASS", group, names, "realCompilerImageNativeInvocations"))
                     for group, names in VIEW_CONTROL_GROUPS]
        requests += [
            ("cache-controls", "cache_controls.py", (), rb"Cache controls passed: 59; compiler/image/native calls: 0\n", None),
            ("elf-controls", "elf_controls_v2.py", (), rb"ELF modeled controls passed: [1-9][0-9]*; native executions: 0\n", None),
            ("elf-bss-controls", "elf_bss_controls.py", (), rb"ELF BSS controls passed: 43; native executions: 0\n", None),
            ("link-input-controls", "link_controls.py", (), rb"Link input controls passed: 66; compiler/process/container calls: 0\n", None),
            ("transfer-controls", "transfer_controls.py", (), None, None),
            ("host-file-controls", "host_files_controls.py", (), None, None)]
        requests += [("filtered-controls-" + group, "filtered_controls.py", (group,), None,
                      ("SUPPLIED_FILTERED_DRIVER_CONTROLS_PASS", group, names, "realExternalInvocations"))
                     for group, names in FILTERED_CONTROL_GROUPS]
        D.check(len(requests) == 26 and len({row[0] for row in requests}) == 26, "fixed prerequisite command plan")
        view_names, filtered_names = [], []
        for identity, script, arguments, expression, grouped in requests:
            attempt.guard()
            ok, output = attempt.command(identity, [sys.executable, "-I", "-S", "-B", str(packet / script), str(fixture)] + list(arguments), 5)
            attempt.guard()
            D.check(ok, "filtered fixed prerequisite controls command failed")
            if grouped is not None:
                status, group, names, external_field = grouped
                actual = grouped_control_result(output, status, group, names, external_field)
                (view_names if script == "view_controls.py" else filtered_names).extend(actual)
            elif identity in ("transfer-controls", "host-file-controls"):
                required_status, required_count = (("SUPPLIED_CONTROLS_PASS", 168) if identity == "transfer-controls" else
                                                    ("SUPPLIED_HOST_FILES_CONTROLS_PASS", 125))
                D.check(0 < len(output) <= 16384, "bounded supplied private-file controls result")
                result = json.loads(output, object_pairs_hook=T.unique_pairs, parse_constant=T.no_constant)
                D.check(type(result) is dict and set(result) == {"schema", "status", "cases", "names", "realDockerInvocations", "nativeQualification"} and
                        type(result["schema"]) is int and result["schema"] == 1 and result["status"] == required_status and
                        type(result["cases"]) is int and result["cases"] == required_count and type(result["names"]) is list and
                        len(result["names"]) == required_count and all(type(name) is str and 0 < len(name) <= 128 and
                        re.fullmatch(r"[A-Za-z0-9-]+", name) for name in result["names"]) and len(set(result["names"])) == required_count and
                        type(result["realDockerInvocations"]) is int and result["realDockerInvocations"] == 0 and
                        result["nativeQualification"] is False, "complete supplied private-file controls result")
                if identity == "transfer-controls":
                    D.check(tuple(result["names"]) == TRANSFER_CASE_NAMES, "complete exact transfer control catalog")
            else:
                D.check(re.fullmatch(expression, output), "filtered fixed prerequisite controls failed")
            attempt.guard()
        D.check(tuple(view_names) == expected_view and tuple(filtered_names) == expected_filtered,
                "complete exact prerequisite control disjoint union")
        attempt.events.append(dict(id="prerequisite-control-coverage", viewGroups=11, viewNames=view_names,
                                   filteredGroups=8, filteredNames=filtered_names, nativeQualification=False))
        attempt.save()
        attempt.guard()
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
        try:
            attempt.cleanup_after_attempt()
        finally:
            attempt.terminate_uncertain_host_files()
    attempt.finalize()


if __name__ == "__main__":
    main()
