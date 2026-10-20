"""Modeled wrapper callthrough. All external responses below are supplied.

Production create_view, unchanged license algorithm and compiler/image/archive
processes are explicitly supplied. Old43 orchestration cases retain a short
build/model boundary; additional inherited cases call the actual build/model
bodies with supplied process outputs. No native evidence.
Actual packet authentication, minimal ToolView construction, wrapper hooks,
container intent/create-capture/remove/cleanup, receipts and finalizer run.
"""
import hashlib
import importlib.util
import json
import os
from contextlib import ExitStack
from pathlib import Path, PurePosixPath
from types import SimpleNamespace
import sys
import tempfile
from unittest.mock import patch

TRANSFER_CASE_ORACLE = ('payload-boundary-0', 'payload-boundary-1', 'payload-boundary-65535', 'payload-boundary-65536', 'payload-boundary-65537', 'payload-boundary-1048576', 'payload-boundary-33554432', 'fragmented-positive-short-writes', 'stderr-eof-first', 'eof-before-child-completion', 'existing-file', 'directory-mode', 'directory-replaced', 'open-before-output', 'open-after-output', 'selector-before', 'selector-after', 'selector-fd-collision', 'popen-before', 'popen-after', 'same-pipe', 'bad-pid', 'pipe-fd-collision', 'register-stdout', 'register-stderr', 'nonblocking', 'select', 'unregister-stdout', 'unregister-stderr', 'read-stdout', 'read-stderr', 'invalid-read', 'write-before', 'write-zero', 'write-negative', 'write-bool', 'write-too-large', 'write-after-full', 'close-output-before', 'close-output-after-reuse', 'readback', 'changed-readback', 'poll', 'wait', 'readback-pipe-alias', 'readback-selector-alias', 'close-stdout', 'close-stderr', 'selector-close', 'child-remains-live', 'pipes-remain-open', 'deadline-write', 'deadline-read-stdout', 'fstat-output', 'write-after-partial', 'truncated', 'extra-byte', 'wrong-hash', 'stderr-private', 'stderr-overflow', 'nonzero-exit', 'snapshot-negative-0', 'snapshot-negative-1', 'snapshot-negative-2', 'snapshot-negative-3', 'snapshot-negative-4', 'snapshot-negative-5', 'snapshot-negative-6', 'snapshot-negative-7', 'snapshot-negative-8', 'snapshot-negative-9', 'snapshot-negative-10', 'snapshot-negative-11', 'snapshot-wanted-73', 'snapshot-wanted-74', 'snapshot-wanted-75', 'snapshot-aggregate-overflow', 'snapshot-aggregate-exact-and-isolated', 'constructor-admission-0', 'constructor-admission-1', 'constructor-admission-2', 'constructor-admission-3', 'constructor-admission-4', 'constructor-admission-5', 'constructor-admission-6', 'constructor-admission-7', 'constructor-admission-8', 'constructor-admission-9', 'constructor-admission-10', 'constructor-admission-11', 'constructor-admission-12', 'constructor-admission-13', 'constructor-admission-14', 'constructor-admission-15', 'constructor-admission-16', 'constructor-admission-17', 'constructor-admission-18', 'constructor-admission-19', 'constructor-admission-20', 'constructor-admission-21', 'constructor-admission-22', 'prospective-capacity-native', 'prospective-capacity-logical', 'prospective-capacity-acquisitions', 'metadata-one-attempt-0', 'metadata-one-attempt-1', 'metadata-one-attempt-True', 'metadata-one-attempt--1', 'metadata-one-attempt-throw', 'metadata-one-attempt-full', 'retained-resource-termination-objects', 'retained-resource-termination-group', 'swallowed-cleanup-assertion-is-control-failure', 'live-child-cleanup-None', 'live-child-cleanup-kill', 'live-child-cleanup-wait', 'diag-count-0', 'diag-count-115', 'diag-count-116', 'diag-count-bool', 'diag-count-negative', 'diag-count-overflow', 'diag-count-float', 'diag-count-hostile', 'diag-phase-unknown', 'diag-phase-hostile', 'diag-phase-initial', 'diag-phase-summary', 'diag-prefix-0', 'diag-prefix-115', 'diag-prefix-116', 'diag-prefix-expanded', 'diag-prefix-nonlist', 'diag-prefix-hostile', 'diag-prefix-foreign', 'diag-prefix-reordered', 'diag-fail-write-zero', 'diag-fail-write-short', 'diag-fail-write-boolean', 'diag-fail-write-negative', 'diag-fail-write-impossible', 'diag-fail-write-throw', 'diag-fail-write-full-throw', 'diag-fail-write-full', 'diag-pass-write-zero', 'diag-pass-write-short', 'diag-pass-write-boolean', 'diag-pass-write-negative', 'diag-pass-write-impossible', 'diag-pass-write-throw', 'diag-pass-write-full-throw', 'diag-pass-write-full', 'diag-pass-serialize', 'diag-fail-serialize', 'diag-pass-oversize', 'diag-catalog-incomplete', 'diag-catalog-reordered', 'diag-catalog-complete', 'diag-publish-twice', 'diag-publish-swallow', 'diag-swallowed-write', 'diag-swallowed-serialize', 'diag-progress-error', 'diag-no-publish', 'diag-terminal-return-objects', 'diag-terminal-return-group', 'diag-terminal-clock', 'diag-primary-clock')
NEW_TRANSFER_CASES = ('transfer-catalog-foreign', 'transfer-catalog-reordered', 'transfer-catalog-duplicate')
FILTERED_CONTROL_COUNT = 141
# Independent literal source-order case oracle, not read from F's runtime plan.
FILTERED_CASE_NAMES = ('healthy', 'prerequisite-failure', 'archive-failure', 'view-failure', 'license-failure', 'wrong-container', 'repeat-initial', 'missing-producer', 'initial-inquiry-failure', 'final-inquiry-failure', 'final-json-failure', 'map-failure', 'snapshot-without-license', 'snapshot-without-readiness', 'snapshot-after-removal', 'final-before-initial', 'wrong-producer-order', 'repeat-final', 'ownership-refusal', 'remove-failure', 'census-failure', 'walker-schema', 'walker-schema-bool', 'walker-bad-count', 'walker-boolean-count', 'walker-wrong-group', 'walker-duplicate-name', 'compile-vector-missing-linker-option', 'compile-vector-duplicate-linker-option', 'compile-vector-wrong-source', 'compile-boundary-unlicensed', 'compile-boundary-unready', 'compile-boundary-no-initial', 'compile-boundary-final-present', 'compile-boundary-wrong-container', 'compile-boundary-retired', 'cleanup-write-short', 'cleanup-write-partial', 'cleanup-write-full-throw', 'terminal-write-short', 'terminal-write-partial', 'terminal-write-full-throw', 'view-return-expiry', 'initial-return-expiry', 'final-return-expiry', 'cache-ready-save-expiry', 'after-cleanup-expiry', 'cleanup-save-expiry', 'terminal-save-expiry', 'walker-foreign-name', 'walker-reordered', 'walker-status', 'walker-extra', 'walker-nonzero-calls', 'walker-native-true', 'inherited-healthy', 'host-control-result-grammar', 'cache-result-schema', 'cache-result-schema-bool', 'cache-result-bad-count', 'cache-result-boolean-count', 'cache-result-legacy-count', 'cache-result-duplicate-name', 'cache-result-foreign-name', 'cache-result-reordered', 'parent-capture-1048576', 'parent-capture-1048577', 'inherited-elf-bad-policy.o', 'inherited-elf-bad-policy-controls.o', 'inherited-elf-bad-policy-install-controls.o', 'cache-result-status', 'cache-result-extra', 'cache-result-nonzero-calls', 'cache-result-native-true', 'cache-result-duplicate-key', 'cache-result-malformed-json', 'cache-result-nonfinite', 'cache-result-byte-limit', 'inherited-elf-bad-state.o', 'inherited-elf-bad-state-controls.o', 'inherited-elf-bad-observer.o', 'link-result-schema', 'link-result-schema-bool', 'link-result-bad-count', 'link-result-boolean-count', 'link-result-legacy-count', 'link-result-duplicate-name', 'link-result-foreign-name', 'link-result-reordered', 'inherited-elf-bad-policy-model', 'inherited-elf-bad-installer-model', 'inherited-elf-bad-state-model', 'link-result-status', 'link-result-extra', 'link-result-nonzero-calls', 'link-result-native-true', 'link-result-duplicate-key', 'link-result-malformed-json', 'link-result-nonfinite', 'link-result-byte-limit', 'inherited-copy-worker-end', 'inherited-copy-save-end', 'inherited-copy-settlement-end', 'inherited-retirement-expiry', 'inherited-source-dependency-expiry', 'inherited-first-model-hash-expiry', 'inherited-second-model-hash-expiry', 'walker-duplicate-key', 'walker-malformed-json', 'walker-nonfinite', 'walker-byte-limit', 'walker-incomplete-last', 'walker-command-failure', 'view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership', 'transfer-catalog-foreign', 'transfer-catalog-reordered', 'transfer-catalog-duplicate', 'walker-return-expiry', 'walker-receipt-expiry', 'walker-repeat', 'walker-foreign-container', 'walker-before-reader', 'inherited-preparation-cap-90', 'inherited-preparation-command-failure', 'inherited-preparation-reserve-expiry')
VIEW_GROUP_ORACLE = (('g01', ('view-001', 'view-002', 'view-072', 'view-073', 'view-074', 'view-075', 'view-076', 'view-077')), ('g02', ('view-003', 'view-078', 'view-079', 'view-080', 'view-081', 'view-082', 'view-083')), ('g03', ('view-004', 'view-084', 'view-085', 'view-086', 'view-087', 'view-088', 'view-089')), ('g04', ('view-005', 'view-090', 'view-091', 'view-092', 'view-093', 'view-094', 'view-095')), ('g05', ('view-006', 'view-096', 'view-097', 'view-098', 'view-099', 'view-100', 'view-101')), ('g06', ('view-007', 'view-102', 'view-103', 'view-104', 'view-105', 'view-106', 'view-107')), ('g07', ('view-008', 'view-009', 'view-010', 'view-011', 'view-012', 'view-013', 'view-014', 'view-015', 'view-016', 'view-017', 'view-018', 'view-019', 'view-020', 'view-021', 'view-022', 'view-023', 'view-024', 'view-025', 'view-026', 'view-108', 'view-109', 'view-110', 'view-111', 'view-112', 'view-113')), ('g08', ('view-027', 'view-028', 'view-029', 'view-030', 'view-031', 'view-032', 'view-033', 'view-034', 'view-035', 'view-036', 'view-114', 'view-115', 'view-116', 'view-117', 'view-118', 'view-119')), ('g09', ('view-037', 'view-038', 'view-039', 'view-040', 'view-041', 'view-042', 'view-043', 'view-044', 'view-045', 'view-046', 'view-047', 'view-048', 'view-049', 'view-050', 'view-120', 'view-121', 'view-122', 'view-123', 'view-124', 'view-125')), ('g10', ('view-051', 'view-052', 'view-053', 'view-054', 'view-055', 'view-056', 'view-057', 'view-058', 'view-059', 'view-060', 'view-061', 'view-062', 'view-126', 'view-127', 'view-128', 'view-129', 'view-130', 'view-131')), ('g11', ('view-063', 'view-064', 'view-065', 'view-066', 'view-067', 'view-068', 'view-069', 'view-070', 'view-071', 'view-132', 'view-133', 'view-134', 'view-135', 'view-136', 'view-137')))
FILTERED_GROUP_ORACLE = (('f01', ('healthy', 'prerequisite-failure', 'archive-failure', 'view-failure', 'license-failure', 'wrong-container', 'repeat-initial', 'missing-producer', 'initial-inquiry-failure', 'final-inquiry-failure', 'final-json-failure', 'map-failure', 'snapshot-without-license', 'snapshot-without-readiness', 'snapshot-after-removal', 'final-before-initial', 'wrong-producer-order', 'repeat-final', 'ownership-refusal', 'remove-failure', 'census-failure', 'walker-schema', 'walker-schema-bool', 'walker-bad-count', 'walker-boolean-count', 'walker-wrong-group', 'walker-duplicate-name')), ('f02', ('compile-vector-missing-linker-option', 'compile-vector-duplicate-linker-option', 'compile-vector-wrong-source', 'compile-boundary-unlicensed', 'compile-boundary-unready', 'compile-boundary-no-initial', 'compile-boundary-final-present', 'compile-boundary-wrong-container', 'compile-boundary-retired', 'cleanup-write-short', 'cleanup-write-partial', 'cleanup-write-full-throw', 'terminal-write-short', 'terminal-write-partial', 'terminal-write-full-throw', 'view-return-expiry', 'initial-return-expiry', 'final-return-expiry', 'cache-ready-save-expiry', 'after-cleanup-expiry', 'cleanup-save-expiry', 'terminal-save-expiry', 'walker-foreign-name', 'walker-reordered', 'walker-status', 'walker-extra', 'walker-nonzero-calls', 'walker-native-true')), ('f03', ('inherited-healthy', 'host-control-result-grammar', 'cache-result-schema', 'cache-result-schema-bool', 'cache-result-bad-count', 'cache-result-boolean-count', 'cache-result-legacy-count', 'cache-result-duplicate-name', 'cache-result-foreign-name', 'cache-result-reordered', 'parent-capture-1048576', 'parent-capture-1048577')), ('f04', ('inherited-elf-bad-policy.o', 'inherited-elf-bad-policy-controls.o', 'inherited-elf-bad-policy-install-controls.o', 'cache-result-status', 'cache-result-extra', 'cache-result-nonzero-calls', 'cache-result-native-true', 'cache-result-duplicate-key', 'cache-result-malformed-json', 'cache-result-nonfinite', 'cache-result-byte-limit')), ('f05', ('inherited-elf-bad-state.o', 'inherited-elf-bad-state-controls.o', 'inherited-elf-bad-observer.o', 'link-result-schema', 'link-result-schema-bool', 'link-result-bad-count', 'link-result-boolean-count', 'link-result-legacy-count', 'link-result-duplicate-name', 'link-result-foreign-name', 'link-result-reordered')), ('f06', ('inherited-elf-bad-policy-model', 'inherited-elf-bad-installer-model', 'inherited-elf-bad-state-model', 'link-result-status', 'link-result-extra', 'link-result-nonzero-calls', 'link-result-native-true', 'link-result-duplicate-key', 'link-result-malformed-json', 'link-result-nonfinite', 'link-result-byte-limit')), ('f07', ('inherited-copy-worker-end', 'inherited-copy-save-end', 'inherited-copy-settlement-end', 'inherited-retirement-expiry', 'inherited-source-dependency-expiry', 'inherited-first-model-hash-expiry', 'inherited-second-model-hash-expiry', 'walker-duplicate-key', 'walker-malformed-json', 'walker-nonfinite', 'walker-byte-limit', 'walker-incomplete-last', 'walker-command-failure')), ('f08', ('view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership', 'transfer-catalog-foreign', 'transfer-catalog-reordered', 'transfer-catalog-duplicate', 'walker-return-expiry', 'walker-receipt-expiry', 'walker-repeat', 'walker-foreign-container', 'walker-before-reader', 'inherited-preparation-cap-90', 'inherited-preparation-command-failure', 'inherited-preparation-reserve-expiry')))
NEW_GROUP_CASES = ('view-group-wrong-selector', 'view-group-bad-count', 'view-group-boolean-count', 'view-group-duplicate-name', 'view-group-foreign-name', 'view-group-reverse-names', 'view-group-unknown-status', 'view-group-extra-field', 'view-group-nonzero-calls', 'view-group-native-true', 'view-group-duplicate-key', 'view-group-malformed-json', 'view-group-incomplete-last', 'view-group-return-expiry', 'view-group-receipt-expiry', 'view-group-command-failure', 'filtered-group-wrong-membership', 'transfer-catalog-foreign', 'transfer-catalog-reordered', 'transfer-catalog-duplicate')


CACHE_SCHEMA_CASE_NAMES = ('v2-cache-legacy-001', 'v2-cache-legacy-002', 'v2-cache-legacy-003', 'v2-cache-legacy-004', 'v2-cache-legacy-005', 'v2-cache-legacy-006', 'v2-cache-legacy-007', 'v2-cache-legacy-008', 'v2-cache-legacy-009', 'v2-cache-legacy-010', 'v2-cache-legacy-011', 'v2-cache-legacy-012', 'v2-cache-legacy-013', 'v2-cache-legacy-014', 'v2-cache-legacy-015', 'v2-cache-legacy-016', 'v2-cache-legacy-017', 'v2-cache-legacy-018', 'v2-cache-legacy-019', 'v2-cache-legacy-020', 'v2-cache-legacy-021', 'v2-cache-legacy-022', 'v2-cache-legacy-023', 'v2-cache-legacy-024', 'v2-cache-legacy-025', 'v2-cache-legacy-026', 'v2-cache-legacy-027', 'v2-cache-legacy-028', 'v2-cache-legacy-029', 'v2-cache-legacy-030', 'v2-cache-legacy-031', 'v2-cache-legacy-032', 'v2-cache-legacy-033', 'v2-cache-legacy-034', 'v2-cache-legacy-035', 'v2-cache-legacy-036', 'v2-cache-legacy-037', 'v2-cache-legacy-038', 'v2-cache-legacy-039', 'v2-cache-legacy-040', 'v2-cache-legacy-041', 'v2-cache-legacy-042', 'v2-cache-legacy-043', 'v2-cache-legacy-044', 'v2-cache-legacy-045', 'v2-cache-legacy-046', 'v2-cache-legacy-047', 'v2-cache-legacy-048', 'v2-cache-legacy-049', 'v2-cache-legacy-050', 'v2-cache-legacy-051', 'v2-cache-legacy-052', 'v2-cache-legacy-053', 'v2-cache-legacy-054', 'v2-cache-legacy-055', 'v2-cache-legacy-056', 'v2-cache-legacy-057', 'v2-cache-legacy-058', 'v2-cache-legacy-059', 'decoder-1048576-surrounding-whitespace-policy', 'decoder-1048577-before-json', 'decoder-files-8192-complete-map', 'decoder-files-8193-count-predicate', 'decoder-directories-2048', 'decoder-directories-2049', 'new-source-contract-only-not-node-body-credit')
COLD_LINK_CASE_NAMES = ('v2-legacy-001', 'v2-legacy-002', 'v2-legacy-003', 'v2-legacy-004', 'v2-legacy-005', 'v2-legacy-006', 'v2-legacy-007', 'v2-legacy-008', 'v2-legacy-009', 'v2-legacy-010', 'v2-legacy-011', 'v2-legacy-012', 'v2-legacy-013', 'v2-legacy-014', 'v2-legacy-015', 'v2-legacy-016', 'v2-legacy-017', 'v2-legacy-018', 'v2-legacy-019', 'v2-legacy-020', 'v2-legacy-021', 'v2-legacy-022', 'v2-legacy-023', 'v2-legacy-024', 'v2-legacy-025', 'v2-legacy-026', 'v2-legacy-027', 'v2-legacy-028', 'v2-legacy-029', 'v2-legacy-030', 'v2-legacy-031', 'v2-legacy-032', 'v2-legacy-033', 'v2-legacy-034', 'v2-legacy-035', 'v2-legacy-036', 'v2-legacy-037', 'v2-legacy-038', 'v2-legacy-039', 'v2-legacy-040', 'v2-legacy-041', 'v2-legacy-042', 'v2-legacy-043', 'v2-legacy-044', 'v2-legacy-045', 'v2-legacy-046', 'v2-legacy-047', 'v2-legacy-048', 'v2-legacy-049', 'v2-legacy-050', 'v2-legacy-051', 'v2-legacy-052', 'v2-legacy-053', 'v2-legacy-054', 'v2-legacy-055', 'v2-legacy-056', 'v2-legacy-057', 'v2-legacy-058', 'v2-legacy-059', 'v2-legacy-060', 'v2-legacy-061', 'v2-legacy-062', 'v2-legacy-063', 'v2-legacy-064', 'v2-legacy-065', 'v2-legacy-066', 'cold-layout-sequential', 'cold-layout-interleaved-delayed-LF', 'cold-layout-crt-first-reverse-archives', 'all-source-positions-and-six-duplicate-basename-pairs', 'header-missing-0', 'header-missing-1', 'header-missing-2', 'header-missing-3', 'object-wrong-first', 'object-wrong-middle', 'object-wrong-last', 'object-missing-middle', 'object-duplicate-first', 'object-reordered', 'ZCU-cross-archive-key', 'CRT-missing', 'CRT-duplicate', 'CRT-wrong-optimization', 'CRT-inner-output-alias', 'final-early', 'newline-before-body', 'newline-missing', 'fifth-role-missing', 'fifth-role-local', 'fifth-role-unobserved', 'CRT-inner-unobserved', 'raw-1048576-not-padding', 'raw-1048577', 'five-role-absolute-map-policy', 'raw-relative-map-refused-policy', 'five-role-absolute-map-installer', 'raw-relative-map-refused-installer', 'five-role-absolute-map-state', 'raw-relative-map-refused-state')
WALKER_GROUP_ORACLE = (('w01', ('libc-shaped-2646-files-1326-directories',)), ('w02', ('files-8192', 'files-8193')), ('w03', ('directories-2048', 'directories-2049', 'names-4096', 'names-4097')), ('w04', ('producer-json-lf-1048576', 'producer-json-lf-1048577')), ('w05', ('empty', 'missing-roots', 'chunked-65537', 'zero-file', 'name-type', 'name-empty', 'name-LF', 'name-CR', 'name-U2028', 'name-U2029', 'name-NUL', 'name-replacement', 'name-dot', 'name-dotdot', 'root-symlink', 'directory-uid', 'file-kind', 'file-uid', 'file-links', 'file-size-negative', 'file-size-over', 'inode-alias', 'aggregate-over', 'open-throw', 'fstat-initial', 'read-throw', 'read-short', 'read-extra-eof', 'fstat-final', 'path-final', 'close-throw', 'directory-close-throw', 'directory-changed', 'stdout-throw')))

NEW_SCHEMA_RESULT_CASES = (('cache-result-schema', 'cache-controls', 'schema'), ('cache-result-schema-bool', 'cache-controls', 'schema-bool'), ('cache-result-bad-count', 'cache-controls', 'bad-count'), ('cache-result-boolean-count', 'cache-controls', 'boolean-count'), ('cache-result-legacy-count', 'cache-controls', 'legacy-count'), ('cache-result-duplicate-name', 'cache-controls', 'duplicate-name'), ('cache-result-foreign-name', 'cache-controls', 'foreign-name'), ('cache-result-reordered', 'cache-controls', 'reordered'), ('cache-result-status', 'cache-controls', 'status'), ('cache-result-extra', 'cache-controls', 'extra'), ('cache-result-nonzero-calls', 'cache-controls', 'nonzero-calls'), ('cache-result-native-true', 'cache-controls', 'native-true'), ('cache-result-duplicate-key', 'cache-controls', 'duplicate-key'), ('cache-result-malformed-json', 'cache-controls', 'malformed-json'), ('cache-result-nonfinite', 'cache-controls', 'nonfinite'), ('cache-result-byte-limit', 'cache-controls', 'byte-limit'), ('link-result-schema', 'link-input-controls', 'schema'), ('link-result-schema-bool', 'link-input-controls', 'schema-bool'), ('link-result-bad-count', 'link-input-controls', 'bad-count'), ('link-result-boolean-count', 'link-input-controls', 'boolean-count'), ('link-result-legacy-count', 'link-input-controls', 'legacy-count'), ('link-result-duplicate-name', 'link-input-controls', 'duplicate-name'), ('link-result-foreign-name', 'link-input-controls', 'foreign-name'), ('link-result-reordered', 'link-input-controls', 'reordered'), ('link-result-status', 'link-input-controls', 'status'), ('link-result-extra', 'link-input-controls', 'extra'), ('link-result-nonzero-calls', 'link-input-controls', 'nonzero-calls'), ('link-result-native-true', 'link-input-controls', 'native-true'), ('link-result-duplicate-key', 'link-input-controls', 'duplicate-key'), ('link-result-malformed-json', 'link-input-controls', 'malformed-json'), ('link-result-nonfinite', 'link-input-controls', 'nonfinite'), ('link-result-byte-limit', 'link-input-controls', 'byte-limit'))
NEW_WALKER_CASES = (('walker-schema', 'schema'), ('walker-schema-bool', 'schema-bool'), ('walker-bad-count', 'bad-count'), ('walker-boolean-count', 'boolean-count'), ('walker-wrong-group', 'wrong-group'), ('walker-duplicate-name', 'duplicate-name'), ('walker-foreign-name', 'foreign-name'), ('walker-reordered', 'reordered'), ('walker-status', 'status'), ('walker-extra', 'extra'), ('walker-nonzero-calls', 'nonzero-calls'), ('walker-native-true', 'native-true'), ('walker-duplicate-key', 'duplicate-key'), ('walker-malformed-json', 'malformed-json'), ('walker-nonfinite', 'nonfinite'), ('walker-byte-limit', 'byte-limit'), ('walker-incomplete-last', 'incomplete-last'), ('walker-command-failure', 'command-failure'), ('walker-return-expiry', 'return-expiry'), ('walker-receipt-expiry', 'receipt-expiry'), ('walker-repeat', 'repeat'), ('walker-foreign-container', 'foreign-container'), ('walker-before-reader', 'before-reader'))
NEW_PARENT_CASES = ('parent-capture-1048576', 'parent-capture-1048577')
ADDED_FILTERED_CASE_NAMES = ('walker-schema', 'walker-schema-bool', 'walker-bad-count', 'walker-boolean-count', 'walker-wrong-group', 'walker-duplicate-name', 'walker-foreign-name', 'walker-reordered', 'walker-status', 'walker-extra', 'walker-nonzero-calls', 'walker-native-true', 'cache-result-schema', 'cache-result-schema-bool', 'cache-result-bad-count', 'cache-result-boolean-count', 'cache-result-legacy-count', 'cache-result-duplicate-name', 'cache-result-foreign-name', 'cache-result-reordered', 'parent-capture-1048576', 'parent-capture-1048577', 'cache-result-status', 'cache-result-extra', 'cache-result-nonzero-calls', 'cache-result-native-true', 'cache-result-duplicate-key', 'cache-result-malformed-json', 'cache-result-nonfinite', 'cache-result-byte-limit', 'link-result-schema', 'link-result-schema-bool', 'link-result-bad-count', 'link-result-boolean-count', 'link-result-legacy-count', 'link-result-duplicate-name', 'link-result-foreign-name', 'link-result-reordered', 'link-result-status', 'link-result-extra', 'link-result-nonzero-calls', 'link-result-native-true', 'link-result-duplicate-key', 'link-result-malformed-json', 'link-result-nonfinite', 'link-result-byte-limit', 'walker-duplicate-key', 'walker-malformed-json', 'walker-nonfinite', 'walker-byte-limit', 'walker-incomplete-last', 'walker-command-failure', 'walker-return-expiry', 'walker-receipt-expiry', 'walker-repeat', 'walker-foreign-container', 'walker-before-reader')
PREPARATION_CASE_NAMES = ('inherited-preparation-cap-90', 'inherited-preparation-command-failure', 'inherited-preparation-reserve-expiry')

def malformed_result(payload,fault,external_field,grouped=False):
    if fault=="byte-limit":
        return b"X"*16385
    value=json.loads(payload)
    if fault=="schema":value["schema"]=2 if grouped else 1
    elif fault=="schema-bool":value["schema"]=True
    elif fault=="bad-count":value["cases"]-=1
    elif fault=="boolean-count":value["cases"]=True
    elif fault=="legacy-count":value["migratedLegacyCases"]-=1
    elif fault=="wrong-group":value["group"]="foreign"
    elif fault=="duplicate-name":value["names"][1]=value["names"][0]
    elif fault=="foreign-name":value["names"][0]="foreign-control"
    elif fault=="reordered":value["names"].reverse()
    elif fault=="status":value["status"]="UNVERIFIED"
    elif fault=="extra":value["unexpected"]=False
    elif fault=="nonzero-calls":value[external_field]=1
    elif fault=="native-true":value["nativeQualification"]=True
    elif fault=="nonfinite":value["cases"]=float("nan")
    elif fault=="incomplete-last":value["names"].pop()
    elif fault not in ("duplicate-key","malformed-json","command-failure","return-expiry","receipt-expiry"):
        raise AssertionError("unknown fixed result fault")
    payload=json.dumps(value,separators=(",",":")).encode("ascii")
    if fault=="duplicate-key":payload=(b'{"schema":1,' if grouped else b'{"schema":2,')+payload[1:]
    if fault=="malformed-json":payload=b"{"
    return payload


def run(owned, group):
    assert type(group) is str and group in {name for name, _ in FILTERED_GROUP_ORACLE}
    selected = next(names for name, names in FILTERED_GROUP_ORACLE if name == group)
    count, completed = 0, []

    def complete(name):
        nonlocal count
        assert name in selected and name not in completed
        completed.append(name)
        count += 1
    with tempfile.TemporaryDirectory(prefix="filtered-modeled-", dir=owned) as temporary:
        parent = Path(temporary)
        workspace = parent / "workspace"
        packet = workspace / "research/native-modeled-v18"
        packet.mkdir(parents=True)
        source = Path(__file__).resolve().parent
        manifest = json.loads((source / "packet.json").read_text())
        assert manifest["schema"] == 1 and len(manifest["files"]) == 37
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
        actual_build, actual_inspect = D.Attempt.build, D.Attempt.inspect_then_models
        actual_copy_valid, actual_artifact_hash = F.FilteredAttempt.artifact_copy_valid, F.FilteredAttempt.artifact_hash
        raw_is_file = Path.is_file
        actual_decode = F.C.decode
        actual_link_decode = F.L.decode
        actual_parent_command = D.Attempt.command
        raw_write = Path.write_bytes
        fixture_path=packet/"cold_diagnostic_fixture.py"
        fixture_bytes=fixture_path.read_bytes()
        assert len(fixture_bytes)==4311 and hashlib.sha256(fixture_bytes).hexdigest()=="57b1e73a4a6674c4938ea5a87e4528564a99e7e19ff2095cb313d1d7d65a5532"
        fixture_spec=importlib.util.spec_from_file_location("independent_staged_cold_fixture",fixture_path)
        I=importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(I)
        cold=I.cold_fixture("sequential")
        initial = dict(schema=1, stage="INITIAL_EMPTY", roots=["/work/local-cache", "/work/global-cache"],
                       files=[], directories=[], totalBytes=0)
        runtime_paths=list(cold["runtime"])
        complete_rows=cold["rows"]
        cache_directories=sorted({parent.as_posix() for path in complete_rows for parent in PurePosixPath(path).parents
                                  if parent.as_posix().startswith("/work/global-cache")})
        final = dict(schema=1, stage="FINAL_AFTER_FIXED_PRODUCERS", roots=["/work/local-cache", "/work/global-cache"],
                     files=[complete_rows[path] for path in sorted(complete_rows)],
                     directories=cache_directories,totalBytes=sum(row["bytes"] for row in complete_rows.values()))
        assert len(runtime_paths)==5 and len(complete_rows)==1332 and final["totalBytes"]==133200
        prefix = ["--error-limit=0", "-mllvm", "-float-abi=hard", "--entry", "_start", "-z", "stack-size=16777216",
                  "--build-id=none", "--image-base=16777216", "--gc-sections", "--eh-frame-hdr", "-znow", "-m", "elf_x86_64", "-static"]
        preparation=cold["payload"]
        assert len(preparation)==80367 and len(cold["fragments"])==1336 and len(cold["prefix"])==1332
        container_id = "a" * 64
        def supplied_result(status, size, family):
            return json.dumps(dict(schema=1, status=status, cases=size, names=(list(TRANSFER_CASE_ORACLE) if status == "SUPPLIED_CONTROLS_PASS" else [family + "-" + str(index) for index in range(size)]),
                                   realDockerInvocations=0, nativeQualification=False), separators=(",", ":")).encode("ascii")

        def group_result(status, group_name, names, external_field):
            return json.dumps(dict(schema=1, status=status, group=group_name, cases=len(names), names=list(names),
                                   **{external_field: 0}, nativeQualification=False), separators=(",", ":")).encode("ascii")
        def versioned_result(status,names,legacy_count,external_field):
            return json.dumps(dict(schema=2,status=status,cases=len(names),names=list(names),
                migratedLegacyCases=legacy_count,**{external_field:0},nativeQualification=False),
                separators=(",",":")).encode("ascii")
        scripts = [("driver-controls", "driver_controls.py", b"Driver modeled controls passed: 318; network/process/container calls: 0\n", ())]
        scripts += [("view-controls-" + group_name, "view_controls.py",
                     group_result("SUPPLIED_TOOL_VIEW_CONTROLS_PASS", group_name, names, "realCompilerImageNativeInvocations"), (group_name,))
                    for group_name, names in VIEW_GROUP_ORACLE]
        scripts += [
            ("cache-controls", "cache_controls.py", versioned_result("SUPPLIED_CACHE_SCHEMA_CONTROLS_PASS",CACHE_SCHEMA_CASE_NAMES,59,"compilerImageNativeCalls"), ()),
            ("elf-controls", "elf_controls_v2.py", b"ELF modeled controls passed: 1; native executions: 0\n", ()),
            ("elf-bss-controls", "elf_bss_controls.py", b"ELF BSS controls passed: 43; native executions: 0\n", ()),
            ("link-input-controls", "link_controls.py", versioned_result("SUPPLIED_COLD_LINK_CONTROLS_PASS",COLD_LINK_CASE_NAMES,66,"compilerProcessContainerCalls"), ()),
            ("transfer-controls", "transfer_controls.py", supplied_result("SUPPLIED_CONTROLS_PASS", 168, "transfer-supplied"), ()),
            ("host-file-controls", "host_files_controls.py", supplied_result("SUPPLIED_HOST_FILES_CONTROLS_PASS", 133, "host-supplied"), ())]
        scripts += [("filtered-controls-" + group_name, "filtered_controls.py",
                     group_result("SUPPLIED_FILTERED_DRIVER_CONTROLS_PASS", group_name, names, "realExternalInvocations"), (group_name,))
                    for group_name, names in FILTERED_GROUP_ORACLE]
        assert len(scripts) == 26 and len({row[0] for row in scripts}) == 26


        def final_request(model, execute):
            # Independent literal oracle. Do not ask L.final_plan to generate
            # the expected argv for the transformation under test.
            options = ["--emit-relocs", "--icf=none", "--no-relax", "--no-pie", "--Map=/work/" + model + ".map"]
            if model == "installer":
                options += ["--wrap=" + item for item in ("getpid", "getuid", "geteuid", "opendir", "dirfd", "fstatfs", "readdir", "closedir",
                            "getrlimit", "setrlimit", "prctl", "syscall")]
            return execute + ["/tool/zig", "ld.lld"] + options + prefix + ["-o", "/work/" + model + "-model", runtime_paths[0]] + \
                ["/work/" + unit + ".o" for unit in D.LINKS[model]] + [runtime_paths[1], "--as-needed", runtime_paths[2], runtime_paths[3], runtime_paths[4]]

        def container_profile(owner, name):
            # Pure independent argv oracle. Calling product docker_base would
            # consume custody intent a second time and invalidate the fixture.
            cpus = sorted(os.sched_getaffinity(0))[:2]
            assert cpus
            return ["/usr/bin/docker", "create", "--name", name, "--label", "com.pdaa.modeled=" + owner.name,
                "--user", "1000:1000", "--read-only", "--network", "none", "--ipc", "none", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "32",
                "--cpus", "2", "--cpuset-cpus", ",".join(map(str, cpus)), "--ulimit", ("nofile=4096:4096" if name == owner.name + "-build" else "nofile=128:128"), "--ulimit", "core=0:0",
                "--log-driver", "none", "--env", "HOME=/work", "--env", "LANG=C", "--env", "LC_ALL=C", "--env", "PATH=/usr/bin:/bin",
                "--env", "TMPDIR=/work", "--env", "ZIG_LIB_DIR=/tool/lib", "--env", "ZIG_LOCAL_CACHE_DIR=/work/local-cache",
                "--env", "ZIG_GLOBAL_CACHE_DIR=/work/global-cache", "--tmpfs",
                "/work:rw,exec,nosuid,nodev,size=268435456,uid=1000,gid=1000,mode=0700"]

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
            if name not in selected:
                return
            runner_temp = parent / name
            runner_temp.mkdir()
            fixture = runner_temp / "pdaa-native-modeled-v18"
            clock = [1000.0]
            state = dict(phase="BODY", commands=[], owners=[], cleanupEntries=[], finalizers=0, modelEntries=0,
                         archiveEntries=0, viewEntries=0, raw=[], decodes=[], faultDeliveries=[], faultReached=False, expectedCreate=None,
                         callbackErrors=[], rawCallbacks=[], walkerEntries=[], walkerDirect=[], walkerExpiryBoundaries=[], parentReads=[], parentOutcomes=[], workerEntries=[], sourceCopyChecks=[], modelStarts=[], hashEntries=[], metadataProbes=[])
            state.update(preparationEntries=[], preparationReturns=[], preparationFaultDeliveries=[], preparationBoundaries=[], linkDecodes=[])
            inherited = name.startswith("inherited-")
            header = "VMA".rjust(16) + " " + "LMA".rjust(16) + "     Size Align Out     In      Symbol\n"
            artifact_payloads = {}
            for unit in D.UNITS:
                artifact_payloads[unit + ".o"] = b"\x00PRIVATE-SUPPLIED-OBJECT-\xff" + unit.encode("ascii")
                artifact_payloads[unit + ".d"] = (unit + ".o: /tool/lib/include/stddef.h /src/" + D.BASE + unit + ".c\n").encode("ascii")
            for model, units in D.LINKS.items():
                artifact_payloads[model + "-model"] = b"\x00PRIVATE-SUPPLIED-MODEL-\xfe" + model.encode("ascii")
                bodies = ["        /work/" + unit + ".o:(.text)" for unit in units]
                bodies.append("        " + runtime_paths[2] + "(member.o):(.text)")
                if name == "map-failure":
                    bodies.append("        relative.o:(.text)")
                artifact_payloads[model + ".map"] = (header + "".join(
                    f"{0:16x} {0:16x} {1:8x} {1:5d} " + body + "\n" for body in bodies)).encode("ascii")
            source_rows = [dict(name=leaf, bytes=len(artifact_payloads[leaf]), sha256=hashlib.sha256(artifact_payloads[leaf]).hexdigest())
                           for leaf in F.T.NAMES]

            def checked(function):
                def invoke(*args, **kwargs):
                    state["rawCallbacks"].append(function.__name__)
                    try:
                        return function(*args, **kwargs)
                    except AssertionError:
                        state["callbackErrors"].append(function.__name__)
                        raise
                return invoke

            def command(owner, identity, argv, seconds, cleanup=False, capture_result=None):
                state["commands"].append((identity, list(argv), seconds, cleanup))  # every entry before response/refusal
                owner.guard(0 if cleanup else 20)
                assert not any(e.get("id") == identity for e in owner.events), "modeled command identity reused"
                matching = [row for row in scripts if row[0] == identity]
                if matching:
                    state["prerequisiteOwner"] = owner
                    index = scripts.index(matching[0])
                    assert [c[0] for c in state["commands"][:index + 1]] == [r[0] for r in scripts[:index + 1]]
                    assert argv == [sys.executable, "-I", "-S", "-B", str(packet / matching[0][1]), str(owner.fixture)] + list(matching[0][3])
                    assert seconds == (30 if matching[0][1] == "filtered_controls.py" else 5) and not cleanup and capture_result is None
                    payload = matching[0][2]
                    schema_target=next((row for row in NEW_SCHEMA_RESULT_CASES if row[0]==name),None)
                    if schema_target is not None and identity==schema_target[1]:
                        external_field="compilerImageNativeCalls" if identity=="cache-controls" else "compilerProcessContainerCalls"
                        payload=malformed_result(payload,schema_target[2],external_field)
                    if name == "host-control-result-grammar" and identity == "host-file-controls":
                        value = json.loads(payload)
                        value["names"][0] = "invalid.policy.o"
                        payload = json.dumps(value, separators=(",", ":")).encode("ascii")

                    grouped_target = ("transfer-controls" if name in NEW_TRANSFER_CASES else
                                      "filtered-controls-f08" if name == "filtered-group-wrong-membership" else
                                      "view-controls-g11" if name == "view-group-incomplete-last" else "view-controls-g01")
                    if name in NEW_GROUP_CASES and identity == grouped_target:
                        value = json.loads(payload)
                        if name == "transfer-catalog-foreign":
                            value["names"][0] = "foreign-control"
                        elif name == "transfer-catalog-reordered":
                            value["names"][0], value["names"][1] = value["names"][1], value["names"][0]
                        elif name == "transfer-catalog-duplicate":
                            value["names"][1] = value["names"][0]
                        elif name == "view-group-wrong-selector":
                            value["group"] = "g02"
                        elif name == "view-group-bad-count":
                            value["cases"] -= 1
                        elif name == "view-group-boolean-count":
                            value["cases"] = True
                        elif name == "view-group-duplicate-name":
                            value["names"][1] = value["names"][0]
                        elif name in ("view-group-foreign-name", "filtered-group-wrong-membership"):
                            value["names"][0] = "foreign-control"
                        elif name == "view-group-reverse-names":
                            value["names"].reverse()
                        elif name == "view-group-unknown-status":
                            value["status"] = "UNKNOWN"
                        elif name == "view-group-extra-field":
                            value["extra"] = False
                        elif name == "view-group-nonzero-calls":
                            value["realCompilerImageNativeInvocations"] = 1
                        elif name == "view-group-native-true":
                            value["nativeQualification"] = True
                        elif name == "view-group-incomplete-last":
                            value["names"].pop()
                        payload = json.dumps(value, separators=(",", ":")).encode("ascii")
                        if name == "view-group-duplicate-key":
                            payload = b'{"schema":1,' + payload[1:]
                        elif name == "view-group-malformed-json":
                            payload = b"{"
                    ok = name != "prerequisite-failure" and not (name == "view-group-command-failure" and identity == grouped_target)
                elif identity == "docker-version":
                    assert inherited and argv == ["/usr/bin/docker", "version", "--format", "{{json .}}"] and seconds == 5 and not cleanup
                    payload, ok = b"{}\n", True
                elif identity == "image-pull":
                    assert inherited and argv == ["/usr/bin/docker", "pull", "--platform", "linux/amd64", D.IMAGE] and seconds == 90 and not cleanup
                    payload, ok = b"supplied image pull\n", True
                elif identity == "image-identity":
                    assert inherited and argv == ["/usr/bin/docker", "image", "inspect", "--format", "{{.Os}} {{.Architecture}} {{.Size}} {{.Id}}", D.IMAGE]
                    assert seconds == 5 and not cleanup
                    payload, ok = b"linux amd64 1 sha256:" + b"a" * 64 + b"\n", True
                elif identity == "build-create":
                    assert argv == state["expectedCreate"] and seconds == 5 and not cleanup and capture_result is not None
                    payload, ok = (container_id + "\n").encode(), True
                elif identity == "build-start":
                    assert argv == ["/usr/bin/docker", "start", container_id] and seconds == 5 and not cleanup
                    payload, ok = b"modeled-start\n", True
                elif identity in ("runtime-cache-initial", "runtime-cache-pre-final", "runtime-cache-final"):
                    first = identity.endswith("initial")
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                                    "/usr/local/bin/node", "-e", F.C.INITIAL_SCRIPT if first else F.C.FINAL_SCRIPT]
                    assert seconds == 5 and not cleanup and capture_result is None
                    if name in NEW_PARENT_CASES and first:
                        raw=json.dumps(initial,separators=(",",":")).encode("ascii")
                        framed=raw+b" "*(1048575-len(raw))+b"\n"
                        blocks=[framed[at:at+65536] for at in range(0,len(framed),65536)]
                        blocks+=[b""] if name.endswith("1048576") else [b"Z"]
                        kills=[]
                        with patch.object(D.subprocess,"Popen") as parent_popen, patch.object(D.selectors,"DefaultSelector") as parent_select, \
                             patch.object(D.os,"read") as parent_read, patch.object(D.os,"killpg") as parent_kill:
                            child,selector=parent_popen.return_value,parent_select.return_value
                            child.pid,child.returncode=456,0
                            child.stdout.fileno.return_value=43
                            child.poll.side_effect=lambda:child.returncode
                            selector.get_map.side_effect=lambda:{1:1} if len(state["parentReads"])<len(blocks) else {}
                            selector.select.return_value=[(SimpleNamespace(fileobj=child.stdout),D.selectors.EVENT_READ)]
                            def raw_parent_read(descriptor,maximum):
                                state["parentReads"].append((descriptor,maximum))
                                return blocks[len(state["parentReads"])-1]
                            def raw_parent_kill(pid,sig):
                                kills.append((pid,sig));child.returncode=-9
                            parent_read.side_effect=raw_parent_read
                            parent_kill.side_effect=raw_parent_kill
                            parent_ok,parent_output=actual_parent_command(owner,identity,argv,seconds,
                                cleanup=cleanup,capture_result=capture_result)
                            state["parentOutcomes"].append(dict(ok=parent_ok,bytes=len(parent_output),
                                sha256=hashlib.sha256(parent_output).hexdigest(),kills=list(kills),
                                popenCalls=parent_popen.call_count,waitCalls=child.wait.call_count,
                                selectorCloses=selector.close.call_count,pipeCloses=child.stdout.close.call_count,
                                argv=parent_popen.call_args.args,kwargs=parent_popen.call_args.kwargs,
                                unregisters=selector.unregister.call_count))
                        if name.endswith("1048577"):
                            state["faultReached"]=True
                            state["faultDeliveries"].append(dict(id=identity,ok=parent_ok,bytes=len(parent_output),
                                sha256=hashlib.sha256(parent_output).hexdigest()))
                        return parent_ok,parent_output
                    payload = json.dumps(initial if first else final, separators=(",", ":")).encode()
                    ok = not ((first and name == "initial-inquiry-failure") or
                              (identity == "runtime-cache-final" and name == "final-inquiry-failure"))
                    if identity == "runtime-cache-final" and name == "final-json-failure":
                        payload = payload.replace(b'"schema":1', b'"schema":1,"schema":1', 1)
                elif identity == "reader-controls":
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                        "/usr/local/bin/node", "-e", (packet / "artifact_reader_controls.js").read_bytes().decode("ascii"), "--",
                        (packet / "artifact_reader.js").read_bytes().decode("ascii")] and seconds == 5 and not cleanup and capture_result is None
                    reader_names = ["reader-source-identity-" + str(index) for index in range(3)]
                    reader_names += ["size-" + str(size) for size in (0, 1, 65535, 65536, 65537, 1048576, 33554432)]
                    reader_names += ["write-order-" + order for order in ("sync", "drain-before-return", "callback-before-drain", "drain-before-callback")]
                    reader_names += ["open-throw", "invalid-fd", "fstat-throw", "initial-kind", "initial-uid", "initial-links", "initial-size",
                        "read-throw", "short-read", "invalid-read", "extra-byte", "changed-fstat", "changed-path", "lstat-throw", "close-throw",
                        "write-throw", "write-invalid-result", "callback-error", "stream-error", "stream-close", "gap-error", "wrong-hash", "destroy-throw"]
                    reader_names += ["argv-" + str(index) for index in range(37, 46)]
                    payload, ok = json.dumps(dict(schema=1, status="SUPPLIED_READER_CONTROLS_PASS", cases=46, names=reader_names,
                        realArtifactReads=0, nativeQualification=False), separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("cache-walker-controls-"):
                    group_name=identity[len("cache-walker-controls-"):]
                    group_index=next(index for index,(key,_) in enumerate(WALKER_GROUP_ORACLE) if key==group_name)
                    expected_groups=[key for key,_ in WALKER_GROUP_ORACLE[:group_index+1]]
                    state["walkerEntries"].append(group_name)
                    assert state["walkerEntries"]==expected_groups and owner.cache_walker_attempts==expected_groups
                    assert argv==["/usr/bin/docker","exec","--workdir","/work",container_id,
                        "/usr/local/bin/node","-e",(packet/"cache_walker_controls.js").read_bytes().decode("ascii"),
                        "--",group_name,F.C.FINAL_SCRIPT]
                    assert seconds==5 and not cleanup and capture_result is None
                    assert owner.reader_controls_passed and owner.cache_initial["container"]==container_id
                    assert not any(event.get("id") in F.PRODUCERS for event in owner.events)
                    payload=group_result("SUPPLIED_CACHE_WALKER_CONTROLS_PASS",group_name,
                        WALKER_GROUP_ORACLE[group_index][1],"realCacheReads")
                    walker_fault=next((fault for key,fault in NEW_WALKER_CASES if key==name),None)
                    walker_target=("w05" if walker_fault=="incomplete-last" else "w03" if walker_fault in (
                        "duplicate-name","reordered") else "w01")
                    if walker_fault is not None and group_name==walker_target and walker_fault not in (
                        "repeat","foreign-container","before-reader"):
                        payload=malformed_result(payload,walker_fault,"realCacheReads",grouped=True)
                    ok=not (walker_fault=="command-failure" and group_name==walker_target)
                elif identity == "runtime-preparation":
                    expected = ["/usr/bin/docker", "exec", "--workdir", "/work", "--env", "ZIG_VERBOSE_LINK=1", container_id]
                    expected += D.COMMON + ["-static", "-no-pie", "-Wl,--gc-sections", "/work/policy.o", "/work/policy-controls.o",
                                            "-o", "/work/runtime-preparation"]
                    assert argv == expected and seconds == 90 and not cleanup and capture_result is None
                    state["preparationEntries"].append(dict(phase=state["phase"], clock=clock[0], deadline=owner.deadline,
                        sameOwner=owner is state["currentOwner"], container=owner.cache_initial["container"],
                        attempted=owner.preparation_attempted, linkRequests=list(owner.link_requests)))
                    if name in PREPARATION_CASE_NAMES:
                        assert len(state["preparationEntries"]) == 1 and owner is state["currentOwner"]
                        assert owner.preparation_attempted and owner.link_requests == ["policy"]
                        assert owner.reader_controls_passed and owner.cache_walker_controls_passed
                        assert owner.preparation_payload is owner.cache_pre_final is owner.runtime_inputs is None
                        assert owner.deadline == owner.started + 600 and clock[0] < owner.deadline - 20
                    payload, ok = preparation, True
                    if name == "inherited-preparation-command-failure":
                        payload, ok = b"supplied preparation command failure\n", False
                elif identity in F.PRODUCERS:
                    expected, limit = producer_request(identity, ["/usr/bin/docker", "exec", "--workdir", "/work", container_id], delivered=True)
                    if identity.startswith("link-"):
                        expected = final_request(identity[len("link-"):], ["/usr/bin/docker", "exec", "--workdir", "/work", container_id])
                    assert argv == expected and seconds == limit and not cleanup and capture_result is None
                    if identity.startswith("compile-"):
                        assert "-fuse-ld=lld" not in argv and "-Werror" in argv and "-c" in argv
                    if identity.startswith("link-"):
                        assert "-fuse-ld=lld" not in argv and "-c" not in argv and argv[5:7] == ["/tool/zig", "ld.lld"]
                    payload, ok = (b"0.15.2\n" if identity == "compiler-version" else b"clang version 20.1.8\n" if identity == "clang-version" else
                                   b"explicitly supplied modeled compiler outcome\n"), True
                elif identity == "artifact-source-snapshot":
                    assert argv == ["/usr/bin/docker", "exec", "--workdir", "/work", container_id,
                                    "/usr/local/bin/node", "-e", F.fixed_source_snapshot_script()]
                    assert seconds == 5 and not cleanup and capture_result is None
                    if name == "map-failure":
                        state["faultReached"] = True
                    payload, ok = json.dumps(source_rows, separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("copy-"):
                    index = int(identity[len("copy-"):])
                    row = source_rows[index]
                    leaf, target = row["name"], owner.fixture / "artifacts" / row["name"]
                    end = owner.transfer_ends[leaf]
                    assert argv == [sys.executable, "-I", "-S", "-B", str(packet / "artifact_transfer.py"), str(target.parent),
                        container_id, leaf, str(row["bytes"]), row["sha256"], repr(end),
                        *(str(value) for value in owner.fixture_identity), *(str(value) for value in owner.artifact_directory_identity)]
                    assert seconds == 3 and not cleanup and capture_result is None and end == min(owner.deadline - 20, clock[0] + 2.5)
                    assert (owner.transfer_attempts == [item["name"] for item in source_rows[:index + 1]] and
                        owner.transfer_unsettled[leaf] == row["bytes"] and leaf not in owner.transfer_verified and
                        owner.transfer_charged == sum(item["bytes"] for item in source_rows[:index + 1]))
                    state["workerEntries"].append((leaf, end, owner.transfer_charged))
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
                    try:
                        assert os.write(descriptor, artifact_payloads[leaf]) == row["bytes"]
                        info = os.fstat(descriptor)
                    finally:
                        os.close(descriptor)
                    report = dict(schema=1, status="VERIFIED_PRIVATE_PENDING_BUILDER_RETIREMENT", code="NONE", name=leaf, container=container_id,
                        expectedBytes=row["bytes"], receivedBytes=row["bytes"], verifiedWriteBytes=row["bytes"], uncertainWriteBytes=0,
                        uncertainReadBytes=0, returnedReadBytes=2 * row["bytes"] + (packet / "artifact_reader.js").stat().st_size, readAttempts=5,
                        streamSha256=row["sha256"], hostSha256=row["sha256"], stderrBytes=0, stderrSha256=hashlib.sha256(b"").hexdigest(),
                        stdoutEof=True, stderrEof=True, childClosedKnown=True, acquisitions=1, closes=1, pendingAcquisitions={}, uncertainCloseRoles=[],
                        nativePendingReservations={}, nativeFdBudget=16, nativeFdPeakReserved=13, ownedResourcesClosed=True,
                        hostIdentity=dict(device=info.st_dev, inode=info.st_ino, uid=info.st_uid, mode=info.st_mode & 0o777, bytes=info.st_size),
                        nativeQualification=False)
                    payload, ok = json.dumps(report, separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("inspect-owner-"):
                    custody = next(row for row in owner.containers if "inspect-owner-" + row["name"] == identity)
                    assert argv == ["/usr/bin/docker", "inspect", "--format", '{{.Id}} {{index .Config.Labels "com.pdaa.modeled"}}', custody["id"]]
                    assert seconds == 2 and cleanup
                    payload, ok = (custody["id"] + " " + owner.name + "\n").encode(), True
                    if name == "ownership-refusal":
                        state["faultReached"] = True
                        payload = (container_id + " wrong-modeled-label\n").encode()
                elif identity.startswith("remove-"):
                    custody = next(row for row in owner.containers if "remove-" + row["name"] == identity)
                    assert argv == ["/usr/bin/docker", "rm", "--force", custody["id"]] and seconds == 3 and cleanup
                    payload, ok = b"modeled-removed\n", True
                    if name == "remove-failure":
                        state["faultReached"] = True
                        ok = False
                elif identity == "elf-inspection":
                    assert inherited and argv == [sys.executable, "-I", "-S", "-B", str(packet / "elf_inspect.py"), str(owner.fixture / "artifacts")]
                    assert seconds == 10 and not cleanup and capture_result is None
                    hashes = {row["name"]: row["sha256"] for row in source_rows if row["name"].endswith((".o", "-model"))}
                    if name.startswith("inherited-elf-bad-"):
                        leaf = name[len("inherited-elf-bad-"):]
                        assert leaf in hashes
                        hashes[leaf] = "0" * 64
                        state["faultReached"] = True
                    payload, ok = json.dumps(dict(status="INSPECTED_MODELS_ONLY", hashes=hashes, wrappedEdges=[], observerLinked=False,
                                                  nativeQualification=False), separators=(",", ":")).encode("ascii"), True
                elif identity.startswith("model-create-"):
                    model = identity[len("model-create-"):]
                    assert inherited and model in D.LINKS and seconds == 5 and not cleanup and capture_result is not None
                    expected = container_profile(owner, owner.name + "-" + model)
                    expected += ["--mount", "type=bind,src=" + str(owner.fixture / "artifacts") + ",dst=/models,readonly",
                                 "--entrypoint", "/models/" + model + "-model", D.IMAGE]
                    assert argv == expected
                    payload, ok = (({"policy": "b", "installer": "c", "state": "d"}[model] * 64) + "\n").encode("ascii"), True
                elif identity.startswith("model-exit-"):
                    model = identity[len("model-exit-"):]
                    custody = next(row for row in owner.containers if row["name"] == owner.name + "-" + model)
                    assert inherited and argv == ["/usr/bin/docker", "inspect", "--format", "{{json .State}}", custody["id"]] and seconds == 2 and not cleanup
                    payload, ok = b'{"Status":"exited","ExitCode":0,"OOMKilled":false,"Error":""}', True
                elif identity.startswith("model-"):
                    model = identity[len("model-"):]
                    custody = next(row for row in owner.containers if row["name"] == owner.name + "-" + model)
                    assert inherited and argv == ["/usr/bin/docker", "start", "--attach", custody["id"]] and seconds == 5 and not cleanup
                    state["modelStarts"].append(model)
                    payload = {"policy": b"Native policy modeled controls passed: 83; structural checks: 1; policy installs: 0\n",
                        "installer": b"Native installer modeled cases passed: 35; kernel installs: 0\n",
                        "state": b"Native lifecycle modeled checks passed: 1; kernel observer calls: 0\n"}[model]
                    ok = True
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
                        (name == "host-control-result-grammar" and identity == "host-file-controls") or \
                        (name == "initial-inquiry-failure" and identity == "runtime-cache-initial") or \
                        (name in {"final-inquiry-failure", "final-json-failure"} and identity == "runtime-cache-final"):
                    # Delivery follows all supplied-boundary assertions and actual receipt calls.
                    state["faultDeliveries"].append(dict(id=identity, ok=ok, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True

                schema_target=next((row for row in NEW_SCHEMA_RESULT_CASES if row[0]==name),None)
                if schema_target is not None and identity==schema_target[1]:
                    state["faultDeliveries"].append(dict(id=identity,ok=ok,bytes=len(payload),
                        sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"]=True
                walker_fault=next((fault for key,fault in NEW_WALKER_CASES if key==name),None)
                walker_target=("w05" if walker_fault=="incomplete-last" else "w03" if walker_fault in (
                    "duplicate-name","reordered") else "w01")
                if walker_fault is not None and walker_fault not in ("repeat","foreign-container","before-reader","receipt-expiry") and \
                        identity=="cache-walker-controls-"+walker_target:
                    state["faultDeliveries"].append(dict(id=identity,ok=ok,bytes=len(payload),
                        sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"]=True
                    if walker_fault=="return-expiry":
                        expiry_before=clock[0]
                        clock[0]=owner.deadline-20
                        state["walkerExpiryBoundaries"].append(("command-return",expiry_before,clock[0],None))
                if name in NEW_GROUP_CASES and identity == grouped_target and name != "view-group-receipt-expiry":
                    state["faultDeliveries"].append(dict(id=identity, ok=ok, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True
                    if name == "view-group-return-expiry":
                        clock[0] = owner.deadline - 20
                if identity == "runtime-cache-initial" and name == "initial-return-expiry" or \
                        identity == "runtime-cache-final" and name == "final-return-expiry":
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                if name == "inherited-copy-worker-end" and identity == "copy-0":
                    state["faultReached"] = True
                    clock[0] = owner.transfer_ends["policy.o"]
                if name == "inherited-retirement-expiry" and identity == "remove-" + owner.name + "-build":
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                if identity == "runtime-preparation":
                    preparation_before = clock[0]
                    if name in ("inherited-preparation-command-failure", "inherited-preparation-reserve-expiry"):
                        assert state["preparationFaultDeliveries"] == [] and state["phase"] == "BODY"
                        assert len(state["preparationEntries"]) == 1 and owner.preparation_attempted
                        if name == "inherited-preparation-reserve-expiry":
                            assert ok and row["status"] == "PASSED" and row["returncode"] == 0
                            assert preparation_before < owner.deadline - 20
                            clock[0] = owner.deadline - 20
                            state["preparationBoundaries"].append(dict(seam="command-return", phase=state["phase"],
                                before=preparation_before, after=clock[0], deadline=owner.deadline,
                                entries=len(state["preparationEntries"])))
                        else:
                            assert not ok and row["status"] == "FAILED" and row["returncode"] == 1
                        delivery = dict(id=identity, ok=ok, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
                        state["preparationFaultDeliveries"].append(delivery)
                        state["faultDeliveries"].append(delivery)
                        state["faultReached"] = True
                    state["preparationReturns"].append(dict(phase=state["phase"], before=preparation_before,
                        after=clock[0], deadline=owner.deadline, entries=len(state["preparationEntries"]),
                        status=row["status"], returncode=row["returncode"], ok=ok,
                        bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                return ok, payload

            def link_decode(payload):
                owner = state["currentOwner"]
                state["linkDecodes"].append(dict(phase=state["phase"], clock=clock[0],
                    bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
                    commands=[row[0] for row in state["commands"]],
                    payloadAdmitted=owner.preparation_payload is not None,
                    preFinalAdmitted=owner.cache_pre_final is not None))
                return actual_link_decode(payload)

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
                owner.events.append(dict(id="supplied-minimal-control-view", production4882RowBodyExercised=False))
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
                if inherited:
                    return actual_inspect(owner, artifacts)
                owner.models_passed = True  # explicitly supplied model outcome, not actual model execution
                owner.events.append(dict(id="supplied-model-success-boundary", realModelExecutions=0))
                owner.save()

            def build_body(owner, view, licensed):
                state["currentOwner"] = owner
                container_name = owner.name + "-build"
                create = container_profile(owner, container_name)
                create += ["--mount", "type=bind,src=" + str(packet / "native") + ",dst=/src,readonly",
                           "--mount", "type=bind,src=" + str(view) + ",dst=/tool,readonly",
                           "--entrypoint", "/usr/local/bin/node", D.IMAGE, "-e", "setInterval(()=>{},1000)"]
                state["expectedCreate"] = list(create)
                if inherited:
                    return actual_build(owner, view, licensed)
                assert owner.docker_base(container_name) == container_profile(owner, container_name)
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
                if name in ("walker-foreign-container","walker-before-reader"):
                    owner.snapshot_cache(container_id,initial=True)
                    if name=="walker-foreign-container":
                        owner.run_reader_controls(container_id)
                    supplied_container="b"*64 if name=="walker-foreign-container" else container_id
                    state["faultReached"]=True
                    state["walkerDirect"].append((supplied_container,list(owner.cache_walker_attempts),
                        owner.reader_controls_passed,owner.cache_walker_controls_passed))
                    owner.run_cache_walker_controls(supplied_container)
                assert owner.command("compiler-version", execute + ["/tool/zig", "version"], 5)[0]
                if name == "repeat-initial":
                    state["faultReached"] = True
                    owner.snapshot_cache(container_id, initial=True)
                producer_order = list(F.COMPILE_PRODUCERS[1:]) + ["link-" + model for model in D.LINKS]
                if name == "wrong-producer-order":
                    state["faultReached"] = True
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
                artifacts = owner.fixture / "artifacts"
                artifacts.mkdir(mode=0o755)
                assert owner.command("artifact-source-snapshot", execute + ["/usr/local/bin/node", "-e", F.fixed_source_snapshot_script()], 5)[0]
                if name == "repeat-final":
                    state["faultReached"] = True
                    owner.snapshot_cache(container_id, initial=False)
                for index, row in enumerate(source_rows):
                    path = artifacts / row["name"]
                    assert owner.command("copy-" + str(index), ["/usr/bin/docker", "cp", container_id + ":/work/" + row["name"], str(path)], 3)[0]
                    assert owner.artifact_copy_valid(path, row)
                owner.remove(container_name)  # actual inspect/capture/remove custody before reconciliation
                owner.after_build_retirement(artifacts)
                for path in owner.artifact_paths(artifacts):
                    owner.artifact_mode(path, 0o555 if path.name.endswith("-model") else 0o444)
                owner.after_artifact_modes(artifacts)
                owner.inspect_then_models(artifacts)

            def save(owner):
                result = actual_save(owner)
                if name=="walker-repeat" and owner.cache_walker_controls_passed and not state["faultReached"]:
                    state["faultReached"]=True
                    state["walkerDirect"].append((container_id,list(owner.cache_walker_attempts),
                        owner.reader_controls_passed,owner.cache_walker_controls_passed))
                    owner.run_cache_walker_controls(container_id)
                if name == "cache-ready-save-expiry" and owner.cache_initial is not None and owner.cache_final is None and not state["faultReached"]:
                    state["faultReached"] = True
                    clock[0] = owner.deadline - 20
                if name in ("inherited-copy-save-end", "inherited-copy-settlement-end") and not state["faultReached"] and "policy.o" in owner.transfer_reports:
                    settled = "policy.o" in owner.transfer_verified
                    if settled is (name == "inherited-copy-settlement-end"):
                        state["faultReached"] = True
                        clock[0] = owner.transfer_ends["policy.o"]
                return result

            def copy_valid(owner, path, row):
                result = actual_copy_valid(owner, path, row)
                state["sourceCopyChecks"].append(row["name"])
                return result

            def artifact_hash(owner, path):
                state["hashEntries"].append((path.name, owner.artifact_retired, len(owner.containers)))
                if name in ("inherited-first-model-hash-expiry", "inherited-second-model-hash-expiry") and path.name == "policy-model" and owner.artifact_retired:
                    target_count = 1 if name == "inherited-first-model-hash-expiry" else 2
                    observed = sum(leaf == "policy-model" and retired for leaf, retired, _ in state["hashEntries"])
                    if observed == target_count:
                        state["faultReached"] = True
                        clock[0] = owner.deadline - 20
                return actual_artifact_hash(owner, path)

            def is_file(path):
                result = raw_is_file(path)
                if name == "inherited-source-dependency-expiry" and path == packet / "native" / (D.BASE + "policy.c") and state["owners"] == []:
                    # Manifest authentication also probes this path. Only the
                    # actual post-publication dependency phase may deliver it.
                    if state.get("currentOwner") is not None and state["currentOwner"].artifact_directory_published:
                        state["metadataProbes"].append(str(path))
                        state["faultReached"] = True
                        clock[0] = state["currentOwner"].deadline - 20
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

                if (name == "view-group-receipt-expiry" and path == fixture / "receipts/view-controls-g01.txt") or (
                        name == "walker-receipt-expiry" and path == fixture / "receipts/cache-walker-controls-w01.txt"):
                    result = raw_write(path, payload)
                    expiry_before = clock[0]
                    state["faultDeliveries"].append(dict(id=("cache-walker-controls-w01" if name=="walker-receipt-expiry" else "view-controls-g01"),
                        ok=True, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()))
                    state["faultReached"] = True
                    clock[0] = state["prerequisiteOwner"].deadline - 20
                    if name=="walker-receipt-expiry":
                        state["walkerExpiryBoundaries"].append(("receipt-write-return",expiry_before,clock[0],result))
                    return result
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
                       GITHUB_REF="refs/heads/codex/native-modeled-research-v18", GITHUB_RUN_ID="87654321", GITHUB_RUN_ATTEMPT="1",
                       PDAA_PACKET_SHA256=hashlib.sha256(packet_bytes).hexdigest(), GITHUB_SHA="MODELED_NO_PUBLICATION")
            error = None
            with ExitStack() as patches:
                patches.enter_context(patch.dict(os.environ, env))
                patches.enter_context(patch.object(sys, "argv", [str(packet / "filtered_driver.py"), str(packet)]))
                patches.enter_context(patch.object(D.time, "monotonic", side_effect=lambda: clock[0]))
                process = patches.enter_context(patch.object(D.subprocess, "Popen", side_effect=AssertionError("real process entry prohibited")))
                network = patches.enter_context(patch.object(D.urllib.request, "build_opener", side_effect=AssertionError("real archive entry prohibited")))
                patches.enter_context(patch.object(D.Attempt, "command", checked(command)))
                patches.enter_context(patch.object(D.Attempt, "download_extract", checked(archive)))
                patches.enter_context(patch.object(F.C, "decode", checked(decode)))
                patches.enter_context(patch.object(F.L, "decode", checked(link_decode)))
                patches.enter_context(patch.object(F.FilteredAttempt, "create_view", checked(create_view)))
                patches.enter_context(patch.object(D.Attempt, "licenses", checked(license_algorithm)))
                patches.enter_context(patch.object(D.Attempt, "build", checked(build_body)))
                patches.enter_context(patch.object(D.Attempt, "inspect_then_models", checked(model_boundary)))
                patches.enter_context(patch.object(F.FilteredAttempt, "cleanup_after_attempt", checked(cleanup)))
                patches.enter_context(patch.object(F.FilteredAttempt, "finalize", checked(finalize)))
                patches.enter_context(patch.object(F.FilteredAttempt, "save", checked(save)))
                patches.enter_context(patch.object(Path, "write_bytes", checked(write)))
                patches.enter_context(patch.object(F.FilteredAttempt, "artifact_copy_valid", checked(copy_valid)))
                patches.enter_context(patch.object(F.FilteredAttempt, "artifact_hash", checked(artifact_hash)))
                patches.enter_context(patch.object(Path, "is_file", checked(is_file)))
                try:
                    F.main()
                except BaseException as caught:
                    error = caught
                assert process.call_count == network.call_count == 0
            assert state["callbackErrors"] == [], (name, state["callbackErrors"])
            if name not in ("walker-return-expiry","walker-receipt-expiry"):
                assert state["walkerExpiryBoundaries"]==[], name
            if name not in ("inherited-preparation-command-failure", "inherited-preparation-reserve-expiry"):
                assert state["preparationFaultDeliveries"] == state["preparationBoundaries"] == [], name
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
            schema_target=next((row for row in NEW_SCHEMA_RESULT_CASES if row[0]==name),None)
            walker_fault=next((fault for key,fault in NEW_WALKER_CASES if key==name),None)
            if schema_target is not None:
                target,fault=schema_target[1:]
                index=next(index for index,row in enumerate(scripts) if row[0]==target)
                assert command_ids==[row[0] for row in scripts[:index+1]]
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete
                assert state["faultReached"] and len(state["faultDeliveries"])==1
                assert state["archiveEntries"]==state["viewEntries"]==state["modelEntries"]==state["finalizers"]==0
                assert state["workerEntries"]==state["walkerEntries"]==[] and owner.containers==[]
                original_output=(owner.receipts/(target+".txt")).read_bytes()
                delivered=state["faultDeliveries"][0]
                assert delivered==dict(id=target,ok=True,bytes=len(original_output),
                    sha256=hashlib.sha256(original_output).hexdigest())
                assert not any(row.get("id")=="prerequisite-control-coverage" for row in receipt["events"])
                if fault in ("duplicate-key","nonfinite"):
                    assert type(error) is F.T.Refused and str(error)=="ADMISSION"
                elif fault=="malformed-json":
                    assert type(error) is json.JSONDecodeError and error.msg=="Expecting property name enclosed in double quotes"
                else:
                    assert type(error) is D.Refused and str(error)==(
                        "bounded versioned prerequisite controls result" if fault=="byte-limit" else
                        "complete exact versioned prerequisite controls result")
                complete(name)
                return
            if walker_fault is not None:
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete
                assert state["faultReached"] and state["modelEntries"]==state["finalizers"]==0
                assert state["workerEntries"]==state["sourceCopyChecks"]==[]
                assert owner.cache_initial is not None and owner.cache_final is owner.preparation_payload is None
                assert len(state["decodes"])==1 and state["decodes"][0]["initial"] and not state["decodes"][0]["refused"]
                assert not any(identity in F.PRODUCERS for identity in command_ids)
                node_ids=["cache-walker-controls-"+key for key in state["walkerEntries"]]
                expected=[row[0] for row in scripts]+["build-create","build-start","runtime-cache-initial"]
                if walker_fault!="before-reader":expected+=["reader-controls"]
                expected+=node_ids+["inspect-owner-"+owner.name+"-build","remove-"+owner.name+"-build","final-container-census"]
                assert command_ids==expected
                assert owner.cache_walker_attempts==state["walkerEntries"]
                if walker_fault in ("repeat","foreign-container","before-reader"):
                    assert len(state["walkerDirect"])==1 and state["faultDeliveries"]==[]
                    assert type(error) is D.Refused and str(error)=="walker controls genuine pre-compiler owned builder boundary"
                    assert owner.cache_walker_controls_passed is (walker_fault=="repeat")
                    assert len(node_ids)==(5 if walker_fault=="repeat" else 0)
                    supplied,attempts,reader_passed,walker_passed=state["walkerDirect"][0]
                    assert supplied==("b"*64 if walker_fault=="foreign-container" else container_id)
                    assert attempts==state["walkerEntries"] and reader_passed is (walker_fault!="before-reader")
                    assert walker_passed is (walker_fault=="repeat")
                else:
                    assert len(state["faultDeliveries"])==1 and state["walkerDirect"]==[]
                    target=("w05" if walker_fault=="incomplete-last" else "w03" if walker_fault in (
                        "duplicate-name","reordered") else "w01")
                    assert state["walkerEntries"]==[key for key,_ in WALKER_GROUP_ORACLE][:
                        next(index for index,(key,_) in enumerate(WALKER_GROUP_ORACLE) if key==target)+1]
                    assert not owner.cache_walker_controls_passed
                    original_output=(owner.receipts/("cache-walker-controls-"+target+".txt")).read_bytes()
                    delivered=state["faultDeliveries"][0]
                    assert delivered==dict(id="cache-walker-controls-"+target,ok=walker_fault!="command-failure",
                        bytes=len(original_output),sha256=hashlib.sha256(original_output).hexdigest())
                    if walker_fault in ("return-expiry","receipt-expiry"):
                        assert type(error) is D.Refused and str(error)=="research deadline" and clock[0]==owner.deadline-20
                        expected_phase="command-return" if walker_fault=="return-expiry" else "receipt-write-return"
                        assert state["walkerExpiryBoundaries"]==[(expected_phase,owner.started,owner.deadline-20,
                            len(original_output) if walker_fault=="receipt-expiry" else None)]
                    elif walker_fault=="command-failure":
                        assert type(error) is D.Refused and str(error)=="fixed supplied cache walker group command incomplete"
                    elif walker_fault in ("duplicate-key","nonfinite"):
                        assert type(error) is F.T.Refused and str(error)=="ADMISSION"
                    elif walker_fault=="malformed-json":
                        assert type(error) is json.JSONDecodeError and error.msg=="Expecting property name enclosed in double quotes"
                    else:
                        assert type(error) is D.Refused and str(error)==(
                            "bounded supplied grouped controls result" if walker_fault=="byte-limit" else
                            "complete supplied grouped controls result")
                complete(name)
                return
            if name in NEW_PARENT_CASES:
                assert state["parentReads"]==[(43,65536)]*17 and len(state["parentOutcomes"])==1
                observed=state["parentOutcomes"][0]
                positive=name.endswith("1048576")
                initial_bytes=json.dumps(initial,separators=(",",":")).encode("ascii")
                expected=initial_bytes+b" "*(1048575-len(initial_bytes))+b"\n"
                retained=(owner.receipts/"runtime-cache-initial.txt").read_bytes()
                assert retained==expected and len(retained)==1048576
                assert observed["ok"] is positive and observed["bytes"]==1048576
                assert observed["sha256"]==hashlib.sha256(expected).hexdigest()
                assert observed["kills"]==([] if positive else [(456,D.signal.SIGKILL)])
                assert observed["popenCalls"]==observed["waitCalls"]==observed["selectorCloses"]==observed["pipeCloses"]==1
                assert observed["unregisters"]==(1 if positive else 0)
                assert observed["argv"]==(["/usr/bin/docker","exec","--workdir","/work",container_id,
                    "/usr/local/bin/node","-e",F.C.INITIAL_SCRIPT],)
                assert observed["kwargs"]==dict(stdin=D.subprocess.DEVNULL,stdout=D.subprocess.PIPE,stderr=D.subprocess.STDOUT,
                    env={"PATH":"/usr/bin:/bin","HOME":str(owner.fixture),"LANG":"C","LC_ALL":"C"},start_new_session=True)
                raw_row=next(row for row in owner.events if row.get("id")=="runtime-cache-initial")
                assert raw_row["status"]==("PASSED" if positive else "OUTPUT_LIMIT")
                assert raw_row["outputBytes"]==1048576 and raw_row["outputSha256"]==observed["sha256"]
                if not positive:
                    assert type(error) is D.Refused and str(error)=="bounded fixed runtime cache inquiry failed"
                    assert state["faultReached"] and len(state["faultDeliveries"])==1
                    assert state["decodes"]==[] and owner.cache_initial is None
                    assert command_ids==[row[0] for row in scripts]+["build-create","build-start","runtime-cache-initial",
                        "inspect-owner-"+owner.name+"-build","remove-"+owner.name+"-build","final-container-census"]
                    assert state["walkerEntries"]==state["workerEntries"]==[] and state["modelEntries"]==state["finalizers"]==0
                    complete(name)
                    return
                assert state["decodes"][0]["bytes"]==1048576 and not state["decodes"][0]["refused"]
            if name in PREPARATION_CASE_NAMES:
                assert inherited and len(state["preparationEntries"]) == len(state["preparationReturns"]) == 1
                entered, returned = state["preparationEntries"][0], state["preparationReturns"][0]
                assert entered["sameOwner"] and entered["container"] == container_id and entered["attempted"]
                assert entered["phase"] == returned["phase"] == "BODY" and entered["linkRequests"] == ["policy"]
                assert entered["clock"] == returned["before"] < owner.deadline - 20
                assert entered["deadline"] == returned["deadline"] == owner.deadline == owner.started + 600
                assert returned["entries"] == 1 and owner.preparation_attempted
                assert command_ids.count("runtime-preparation") == 1
                preparation_row = next(row for row in receipt["events"] if row.get("id") == "runtime-preparation")
                retained = (owner.receipts / "runtime-preparation.txt").read_bytes()
                assert returned["bytes"] == len(retained) and returned["sha256"] == hashlib.sha256(retained).hexdigest()
                assert preparation_row["status"] == returned["status"] and preparation_row["returncode"] == returned["returncode"]
                assert preparation_row["suppliedModeledResponse"] is True
                assert state["archiveEntries"] == state["viewEntries"] == 1
                if name == "inherited-preparation-cap-90":
                    assert returned["ok"] and returned["status"] == "PASSED" and returned["returncode"] == 0
                    assert returned["before"] == returned["after"] and retained == preparation
                    assert state["faultDeliveries"] == [] and not state["faultReached"]
                    assert state["linkDecodes"] and state["linkDecodes"][0]["commands"][-1] == "runtime-preparation"
                    first_decode = state["linkDecodes"][0]
                    assert first_decode["phase"] == "BODY" and not first_decode["payloadAdmitted"] and not first_decode["preFinalAdmitted"]
                    assert first_decode["bytes"] == len(retained) and first_decode["sha256"] == hashlib.sha256(retained).hexdigest()
                    assert owner.link_requests == ["policy", "installer", "state"]
                    assert error is None and owner.terminal_complete and owner.success and not owner.failed
                    assert state["modelEntries"] == state["finalizers"] == 1 and state["modelStarts"] == list(D.LINKS)
                    assert receipt["status"] == "PASS_FILTERED_MODELED_ONLY" and len(owner.containers) == 4
                    assert state["sourceCopyChecks"] == list(F.T.NAMES) and len(state["workerEntries"]) == 18
                    assert [leaf for leaf, retired, _ in state["hashEntries"] if retired] == [model + "-model" for model in D.LINKS for _ in range(2)]
                    assert not owner.transfer_unsettled and set(owner.transfer_verified) == set(F.T.NAMES)
                    assert owner.artifact_retired and owner.artifact_directory_published and not owner.host_files.unsafe() and not owner.host_files.failed
                    assert len(state["decodes"]) == 3 and not any(row["refused"] for row in state["decodes"])
                    directory = owner.fixture / "artifacts"
                    if directory.exists():
                        directory.chmod(0o700)
                else:
                    assert type(error) is D.Refused and owner.failed and not owner.success and not owner.terminal_complete
                    assert receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE"
                    assert state["faultReached"] and len(state["faultDeliveries"]) == len(state["preparationFaultDeliveries"]) == 1
                    assert state["faultDeliveries"] == state["preparationFaultDeliveries"] == [dict(id="runtime-preparation",
                        ok=returned["ok"], bytes=len(retained), sha256=hashlib.sha256(retained).hexdigest())]
                    assert owner.link_requests == ["policy"] and not any(identity.startswith("link-") for identity in command_ids[len(scripts):])
                    assert owner.preparation_payload is owner.cache_pre_final is owner.runtime_inputs is owner.cache_final is None
                    assert state["linkDecodes"] == []
                    assert len(state["decodes"]) == 1 and state["decodes"][0]["initial"] and not state["decodes"][0]["refused"]
                    assert state["modelEntries"] == state["finalizers"] == 0 and state["modelStarts"] == []
                    assert state["workerEntries"] == state["sourceCopyChecks"] == [] and owner.transfer_attempts == []
                    assert owner.artifact_snapshot is None and not owner.artifact_directory_published and not owner.finalization_attempted
                    assert not any(row.get("id") == "runtime-input-binding" for row in receipt["events"])
                    assert state["cleanupEntries"] == [dict(failed=True, success=False, terminal=False)]
                    assert command_ids == [row[0] for row in scripts] + ["docker-version", "image-pull", "image-identity",
                        "build-create", "build-start", "runtime-cache-initial", "reader-controls",
                        "cache-walker-controls-w01", "cache-walker-controls-w02", "cache-walker-controls-w03",
                        "cache-walker-controls-w04", "cache-walker-controls-w05", "compiler-version", "clang-version",
                        "compile-policy", "compile-policy-controls", "compile-policy-install-controls", "compile-state",
                        "compile-state-controls", "compile-observer", "runtime-preparation",
                        "inspect-owner-" + owner.name + "-build", "remove-" + owner.name + "-build", "final-container-census"]
                    assert len(owner.containers) == 1 and owner.containers[0]["id"] == container_id and owner.containers[0]["removed"]
                    assert (owner.receipts / "final-container-census.txt").read_bytes() == b""
                    if name == "inherited-preparation-command-failure":
                        assert str(error) == "bounded fixed runtime preparation failed"
                        assert retained == b"supplied preparation command failure\n"
                        assert not returned["ok"] and returned["status"] == "FAILED" and returned["returncode"] == 1
                        assert returned["after"] == returned["before"] and state["preparationBoundaries"] == []
                    else:
                        assert str(error) == "research deadline" and retained == preparation
                        assert returned["ok"] and returned["status"] == "PASSED" and returned["returncode"] == 0
                        assert returned["before"] < returned["after"] == clock[0] == owner.deadline - 20 < owner.deadline
                        assert state["preparationBoundaries"] == [dict(seam="command-return", phase="BODY",
                            before=returned["before"], after=returned["after"], deadline=owner.deadline, entries=1)]
                complete(name)
                return
            if inherited:
                assert owner.deadline == owner.started + 600 and owner.receipt_bytes == sum(owner.receipt_verified.values()) + sum(owner.receipt_uncertain.values())
                if name == "inherited-healthy":
                    assert error is None and owner.terminal_complete and owner.success and not owner.failed
                    assert state["modelEntries"] == state["finalizers"] == 1 and state["modelStarts"] == list(D.LINKS)
                    assert receipt["status"] == "PASS_FILTERED_MODELED_ONLY" and len(owner.containers) == 4
                    assert state["sourceCopyChecks"] == list(F.T.NAMES) and len(state["workerEntries"]) == 18
                    assert [leaf for leaf, retired, _ in state["hashEntries"] if retired] == [model + "-model" for model in D.LINKS for _ in range(2)]
                    assert not owner.transfer_unsettled and set(owner.transfer_verified) == set(F.T.NAMES)
                    assert owner.artifact_retired and owner.artifact_directory_published and not owner.host_files.unsafe() and not owner.host_files.failed
                    assert len(state["decodes"]) == 3 and not any(row["refused"] for row in state["decodes"])
                else:
                    assert state["faultReached"] and error is not None and owner.failed and not owner.success and not owner.terminal_complete
                    assert receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE" and state["finalizers"] == 0
                    assert state["cleanupEntries"][0]["failed"] and not state["modelStarts"]
                    if name.startswith("inherited-elf-bad-"):
                        assert type(error) is D.Refused and str(error) == "ELF hashes bind actual independently verified source artifacts"
                        assert state["modelEntries"] == 1 and len(owner.containers) == 1
                        assert not any(identity.startswith("model-create-") for identity in command_ids)
                    elif name in ("inherited-copy-worker-end", "inherited-copy-save-end", "inherited-copy-settlement-end"):
                        expected = {"inherited-copy-worker-end": "original copy end after worker",
                            "inherited-copy-save-end": "original copy end after transfer receipt",
                            "inherited-copy-settlement-end": "original copy end after closed verification and receipt"}[name]
                        assert type(error) is D.Refused and str(error) == expected
                        assert clock[0] == owner.transfer_ends["policy.o"] == owner.started + 2.5
                        assert owner.transfer_attempts == ["policy.o"] and owner.transfer_unsettled == {"policy.o": source_rows[0]["bytes"]}
                        assert owner.transfer_charged == source_rows[0]["bytes"] and not owner.transfer_verified and state["sourceCopyChecks"] == []
                        assert len(state["workerEntries"]) == 1 and state["modelEntries"] == 0 and not owner.host_files.unsafe()
                        assert not any(identity in command_ids for identity in ("copy-1", "elf-inspection", "model-create-policy"))
                    else:
                        assert type(error) is D.Refused and str(error) == "research deadline" and clock[0] == owner.deadline - 20
                        assert len(state["workerEntries"]) == 18 and not owner.transfer_unsettled
                        if name == "inherited-retirement-expiry":
                            assert not owner.artifact_retired and owner.artifact_mode_attempts == [] and not owner.host_files.census_attempted
                            assert state["modelEntries"] == 0 and owner.host_files.operations == 18
                        elif name == "inherited-source-dependency-expiry":
                            assert state["metadataProbes"] == [str(packet / "native" / (D.BASE + "policy.c"))]
                            assert state["modelEntries"] == 0 and "elf-inspection" not in command_ids and owner.artifact_directory_published
                        else:
                            assert name in ("inherited-first-model-hash-expiry", "inherited-second-model-hash-expiry")
                            assert state["modelEntries"] == 1 and len(owner.containers) == (1 if name.startswith("inherited-first") else 2)
                            assert command_ids.count("model-create-policy") == (0 if name.startswith("inherited-first") else 1)
                            assert command_ids.count("model-policy") == 0
                # Control-owned fixture teardown happens after every evidence
                # assertion and does not alter subject witnesses or clocks.
                directory = owner.fixture / "artifacts"
                if directory.exists():
                    directory.chmod(0o700)
                complete(name)
                return

            if name in NEW_GROUP_CASES:
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete
                assert state["faultReached"] and len(state["faultDeliveries"]) == 1
                target = ("transfer-controls" if name in NEW_TRANSFER_CASES else
                          "filtered-controls-f08" if name == "filtered-group-wrong-membership" else
                          "view-controls-g11" if name == "view-group-incomplete-last" else "view-controls-g01")
                index = next(i for i, row in enumerate(scripts) if row[0] == target)
                assert command_ids == [row[0] for row in scripts[:index + 1]]
                delivered = state["faultDeliveries"][0]
                assert delivered["id"] == target
                original_output = (owner.receipts / (target + ".txt")).read_bytes()
                assert len(original_output) == delivered["bytes"] and hashlib.sha256(original_output).hexdigest() == delivered["sha256"]
                assert state["archiveEntries"] == state["viewEntries"] == state["modelEntries"] == state["finalizers"] == 0
                assert state["workerEntries"] == state["sourceCopyChecks"] == [] and owner.containers == []
                assert state["cleanupEntries"][0]["failed"] and receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE"
                assert not any(row.get("id") == "prerequisite-control-coverage" for row in receipt["events"])
                if name in NEW_TRANSFER_CASES:
                    observed = json.loads(original_output)
                    wanted_names = list(TRANSFER_CASE_ORACLE)
                    if name == "transfer-catalog-foreign":
                        wanted_names[0] = "foreign-control"
                    elif name == "transfer-catalog-reordered":
                        wanted_names[:2] = [TRANSFER_CASE_ORACLE[1], TRANSFER_CASE_ORACLE[0]]
                    else:
                        wanted_names[1] = TRANSFER_CASE_ORACLE[0]
                    assert observed == dict(schema=1, status="SUPPLIED_CONTROLS_PASS", cases=168, names=wanted_names,
                        realDockerInvocations=0, nativeQualification=False)
                    assert delivered["ok"] is True
                    assert type(error) is D.Refused
                    assert str(error) == ("complete supplied private-file controls result" if name == "transfer-catalog-duplicate" else
                        "complete exact transfer control catalog")
                elif name in ("view-group-return-expiry", "view-group-receipt-expiry"):
                    assert type(error) is D.Refused and str(error) == "research deadline"
                    assert clock[0] == owner.deadline - 20
                elif name == "view-group-command-failure":
                    assert type(error) is D.Refused and str(error) == "filtered fixed prerequisite controls command failed"
                    assert delivered["ok"] is False
                elif name == "view-group-duplicate-key":
                    assert type(error) is F.T.Refused and str(error) == "ADMISSION"
                elif name == "view-group-malformed-json":
                    assert type(error) is json.JSONDecodeError and error.msg == "Expecting property name enclosed in double quotes"
                else:
                    assert type(error) is D.Refused and str(error) == "complete supplied grouped controls result"
                complete(name)
                return
            if name in ("healthy","parent-capture-1048576"):
                assert error is None and owner.terminal_complete and owner.success and not owner.failed
                assert state["modelEntries"] == state["finalizers"] == 1 and receipt["status"] == "PASS_FILTERED_MODELED_ONLY"
                assert [row[0] for row in state["commands"][:len(scripts)]] == [r[0] for r in scripts]
                assert owner.view_builder.completed and owner.cache_initial and owner.cache_final
                assert owner.cache_pre_final and owner.reader_controls_passed and owner.cache_walker_controls_passed
                assert state["walkerEntries"] == [key for key,_ in WALKER_GROUP_ORACLE]
                assert owner.runtime_inputs == [
                    next(row for row in final["files"] if row["path"] == path) for path in runtime_paths]
                assert state["sourceCopyChecks"] == list(F.T.NAMES) and len(state["workerEntries"]) == 18
                assert owner.transfer_charged == sum(row["bytes"] for row in source_rows) and not owner.transfer_unsettled
                assert set(owner.transfer_verified) == set(F.T.NAMES) and owner.artifact_retired and owner.artifact_directory_published
                assert not owner.host_files.failed and not owner.host_files.unsafe() and owner.host_files.opaque_directory_slots == 1
            else:
                assert error is not None and owner.failed and not owner.success and not owner.terminal_complete, (name, error, state)
                assert receipt["status"] == "FILTERED_RESEARCH_FAILED_OR_INCOMPLETE"
                assert state["faultReached"], (name, error, state)
                if name in {"prerequisite-failure", "initial-inquiry-failure", "final-inquiry-failure", "final-json-failure"}:
                    assert len(state["faultDeliveries"]) == 1
                    delivered = state["faultDeliveries"][0]
                    if name == "prerequisite-failure":
                        assert delivered["id"] == "driver-controls" and delivered["ok"] is False
                        assert type(error) is D.Refused and str(error) == "filtered fixed prerequisite controls command failed"
                        assert state["decodes"] == []
                    elif name in {"initial-inquiry-failure", "final-inquiry-failure"}:
                        assert delivered["id"] == ("runtime-cache-initial" if name.startswith("initial") else "runtime-cache-final")
                        assert delivered["ok"] is False and type(error) is D.Refused
                        assert str(error) == "bounded fixed runtime cache inquiry failed"
                        assert len(state["decodes"]) == (0 if name.startswith("initial") else 2)
                        assert all(not row["refused"] for row in state["decodes"])
                        if name.startswith("final"):
                            assert [row["initial"] for row in state["decodes"]] == [True, False]
                    else:
                        assert delivered["id"] == "runtime-cache-final" and delivered["ok"] is True
                        assert type(error) is ValueError and str(error) == "cache duplicate decoded JSON key"
                        assert len(state["decodes"]) == 3 and state["decodes"][0]["initial"] and not state["decodes"][0]["refused"]
                        assert state["decodes"][1]["initial"] is False and not state["decodes"][1]["refused"]
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
                if name == "host-control-result-grammar":
                    assert type(error) is D.Refused and str(error) == "complete supplied private-file controls result"
                    assert state["archiveEntries"] == state["viewEntries"] == 0 and state["workerEntries"] == []
                    assert command_ids == [row[0] for row in scripts if row[1] != "filtered_controls.py"] and len(state["faultDeliveries"]) == 1
                if name.startswith("compile-vector-"):
                    assert type(error) is D.Refused and str(error) == "fixed original compile-only argument vector"
                    assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                        "reader-controls", *["cache-walker-controls-"+key for key,_ in WALKER_GROUP_ORACLE],
                        "compiler-version", "clang-version", "inspect-owner-" + owner.name + "-build",
                        "remove-" + owner.name + "-build", "final-container-census"]
                    assert owner.cache_initial is not None and owner.cache_final is None
                    assert not any(identity.startswith(("compile-", "link-")) for identity in command_ids[len(scripts):])
                if name.startswith("compile-boundary-"):
                    assert type(error) is D.Refused and str(error) == "fixed compile-only licensed owned-container boundary"
                    assert command_ids == [row[0] for row in scripts] + ["build-create", "build-start", "runtime-cache-initial",
                        "reader-controls", *["cache-walker-controls-"+key for key,_ in WALKER_GROUP_ORACLE],
                        "compiler-version", "clang-version", "inspect-owner-" + owner.name + "-build",
                        "remove-" + owner.name + "-build", "final-container-census"]
                    assert (owner.cache_initial is None) is (name == "compile-boundary-no-initial")
                    assert (owner.cache_final is not None) is (name == "compile-boundary-final-present")
                    if name == "compile-boundary-wrong-container":
                        assert owner.cache_initial["container"] == "b" * 64
                    assert not any(identity.startswith(("compile-", "link-")) for identity in command_ids[len(scripts):])
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
                    assert observed == list(F.COMPILE_PRODUCERS) + ["runtime-preparation", "link-policy"]
                    assert owner.link_requests == ["policy"] and type(error) is D.Refused
                    assert str(error) == "fixed final link dispatch order and original command cap"
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
                        producers = ["build-create", "build-start", "runtime-cache-initial", "reader-controls"] + [
                            "cache-walker-controls-"+key for key,_ in WALKER_GROUP_ORACLE] + list(F.COMPILE_PRODUCERS)
                        producers += ["runtime-preparation", "runtime-cache-pre-final"] + ["link-" + model for model in D.LINKS] + ["runtime-cache-final"]
                        if name != "final-return-expiry":
                            producers += ["artifact-source-snapshot"]
                        if late:
                            producers += ["copy-" + str(index) for index in range(18)]
                        assert command_ids == [row[0] for row in scripts] + producers + [
                            "inspect-owner-" + owner.name + "-build", "remove-" + owner.name + "-build", "final-container-census"]
                        assert owner.cache_initial is not None and (owner.cache_final is not None) is (name != "final-return-expiry")
                        assert len(state["decodes"]) == 3 and not any(row["refused"] for row in state["decodes"])
                        if name == "cleanup-save-expiry":
                            assert len(state["raw"]) == 3 and not owner.receipt_uncertain
                        if name == "terminal-save-expiry":
                            assert len(state["raw"]) == 2 and not owner.receipt_uncertain
            complete(name)
            directory = owner.fixture / "artifacts"
            if directory.exists():
                directory.chmod(0o700)

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
        scenario("inherited-healthy")
        scenario("host-control-result-grammar")
        for leaf in tuple(unit + ".o" for unit in D.UNITS) + tuple(model + "-model" for model in D.LINKS):
            scenario("inherited-elf-bad-" + leaf)
        for name in ("inherited-copy-worker-end", "inherited-copy-save-end", "inherited-copy-settlement-end",
                     "inherited-retirement-expiry", "inherited-source-dependency-expiry",
                     "inherited-first-model-hash-expiry", "inherited-second-model-hash-expiry"):
            scenario(name)
        for name in NEW_GROUP_CASES:
            scenario(name)
        for name in ADDED_FILTERED_CASE_NAMES:
            scenario(name)
        for name in PREPARATION_CASE_NAMES:
            scenario(name)
    assert tuple(completed) == selected and count == len(selected)
    return dict(schema=1, status="SUPPLIED_FILTERED_DRIVER_CONTROLS_PASS", group=group, cases=count,
                names=completed, realExternalInvocations=0, nativeQualification=False)


if __name__ == "__main__":
    assert len(sys.argv) == 3
    print(json.dumps(run(Path(sys.argv[1]), sys.argv[2]), separators=(",", ":"), sort_keys=True))
