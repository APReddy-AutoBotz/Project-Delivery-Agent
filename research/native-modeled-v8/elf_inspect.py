"""EXEC-016/TR-DEP-004: bounded ELF inspection for three research models only.

No subprocesses, target attachment, native loading or execution. This deliberately
restricted parser rejects unsupported ELF layouts/call encodings. Byte scanning
is an extra rejection check, not disassembly or a zero-kernel-effects proof.
"""
import hashlib
import json
import os
import stat
import struct
from pathlib import Path

WRAPS = frozenset(("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs",
                   "readdir", "closedir", "getrlimit", "setrlimit", "prctl", "syscall"))
MAX_FILE = 32 * 1024 * 1024
FORBIDDEN = (b"\x0f\x05", b"\x0f\x34", b"\xcd\x80")
RELOCATION_WIDTHS = {1: 8, 2: 4, 4: 4, 10: 4, 11: 4}
# Static musl's retained metadata can contain TLS/GOT references. These known
# storage widths are accepted for bounds checking only; first-party function
# comparison below still accepts only the five reviewed direct forms above.
ELF_STORAGE_WIDTHS = dict(RELOCATION_WIDTHS, **{})
ELF_STORAGE_WIDTHS.update({9: 4, 17: 8, 18: 8, 21: 4, 22: 4, 23: 4, 24: 8, 25: 8, 26: 4, 41: 4, 42: 4})


class Rejected(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Rejected(reason)


def span(data, offset, size):
    require(isinstance(offset, int) and isinstance(size, int) and
            0 <= offset <= len(data) and 0 <= size <= len(data) - offset, "file bounds")
    return data[offset:offset + size]


def unpack(data, fmt, offset):
    return struct.unpack(fmt, span(data, offset, struct.calcsize(fmt)))


def string(data, offset):
    require(0 <= offset < len(data), "string offset")
    end = data.find(b"\0", offset, min(len(data), offset + 1025))
    require(end >= offset, "bounded terminated string")
    try:
        return data[offset:end].decode("ascii")
    except UnicodeDecodeError as error:
        raise Rejected("non-ASCII ELF name") from error


class Elf:
    def __init__(self, data, expected_type):
        require(64 <= len(data) <= MAX_FILE, "ELF file size")
        self.data = data
        h = unpack(data, "<16sHHIQQQIHHHHHH", 0)
        ident, kind, machine, version, entry, phoff, shoff, flags, ehsize, phsize, phnum, shsize, shnum, names = h
        require(ident[:9] == b"\x7fELF\x02\x01\x01\x00\x00" and ident[9:] == b"\0" * 7,
                "ELF64 little endian System V identity")
        require(kind == expected_type and machine == 62 and version == 1 and flags == 0 and ehsize == 64,
                "ELF type/architecture/version")
        require(1 <= shnum <= 2048 and shsize == 64 and 0 < names < shnum, "section table shape")
        require(0 <= phnum <= 32 and ((phsize == 56 and phoff >= 64) if phnum else phoff == 0),
                "program table shape")
        require((kind == 1 and phnum == 0 and entry == 0) or (kind == 2 and phnum > 0 and entry > 0),
                "object/executable layout")
        span(data, shoff, shnum * 64)
        if phnum:
            span(data, phoff, phnum * 56)
        occupied = [(0, 64), (shoff, shoff + shnum * 64)]
        if phnum:
            occupied.append((phoff, phoff + phnum * 56))
        self.sections = []
        for index in range(shnum):
            name, stype, sflags, addr, off, size, link, info, align, entsize = unpack(data, "<IIQQQQIIQQ", shoff + index * 64)
            require(align == 0 or (align <= 1048576 and align & (align - 1) == 0), "section alignment")
            require(stype not in (6, 9, 18) and not sflags & 0x800, "dynamic/REL/extended/compressed section")
            if index == 0:
                require((name, stype, sflags, addr, off, size, link, info, align, entsize) == (0,) * 10,
                        "null section")
            elif stype != 8 and size:
                span(data, off, size)
                occupied.append((off, off + size))
            require(not (sflags & 1 and sflags & 4), "writable executable section")
            require(not sflags & 4 or sflags & 2, "nonallocated executable section")
            self.sections.append(dict(index=index, name_offset=name, type=stype, flags=sflags,
                                      addr=addr, offset=off, size=size, link=link, info=info, entsize=entsize))
        for left, right in zip(sorted(occupied), sorted(occupied)[1:]):
            require(left[1] <= right[0], "overlapping file regions")
        name_section = self.sections[names]
        require(name_section["type"] == 3, "section names string table")
        names_data = self.section_data(name_section)
        for section in self.sections:
            section["name"] = string(names_data, section["name_offset"])
        loads = []
        load_mappings = []
        executable_entry = False
        for index in range(phnum):
            ptype, pflags, off, va, pa, filesz, memsz, align = unpack(data, "<IIQQQQQQ", phoff + index * 56)
            require(ptype not in (2, 3) and pflags & ~7 == 0, "dynamic/interpreter/unknown segment flags")
            require(filesz <= memsz and va <= (1 << 64) - memsz, "segment memory bounds")
            span(data, off, filesz)
            if ptype == 1:
                require(not (pflags & 1 and pflags & 2), "writable executable load")
                require(align in (0, 1) or (align & (align - 1) == 0 and off % align == va % align),
                        "load alignment")
                loads.append((va, va + memsz))
                load_mappings.append((off, va, filesz, memsz, pflags))
                if pflags & 1 and va <= entry < va + filesz:
                    executable_entry = True
        for left, right in zip(sorted(loads), sorted(loads)[1:]):
            require(left[1] <= right[0], "overlapping load regions")
        require(kind != 2 or executable_entry, "entry outside executable load")
        if kind == 2:
            for section in self.sections:
                if not section["flags"] & 2 or not section["size"]:
                    continue
                mappings = [p for p in load_mappings if p[1] <= section["addr"] and
                            section["size"] <= p[1] + (p[3] if section["type"] == 8 else p[2]) - section["addr"]]
                require(len(mappings) == 1, "allocated section load coverage")
                off, va, filesz, memsz, pflags = mappings[0]
                if section["type"] != 8:
                    require(section["offset"] == off + section["addr"] - va, "section/load byte correspondence")
                elif section["flags"] == 3:
                    # Ordinary writable NOBITS is memory, not initialized file
                    # bytes. TLS and other layouts remain outside this branch.
                    require(section["addr"] >= va + filesz and
                            section["size"] <= va + memsz - section["addr"],
                            "NOBITS outside zero-fill load tail")
                require(not section["flags"] & 4 or pflags & 1, "code outside executable load")
                require(not section["flags"] & 1 or pflags & 2, "writable section outside writable load")
        tables = [s for s in self.sections if s["type"] == 2]
        require(len(tables) == 1, "exactly one retained symbol table")
        table = tables[0]
        require(table["entsize"] == 24 and table["size"] % 24 == 0 and
                1 <= table["size"] // 24 <= 65536 and 0 < table["link"] < shnum,
                "symbol table shape")
        text = self.sections[table["link"]]
        require(text["type"] == 3, "symbol names table")
        text_data = self.section_data(text)
        self.symbols = []
        for index in range(table["size"] // 24):
            name, info, other, section, value, size = unpack(data, "<IBBHQQ", table["offset"] + index * 24)
            require(section < shnum or section == 0xfff1, "symbol section index")
            symbol = dict(index=index, name=string(text_data, name), binding=info >> 4, type=info & 15,
                          visibility=other, section=section, value=value, size=size)
            if index == 0:
                require((name, info, other, section, value, size) == (0,) * 6, "null symbol")
            self.symbols.append(symbol)
        self.relocations = []
        for section in self.sections:
            if section["type"] != 4:
                continue
            require(section["link"] == table["index"] and 0 < section["info"] < shnum and
                    section["entsize"] == 24 and section["size"] % 24 == 0, "RELA shape/link")
            require(len(self.relocations) + section["size"] // 24 <= 65536, "relocation budget")
            target = self.sections[section["info"]]
            for index in range(section["size"] // 24):
                offset, info, addend = unpack(data, "<QQq", section["offset"] + index * 24)
                require(info >> 32 < len(self.symbols), "relocation symbol index")
                relative = offset if kind == 1 else offset - target["addr"]
                width = ELF_STORAGE_WIDTHS.get(info & 0xffffffff)
                require(width is not None and 0 <= relative <= target["size"] and
                        width <= target["size"] - relative, "relocation type/full target span")
                self.relocations.append(dict(section=target["index"], offset=relative,
                                             type=info & 0xffffffff, symbol=self.symbols[info >> 32], addend=addend))
        self.kind = kind

    def section_data(self, section):
        require(section["type"] != 8, "NOBITS has no file data")
        return span(self.data, section["offset"], section["size"])

    def functions(self):
        result = []
        for symbol in self.symbols:
            if symbol["type"] != 2 or symbol["section"] in (0, 0xfff1):
                continue
            section = self.sections[symbol["section"]]
            require(section["flags"] & 6 == 6 and section["type"] == 1, "function outside allocated code section")
            offset = symbol["value"] if self.kind == 1 else symbol["value"] - section["addr"]
            require(0 <= offset <= section["size"] and 0 <= symbol["size"] <= section["size"] - offset,
                    "function bounds")
            if symbol["size"]:
                result.append(dict(symbol, offset=offset))
        return result

    def function(self, name):
        matches = [s for s in self.functions() if s["name"] == name]
        require(len(matches) == 1, "unique function: " + name)
        return matches[0]

    def code(self, symbol):
        section = self.sections[symbol["section"]]
        return span(self.section_data(section), symbol["offset"], symbol["size"])


def scan_first_party_object(elf):
    elf.functions()  # validate every function, not just installer functions
    for section in elf.sections:
        if section["flags"] & 4:
            require(not any(op in elf.section_data(section) for op in FORBIDDEN), "first-party native opcode")
    require(not any(s["name"].startswith("__real_") for s in elf.symbols), "real-symbol escape")


def compare_nobits_destination(obj, model, source_section, target_section, source_offset, target_offset):
    """Bind one zero-initialized object arithmetically; never allocate zeros."""
    require(source_section["type"] == target_section["type"] == 8 and
            source_section["flags"] == target_section["flags"] == 3 and
            source_section["entsize"] == target_section["entsize"] == 0,
            "ordinary NOBITS destination required")

    def objects(elf, section):
        result = []
        for symbol in elf.symbols:
            if symbol["type"] != 1 or symbol["section"] != section["index"]:
                continue
            start = symbol["value"] if elf.kind == 1 else symbol["value"] - section["addr"]
            require(0 <= start <= section["size"] and 0 < symbol["size"] <= section["size"] - start,
                    "NOBITS object extent")
            result.append((symbol, start))
        return result

    source_objects = objects(obj, source_section)
    source_matches = [(symbol, start) for symbol, start in source_objects
                      if start <= source_offset < start + symbol["size"]]
    require(len(source_matches) == 1 and source_matches[0][0]["name"], "unique named NOBITS source anchor")
    original, source_start = source_matches[0]
    require(len([s for s in obj.symbols if s["type"] == 1 and s["name"] == original["name"]]) == 1,
            "unique named NOBITS source anchor")
    matches = [s for s in model.symbols if s["type"] == 1 and s["name"] == original["name"]]
    require(len(matches) == 1 and matches[0]["section"] == target_section["index"],
            "unique corresponding NOBITS linked anchor")
    destination = matches[0]
    target_objects = objects(model, target_section)
    target_start = destination["value"] - target_section["addr"]
    require(destination["size"] == original["size"] and destination["binding"] == original["binding"] and
            destination["visibility"] == original["visibility"], "NOBITS anchor identity changed")
    for collection, anchor, start in ((source_objects, original, source_start),
                                       (target_objects, destination, target_start)):
        require(not any(symbol["index"] != anchor["index"] and other < start + anchor["size"] and
                        start < other + symbol["size"] for symbol, other in collection),
                "overlapping NOBITS anchor")
    require(0 <= source_offset - source_start < original["size"] and
            target_offset - target_start == source_offset - source_start,
            "NOBITS object displacement changed")


def compare_function(obj, original, model, linked):
    """Require byte equality except actual, understood relocation storage.

    This binds the reviewed first-party body to the inspected executable. The
    relocation values are separately checked, including non-native references.
    Unknown widths/types and overlapping fixups refuse the model.
    """
    require(original["size"] == linked["size"], "retained source function size")
    left, right = bytearray(obj.code(original)), bytearray(model.code(linked))
    used = set()
    for ref in obj.relocations:
        if ref["section"] != original["section"] or not original["offset"] <= ref["offset"] < original["offset"] + original["size"]:
            continue
        width = RELOCATION_WIDTHS.get(ref["type"])
        require(width is not None, "unsupported first-party relocation type")
        delta = ref["offset"] - original["offset"]
        require(delta + width <= len(left) and not any(i in used for i in range(delta, delta + width)),
                "overlapping/out-of-function relocation")
        used.update(range(delta, delta + width))
        matching = [r for r in model.relocations if r["section"] == linked["section"] and
                    r["offset"] == linked["offset"] + delta]
        require(len(matching) == 1, "retained source relocation missing/duplicate")
        final = matching[0]
        require(final["type"] == ref["type"], "relocation type changed")
        target = final["symbol"]
        require(target["section"] != 0, "unresolved linked relocation")
        expected_name = "__wrap_" + ref["symbol"]["name"] if ref["symbol"]["name"] in WRAPS else ref["symbol"]["name"]
        # Local section symbols have empty names; their section identity must
        # match the corresponding source section name (LLD can merge .text.*).
        if ref["symbol"]["type"] != 3:
            require(target["name"] == expected_name and final["addend"] == ref["addend"],
                    "relocation redirected to different symbol/addend")
        else:
            require(target["type"] == 3 and target["section"] != 0xfff1, "section relocation target changed")
            source_section = obj.sections[ref["symbol"]["section"]]
            target_section = model.sections[target["section"]]
            bias = 4 if ref["type"] in (2, 4) else 0
            source_offset = ref["symbol"]["value"] + ref["addend"] + bias
            target_offset = target["value"] + final["addend"] + bias - target_section["addr"]
            require(source_section["flags"] & 7 == target_section["flags"] & 7 and
                    0 <= source_offset < source_section["size"] and 0 <= target_offset < target_section["size"],
                    "section-relative relocation correspondence")
            if source_section["type"] == target_section["type"] == 8:
                compare_nobits_destination(obj, model, source_section, target_section, source_offset, target_offset)
            elif source_section["type"] != 1 or target_section["type"] != 1:
                raise Rejected("section-relative relocation correspondence")
            elif source_section["flags"] & 4:
                destination_functions = [f for f in obj.functions() if f["section"] == source_section["index"] and
                                         f["offset"] == source_offset]
                require(len(destination_functions) == 1 and
                        model.function(destination_functions[0]["name"])["value"] == target_section["addr"] + target_offset,
                        "section-relative function destination")
            else:
                data = obj.section_data(source_section)[source_offset:]
                if source_section["flags"] & 0x20:  # SHF_STRINGS: allow exact pooled/suffix-merged string
                    end = data.find(b"\0")
                    require(end >= 0 and source_section["entsize"] == 1, "supported string relocation")
                    data = data[:end + 1]
                require(data == span(model.section_data(target_section), target_offset, len(data)),
                        "section-relative data destination")
        value = target["value"] + final["addend"]
        if ref["type"] in (2, 4):
            value -= linked["value"] + delta
        signed = ref["type"] in (2, 4, 11)
        require(-(1 << (8 * width - 1)) <= value < (1 << (8 * width - 1)) if signed else
                0 <= value < (1 << (8 * width)), "relocation result overflow")
        require(int.from_bytes(right[delta:delta + width], "little", signed=signed) == value,
                "linked relocation bytes mismatch")
        left[delta:delta + width] = b"\0" * width
        right[delta:delta + width] = b"\0" * width
    require(left == right, "first-party function bytes changed")


def inspect_wrapping(policy, model):
    """Prove every actual installer boundary call reaches its exact mock body."""
    undefined = {s["name"] for s in policy.symbols if s["index"] and s["section"] == 0}
    require(undefined == WRAPS | {"__errno_location"}, "installer undefined boundary set")
    require(not any(s["name"].startswith("__real_") for s in model.symbols), "linked real-symbol escape")
    edges = []
    for name in sorted(WRAPS):
        symbols = [s for s in policy.symbols if s["name"] == name]
        require(len(symbols) == 1 and symbols[0]["section"] == 0 and symbols[0]["binding"] == 1 and
                symbols[0]["visibility"] == 0, "unambiguous undefined native symbol")
        mock = model.function("__wrap_" + name)
        require(mock["binding"] == 1 and mock["visibility"] == 0, "global mock definition")
        require(not any(s["name"] == name and s["section"] != 0 for s in model.symbols),
                "unwrapped native function retained")
        references = [r for r in policy.relocations if r["symbol"]["name"] == name]
        require(references, "native boundary lacks relocation")
        for ref in references:
            require(ref["type"] in (2, 4) and ref["addend"] == -4, "unsupported native relocation")
            owners = [s for s in policy.functions() if s["section"] == ref["section"] and
                      s["offset"] < ref["offset"] and ref["offset"] + 4 <= s["offset"] + s["size"]]
            require(len(owners) == 1, "native call function owner")
            owner = owners[0]
            linked = model.function(owner["name"])
            require(owner["size"] == linked["size"], "link changed function shape")
            delta = ref["offset"] - owner["offset"]
            original_code, linked_code = policy.code(owner), model.code(linked)
            require(original_code[delta - 1] == 0xe8 and linked_code[delta - 1] == 0xe8,
                    "native edge is not supported direct call")
            destination = linked["value"] + delta + 4 + struct.unpack("<i", span(linked_code, delta, 4))[0]
            require(destination == mock["value"], "native call does not land on mock")
            matching = [r for r in model.relocations if r["section"] == linked["section"] and
                        r["offset"] == linked["offset"] + delta]
            require(len(matching) == 1 and matching[0]["type"] in (2, 4) and matching[0]["addend"] == -4 and
                    matching[0]["symbol"]["name"] == "__wrap_" + name, "retained wrapped relocation")
            # No other named function may alias the mock entry address.
            require(not any(s["name"] != mock["name"] and s["section"] not in (0, 0xfff1) and
                            s["type"] == 2 and s["value"] == mock["value"] for s in model.symbols), "mock alias")
            edges.append(dict(native=name, owner=owner["name"], displacement=delta, destination=destination))
    return edges


def inspect_model(objects, model, selected):
    require(selected in ("policy", "installer", "state"), "unknown model")
    all_names = {s["name"] for s in model.symbols}
    require(not any(name.startswith("pdaa_observer_") for name in all_names), "observer retained")
    require(len(objects) == 2, "two fixed first-party model objects")
    source_functions = {}
    for obj in objects:
        for function in obj.functions():
            require(function["name"] not in source_functions, "ambiguous source function name")
            source_functions[function["name"]] = (obj, function)
            matches = [s for s in model.functions() if s["name"] == function["name"]]
            # gc-sections may remove unused functions; any retained source body
            # must preserve the reviewed no-relax/no-ICF/O0 shape and opcode check.
            require(len(matches) <= 1, "ambiguous retained source function")
            if matches:
                compare_function(obj, function, model, matches[0])
                require(not any(op in model.code(matches[0]) for op in FORBIDDEN), "linked first-party native opcode")
    model.function("main")
    require("main" in source_functions, "main missing from source objects")
    if selected == "installer":
        for name in ("pdaa_install_lifecycle_policy", "bounded_proc_inventory") + tuple("__wrap_" + n for n in WRAPS):
            require(name in source_functions, "required installer source function missing")
            model.function(name)
    if selected == "policy":
        require("pdaa_install_lifecycle_policy" not in all_names and "bounded_proc_inventory" not in all_names,
                "BPF-only model retains installer")
    if selected != "installer":
        require(not any(name.startswith("__wrap_") for name in all_names), "unexpected mocked installer")
    return inspect_wrapping(objects[0], model) if selected == "installer" else []


def read_artifact(path):
    """Bound acquisition itself, from one no-follow regular-file descriptor."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode) and 64 <= before.st_size <= MAX_FILE, "regular bounded artifact")
        data = bytearray()
        while len(data) <= MAX_FILE:
            block = os.read(descriptor, min(65536, MAX_FILE + 1 - len(data)))
            if not block:
                break
            data.extend(block)
        after = os.fstat(descriptor)
        require(len(data) == before.st_size == after.st_size and len(data) <= MAX_FILE and
                before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns,
                "artifact changed/overflowed while reading")
        return bytes(data)
    finally:
        os.close(descriptor)


def inspect_directory(directory):
    root = Path(directory)
    names = ("policy", "policy-controls", "policy-install-controls", "state", "state-controls", "observer")
    objects = {}
    hashes = {}
    for name in names:
        path = root / (name + ".o")
        require(path.is_file() and not path.is_symlink(), "regular object required")
        data = read_artifact(path)
        objects[name] = Elf(data, 1)
        scan_first_party_object(objects[name])
        hashes[path.name] = hashlib.sha256(data).hexdigest()
    definitions = {"policy": ("policy", "policy-controls"),
                   "installer": ("policy", "policy-install-controls"),
                   "state": ("state", "state-controls")}
    edges = {}
    for name, inputs in definitions.items():
        path = root / (name + "-model")
        require(path.is_file() and not path.is_symlink(), "regular model required")
        data = read_artifact(path)
        model = Elf(data, 2)
        edges[name] = inspect_model([objects[item] for item in inputs], model, name)
        hashes[path.name] = hashlib.sha256(data).hexdigest()
    return dict(status="INSPECTED_MODELS_ONLY", hashes=hashes, wrappedEdges=edges,
                observerLinked=False, nativeQualification=False)


if __name__ == "__main__":
    import sys
    require(len(sys.argv) == 2, "one artifact directory required")
    print(json.dumps(inspect_directory(sys.argv[1]), sort_keys=True))
