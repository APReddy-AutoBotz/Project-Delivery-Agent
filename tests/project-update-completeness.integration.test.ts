// EXEC-018 / FR-HLT-002 / AC-HLT-002: real authority-to-completeness wiring.
import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectUpdateRepository,
  DatabaseProjectFactRepository, DatabaseAuthorityRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
    !["localhost", "127.0.0.1"].includes(new URL(url).hostname) ||
    !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Completeness checks require an isolated synthetic database");
const db = createDatabase(url);
afterAll(async () => { await db.$disconnect(); });

// Set only birth timestamps through real creation transactions. Never update
// immutable history or mock authority selection, permissions or the evaluator.
function birthDatabase(bornAt: Date) {
  return {
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => operation(new Proxy(tx, { get(target, key) {
        if (key === "canonicalProject") return new Proxy(target.canonicalProject, { get(delegate, method) {
          if (method === "create") return (args: Parameters<typeof delegate.create>[0]) =>
            delegate.create({ ...args, data: { ...args.data, createdAt: bornAt } });
          const value = Reflect.get(delegate, method);
          return typeof value === "function" ? value.bind(delegate) : value;
        } });
        if (key === "factEvidence") return new Proxy(target.factEvidence, { get(delegate, method) {
          if (method === "create") return (args: Parameters<typeof delegate.create>[0]) =>
            delegate.create({ ...args, data: { ...args.data, observedAt: bornAt } });
          const value = Reflect.get(delegate, method);
          return typeof value === "function" ? value.bind(delegate) : value;
        } });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } })), options as never),
  };
}

async function fixture() {
  const customerId = process.env.CUSTOMER_ID!;
  const portfolioId = randomUUID();
  const admin: Actor = { customerId, subject: "completeness-pmo-" + randomUUID(), roles: ["pmo_admin"] };
  const writer: Actor = { customerId, subject: "completeness-writer-" + randomUUID(), roles: ["project_manager"] };
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Completeness fixture" } });
  for (const actor of [admin, writer]) await db.accessGrant.create({ data: {
    customerId, subject: actor.subject, scopeType: "portfolio", scopeId: portfolioId, role: actor.roles[0]!,
  } });
  const bornAt = new Date(Date.now() - 86_400_000);
  const birth = birthDatabase(bornAt);
  const project = await new DatabaseCanonicalProjectRepository(birth as never).createProject(
    admin, canonicalFixture(portfolioId), randomUUID(),
  );
  const updates = new DatabaseProjectUpdateRepository(db);
  const facts = new DatabaseProjectFactRepository(birth as never);
  const authority = new DatabaseAuthorityRepository(db);
  const factType = "project.status";
  await updates.setPolicy(admin, project.id, {
    expectedRevision: 0, freshnessWindowSeconds: 1, timeZone: "UTC",
    requiredFacts: [{ factType, label: "Current status" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false,
    reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
    escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
  }, randomUUID());
  const append = async (actor = admin, readers = [admin.subject], value = "Private completeness value") => {
    const fact = await db.projectFact.findFirst({ where: { customerId, projectId: project.id, factType } });
    const result = await facts.appendHumanStatement(actor, {
      projectId: project.id, factType, expectedRevision: fact?.revision ?? 0,
      idempotencyKey: randomUUID(), effectiveAt: bornAt.toISOString(),
      value: { type: "text", value }, originalStatement: "Private completeness statement",
    }, { correlationId: randomUUID() });
    await facts.setSourceAccess(admin, {
      projectId: project.id, sourceId: result.entry.sourceId,
      expectedRevision: result.entry.sourceAccessRevision, state: "AVAILABLE", readers,
    }, { correlationId: randomUUID() });
    return result;
  };
  const policy = async (durationMs: number, expectedRevision = 0) => authority.appendPolicy(admin, {
    projectId: project.id, factType, expectedRevision, idempotencyKey: randomUUID(),
    effectiveAt: bornAt.toISOString(), definition: {
      tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
        requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs } }] }],
      conflictBehavior: "REQUEST_RECONCILIATION",
    },
  }, { correlationId: randomUUID() });
  const assess = () => updates.assess(admin, project.id, randomUUID());
  return { customerId, projectId: project.id, admin, writer, facts, updates, append, policy, assess, factType };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function assertUnresolved(f: Fixture, count: number, reason: string, status: string) {
  const view = await f.assess();
  expect(view.completeness.factAssessments).toEqual([expect.objectContaining({
    factType: f.factType, state: "UNCONFIRMED", canonicalVersionCount: count,
    sourceAuthorityStatus: status, reasonCodes: expect.arrayContaining([reason]),
  })]);
  expect(view.freshness).toMatchObject({ state: "STALE", sourceDateField: "project.createdAt" });
  expect(view.knownPosition).toEqual([]);
  expect(view.obligation?.state).toBe("OPEN");
  expect(view.preview?.requiredFacts).toEqual([expect.objectContaining({ state: "UNCONFIRMED" })]);
  expect(view.preview?.evidence).toEqual([]);
  expect(JSON.stringify(view)).not.toMatch(/Private completeness/);
  const saved = await db.projectUpdateAssessment.findFirstOrThrow({
    where: { customerId: f.customerId, projectId: f.projectId }, orderBy: [{ assessedAt: "desc" }, { id: "desc" }],
  });
  expect(saved.result).toMatchObject({ completeness: view.completeness });
  expect(saved.input).toMatchObject({ latestValidUpdateAt: null, timestampBasis: "UNCONFIRMED" });
  expect(saved.result).toMatchObject({ engagementFacts: [expect.objectContaining({ state: "UNRESOLVED" })] });
  expect((await f.updates.latest(f.admin, f.projectId))?.completeness).toEqual(view.completeness);
  const repeated = await f.assess();
  expect(repeated.obligation?.id).toBe(view.obligation?.id);
  expect(await db.projectUpdateObligation.count({ where: {
    customerId: f.customerId, projectId: f.projectId, state: "OPEN",
  } })).toBe(1);
  return view;
}

it("keeps existing readable evidence without policy unconfirmed instead of missing", async () => {
  const f = await fixture();
  await f.append();
  await assertUnresolved(f, 1, "NO_APPLICABLE_AUTHORITY_POLICY", "NO_POLICY");
});

it("keeps expired readable evidence unconfirmed without freshness or satisfaction credit", async () => {
  const f = await fixture();
  await f.append();
  await f.policy(1000);
  await assertUnresolved(f, 1, "NO_CURRENT_AUTHORIZED_VALUE", "UNKNOWN");
});

it("counts no restricted-only evidence and preserves source revalidation", async () => {
  const f = await fixture();
  const statement = await f.append(f.writer, [f.writer.subject]);
  const view = await assertUnresolved(f, 0, "SOURCE_REVALIDATION_REQUIRED", "REVALIDATION_REQUIRED");
  expect(JSON.stringify(view)).not.toContain(statement.entry.sourceId);
  expect(JSON.stringify(view)).not.toContain(statement.entry.id);
});

it("counts only the readable part of mixed readable and restricted evidence", async () => {
  const f = await fixture();
  await f.append();
  const hidden = await f.append(f.writer, [f.writer.subject], "Different private completeness value");
  const view = await assertUnresolved(f, 1, "SOURCE_REVALIDATION_REQUIRED", "REVALIDATION_REQUIRED");
  expect(JSON.stringify(view)).not.toContain(hidden.entry.sourceId);
  expect(JSON.stringify(view)).not.toContain(hidden.entry.id);
});

it("retains an expired recorded conflict without inventing zero-count authority input", async () => {
  const f = await fixture();
  await f.append();
  await f.append(f.writer, [f.admin.subject, f.writer.subject], "Different private completeness value");
  await f.policy(31_536_000_000);
  const initial = await f.assess();
  expect(initial.completeness.factAssessments[0]).toMatchObject({
    state: "UNCONFIRMED", canonicalVersionCount: 2, conflict: "CONFLICTING",
  });
  expect(await db.factAuthorityConflict.count({ where: {
    customerId: f.customerId, projectId: f.projectId,
  } })).toBeGreaterThan(0);
  await f.policy(1000, 1);
  const view = await assertUnresolved(f, 2, "CONFLICTING_AUTHORITY", "CONFLICTING");
  expect(view.completeness.factAssessments[0]?.conflict).toBe("CONFLICTING");
});

it("keeps historical metadata immutable after revocation while a new assessment excludes the evidence", async () => {
  const f = await fixture();
  const statement = await f.append();
  await f.policy(31_536_000_000);
  const initial = await f.assess();
  expect(initial.completeness.factAssessments[0]).toMatchObject({ state: "CONFIRMED", canonicalVersionCount: 1 });
  expect(initial.knownPosition).toHaveLength(1);
  const before = await db.projectUpdateAssessment.findFirstOrThrow({
    where: { customerId: f.customerId, projectId: f.projectId },
  });
  const access = await f.facts.getSourceAccess(f.admin, {
    projectId: f.projectId, sourceId: statement.entry.sourceId,
  });
  if (!access) throw new Error("Expected source access fixture");
  await f.facts.setSourceAccess(f.admin, {
    projectId: f.projectId, sourceId: statement.entry.sourceId, expectedRevision: access.revision,
    state: "AVAILABLE", readers: [f.writer.subject],
  }, { correlationId: randomUUID() });
  const historical = await f.updates.latest(f.admin, f.projectId);
  expect(historical?.completeness).toEqual(initial.completeness);
  expect(historical?.knownPosition).toEqual([]);
  expect(historical?.preview?.evidence).toEqual([]);
  expect(JSON.stringify(historical)).not.toMatch(/Private completeness/);
  expect(JSON.stringify(historical)).not.toContain(statement.entry.sourceId);
  await assertUnresolved(f, 0, "SOURCE_REVALIDATION_REQUIRED", "REVALIDATION_REQUIRED");
  expect(await db.projectUpdateAssessment.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
});

it("keeps a defined but empty fact and an absent fact missing", async () => {
  const f = await fixture();
  // Creating only a canonical fact definition adds no evidence or value version.
  await db.projectFact.create({ data: {
    id: randomUUID(), customerId: f.customerId, projectId: f.projectId,
    factType: f.factType, revision: 0,
  } });
  const view = await f.assess();
  expect(view.completeness.factAssessments[0]).toMatchObject({
    state: "MISSING", canonicalVersionCount: 0, reasonCodes: ["NO_CANONICAL_VALUE"],
  });
  const absent = await fixture();
  expect((await absent.assess()).completeness.factAssessments[0]).toMatchObject({
    state: "MISSING", canonicalVersionCount: 0, reasonCodes: ["NO_CANONICAL_VALUE"],
  });
});

it("denies project and unconfigured service identities without assessment or obligation writes", async () => {
  const f = await fixture();
  await f.append();
  const outsider: Actor = { customerId: f.customerId, subject: "outside-" + randomUUID(), roles: ["pmo_admin"] };
  await expect(f.updates.assess(outsider, f.projectId, randomUUID())).rejects.toMatchObject({ code: "DENIED" });
  await expect(f.updates.scanScheduledProjects(1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await db.projectUpdateAssessment.count({ where: { customerId: f.customerId, projectId: f.projectId } })).toBe(0);
  expect(await db.projectUpdateObligation.count({ where: { customerId: f.customerId, projectId: f.projectId } })).toBe(0);
});
