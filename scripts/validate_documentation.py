#!/usr/bin/env python3
"""Validate requirement, acceptance, story and planned-test contracts."""
from __future__ import annotations
import sys
from pathlib import Path
from typing import Any
try:
    import yaml
except ImportError as exc:
    raise SystemExit('PyYAML is required: python -m pip install -r requirements-dev.txt') from exc

ROOT = Path(__file__).resolve().parents[1]
EXTERNAL_REFS = {'OPEN_SOURCE_POLICY'}


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError(f'{path.name} must contain a YAML mapping')
    return data


def load_manifest(path: Path, keys: tuple[str, ...]) -> dict[str, Any]:
    doc = load_yaml(path)
    includes = doc.get('includes', [])
    if not isinstance(includes, list):
        raise ValueError(f'{path.name}: includes must be a list')
    if includes and any(doc.get(key) for key in keys):
        raise ValueError(f'{path.name}: use inline entries or includes, not both')
    merged = {**doc, **{key: [] for key in keys}} if includes else doc
    seen = set()
    for rel in includes:
        if not isinstance(rel, str):
            raise ValueError('Catalog include must be a string')
        target = (path.parent / rel).resolve()
        if not target.is_relative_to(path.parent.resolve()) or target in seen:
            raise ValueError(f'Unsafe or duplicate catalog include: {rel}')
        seen.add(target)
        catalog = load_yaml(target)
        for key in keys:
            entries = catalog.get(key, [])
            if not isinstance(entries, list):
                raise ValueError(f'{rel}: {key} must be a list')
            merged[key].extend(entries)
    return merged


def validate(req_doc: dict[str, Any], trace: dict[str, Any], root: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    indexes: dict[str, dict[str, dict[str, Any]]] = {}
    for key, source in [('requirements', req_doc), ('acceptance_criteria', trace), ('stories', trace), ('tests', trace)]:
        items = source.get(key, [])
        index: dict[str, dict[str, Any]] = {}
        if not isinstance(items, list) or not items:
            errors.append(f'{key} must be a nonempty list')
            items = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
                errors.append(f'Invalid {key} entry or ID')
                continue
            if item['id'] in index:
                errors.append(f'Duplicate {key} ID: {item["id"]}')
            index[item['id']] = item
        indexes[key] = index
    reqs, acs, stories, tests = (indexes[k] for k in ('requirements', 'acceptance_criteria', 'stories', 'tests'))

    def refs(item: dict[str, Any], field: str, valid: set[str]) -> list[str]:
        values = item.get(field, [])
        if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
            errors.append(f'{item["id"]}: {field} must be a string list')
            return []
        if not values:
            errors.append(f'{item["id"]}: {field} is empty')
        for value in values:
            if value not in valid:
                errors.append(f'{item["id"]}: unknown {field} reference {value}')
        if len(set(values)) != len(values):
            errors.append(f'{item["id"]}: duplicate {field} references')
        return values

    def existing_file(value: Any) -> bool:
        if not isinstance(value, str) or not value:
            return False
        path = (root / value).resolve()
        return path.is_relative_to(root.resolve()) and path.is_file()

    statuses = {'draft', 'reviewed', 'approved'}
    baseline = req_doc.get('baseline_status')
    if baseline not in statuses:
        errors.append('Invalid baseline_status')
    md_by_name: dict[str, list[Path]] = {}
    for p in (root / 'docs').rglob('*.md'):
        md_by_name.setdefault(p.name, []).append(p)
    for rid, req in reqs.items():
        if req.get('parent') and req['parent'] not in reqs:
            errors.append(f'{rid}: missing parent {req["parent"]}')
        chain = {rid}
        parent = req.get('parent')
        while parent in reqs:
            if parent in chain:
                errors.append(f'{rid}: cyclic requirement ancestry')
                break
            chain.add(parent)
            parent = reqs[parent].get('parent')
        if req.get('status') not in statuses:
            errors.append(f'{rid}: invalid requirement status')
        source = req.get('source_doc')
        if not existing_file(source) and (not isinstance(source, str) or len(md_by_name.get(source, [])) != 1):
            errors.append(f'{rid}: missing or ambiguous source document {source}')
        if not isinstance(req.get('statement'), str) or not req['statement'].strip():
            errors.append(f'{rid}: missing statement')

    ac_requirements: dict[str, set[str]] = {}
    ac_tests: dict[str, set[str]] = {}
    for aid, ac in acs.items():
        ac_requirements[aid] = set(refs(ac, 'requirements', set(reqs) | EXTERNAL_REFS))
        ac_tests[aid] = set(refs(ac, 'tests', set(tests)))
        if not isinstance(ac.get('criterion'), str) or not ac['criterion'].strip():
            errors.append(f'{aid}: missing behavioral criterion')
    owned: set[str] = set()
    for sid, story in stories.items():
        requirements = refs(story, 'requirements', set(reqs))
        criteria = refs(story, 'acceptance_criteria', set(acs))
        owned.update(criteria)
        covered = set().union(*(ac_requirements.get(a, set()) for a in criteria))
        for rid in set(requirements) - covered:
            errors.append(f'{sid}: requirement {rid} is not covered by its own criteria')
    for aid, ac in acs.items():
        if ac.get('priority') == 'P0' and aid not in owned:
            errors.append(f'{aid}: P0 criterion has no owning story')
    for tid, test in tests.items():
        owners = refs(test, 'acceptance_criteria', set(acs))
        for aid in owners:
            if tid not in ac_tests.get(aid, set()):
                errors.append(f'{tid}: owning criterion {aid} does not reference this test')
        for aid in acs:
            if tid in ac_tests[aid] and aid not in owners:
                errors.append(f'{tid}: missing reverse ownership for {aid}')
        if not existing_file(test.get('specification')):
            errors.append(f'{tid}: missing test specification')
        if not isinstance(test.get('behavior'), str) or not test['behavior'].strip():
            errors.append(f'{tid}: missing expected behavior')
        if test.get('status') not in {'planned', 'implemented'}:
            errors.append(f'{tid}: invalid test status (execution outcomes belong in evidence)')
        if test.get('status') == 'implemented' and not test.get('evidence'):
            errors.append(f'{tid}: implemented test has no evidence')

    covered = set().union(*ac_requirements.values()) if ac_requirements else set()
    must = {rid for rid, req in reqs.items() if req.get('release') == 'R1' and req.get('priority') == 'Must'}
    uncovered = sorted(must - covered)
    if uncovered:
        message = f'{len(uncovered)} R1 Must requirements lack direct acceptance criteria: {", ".join(uncovered)}'
        (errors if baseline == 'approved' else warnings).append(message)
    if baseline == 'approved':
        for rid in must:
            if reqs[rid].get('status') != 'approved':
                errors.append(f'{rid}: R1 Must status must be approved with its baseline')
    return errors, warnings


def main() -> int:
    try:
        req_doc = load_manifest(ROOT / 'requirements/requirements.yaml', ('requirements',))
        trace = load_manifest(ROOT / 'requirements/traceability.yaml', ('acceptance_criteria', 'stories', 'tests'))
        errors, warnings = validate(req_doc, trace, ROOT)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        print(f'ERROR: {exc}')
        return 1
    print(f'Validated {len(req_doc.get("requirements", []))} requirements, '
          f'{len(trace.get("acceptance_criteria", []))} acceptance criteria, '
          f'{len(trace.get("stories", []))} stories and {len(trace.get("tests", []))} test specifications.')
    for message in warnings:
        print(f'WARNING: {message}')
    for message in errors:
        print(f'ERROR: {message}')
    if errors:
        return 1
    print('Documentation validation passed. Test specifications are not execution evidence.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
