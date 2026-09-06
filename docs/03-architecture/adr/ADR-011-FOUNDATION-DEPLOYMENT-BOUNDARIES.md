# ADR-011: Production foundation configuration and component boundaries

Status: Accepted under delegated controller authority; final implementation review required
Date: 2026-09-06
Requirement IDs: TR-STACK-002, TR-STACK-004, TR-DEP-001, TR-DEP-003, TR-AUTH-001, NFR-SEC-003, NFR-SEC-005, NFR-ACC-001, NFR-ACC-002

## Decision

Approve a first-party React component layer using semantic native buttons, labelled
inputs/selects and live messages, styled by Tailwind 4.3.3. shadcn remains optional.
The existing visual layout stays in CSS; omit Tailwind Preflight to avoid resetting
established spacing. Native controls preserve keyboard and form behavior. This
satisfies the approved component-layer choice without adopting another UI runtime.

The production reference uses separate web/ingress, API and worker containers from
one build, plus explicit migration/backup jobs and bundled or external PostgreSQL.
The bundled production database provides pgvector; application use remains deferred
until approved semantic retrieval exists. Earlier local pgvector deferral did not
waive TR-STACK-004's deployment availability requirement.

Production connections use explicit nonsecret host/port/database/user settings and
mounted password/key files. Both runtime database consumers enforce certificate
and hostname verification; connection-string transport overrides are rejected.
Migration transport is validated separately. Identity uses configured API scopes
and audiences and authorization code with PKCE. Tokens remain in browser memory;
the provider logout request receives its ID-token hint explicitly.

## Alternatives and consequences

A complete UI framework adds runtime/dependency scope without a required control.
Keep a small approved layer and revisit for richer accessible interactions.
Environment-only secrets and TLS-optional customer databases would leave the
production boundary unverified; retain those conveniences only in the strictly
guarded existing local synthetic workflow.

Use an isolated real identity-provider fixture and trusted ephemeral certificates
for acceptance. No certificate is installed into the user's host trust store and
no customer integration is activated. Test results establish generic production
support, not acceptance of an untested customer's registration or infrastructure.

## Verification

EXEC-003 and Issue #5 track keyboard/form behavior, production OIDC login/logout,
denial tests, TLS and secret disclosure, restricted roles, migration/recovery and
distribution gates. Complete story acceptance still requires independent review,
passing remote checks and merge.

Sources: [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite),
[Preflight](https://tailwindcss.com/docs/preflight),
[node-postgres TLS](https://node-postgres.com/features/ssl),
[Keycloak containers](https://www.keycloak.org/server/containers).
