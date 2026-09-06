import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import { z } from "zod";
import { roleSchema, type Role } from "@pdaa/domain";
import { assertSyntheticDatabaseUrl } from "./database-target.js";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  DEPLOYMENT_MODE: z.enum(["local", "customer"]).default("local"),
  AUTH_MODE: z.enum(["oidc", "development"]).default("oidc"),
  DATA_MODE: z.enum(["synthetic", "customer"]).default("customer"),
  CUSTOMER_ID: z.uuid(),
  PDAA_DATABASE_URL: z.string().min(1).optional(),
  PDAA_DB_HOST: z
    .string()
    .regex(/^[A-Za-z0-9.:-]+$/)
    .optional(),
  PDAA_DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PDAA_DB_NAME: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .optional(),
  PDAA_DB_USER: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .optional(),
  PDAA_DB_PASSWORD_FILE: z.string().min(1).optional(),
  PDAA_DB_CA_FILE: z.string().min(1).optional(),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  API_HOST: z.string().default("127.0.0.1"),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  SESSION_SECRET: z.string().min(43).optional(),
  SHADOW_MODE: z.enum(["true", "false"]).default("true"),
  OIDC_ISSUER: z.url().optional(),
  OIDC_JWKS_URI: z.url().optional(),
  OIDC_AUDIENCE: z.string().min(1).optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_SCOPE: z
    .string()
    .regex(/^[A-Za-z0-9:._/-]+(?: [A-Za-z0-9:._/-]+)*$/)
    .default("openid profile"),
  OIDC_RESOURCE: z.url().optional(),
  OIDC_GROUP_ROLE_MAP: z.string().default("{}"),
});

export type DatabaseTransport = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl:
    | false
    | {
        rejectUnauthorized: true;
        ca?: string;
        checkServerIdentity?: typeof checkServerIdentity;
      };
};
export type Config = z.infer<typeof schema> & {
  PDAA_DATABASE_URL: string;
  database: DatabaseTransport;
  groupRoles: Record<string, Role[]>;
};

export function readSecretFile(path: string, key: string): string {
  try {
    const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    if (!value || value.includes("\0")) throw new Error();
    return value;
  } catch {
    throw new Error(`Secret file unavailable: ${key}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (
    env.AUTH_MODE === "development" &&
    (env.NODE_ENV === "production" ||
      env.DATA_MODE !== "synthetic" ||
      (env.DEPLOYMENT_MODE && env.DEPLOYMENT_MODE !== "local"))
  )
    throw new Error(
      "Development identity requires non-production local synthetic data",
    );
  const values = { ...env };
  for (const key of ["ENCRYPTION_KEY", "SESSION_SECRET"]) {
    if (env[key] !== undefined && env[`${key}_FILE`] !== undefined)
      throw new Error(`Conflicting secret configuration: ${key}`);
    if (env[`${key}_FILE`] !== undefined)
      values[key] = readSecretFile(env[`${key}_FILE`]!, key);
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success)
    throw new Error(
      "Invalid configuration keys: " +
        [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(
          ", ",
        ),
    );
  const c = parsed.data;
  if (
    c.NODE_ENV === "production" &&
    (c.DEPLOYMENT_MODE !== "customer" ||
      !env.ENCRYPTION_KEY_FILE ||
      c.PDAA_DATABASE_URL ||
      env.SESSION_SECRET ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  )
    throw new Error(
      "Production requires customer deployment, separated file secrets and verified TLS",
    );
  if (c.AUTH_MODE === "development" && !c.SESSION_SECRET)
    throw new Error("Development identity requires SESSION_SECRET");
  if (Buffer.from(c.ENCRYPTION_KEY, "base64").length !== 32)
    throw new Error("Invalid encryption key");

  const { database, PDAA_DATABASE_URL } = loadDatabaseConfig(env);

  if (
    c.AUTH_MODE === "oidc" &&
    (!c.OIDC_ISSUER ||
      !c.OIDC_JWKS_URI ||
      !c.OIDC_AUDIENCE ||
      !c.OIDC_CLIENT_ID)
  )
    throw new Error("OIDC configuration is incomplete");
  for (const value of [c.OIDC_ISSUER, c.OIDC_JWKS_URI, c.OIDC_RESOURCE]) {
    if (!value) continue;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error("OIDC endpoints require credential-free HTTPS");
  }
  if (!c.OIDC_SCOPE.split(" ").includes("openid"))
    throw new Error("OIDC_SCOPE requires openid");
  if (c.AUTH_MODE === "oidc" && c.OIDC_AUDIENCE === c.OIDC_CLIENT_ID)
    throw new Error("OIDC API audience must differ from the browser client");
  const origin = new URL(c.APP_ORIGIN);
  if (
    origin.origin !== c.APP_ORIGIN ||
    (c.NODE_ENV === "production" && origin.protocol !== "https:")
  )
    throw new Error("Invalid application origin; production requires HTTPS");
  let groupRoles: Record<string, Role[]>;
  try {
    groupRoles = z
      .record(z.string(), z.array(roleSchema))
      .parse(JSON.parse(c.OIDC_GROUP_ROLE_MAP));
  } catch {
    throw new Error("Invalid OIDC group-role mapping");
  }
  return { ...c, PDAA_DATABASE_URL, database, groupRoles };
}

const databaseSchema = schema.pick({
  NODE_ENV: true,
  DEPLOYMENT_MODE: true,
  DATA_MODE: true,
  PDAA_DATABASE_URL: true,
  PDAA_DB_HOST: true,
  PDAA_DB_PORT: true,
  PDAA_DB_NAME: true,
  PDAA_DB_USER: true,
  PDAA_DB_PASSWORD_FILE: true,
  PDAA_DB_CA_FILE: true,
});
export function loadDatabaseConfig(env: NodeJS.ProcessEnv) {
  const parsed = databaseSchema.safeParse(env);
  if (!parsed.success) throw new Error("Invalid database configuration keys");
  const c = parsed.data;
  if (
    c.NODE_ENV === "production" &&
    (c.DEPLOYMENT_MODE !== "customer" ||
      env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  )
    throw new Error("Production database requires verified TLS");
  let database: DatabaseTransport;
  let connection: URL;
  if (c.DEPLOYMENT_MODE === "local") {
    if (!c.PDAA_DATABASE_URL) throw new Error("Missing PDAA_DATABASE_URL");
    if (c.PDAA_DB_HOST || c.PDAA_DB_PASSWORD_FILE || c.PDAA_DB_CA_FILE)
      throw new Error("Conflicting local database configuration");
    // This path is deliberately unchanged in scope: only the explicit loopback fixture.
    connection = assertSyntheticDatabaseUrl(c.PDAA_DATABASE_URL);
    if (c.DATA_MODE !== "synthetic")
      throw new Error("Local deployment requires synthetic data");
    database = {
      host: connection.hostname,
      port: Number(connection.port),
      database: connection.pathname.slice(1),
      user: decodeURIComponent(connection.username),
      password: decodeURIComponent(connection.password),
      ssl: false,
    };
  } else {
    if (c.PDAA_DATABASE_URL)
      throw new Error(
        "Customer database uses explicit fields, not URL overrides",
      );
    if (
      !c.PDAA_DB_HOST ||
      !c.PDAA_DB_NAME ||
      !c.PDAA_DB_USER ||
      !c.PDAA_DB_PASSWORD_FILE
    )
      throw new Error("Customer database configuration is incomplete");
    const password = readSecretFile(
      c.PDAA_DB_PASSWORD_FILE,
      "PDAA_DB_PASSWORD",
    );
    let ca: string | undefined;
    if (c.PDAA_DB_CA_FILE) {
      try {
        ca = readFileSync(c.PDAA_DB_CA_FILE, "utf8");
      } catch {
        throw new Error("Database trust file unavailable");
      }
      if (!ca.includes("-----BEGIN CERTIFICATE-----"))
        throw new Error("Invalid database trust file");
    }
    database = {
      host: c.PDAA_DB_HOST,
      port: c.PDAA_DB_PORT,
      database: c.PDAA_DB_NAME,
      user: c.PDAA_DB_USER,
      password,
      ssl: {
        rejectUnauthorized: true,
        ...(ca ? { ca } : {}),
        checkServerIdentity: (_hostname, certificate) =>
          checkServerIdentity(c.PDAA_DB_HOST!, certificate),
      },
    };
    if (
      !isIP(c.PDAA_DB_HOST) &&
      !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(
        c.PDAA_DB_HOST,
      )
    )
      throw new Error("Invalid database host; configure the port separately");
    connection = new URL("postgresql://localhost");
    connection.hostname =
      isIP(c.PDAA_DB_HOST) === 6 ? `[${c.PDAA_DB_HOST}]` : c.PDAA_DB_HOST;
    connection.port = String(c.PDAA_DB_PORT);
    connection.pathname = c.PDAA_DB_NAME;
    connection.username = c.PDAA_DB_USER;
    connection.password = encodeURIComponent(password);
  }

  return { ...c, PDAA_DATABASE_URL: connection.toString(), database };
}

// Prisma's migration engine has its own TLS URL dialect; never pass this URL to pg.
export function migrationDatabaseUrl(
  config: ReturnType<typeof loadDatabaseConfig>,
): string {
  const url = new URL(config.PDAA_DATABASE_URL);
  if (config.DEPLOYMENT_MODE === "customer") {
    url.searchParams.set("sslmode", "require");
    url.searchParams.set("sslaccept", "strict");
    if (config.PDAA_DB_CA_FILE)
      url.searchParams.set("sslcert", config.PDAA_DB_CA_FILE);
  }
  return url.toString();
}
