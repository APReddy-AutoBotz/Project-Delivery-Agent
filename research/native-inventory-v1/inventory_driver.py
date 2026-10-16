"""EXEC-016/TR-DEP-004: fixed inventory-only research entrypoint.

No mode flag and no licence/adoption, image, compiler, ELF or model entry.
Unresolved policy observations are evidence, never permission to use an input.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
HELPER_SHA = "1e762d24376b1ced6e3f5e23215e274e48f03051726eb5037d73d67d8f1802ad"
helper = HERE / "host_driver.py"
if helper.is_symlink() or not helper.is_file() or hashlib.sha256(helper.read_bytes()).hexdigest() != HELPER_SHA:
    raise RuntimeError("exact reviewed inventory helper required")
spec = importlib.util.spec_from_file_location("inventory_fixed_helper", helper)
D = importlib.util.module_from_spec(spec)
spec.loader.exec_module(D)


def syntax_atoms(raw):
    """Finite expression syntax observation only; identifiers gain no approval."""
    D.check(0 < len(raw) <= 512 and all(b in (9, 32) or 33 <= b <= 126 for b in raw),
            "inventory SPDX bytes/ASCII budget")
    text = raw.decode("ascii")
    tokens, at = [], 0
    while at < len(text):
        if text[at] in " \t":
            at += 1
            continue
        D.check(len(tokens) < 256, "inventory SPDX token budget")
        token = re.match(r"[A-Za-z0-9.+:-]+|[()]", text[at:])
        D.check(token is not None, "inventory SPDX syntax token")
        tokens.append(token.group())
        at += len(token.group())
    position, nodes, atoms = 0, 0, []

    def node():
        nonlocal nodes
        D.check(nodes < 128, "inventory SPDX node budget")
        nodes += 1

    def primary(depth):
        nonlocal position
        D.check(position < len(tokens), "inventory SPDX missing operand")
        if tokens[position] == "(":
            D.check(depth < 16, "inventory SPDX depth budget")
            node()
            position += 1
            parse_or(depth + 1)
            D.check(position < len(tokens) and tokens[position] == ")", "inventory SPDX closing group")
            position += 1
            return
        identifier = tokens[position]
        D.check(identifier not in {"AND", "OR", "WITH", ")"}, "inventory SPDX identifier syntax")
        position += 1
        node()
        if position < len(tokens) and tokens[position] == "WITH":
            position += 1
            D.check(position < len(tokens) and tokens[position] not in {"AND", "OR", "WITH", "(", ")"},
                    "inventory SPDX exception syntax")
            identifier += " WITH " + tokens[position]
            position += 1
        atoms.append(identifier)

    def parse_and(depth):
        nonlocal position
        primary(depth)
        while position < len(tokens) and tokens[position] == "AND":
            node()
            position += 1
            primary(depth)

    def parse_or(depth):
        nonlocal position
        parse_and(depth)
        while position < len(tokens) and tokens[position] == "OR":
            node()
            position += 1
            parse_and(depth)

    parse_or(0)
    D.check(position == len(tokens), "inventory SPDX trailing token")
    return text, atoms


class InventoryAttempt(D.Attempt):
    def __init__(self, packet, fixture):
        self.receipt_verified, self.receipt_uncertain = {}, {}
        self.inventory_collected = self.finalization_attempted = False
        self.inventory_complete = False
        self.inventory_records = self.unresolved_files = self.unresolved_expressions = 0
        self.inventory_bytes, self.inventory_sha = 0, None
        super().__init__(packet, fixture)

    def save(self):
        if "attempt.json" in self.receipt_uncertain:
            self.failed, self.inventory_complete = True, False
        value = dict(elapsedSeconds=D.time.monotonic() - self.started, events=self.events,
                     containerCustody=self.containers, licenseGate=self.license_gate,
                     acceptedStories="5/38 unchanged", receiptUncertainties=dict(self.receipt_uncertain),
                     status=("INVENTORY_ONLY_COMPLETE_WITH_UNRESOLVED" if self.unresolved_files else
                            "INVENTORY_ONLY_COMPLETE_NO_ADMISSION") if self.inventory_complete and not self.failed else
                            "INVENTORY_ONLY_FAILED_OR_INCOMPLETE",
                     inventoryComplete=self.inventory_complete, inventoryRecords=self.inventory_records,
                     inventoryCollected=self.inventory_collected, finalizationAttempted=self.finalization_attempted,
                     unresolvedFiles=self.unresolved_files, unresolvedExpressions=self.unresolved_expressions,
                     inventoryBytes=self.inventory_bytes, inventorySha256=self.inventory_sha,
                     licenseGatePassed=False, compilerInvoked=False, modelsPassed=False,
                     inventoryOnly=True, nativeQualification=False, applicationCopy=False)
        payload = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
        # An uncertain original receipt is evidence, never a pathname to repair.
        name = "inventory-failure.json" if "attempt.json" in self.receipt_uncertain else "attempt.json"
        self.write_receipt(name, payload)

    def command(self, identity, argv, seconds, cleanup=False, capture_result=None):
        expected = {"driver-controls": "driver_controls.py", "inventory-controls": "inventory_controls.py"}
        D.check(identity in expected and argv == [sys.executable, "-I", "-S", "-B",
                str(self.packet / expected[identity]), str(self.fixture)] and seconds == 5 and
                not cleanup and capture_result is None, "inventory-only command boundary")
        return super().command(identity, argv, seconds)

    def write_receipt(self, name, payload, maximum=D.LIMIT):
        D.check(re.fullmatch(r"[a-z0-9-]+\.(?:json|txt)", name), "inventory owned receipt name")
        path = self.receipts / name
        D.check(name not in self.receipt_uncertain, "inventory uncertain receipt cannot be rewritten")
        D.check(name in self.receipt_verified or not path.exists(), "inventory unowned existing receipt")
        D.check(len(payload) <= maximum and self.receipt_bytes + len(payload) <= 16 * D.LIMIT,
                "inventory receipt byte budget")
        self.receipt_bytes += len(payload)  # old verified bytes remain charged until full success
        self.receipt_uncertain[name] = len(payload)
        written = path.write_bytes(payload)
        D.check(written == len(payload), "inventory short receipt write")
        self.receipt_bytes -= self.receipt_verified.get(name, 0)  # owned ledger, never a later pathname stat
        self.receipt_verified[name] = len(payload)
        del self.receipt_uncertain[name]

    def prohibited(self, *args, **kwargs):
        raise D.Refused("inventory-only prohibits image/container/compiler/ELF/model entry")

    docker_base = create = remove = build = inspect_then_models = prohibited

    def cleanup_after_attempt(self):
        try:
            self.cleanup()
        except BaseException as error:
            self.failed, self.inventory_complete = True, False
            self.events.append(dict(id="inventory-cleanup-failure", type=type(error).__name__, reason=str(error)[:256]))
            try:
                self.save()  # failure-only diagnostic; never retry cleanup or an uncertain path
            except BaseException as diagnostic:
                raise D.Refused("inventory cleanup and failure receipt unresolved") from diagnostic
            raise

    def finalize(self):
        D.check(not self.finalization_attempted, "inventory finalization already spent")
        self.finalization_attempted = True
        try:
            self.guard(0)  # SAME deadline after actual cleanup; no new interval
            D.check(self.inventory_collected and not self.failed and not self.containers and not self.receipt_uncertain,
                    "inventory-only attempt incomplete or custody unresolved")
            self.inventory_complete = True
            self.save()
            self.guard(0)  # terminal receipt writing is inside the owned clock
            D.check(self.inventory_complete and not self.failed and not self.receipt_uncertain,
                    "inventory final publication failed")
        except BaseException as error:
            self.inventory_complete = False
            self.failed = True
            self.events.append(dict(id="inventory-terminal-failure", type=type(error).__name__, reason=str(error)[:256]))
            self.save()
            raise

    def inventory(self, tool):
        self.license_gate = dict(stage="INVENTORY_SCOPE", path=None)
        scope = json.loads((self.packet / "license-scope.json").read_text())
        D.check(D.sha(self.packet / "LLVM-LICENSE.txt") == D.LLVM_NOTICE_SHA, "inventory LLVM notice identity")
        D.check(scope.get("spdxCompositionPolicy") == D.SPDX_POLICY, "inventory original policy identity")
        approved_roots = {"zig", "lib/std", "lib/compiler", "lib/compiler_rt", "lib/compiler_rt.zig", "lib/include",
            "lib/libc/musl", "lib/libc/include/generic-musl", "lib/libc/include/x86_64-linux-musl",
            "lib/libc/include/any-linux-any", "lib/libc/include/x86-linux-any"}
        D.check(len(scope["roots"]) == 11 and {r["path"] for r in scope["roots"]} == approved_roots,
                "inventory exact eleven roots")
        roots = []
        for row in scope["roots"]:
            path = tool / row["path"]
            self.license_gate = dict(stage="INVENTORY_ROOT", path=row["path"])
            D.check(set(row) == {"path", "component", "defaultExpression"} and
                    isinstance(row["component"], str) and isinstance(row["defaultExpression"], str), "inventory root schema")
            D.check(not path.is_symlink() and
                    (path.is_file() if row["path"] in {"zig", "lib/compiler_rt.zig"} else path.is_dir()),
                    "inventory mandatory root kind/absence")
            roots.append((path, row))
        seen = set()
        inventory_path = self.receipts / "inventory-files.txt"
        with inventory_path.open("xb") as output:
            for path in sorted(tool.rglob("*")):
                self.guard()
                D.check(not path.is_symlink(), "inventory source symlink")
                if not path.is_file():
                    continue
                matches = [row for root, row in roots if path == root or root in path.parents]
                if not matches:
                    continue
                D.check(len(matches) == 1, "inventory ambiguous root")
                row = matches[0]
                relative = path.relative_to(tool).as_posix()
                size = path.stat().st_size
                D.check(size <= 256 * D.LIMIT, "inventory individual file budget")
                digest = D.sha(path)
                identity = dict(path=relative, fileBytes=size, fileSha256=digest,
                                root=row["path"], component=row["component"])
                self.license_gate = dict(identity, stage="INVENTORY_FILE")
                self.guard()  # a large file hash cannot carry an expired admission forward
                prefix = b""
                if path.suffix.lower() in (".h", ".c", ".s", ".zig", ".txt") or path.name in ("COPYRIGHT", "LICENSE"):
                    with path.open("rb") as source:
                        prefix = source.read(16384)
                expressions, reasons, groups = [], [], []
                for raw, tail in D.identifier_expressions(prefix):
                    D.check(len(expressions) < 16, "inventory per-file SPDX count")
                    complete = not (tail and len(prefix) < size)
                    evidence, decoded = D.expression_evidence(raw, complete)
                    self.license_gate = dict(identity, stage="INVENTORY_EXPRESSION", **evidence)
                    D.check(len(json.dumps(self.license_gate).encode()) <= 8192, "inventory diagnostic budget")
                    D.check(complete, "inventory truncated SPDX line")
                    text, atoms = syntax_atoms(raw)  # malformed input is fatal, not unresolved policy
                    groups.append(atoms)
                    observation = dict(evidence, observedAtoms=atoms)
                    try:
                        D.spdx_terms(text, row["component"], row["path"])
                        observation["policyObservation"] = "MATCHES_PRIOR_RESEARCH_POLICY_NOT_ADMISSION"
                    except D.Refused as error:
                        observation.update(policyObservation="UNRESOLVED", policyReason=str(error)[:128])
                        reasons.append("SPDX_POLICY")
                        self.unresolved_expressions += 1
                    expressions.append(observation)
                text = prefix.decode("utf-8", errors="replace")  # notice classification only, never exact-expression evidence
                if re.search(r"GNU\s+(?:LESSER(?:\s+GENERAL)?|LIBRARY\s+GENERAL)\s+PUBLIC\s+LICENSE", text, re.I):
                    reasons.append("LGPL_NOTICE_UNRESOLVED_UNDER_PRIOR_POLICY")
                if re.search(r"GNU\s+GENERAL\s+PUBLIC\s+LICENSE", text, re.I):
                    if not (row["component"] == "Linux-UAPI" and row["path"] in D.UAPI_ROOTS and groups and
                        all(any(a in {b + " WITH Linux-syscall-note" for b in D.GPL_SYSCALL_BASES} for a in g) for g in groups)):
                        reasons.append("GPL_NOTICE_UNRESOLVED_UNDER_PRIOR_POLICY")
                if re.search(r"GNU\s+Affero|Server\s+Side\s+Public\s+License|Business\s+Source\s+Licen[cs]e|"
                    r"Commons\s+Clause|non[- ]commercial\s+(?:use|only)|licensed\s+under\s+(?:an?\s+)?unknown|"
                    r"proprietary\s+(?:licen[cs]e|rights|use\s+only)|(?:may|must)\s+not\s+redistribute", text, re.I):
                    reasons.append("CONTRARY_OR_UNCLASSIFIED_NOTICE")
                record = dict(identity, expressions=expressions, unresolvedReasons=sorted(set(reasons)),
                    observedDisposition="UNRESOLVED" if reasons else "PRIOR_POLICY_MATCH_NOT_ADMISSION",
                    inheritedPublisherExpression=None if expressions else row["defaultExpression"])
                payload = json.dumps(record, sort_keys=True).encode() + b"\n"
                self.guard()
                D.check(self.inventory_records < 100000 and len(payload) <= 65536 and
                        self.inventory_bytes + len(payload) <= 12 * D.LIMIT and
                        self.receipt_bytes + len(payload) <= 15 * D.LIMIT, "inventory count/row/aggregate budget")
                self.receipt_bytes += len(payload)  # reserve before write; uncertain/short writes stay charged
                written = output.write(payload)
                D.check(written == len(payload), "inventory short record write")
                self.inventory_bytes += written
                self.inventory_records += 1
                self.unresolved_files += bool(reasons)
                seen.add(relative)
                self.guard()
            output.flush()
        self.guard()  # includes flush and close
        self.license_gate = dict(stage="INVENTORY_SENTINELS", path=None)
        D.check(len(scope["requiredHeaders"]) == len(set(scope["requiredHeaders"])) == 46 and
                all(relative in seen for relative in scope["requiredHeaders"]), "inventory required 46 headers")
        D.check(inventory_path.stat().st_size == self.inventory_bytes, "inventory final byte count")
        self.inventory_sha = D.sha(inventory_path)
        self.guard()  # includes final readback/hash, before reserving cleanup time
        self.inventory_collected = True
        self.license_gate = dict(stage="INVENTORY_ONLY_COLLECTED_NO_ADMISSION", path="inventory-files.txt")
        self.save()
        self.guard()  # readiness receipt cannot consume the cleanup reserve silently


def main():
    D.check(sys.platform == "linux" and os.uname().machine == "x86_64" and sys.version_info[:2] == (3, 12),
            "inventory nominated Linux x86_64 Python3.12")
    D.check(len(sys.argv) == 2 and os.getuid() != 0 and D.pwd.getpwuid(os.getuid()).pw_name == "runner",
            "inventory exact arguments/account")
    packet = Path(sys.argv[1]).resolve(strict=True)
    D.check(Path(sys.argv[1]).absolute() == packet == Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True) /
            "research/native-inventory-v1", "inventory fixed packet root")
    D.check(os.environ.get("GITHUB_REPOSITORY") == "APReddy-AutoBotz/Project-Delivery-Agent" and
            os.environ.get("GITHUB_REF") == "refs/heads/codex/native-inventory-research-v1" and
            os.environ.get("GITHUB_RUN_ATTEMPT") == "1" and re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")),
            "inventory exact destination/first attempt")
    manifest_path = packet / "packet.json"
    D.check(manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_size <= D.LIMIT and
            D.sha(manifest_path) == os.environ.get("PDAA_PACKET_SHA256"), "inventory bound packet")
    manifest = json.loads(manifest_path.read_text())
    expected = {"inventory_driver.py", "inventory_controls.py", "host_driver.py", "driver_controls.py", "license-scope.json", "LLVM-LICENSE.txt", "README.md"}
    D.check(set(manifest) == {"schema", "files"} and manifest["schema"] == 1 and len(manifest["files"]) == len(expected),
            "inventory exact packet schema")
    seen = set()
    for row in manifest["files"]:
        D.check(set(row) == {"path", "bytes", "sha256"} and row["path"] in expected and row["path"] not in seen and
                isinstance(row["bytes"], int) and 0 <= row["bytes"] <= D.LIMIT and
                re.fullmatch(r"[0-9a-f]{64}", row["sha256"]), "inventory exact packet row")
        path = packet / row["path"]
        D.check(path.is_file() and not path.is_symlink() and path.resolve(strict=True) == path and
                path.stat().st_size == row["bytes"] and D.sha(path) == row["sha256"], "inventory frozen source")
        seen.add(row["path"])
    fixture = Path(os.environ["RUNNER_TEMP"]) / "pdaa-native-inventory-v1"
    attempt = InventoryAttempt(packet, fixture)
    try:
        attempt.events.append(dict(id="host", uname=list(os.uname()), python=sys.version,
            executable=str(Path(sys.executable).resolve()), executableSha256=D.sha(Path(sys.executable).resolve()),
            workflowCommit=os.environ.get("GITHUB_SHA")))
        for identity, script, expression in (("driver-controls", "driver_controls.py", rb"Driver modeled controls passed: 306; network/process/container calls: 0\n"),
                ("inventory-controls", "inventory_controls.py", rb"Inventory controls passed: [1-9][0-9]*; compiler/image/native calls: 0\n")):
            ok, output = attempt.command(identity, [sys.executable, "-I", "-S", "-B", str(packet / script), str(fixture)], 5)
            D.check(ok and re.fullmatch(expression, output), "inventory prerequisite controls failed")
        tool = attempt.download_extract()
        attempt.inventory(tool)
    except BaseException as error:
        attempt.failed = True
        attempt.events.append(dict(id="inventory-failure", type=type(error).__name__, reason=str(error)[:512]))
        attempt.save()
        raise
    finally:
        attempt.cleanup_after_attempt()
    attempt.finalize()


if __name__ == "__main__":
    main()
