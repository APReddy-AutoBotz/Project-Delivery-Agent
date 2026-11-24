import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseHealthAssessmentRepository,
  DatabaseProjectFactRepository,
  DatabaseProjectUpdateRepository,
} from "../packages/data/dist/index.js";
import {
  assessDeliveryHealth,
  type Actor,
  type AuthorityDefinition,
} from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL;
const target = url ? new URL(url) : null;
if (!url || !target || !["127.0.0.1", "localhost"].includes(target.hostname) ||
  !/^\/pdaa_test_[0-9]+$/.test(target.pathname))
  throw new Error("Delivery concern tests require an isolated database");
const db = createDatabase(url);
const canonical = new DatabaseCanonicalProjectRepository(db);
const updates = new DatabaseProjectUpdateRepository(db);
const facts = new DatabaseProjectFactRepository(db);
const authority = new DatabaseAuthorityRepository(db);
const health = new DatabaseHealthAssessmentRepository(db);
afterAll(async () => db.$disconnect());

it("saves and replays a same-project concern with a frozen scoped policy and rechecks all proof access", async () => {
  const customerId = randomUUID();
  const portfolioId = randomUUID();
  const admin: Actor = { customerId, subject: "concern-admin-" + randomUUID(), roles: ["pmo_admin"] };
  const pm: Actor = { customerId, subject: "concern-pm-" + randomUUID(), roles: ["project_manager"] };
  await db.customer.create({ data: { id: customerId, name: "Synthetic concern customer" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic concern portfolio" } });
  await db.accessGrant.createMany({ data: [
    { customerId, subject: admin.subject, role: "pmo_admin", scopeType: "portfolio", scopeId: portfolioId },
    { customerId, subject: pm.subject, role: "project_manager", scopeType: "portfolio", scopeId: portfolioId },
  ] });
  const payload = canonicalFixture(portfolioId);
  payload.raidItems = payload.raidItems.map((item, index) => ({
    ...item, state: index < 2 ? "OPEN" : "COMPLETE",
  }));
  const project = await canonical.createProject(admin, payload, randomUUID());
  const projectId = project.id;
  const other = await canonical.createProject(admin, canonicalFixture(portfolioId), randomUUID());
  const [milestone, strayMilestone, raids] = await Promise.all([
    db.milestone.findFirstOrThrow({ where: { customerId, projectId } }),
    db.milestone.findFirstOrThrow({ where: { customerId, projectId: other.id } }),
    db.raidItem.findMany({ where: { customerId, projectId }, orderBy: { key: "asc" } }),
  ]);
  const [young, older, closed] = raids;
  if (!young || !older || !closed) throw new Error("Synthetic fixtures missing");
  expect([young.state, older.state, closed.state]).toEqual(["OPEN", "OPEN", "COMPLETE"]);
  const criticalTargets = { milestoneIds: [milestone.id], raidItemIds: [young.id, closed.id].sort() };
  const schedule = {
    expectedRevision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [],
  };
  await expect(health.setScheduleHealthPolicy(
    { ...pm, roles: ["project_manager", "pmo_admin"] }, projectId,
    { ...schedule, criticalTargets }, randomUUID(),
  )).rejects.toMatchObject({ code: "DENIED" });
  await expect(health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, criticalTargets: { ...criticalTargets, milestoneIds: [strayMilestone.id] } }, randomUUID(),
  )).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  await expect(health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, criticalTargets: { ...criticalTargets, raidItemIds: [milestone.id] } }, randomUUID(),
  )).rejects.toMatchObject({ code: "INVALID_REQUEST" });

  await health.setRetention(admin, {
    contentRetentionHours: 24, auditRetentionHours: 48, idempotencyRetentionHours: 72,
  }, randomUUID());
  const initialThreshold = await health.blockerAgeThresholdPolicy(admin);
  const threshold = await health.setBlockerAgeThresholdPolicy(admin, {
    expectedRevision: initialThreshold?.revision ?? 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720,
  }, randomUUID());
  const now = await db.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
  const effectiveAt = new Date(now[0]!.now.getTime() - 60_000).toISOString();
  const current: AuthorityDefinition = {
    tiers: [{ selectors: [{
      sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
      validity: { basis: "observedAt", durationMs: 86_400_000 },
    }] }],
    conflictBehavior: "REQUEST_RECONCILIATION",
  };
  const period: AuthorityDefinition = {
    ...current,
    tiers: [{ selectors: [{
      sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
      validity: { mode: "UNTIL_SUPERSEDED" },
    }] }],
  };
  const mark = { correlationId: "story015-native-concern" };
  async function publish(factType: string, value: { type: "text" | "date"; value: string } | { type: "boolean"; value: boolean }, definition = current) {
    await authority.appendPolicy(admin, {
      projectId, factType, idempotencyKey: randomUUID(), expectedRevision: 0, effectiveAt, definition,
    }, mark);
    const evidence = await facts.appendHumanStatement(admin, {
      projectId, factType, idempotencyKey: randomUUID(), expectedRevision: 0, effectiveAt, value,
      validUntil: null, originalStatement: "Synthetic scoped delivery evidence.",
    }, mark);
    const access = await facts.setSourceAccess(admin, {
      projectId, sourceId: evidence.entry.sourceId, expectedRevision: evidence.entry.sourceAccessRevision,
      state: "AVAILABLE", readers: [admin.subject, pm.subject],
    }, mark);
    return { entry: evidence.entry, access };
  }
  const updateType = "project.forecast";
  const update = await publish(updateType, { type: "text", value: "Synthetic forecast" });
  const alternative = await facts.appendHumanStatement(pm, {
    projectId, factType: updateType, idempotencyKey: randomUUID(), expectedRevision: 1, effectiveAt,
    value: { type: "text", value: "Synthetic secondary forecast" },
    validUntil: null, originalStatement: "Synthetic fallback forecast support.",
  }, mark);
  const fallbackAccess = await facts.setSourceAccess(admin, {
    projectId, sourceId: alternative.entry.sourceId, expectedRevision: alternative.entry.sourceAccessRevision,
    state: "AVAILABLE", readers: [admin.subject, pm.subject],
  }, mark);
  const selector = current.tiers[0]!.selectors[0]!;
  await authority.appendPolicy(admin, {
    projectId, factType: updateType, idempotencyKey: randomUUID(), expectedRevision: 1,
    effectiveAt: new Date(Date.parse(effectiveAt) + 1000).toISOString(),
    definition: {
      ...current,
      tiers: [update.entry.sourceId, alternative.entry.sourceId].map((instanceId) => ({
        selectors: [{ ...selector, instanceId }],
      })),
    },
  }, mark);
  const cadenceFields = {
    timeZone: "Asia/Kolkata",
    requiredFacts: [{ factType: updateType, label: "Current forecast" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false,
    reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0, escalationRecipientSubject: null,
    quietHoursStartLocal: null, quietHoursEndLocal: null,
  };
  const youngClassification = await publish("raid_item." + young.id + ".blocks_delivery", { type: "boolean", value: true });
  await publish("raid_item." + older.id + ".blocks_delivery", { type: "boolean", value: true });
  await publish("raid_item." + young.id + ".opened_at", {
    type: "date", value: now[0]!.now.toISOString().slice(0, 10),
  }, period);
  const before = await health.create(pm, projectId, "before-concern", randomUUID());
  expect(before.coverage).toBe("SCHEDULE_AND_BLOCKER_AGE");
  expect(before.result).not.toHaveProperty("deliveryConcern");

  const empty = await health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, criticalTargets: { milestoneIds: [], raidItemIds: [] } }, randomUUID(),
  );
  const unconfigured = await health.create(pm, projectId, "concern-no-cadence", randomUUID());
  expect(unconfigured.result?.deliveryConcern).toMatchObject({
    calculated: { status: "UNKNOWN" }, recommendation: null,
    objectiveSignals: [expect.objectContaining({ kind: "UPDATE_FRESHNESS", state: "UNASSESSABLE" })],
  });
  const freshCadence = await updates.setPolicy(admin, projectId, {
    ...cadenceFields, expectedRevision: 0, freshnessWindowSeconds: 3600,
  }, randomUUID());
  const fresh = await health.create(pm, projectId, "concern-fresh-update", randomUUID());
  expect(fresh.result?.deliveryConcern).toMatchObject({
    calculated: { status: "GREEN" }, recommendation: null,
    objectiveSignals: [expect.objectContaining({ kind: "UPDATE_FRESHNESS", state: "CLEAR" })],
  });
  const cadence = await updates.setPolicy(admin, projectId, {
    ...cadenceFields, expectedRevision: freshCadence.revision, freshnessWindowSeconds: 1,
  }, randomUUID());
  const statementEvidence = await db.factEvidence.findUniqueOrThrow({
    where: { id: update.entry.evidenceId }, select: { observedAt: true },
  });
  await vi.waitFor(async () => {
    const [clock] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    expect(clock!.now.getTime()).toBeGreaterThan(statementEvidence.observedAt.getTime() + 1000);
  }, { timeout: 3000, interval: 50 });
  const enabled = await health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, expectedRevision: empty.revision, criticalTargets }, randomUUID(),
  );
  const noInventory = await health.create(pm, projectId, "concern-without-inventory", randomUUID());
  expect(noInventory.result?.deliveryConcern).toMatchObject({
    objectiveSignals: expect.arrayContaining([
      expect.objectContaining({ kind: "CRITICAL_BLOCKER", targetKey: young.key, state: "UNASSESSABLE" }),
      expect.objectContaining({ kind: "CRITICAL_BLOCKER", targetKey: closed.key, state: "CLEAR" }),
    ]),
  });
  await publish("project.open_blocker_inventory_complete", { type: "boolean", value: true });
  const checkingOld = await health.setScheduleHealthPolicy(admin, projectId, {
    ...schedule, expectedRevision: enabled.revision,
    criticalTargets: { milestoneIds: [], raidItemIds: [older.id] },
  }, randomUUID());
  const noOpenedDate = await health.create(pm, projectId, "concern-missing-opened-date", randomUUID());
  expect(noOpenedDate.result?.deliveryConcern).toMatchObject({
    calculated: { status: "UNKNOWN" },
    objectiveSignals: expect.arrayContaining([
      expect.objectContaining({ kind: "CRITICAL_BLOCKER", targetKey: older.key, state: "UNASSESSABLE" }),
    ]),
  });
  await publish("raid_item." + older.id + ".opened_at", {
    type: "date", value: new Date(now[0]!.now.getTime() - 10 * 86_400_000).toISOString().slice(0, 10),
  }, period);
  const configured = await health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, expectedRevision: checkingOld.revision, criticalTargets }, randomUUID(),
  );

  const policy = await health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, expectedRevision: configured.revision }, randomUUID(),
  );
  expect(policy.criticalTargets).toEqual(criticalTargets);
  const saved = await health.create(pm, projectId, "concern-with-inventory", randomUUID());
  expect(saved).toMatchObject({
    coverage: "SCHEDULE_BLOCKER_AGE_AND_DELIVERY_CONCERN", blockerAgeCoverage: "COMPLETE",
    contentAvailable: true, input: { deliveryConcern: {
      criticalTargetsPolicyRevision: policy.revision,
      updateEvidence: [expect.objectContaining({
        versionId: update.entry.id, evidenceId: update.entry.evidenceId, sourceId: update.entry.sourceId,
      })],
      dependencies: expect.arrayContaining([
        expect.objectContaining({ sourceId: update.entry.sourceId }),
        expect.objectContaining({ sourceId: alternative.entry.sourceId }),
      ]),
    } },
  });
  const concernInput = saved.input?.deliveryConcern as { evaluation: unknown };
  const replayEvaluation = assessDeliveryHealth(concernInput.evaluation);
  expect(saved.result?.deliveryConcern).toEqual({ ...replayEvaluation, recommendation: "PM_REVIEW" });
  expect(replayEvaluation.assessedAt).toBe(saved.assessedAt);
  expect(replayEvaluation.reported.status).toBe("GREEN");
  expect(replayEvaluation.calculated.status).toBe("RED");
  expect(replayEvaluation.objectiveSignals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: "CRITICAL_BLOCKER", targetKey: young.key, state: "ACTIVE",
      rule: expect.objectContaining({ parameters: expect.arrayContaining([
        { name: "blockerAgeThresholdRevision", value: threshold.revision },
      ]) }),
    }),
    expect.objectContaining({ kind: "CRITICAL_BLOCKER", targetKey: closed.key, state: "CLEAR" }),
    expect.objectContaining({ kind: "OVERDUE_MILESTONE", targetKey: milestone.key, state: "ACTIVE" }),
    expect.objectContaining({
      kind: "UPDATE_FRESHNESS", state: "ACTIVE",
      rule: expect.objectContaining({ parameters: expect.arrayContaining([
        { name: "cadencePolicyRevision", value: cadence.revision },
      ]) }),
    }),
  ]));
  expect(replayEvaluation.objectiveSignals.some((signal) => signal.targetKey === older.key)).toBe(false);
  expect(saved.result?.blockerAge).toMatchObject({
    assessments: expect.arrayContaining([
      expect.objectContaining({ targetKey: young.key, status: "WITHIN_THRESHOLD" }),
      expect.objectContaining({ targetKey: older.key, status: "AGED" }),
    ]),
  });
  expect(await db.projectUpdateAssessment.count({ where: { customerId, projectId } })).toBe(0);
  expect(await db.projectUpdateObligation.count({ where: { customerId, projectId } })).toBe(0);

  const alternatives = await Promise.allSettled([
    health.setScheduleHealthPolicy(admin, projectId, {
      ...schedule, expectedRevision: policy.revision, criticalTargets: null,
    }, randomUUID()),
    health.setScheduleHealthPolicy(admin, projectId, {
      ...schedule, expectedRevision: policy.revision, criticalTargets: { milestoneIds: [], raidItemIds: [] },
    }, randomUUID()),
  ]);
  expect(alternatives.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(alternatives.find((result) => result.status === "rejected")).toMatchObject({
    reason: { code: "CONFLICT" },
  });
  const replay = await health.create(pm, projectId, "concern-with-inventory", randomUUID());
  expect(replay).toEqual({ ...saved, replayed: true });
  const blockerHidden = await facts.setSourceAccess(admin, {
    projectId, sourceId: youngClassification.access.sourceId, expectedRevision: youngClassification.access.revision,
    state: "AVAILABLE", readers: [admin.subject],
  }, mark);
  expect(await health.create(pm, projectId, "concern-with-inventory", randomUUID()))
    .toMatchObject({ contentAvailable: false, input: null, result: null });
  await facts.setSourceAccess(admin, {
    projectId, sourceId: blockerHidden.sourceId, expectedRevision: blockerHidden.revision,
    state: "AVAILABLE", readers: [admin.subject, pm.subject],
  }, mark);
  expect(await health.create(pm, projectId, "concern-with-inventory", randomUUID()))
    .toEqual({ ...saved, replayed: true });
  await facts.setSourceAccess(admin, {
    projectId, sourceId: fallbackAccess.sourceId, expectedRevision: fallbackAccess.revision,
    state: "AVAILABLE", readers: [admin.subject],
  }, mark);
  expect(await health.create(pm, projectId, "concern-with-inventory", randomUUID()))
    .toMatchObject({ contentAvailable: false, input: null, result: null });
  await facts.setSourceAccess(admin, {
    projectId, sourceId: update.access.sourceId, expectedRevision: update.access.revision,
    state: "AVAILABLE", readers: [admin.subject],
  }, mark);
  for (const hidden of [
    await health.latest(pm, projectId),
    await health.create(pm, projectId, "concern-with-inventory", randomUUID()),
  ]) expect(hidden).toMatchObject({
    assessmentId: saved.assessmentId, contentAvailable: false, input: null, result: null,
  });
  const stored = await db.healthAssessment.findUniqueOrThrow({ where: { id: saved.assessmentId } });
  expect(stored.envelopeHash).toBe(saved.envelopeHash);
  expect(stored.result).toEqual(saved.result);

  const revised = await health.scheduleHealthPolicy(admin, projectId);
  await health.setScheduleHealthPolicy(
    admin, projectId, { ...schedule, expectedRevision: revised.revision, criticalTargets }, randomUUID(),
  );
  const freshCommand = await health.create(pm, projectId, "concern-after-update-revocation", randomUUID());
  expect(freshCommand).toMatchObject({
    contentAvailable: true,
    input: { deliveryConcern: { updateEvidence: [], dependencies: [] } },
    result: { deliveryConcern: {
      calculated: { status: "RED" },
      objectiveSignals: expect.arrayContaining([
        expect.objectContaining({ kind: "UPDATE_FRESHNESS", state: "UNASSESSABLE" }),
      ]),
    } },
  });
  expect(JSON.stringify(freshCommand)).not.toContain(update.entry.sourceId);
  expect(JSON.stringify(freshCommand)).not.toContain(alternative.entry.sourceId);

  const where = { customerId, projectId };
  const countAssessments = () => db.healthAssessment.count({ where });
  const countReceipts = () => db.healthAssessmentCommandReceipt.count({ where });
  const counts = await Promise.all([countAssessments(), countReceipts()]);
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const boundedUrl = new URL(url);
  boundedUrl.searchParams.set("options", "-c lock_timeout=500");
  const boundedDb = createDatabase(boundedUrl.href);
  const bounded = new DatabaseHealthAssessmentRepository(boundedDb);
  const writer = db.$transaction(async (tx) => {
    try {
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
        "schedule-health-policy:" + customerId + ":" + projectId,
      );
      acquired.resolve();
      await release.promise;
    } catch (error) {
      acquired.reject(error);
      throw error;
    }
  }, { timeout: 25000 });
  try {
    await acquired.promise;
    await expect(bounded.create(pm, projectId, "concern-lock-timeout", randomUUID()))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  } finally {
    release.resolve();
    await Promise.all([writer, boundedDb.$disconnect()]);
  }
  expect(await Promise.all([countAssessments(), countReceipts()])).toEqual(counts);
}, 45000);
