import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectRepository,
} from "../packages/data/dist/index.js";
import {
  loadConfig,
  IdentityService,
} from "../packages/platform/dist/index.js";
import { createApp } from "../apps/api/dist/app.js";
import {
  canonicalFixture,
  canonicalTables,
} from "../scripts/acceptance/canonical-projects.mjs";
import type { Actor } from "../packages/domain/src/index.js";
import type { Prisma } from "../packages/data/src/generated/prisma/client.js";
const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_\d+$/.test(new URL(url).pathname))
  throw new Error("Canonical integration requires isolated synthetic database");
const db = createDatabase(url),
  repository = new DatabaseCanonicalProjectRepository(db),
  config = loadConfig(process.env);
const customerId = config.CUSTOMER_ID,
  portfolioId = randomUUID();
const pmo: Actor = {
  customerId,
  subject: "canonical-pmo-" + randomUUID(),
  roles: ["pmo_admin"],
};
const manager: Actor = {
  customerId,
  subject: "canonical-manager-" + randomUUID(),
  roles: ["portfolio_manager"],
};
let app: Awaited<ReturnType<typeof createApp>>["app"],
  base: string,
  projectId: string,
  programmeId: string;
const grant = async (
  actor: Actor,
  scopeId = portfolioId,
  role = actor.roles[0]!,
  scopeType = "portfolio",
) =>
  db.accessGrant.create({
    data: {
      customerId: actor.customerId,
      subject: actor.subject,
      scopeType,
      scopeId,
      role,
    },
  });
const token = (actor: Actor) =>
  new SignJWT({ roles: actor.roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.subject)
    .setIssuer("pdaa:local")
    .setAudience("pdaa:api")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(config.SESSION_SECRET));
async function api(
  actor: Actor | null,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const bearer = actor ? await token(actor) : null;
  return fetch(base + "/api" + path, {
    method,
    headers: {
      ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeAll(async () => {
  await db.portfolio.create({
    data: {
      id: portfolioId,
      customerId,
      name: "Canonical synthetic portfolio",
    },
  });
  await grant(pmo);
  await grant(manager);
  ({ app } = await createApp(
    config,
    new DatabaseProjectRepository(db),
    undefined,
    repository,
  ));
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});
it("INT-MOD-001: HTTP programme and full project creation retrieve persisted typed hierarchy", async () => {
  const programme = await api(
    pmo,
    "/portfolios/" + portfolioId + "/programmes",
    "POST",
    { code: "PROG", name: "Synthetic programme", idempotencyKey: randomUUID() },
  );
  expect(programme.status).toBe(201);
  programmeId = (await programme.json()).id;
  const payload = canonicalFixture(portfolioId, programmeId);
  const created = await api(manager, "/projects", "POST", payload);
  expect(created.status).toBe(201);
  projectId = (await created.json()).id;
  const response = await api(manager, "/projects/" + projectId + "/canonical");
  expect(response.status).toBe(200);
  const detail = await response.json();
  expect(detail).toMatchObject({
    id: projectId,
    configured: true,
    programme: { id: programmeId },
    dates: payload.dates,
    reportedStatus: "GREEN",
    sourceMappingsWithheld: false,
    creation: { by: manager.subject, revision: 1 },
  });
  expect(detail.workItems[0].sprintKey).toBe("SPR-1");
  expect(detail.requiredWorkItems).toEqual(payload.requiredWorkItems);
  expect(detail.responsibilities).toHaveLength(5);
  expect(detail.raidItems.map((r: { kind: string }) => r.kind).sort()).toEqual(
    payload.raidItems.map((r) => r.kind).sort(),
  );
  expect(detail.sourceMappings).toHaveLength(5);
  const replay = await api(manager, "/projects", "POST", payload);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ id: projectId });
  expect(
    await db.auditEvent.count({
      where: { event: "project.created", actor: manager.subject },
    }),
  ).toBe(1);
  const conflict = await api(manager, "/projects", "POST", {
    ...payload,
    name: "changed",
  });
  expect(conflict.status).toBe(409);
  expect(JSON.stringify(await conflict.json())).not.toContain("changed");
});
it("new detail denies absent, mismatched, operational, contributor and project-only creation authority", async () => {
  for (const [roles, grantRole, scopeType] of [
    [[], "pmo_admin", "portfolio"],
    [["system_admin"], "system_admin", "portfolio"],
    [["contributor"], "contributor", "portfolio"],
    [["pmo_admin"], "leadership", "portfolio"],
    [["project_manager"], "project_manager", "project"],
  ] as const) {
    const actor: Actor = { ...pmo, subject: randomUUID(), roles: [...roles] };
    await grant(
      actor,
      scopeType === "project" ? projectId : portfolioId,
      grantRole,
      scopeType,
    );
    expect(
      (await api(actor, "/projects", "POST", canonicalFixture(portfolioId)))
        .status,
    ).toBe(404);
    if (scopeType !== "project")
      expect(
        (await api(actor, "/projects/" + projectId + "/canonical")).status,
      ).toBe(404);
  }
  expect(
    (await api(null, "/projects/" + projectId + "/canonical")).status,
  ).toBe(401);
});
it("ordinary permitted canonical readers receive no mapping identifiers or URLs", async () => {
  const reader: Actor = {
    ...pmo,
    subject: randomUUID(),
    roles: ["leadership"],
  };
  await grant(reader, projectId, "leadership", "project");
  const detail = await repository.detail(reader, projectId);
  expect(detail.sourceMappings).toEqual([]);
  expect(detail.sourceMappingsWithheld).toBe(true);
  expect(JSON.stringify(detail)).not.toContain("tracker.example.test");
  expect((await repository.setup(reader)).portfolios).toEqual([]);
});
it("revocation reauthorizes read, setup and idempotent replay", async () => {
  const actor: Actor = { ...pmo, subject: randomUUID() };
  await grant(actor);
  const value = canonicalFixture(portfolioId);
  const created = await repository.createProject(actor, value, randomUUID());
  await db.accessGrant.deleteMany({
    where: { customerId, subject: actor.subject },
  });
  await expect(repository.detail(actor, created.id)).rejects.toMatchObject({
    code: "DENIED",
  });
  await expect(
    repository.createProject(actor, value, randomUUID()),
  ).rejects.toMatchObject({ code: "DENIED" });
  expect((await repository.setup(actor)).portfolios).toEqual([]);
});
it("foreign programme/customer/portfolio cannot reparent a new project", async () => {
  const other = randomUUID();
  await db.portfolio.create({
    data: { id: other, customerId, name: "Other portfolio" },
  });
  await grant(pmo, other);
  await expect(
    repository.createProject(
      pmo,
      canonicalFixture(other, programmeId),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "DENIED" });
  await expect(
    repository.createProject(manager, canonicalFixture(other), randomUUID()),
  ).rejects.toMatchObject({ code: "DENIED" });
  await expect(
    repository.detail({ ...pmo, customerId: randomUUID() }, projectId),
  ).rejects.toMatchObject({ code: "DENIED" });
});
it("concurrent retries create one aggregate; duplicate code and shared external identities roll back atomically", async () => {
  const value = canonicalFixture(portfolioId);
  const result = await Promise.all([
    repository.createProject(pmo, value, randomUUID()),
    repository.createProject(pmo, value, randomUUID()),
  ]);
  expect(result[0]).toEqual(result[1]);
  const before = await db.project.count();
  for (const data of [
    { ...canonicalFixture(portfolioId), code: value.code },
    { ...canonicalFixture(portfolioId), sourceMappings: value.sourceMappings },
  ])
    await expect(
      repository.createProject(pmo, data, randomUUID()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await db.project.count()).toBe(before);
});
it("programme replay is stable and operation collisions cannot replay a project", async () => {
  const input = {
    code: "REPLAY",
    name: "Replay programme",
    idempotencyKey: randomUUID(),
  };
  const first = await repository.createProgramme(
    pmo,
    portfolioId,
    input,
    randomUUID(),
  );
  expect(
    await repository.createProgramme(pmo, portfolioId, input, randomUUID()),
  ).toEqual(first);
  await expect(
    repository.createProject(
      pmo,
      {
        ...canonicalFixture(portfolioId),
        idempotencyKey: input.idempotencyKey,
      },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("legacy detail retains original summary and unknown canonical fields", async () => {
  const id = randomUUID();
  await db.project.create({
    data: {
      id,
      customerId,
      portfolioId,
      code: "LEG-" + id,
      name: "Legacy",
      description: "retained",
      reportedStatus: "legacy unchanged",
    },
  });
  const detail = await repository.detail(pmo, id);
  expect(detail.configured).toBe(false);
  expect(detail.creation).toBe(null);
  expect(Object.values(detail.dates).every((v) => v === null)).toBe(true);
  expect(detail.reportedStatus).toBe("legacy unchanged");
});
it("complete aggregates reject SQL update/delete/truncate and post-seal inserts", async () => {
  for (const table of canonicalTables) {
    await expect(
      db.$executeRawUnsafe(`UPDATE "${table}" SET id=id`),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(`DELETE FROM "${table}"`),
    ).rejects.toThrow();
    await expect(
      db.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`),
    ).rejects.toThrow();
  }
  await expect(
    db.project.update({ where: { id: projectId }, data: { name: "tampered" } }),
  ).rejects.toThrow();
  await expect(
    db.sprint.create({
      data: {
        id: randomUUID(),
        customerId,
        projectId,
        key: "LATE",
        name: "Late insert",
      },
    }),
  ).rejects.toThrow();
});
async function draftProject(
  tx: Prisma.TransactionClient,
  id: string,
  sprintsCount = 0,
) {
  await tx.project.create({
    data: {
      id,
      customerId,
      portfolioId,
      code: "DRAFT-" + id,
      name: "Draft invariant probe",
      description: "",
      reportedStatus: "UNKNOWN",
    },
  });
  await tx.canonicalProject.create({
    data: {
      id,
      customerId,
      portfolioId,
      createdBy: pmo.subject,
      responsibilitiesCount: 0,
      sprintsCount,
      milestonesCount: 0,
      workItemsCount: 0,
      requiredWorkItemsCount: 0,
      raidItemsCount: 0,
      sourceMappingsCount: 0,
    },
  });
  await tx.canonicalCreationReceipt.create({
    data: {
      id: randomUUID(),
      customerId,
      portfolioId,
      subject: pmo.subject,
      idempotencyKey: randomUUID(),
      operation: "PROJECT",
      requestHash: "0".repeat(64),
      projectId: id,
    },
  });
}
it("unsealed aggregates reject relations to another project's children at INSERT", async () => {
  const sprint = await db.sprint.findFirstOrThrow({ where: { projectId } });
  const work = await db.workItem.findFirstOrThrow({ where: { projectId } });
  const milestone = await db.milestone.findFirstOrThrow({
    where: { projectId },
  });
  const insertions = [
    (tx: Prisma.TransactionClient, id: string) =>
      tx.workItem.create({
        data: {
          id: randomUUID(),
          customerId,
          projectId: id,
          key: "WI",
          title: "Cross-project sprint",
          state: "OPEN",
          sprintId: sprint.id,
        },
      }),
    (tx: Prisma.TransactionClient, id: string) =>
      tx.requiredWorkItem.create({
        data: {
          id: randomUUID(),
          customerId,
          projectId: id,
          milestoneId: milestone.id,
          workItemId: work.id,
        },
      }),
    (tx: Prisma.TransactionClient, id: string) =>
      tx.canonicalSourceMapping.create({
        data: {
          id: randomUUID(),
          customerId,
          projectId: id,
          sourceSystem: "Synthetic",
          instanceKey: "test",
          externalType: "item",
          externalId: randomUUID(),
          targetType: "WORK_ITEM",
          workItemId: work.id,
        },
      }),
  ];
  for (const insert of insertions) {
    const id = randomUUID();
    await expect(
      db.$transaction(async (tx) => {
        await draftProject(tx, id);
        await insert(tx, id);
        throw new Error("Cross-project INSERT unexpectedly succeeded");
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(await db.project.findUnique({ where: { id } })).toBe(null);
  }
});
it("sealing refuses declared children that have not been inserted", async () => {
  const id = randomUUID();
  await expect(
    db.$transaction(async (tx) => {
      await draftProject(tx, id, 1);
      await tx.canonicalProject.update({
        where: { id },
        data: { sealed: true },
      });
      throw new Error("Incomplete collection unexpectedly sealed");
    }),
  ).rejects.not.toThrow("Incomplete collection unexpectedly sealed");
  expect(await db.project.findUnique({ where: { id } })).toBe(null);
});
it("COMMIT rejects an unsealed receipted project and programme without a receipt", async () => {
  await expect(
    db.$transaction(async (tx) => {
      await tx.programme.create({
        data: {
          id: randomUUID(),
          customerId,
          portfolioId,
          code: "UNCOMMITTED",
          name: "Missing receipt",
          createdBy: pmo.subject,
        },
      });
    }),
  ).rejects.toThrow();
  const id = randomUUID();
  await expect(
    db.$transaction(async (tx) => {
      await draftProject(tx, id);
    }),
  ).rejects.toThrow();
  expect(await db.project.findUnique({ where: { id } })).toBe(null);
});
it("audit and error responses omit sensitive project payloads", async () => {
  const rows = await db.auditEvent.findMany({
    where: { event: { in: ["programme.created", "project.created"] } },
  });
  for (const row of rows) {
    expect(JSON.stringify(row.detail)).not.toContain("Synthetic");
    expect(JSON.stringify(row.detail)).not.toContain("tracker.example.test");
  }
  const invalid = await api(pmo, "/projects", "POST", {
    ...canonicalFixture(portfolioId),
    createdBy: "SECRET-REJECT",
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("SECRET-REJECT");
});
it("configured sixth OIDC role authorizes only matching current scope; remapping the same token denies access", async () => {
  const pair = await generateKeyPair("RS256");
  const common = {
    ...process.env,
    AUTH_MODE: "oidc",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_JWKS_URI: "https://identity.example.test/keys",
    OIDC_AUDIENCE: "pdaa",
    OIDC_CLIENT_ID: "web",
  };
  const signed = await new SignJWT({
    groups: ["portfolio-group"],
    roles: ["pmo_admin"],
  })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(manager.subject)
    .setIssuer(common.OIDC_ISSUER)
    .setAudience("pdaa")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(pair.privateKey);
  const mapped = new IdentityService(
    loadConfig({
      ...common,
      OIDC_GROUP_ROLE_MAP: JSON.stringify({
        "portfolio-group": ["portfolio_manager"],
      }),
    }),
    async () => pair.publicKey,
  );
  const unmapped = new IdentityService(
    loadConfig({ ...common, OIDC_GROUP_ROLE_MAP: "{}" }),
    async () => pair.publicKey,
  );
  const actor = await mapped.authenticate(signed);
  expect(actor.roles).toEqual(["portfolio_manager"]);
  expect((await repository.detail(actor, projectId)).id).toBe(projectId);
  await expect(
    repository.detail(await unmapped.authenticate(signed), projectId),
  ).rejects.toMatchObject({ code: "DENIED" });
});
