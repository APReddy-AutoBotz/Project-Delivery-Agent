import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, DatabaseIngestionRepository } from "../packages/data/src/index.js";
import { assertSyntheticDatabaseUrl, CredentialVault } from "../packages/platform/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL ?? "";
const target = assertSyntheticDatabaseUrl(url);
if (!/^\/pdaa_test_[0-9]+$/.test(target.pathname) || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic")
  throw new Error("Spreadsheet preparse tests require an isolated synthetic test database");
const db = createDatabase(url);
afterAll(() => db.$disconnect());

it("reauthorizes a detached spreadsheet configuration after simulated work", async () => {
  const customerId = randomUUID(), portfolioId = randomUUID(), sourceId = randomUUID();
  const projects = [randomUUID(), randomUUID()].sort();
  const admin: Actor = { customerId, subject: "preparse-admin", roles: ["pmo_admin"] };
  const manager: Actor = { customerId, subject: "preparse-manager", roles: ["project_manager"] };
  const portfolioManager: Actor = { customerId, subject: "preparse-portfolio", roles: ["portfolio_manager"] };
  await db.customer.create({ data: { id: customerId, name: "Synthetic preparse customer" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic preparse portfolio" } });
  for (const id of projects) {
    await db.project.create({ data: { id, customerId, portfolioId, code: "P-" + id,
      name: "Synthetic preparse project", description: "Synthetic", reportedStatus: "UNKNOWN" } });
    for (const principal of [admin, manager]) await db.accessGrant.create({ data: {
      customerId, subject: principal.subject, scopeType: "project", scopeId: id, role: principal.roles[0]!,
    } });
  }
  await db.accessGrant.create({ data: { customerId, subject: portfolioManager.subject,
    scopeType: "portfolio", scopeId: portfolioId, role: "portfolio_manager" } });
  const configuration = { binding: { customerId, sourceId, sourceType: "synthetic.sheet", origin: "https://sheet.example" },
    projects: projects.map((projectId) => ({ projectId, readers: [admin.subject, manager.subject, portfolioManager.subject] })),
    mapping: { kind: "CSV" as const, sheet: "Sheet", identityColumn: "Key", projectColumn: "Project",
      fields: [{ column: "Forecast", factType: "project.forecast", type: "date" as const, required: true }] } };
  const vault = new CredentialVault(Buffer.alloc(32, 17).toString("base64"));
  const setup = new DatabaseIngestionRepository(db, vault);
  await setup.configure(admin, configuration, "preparse-config");
  let failAudit = false;
  const roleDb = {
    $queryRaw: (sql: TemplateStringsArray, ...values: unknown[]) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRaw<{ role: string }[]>`SELECT current_user AS role`)[0]?.role).toBe("pdaa_api");
      return tx.$queryRaw(sql, ...values);
    }),
    $transaction: (fn: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      expect((await tx.$queryRaw<{ role: string }[]>`SELECT current_user AS role`)[0]?.role).toBe("pdaa_api");
      return fn(tx);
    }, options as never),
    auditEvent: { create: (args: unknown) => {
      if (failAudit) throw new Error("synthetic audit failure");
      return db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        expect((await tx.$queryRaw<{ role: string }[]>`SELECT current_user AS role`)[0]?.role).toBe("pdaa_api");
        return tx.auditEvent.create(args as never);
      });
    } },
  };
  const roleBound = new DatabaseIngestionRepository(roleDb as unknown as typeof db, vault);
  const tables = ["IngestionSource", "IngestionConfigurationRevision", "IngestionConfigurationProject",
    "IngestionConfigurationReader", "AccessGrant", "IngestionOperationReceipt", "AuditEvent"] as const;
  const snapshot = async () => Promise.all(tables.map((table) => db.$queryRawUnsafe<{ row: string }[]>(
    `SELECT to_jsonb(t)::text AS row FROM public."${table}" t WHERE "customerId"=$1::uuid ORDER BY row`, customerId)));
  const before = await snapshot();
  const first = await roleBound.prepareSpreadsheetParse(manager, sourceId, "preparse-first");
  expect(first.projectIds).toEqual(projects);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.projectIds)).toBe(true);
  await expect(roleBound.revalidateSpreadsheetParse(manager, sourceId, first, "preparse-again")).resolves.toBeUndefined();
  for (const principal of [admin, portfolioManager]) {
    const view = await roleBound.prepareSpreadsheetParse(principal, sourceId, "preparse-role");
    await expect(roleBound.revalidateSpreadsheetParse(principal, sourceId, view, "preparse-role-again")).resolves.toBeUndefined();
  }
  expect(await snapshot()).toEqual(before);
  await expect(roleBound.revalidateSpreadsheetParse(manager, sourceId, { ...first, projectIds: [...projects].reverse() }, "preparse-invalid"))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(roleBound.revalidateSpreadsheetParse(manager, sourceId, { ...first, projectIds: [projects[0], projects[0]] }, "preparse-duplicate"))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  let visited = false;
  const oversized = new Array(101);
  Object.defineProperty(oversized, 0, { get() { visited = true; throw new Error("unexpected traversal"); } });
  await expect(roleBound.revalidateSpreadsheetParse(manager, sourceId, { ...first, projectIds: oversized }, "preparse-oversized"))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(visited).toBe(false);
  // A matching plain object can be forged; this demonstrates a current-state
  // comparison only, not that the object came from an earlier preparation.
  await expect(roleBound.revalidateSpreadsheetParse(manager, sourceId, structuredClone(first), "preparse-forged"))
    .resolves.toBeUndefined();
  expect(await snapshot()).toEqual(before);
  const expectAuditedDenial = async (operation: () => Promise<unknown>, correlationId: string) => {
    const old = await snapshot();
    await expect(operation()).rejects.toMatchObject({ code: "DENIED" });
    const current = await snapshot();
    expect(current.slice(0, -1)).toEqual(old.slice(0, -1));
    const previousAudits = new Set(old.at(-1)!.map(({ row }) => row));
    const added = current.at(-1)!.filter(({ row }) => !previousAudits.has(row));
    expect(current.at(-1)!.length).toBe(previousAudits.size + 1);
    expect(added).toHaveLength(1);
    const event = JSON.parse(added[0]!.row) as { correlationId: string; event: string; detail: unknown };
    expect(event.correlationId).toBe(correlationId);
    expect(event.event).toBe("ingestion.operation.denied");
    expect(event.detail).toMatchObject({ reason: "DENIED" });
  };
  const wrongSubject = { ...manager, subject: "other-subject" };
  await expectAuditedDenial(() => roleBound.revalidateSpreadsheetParse(wrongSubject, sourceId, first, "preparse-denied"), "preparse-denied");
  const denial = await db.auditEvent.findMany({ where: { customerId, correlationId: "preparse-denied" } });
  expect(denial).toHaveLength(1);
  expect(denial[0]?.detail).toEqual({ operation: "spreadsheet_preparse_revalidate", reason: "DENIED" });
  expect((await snapshot()).slice(0, -1)).toEqual(before.slice(0, -1));
  await expectAuditedDenial(() => roleBound.revalidateSpreadsheetParse(manager, randomUUID(), first, "preparse-wrong-source"), "preparse-wrong-source");
  const otherCustomer = randomUUID();
  await db.customer.create({ data: { id: otherCustomer, name: "Synthetic other tenant" } });
  await expect(roleBound.revalidateSpreadsheetParse({ ...manager, customerId: otherCustomer }, sourceId, first, "preparse-wrong-tenant"))
    .rejects.toMatchObject({ code: "DENIED" });
  await db.accessGrant.deleteMany({ where: { customerId, subject: manager.subject, scopeId: projects[0] } });
  await expectAuditedDenial(() => roleBound.prepareSpreadsheetParse(manager, sourceId, "preparse-missing-grant"), "preparse-missing-grant");
  await expectAuditedDenial(() => roleBound.revalidateSpreadsheetParse(manager, sourceId, first, "preparse-revoked-grant"), "preparse-revoked-grant");
  await db.accessGrant.create({ data: { customerId, subject: manager.subject, scopeType: "project",
    scopeId: projects[0]!, role: "project_manager" } });
  await expect(roleBound.revalidateSpreadsheetParse(manager, sourceId, first, "preparse-restored-grant")).resolves.toBeUndefined();
  await expectAuditedDenial(() => roleBound.revalidateSpreadsheetParse({ ...manager, roles: ["pmo_admin"] }, sourceId, first, "preparse-role-downgrade"), "preparse-role-downgrade");
  for (const correlationId of ["preparse-wrong-source", "preparse-missing-grant", "preparse-revoked-grant", "preparse-role-downgrade"]) {
    const audit = await db.auditEvent.findMany({ where: { customerId, correlationId } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ reason: "DENIED" });
  }
  expect(await db.auditEvent.count({ where: { customerId: otherCustomer, correlationId: "preparse-wrong-tenant" } })).toBe(1);
  let simulatedWork = 0;
  const unauthorizedWork = async () => {
    await roleBound.prepareSpreadsheetParse(wrongSubject, sourceId, "preparse-no-work");
    simulatedWork++;
  };
  await expect(unauthorizedWork()).rejects.toMatchObject({ code: "DENIED" });
  expect(simulatedWork).toBe(0); // Test harness sequencing, not a production dispatcher.
  failAudit = true;
  const beforeAuditFailure = await snapshot();
  await expect(roleBound.revalidateSpreadsheetParse(wrongSubject, sourceId, first, "preparse-audit-fails"))
    .rejects.toMatchObject({ code: "PERSISTENCE_FAILED" });
  expect(await snapshot()).toEqual(beforeAuditFailure);
  failAudit = false;

  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const work = (async () => {
    const previous = await roleBound.prepareSpreadsheetParse(manager, sourceId, "preparse-before-work");
    started(); await gate;
    await roleBound.revalidateSpreadsheetParse(manager, sourceId, previous, "preparse-after-work");
  })();
  const workOutcome = work.then(() => null, (error: unknown) => error);
  let result: unknown;
  const boundedSetup = new DatabaseIngestionRepository({
    $transaction: (fn: (tx: unknown) => Promise<unknown>, options: Record<string, unknown>) =>
      db.$transaction(fn as never, { ...options, maxWait: 2000, timeout: 8000 } as never),
    auditEvent: db.auditEvent,
  } as unknown as typeof db, vault);
  try {
    await Promise.race([ready, workOutcome.then((error) => { throw error ?? new Error("work finished before its gate"); })]);
    // configure uses the repository's bounded transaction; it must finish while
    // the simulated work remains gated, demonstrating preflight released locks.
    await boundedSetup.configure(admin, { ...configuration, mapping: { ...configuration.mapping, sheet: "Revised" } }, "preparse-change");
  } finally { release(); result = await workOutcome; }
  expect(result).toMatchObject({ code: "STALE_CONFIGURATION" });
  const revised = await roleBound.prepareSpreadsheetParse(manager, sourceId, "preparse-revised");
  await setup.configure(admin, { ...configuration, projects: configuration.projects.map((project, index) =>
    index === 0 ? { ...project, readers: [] } : project) }, "preparse-remove-reader");
  await expectAuditedDenial(() => roleBound.revalidateSpreadsheetParse(manager, sourceId, revised, "preparse-reader-denied"), "preparse-reader-denied");
  await setup.configure(admin, { ...configuration, mapping: { kind: "CONNECTOR", factTypes: ["project.forecast"] } }, "preparse-connector");
  await expect(roleBound.prepareSpreadsheetParse(manager, sourceId, "preparse-wrong-kind"))
    .rejects.toMatchObject({ code: "INVALID_REQUEST" });
}, 120000);
