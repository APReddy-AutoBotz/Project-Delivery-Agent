import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import {
  loadConfig,
  IdentityService,
  CredentialVault,
  guardedDispatch,
  assertSyntheticDatabaseUrl,
} from "../packages/platform/src/index.js";
import { assessFact, canReadProject } from "../packages/domain/src/index.js";

export const syntheticEnv = () => ({
  NODE_ENV: "test",
  AUTH_MODE: "development",
  DATA_MODE: "synthetic",
  CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
  PDAA_DATABASE_URL: "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa_test",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(48).toString("base64url"),
});
describe("Foundation security — TR-AUTH-001, TR-AUTH-003, NFR-SEC-001, NFR-SEC-004, FR-APP-010", () => {
  it("rejects driver host overrides, alternate ports and ambient database configuration before a connection", () => {
    const valid = "postgresql://pdaa:synthetic@127.0.0.1:55432/pdaa";
    expect(assertSyntheticDatabaseUrl(valid, "pdaa").pathname).toBe("/pdaa");
    for (const invalid of [
      valid + "?host=remote.example",
      valid + "?port=5432",
      valid + "#fragment",
      valid.replace(":55432", ":5432"),
      valid.replace("127.0.0.1", "remote.example"),
      valid.replace("postgresql:", "http:"),
      valid.replace("/pdaa", "/customer"),
    ])
      expect(() => assertSyntheticDatabaseUrl(invalid, "pdaa")).toThrow();
    const env = syntheticEnv();
    expect(
      loadConfig({
        ...env,
        DATABASE_URL: "postgresql://remote.example/customer",
      }).PDAA_DATABASE_URL,
    ).toBe(env.PDAA_DATABASE_URL);
    expect(() =>
      loadConfig({
        ...env,
        PDAA_DATABASE_URL: undefined,
        DATABASE_URL: "postgresql://remote.example/customer",
      }),
    ).toThrow("PDAA_DATABASE_URL");
  });
  it("refuses development identity with production or customer data and defaults to shadow", () => {
    const env = syntheticEnv();
    expect(loadConfig(env).SHADOW_MODE).toBe("true");
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow(
      "Development identity",
    );
    expect(() => loadConfig({ ...env, DATA_MODE: "customer" })).toThrow(
      "Development identity",
    );
    expect(() => loadConfig({ ...env, AUTH_MODE: "oidc" })).toThrow(
      "incomplete",
    );
  });
  it("validates signature, expiry, issuer and audience", async () => {
    const config = loadConfig(syntheticEnv());
    const identity = new IdentityService(config);
    const good = await identity.developmentToken("pm-atlas");
    expect((await identity.authenticate(good)).subject).toBe("pm-atlas");
    await expect(
      identity.authenticate(good.slice(0, -8) + "tampered"),
    ).rejects.toThrow();
    const sign = (issuer: string, aud: string, expiry: number) =>
      new SignJWT({ roles: ["system_admin"] })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("operator")
        .setIssuer(issuer)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(expiry)
        .sign(new TextEncoder().encode(config.SESSION_SECRET));
    for (const token of [
      await sign("evil", "pdaa:api", Date.now() / 1000 + 500),
      await sign("pdaa:local", "evil", Date.now() / 1000 + 500),
      await sign("pdaa:local", "pdaa:api", 1),
    ])
      await expect(identity.authenticate(token)).rejects.toThrow();
  });
  it("maps only configured OIDC groups and rejects development tokens in OIDC mode", async () => {
    const keys = await generateKeyPair("RS256");
    const config = loadConfig({
      ...syntheticEnv(),
      AUTH_MODE: "oidc",
      OIDC_ISSUER: "https://identity.example.test",
      OIDC_JWKS_URI: "https://identity.example.test/keys",
      OIDC_AUDIENCE: "pdaa",
      OIDC_CLIENT_ID: "web",
      OIDC_GROUP_ROLE_MAP: '{"operators":["system_admin"]}',
    });
    const identity = new IdentityService(config, async () => keys.publicKey);
    const token = await new SignJWT({
      groups: ["operators", "unmapped"],
      roles: ["pmo_admin"],
    })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("real-subject")
      .setIssuer(config.OIDC_ISSUER!)
      .setAudience("pdaa")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    expect((await identity.authenticate(token)).roles).toEqual([
      "system_admin",
    ]);
    await expect(identity.developmentToken("operator")).rejects.toThrow(
      "disabled",
    );
    await expect(
      identity.authenticate(
        await new IdentityService(loadConfig(syntheticEnv())).developmentToken(
          "operator",
        ),
      ),
    ).rejects.toThrow();
  });
  it("encrypts with randomized context-bound envelopes and rejects tampering and shortened tags", () => {
    const vault = new CredentialVault(randomBytes(32).toString("base64"));
    const first = vault.encrypt("synthetic-secret", "customer:connector:1");
    expect(first).not.toContain("synthetic-secret");
    expect(vault.encrypt("synthetic-secret", "customer:connector:1")).not.toBe(
      first,
    );
    expect(vault.decrypt(first, "customer:connector:1")).toBe(
      "synthetic-secret",
    );
    expect(() => vault.decrypt(first, "other-customer:connector:1")).toThrow(
      "decryption failed",
    );
    for (const length of [4, 8, 12]) {
      const parts = first.split(".");
      parts[2] = Buffer.from(parts[2]!, "base64")
        .subarray(0, length)
        .toString("base64");
      expect(() =>
        vault.decrypt(parts.join("."), "customer:connector:1"),
      ).toThrow();
    }
    const parts = first.split(".");
    parts[3] = Buffer.from("tamper").toString("base64");
    expect(() =>
      vault.decrypt(parts.join("."), "customer:connector:1"),
    ).toThrow();
  });
  it("does not execute outbound callback for any incomplete or malformed policy", async () => {
    const dispatch = vi.fn(async () => "sent");
    for (const policy of [
      null,
      {},
      { permitted: true, humanApproved: true },
      { shadow: true, permitted: true, humanApproved: true },
      { shadow: false, permitted: false, humanApproved: true },
      { shadow: false, permitted: true, humanApproved: false },
      { shadow: false, permitted: "true", humanApproved: true },
    ])
      await expect(
        guardedDispatch(policy as never, dispatch),
      ).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await guardedDispatch(
        { shadow: false, permitted: true, humanApproved: true },
        dispatch,
      ),
    ).toBe("sent");
  });
  it("does not infer project access from an operational admin role", () => {
    const actor = {
      subject: "operator",
      roles: ["system_admin"] as const,
      customerId: "customer",
    };
    const project = {
      id: "atlas",
      portfolioId: "portfolio",
      code: "ATL",
      name: "Atlas",
      description: "",
      reportedStatus: "GREEN",
    };
    expect(
      canReadProject({ ...actor, roles: [...actor.roles] }, project, []),
    ).toBe(false);
    expect(
      canReadProject({ ...actor, roles: [...actor.roles] }, project, [
        {
          subject: "operator",
          scopeType: "project",
          scopeId: "draco",
          role: "contributor",
        },
      ]),
    ).toBe(false);
  });
});
describe("Orthogonal fact state — ADR-009", () => {
  it("retains provenance and marks staleness at the exact expiry boundary", () => {
    const result = assessFact(
      {
        provenance: "HUMAN_CONFIRMED",
        validUntil: "2026-09-06T12:00:00Z",
        conflicting: false,
      },
      new Date("2026-09-06T12:00:00Z"),
    );
    expect(result).toMatchObject({
      provenance: "HUMAN_CONFIRMED",
      freshness: "STALE",
      classification: "STALE",
    });
  });
  it("keeps conflict and freshness independent, with conflict taking label precedence", () => {
    expect(
      assessFact(
        { provenance: "SYSTEM_VERIFIED", validUntil: null, conflicting: true },
        new Date(),
      ),
    ).toMatchObject({
      provenance: "SYSTEM_VERIFIED",
      freshness: "UNKNOWN",
      conflict: "CONFLICTING",
      classification: "CONFLICTING",
    });
  });
});
