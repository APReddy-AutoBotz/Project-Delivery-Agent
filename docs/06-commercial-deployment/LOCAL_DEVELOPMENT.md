# Local foundation development

This increment runs synthetic data on one workstation. Node 24, pnpm 11.19.0 and
a local Docker engine are prerequisites. It does not connect Jira, email or AI.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose -f compose.yaml -p pdaa-foundation up -d --wait
pnpm build
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open http://localhost:5173. Project manager and leadership accounts see Atlas;
the platform operator sees service health and access administration, and has no
implicit project access. All three are explicit synthetic development identities.
API reference: http://localhost:3001/api/docs (development only).

The initial build generates the Prisma client. Restart `pnpm dev` after API or
worker changes and rebuild first; Vite reloads web changes. Local ports are 5173
(web), 3001 (API), and 55432 (PostgreSQL). They bind to loopback. The background
heartbeat runs every minute; health may show unavailable until its first run.

`setup:local` creates a private ignored `.env` with random secrets and preserves
an existing file. `PDAA_DATABASE_URL` is specific to this app; an ambient
`DATABASE_URL` is ignored. Local commands read the explicit `.env`, require
synthetic development, and reject remote hosts, alternate ports, database URL
options and unexpected database names before opening a connection. Do not share
the `.env`, test traces or credential-bearing environment dumps.

## Atlas approval demo

With the local PostgreSQL composition running and `pnpm build` complete, run
`node scripts/local.mjs scripts/test-escalation-browser.mjs --serve-atlas`.
The harness creates a disposable synthetic database and prints the owner's
invitation URL on port 5174. Sign in as the Atlas contributor and record a
reply. Confirm the API access status. Sign out, open the app home page, and
sign in as the project manager. Open **Atlas · Delivery approval** to review
the ATLAS-248 comment. Edit the proposed text if needed, then record the demo decision. After approval, select
**Record simulated comment** to see the receipt and fixture revision. Choose
a forecast confidence and select **Confirm API access caused the delay** to
record the PM assessment. Sign out, then sign in as Leadership to ask
**Why is Atlas delayed?** and inspect the cited schedule, late integration
start, synthetic Jira blocker, owner reply, captured PM escalation, simulated
comment receipt and PM assessment. Choose **Save draft snapshot** to freeze the
schedule, owner reply, comment receipt and PM assessment. Open **Leadership email preview** or choose
**Download editable PowerPoint** and check the shared snapshot ID. The draft
reopens for the same leadership user while the originating capture is accessible.
Choose **Request final approval**, then sign in as the Atlas project manager.
Open **Final report approval** and approve or reject the displayed snapshot.
Sign in as Leadership again to view the decision and download the PowerPoint
with the recorded approval status.
From the PM screen, choose **Distribute to Atlas Leadership** after approval.
The report and receipt appear under **Distributed report** for the Leadership
persona. This local inbox uses the same approved PowerPoint.

Stop the harness with Ctrl+C.

## Validation

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:integration
pnpm test:recovery
pnpm exec playwright install chromium
# Keep pnpm dev running in another terminal:
pnpm test:e2e
python scripts/validate_documentation.py
python -m unittest discover -s scripts -p "test_*.py"
pnpm audit --audit-level high
```

Integration checks create a fresh `pdaa_test_<timestamp>` database, apply the
migration twice, seed synthetic data and run live API tests. Recovery uses the
last successful test database, validates the local Docker endpoint and matching
database cluster, then restores into `pdaa_restore_<timestamp>`. It checks full
project/grant/audit/credential rows, credential decryption, scoped access and
audit mutation denial. Databases remain available for inspection. The restore
never starts a worker or enables outbound actions. Test artifacts are ignored.

`docker compose -f compose.yaml -p pdaa-foundation stop` stops the database while
preserving its volume. Stop the development command with Ctrl+C. Revert a code
change through Git; recover database state into a separate database before
switching an application connection. No destructive down migration is supplied.

## Customer deployment prerequisites

Production OIDC mode validates issuer, audience, signature and required claims;
it maps only configured groups. Set `AUTH_MODE=oidc`, `NODE_ENV=production`,
`DATA_MODE=customer`, `CUSTOMER_ID`, `PDAA_DATABASE_URL`, `OIDC_ISSUER`,
`OIDC_JWKS_URI`, `OIDC_AUDIENCE`, `OIDC_CLIENT_ID`, `OIDC_GROUP_ROLE_MAP`,
`APP_ORIGIN`, `ENCRYPTION_KEY` and `SESSION_SECRET` through customer secret/config
management. Keep `SHADOW_MODE=true`. The encryption key is 32 random bytes encoded
as base64. The development identity secret is separate. OIDC endpoints and
production browser origin require HTTPS. The browser uses authorization code
with PKCE and keeps access tokens in memory; register `/auth/callback` at the
customer origin. Refresh is manual sign-in in this increment. Global roles and
scoped grants are separate; granting a scoped admin role does not confer global
administration.

This is configuration guidance, not a validated production package. Real IdP
interoperability, API-specific token scope configuration, ingress TLS, separate
migration/runtime DB roles, key rotation, hardened application containers,
resource limits, image scans and complete distribution notices remain required
before customer use. The local PostgreSQL owner account is for synthetic tests.
