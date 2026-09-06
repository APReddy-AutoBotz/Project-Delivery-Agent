import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  DatabaseProjectRepository,
  DatabaseWorkerHeartbeatRepository,
} from "../packages/data/dist/index.js";
import {
  loadConfig,
  IdentityService,
} from "../packages/platform/dist/index.js";
import { createApp } from "../apps/api/dist/app.js";
import type { Actor, Grant } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Integration tests require the isolated pdaa_test database");
const db = createDatabase(url);
const repository = new DatabaseProjectRepository(db);
const customerId = process.env.CUSTOMER_ID!;
const atlas = "30000000-0000-4000-8000-000000000001";
const draco = "30000000-0000-4000-8000-000000000002";
const operator: Actor = {
  subject: "operator",
  roles: ["system_admin"],
  customerId,
};
const manager: Actor = {
  subject: "pm-atlas",
  roles: ["project_manager"],
  customerId,
};
const grant: Grant = {
  subject: "pm-atlas",
  scopeType: "project",
  scopeId: draco,
  role: "contributor",
};
const config = loadConfig(process.env);
const identity = new IdentityService(config);
let app: Awaited<ReturnType<typeof createApp>>["app"];
let base: string;
let pmToken: string;
let opToken: string;
beforeAll(async () => {
  ({ app } = await createApp(config, repository));
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
  pmToken = await identity.developmentToken("pm-atlas");
  opToken = await identity.developmentToken("operator");
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});
const api = (path: string, token?: string, method = "GET", body?: unknown) =>
  fetch(base + "/api" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("Real database and HTTP foundation boundaries", () => {
  it("INT-DATA-001: enforces customer/portfolio ownership and customer-scoped project-code uniqueness", async () => {
    const other = "10000000-0000-4000-8000-000000000090";
    const portfolio = "20000000-0000-4000-8000-000000000090";
    const project = "30000000-0000-4000-8000-000000000090";
    const data = {
      id: project,
      customerId: other,
      portfolioId: portfolio,
      code: "ATL",
      name: "Constraint fixture",
      description: "Synthetic",
      reportedStatus: "UNKNOWN",
    };
    await db.customer.create({
      data: { id: other, name: "Synthetic constraint fixture" },
    });
    await db.portfolio.create({
      data: { id: portfolio, customerId: other, name: "Synthetic" },
    });
    try {
      await expect(
        db.project.create({
          data: {
            ...data,
            portfolioId: "20000000-0000-4000-8000-000000000001",
          },
        }),
      ).rejects.toThrow();
      await expect(
        db.project.create({
          data: {
            ...data,
            customerId,
            portfolioId: "20000000-0000-4000-8000-000000000001",
          },
        }),
      ).rejects.toThrow();
      await db.project.create({ data });
      expect(await repository.getProject(manager, project)).toBe(null);
    } finally {
      await db.project.deleteMany({ where: { customerId: other } });
      await db.portfolio.delete({ where: { id: portfolio } });
      await db.customer.delete({ where: { id: other } });
    }
  });
  it("INT-DATA-001: heartbeat repository updates one durable worker row", async () => {
    const heartbeat = new DatabaseWorkerHeartbeatRepository(db);
    await heartbeat.recordHeartbeat(new Date("2026-09-06T00:00:00.000Z"));
    const latest = new Date();
    await heartbeat.recordHeartbeat(latest);
    expect(await repository.heartbeat()).toEqual(latest);
    expect(await db.serviceHeartbeat.count({ where: { id: "worker" } })).toBe(
      1,
    );
  });
  it("denies detail reads with no grants, including after the last grant is revoked", async () => {
    expect((await api("/projects/" + atlas, opToken)).status).toBe(404);
    const scope = {
      subject: "pm-atlas",
      scopeType: "project" as const,
      scopeId: atlas,
    };
    await repository.revokeGrant(operator, scope, "last-grant-revoked");
    try {
      expect((await api("/projects/" + atlas, pmToken)).status).toBe(404);
      expect(await repository.getProject(manager, atlas)).toBe(null);
      expect(await repository.listProjects(manager)).toEqual([]);
    } finally {
      await repository.setGrant(
        operator,
        { ...scope, role: "project_manager" },
        "last-grant-restored",
      );
    }
  });
  it("applies portfolio access and revocation without expanding operational roles", async () => {
    const portfolio = {
      subject: "portfolio-reader",
      scopeType: "portfolio" as const,
      scopeId: "20000000-0000-4000-8000-000000000001",
      role: "leadership" as const,
    };
    const reader: Actor = {
      subject: "portfolio-reader",
      roles: ["leadership"],
      customerId,
    };
    await repository.setGrant(operator, portfolio, "portfolio-grant");
    expect(
      (await repository.listProjects(reader)).map((p) => p.id).sort(),
    ).toEqual([atlas, draco]);
    const revocation = {
      subject: portfolio.subject,
      scopeType: portfolio.scopeType,
      scopeId: portfolio.scopeId,
    };
    await expect(
      repository.revokeGrant(manager, revocation, "denied"),
    ).rejects.toThrow("denied");
    await repository.revokeGrant(operator, revocation, "portfolio-revoke");
    expect(await repository.listProjects(reader)).toEqual([]);
  });
  it("requires identity and denies cross-project enumeration and detail", async () => {
    expect((await api("/projects")).status).toBe(401);
    const response = await api("/projects", pmToken);
    expect(response.status).toBe(200);
    expect((await response.json()).map((p: { id: string }) => p.id)).toEqual([
      atlas,
    ]);
    expect((await api("/projects/" + draco, pmToken)).status).toBe(404);
    expect(
      (await api("/projects/30000000-0000-4000-8000-000000000099", pmToken))
        .status,
    ).toBe(404);
    expect(await (await api("/projects", opToken)).json()).toEqual([]);
  });
  it("permits scoped administration only to administrators and rechecks revoked access", async () => {
    expect((await api("/access-grants", pmToken, "POST", grant)).status).toBe(
      403,
    );
    expect(
      (await api("/access-grants", opToken, "POST", { ...grant, admin: true }))
        .status,
    ).toBe(400);
    expect((await api("/access-grants", opToken, "POST", grant)).status).toBe(
      204,
    );
    expect((await api("/projects/" + draco, pmToken)).status).toBe(200);
    const { role: _role, ...revocation } = grant;
    expect(
      (await api("/access-grants", opToken, "DELETE", revocation)).status,
    ).toBe(204);
    expect((await api("/projects/" + draco, pmToken)).status).toBe(404);
    expect(
      (await repository.listAudit(operator)).length,
    ).toBeGreaterThanOrEqual(2);
  });
  it("denies customer mismatch and non-admin repository writes", async () => {
    expect(
      await repository.listProjects({
        ...manager,
        customerId: "10000000-0000-4000-8000-000000000099",
      }),
    ).toEqual([]);
    await expect(repository.setGrant(manager, grant, "denied")).rejects.toThrow(
      "denied",
    );
    await expect(
      repository.setGrant(
        { ...operator, customerId: "10000000-0000-4000-8000-000000000099" },
        grant,
        "wrong-customer",
      ),
    ).rejects.toThrow("Scope unavailable");
  });
  it("enforces immutable audit rows and stores encrypted credentials without plaintext", async () => {
    const record = await db.auditEvent.findFirstOrThrow();
    await expect(
      db.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"'),
    ).rejects.toThrow();
    await expect(
      db.auditEvent.update({
        where: { id: record.id },
        data: { event: "changed" },
      }),
    ).rejects.toThrow();
    await expect(
      db.auditEvent.delete({ where: { id: record.id } }),
    ).rejects.toThrow();
    const { CredentialVault } = await import(
      "../packages/platform/dist/index.js"
    );
    const vault = new CredentialVault(config.ENCRYPTION_KEY);
    const saved = await db.connectorCredential.create({
      data: {
        customerId,
        name: "synthetic",
        envelope: vault.encrypt("fixture-token", customerId + ":synthetic"),
        keyId: "local-v1",
      },
    });
    expect(saved.envelope).not.toContain("fixture-token");
    expect(vault.decrypt(saved.envelope, customerId + ":synthetic")).toBe(
      "fixture-token",
    );
  });
  it("restricts platform and audit endpoints and reports readiness", async () => {
    expect((await api("/platform", pmToken)).status).toBe(403);
    expect((await api("/audit", pmToken)).status).toBe(403);
    const platform = await api("/platform", opToken);
    expect(platform.status).toBe(200);
    expect(await platform.json()).toMatchObject({
      database: "connected",
      shadowMode: true,
    });
    expect((await api("/health/ready")).status).toBe(200);
  });
});
