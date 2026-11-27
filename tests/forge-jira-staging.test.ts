import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createForgeJiraInvocationVerifier } from "../packages/platform/src/forge-jira-invocation.js";
import { installForgeJiraStagingRoute, loadForgeJiraStagingBinding } from "../apps/api/src/forge-jira-staging.js";

const appId = "ari:cloud:ecosystem::app/77334c21-3dd0-474f-a53f-28b4eeee5a71";
const environmentId = "ari:cloud:ecosystem::environment/3bb5deab-afcd-4140-9be4-f837b4b14b2c";
const installationId = "ari:cloud:ecosystem::installation/75969db9-dc7b-4798-9715-bd098ac0d9d1";
const cloudId = "d0d52620-3203-4cfa-8db5-f2587155f0dd";
const apiBaseUrl = `https://api.atlassian.com/ex/jira/${cloudId}`;
const jiraProjectId = "10001";
const binding = { appId, environmentId, installationId, cloudId, jiraProjectId };
const forgeApp = {
  id: appId,
  environment: { id: environmentId, type: "STAGING" },
  module: { key: "jira-staging-project-probe", type: "core:endpoint" },
  installation: { id: installationId, contexts: [{ name: "jira", cloudId, apiBaseUrl }] },
};
const path = "/api/webhooks/forge/jira-staging";
const systemToken = "synthetic-system-token";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
});

function sign(options: {
  id?: string;
  app?: typeof forgeApp;
  audience?: string;
  expiry?: number;
  key?: CryptoKey;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ app: options.app ?? forgeApp })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("forge/invocation-token")
    .setAudience(options.audience ?? appId)
    .setJti(options.id ?? "scheduled-probe")
    .setIssuedAt(now - 5)
    .setNotBefore(now - 5)
    .setExpirationTime(options.expiry ?? now + 60)
    .sign(options.key ?? keys.privateKey);
}

function harness(fetchImpl: typeof fetch) {
  const use = vi.fn();
  const app = { use } as unknown as NestExpressApplication;
  const verify = createForgeJiraInvocationVerifier(binding, async () => keys.publicKey);
  installForgeJiraStagingRoute(app, binding, verify, fetchImpl);
  const route = use.mock.calls[0]![0];
  return async (token: string, url = path, oauthToken = systemToken) => {
    const headers = new Map([
      ["authorization", `Bearer ${token}`],
      ["x-forge-oauth-system", oauthToken],
    ]);
    const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
    response.status.mockReturnValue(response);
    await route({ method: "POST", path, url, get: (name: string) => headers.get(name) }, response, vi.fn());
    return response;
  };
}

describe("Forge Jira staging connection", () => {
  it("is disabled by default and denies mismatched invocations before reading Jira", async () => {
    const use = vi.fn();
    installForgeJiraStagingRoute({ use } as unknown as NestExpressApplication, loadForgeJiraStagingBinding(undefined));
    expect(use).not.toHaveBeenCalled();

    const fetchImpl = vi.fn<typeof fetch>();
    const call = harness(fetchImpl);
    const other = await generateKeyPair("RS256");
    const denied = await Promise.all([
      sign({ key: other.privateKey }),
      sign({ audience: "another-app" }),
      sign({ expiry: Math.floor(Date.now() / 1000) - 1 }),
      sign({ app: { ...forgeApp, id: "another-app" } }),
      sign({ app: { ...forgeApp, environment: { ...forgeApp.environment, type: "PRODUCTION" } } }),
      sign({ app: { ...forgeApp, environment: { ...forgeApp.environment, id: "another-environment" } } }),
      sign({ app: { ...forgeApp, module: { ...forgeApp.module, key: "another-endpoint" } } }),
      sign({ app: { ...forgeApp, installation: { ...forgeApp.installation, id: "another-installation" } } }),
      sign({ app: { ...forgeApp, installation: { id: installationId, contexts: [{ name: "jira", cloudId: "another-cloud", apiBaseUrl }] } } }),
      sign({ app: { ...forgeApp, installation: { id: installationId, contexts: [{ name: "jira", cloudId, apiBaseUrl: "https://wrong.invalid" }] } } }),
    ]);
    for (const token of denied) expect((await call(token)).status).toHaveBeenCalledWith(401);
    const valid = await sign();
    expect((await call(valid, path, "")).status).toHaveBeenCalledWith(401);
    expect((await call(valid, `${path}?project=10002`)).status).toHaveBeenCalledWith(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("executes one fixed project read and reuses the result for a repeated delivery", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ id: jiraProjectId, name: "sensitive project name" }));
    const call = harness(fetchImpl);
    const fit = await sign();
    const responses = await Promise.all([call(fit), call(fit)]);
    for (const response of responses) {
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith({ status: "reachable" });
    }
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(`${apiBaseUrl}/rest/api/3/project/${jiraProjectId}`, {
      method: "GET",
      headers: { authorization: `Bearer ${systemToken}`, accept: "application/json" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("denies provider permission failures and suppresses retries during a Jira rate limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ id: "10002" }))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    const call = harness(fetchImpl);
    const denied = await sign({ id: "denied" });
    expect((await call(denied)).status).toHaveBeenCalledWith(403);
    expect((await call(denied)).status).toHaveBeenCalledWith(403);
    expect((await call(await sign({ id: "different-project" }))).status).toHaveBeenCalledWith(503);
    const limited = await call(await sign({ id: "limited" }));
    expect(limited.status).toHaveBeenCalledWith(429);
    expect(limited.setHeader).toHaveBeenCalledWith("Retry-After", "120");
    expect((await call(await sign({ id: "retry" }))).status).toHaveBeenCalledWith(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
