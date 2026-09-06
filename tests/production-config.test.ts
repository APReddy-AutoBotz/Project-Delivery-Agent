import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import type { PeerCertificate } from "node:tls";
import { spawnSync } from "node:child_process";
import {
  loadConfig,
  loadDatabaseConfig,
  migrationDatabaseUrl,
} from "../packages/platform/src/index.js";

const dir = mkdtempSync(join(tmpdir(), "pdaa-config-"));
const key = randomBytes(32).toString("base64");
const password = "fixture-private:%40%25%?sslmode=disable&host=elsewhere";
for (const [name, value] of Object.entries({
  key,
  password,
  empty: "",
  ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n",
}))
  writeFileSync(join(dir, name), value + (name === "password" ? "\r\n" : ""));
afterAll(() => {
  for (const name of ["key", "password", "empty", "ca"])
    unlinkSync(join(dir, name));
  rmdirSync(dir);
});
const fixture = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DEPLOYMENT_MODE: "customer",
  AUTH_MODE: "oidc",
  DATA_MODE: "synthetic",
  CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
  APP_ORIGIN: "https://gateway:8443",
  PDAA_DB_HOST: "database",
  PDAA_DB_PORT: "5432",
  PDAA_DB_USER: "pdaa_api",
  PDAA_DB_NAME: "pdaa",
  PDAA_DB_PASSWORD_FILE: join(dir, "password"),
  PDAA_DB_CA_FILE: join(dir, "ca"),
  ENCRYPTION_KEY_FILE: join(dir, "key"),
  OIDC_ISSUER: "https://gateway:8443/identity/realms/pdaa",
  OIDC_JWKS_URI: "https://gateway:8443/identity/realms/pdaa/keys",
  OIDC_CLIENT_ID: "pdaa-web",
  OIDC_AUDIENCE: "pdaa-api",
  OIDC_SCOPE: "openid pdaa.read",
});
describe("Production deployment boundary — TR-DEP-003, NFR-SEC-003/005, TR-AUTH-001", () => {
  it("binds certificate identity to the configured IP instead of a TLS localhost fallback", () => {
    const tls = loadDatabaseConfig({ ...fixture(), PDAA_DB_HOST: "192.0.2.1" })
      .database.ssl;
    if (!tls || !tls.checkServerIdentity)
      throw new Error("Explicit identity verification absent");
    expect(
      tls.checkServerIdentity("localhost", {
        subjectaltname: "IP Address:192.0.2.1",
      } as PeerCertificate),
    ).toBeUndefined();
    for (const subjectaltname of ["DNS:localhost", "IP Address:192.0.2.2"])
      expect(
        tls.checkServerIdentity("localhost", {
          subjectaltname,
        } as PeerCertificate),
      ).toBeInstanceOf(Error);
  });
  it("refuses missing production migration configuration before selecting a datasource", () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("PDAA_") && key !== "DATABASE_URL",
      ),
    );
    const result = spawnSync(
      process.execPath,
      ["../../node_modules/prisma/build/index.js", "migrate", "deploy"],
      {
        cwd: "packages/data",
        env: {
          ...env,
          NODE_ENV: "production",
          DEPLOYMENT_MODE: "customer",
          DATA_MODE: "synthetic",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Customer database configuration is incomplete",
    );
    expect(result.stdout).not.toContain('Datasource "db"');
  });
  it("loads separated secrets and produces verified runtime and strict migration transports", () => {
    const config = loadConfig(fixture());
    expect(config.SESSION_SECRET).toBeUndefined();
    expect(config.ENCRYPTION_KEY).toBe(key);
    expect(config.database).toMatchObject({
      host: "database",
      user: "pdaa_api",
      password,
      ssl: { rejectUnauthorized: true },
    });
    expect(config.database).not.toHaveProperty("connectionString");
    const migration = new URL(migrationDatabaseUrl(config));
    expect(migration.hostname).toBe("database");
    expect(decodeURIComponent(migration.password)).toBe(password);
    expect(migration.searchParams.get("sslmode")).toBe("require");
    expect(migration.searchParams.get("sslaccept")).toBe("strict");
    expect(migration.searchParams.get("sslcert")).toBe(join(dir, "ca"));
    expect(migration.searchParams.has("host")).toBe(false);
    expect(
      loadDatabaseConfig({
        ...fixture(),
        ENCRYPTION_KEY_FILE: undefined,
        OIDC_ISSUER: undefined,
      }).database,
    ).toMatchObject({
      host: "database",
      password,
      ssl: { rejectUnauthorized: true },
    });
  });
  it("rejects transport overrides, insecure production modes and unsafe origins before connecting", () => {
    for (const patch of [
      {
        PDAA_DATABASE_URL:
          "postgresql://pdaa:private@remote/db?sslmode=disable",
      },
      { PDAA_DB_HOST: "database?sslmode=disable" },
      { PDAA_DB_PASSWORD_FILE: undefined },
      { PDAA_DB_HOST: "db:5432" },
      { PDAA_DB_HOST: ":::" },
      { DEPLOYMENT_MODE: "local" },
      { AUTH_MODE: "development" },
      { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      { APP_ORIGIN: "http://gateway" },
      { APP_ORIGIN: "https://gateway/private" },
      { APP_ORIGIN: "https://user:private@gateway" },
      { OIDC_ISSUER: "http://identity.test" },
      { OIDC_AUDIENCE: "pdaa-web" },
      { OIDC_SCOPE: "profile pdaa.read" },
      { OIDC_SCOPE: "openid\npdaa.read" },
    ])
      expect(() => loadConfig({ ...fixture(), ...patch })).toThrow();
  });
  it("rejects missing, empty and conflicting secret files without disclosing their values", () => {
    for (const patch of [
      { ENCRYPTION_KEY: key },
      { ENCRYPTION_KEY_FILE: join(dir, "absent-secret") },
      { ENCRYPTION_KEY_FILE: join(dir, "empty") },
      { PDAA_DB_PASSWORD_FILE: join(dir, "empty") },
      { PDAA_DB_CA_FILE: join(dir, "password") },
      { ENCRYPTION_KEY_FILE: undefined, ENCRYPTION_KEY: key },
    ]) {
      let error: unknown;
      try {
        loadConfig({ ...fixture(), ...patch });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error)).not.toContain(key);
      expect(inspect(error)).not.toContain(password);
      expect(inspect(error)).not.toContain("absent-secret");
    }
  });
});
