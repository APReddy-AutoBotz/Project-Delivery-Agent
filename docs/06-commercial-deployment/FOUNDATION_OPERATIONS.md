# Foundation operations and recovery

Requirements: TR-DEP-001/003/004, NFR-AVL-001/002, NFR-SEC-003/004/005.
Decision: ADR-013. Issue: #5, supporting STORY-003. This is a reference operations
package, not approval to distribute or activate a customer installation. STORY-004
image/license/signing gates and customer identity registration remain required.

## Deployment settings

Use `deploy/customer/compose.yaml` with an external PostgreSQL 17 database that has
pgvector available, or add `deploy/customer/bundled-database.yaml` for a persistent
bundled database with no published database port. The bundled administrator is
`postgres`; set `PDAA_ADMIN_USER=postgres`. Use one customer per dedicated cluster:
the four `pdaa_*` role names are cluster-wide and must not already exist on first
provisioning. Create the target from `template0`, with no application objects or
extensions besides plpgsql. Provisioning installs vector and the worker schema.

Copy the non-secret settings from `deploy/customer/customer.env.example` to an
operator-controlled location outside Git. Resolve images to reviewed immutable
digests. The database certificate must cover `PDAA_DB_HOST`. The ingress certificate
must cover the registered `APP_ORIGIN`; the bundled database uses separate
`database.crt`/`database.key` files. `identity-ca.crt` holds the issuer trust bundle.
The web image serves HTTPS and proxies only `/api/*`; it contains no test identity
provider route. Register the OIDC callback and logout origin as described in
`deploy/README.md`. Customer configuration creates no demonstration projects.

`PDAA_SECRET_DIR` contains separate admin, migration, API, worker and backup password
files; `encryption-key` and `backup-key` each contain independently generated base64
32-byte keys. Keep the database, identity and ingress certificates there as well.
No password or key goes in the env file or command line. Local Compose file secrets
retain host file permissions: arrange read access for the receiving container UID
1000 without exposing the directory to other host users. Backups need a private,
existing filesystem directory writable by UID 1000 with atomic hard-link support.
The restore container requires a size-appropriate `/tmp` tmpfs; decrypted archives
exist only there and are removed after success or failure. Encrypt host swap or
disable swap if policy forbids memory-backed pages reaching disk.

The commands below use an explicit project and env file; add the bundled database
overlay to every command when using that option. Validate with `config --quiet`
first. Do not use `down --volumes` on a customer deployment.

```sh
docker compose --env-file /srv/pdaa/customer.env -p pdaa-customer -f deploy/customer/compose.yaml config --quiet
# Bundled option: add -f deploy/customer/bundled-database.yaml and start database first.
docker compose --env-file /srv/pdaa/customer.env -p pdaa-customer -f deploy/customer/compose.yaml run --rm operations provision
docker compose --env-file /srv/pdaa/customer.env -p pdaa-customer -f deploy/customer/compose.yaml up -d api worker web
```

Provision requires an administrator able to create roles/extensions and set owners.
It verifies the explicit `host:port/database` confirmation, customer, role safety and
existing passwords; it never rotates passwords silently. Repeating on the owned
customer is supported, including resuming a partially initialized marked database.
API and worker use restricted accounts; the migration owner and administrator
remain maintenance-only. Database comments distinguish owned and quarantined targets.

API health reports readiness within three seconds of a failed database probe.
Readiness may be unhealthy during maintenance while liveness remains available.
The worker exits on unhandled failures or 180 seconds without a successful scheduled
heartbeat. Container restart policies recover process exits; Docker's unhealthy
state alone does not restart a container. Monitor readiness and worker progress,
and alert on repeated restarts. The local development supervisor restarts a failed
worker independently so its failure no longer takes down API/web.

## Backup and upgrade

```sh
docker compose --env-file /srv/pdaa/customer.env -p pdaa-customer -f deploy/customer/compose.yaml run --rm backup
```

Run this one-shot job through the customer's scheduler at its approved RPO cadence,
before every upgrade, and alert on nonzero exit. No scheduler or customer automation
is installed by this repository. Copy completed `backup-*.pdaa` files to approved
off-host storage, retain them under the customer's retention policy, and verify
restores regularly. Do not delete the previous known-good backup until the new one
has passed a restore drill. Keep both keys separately from the archives, with
controlled recovery access; the archive key cannot decrypt stored connector secrets.

The backup role reads all first-party/Graphile tables and sequences but cannot write
them. Graphile tables have an explicit backup-only SELECT policy; the dump enables
row security after rejecting unreviewed filtering policies. No BYPASSRLS grant is
needed. The job holds the release/Prisma migration locks and exports one repeatable-read
snapshot for metadata and pg_dump. AES-256-GCM authenticates the envelope and metadata;
only a completed ciphertext is published atomically. Fixed errors omit SQL, secrets
and raw PostgreSQL diagnostics. The operations image contains PostgreSQL 17 clients,
Node and the reviewed operations closure; Prisma CLI/Studio is development-only.

For upgrades, review the release notes and migration set, back up, stop API/worker,
and run `operations migrate` with `PDAA_DB_USER=pdaa_migrate` and
`PDAA_DB_PASSWORD_FILE=/run/secrets/migration-password`. Use the new release images
only after the job passes. The job uses the existing Prisma ledger, rejects unknown,
unfinished or changed migrations, serializes concurrent adapters and applies each
complete SQL file transactionally. Nontransactional migrations require a separate
approved recovery design. Current schema is unchanged by this increment; the first
release migration is packaged exactly as before. There is no automatic SQL down path.

## Restore drill and recovery

Stop any clients of the restore target. On the same dedicated cluster, create a new
empty database from `template0` through the customer's database administration
process. Retain the original source database. Use its reviewed existing restricted
roles; cross-cluster role reconstruction is not automated in this increment.

```sh
docker compose --env-file /srv/pdaa/customer.env -p pdaa-customer -f deploy/customer/compose.yaml run --rm \
  -e PDAA_DB_NAME=pdaa_restore -e PDAA_OPS_TARGET=database:5432/pdaa_restore \
  operations restore backup-REPLACE.pdaa
```

The job authenticates the entire archive before any target SQL, checks customer and
release metadata, rejects existing target objects, revokes PUBLIC/API/worker CONNECT
and checks for surviving sessions. It never terminates another client's session.
Restoration uses one pg_restore transaction, repairs table/function/type ownership
and grants, verifies customer/history, and keeps application connections denied.
Any failure after quarantine leaves the target quarantined. Inspect and replace
only that failed drill target through the DBA process; never reset the source.
Provision/migrate cannot remove restore quarantine.

Verify row integrity, append-only audit, connector-secret decryption using the
separately retained key, Graphile ownership and absence of application sessions.
Do not start a worker on restored queue contents automatically. Promotion requires
the customer's incident/change procedure, explicit source/target choice, credential
review and later external-action reconciliation (STORY-036). There is deliberately
no automatic promotion command. For a code-only rollback, deploy the previous
reviewed image set; for a failed data upgrade, retain the source and restore the
pre-upgrade archive into a separate quarantined target with its matching release.

Limits: PostgreSQL 17 only; no point-in-time recovery or cross-cluster bootstrap;
backup jobs have a five-minute PostgreSQL client deadline and restore capacity is
bounded by the configured tmpfs. Validate capacity/RPO with customer-sized data.
