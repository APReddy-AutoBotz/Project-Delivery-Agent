"""EXEC-016: synthetic NOBITS correspondence; no native execution or loading."""
import importlib.util
from pathlib import Path
import struct

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


I = module("bss_inspector", "elf_inspect.py")
OLD = module("bss_existing_fixture_builder", "elf_controls_v2.py")
WRAPS = ("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs", "readdir", "closedir",
         "getrlimit", "setrlimit", "prctl", "syscall")


def fixture(kind, installer=False, absolute=False, bss_type=8, extra_source=False, duplicate_ref=False):
    """Handwritten small ELF with a section-symbol reference into a real BSS.

    An RX text segment and a separate RW memory segment describe ET_EXEC.
    NOBITS payload has no file bytes. Only the PROGBITS mismatch fixture has
    a small explicit initialized payload; no section-sized generic allocation.
    """
    executable = kind == 2
    begin = 176 if executable else 64
    base = 0x400000 + begin if executable else 0
    bss_addr = 0x600000 if executable else 0
    bss_size, object_at = (64, 32) if executable else (16, 0)
    wraps = sorted(WRAPS)
    owner = "pdaa_install_lifecycle_policy"
    helper = "bounded_proc_inventory"
    reference = b"\x48\xb8" + b"\0" * 8 + b"\xc3" if absolute else b"\x48\x8d\x05" + b"\0" * 4 + b"\xc3"
    functions = ([(owner, b"\xe8\0\0\0\0" * 12), (helper, b"\xc3"), ("read_zero", reference)]
                 if installer else [("main", reference)])
    if executable and installer:
        functions += [("__wrap_" + name, b"\xc3") for name in wraps] + [("main", b"\xc3")]
    undefined = wraps + ["__errno_location"] if installer and not executable else []
    positions, code = {}, bytearray()
    for name, body in functions:
        positions[name] = len(code)
        code.extend(body)
    names = [""] + [name for name, _ in functions] + undefined + ["zero_object", "other_zero"]
    strings, offsets = bytearray(b"\0"), {"": 0}
    for name in names[1:]:
        offsets[name] = len(strings)
        strings.extend(name.encode() + b"\0")
    symbols = [b"\0" * 24]
    indices = {}
    for name, body in functions:
        indices[name] = len(symbols)
        symbols.append(struct.pack("<IBBHQQ", offsets[name], 0x12, 0, 1, base + positions[name], len(body)))
    for name in undefined:
        indices[name] = len(symbols)
        symbols.append(struct.pack("<IBBHQQ", offsets[name], 0x10, 0, 0, 0, 0))
    anchor = len(symbols)
    symbols.append(struct.pack("<IBBHQQ", offsets["zero_object"], 0x11, 0, 2, bss_addr + object_at, 16))
    other = None
    if executable or extra_source:
        other = len(symbols)
        symbols.append(struct.pack("<IBBHQQ", offsets["other_zero"], 0x11, 0, 2, bss_addr, 16))
    section_symbol = len(symbols)
    symbols.append(struct.pack("<IBBHQQ", 0, 3, 0, 2, bss_addr, 0))
    relocations = []
    if installer:
        for index, name in enumerate(wraps):
            at = positions[owner] + index * 5 + 1
            target = "__wrap_" + name if executable else name
            relocations.append(struct.pack("<QQq", base + at, (indices[target] << 32) | 4, -4))
            if executable:
                code[at:at + 4] = struct.pack("<i", positions[target] - at - 4)
    function = "read_zero" if installer else "main"
    field = positions[function] + (2 if absolute else 3)
    relocation_type, width, bias = (1, 8, 0) if absolute else (2, 4, 4)
    addend = object_at + 15 - bias
    bss_ref = struct.pack("<QQq", base + field, (section_symbol << 32) | relocation_type, addend)
    relocations.append(bss_ref)
    if duplicate_ref:
        relocations.append(bss_ref)
    if executable:
        value = bss_addr + addend - (0 if absolute else base + field)
        code[field:field + width] = value.to_bytes(width, "little", signed=not absolute)
    bss_name = ".bss" if executable else ".bss.object"
    section_names = ("\0.text\0" + bss_name + "\0.strtab\0.symtab\0.rela.text\0.shstrtab\0").encode()
    pieces = [bytes(code), b"\0" * bss_size if bss_type == 1 else b"", bytes(strings),
              b"".join(symbols), b"".join(relocations), section_names]
    file_offsets, body = [], bytearray()
    for piece in pieces:
        file_offsets.append(begin + len(body))
        body.extend(piece)
    shoff = begin + len(body)
    descriptions = ((".text", 1, 6, base, len(code), 0, 0, 1, 0),
                    (bss_name, bss_type, 3, bss_addr, bss_size, 0, 0, 8, 0),
                    (".strtab", 3, 0, 0, len(pieces[2]), 0, 0, 1, 0),
                    (".symtab", 2, 0, 0, len(pieces[3]), 3, 1, 8, 24),
                    (".rela.text", 4, 0, 0, len(pieces[4]), 4, 1, 8, 24),
                    (".shstrtab", 3, 0, 0, len(pieces[5]), 0, 0, 1, 0))
    sections = [b"\0" * 64]
    for index, (name, stype, flags, addr, size, link, info, align, entsize) in enumerate(descriptions):
        sections.append(struct.pack("<IIQQQQIIQQ", section_names.index(name.encode() + b"\0"), stype, flags,
                                    addr, file_offsets[index], size, link, info, align, entsize))
    header = struct.pack("<16sHHIQQQIHHHHHH", b"\x7fELF\x02\x01\x01" + b"\0" * 9, kind, 62, 1,
                         base if executable else 0, 64 if executable else 0, shoff, 0,
                         64, 56 if executable else 0, 2 if executable else 0, 64, 7, 6)
    programs = b""
    if executable:
        text_end = begin + len(code)
        programs = struct.pack("<IIQQQQQQ", 1, 5, 0, 0x400000, 0x400000, text_end, text_end, 4096)
        programs += struct.pack("<IIQQQQQQ", 1, 6, file_offsets[1], bss_addr, bss_addr,
                                bss_size if bss_type == 1 else 0, bss_size, 1)
    return header + programs + body + b"".join(sections), dict(
        code=begin, field=begin + field, fieldOffset=field, width=width, base=base, bssAddr=bss_addr,
        bssSection=shoff + 2 * 64, anchor=file_offsets[3] + anchor * 24,
        other=None if other is None else file_offsets[3] + other * 24,
        sectionSymbol=file_offsets[3] + section_symbol * 24,
        strings=file_offsets[2], zeroName=offsets["zero_object"], otherName=offsets["other_zero"],
        relaSection=shoff + 5 * 64, bssRef=file_offsets[4] + (12 if installer else 0) * 24,
        zeroProgram=120 if executable else None)


def patch(data, offset, fmt, value):
    result = bytearray(data)
    struct.pack_into(fmt, result, offset, value)
    return bytes(result)


def run():
    count = 0
    controls, _ = OLD.fixture(1, [("__wrap_" + name, b"\xc3") for name in sorted(WRAPS)] + [("main", b"\xc3")])

    def compare(source, linked, installer=False):
        obj, model = I.Elf(source, 1), I.Elf(linked, 2)
        if installer:
            edges = I.inspect_model([obj, I.Elf(controls, 1)], model, "installer")
            assert len(edges) == 12 and {edge["native"] for edge in edges} == set(WRAPS)
        else:
            I.scan_first_party_object(obj)
            I.compare_function(obj, obj.function("main"), model, model.function("main"))
        return obj, model

    for absolute in (False, True):
        for installer in (False, True):
            source, _ = fixture(1, installer, absolute)
            linked, _ = fixture(2, installer, absolute)
            compare(source, linked, installer)
            count += 1
    source, src = fixture(1)
    linked, dst = fixture(2)

    def deny(bad_source, bad_linked, reason):
        nonlocal count
        compare(source, linked)  # establish valid unmodified baseline externally
        try:
            compare(bad_source, bad_linked)
        except I.Rejected as error:
            assert str(error) == reason
        else:
            raise AssertionError("invalid NOBITS fixture accepted")
        count += 1

    wrong_type, _ = fixture(1, bss_type=1)
    deny(wrong_type, linked, "section-relative relocation correspondence")
    for which, at in (("source", src), ("linked", dst)):
        data = source if which == "source" else linked
        bad = patch(data, at["bssSection"] + 8, "Q", 7)
        deny(bad if which == "source" else source, linked if which == "source" else bad, "writable executable section")
    # TLS is disallowed even when both source/target flags agree.
    deny(patch(source, src["bssSection"] + 8, "Q", 1027), patch(linked, dst["bssSection"] + 8, "Q", 1027),
         "ordinary NOBITS destination required")
    deny(patch(source, src["anchor"] + 4, "B", 0x10), linked, "unique named NOBITS source anchor")
    deny(source, patch(linked, dst["anchor"], "I", dst["otherName"]), "unique corresponding NOBITS linked anchor")
    deny(source, patch(linked, dst["other"], "I", dst["zeroName"]), "unique corresponding NOBITS linked anchor")
    deny(source, patch(linked, dst["anchor"] + 16, "Q", 15), "NOBITS anchor identity changed")
    deny(source, patch(linked, dst["anchor"] + 4, "B", 0x01), "NOBITS anchor identity changed")
    deny(source, patch(linked, dst["anchor"] + 5, "B", 2), "NOBITS anchor identity changed")
    deny(source, patch(linked, dst["other"] + 8, "Q", dst["bssAddr"] + 34), "overlapping NOBITS anchor")
    duplicate, dupe = fixture(1, extra_source=True)
    deny(duplicate, linked, "unique named NOBITS source anchor")
    deny(patch(duplicate, dupe["other"] + 16, "Q", 1), linked, "overlapping NOBITS anchor")
    for extent in (0, 17):
        deny(patch(source, src["anchor"] + 16, "Q", extent), linked, "NOBITS object extent")
    deny(source, patch(linked, dst["anchor"] + 16, "Q", 33), "NOBITS object extent")
    for addend in (-5, 12):
        deny(patch(source, src["bssRef"] + 16, "q", addend), linked, "section-relative relocation correspondence")
    redirected = patch(linked, dst["bssRef"] + 16, "q", 11)
    redirected = patch(redirected, dst["field"], "i", dst["bssAddr"] + 11 - dst["base"] - dst["fieldOffset"])
    deny(source, redirected, "NOBITS object displacement changed")
    deny(source, patch(linked, dst["bssRef"] + 16, "q", 44), "NOBITS object displacement changed")
    deny(source, patch(linked, dst["zeroProgram"] + 32, "Q", 1), "NOBITS outside zero-fill load tail")
    deny(source, patch(linked, dst["zeroProgram"] + 40, "Q", 63), "allocated section load coverage")
    deny(source, patch(linked, dst["field"], "i", 0), "linked relocation bytes mismatch")
    deny(source, patch(linked, dst["relaSection"] + 32, "Q", 0), "retained source relocation missing/duplicate")
    deny(patch(source, src["bssRef"] + 8, "Q", 255), linked, "relocation type/full target span")
    repeated, _ = fixture(1, duplicate_ref=True)
    deny(repeated, linked, "overlapping/out-of-function relocation")
    installer_source, _ = fixture(1, installer=True)
    installer_linked, ins = fixture(2, installer=True)
    for index in range(12):
        compare(installer_source, installer_linked, installer=True)
        bad = patch(installer_linked, ins["code"] + index * 5 + 1, "i", 0)
        try:
            compare(installer_source, bad, installer=True)
        except I.Rejected as error:
            assert str(error) == "linked relocation bytes mismatch"
        else:
            raise AssertionError("changed wrapped call accepted")
        count += 1
    obj = I.Elf(source, 1)
    try:
        obj.section_data(obj.sections[2])
    except I.Rejected as error:
        assert str(error) == "NOBITS has no file data"
    else:
        raise AssertionError("NOBITS presented as file bytes")
    count += 1
    print("ELF BSS controls passed: " + str(count) + "; native executions: 0")
    return count


if __name__ == "__main__":
    run()
