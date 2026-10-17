"""EXEC-016: synthetic ELF bounds, body binding and model gates. No ELF exec."""
import importlib.util
import os
from pathlib import Path
import struct
import sys
import tempfile

spec = importlib.util.spec_from_file_location("inspector", Path(__file__).with_name("elf_inspect.py"))
I = importlib.util.module_from_spec(spec)
spec.loader.exec_module(I)


def fixture(kind, functions, undefined=(), calls=()):
    """Own minimal ELF bytes, not a compiler/runtime input or executable probe."""
    executable = kind == 2
    begin = 120 if executable else 64
    base = 0x400000 + begin if executable else 0
    positions, code = {}, bytearray()
    for name, body in functions:
        positions[name] = len(code)
        code.extend(body)
    names = [""] + [n for n, _ in functions] + list(undefined)
    strings, offsets = bytearray(b"\0"), {"": 0}
    for name in names[1:]:
        offsets[name] = len(strings)
        strings.extend(name.encode() + b"\0")
    symbols = bytearray(b"\0" * 24)
    for name, body in functions:
        symbols.extend(struct.pack("<IBBHQQ", offsets[name], 0x12, 0, 1, base + positions[name], len(body)))
    for name in undefined:
        symbols.extend(struct.pack("<IBBHQQ", offsets[name], 0x10, 0, 0, 0, 0))
    relocs = bytearray()
    for owner, within, target in calls:
        at = positions[owner] + within
        relocs.extend(struct.pack("<QQq", base + at, (names.index(target) << 32) | 4, -4))
        if executable:
            code[at:at + 4] = struct.pack("<i", positions[target] - at - 4)
    section_names = b"\0.text\0.strtab\0.symtab\0.rela.text\0.shstrtab\0"
    pieces = [bytes(code), bytes(strings), bytes(symbols), bytes(relocs), section_names]
    file_offsets, body = [], bytearray()
    for piece in pieces:
        file_offsets.append(begin + len(body))
        body.extend(piece)
    shoff = begin + len(body)
    sections = [b"\0" * 64]
    for index, (name, stype, flags, link, info, align, entsize) in enumerate((
        (".text", 1, 6, 0, 0, 1, 0), (".strtab", 3, 0, 0, 0, 1, 0),
        (".symtab", 2, 0, 2, 1, 8, 24), (".rela.text", 4, 0, 3, 1, 8, 24),
        (".shstrtab", 3, 0, 0, 0, 1, 0)), 1):
        sections.append(struct.pack("<IIQQQQIIQQ", section_names.index(name.encode() + b"\0"), stype, flags,
                                    base if index == 1 else 0, file_offsets[index - 1], len(pieces[index - 1]),
                                    link, info, align, entsize))
    header = struct.pack("<16sHHIQQQIHHHHHH", b"\x7fELF\x02\x01\x01" + b"\0" * 9, kind, 62, 1,
                         base if executable else 0, 64 if executable else 0, shoff, 0,
                         64, 56 if executable else 0, 1 if executable else 0, 64, 6, 5)
    program = b""
    if executable:
        size = shoff + 6 * 64
        program = struct.pack("<IIQQQQQQ", 1, 5, 0, 0x400000, 0x400000, size, size, 4096)
    return bytes(header + program + body + b"".join(sections)), dict(code=begin, sym=file_offsets[2],
                                                                   rela=file_offsets[3], sh=shoff)


def patch(data, offset, fmt, value):
    result = bytearray(data)
    result[offset:offset + struct.calcsize(fmt)] = struct.pack(fmt, value)
    return bytes(result)


def run(owned_directory):
    count = 0

    def accept(action):
        nonlocal count
        action()
        count += 1

    def deny(action, expected_reason=None):
        nonlocal count
        try:
            action()
        except (I.Rejected, OSError) as error:
            if expected_reason is not None:
                assert str(error) == expected_reason
            count += 1
            return
        raise AssertionError("malformed fixture accepted: " + str(count + 1))

    p = lambda data: I.Elf(data, 1)
    x = lambda data: I.Elf(data, 2)
    wraps = sorted(I.WRAPS)
    owner = "pdaa_install_lifecycle_policy"
    helper = "bounded_proc_inventory"
    policy_functions = [(owner, b"\xe8\0\0\0\0" * 12), (helper, b"\xc3")]
    control_functions = [("__wrap_" + n, b"\xc3") for n in wraps] + [("main", b"\xc3")]
    obj, at = fixture(1, policy_functions, wraps + ["__errno_location"], [(owner, i * 5 + 1, n) for i, n in enumerate(wraps)])
    controls, _ = fixture(1, control_functions)
    exe, ex = fixture(2, policy_functions + control_functions, (), [(owner, i * 5 + 1, "__wrap_" + n) for i, n in enumerate(wraps)])
    plain, _ = fixture(1, [("main", b"\xc3")])
    empty, _ = fixture(1, [("unused", b"\xc3")])
    simple, sx = fixture(2, [("main", b"\xc3")])
    accept(lambda: p(obj))
    accept(lambda: x(exe))
    accept(lambda: I.scan_first_party_object(p(obj)))
    accept(lambda: I.inspect_wrapping(p(obj), x(exe)))
    for selection in ("policy", "state"):
        accept(lambda selection=selection: I.inspect_model([p(empty), p(plain)], x(simple), selection))
    accept(lambda: I.inspect_model([p(obj), p(controls)], x(exe), "installer"))
    for data in (b"", obj[:63], obj[:-1]):
        deny(lambda data=data: p(data))
    for offset, fmt, value in ((4, "B", 1), (5, "B", 2), (18, "H", 3), (16, "H", 3),
                               (40, "Q", (1 << 64) - 16), (60, "H", 2049), (62, "H", 65535),
                               (at["sh"] + 64 + 24, "Q", 0), (at["sh"] + 3 * 64 + 40, "I", 99),
                               (at["sh"] + 4 * 64 + 56, "Q", 8), (at["sym"] + 24 + 6, "H", 65535),
                               (at["rela"] + 8, "Q", (65535 << 32) | 4), (at["rela"], "Q", (1 << 64) - 1),
                               (at["rela"], "Q", 60)):
        deny(lambda offset=offset, fmt=fmt, value=value: p(patch(obj, offset, fmt, value)))
    # Four/eight-byte relocation crossing the exact end of the code section.
    for relocation_type, offset in ((4, 60), (1, 57)):
        data = patch(patch(obj, at["rela"], "Q", offset), at["rela"] + 8, "Q", (3 << 32) | relocation_type)
        deny(lambda data=data: p(data))
    for offset, fmt, value in ((68, "I", 7), (64, "I", 3), (64, "I", 2), (24, "Q", 1),
                               (ex["sh"] + 64 + 8, "Q", 4),
                               (ex["sh"] + 64 + 16, "Q", 0x700000),
                               (ex["sh"] + 64 + 24, "Q", ex["code"] + 1), (64 + 32, "Q", 119)):
        deny(lambda offset=offset, fmt=fmt, value=value: x(patch(exe, offset, fmt, value)))
    for opcode in I.FORBIDDEN:
        data = obj[:at["code"]] + opcode + obj[at["code"] + 2:]
        deny(lambda data=data: I.scan_first_party_object(p(data)))
    # Keep section file regions and entry/load coverage valid. Only the
    # address-to-file correspondence differs, so this proves that exact guard.
    mismapped = patch(patch(exe, 64 + 16, "Q", 0x400001), 64 + 48, "Q", 1)
    deny(lambda: x(mismapped), "section/load byte correspondence")
    deny(lambda: I.inspect_wrapping(p(patch(obj, at["rela"] + 16, "q", 0)), x(exe)))
    deny(lambda: I.inspect_wrapping(p(patch(obj, at["rela"] + 8, "Q", (3 << 32) | 1)), x(exe)))
    for offset, fmt, value in ((ex["code"] + 1, "i", 0), (ex["code"], "B", 0x90),
                               (ex["sym"] + 24 + 16, "Q", 59),
                               (ex["rela"] + 8, "Q", (4 << 32) | 4),
                               (ex["sym"] + 4 * 24 + 8, "Q", 0x400000 + ex["code"] + 61)):
        deny(lambda offset=offset, fmt=fmt, value=value:
             I.inspect_wrapping(p(obj), x(patch(exe, offset, fmt, value))))
    changed_mock = patch(exe, ex["code"] + 61, "B", 0x90)
    deny(lambda: I.inspect_model([p(obj), p(controls)], x(changed_mock), "installer"))
    changed_main = patch(simple, sx["code"], "B", 0x90)
    deny(lambda: I.inspect_model([p(empty), p(plain)], x(changed_main), "state"))
    for forbidden in (owner, helper, "pdaa_observer_attach", "__wrap_prctl"):
        data, _ = fixture(2, [("main", b"\xc3"), (forbidden, b"\xc3")])
        deny(lambda data=data: I.inspect_model([p(empty), p(plain)], x(data), "policy"))
    deny(lambda: I.inspect_model([p(empty), p(plain)], x(simple), "unknown"))
    deny(lambda: I.inspect_model([p(plain), p(plain)], x(simple), "state"))
    deny(lambda: I.inspect_model([p(empty)], x(simple), "state"))
    deny(lambda: I.inspect_model([p(obj), p(plain)], x(exe), "installer"))
    # Exercise the real fixed artifact inventory, regular/no-follow and bounded
    # read paths. Sparse oversize fixtures never allocate an oversized buffer.
    with tempfile.TemporaryDirectory(prefix="elf-controls-", dir=owned_directory) as location:
        root = Path(location)
        for name in ("policy", "policy-controls", "policy-install-controls", "state", "state-controls", "observer"):
            (root / (name + ".o")).write_bytes(empty if name in ("state", "observer") else plain)
        # Directory healthy mapping needs policy-only and installer variants of
        # the SAME policy object; an unused installer is permitted only in object.
        (root / "policy.o").write_bytes(obj)
        (root / "policy-install-controls.o").write_bytes(controls)
        (root / "policy-model").write_bytes(simple)
        (root / "installer-model").write_bytes(exe)
        (root / "state-model").write_bytes(simple)
        accept(lambda: I.inspect_directory(root))
        path = root / "observer.o"
        path.unlink()
        deny(lambda: I.inspect_directory(root))
        path.symlink_to(root / "state.o")
        deny(lambda: I.inspect_directory(root))
        path.unlink()
        with path.open("xb") as stream:
            stream.truncate(I.MAX_FILE + 1)
        deny(lambda: I.read_artifact(path))
    print("ELF modeled controls passed: " + str(count) + "; native executions: 0")
    return count


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("one owned fixture directory required")
    run(sys.argv[1])
