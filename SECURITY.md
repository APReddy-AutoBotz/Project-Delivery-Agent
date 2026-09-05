# Security Policy

## Current project state

The repository currently contains a draft documentation and implementation-control baseline. Production application code has not yet been released.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, credential, customer-data exposure, or exploitable design flaw in a public issue.

Authorised collaborators should report security concerns privately to the repository owner through an approved private communication channel and include:

- affected document, component, branch, or commit;
- description of the issue;
- conditions required to reproduce it;
- potential confidentiality, integrity, availability, or authorisation impact;
- evidence or proof of concept with secrets and customer data removed; and
- recommended mitigation, when known.

Do not include real access tokens, passwords, API keys, private customer URLs, production logs, personal data, or confidential client material.

## Security principles

The product baseline requires:

- customer-hosted, single-tenant deployment support;
- least-privilege connector access;
- OIDC authentication and role/project-level authorisation;
- no unrestricted LLM access to databases or connectors;
- deterministic permission and policy enforcement outside the model;
- evidence-linked leadership answers;
- explicit handling of stale, conflicting, and unknown information;
- human approval for material external writes;
- idempotency and safe retry behavior;
- immutable audit and action receipts;
- encrypted credentials and token rotation;
- data minimisation and configurable retention; and
- backup, restore, upgrade, and rollback controls.

See:

- `docs/03-architecture/SECURITY_AND_PRIVACY.md`
- `docs/05-quality/THREAT_MODEL.md`
- `docs/05-quality/FAILURE_AND_RECOVERY_TESTS.md`
- `docs/02-requirements/RBAC_AND_PERMISSIONS.md`
- `docs/02-requirements/APPROVAL_AND_WRITEBACK.md`

## Repository handling

Never commit:

- `.env` files containing secrets;
- customer or employee project data;
- production database exports;
- OAuth refresh tokens;
- private keys or certificates;
- raw email or collaboration exports;
- unredacted logs;
- proprietary client documents; or
- source copied from repositories without an approved licence.

Any accidental secret exposure must be treated as compromised even after the Git history is rewritten. Revoke or rotate the credential immediately.

## Supported versions

No production version is currently supported. A version-support table will be added before the first customer deployment.
