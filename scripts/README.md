# Repository Scripts

## Documentation validation

`validate_documentation.py` validates the documentation-first control baseline, including requirement IDs, story and acceptance-criteria references, and indexed files.

Run from the repository root:

```bash
python -m pip install -r requirements-dev.txt
python scripts/validate_documentation.py
```

The approved baseline validates 245 requirements, 91 acceptance criteria, 38 stories
and 135 test specifications without a direct R1 Must coverage gap. Test
specifications with executable evidence are distinct from the number of tests run.

## Foundation validation

After installing the pinned Node 24/pnpm dependencies and following
`docs/06-commercial-deployment/LOCAL_DEVELOPMENT.md`, run:

```bash
pnpm build
pnpm check:architecture
pnpm check:contracts
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:recovery
```

`check:contracts` compares the generated API document without updating it. To
intentionally regenerate an approved change, run
`node scripts/local.mjs scripts/export-openapi.mjs` and review the diff.
The integration and recovery runners enforce synthetic loopback target guards.
With the local preview running, `pnpm test:e2e` checks browser workflows.
`pnpm test:production` uses isolated Docker services for the eight production
acceptance groups. See `docs/05-quality/FOUNDATION_CONTRACT_VALIDATION.md` for
the scope, evidence and remaining release gates.

Future scripts may add:

- requirement-to-issue consistency checks;
- PR requirement-reference checks;
- dependency licence validation;
- software bill of materials generation;
- documentation link validation; and
- release evidence packaging.
