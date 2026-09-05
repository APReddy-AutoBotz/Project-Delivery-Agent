# Repository Publication and Local Setup

The canonical repository is:

```text
https://github.com/APReddy-AutoBotz/Project-Delivery-Agent
```

## Clone

```bash
git clone https://github.com/APReddy-AutoBotz/Project-Delivery-Agent.git
cd Project-Delivery-Agent
```

## Branches

- `main` is the canonical integration branch.
- `docs/baseline-v0.1` preserves the first complete documentation baseline.
- Future review or implementation work should use focused branches and pull requests.

## Validate after cloning

```bash
python -m pip install -r requirements-dev.txt
python scripts/validate_documentation.py
```

## Documentation approval status

Publication to GitHub does not mean the v0.1 documentation has been approved for implementation. The baseline remains Draft until:

1. the independent Astra review is completed;
2. P0 findings are resolved;
3. requirement and acceptance gaps relevant to Release 1 are closed;
4. open architecture and product decisions are recorded; and
5. the Product Owner marks the baseline Approved.

## First implementation gate

After approval, implementation should begin with the platform-foundation epic and follow the issue, ExecPlan, review, test, and traceability controls defined in:

- `AGENTS.md`
- `PLANS.md`
- `docs/04-delivery/EPICS_AND_STORIES.md`
- `docs/05-quality/DEFINITION_OF_DONE.md`
