# Open-Source Software Policy

## Purpose

This policy protects the proprietary product from accidental licence contamination, unsupported dependencies and supply-chain risk.

## Normally permitted after review

- MIT
- Apache License 2.0
- BSD 2-Clause
- BSD 3-Clause
- ISC
- PostgreSQL Licence
- Other clearly permissive licences approved by legal review

## Requires explicit legal and product approval

- GPL
- LGPL
- AGPL
- SSPL
- Business Source Licence
- Sustainable Use Licence
- Elastic Licence
- Commons Clause
- Fair-code or source-available licences
- Dual-licensed repositories with enterprise-only directories
- Repositories without a clear licence
- Code generated from an unclear or unverifiable source

## Dependency decision criteria

Every runtime dependency must be evaluated for:

1. Product fit
2. Licence
3. Maintenance activity
4. Security history
5. Release stability
6. Transitive dependencies
7. Deployment impact
8. Replacement difficulty
9. Customer-hosted compatibility
10. Vendor lock-in

## Required controls

- Pin exact versions through the lockfile.
- Run dependency and vulnerability scanning in CI.
- Generate a software bill of materials for releases.
- Maintain `THIRD_PARTY_NOTICES.md`.
- Record each dependency in the adoption register.
- Define an exit or replacement path for critical dependencies.
- Do not import enterprise-only source directories without a commercial agreement.
- Do not fork unless modifying upstream code is unavoidable and maintainable.

## External reference repositories

Reference repositories may be inspected for general product and architecture ideas. Do not copy code, prompts, documentation or proprietary wording from unlicensed or incompatible repositories.

Use a clean-room process:

1. Researcher records abstract requirements and patterns.
2. The implementation task uses only approved internal requirements, official APIs and our architecture.
3. The implementation does not consult the incompatible reference repository.

## Legal review

This policy is an engineering control and is not legal advice. Final commercial distribution and customer source-access arrangements require specialist legal review.
