#!/usr/bin/env python3
"""Validate the documentation baseline and machine-readable traceability."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:
    raise SystemExit("PyYAML is required: python -m pip install pyyaml") from exc


ROOT = Path(__file__).resolve().parents[1]


def load_yaml(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a YAML mapping")
    return data


def duplicates(values: list[str]) -> list[str]:
    seen: set[str] = set()
    dupes: set[str] = set()
    for value in values:
        if value in seen:
            dupes.add(value)
        seen.add(value)
    return sorted(dupes)


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    req_path = ROOT / "requirements" / "requirements.yaml"
    trace_path = ROOT / "requirements" / "traceability.yaml"

    for path in (req_path, trace_path):
        if not path.exists():
            errors.append(f"Missing required file: {path.relative_to(ROOT)}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    req_doc = load_yaml(req_path)
    trace_doc = load_yaml(trace_path)

    requirements = req_doc.get("requirements", [])
    criteria = trace_doc.get("acceptance_criteria", [])
    stories = trace_doc.get("stories", [])

    req_ids = [item.get("id") for item in requirements if isinstance(item, dict)]
    ac_ids = [item.get("id") for item in criteria if isinstance(item, dict)]
    story_ids = [item.get("id") for item in stories if isinstance(item, dict)]

    for label, ids in (("requirement", req_ids), ("acceptance criterion", ac_ids), ("story", story_ids)):
        invalid = [value for value in ids if not isinstance(value, str) or not value]
        if invalid:
            errors.append(f"Invalid {label} IDs found")
        dupes = duplicates([value for value in ids if isinstance(value, str)])
        if dupes:
            errors.append(f"Duplicate {label} IDs: {', '.join(dupes)}")

    req_set = set(req_ids)

    for req in requirements:
        if not isinstance(req, dict):
            errors.append("Requirement entry is not a mapping")
            continue
        parent = req.get("parent")
        if parent and parent not in req_set:
            errors.append(f"{req.get('id')} references missing parent {parent}")

    allowed_external_refs = {"OPEN_SOURCE_POLICY"}
    for criterion in criteria:
        if not isinstance(criterion, dict):
            errors.append("Acceptance criterion entry is not a mapping")
            continue
        for ref in criterion.get("requirements", []):
            if ref not in req_set and ref not in allowed_external_refs:
                errors.append(f"{criterion.get('id')} references missing requirement {ref}")

    ac_set = set(ac_ids)
    for story in stories:
        if not isinstance(story, dict):
            errors.append("Story entry is not a mapping")
            continue
        for ref in story.get("requirements", []):
            if ref.startswith("AC-"):
                if ref not in ac_set:
                    errors.append(f"{story.get('id')} references missing acceptance criterion {ref}")
            elif ref not in req_set:
                errors.append(f"{story.get('id')} references missing requirement {ref}")
        story_acs = story.get("acceptance_criteria", [])
        if not story_acs:
            errors.append(f"{story.get('id')} has no mapped acceptance criteria")
        for ref in story_acs:
            if ref not in ac_set:
                errors.append(f"{story.get('id')} references missing acceptance criterion {ref}")

    required_files = [
        "README.md",
        "AGENTS.md",
        "PLANS.md",
        "docs/00-governance/DOCUMENT_INDEX.md",
        "docs/01-business-product/BRD.md",
        "docs/01-business-product/PRD.md",
        "docs/02-requirements/FRD.md",
        "docs/02-requirements/NFR.md",
        "docs/02-requirements/TRD.md",
        "docs/03-architecture/SOLUTION_ARCHITECTURE.md",
        "docs/04-delivery/RELEASE-1-VERTICAL-SLICE.md",
        "docs/05-quality/DEFINITION_OF_DONE.md",
        "docs/07-research/OPEN_SOURCE_ADOPTION_REGISTER.md",
    ]
    for rel in required_files:
        if not (ROOT / rel).exists():
            errors.append(f"Missing indexed baseline file: {rel}")

    ac_covered = {ref for criterion in criteria for ref in criterion.get("requirements", [])}
    r1_must = {
        req["id"]
        for req in requirements
        if req.get("release") == "R1" and req.get("priority") == "Must"
    }
    uncovered = sorted(r1_must - ac_covered)
    if uncovered:
        warnings.append(
            f"{len(uncovered)} R1 Must requirements do not yet have direct acceptance criteria. "
            "This is allowed while the baseline status is draft."
        )

    print(
        f"Validated {len(requirements)} requirements, "
        f"{len(criteria)} acceptance criteria and {len(stories)} stories."
    )
    for warning in warnings:
        print(f"WARNING: {warning}")

    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    print("Documentation validation passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
