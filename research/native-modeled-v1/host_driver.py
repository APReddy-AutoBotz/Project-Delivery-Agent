"""EXEC-016/TR-DEP-004: one-use hosted compiler/model research driver.

Invoke only after BOTH reviews bind this exact packet. No application install,
database, observer entrypoint, customer secrets or operational admission.
"""
import hashlib
import importlib.util
import io
import json
import lzma
import os
import pwd
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import struct
import subprocess
import sys
import tarfile
import time
import urllib.request

IMAGE = "node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df"
ARCHIVE = "https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz"
ARCHIVE_SHA = "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239"
ARCHIVE_SIZE = 53733924
TOP = "zig-x86_64-linux-0.15.2"
UNITS = ("policy", "policy-controls", "policy-install-controls", "state", "state-controls", "observer")
BASE = "recognition-lifecycle-"
LINKS = {"policy": ("policy", "policy-controls"), "installer": ("policy", "policy-install-controls"),
         "state": ("state", "state-controls")}
WRAPS = ("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs", "readdir", "closedir",
         "getrlimit", "setrlimit", "prctl", "syscall")
COMMON = ["/tool/zig", "cc", "-target", "x86_64-linux-musl", "-mcpu=baseline", "-std=c17", "-O0",
          "-fno-lto", "-fno-pie", "-fno-pic", "-fno-builtin", "-fno-inline", "-fno-optimize-sibling-calls",
          "-fno-stack-protector", "-fno-stack-clash-protection", "-fno-unwind-tables",
          "-fno-asynchronous-unwind-tables", "-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=0",
          "-ffunction-sections", "-fdata-sections", "-fuse-ld=lld"]
INCLUDES = ["-nostdinc", "-I/src"]
for include in ("lib/include", "lib/libc/include/x86_64-linux-musl", "lib/libc/include/generic-musl",
                "lib/libc/include/x86_64-linux-any", "lib/libc/include/any-linux-any"):
    INCLUDES += ["-isystem", "/tool/" + include]
LIMIT = 1024 * 1024
LLVM_NOTICE_SHA = "8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee"


class Refused(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        raise Refused("archive redirect refused before follow")


def check(value, reason):
    if not value:
        raise Refused(reason)


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def module(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


class XzReader(io.RawIOBase):
    """Bound the decompressor dictionary and total expanded tar framing too."""
    def __init__(self, stream, guard):
        self.stream, self.guard = stream, guard
        self.decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=128 * LIMIT)
        self.buffer, self.total, self.done = b"", 0, False

    def readable(self):
        return True

    def readinto(self, destination):
        self.guard()
        while not self.buffer and not self.done:
            block = self.stream.read(65536) if self.decoder.needs_input else b""
            check(block or not self.decoder.needs_input, "truncated XZ")
            self.buffer = self.decoder.decompress(block, max_length=65536)
            self.total += len(self.buffer)
            check(self.total <= 2 * 1024 * LIMIT, "expanded archive budget")
            self.done = self.decoder.eof
            if self.done:
                check(not self.decoder.unused_data and not self.stream.read(1), "trailing XZ data")
        size = min(len(destination), len(self.buffer))
        destination[:size], self.buffer = self.buffer[:size], self.buffer[size:]
        return size


class Attempt:
    def __init__(self, packet, fixture):
        # Creation is the clock origin; the directory is never reused.
        self.started = time.monotonic()
        self.deadline = self.started + 600
        self.packet, self.fixture = packet, fixture
        fixture.mkdir(mode=0o700)
        self.receipts = fixture / "receipts"
        self.receipts.mkdir(mode=0o700)
        self.events, self.log_bytes, self.containers = [], 0, []
        self.receipt_bytes = 0
        self.success, self.models_passed, self.failed = False, False, False
        self.name = "pdaa-modeled-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]

    def guard(self, reserve=20):
        check(time.monotonic() < self.deadline - reserve, "research deadline")

    def save(self):
        value = dict(status="PASS_MODELED_ONLY" if self.success else "FAILED_OR_INCOMPLETE",
                     elapsedSeconds=time.monotonic() - self.started, events=self.events,
                     containerCustody=self.containers,
                     modelsPassed=self.models_passed,
                     nativeQualification=False, applicationCopy=False, acceptedStories="5/38 unchanged")
        payload = json.dumps(value, indent=2, sort_keys=True).encode() + b"\n"
        check(len(payload) <= LIMIT, "receipt budget")
        self.write_receipt("attempt.json", payload)

    def write_receipt(self, name, payload, maximum=LIMIT):
        check(re.fullmatch(r"[a-z0-9-]+\.(?:json|txt)", name), "owned receipt filename")
        path = self.receipts / name
        previous = path.stat().st_size if path.exists() else 0
        check(len(payload) <= maximum and self.receipt_bytes - previous + len(payload) <= 16 * LIMIT,
              "aggregate receipt byte budget")
        path.write_bytes(payload)
        self.receipt_bytes += len(payload) - previous

    def command(self, identity, argv, seconds, cleanup=False, capture_result=None):
        check(not any(row.get("id") == identity for row in self.events), "command identity reuse")
        self.guard(0 if cleanup else 20)
        duration = min(seconds, self.deadline - time.monotonic() - (0 if cleanup else 20))
        check(duration > 0, "no command time remains")
        row = dict(id=identity, argv=argv, status="ATTEMPTED", seconds=duration)
        self.events.append(row)  # retain attempted identity before process acquisition
        self.save()
        began = time.monotonic()
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.fixture), "LANG": "C", "LC_ALL": "C"}
        process, selector = None, None
        output = bytearray()
        reason = None
        try:
            self.guard(0 if cleanup else 20)
            duration = min(seconds, self.deadline - time.monotonic() - (0 if cleanup else 20))
            check(duration > 0, "no fresh command entry time remains")
            began = time.monotonic()
            row["seconds"] = duration
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, env=env, start_new_session=True)
            row["hostPid"] = process.pid
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() - began >= duration:
                    reason = "TIMEOUT"
                    break
                for key, _ in selector.select(min(0.1, max(0, duration - (time.monotonic() - began)))):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    remaining = min(LIMIT - len(output), 16 * LIMIT - self.log_bytes,
                                    14 * LIMIT - self.receipt_bytes - len(output))
                    output.extend(block[:max(remaining, 0)])
                    self.log_bytes += min(len(block), max(remaining, 0))
                    if len(block) > remaining:
                        reason = "OUTPUT_LIMIT"
                        break
                if reason:
                    break
            if reason:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=max(0.01, min(1, self.deadline - time.monotonic())))
            if capture_result is not None:
                capture_result(reason or ("PASSED" if process.returncode == 0 else "FAILED"),
                               process.returncode, bytes(output))
        except BaseException as error:
            reason = "DRIVER_EXCEPTION"
            row["exceptionType"] = type(error).__name__
            raise
        finally:
            try:
                if selector is not None:
                    selector.close()
            finally:
                if process is not None:
                    try:
                        process.stdout.close()
                    finally:
                        if process.poll() is None:
                            row["hostKillAttempted"] = True
                            os.killpg(process.pid, signal.SIGKILL)
                            process.wait(timeout=max(0.01, min(1, self.deadline - time.monotonic())))
                row.update(status=reason or ("PASSED" if process is not None and process.returncode == 0 else "FAILED"),
                           returncode=process.returncode if process is not None else None,
                           elapsedSeconds=time.monotonic() - began,
                           outputSha256=hashlib.sha256(output).hexdigest(), outputBytes=len(output))
                self.write_receipt(identity + ".txt", output)
                self.save()
        return row["status"] == "PASSED", bytes(output)

    def download_extract(self):
        self.guard()
        archive = self.fixture / "zig.tar.xz"
        digest, count = hashlib.sha256(), 0
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(ARCHIVE, headers={"User-Agent": "PDAA-modeled-research/1"})
        row = dict(id="archive", status="ATTEMPTED", url=ARCHIVE)
        self.events.append(row)
        self.save()
        self.guard()
        timeout = min(10, self.deadline - time.monotonic() - 20)
        check(timeout > 0, "no archive request time remains")
        with opener.open(request, timeout=timeout) as response, archive.open("xb") as target:
            check(response.status == 200 and response.url == ARCHIVE, "archive status/redirect")
            while block := response.read(65536):
                self.guard()
                count += len(block)
                check(count <= ARCHIVE_SIZE, "archive compressed byte limit")
                digest.update(block)
                target.write(block)
        check(count == ARCHIVE_SIZE and digest.hexdigest() == ARCHIVE_SHA, "archive authentication")
        row.update(status="AUTHENTICATED", bytes=count, sha256=digest.hexdigest())
        tool_parent = self.fixture / "tools"
        tool_parent.mkdir()
        entries, total, notices, seen = 0, 0, [], set()
        with archive.open("rb") as compressed:
            with io.BufferedReader(XzReader(compressed, self.guard), buffer_size=65536) as stream:
                # Decode only fixed 512-byte headers. TarFile's automatic GNU
                # long-name/PAX payload acquisition is intentionally not used.
                while True:
                        header = stream.read(512)
                        check(len(header) == 512, "truncated tar header")
                        if header == b"\0" * 512:
                            check(stream.read(512) == b"\0" * 512, "two tar terminal blocks required")
                            break
                        member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
                        self.guard()
                        entries += 1
                        check(entries <= 100000, "archive entry budget")
                        path = PurePosixPath(member.name)
                        raw_parts = member.name.rstrip("/").split("/")
                        check(len(member.name) <= 512 and not path.is_absolute() and raw_parts and
                              raw_parts[0] == TOP and all(p not in ("", ".", "..") for p in raw_parts) and
                              "\\" not in member.name and not member.pax_headers, "archive path/PAX refusal")
                        check(member.name.isascii() and all(32 <= ord(c) < 127 for c in member.name) and
                              tuple(raw_parts) not in seen, "archive duplicate/control-character path")
                        seen.add(tuple(raw_parts))
                        check(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) and member.sparse is None,
                              "archive link/extension/special entry refused")
                        check(0 <= member.size <= 256 * LIMIT, "archive member size")
                        total += member.size
                        check(total <= 1536 * LIMIT, "archive file payload budget")
                        target = tool_parent.joinpath(*path.parts)
                        if member.isdir():
                            check(member.size == 0, "directory payload refused")
                            target.mkdir(parents=True, exist_ok=True)
                            continue
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open("xb") as output:
                            left = member.size
                            while left:
                                self.guard()
                                block = stream.read(min(left, 65536))
                                check(block, "truncated archive member")
                                output.write(block)
                                left -= len(block)
                        padding = (-member.size) % 512
                        check(stream.read(padding) == b"\0" * padding, "tar member padding")
                        target.chmod(0o555 if path.name == "zig" and len(path.parts) == 2 else 0o444)
                        if re.search(r"(^|[-_.])(LICENSE|LICENCE|COPYRIGHT|COPYING|NOTICE)([-_.]|$)", path.name, re.I):
                            check(member.size <= 256 * 1024 and len(notices) < 512, "license notice budget")
                            notices.append(dict(path=str(path.relative_to(TOP)), sha256=sha(target), bytes=member.size))
                # Drain finite tar padding through the authenticated XZ EOF.
                padding_bytes = 0
                while padding := stream.read(65536):
                    self.guard()
                    padding_bytes += len(padding)
                    check(padding_bytes <= LIMIT and not padding.strip(b"\0"), "tar terminal padding")
        check(any(n["path"] == "LICENSE" for n in notices), "Zig license missing")
        check(any(n["path"] == "lib/libc/musl/COPYRIGHT" for n in notices), "musl copyright missing")
        tool = tool_parent / TOP
        license_text = (tool / "LICENSE").read_text()
        musl_text = (tool / "lib/libc/musl/COPYRIGHT").read_text()
        check("MIT License" in license_text and "Zig contributors" in license_text and
              "musl as a whole is licensed" in musl_text and "standard MIT" in musl_text,
              "published tool/runtime license identities")
        # Concrete LLVM/compiler-runtime and UAPI disposition remains an explicit
        # review input; the inventory cannot infer package-wide MIT licensing.
        inventory = dict(archiveSha256=ARCHIVE_SHA, entries=entries, payloadBytes=total,
                         compilerSha256=sha(tool / "zig"), notices=notices,
                         adoptionStatus="QUARANTINED_AWAITING_ACTUAL_LICENSE_REVIEW")
        self.write_receipt("tool-inventory.json", json.dumps(inventory, indent=2).encode() + b"\n")
        self.save()
        return tool

    def docker_base(self, name):
        check(re.fullmatch(r"pdaa-modeled-[0-9]+-[0-9]+(?:-[a-z]+)?", name), "owned container name")
        cpus = sorted(os.sched_getaffinity(0))[:2]
        check(cpus, "CPU affinity unavailable")
        args = ["/usr/bin/docker", "create", "--name", name, "--label", "com.pdaa.modeled=" + self.name,
                "--user", "1000:1000", "--read-only",
                "--network", "none", "--ipc", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "32", "--cpus", "2",
                "--cpuset-cpus", ",".join(map(str, cpus)), "--ulimit", "nofile=128:128", "--ulimit", "core=0:0",
                "--log-driver", "none", "--env", "HOME=/work", "--env", "LANG=C", "--env", "LC_ALL=C",
                "--env", "PATH=/usr/bin:/bin", "--env", "TMPDIR=/work", "--env", "ZIG_LIB_DIR=/tool/lib",
                "--env", "ZIG_LOCAL_CACHE_DIR=/work/local-cache", "--env", "ZIG_GLOBAL_CACHE_DIR=/work/global-cache",
                "--tmpfs", "/work:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=0700"]
        check(not any(r["name"] == name for r in self.containers), "container intent reuse")
        self.containers.append(dict(name=name, id=None, createAttempted=False, removeAttempted=False, removed=False))
        return args

    def create(self, name, identity, argv):
        row = next(r for r in self.containers if r["name"] == name)
        check(not row["createAttempted"], "container creation already spent")
        row["createAttempted"] = True
        def retain(status, returncode, output):
            returned = output.decode("ascii", errors="replace").strip()
            if status == "PASSED" and returncode == 0 and re.fullmatch(r"[0-9a-f]{64}", returned):
                row["id"] = returned  # before any output-receipt/finalization write
                self.events.append(dict(id="admit-" + name, containerId=returned))
        ok, output = self.command(identity, argv, 5, capture_result=retain)
        if ok and row["id"] is not None:
            return True
        self.events.append(dict(id="uncertain-create-" + name, status="UNRESOLVED_NO_ADMITTED_ID"))
        self.save()
        return False

    def remove(self, name):
        custody = next(r for r in self.containers if r["name"] == name)
        check(custody["id"] is not None and not custody["removeAttempted"], "no admitted/unspent container removal")
        custody["removeAttempted"] = True
        ok, output = self.command("inspect-owner-" + name, ["/usr/bin/docker", "inspect", "--format",
                                "{{.Id}} {{index .Config.Labels \"com.pdaa.modeled\"}}", custody["id"]], 2, cleanup=True)
        # Missing/uncertain custody is a failed cleanup receipt, never permission
        # to delete a different container or to claim terminal closure.
        check(ok, "container ownership/absence unresolved: " + name)
        parts = output.decode("ascii").strip().split()
        check(len(parts) == 2 and parts[0] == custody["id"] and parts[1] == self.name,
              "container ownership mismatch")
        ok, _ = self.command("remove-" + name, ["/usr/bin/docker", "rm", "--force", parts[0]], 3, cleanup=True)
        check(ok, "owned container removal unresolved")
        custody["removed"] = True

    def licenses(self, tool):
        disposition = json.loads((self.packet / "license-scope.json").read_text())
        llvm = disposition.get("llvmNotice", {})
        notice = self.packet / "LLVM-LICENSE.txt"
        check(llvm == {"file": "LLVM-LICENSE.txt", "sha256": LLVM_NOTICE_SHA, "version": "llvmorg-20.1.8",
                       "appliesToCompilerMajor": 20,
                       "upstream": "https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-20.1.8/llvm/LICENSE.TXT"} and
              notice.is_file() and not notice.is_symlink() and sha(notice) == LLVM_NOTICE_SHA,
              "missing/changed concrete LLVM publisher notice")
        notice_text = notice.read_text()
        check("Apache License v2.0 with LLVM Exceptions" in notice_text and
              "Legacy LLVM License" in notice_text and "University of Illinois/NCSA" in notice_text,
              "LLVM current/legacy component terms")
        clang_header = tool / "lib/include/stddef.h"
        check(clang_header.is_file() and clang_header.stat().st_size <= 16384 and
              "SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception" in clang_header.read_text(),
              "actual bundled Clang-header notice applicability")
        approved_roots = {"zig", "lib/std", "lib/compiler", "lib/compiler_rt", "lib/compiler_rt.zig", "lib/include",
                          "lib/libc/musl", "lib/libc/include/generic-musl", "lib/libc/include/x86_64-linux-musl",
                          "lib/libc/include/any-linux-any", "lib/libc/include/x86_64-linux-any"}
        check(isinstance(disposition, dict) and isinstance(disposition.get("roots"), list) and
              len(disposition["roots"]) == len(approved_roots) and
              {r["path"] for r in disposition["roots"]} == approved_roots, "exact reviewed tool input roots")
        records, roots = [], []
        for row in disposition["roots"]:
            check(set(row) == {"path", "component", "defaultExpression"} and
                  isinstance(row["component"], str) and isinstance(row["defaultExpression"], str), "licence root schema")
            path = tool / row["path"]
            check(path.exists() and not path.is_symlink(), "declared tool input missing: " + row["path"])
            roots.append((path, row))
        for path in sorted(tool.rglob("*")):
            self.guard()
            if not path.is_file():
                continue
            relative = path.relative_to(tool).as_posix()
            matches = [(p, row) for p, row in roots if path == p or p in path.parents]
            if not matches:
                continue
            check(len(matches) == 1, "ambiguous tool input licence root")
            row = matches[0][1]
            check(path.stat().st_size <= 256 * LIMIT, "tool input file budget")
            prefix = b""
            if path.suffix.lower() in (".h", ".c", ".s", ".zig", ".txt") or path.name in ("COPYRIGHT", "LICENSE"):
                with path.open("rb") as stream:
                    prefix = stream.read(16384)
            text = prefix.decode("utf-8", errors="replace")
            expressions = re.findall(r"SPDX-License-Identifier:\s*([^\r\n*]+)", text)
            for expression in expressions:
                check(expression.strip() in disposition["allowedSpdx"], "unreviewed tool input SPDX: " + relative)
            if re.search(r"GNU (?:GENERAL|LESSER|LIBRARY GENERAL) PUBLIC LICENSE", text, re.I):
                check(row["component"] == "Linux-UAPI" and expressions and
                      all("WITH Linux-syscall-note" in e for e in expressions), "unexcepted GPL/LGPL input")
            # Publisher-root inheritance is explicit for these authenticated
            # component trees. A file-specific contrary/unclassified notice
            # cannot silently fall back to that publisher licence.
            check(not re.search(r"GNU\s+Affero|Server\s+Side\s+Public\s+License|Business\s+Source\s+Licen[cs]e|"
                                r"Commons\s+Clause|non[- ]commercial\s+(?:use|only)|licensed\s+under\s+(?:an?\s+)?unknown|"
                                r"proprietary\s+(?:licen[cs]e|rights|use\s+only)|(?:may|must)\s+not\s+redistribute",
                                text, re.I), "contrary/unclassified input notice")
            records.append(dict(path=relative, sha256=sha(path), component=row["component"],
                                licenseExpressions=expressions or [row["defaultExpression"]],
                                licenseSource="file-SPDX" if expressions else "reviewed-authenticated-publisher-root"))
            check(len(records) <= 100000, "tool input inventory count")
        for relative in disposition["requiredHeaders"]:
            check(any(r["path"] == relative for r in records), "required bundled header unavailable: " + relative)
        payload = json.dumps(dict(scope=disposition, inputs=records), sort_keys=True).encode() + b"\n"
        check(len(payload) <= 12 * LIMIT, "tool licence/input inventory byte budget")
        self.write_receipt("licensed-inputs.json", payload, maximum=12 * LIMIT)
        self.events.append(dict(id="license-input-gate", status="PASSED_SELECTED_RESEARCH_SCOPE",
                                files=len(records), inventorySha256=hashlib.sha256(payload).hexdigest(),
                                llvmNoticeSha256=LLVM_NOTICE_SHA, bundledClangHeaderSha256=sha(clang_header)))
        self.save()
        return {r["path"]: r for r in records}

    def build(self, tool, licensed):
        ok, output = self.command("docker-version", ["/usr/bin/docker", "version", "--format", "{{json .}}"], 5)
        check(ok, "nominated Docker unavailable")
        ok, _ = self.command("image-pull", ["/usr/bin/docker", "pull", "--platform", "linux/amd64", IMAGE], 90)
        check(ok, "exact image pull failed")
        ok, output = self.command("image-identity", ["/usr/bin/docker", "image", "inspect", "--format",
                              "{{.Os}} {{.Architecture}} {{.Size}} {{.Id}}", IMAGE], 5)
        words = output.decode("ascii").strip().split()
        check(ok and len(words) == 4 and words[:2] == ["linux", "amd64"] and int(words[2]) <= 512 * LIMIT,
              "image platform/storage identity")
        container = self.name + "-build"
        create = self.docker_base(container)
        create += ["--mount", "type=bind,src=" + str(self.packet / "native") + ",dst=/src,readonly",
                   "--mount", "type=bind,src=" + str(tool) + ",dst=/tool,readonly",
                   "--entrypoint", "/usr/local/bin/node", IMAGE, "-e", "setInterval(()=>{},1000)"]
        ok = self.create(container, "build-create", create)
        check(ok, "build container create failed")
        container_name = container
        container = next(r["id"] for r in self.containers if r["name"] == container_name)
        ok, _ = self.command("build-start", ["/usr/bin/docker", "start", container], 5)
        check(ok, "build container start failed")
        execute = ["/usr/bin/docker", "exec", "--workdir", "/work", container]
        ok, output = self.command("compiler-version", execute + ["/tool/zig", "version"], 5)
        check(ok and output == b"0.15.2\n", "compiler version mismatch")
        ok, output = self.command("clang-version", execute + ["/tool/zig", "cc", "--version"], 5)
        check(ok and re.search(rb"clang version 20\.1\.[0-9]+(?:\s|$)", output), "publisher LLVM20.1 compiler scope mismatch")
        outcomes = {}
        for unit in UNITS:
            argv = COMMON + INCLUDES + ["-Wall", "-Wextra", "-Werror", "-MD", "-MF", "/work/" + unit + ".d",
                    "-c", "/src/" + BASE + unit + ".c", "-o", "/work/" + unit + ".o"]
            ok, _ = self.command("compile-" + unit, execute + argv, 30)
            outcomes[unit] = ok
            # A killed/timed out/output-limited compiler can leave engine-side
            # children. Stop all progression and retire the whole container.
            check(self.events[-1]["status"] not in ("TIMEOUT", "OUTPUT_LIMIT"), "compiler closure requires container retirement")
        linked = {}
        for name, inputs in LINKS.items():
            if not all(outcomes[unit] for unit in inputs):
                self.events.append(dict(id="link-" + name, status="SKIPPED_FAILED_DEPENDENCY"))
                linked[name] = False
                continue
            argv = COMMON + ["-static", "-no-pie", "-Wl,--gc-sections", "-Wl,--emit-relocs", "-Wl,--icf=none",
                             "-Wl,--no-relax", "-Wl,-Map,/work/" + name + ".map"]
            if name == "installer":
                argv += ["-Wl,--wrap=" + boundary for boundary in WRAPS]
            argv += ["/work/" + unit + ".o" for unit in inputs] + ["-o", "/work/" + name + "-model"]
            ok, _ = self.command("link-" + name, execute + argv, 30)
            linked[name] = ok
            check(self.events[-1]["status"] not in ("TIMEOUT", "OUTPUT_LIMIT"), "linker closure requires container retirement")
        artifacts = self.fixture / "artifacts"
        artifacts.mkdir(mode=0o755)
        # Copy only fixed paths; each individual file and the whole tmpfs have
        # finite bounds. No cache/tool archive/binary is published by the workflow.
        wanted = [unit + suffix for unit in UNITS for suffix in (".o", ".d") if outcomes[unit]]
        wanted += [name + suffix for name in LINKS for suffix in ("-model", ".map") if linked[name]]
        snapshot_script = (
            "const fs=require('fs'),c=require('crypto');const out=[];let total=0;"
            "for(const n of " + json.dumps(wanted) + "){const p='/work/'+n,s=fs.lstatSync(p);"
            "const max=n.endsWith('.d')||n.endsWith('.map')?1048576:33554432;"
            "if(!s.isFile()||s.size<0||s.size>max)throw Error('artifact bounds');"
            "total+=s.size;if(total>268435456)throw Error('aggregate artifacts');"
            "const b=fs.readFileSync(p);if(b.length!==s.size)throw Error('changed artifact');"
            "out.push({name:n,bytes:b.length,sha256:c.createHash('sha256').update(b).digest('hex')});}"
            "process.stdout.write(JSON.stringify(out)+'\\n');")
        ok, output = self.command("artifact-source-snapshot", execute + ["/usr/local/bin/node", "-e", snapshot_script], 5)
        check(ok, "bounded artifact source inventory failed")
        snapshot = json.loads(output)
        check(isinstance(snapshot, list) and len(snapshot) == len(wanted) and
              [r["name"] for r in snapshot] == wanted, "artifact source inventory shape")
        for index, name in enumerate(wanted):
            ok, _ = self.command("copy-" + str(index), ["/usr/bin/docker", "cp", container + ":/work/" + name,
                                                       str(artifacts / name)], 3)
            check(ok and (artifacts / name).is_file() and not (artifacts / name).is_symlink() and
                  (artifacts / name).stat().st_size == snapshot[index]["bytes"] <= 32 * LIMIT and
                  sha(artifacts / name) == snapshot[index]["sha256"], "bounded unchanged regular compiler artifact")
        self.remove(container_name)
        # No compiler process can alter artifacts after retirement. Host-owned
        # files are read-only; the model containers receive only a read-only mount.
        for path in artifacts.iterdir():
            path.chmod(0o555 if path.name.endswith("-model") else 0o444)
        for unit in UNITS:
            if not outcomes[unit]:
                continue
            data = (artifacts / (unit + ".d")).read_bytes()
            check(len(data) <= LIMIT and b"\0" not in data, "bounded dependency file")
            deps = data.decode("utf-8").replace("\\\n", " ").split(":", 1)
            check(len(deps) == 2 and deps[1].split(), "dependency file shape")
            for dep in deps[1].split():
                if dep.startswith("/tool/"):
                    relative = dep[len("/tool/"):]
                    check(relative in licensed and sha(tool / relative) == licensed[relative]["sha256"],
                          "unapproved/changed tool dependency")
                else:
                    check(dep.startswith("/src/") and "/" not in dep[len("/src/"):] and
                          (self.packet / "native" / dep[len("/src/"):]).is_file(), "foreign header dependency")
        check(all(outcomes.values()) and all(linked.values()), "retained compiler/link failures; model inspection skipped")
        # The exact link map is retained locally and hashed. Every input-like path
        # must name a reviewed first-party object or fresh Zig-owned runtime cache.
        for name in LINKS:
            data = (artifacts / (name + ".map")).read_bytes()
            check(len(data) <= LIMIT, "link map budget")
            paths = re.findall(rb"(?:/[^\s():]+)+\.(?:o|a)", data)
            check(paths and all(p.startswith((b"/work/local-cache/", b"/work/global-cache/")) or
                               p.decode() in {"/work/" + u + ".o" for u in LINKS[name]} for p in paths),
                  "unexpected link input path")
            self.events.append(dict(id="map-" + name, sha256=hashlib.sha256(data).hexdigest(), bytes=len(data)))
        self.inspect_then_models(artifacts)

    def inspect_then_models(self, artifacts):
        ok, output = self.command("elf-inspection", [sys.executable, "-I", "-S", "-B",
                                  str(self.packet / "elf_inspect.py"), str(artifacts)], 10)
        check(ok, "bounded ELF inspection failed")
        inspection = json.loads(output)
        expected_artifacts = {u + ".o" for u in UNITS} | {n + "-model" for n in LINKS}
        check(set(inspection) == {"status", "hashes", "wrappedEdges", "observerLinked", "nativeQualification"} and
              inspection["status"] == "INSPECTED_MODELS_ONLY" and inspection["observerLinked"] is False and
              inspection["nativeQualification"] is False and set(inspection["hashes"]) == expected_artifacts and
              all(re.fullmatch(r"[a-f0-9]{64}", h) for h in inspection["hashes"].values()), "ELF result schema")
        self.write_receipt("elf-inspection.json", json.dumps(inspection, indent=2).encode() + b"\n")
        for name in LINKS:
            path = artifacts / (name + "-model")
            check(sha(path) == inspection["hashes"][path.name], "inspected artifact changed")
            model_container = self.name + "-" + name
            create = self.docker_base(model_container)
            create += ["--mount", "type=bind,src=" + str(artifacts) + ",dst=/models,readonly",
                       "--entrypoint", "/models/" + path.name, IMAGE]
            ok = self.create(model_container, "model-create-" + name, create)
            check(ok, "model container create failed")
            model_id = next(r["id"] for r in self.containers if r["name"] == model_container)
            check(sha(path) == inspection["hashes"][path.name], "artifact changed before model entry")
            ok, output = self.command("model-" + name, ["/usr/bin/docker", "start", "--attach", model_id], 5)
            expected = {"policy": rb"Native policy modeled controls passed: 83; structural checks: 1; policy installs: 0\n",
                        "installer": rb"Native installer modeled cases passed: 35; kernel installs: 0\n",
                        "state": rb"Native lifecycle modeled checks passed: [1-9][0-9]{0,8}; kernel observer calls: 0\n"}[name]
            matched = ok and re.fullmatch(expected, output) is not None
            ok, state = self.command("model-exit-" + name, ["/usr/bin/docker", "inspect", "--format",
                                    "{{json .State}}", model_id], 2)
            terminal = json.loads(state) if ok else {}
            matched = matched and terminal.get("Status") == "exited" and terminal.get("ExitCode") == 0 and \
                terminal.get("OOMKilled") is False and terminal.get("Error") == ""
            self.remove(model_container)
            check(matched, "modeled result failure or unexpected output")
        self.models_passed = True
        self.save()

    def cleanup(self):
        failures = []
        for custody in reversed(self.containers):
            name = custody["name"]
            if not custody["removed"]:
                try:
                    self.remove(name)
                except BaseException as error:
                    failures.append(dict(container=name, type=type(error).__name__, reason=str(error)[:256]))
        if failures:
            self.events.append(dict(id="unresolved-cleanup", failures=failures))
        census_ok = not self.containers
        if self.containers:
            try:
                ok, output = self.command("final-container-census", ["/usr/bin/docker", "ps", "--all", "--quiet",
                                          "--filter", "label=com.pdaa.modeled=" + self.name], 3, cleanup=True)
                census_ok = ok and not output.strip()
            except BaseException as error:
                census_ok = False
                self.failed = True
                self.events.append(dict(id="census-exception", type=type(error).__name__, reason=str(error)[:256]))
            if not census_ok:
                self.events.append(dict(id="unresolved-container-census", status="FAILED"))
        self.success = self.models_passed and not self.failed and not failures and census_ok
        self.save()


def main():
    check(sys.platform == "linux" and os.uname().machine == "x86_64" and sys.version_info[:2] == (3, 12),
          "nominated Linux x86_64 Python3.12 host required")
    check(len(sys.argv) == 2, "one exact packet path required")
    check(os.getuid() != 0 and pwd.getpwuid(os.getuid()).pw_name == "runner", "nominated unprivileged runner account")
    packet_arg = Path(sys.argv[1])
    packet = packet_arg.resolve(strict=True)
    check(packet == Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True) / "research/native-modeled-v1" and
          packet_arg.absolute() == packet, "exact research packet root")
    manifest_path = packet / "packet.json"
    check(manifest_path.is_file() and not manifest_path.is_symlink() and manifest_path.stat().st_size <= LIMIT,
          "bounded regular packet manifest")
    check(sha(manifest_path) == os.environ.get("PDAA_PACKET_SHA256"), "workflow-bound packet manifest hash")
    manifest = json.loads(manifest_path.read_text())
    expected = {"host_driver.py", "elf_inspect.py", "elf_controls_v2.py", "driver_controls.py", "license-scope.json", "LLVM-LICENSE.txt", "README.md"}
    expected |= {"native/" + BASE + unit + ".c" for unit in UNITS}
    expected |= {"native/" + BASE + unit + ".h" for unit in ("policy", "state", "observer")}
    check(set(manifest) == {"schema", "files"} and manifest["schema"] == 1 and isinstance(manifest["files"], list) and
          len(manifest["files"]) == len(expected), "exact packet schema/file count")
    check(os.environ.get("GITHUB_REPOSITORY") == "APReddy-AutoBotz/Project-Delivery-Agent" and
          os.environ.get("GITHUB_REF") == "refs/heads/codex/native-modeled-research-v1" and
          os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "exact hosted destination/first attempt")
    check(re.fullmatch(r"[0-9]+", os.environ.get("GITHUB_RUN_ID", "")), "run identity")
    seen = set()
    for row in manifest["files"]:
        check(isinstance(row, dict) and set(row) == {"path", "bytes", "sha256"} and row["path"] in expected and
              row["path"] not in seen and isinstance(row["bytes"], int) and 0 <= row["bytes"] <= LIMIT and
              isinstance(row["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]), "exact packet file row")
        seen.add(row["path"])
        path = packet / row["path"]
        check(path.is_file() and not path.is_symlink() and path.stat().st_size == row["bytes"] and
              path.resolve(strict=True) == path and sha(path) == row["sha256"], "frozen packet input: " + row["path"])
    fixture = Path(os.environ["RUNNER_TEMP"]) / "pdaa-native-modeled-v1"
    attempt = Attempt(packet, fixture)
    try:
        attempt.events.append(dict(id="host", uname=list(os.uname()), python=sys.version,
                                   executable=str(Path(sys.executable).resolve()),
                                   executableSha256=sha(Path(sys.executable).resolve()),
                                   workflowCommit=os.environ.get("GITHUB_SHA")))
        ok, output = attempt.command("driver-controls", [sys.executable, "-I", "-S", "-B",
                                    str(packet / "driver_controls.py"), str(fixture)], 5)
        check(ok and re.fullmatch(rb"Driver modeled controls passed: [1-9][0-9]*; network/process/container calls: 0\n", output),
              "research driver modeled controls failed")
        tool = attempt.download_extract()
        licensed = attempt.licenses(tool)
        # Pure Python parser controls precede compiler entry, in the same clock.
        ok, output = attempt.command("elf-controls", [sys.executable, "-I", "-S", "-B",
                                    str(packet / "elf_controls_v2.py"), str(fixture)], 5)
        check(ok and re.fullmatch(rb"ELF modeled controls passed: [1-9][0-9]*; native executions: 0\n", output),
              "ELF modeled controls failed")
        attempt.build(tool, licensed)
    except BaseException as error:
        attempt.success = False
        attempt.failed = True
        attempt.events.append(dict(id="failure", type=type(error).__name__, reason=str(error)[:512]))
        attempt.save()
        raise
    finally:
        attempt.cleanup()
    check(attempt.success, "research attempt or final cleanup failed; see retained receipts")


if __name__ == "__main__":
    main()
