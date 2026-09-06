import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { generateKeyPair, SignJWT } from "jose";
import {
  loadConfig,
  IdentityService,
  CredentialVault,
  assertSyntheticDatabaseUrl,
} from "../packages/platform/src/index.js";
const fixture = () => ({
  NODE_ENV: "test",
  AUTH_MODE: "oidc",
  DATA_MODE: "synthetic",
  CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
  PDAA_DATABASE_URL: "postgresql://pdaa:fixture@127.0.0.1:55432/pdaa_test",
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  SESSION_SECRET: randomBytes(48).toString("base64url"),
  OIDC_ISSUER: "https://identity.example.test",
  OIDC_JWKS_URI: "https://identity.example.test/keys",
  OIDC_AUDIENCE: "pdaa",
  OIDC_CLIENT_ID: "web",
});
describe("Production identity and secret error boundaries", () => {
  it("rejects invalid OIDC signatures, issuer, audience, expiry and missing required claims", async () => {
    const key = await generateKeyPair("RS256");
    const other = await generateKeyPair("RS256");
    const identity = new IdentityService(
      loadConfig(fixture()),
      async () => key.publicKey,
    );
    const valid = {
      sub: "subject",
      iss: "https://identity.example.test",
      aud: "pdaa",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const sign = (
      payload: Record<string, unknown>,
      signingKey = key.privateKey,
    ) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256" })
        .sign(signingKey);
    expect((await identity.authenticate(await sign(valid))).subject).toBe(
      "subject",
    );
    for (const payload of [
      { ...valid, iss: "https://other.example.test" },
      { ...valid, aud: "other" },
      { ...valid, exp: 1 },
      ...["sub", "exp", "iat"].map((claim) =>
        Object.fromEntries(Object.entries(valid).filter(([k]) => k !== claim)),
      ),
    ])
      await expect(
        identity.authenticate(await sign(payload)),
      ).rejects.toThrow();
    await expect(
      identity.authenticate(await sign(valid, other.privateKey)),
    ).rejects.toThrow();
  });
  it("does not preserve a sentinel credential in malformed URL errors", () => {
    const invalid =
      "postgresql://pdaa:SENTINEL_PRIVATE_VALUE@127.0.0.1:invalid/pdaa";
    for (const operation of [
      () => assertSyntheticDatabaseUrl(invalid),
      () => loadConfig({ ...fixture(), PDAA_DATABASE_URL: invalid }),
    ]) {
      try {
        operation();
        throw new Error("Expected rejection");
      } catch (error) {
        expect(inspect(error)).not.toContain("SENTINEL_PRIVATE_VALUE");
        expect((error as Error).message).toMatch(/Invalid.*database/);
      }
    }
  });
  it("requires an encryption key and fails closed with a different decryption key", () => {
    expect(() =>
      loadConfig({ ...fixture(), ENCRYPTION_KEY: undefined }),
    ).toThrow("ENCRYPTION_KEY");
    const first = new CredentialVault(randomBytes(32).toString("base64"));
    const second = new CredentialVault(randomBytes(32).toString("base64"));
    expect(() =>
      second.decrypt(
        first.encrypt("synthetic-token", "customer:connector"),
        "customer:connector",
      ),
    ).toThrow("decryption failed");
  });
});
