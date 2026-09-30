// EXEC-015 Stage 2b; AC-UPD-007, FR-UPD-010, FR-ESC-006, NFR-REL-002 / NFR-SEC-001.
import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectUpdateRepository,
  DatabaseProjectFactRepository, DatabaseAuthorityRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.DATA_MODE !== "synthetic" || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Engagement checks require an isolated synthetic database");
const db = createDatabase(url);
afterAll(async () => { await db.$disconnect(); });

async function fixture() {
  const customerId = process.env.CUSTOMER_ID!;
  const portfolioId = randomUUID();
  const admin: Actor = { customerId, subject: "engagement-pmo-" + randomUUID(), roles: ["pmo_admin"] };
  const service = "engagement-service-" + randomUUID();
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic engagement processing" } });
  await db.accessGrant.create({ data: { customerId, subject: admin.subject,
    scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" } });
  const project = await new DatabaseCanonicalProjectRepository(db).createProject(
    admin, canonicalFixture(portfolioId), randomUUID(),
  );
  for (const [subject, role] of [["synthetic-owner-4", "contributor"], ["synthetic-owner-1", "project_manager"]])
    await db.accessGrant.create({ data: { customerId, subject, scopeType: "project", scopeId: project.id, role } });
  const zones = { customerId, customerTimeZone: "UTC", recipientTimeZones: [] };
  const updates = new DatabaseProjectUpdateRepository(db, service, zones);
  const change = { expectedRevision: 0, freshnessWindowSeconds: 2, timeZone: "UTC",
    requiredFacts: [{ factType: "project.status", label: "Current status" }, { factType: "project.forecast", label: "Current forecast" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: true,
    reminderBusinessDayOffsets: [1, 2], escalationAfterBusinessDays: 3,
    escalationRecipientSubject: "synthetic-owner-1", quietHoursStartLocal: null, quietHoursEndLocal: null };
  await updates.setPolicy(admin, project.id, change, randomUUID());
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const activate = () => updates.activateEngagement(admin, project.id, 1, randomUUID());
  const facts = new DatabaseProjectFactRepository(db);
  const authority = new DatabaseAuthorityRepository(db);
  const append = async (factType: string) => {
    const result = await facts.appendHumanStatement(admin, {
      projectId: project.id, factType, expectedRevision: 0, idempotencyKey: randomUUID(),
      effectiveAt: new Date().toISOString(), value: { type: "text", value: "Private synthetic value" },
      originalStatement: "Private synthetic statement",
    }, { correlationId: randomUUID() });
    await facts.setSourceAccess(admin, { projectId: project.id, sourceId: result.entry.sourceId,
      expectedRevision: result.entry.sourceAccessRevision, state: "AVAILABLE",
      readers: [admin.subject, service] }, { correlationId: randomUUID() });
    await authority.appendPolicy(admin, { projectId: project.id, factType,
      expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt: "2026-01-01T00:00:00.000Z",
      definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
        requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 31536000000 } }] }],
        conflictBehavior: "REQUEST_RECONCILIATION" },
    }, { correlationId: randomUUID() });
    return result;
  };
  return { admin, service, zones, projectId: project.id, updates, activate, append, facts, change };
}
const stages = (engagementId: string) => db.projectUpdateStage.findMany({ where: { engagementId } });
const outbox = async (engagementId: string) => {
  const ids = (await stages(engagementId)).map((stage) => stage.id);
  return db.projectUpdateOutbox.findMany({ where: { stageId: { in: ids } } });
};

it("activates server-selected stages idempotently and denies stale revisions or read-only actors", async () => {
  const f = await fixture();
  const first = (await f.activate())!;
  expect(first).toMatchObject({ mode: "SHADOW", stageCount: 5, configurationActions: [],
    remainingFactTypes: ["project.forecast", "project.status"] });
  expect((await f.activate())!.engagementId).toBe(first.engagementId);
  expect(await stages(first.engagementId)).toHaveLength(5);
  expect(await outbox(first.engagementId)).toHaveLength(5);
  expect(await db.projectUpdateDispatchAttempt.count({
    where: { outboxId: { in: (await outbox(first.engagementId)).map((row) => row.id) }, event: "ENQUEUED" },
  })).toBe(5);
  const before = await stages(first.engagementId);
  await expect(f.updates.activateEngagement(f.admin, f.projectId, 2, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(f.updates.activateEngagement({ ...f.admin, roles: ["leadership"] }, f.projectId, 1, randomUUID())).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(f.updates.activateEngagement({ ...f.admin, customerId: randomUUID() }, f.projectId, 1, randomUUID())).rejects.toMatchObject({ code: "DENIED" });
  expect(await stages(first.engagementId)).toEqual(before);
});

it("keeps owner stages when the configured PM loses current authorization", async () => {
  const f = await fixture();
  await db.accessGrant.deleteMany({ where: { projectId: f.projectId, subject: "synthetic-owner-1" } });
  const result = (await f.activate())!;
  expect(result.configurationActions).toEqual(["PM_RECIPIENT_REVOKED"]);
  expect(result.stageCount).toBe(4);
  expect((await stages(result.engagementId)).every((stage) => stage.recipientRole === "OWNER")).toBe(true);
});

it("commits refreshed partial satisfaction, future cancellation and linked replacements atomically", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  const prior = await stages(initial.engagementId);
  await f.append("project.status");
  await f.updates.assess(f.admin, f.projectId, randomUUID());
  const engagement = await db.projectUpdateEngagement.findUniqueOrThrow({ where: { id: initial.engagementId } });
  expect(engagement.obligationId).toBe(initial.obligationId);
  expect(engagement.sourceSatisfiedFactTypes).toEqual(["project.status"]);
  expect(engagement.sourceAssessmentId).not.toBe(engagement.assessmentId);
  const replaced = (await stages(initial.engagementId)).filter((stage) => stage.generation === 2);
  expect(replaced).toHaveLength(5);
  expect(replaced.every((stage) => stage.factTypes.join() === "project.forecast" && stage.replacesStageId !== null)).toBe(true);
  for (const original of prior) {
    expect(await db.projectUpdateStage.findUnique({ where: { id: original.id } })).toEqual(original);
    expect(await db.projectUpdateOutbox.findFirst({ where: { stageId: original.id } })).toMatchObject({
      state: "SUPPRESSED", reason: "REQUIRED_FACTS_SATISFIED", claimGeneration: 0,
    });
  }
  // Future rows were suppressed without moving their availability backward or
  // inventing a lease. Every transition has an automatic immutable receipt.
  expect(await db.projectUpdateDispatchAttempt.count({ where: {
    outboxId: { in: (await outbox(initial.engagementId)).filter((row) => row.state === "SUPPRESSED").map((row) => row.id) },
    event: "SUPPRESSED", claimGeneration: 0,
  } })).toBe(5);
});

it("closes the cycle and cancels future stages once every authorized fact is current", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  await f.append("project.status");
  await f.append("project.forecast");
  const assessment = await f.updates.assess(f.admin, f.projectId, randomUUID());
  expect(assessment.freshness.state).toBe("CURRENT");
  expect(assessment.obligation).toBeNull();
  expect(await db.projectUpdateEngagement.findUnique({ where: { id: initial.engagementId } })).toMatchObject({
    state: "CLOSED", sourceSatisfiedFactTypes: ["project.forecast", "project.status"],
  });
  expect((await outbox(initial.engagementId)).every((row) => row.state === "SUPPRESSED" && row.reason === "REQUIRED_FACTS_SATISFIED")).toBe(true);
});

it("processes SHADOW under the API role, records a fenced suppression, and performs no network call", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  const apiDb = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        return operation(tx);
      }, options as never),
  };
  const api = new DatabaseProjectUpdateRepository(apiDb as never, f.service, f.zones);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Outbound forbidden"));
  try {
    expect(await api.processShadowEngagements(1)).toBe(1);
    expect(await api.processShadowEngagements(1)).toBe(0);
    expect(network).not.toHaveBeenCalled();
    const ready = await outbox(initial.engagementId);
    expect(ready.filter((row) => row.state === "SUPPRESSED")).toHaveLength(1);
    const request = ready.find((row) => row.state === "SUPPRESSED")!;
    expect(request).toMatchObject({ reason: "SHADOW_MODE", claimGeneration: 1, handoffAt: null });
    expect((await db.projectUpdateDispatchAttempt.findMany({ where: { outboxId: request.id } }))
      .map((row) => row.event).sort()).toEqual(["CLAIMED", "ENQUEUED", "SUPPRESSED"]);
  } finally { network.mockRestore(); }
});

it("retains unresolved actions and creates a reasoned deferral after recipient or source revocation", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  await db.accessGrant.deleteMany({ where: { projectId: f.projectId, subject: "synthetic-owner-4" } });
  expect(await f.updates.processShadowEngagements(1)).toBe(1);
  expect((await outbox(initial.engagementId)).some((row) => row.state === "READY" && row.reason === "RECIPIENT_REVOKED")).toBe(true);
  await db.accessGrant.create({ data: { customerId: f.admin.customerId, subject: "synthetic-owner-4",
    scopeType: "project", scopeId: f.projectId, role: "contributor" } });
  const source = await f.append("project.status");
  await f.updates.assess(f.admin, f.projectId, randomUUID());
  await f.facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: source.entry.sourceId,
    expectedRevision: source.entry.sourceAccessRevision + 1, state: "REVOKED",
    readers: [] }, { correlationId: randomUUID() });
  await f.updates.assess(f.admin, f.projectId, randomUUID());
  expect(await db.projectUpdateEngagement.findUnique({ where: { id: initial.engagementId } })).toMatchObject({
    sourceSatisfiedFactTypes: [],
  });
  const current = (await stages(initial.engagementId)).filter((stage) => stage.generation === 3);
  expect(current.every((stage) => stage.factTypes.length === 2)).toBe(true);
  expect(await f.updates.processShadowEngagements(1)).toBe(1);
  expect((await outbox(initial.engagementId)).some((row) => row.reason === "SOURCE_UNKNOWN" && row.state === "READY")).toBe(true);
});

it("re-assesses policy edits and carries unresolved actions to the new immutable revision", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  await f.updates.setPolicy(f.admin, f.projectId, { ...f.change, expectedRevision: 1,
    reminderBusinessDayOffsets: [1, 2, 4] }, randomUUID());
  await f.updates.assess(f.admin, f.projectId, randomUUID());
  expect(await db.projectUpdateEngagement.findUnique({ where: { id: initial.engagementId } })).toMatchObject({ state: "CLOSED" });
  expect((await outbox(initial.engagementId)).every((row) => row.reason === "POLICY_CHANGED")).toBe(true);
  const successor = await db.projectUpdateEngagement.findFirstOrThrow({ where: { projectId: f.projectId, state: "ACTIVE" } });
  expect(successor.policyRevision).toBe(2);
  expect(successor.obligationId).not.toBe(initial.obligationId);
  expect(await stages(successor.id)).toHaveLength(6);
});

it("rolls back a crash between stage and intent, then activates without duplicate rows", async () => {
  const f = await fixture();
  const broken = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        const fault = new Proxy(tx, { get(target, key) {
          if (key === "$executeRawUnsafe") return async (sql: string, ...args: unknown[]) => {
            if (sql.startsWith('INSERT INTO public."ProjectUpdateOutbox"')) throw new Error("Synthetic precommit crash");
            return target.$executeRawUnsafe(sql, ...args);
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        } });
        return operation(fault);
      }, options as never),
  };
  await expect(new DatabaseProjectUpdateRepository(broken as never, f.service, f.zones)
    .activateEngagement(f.admin, f.projectId, 1, randomUUID())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await db.projectUpdateEngagement.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.projectUpdateStage.count({ where: { projectId: f.projectId } })).toBe(0);
  const attempts = await Promise.allSettled([f.activate(), f.activate()]);
  expect(attempts.some((result) => result.status === "fulfilled")).toBe(true);
  const result = (await f.activate())!;
  expect(await stages(result.engagementId)).toHaveLength(5);
  const processors = await Promise.allSettled([f.updates.processShadowEngagements(1), f.updates.processShadowEngagements(1)]);
  expect(processors.some((result) => result.status === "fulfilled")).toBe(true);
  expect(await db.projectUpdateDispatchAttempt.count({ where: {
    outboxId: { in: (await outbox(result.engagementId)).map((row) => row.id) }, event: "SUPPRESSED",
  } })).toBe(1);
});

it("replaces changed recipient zones explicitly and preserves previous snapshots", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  const prior = await stages(initial.engagementId);
  const changed = new DatabaseProjectUpdateRepository(db, f.service, { ...f.zones,
    recipientTimeZones: [{ subject: "synthetic-owner-4", timeZone: "Asia/Kolkata" }] });
  await changed.assess(f.admin, f.projectId, randomUUID());
  const next = (await stages(initial.engagementId)).filter((stage) => stage.generation === 2);
  expect(next).toHaveLength(4);
  expect(next.every((stage) => stage.timeZone === "Asia/Calcutta" || stage.timeZone === "Asia/Kolkata")).toBe(true);
  expect(next.every((stage) => stage.zoneSource === "RECIPIENT" && stage.replacesStageId !== null)).toBe(true);
  for (const stage of prior) expect(await db.projectUpdateStage.findUnique({ where: { id: stage.id } })).toEqual(stage);
  expect((await outbox(initial.engagementId)).filter((row) => row.reason === "RECIPIENT_ZONE_CHANGED")).toHaveLength(4);
});

it("rolls back a crash after claim without a durable handoff and safely retries", async () => {
  const f = await fixture();
  const initial = (await f.activate())!;
  const before = await outbox(initial.engagementId);
  const broken = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => operation(new Proxy(tx, { get(target, key) {
        if (key === "$executeRawUnsafe") return async (sql: string, ...args: unknown[]) => {
          if (sql.includes("SET state='SUPPRESSED'")) throw new Error("Synthetic precommit claim crash");
          return target.$executeRawUnsafe(sql, ...args);
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } })), options as never),
  };
  await expect(new DatabaseProjectUpdateRepository(broken as never, f.service, f.zones)
    .processShadowEngagements(1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(await outbox(initial.engagementId)).toEqual(before);
  expect(await db.projectUpdateDispatchAttempt.count({ where: {
    outboxId: { in: before.map((row) => row.id) }, event: "CLAIMED",
  } })).toBe(0);
  expect(await f.updates.processShadowEngagements(1)).toBe(1);
  const request = (await outbox(initial.engagementId)).find((row) => row.reason === "SHADOW_MODE")!;
  expect(request).toMatchObject({ claimGeneration: 1, handoffAt: null, state: "SUPPRESSED" });
});
