# Controlled customer-hosted foundation acceptance

Requirement IDs: TR-DEP-001, TR-DEP-003, TR-AUTH-001/002/003, NFR-SEC-003/005/010.

Run `pnpm test:production` from the repository after installing Node 24/pnpm and
starting local Docker. The runner builds API, worker, web and development acceptance
targets, generates random synthetic credentials and a two-day certificate authority,
then starts a unique Compose project. It publishes no host ports, changes no host
certificate trust, uses ephemeral database storage and stops only that generated
project. The original `pdaa-foundation` database and preview remain available.

The fixture tests the same production configuration path used by application
containers. Keycloak is an isolated test provider; it is not a customer registration.
The `acceptance/compose.yaml` file is intentionally a development acceptance fixture.
It is not an approved customer installation or backup configuration. Complete
release packaging, notices, image scans, operations/recovery and customer-specific
identity registration remain open in Issue #5 and EXEC-003.

## Production configuration contract

Use `NODE_ENV=production`, `DEPLOYMENT_MODE=customer`, `AUTH_MODE=oidc`, an exact
HTTPS `APP_ORIGIN`, customer UUID and default `SHADOW_MODE=true`. Set explicit
`PDAA_DB_HOST`, `PDAA_DB_PORT`, `PDAA_DB_NAME`, `PDAA_DB_USER` and
`PDAA_DB_PASSWORD_FILE`. Use `PDAA_DB_CA_FILE` for a private database CA, or omit it
to use platform trust. Set `ENCRYPTION_KEY_FILE` to a base64-encoded 32-byte key.
Passwords may contain URL metacharacters; only a single terminal newline is removed.
Raw database URLs and direct encryption keys are rejected in production. Migration
configuration is validated independently and does not require the encryption key.

Runtime PostgreSQL always verifies certificate trust and the configured host/IP.
Prisma's pinned migration engine has a different TLS URL dialect: use the generated
`sslmode=require`, `sslaccept=strict`, `sslcert=<CA path>` parameters. Do not use
`verify-full`/`sslrootcert` with that engine or pass its URL to node-postgres.
Reference: [pinned engine source](https://github.com/prisma/prisma-engines/blob/0edf323efd1d98336f3f0a68684b56f689b900d3/quaint/src/connector/postgres/url.rs).

Configure HTTPS `OIDC_ISSUER` and `OIDC_JWKS_URI`, a public browser
`OIDC_CLIENT_ID`, a distinct API `OIDC_AUDIENCE`, `OIDC_SCOPE` containing `openid`
and the provider's API scope, and `OIDC_GROUP_ROLE_MAP`. `OIDC_RESOURCE` is optional
for providers that require it. Use `NODE_EXTRA_CA_CERTS` for a private identity CA.
Register `/auth/callback` and the application's origin as the logout redirect.
Development persona login cannot be enabled in production, including when test
data is synthetic. Access and ID tokens stay in browser memory; logout supplies
the ID-token hint before navigation.

## Evidence and recovery

Successful checks write `artifacts/production-acceptance.json`. Raw local build
diagnostics are not public artifacts. A run-specific `run.json` records its source
revision, dirty-worktree indicator, immutable image IDs and final status. The
canonical success report is invalidated before starting and published atomically
only after all checks and teardown succeed. Random fixture secrets remain under ignored
`tmp/pdaa-acceptance-*`; do not publish or reuse them. Rerun to obtain a fresh
isolated database and identity state. Customer data is never seeded or restored by
this runner. Existing guarded `pnpm test:integration` and `pnpm test:recovery`
continue to verify local forward migration, repeat deployment and full restore.

The acceptance database grants API CRUD access without table ownership and denies
audit update/delete/truncate/alter. The worker owns its Graphile schema and can
update only its business-schema heartbeat. These fixture grants establish the
boundary; future tables need explicit, reviewed grants in release provisioning.
The migration role can create schemas within the fixture database; it cannot
create databases or roles. Graphile's schema is provisioned separately, and its
temporary database CREATE privilege is revoked before the worker starts.

The web image removes Caddy's unused privileged-port capability so it can run as
a nonroot user with all capabilities dropped. Its loopback-only HTTP probe checks
process readiness; the acceptance client separately verifies ingress HTTPS trust.
HTTP request error logs are excluded because callback URLs can contain codes or
logout hints. Use safe API operational logs and readiness probes for failures.

Use [the image register](../docs/07-research/FOUNDATION_IMAGE_REGISTER.md) for pins,
packaging decisions and outstanding distribution work.
