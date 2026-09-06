import { it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { createApp } from "../apps/api/dist/app.js";
import { loadConfig, IdentityService } from "../packages/platform/src/index.js";
import type { ProjectRepository } from "../packages/domain/src/index.js";
it("reports database unready and stale worker without exposing infrastructure errors", async () => {
  const config = loadConfig({
    NODE_ENV: "test",
    AUTH_MODE: "development",
    DATA_MODE: "synthetic",
    CUSTOMER_ID: "10000000-0000-4000-8000-000000000001",
    PDAA_DATABASE_URL: "postgresql://pdaa:fixture@127.0.0.1:55432/pdaa_test",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
  });
  const repository: ProjectRepository = {
    listProjects: async () => [],
    getProject: async () => null,
    setGrant: async () => {},
    revokeGrant: async () => {},
    listAudit: async () => [],
    ready: async () => false,
    heartbeat: async () => new Date(0),
  };
  const identity = new IdentityService(config);
  const { app } = await createApp(config, repository, identity);
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    expect((await fetch(base + "/api/health/ready")).status).toBe(503);
    const response = await fetch(base + "/api/platform", {
      headers: {
        Authorization:
          "Bearer " + (await identity.developmentToken("operator")),
      },
    });
    expect(await response.json()).toMatchObject({
      database: "unavailable",
      worker: "unavailable",
    });
    repository.heartbeat = async () => null;
    const missing = await fetch(base + "/api/platform", {
      headers: {
        Authorization:
          "Bearer " + (await identity.developmentToken("operator")),
      },
    });
    expect(await missing.json()).toMatchObject({ worker: "unavailable" });
  } finally {
    await app.close();
  }
});
