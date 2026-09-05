# Repository Scripts

## Documentation validation

`validate_documentation.py` validates the documentation-first control baseline, including requirement IDs, story and acceptance-criteria references, and indexed files.

Run from the repository root:

```bash
python -m pip install -r requirements-dev.txt
python scripts/validate_documentation.py
```

The current draft baseline is expected to pass while reporting a warning for Release 1 Must requirements that do not yet have direct one-to-one acceptance criteria.

Future scripts may add:

- requirement-to-issue consistency checks;
- PR requirement-reference checks;
- dependency licence validation;
- software bill of materials generation;
- documentation link validation; and
- release evidence packaging.
