"""EXEC-016 independent complete-cold controls. UNEXECUTED versioned draft.

Every old66 local ordinal is explicitly mapped. Supplied literal diagnostics
exercise actual Python helpers; no compiler/process/native effects are requested.
"""
import copy
import importlib.util
import json
from pathlib import Path


def module(name):
    spec = importlib.util.spec_from_file_location('cold_control_' + name, Path(__file__).with_name(name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


L, C, I = module('link_inputs'), module('cache_provenance'), module('cold_diagnostic_fixture')


def run():
    fixture = I.cold_fixture()
    payload, rows, runtime = fixture['payload'], fixture['rows'], fixture['runtime']
    names, migration = [], []
    def baseline(value=fixture):
        result = L.decode(value['payload'])
        assert result['runtimePaths'] == value['runtime'] and result['rawRuntimePaths'] == value['rawRuntime']
        assert result['words'] == value['words'] and result['prefixPaths'] == value['prefix']
        assert result['stackBytes'] == result['imageBase'] == 16777216
        assert result['diagnosticBytes'] == 80367 and result['fragments'] == 1336
        assert result['runtimePositions'] == (18, 21, 23, 24, 25)
        return result
    def record(name, old=None, reason='Preserved substantive predicate under full cold grammar/five-role contract'):
        assert type(name) is str and name not in names
        names.append(name)
        if old is not None:
            assert old == len(migration) + 1
            migration.append(dict(oldLocalOrdinal=old, newCase=name, explicitMigrationReason=reason))
    def deny(name, action, reason, old=None, migration_reason=None):
        baseline()  # outside interception; stale fixture must not mask a fault
        try:
            action()
        except ValueError as error:
            assert str(error) == reason, (name, str(error), reason)
        else:
            raise AssertionError('invalid complete-cold input accepted: ' + name)
        record(name, old, migration_reason or 'Preserved refusal with explicit complete-fragment/five-role reason')
    def final_change(before, after):
        fragments = fixture['fragments']
        return b''.join(row[3] for row in fragments[:-1]) + fragments[-1][3].replace(before, after, 1)
    def altered_fragment(index, data):
        return b''.join(data if at == index else row[3] for at, row in enumerate(fixture['fragments']))
    def remove_fragment(index):
        return b''.join(row[3] for at, row in enumerate(fixture['fragments']) if at != index)
    wraps = ('getpid', 'getuid', 'geteuid', 'opendir', 'dirfd', 'fstatfs', 'readdir', 'closedir',
             'getrlimit', 'setrlimit', 'prctl', 'syscall')
    for old, model, units in ((1, 'policy', ('policy', 'policy-controls')),
                              (2, 'installer', ('policy', 'policy-install-controls')),
                              (3, 'state', ('state', 'state-controls'))):
        plan = L.final_plan(model, payload, rows)
        wanted = ['/tool/zig', 'ld.lld', '--emit-relocs', '--icf=none', '--no-relax', '--no-pie', '--Map=/work/' + model + '.map']
        if model == 'installer':
            wanted += ['--wrap=' + name for name in wraps]
        wanted += ['--error-limit=0', '-mllvm', '-float-abi=hard', '--entry', '_start', '-z',
                   'stack-size=16777216', '--build-id=none', '--image-base=16777216', '--gc-sections',
                   '--eh-frame-hdr', '-znow', '-m', 'elf_x86_64', '-static', '-o', '/work/' + model + '-model',
                   runtime[0], '/work/' + units[0] + '.o', '/work/' + units[1] + '.o', runtime[1],
                   '--as-needed', runtime[2], runtime[3], runtime[4]]
        assert plan['argv'] == wanted and plan['runtimeInputs'] == [rows[path] for path in runtime]
        assert plan['rawRuntimePaths'] == fixture['rawRuntime'] and plan['runtimePositions'] == (18, 21, 23, 24, 25)
        assert plan['preparationOutputRetainedAsModel'] is plan['exactPerProcessProductionProved'] is plan['nativeQualification'] is False
        assert '/work/runtime-preparation' not in plan['argv']
        assert not any('unresolved' in word or word.startswith('@') for word in plan['argv'])
        assert [word for word in plan['argv'] if word.startswith('--wrap=')] == (
            ['--wrap=' + name for name in wraps] if model == 'installer' else [])
        record('v2-legacy-' + str(old).zfill(3), old)
    assert L.verify_unchanged(payload, rows, copy.deepcopy(rows)) == [rows[path] for path in runtime]
    record('v2-legacy-004', 4)
    deny('v2-legacy-005', lambda: L.final_plan('policy', b'ar rcs /work/opaque-data.a opaque-data.o\n' + payload, rows),
         'link dump archive header identity or multiplicity', 5,
         'Old arbitrary opaque-ar POSITIVE explicitly becomes strict complete-language rejection; original source/result retained')
    isolated = L.final_plan('installer', payload, rows)
    isolated['argv'][0], isolated['runtimeInputs'][0]['bytes'] = 'caller mutation', 101
    assert rows[runtime[0]]['bytes'] == 100 and L.final_plan('installer', payload, rows)['argv'][0] == '/tool/zig'
    assert L.final_plan('installer', payload, rows)['runtimeInputs'][0]['bytes'] == 100
    record('v2-legacy-006', 6)
    for old, bad in enumerate(('not bytes', b'', b'x' * 1048577), 7):
        deny('v2-legacy-' + str(old).zfill(3), lambda bad=bad: L.decode(bad), 'link dump byte budget', old,
             'Primitive/empty refusal preserved; old65537 ceiling explicitly versioned to1048577 under1MiB raw cap')
    framing = [(payload[:-1], 'link dump exact final vector and EOF'),
               (payload + b'\0', 'link dump ASCII output framing'),
               (payload.replace(b' _start', b'\t_start'), 'link dump ASCII output framing'),
               (payload.replace(b'_start', b'\xffstart'), 'link dump ASCII output framing'),
               (payload.replace(b'\n', b'\r\n'), 'link dump ASCII output framing')]
    for old, (bad, reason) in enumerate(framing, 10):
        deny('v2-legacy-' + str(old).zfill(3), lambda bad=bad: L.decode(bad), reason, old)
    for old, bad, reason in ((15, b'\n' + payload, 'link dump archive newline obligations'),
                             (16, b'x' * 8193 + b'\n' + payload, 'link dump unrecognized fragment boundary'),
                             (17, b'opaque\n' * 256 + payload, 'link dump unrecognized fragment boundary'),
                             (18, payload + payload, 'link dump exact final vector and EOF'),
                             (19, b' ' + payload, 'link dump ordered object fragment'),
                             (20, b'no linker here\n', 'link dump unrecognized fragment boundary')):
        deny('v2-legacy-' + str(old).zfill(3), lambda bad=bad: L.decode(bad), reason, old,
             'Old physical-line/top-level selection rule explicitly replaced by complete fragment consumption and exact final EOF')
    deny('v2-legacy-021', lambda: L.decode(final_change(b'ld.lld', b'ld.lldx')), 'link dump unrecognized fragment boundary', 21)
    for old, before, after in ((22, b' _start', b'  _start'), (23, b'_start', b'x' * 1025)):
        deny('v2-legacy-' + str(old).zfill(3), lambda before=before, after=after: L.decode(final_change(before, after)),
             'link dump unrecognized fragment boundary', old, 'Fixed final language excludes oversized/extra tokens without global physical-line restriction')
    options = ((b'--entry _start ', b''), (b'stack-size=16777216', b'stack-size=33554432'),
               (b'--image-base=16777216', b'--image-base=2097152'), (b'--gc-sections ', b''),
               (b'--eh-frame-hdr ', b''), (b'-znow ', b''), (b'elf_x86_64', b'elf_i386'), (b'-static', b'-pie'),
               (b'/work/runtime-preparation', b'/work/policy-model'), (b'/work/policy-controls.o', b'/work/state-controls.o'))
    for old, (before, after) in enumerate(options, 24):
        deny('v2-legacy-' + str(old).zfill(3), lambda before=before, after=after: L.decode(final_change(before, after)),
             'link dump exact final vector and EOF' if old == 33 else 'link dump unrecognized fragment boundary', old)
    raw = fixture['rawRuntime']
    runtime_faults = ((raw[0], raw[0].replace('crt1.o', 'crti.o')), (raw[0], '/foreign/' + raw[0]),
                      (raw[0], raw[0].replace('/o/', '/o/../o/')), (raw[0], raw[0].replace('/o/', '/o//')),
                      (raw[1], raw[1].replace('libubsan_rt.a', 'libcompiler_rt.a')), (raw[2], '@/work/options.rsp'),
                      (raw[4], raw[4] + ';bad'))
    for old, (before, after) in enumerate(runtime_faults, 34):
        deny('v2-legacy-' + str(old).zfill(3), lambda before=before, after=after:
             L.decode(final_change(before.encode(), after.encode())), 'link dump exact final vector and EOF', old)
    deny('v2-legacy-041', lambda: L.decode(final_change((raw[1] + ' ').encode(), b'')), 'link dump exact final vector and EOF', 41)
    deny('v2-legacy-042', lambda: L.decode(payload[:-1] + b' --unresolved-symbols=ignore-all\n'), 'link dump exact final vector and EOF', 42)
    old_roles = (0, 1, 2, 4)
    for old, role in enumerate(old_roles, 43):
        deny('v2-legacy-' + str(old).zfill(3), lambda role=role: L.decode(
            final_change(raw[role].encode(), raw[role].replace('global-cache', 'local-cache').encode())),
             'link dump exact final vector and EOF', old)
    for old, role in enumerate(old_roles, 47):
        bad = copy.deepcopy(rows); del bad[runtime[role]]
        deny('v2-legacy-' + str(old).zfill(3), lambda bad=bad: L.final_plan('policy', payload, bad),
             'link referenced input not observed', old)
    for old, (key, value) in enumerate((('bytes', True), ('bytes', 0), ('bytes', 33554433), ('sha256', 'b' * 63),
                                       ('sha256', 'A' * 64), ('path', runtime[0] + '.other')), 51):
        bad = copy.deepcopy(rows); bad[runtime[0]][key] = value
        deny('v2-legacy-' + str(old).zfill(3), lambda bad=bad: L.final_plan('policy', payload, bad),
             'link referenced observed identity', old)
    deny('v2-legacy-057', lambda: L.final_plan('observer', payload, rows), 'link fixed model identity', 57)
    deny('v2-legacy-058', lambda: L.final_plan('policy', payload, []), 'link bounded decoded cache rows', 58)
    for old, (key, value) in enumerate((('sha256', 'b' * 64), ('bytes', 101)), 59):
        later = copy.deepcopy(rows); later[runtime[1]][key] = value
        deny('v2-legacy-' + str(old).zfill(3), lambda later=later: L.verify_unchanged(payload, rows, later),
             'link runtime observed identity changed', old)
    class EqualitySpy:
        def __init__(self, hash_value=0):
            self.armed = False
            self.equalities = self.hashes = 0
            self.hash_value = hash_value
        def __hash__(self):
            if self.armed:
                self.hashes += 1
            return self.hash_value
        def __eq__(self, other):
            if self.armed:
                self.equalities += 1
            return True
    spy = EqualitySpy(); bad = copy.deepcopy(rows); bad[runtime[0]]['path'] = spy; spy.armed = True
    deny('v2-legacy-061', lambda: L.final_plan('policy', payload, bad), 'link referenced observed identity', 61)
    assert spy.equalities == spy.hashes == 0
    spy = EqualitySpy(hash(runtime[0])); bad = {spy: rows[runtime[0]]}
    bad.update({key: value for key, value in rows.items() if key != runtime[0]}); spy.armed = True
    deny('v2-legacy-062', lambda: L.final_plan('policy', payload, bad), 'link bounded decoded cache rows', 62)
    assert spy.equalities == spy.hashes == 0
    spy = EqualitySpy(hash('path')); bad = copy.deepcopy(rows)
    bad[runtime[0]] = {spy: runtime[0], 'bytes': 100, 'sha256': 'a' * 64}; spy.armed = True
    deny('v2-legacy-063', lambda: L.final_plan('policy', payload, bad), 'link referenced observed identity', 63)
    assert spy.equalities == spy.hashes == 0
    bad = copy.deepcopy(rows); bad[runtime[0]]['extra'] = 'not an identity field'
    deny('v2-legacy-064', lambda: L.final_plan('policy', payload, bad), 'link referenced observed identity', 64)
    boundary = copy.deepcopy(rows)
    boundary.update({'/work/global-cache/unselected-' + str(index): dict(path='/work/global-cache/unselected-' + str(index),
        bytes=1, sha256='a' * 64) for index in range(8192 - len(rows))})
    assert len(boundary) == 8192 and L.final_plan('policy', payload, boundary) == L.final_plan('policy', payload, rows)
    record('v2-legacy-065', 65, 'Old2048-map acceptance explicitly raised to8192 complete-map consumer ceiling')
    boundary['/work/global-cache/over'] = dict(path='/work/global-cache/over', bytes=1, sha256='a' * 64)
    deny('v2-legacy-066', lambda: L.final_plan('policy', payload, boundary), 'link bounded decoded cache rows', 66,
         'Old2049-map refusal explicitly versioned to8193')
    assert [row['oldLocalOrdinal'] for row in migration] == list(range(1, 67))

    for layout in ('sequential', 'interleaved-delayed-LF', 'crt-first-reverse-archives'):
        baseline(I.cold_fixture(layout)); record('cold-layout-' + layout)
    duplicate_positions = {'clone.o': (224, 1202), 'free.o': (309, 314), 'aligned_alloc.o': (312, 319),
                          'malloc.o': (315, 320), 'malloc_usable_size.o': (316, 321), 'realloc.o': (317, 324)}
    for name, positions in duplicate_positions.items():
        assert tuple(i + 1 for i, value in enumerate(fixture['objects']) if value == name) == positions
        assert len({fixture['objectPaths'][0][index - 1] for index in positions}) == 2
    record('all-source-positions-and-six-duplicate-basename-pairs')
    fragments = fixture['fragments']
    for role in range(4):
        index = next(i for i, item in enumerate(fragments) if item[0] == 'header' and item[1] == role)
        deny('header-missing-' + str(role), lambda index=index: L.decode(remove_fragment(index)), 'link dump ordered object fragment')
    indexes = [i for i, item in enumerate(fragments) if item[0] == 'object' and item[1] == 0]
    for label, index in (('first', indexes[0]), ('middle', indexes[661]), ('last', indexes[-1])):
        deny('object-wrong-' + label, lambda index=index: L.decode(altered_fragment(index, b' global-cache/o/' + b'0' * 32 + b'/foreign.o')),
             'link dump ordered object fragment')
    deny('object-missing-middle', lambda: L.decode(remove_fragment(indexes[661])), 'link dump ordered object fragment')
    deny('object-duplicate-first', lambda: L.decode(altered_fragment(indexes[1], fragments[indexes[0]][3])), 'link dump ordered object fragment')
    swapped = list(fragments); swapped[indexes[5]], swapped[indexes[6]] = swapped[indexes[6]], swapped[indexes[5]]
    deny('object-reordered', lambda: L.decode(b''.join(row[3] for row in swapped)), 'link dump ordered object fragment')
    index = next(i for i, item in enumerate(fragments) if item[0] == 'object' and item[1] == 1)
    deny('ZCU-cross-archive-key', lambda: L.decode(altered_fragment(index, fragments[index][3].replace(b'b' * 32, b'9' * 32))),
         'link dump ZCU archive binding')
    index = next(i for i, item in enumerate(fragments) if item[0] == 'crt')
    deny('CRT-missing', lambda: L.decode(remove_fragment(index)), 'link dump final before complete cold producers')
    deny('CRT-duplicate', lambda: L.decode(altered_fragment(index, fragments[index][3] * 2)), 'link dump repeated CRT producer')
    deny('CRT-wrong-optimization', lambda: L.decode(altered_fragment(index, fragments[index][3].replace(b'-O3', b'-O0'))),
         'link dump unrecognized fragment boundary')
    deny('CRT-inner-output-alias', lambda: L.decode(altered_fragment(index, fragments[index][3].replace(b'f' * 32, b'e' * 32))),
         'link dump CRT inner/output alias')
    deny('final-early', lambda: L.decode(fragments[-1][3] + payload), 'link dump final before complete cold producers')
    deny('newline-before-body', lambda: L.decode(altered_fragment(0, fragments[0][3] + b'\n')), 'link dump archive newline obligations')
    index = next(i for i, item in enumerate(fragments) if item[0] == 'newline')
    deny('newline-missing', lambda: L.decode(remove_fragment(index)), 'link dump final before complete cold producers')
    deny('fifth-role-missing', lambda: L.decode(final_change((raw[3] + ' ').encode(), b'')), 'link dump exact final vector and EOF')
    deny('fifth-role-local', lambda: L.decode(final_change(raw[3].encode(), raw[3].replace('global-cache', 'local-cache').encode())),
         'link dump exact final vector and EOF')
    bad = copy.deepcopy(rows); del bad[runtime[3]]
    deny('fifth-role-unobserved', lambda: L.final_plan('policy', payload, bad), 'link referenced input not observed')
    bad = copy.deepcopy(rows); del bad['/work/' + fragments[-2][4][1]]
    deny('CRT-inner-unobserved', lambda: L.final_plan('policy', payload, bad), 'link referenced input not observed')
    raw_limit = payload + b'x' * (1048576 - len(payload))
    assert len(raw_limit) == 1048576
    deny('raw-1048576-not-padding', lambda: L.decode(raw_limit), 'link dump exact final vector and EOF')
    deny('raw-1048577', lambda: L.decode(raw_limit + b'x'), 'link dump byte budget')
    header = 'VMA'.rjust(16) + ' ' + 'LMA'.rjust(16) + '     Size Align Out     In      Symbol\n'
    def map_bytes(paths):
        bodies = [path + ('(member.o)' if path.endswith('.a') else '') + ':(.text)' for path in paths]
        return (header + ''.join(f'{0:16x} {0:16x} {1:8x} {1:5d} ' + ' ' * 8 + body + '\n' for body in bodies)).encode('ascii')
    for model, units in (('policy', ('policy', 'policy-controls')), ('installer', ('policy', 'policy-install-controls')),
                          ('state', ('state', 'state-controls'))):
        first_party = {'/work/' + name + '.o' for name in units}
        all_paths = list(runtime) + sorted(first_party)
        assert C.map_inputs(map_bytes(all_paths), rows, first_party) == sorted(all_paths)
        record('five-role-absolute-map-' + model)
        deny('raw-relative-map-refused-' + model,
             lambda: C.map_inputs(map_bytes(list(raw) + sorted(first_party)), rows, first_party), 'cache canonical owned path')
    assert len(names) == len(set(names)) == 100
    print(json.dumps(dict(schema=2, status='SUPPLIED_COLD_LINK_CONTROLS_PASS', cases=len(names), names=names,
                         migratedLegacyCases=len(migration), compilerProcessContainerCalls=0, nativeQualification=False), separators=(',', ':')))
    return names, migration


if __name__ == '__main__':
    run()
