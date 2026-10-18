"""Independent literal diagnostic fixtures, NEVER a production decoder oracle.

UNEXECUTED EXEC-016 draft. The complete original selected tuples are a separately
derived metadata artifact; no production table or selector is imported here.
"""
import hashlib
import json
from pathlib import Path


def cold_fixture(layout='sequential'):
    raw = Path(__file__).with_name('musl-control-fixture.json').read_bytes()
    assert len(raw) == 104885
    assert hashlib.sha256(raw).hexdigest() == 'ebc58bfc9ea13fbefe8cd67fb13cdfcc5e41c5656361b826fd3e9e3c94dfd74e'
    fixture = json.loads(raw)
    assert fixture['productionTableUsedAsOracle'] is False
    tuples = fixture['selectedTuples']
    assert len(tuples) == 1323 and [row[0] for row in tuples] == list(range(1, 1324))
    objects = [row[4] for row in tuples]
    assert len(set(objects)) == 1317
    assert hashlib.sha256(('\n'.join(objects) + '\n').encode('ascii')).hexdigest() == '478b41b34e3df32dbecd328b280b7834d87d4c0a834b1cbc0b3893294f9ff8e5'
    def path(key, name):
        return 'global-cache/o/' + key + '/' + name
    outputs = [path(key * 32, name) for key, name in
               (('a', 'libc.a'), ('b', 'libcompiler_rt.a'), ('c', 'libubsan_rt.a'), ('d', 'libzigc.a'))]
    object_paths = [[path(format(index, '032x'), name) for index, name in enumerate(objects)]]
    object_paths += [[path(key * 32, name)] for key, name in
                     (('b', 'libcompiler_rt_zcu.o'), ('c', 'libubsan_rt_zcu.o'), ('d', 'libzigc_zcu.o'))]
    crt, inner = path('e' * 32, 'crt1.o'), path('f' * 32, 'crt1.o')
    crt_words = ['ld.lld', '-r', '--error-limit=0', '-mllvm', '-float-abi=hard', '-O3', '--build-id=none',
                 '--image-base=16777216', '--eh-frame-hdr', '-znow', '-m', 'elf_x86_64', '-static', '-o', crt, inner]
    final_words = ['ld.lld', '--error-limit=0', '-mllvm', '-float-abi=hard', '--entry', '_start', '-z',
                   'stack-size=16777216', '--build-id=none', '--image-base=16777216', '--gc-sections',
                   '--eh-frame-hdr', '-znow', '-m', 'elf_x86_64', '-static', '-o', '/work/runtime-preparation',
                   crt, '/work/policy.o', '/work/policy-controls.o', outputs[2], '--as-needed', outputs[0], outputs[3], outputs[1]]
    headers = [('header', role, -1, ('ar rcs ' + output).encode('ascii'), (output,)) for role, output in enumerate(outputs)]
    bodies = [[('object', role, index, (' ' + name).encode('ascii'), (name,))
               for index, name in enumerate(names)] for role, names in enumerate(object_paths)]
    newlines = [('newline', role, -1, b'\n', ()) for role in range(4)]
    crt_fragment = ('crt', -1, -1, (' '.join(crt_words) + '\n').encode('ascii'), (crt, inner))
    if layout == 'sequential':
        fragments = []
        for role in range(4):
            fragments += [headers[role]] + bodies[role] + [newlines[role]]
        fragments.append(crt_fragment)
    elif layout == 'interleaved-delayed-LF':
        fragments = [headers[3], headers[1], crt_fragment, headers[0], headers[2]]
        fragments += [bodies[1][0], bodies[0][0], bodies[3][0], bodies[2][0]] + bodies[0][1:]
        fragments += [newlines[2], newlines[0], newlines[3], newlines[1]]
    elif layout == 'crt-first-reverse-archives':
        fragments = [crt_fragment]
        for role in (3, 2, 1, 0):
            fragments += [headers[role]] + bodies[role] + [newlines[role]]
    else:
        raise ValueError('fixed independent fixture layout')
    prefix = [name for fragment in fragments for name in fragment[4]]
    final = ('final', -1, -1, (' '.join(final_words) + '\n').encode('ascii'), ())
    fragments.append(final)
    payload = b''.join(fragment[3] for fragment in fragments)
    assert len(prefix) == 1332 and len(fragments) == 1336 and len(payload) == 80367
    assert len(final[3]) == 554 and len(final_words) == 26
    runtime = (crt, outputs[2], outputs[0], outputs[3], outputs[1])
    rows = {'/work/' + name: dict(path='/work/' + name, bytes=100, sha256='a' * 64)
            for name in prefix}
    return dict(payload=payload, fragments=fragments, prefix=tuple(prefix), rawRuntime=runtime,
                runtime=tuple('/work/' + name for name in runtime), words=final_words, rows=rows,
                objects=tuple(objects), objectPaths=object_paths, outputs=outputs)
