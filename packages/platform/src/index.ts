import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import { roleSchema, type Actor, type Role } from "@pdaa/domain";
import type { Config } from "./config.js";
export {
  loadConfig,
  loadDatabaseConfig,
  readSecretFile,
  migrationDatabaseUrl,
  type Config,
  type DatabaseTransport,
} from "./config.js";
export { assertSyntheticDatabaseUrl } from "./database-target.js";

export class IdentityService {
  private readonly key: Uint8Array;
  private readonly jwks?: JWTVerifyGetKey;
  constructor(
    private readonly config: Config,
    verificationKey?: JWTVerifyGetKey,
  ) {
    this.key = new TextEncoder().encode(config.SESSION_SECRET ?? "");
    this.jwks =
      verificationKey ??
      (config.OIDC_JWKS_URI
        ? createRemoteJWKSet(new URL(config.OIDC_JWKS_URI), {
            timeoutDuration: 5000,
          })
        : undefined);
  }
  async authenticate(token: string): Promise<Actor> {
    const dev = this.config.AUTH_MODE === "development";
    const options = {
      issuer: dev ? "pdaa:local" : this.config.OIDC_ISSUER,
      audience: dev ? "pdaa:api" : this.config.OIDC_AUDIENCE,
      algorithms: dev ? ["HS256"] : ["RS256", "ES256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 0,
    };
    const { payload } = dev
      ? await jwtVerify(token, this.key, options)
      : await jwtVerify(token, this.jwks!, options);
    if (typeof payload.sub !== "string" || !payload.sub)
      throw new Error("Missing subject");
    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((v): v is string => typeof v === "string")
      : [];
    const mapped = dev
      ? z.array(roleSchema).parse(payload.roles)
      : [...new Set(groups.flatMap((g) => this.config.groupRoles[g] ?? []))];
    return {
      subject: payload.sub,
      roles: mapped,
      customerId: this.config.CUSTOMER_ID,
    };
  }
  async developmentToken(
    persona: "pm-atlas" | "leader-atlas" | "operator",
  ): Promise<string> {
    if (
      this.config.AUTH_MODE !== "development" ||
      this.config.NODE_ENV === "production" ||
      this.config.DATA_MODE !== "synthetic"
    )
      throw new Error("Development login disabled");
    const roles: Role[] =
      persona === "operator"
        ? ["system_admin"]
        : persona === "leader-atlas"
          ? ["leadership"]
          : ["project_manager"];
    return new SignJWT({ roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(persona)
      .setIssuer("pdaa:local")
      .setAudience("pdaa:api")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(this.key);
  }
}

export class CredentialVault {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32)
      throw new Error("Encryption key must contain 32 bytes");
  }
  encrypt(secret: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from("pdaa:v1:" + context));
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      data.toString("base64"),
    ].join(".");
  }
  decrypt(envelope: string, context: string): string {
    try {
      const parts = envelope.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") throw new Error();
      const iv = Buffer.from(parts[1]!, "base64");
      const tag = Buffer.from(parts[2]!, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, {
        authTagLength: 16,
      });
      decipher.setAAD(Buffer.from("pdaa:v1:" + context));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Credential decryption failed");
    }
  }
}

export async function guardedDispatch<T>(
  policy: { shadow: boolean; permitted: boolean; humanApproved: boolean },
  dispatch: () => Promise<T>,
): Promise<T> {
  if (
    !policy ||
    policy.shadow !== false ||
    policy.permitted !== true ||
    policy.humanApproved !== true
  )
    throw new Error("Outbound action blocked");
  return dispatch();
}

export function operationalLog(
  event: string,
  fields: {
    correlationId?: string;
    method?: string;
    status?: number;
    durationMs?: number;
  } = {},
): void {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }),
  );
}
