import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseAuthorityRepository,
  DatabaseCanonicalProjectRepository,
  DatabaseHealthAssessmentRepository,
  DatabaseProjectFactRepository,
} from "../packages/data/dist/index.js";
import type { Actor, AuthorityDefinition } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Blocker assessment tests require an isolated synthetic database");
const customerId = process.env.CUSTOMER_ID!;
const db = createDatabase(url);
const facts = new DatabaseProjectFactRepository(db);
const authority = new DatabaseAuthorityRepository(db);
const canonical = new DatabaseCanonicalProjectRepository(db);
const health = new DatabaseHealthAssessmentRepository(db);
const context = { correlationId: "blocker-age-composition" };
afterAll(async () => {
  await db.$disconnect();
});

async function withoutAiProvider<T>(operation: () => Promise<T>): Promise<T> {
  // Reject fetch-based provider traffic while the source-authorized assessment
  // and its separate idempotent replay are captured.
  const providerRequest = vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("AI provider is disabled for this test"),
  );
  try {
    const result = await operation();
    expect(providerRequest).not.toHaveBeenCalled();
    return result;
  } finally {
    providerRequest.mockRestore();
  }
}

it("persists source-authorized schedule and blocker-age results with provider access disabled and preserves idempotent replay", async () => {
  const portfolioId = randomUUID();
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Blocker age composition fixture" },
  });
  const manager: Actor = {
    customerId,
    subject: "blocker-manager-" + randomUUID(),
    roles: ["portfolio_manager", "project_manager"],
  };
  const administrator: Actor = {
    customerId,
    subject: "blocker-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await db.accessGrant.create({
    data: {
      customerId,
      subject: manager.subject,
      scopeType: "portfolio",
      scopeId: portfolioId,
      role: "portfolio_manager",
    },
  });
  const projectInput = canonicalFixture(portfolioId);
  projectInput.code = "BLK-" + randomUUID().slice(0, 8);
  const [scheduleClock] = await db.$queryRawUnsafe<{ now: Date }[]>(
    "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
  );
  const scheduleTimeZone = "America/Los_Angeles";
  const localParts = new Map(
    new Intl.DateTimeFormat("en-US", {
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: scheduleTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(scheduleClock!.now)
      .map((part) => [part.type, part.value] as const),
  );
  const localDate = [
    localParts.get("year")!.padStart(4, "0"),
    localParts.get("month")!,
    localParts.get("day")!,
  ].join("-");
  const shiftLocalDate = (value: string, days: number) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days))
      .toISOString()
      .slice(0, 10);
  };
  const scheduledDueDate = shiftLocalDate(localDate, -1);
  const olderPlannedDate = shiftLocalDate(localDate, -10);
  projectInput.milestones = projectInput.milestones.map((item) => ({
    ...item,
    dates: {
      ...item.dates,
      forecastEnd: scheduledDueDate,
      plannedEnd: olderPlannedDate,
    },
  }));
  projectInput.workItems = projectInput.workItems.map((item) => ({
    ...item,
    dates: {
      ...item.dates,
      forecastEnd: scheduledDueDate,
      plannedEnd: olderPlannedDate,
    },
  }));
  projectInput.raidItems = projectInput.raidItems.map((item, index) => ({
    ...item,
    state: index < 2 ? "OPEN" : "COMPLETE",
  }));
  const created = await canonical.createProject(
    manager,
    projectInput,
    randomUUID(),
  );
  const projectId = created.id;
  await db.accessGrant.createMany({
    data: [
      {
        customerId,
        subject: manager.subject,
        scopeType: "project",
        scopeId: projectId,
        role: "project_manager",
      },
      {
        customerId,
        subject: administrator.subject,
        scopeType: "project",
        scopeId: projectId,
        role: "pmo_admin",
      },
    ],
  });

  const initialSchedulePolicy = await health.scheduleHealthPolicy(
    manager,
    projectId,
  );
  expect(initialSchedulePolicy).toMatchObject({
    revision: 0,
    timeZone: "UTC",
    defaultMinimumOverdueDays: 1,
    targetOverrides: [],
    changedBy: null,
    changedAt: null,
  });

  const policyAcl = await db.$queryRawUnsafe<{
    owner: string;
    apiSelect: boolean;
    apiInsert: boolean;
    apiUpdate: boolean;
    apiDelete: boolean;
    apiGrantOption: boolean;
    workerSelect: boolean;
    backupSelect: boolean;
  }[]>(
    `SELECT pg_get_userbyid(relowner) AS owner,
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','SELECT') AS "apiSelect",
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','INSERT') AS "apiInsert",
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','UPDATE') AS "apiUpdate",
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','DELETE') AS "apiDelete",
      has_table_privilege('pdaa_api','public."ScheduleHealthPolicyRevision"','SELECT WITH GRANT OPTION') AS "apiGrantOption",
      has_table_privilege('pdaa_worker','public."ScheduleHealthPolicyRevision"','SELECT') AS "workerSelect",
      has_table_privilege('pdaa_backup','public."ScheduleHealthPolicyRevision"','SELECT') AS "backupSelect"
    FROM pg_class WHERE oid='public."ScheduleHealthPolicyRevision"'::regclass`,
  );
  expect(policyAcl[0]).toMatchObject({
    owner: "pdaa_migrate",
    apiSelect: true,
    apiInsert: true,
    apiUpdate: false,
    apiDelete: false,
    apiGrantOption: false,
    workerSelect: false,
    backupSelect: true,
  });

  await expect(
    health.setScheduleHealthPolicy(
      manager,
      projectId,
      {
        expectedRevision: initialSchedulePolicy.revision,
        timeZone: scheduleTimeZone,
        defaultMinimumOverdueDays: 3,
        targetOverrides: [],
      },
      randomUUID(),
    ),
  ).rejects.toThrow("FORBIDDEN");

  const outOfScopeAdmin: Actor = {
    customerId,
    subject: "blocker-out-of-scope-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await expect(
    health.scheduleHealthPolicy(outOfScopeAdmin, projectId),
  ).rejects.toThrow("DENIED");
  await expect(
    health.setScheduleHealthPolicy(
      outOfScopeAdmin,
      projectId,
      {
        expectedRevision: initialSchedulePolicy.revision,
        timeZone: scheduleTimeZone,
        defaultMinimumOverdueDays: 3,
        targetOverrides: [],
      },
      randomUUID(),
    ),
  ).rejects.toThrow("DENIED");

  await expect(
    health.setScheduleHealthPolicy(
      administrator,
      projectId,
      {
        expectedRevision: initialSchedulePolicy.revision,
        timeZone: "Not/A_Real_Zone",
        defaultMinimumOverdueDays: 3,
        targetOverrides: [],
      },
      randomUUID(),
    ),
  ).rejects.toThrow("INVALID_REQUEST");

  const proposedSchedulePolicy = {
    timeZone: scheduleTimeZone,
    defaultMinimumOverdueDays: 3,
    targetOverrides: [
      {
        targetType: "MILESTONE" as const,
        targetKey: "MS-1",
        minimumOverdueDays: 1,
      },
    ],
  };
  const policyWriteCorrelationIds = [randomUUID(), randomUUID()];
  const concurrentPolicyWrites = await Promise.allSettled(
    policyWriteCorrelationIds.map((correlationId) =>
      health.setScheduleHealthPolicy(
        administrator,
        projectId,
        {
          expectedRevision: initialSchedulePolicy.revision,
          ...proposedSchedulePolicy,
        },
        correlationId,
      ),
    ),
  );
  const winningPolicyWriteIndex = concurrentPolicyWrites.findIndex(
    (result) => result.status === "fulfilled",
  );
  const winningPolicyWrite = concurrentPolicyWrites[winningPolicyWriteIndex];
  const losingPolicyWrite = concurrentPolicyWrites[
    winningPolicyWriteIndex === 0 ? 1 : 0
  ];
  if (
    !winningPolicyWrite ||
    winningPolicyWrite.status !== "fulfilled" ||
    !losingPolicyWrite ||
    losingPolicyWrite.status !== "rejected"
  )
    throw new Error("Exactly one concurrent schedule-policy write must win");
  const schedulePolicy = winningPolicyWrite.value;
  expect(losingPolicyWrite.reason).toMatchObject({ code: "CONFLICT" });
  expect(schedulePolicy).toMatchObject({
    revision: initialSchedulePolicy.revision + 1,
    timeZone: scheduleTimeZone,
    defaultMinimumOverdueDays: 3,
    targetOverrides: proposedSchedulePolicy.targetOverrides,
    changedBy: administrator.subject,
  });
  const winningAudit = await db.auditEvent.findFirst({
    where: {
      customerId,
      event: "health.schedule.policy.changed",
      correlationId: policyWriteCorrelationIds[winningPolicyWriteIndex],
    },
  });
  expect(winningAudit).toMatchObject({
    actor: administrator.subject,
    event: "health.schedule.policy.changed",
    detail: {
      objectType: "ScheduleHealthPolicy",
      projectId,
      revision: schedulePolicy.revision,
      timeZone: scheduleTimeZone,
      defaultMinimumOverdueDays: 3,
    },
  });

  await expect(
    health.setScheduleHealthPolicy(
      administrator,
      projectId,
      {
        expectedRevision: schedulePolicy.revision,
        timeZone: scheduleTimeZone,
        defaultMinimumOverdueDays: 3,
        targetOverrides: [
          {
            targetType: "MILESTONE",
            targetKey: "MS-NOT-IN-PROJECT",
            minimumOverdueDays: 1,
          },
        ],
      },
      randomUUID(),
    ),
  ).rejects.toThrow("INVALID_REQUEST");

  await expect(
    health.setScheduleHealthPolicy(
      administrator,
      projectId,
      {
        expectedRevision: initialSchedulePolicy.revision,
        timeZone: "UTC",
        defaultMinimumOverdueDays: 1,
        targetOverrides: [],
      },
      randomUUID(),
    ),
  ).rejects.toThrow("CONFLICT");

  await health.setRetention(
    administrator,
    {
      contentRetentionHours: 24,
      auditRetentionHours: 48,
      idempotencyRetentionHours: 72,
    },
    randomUUID(),
  );
  await health.setBlockerAgeThresholdPolicy(
    administrator,
    {
      expectedRevision: 0,
      minimumBlockerAgeDays: 5,
      auditRetentionHours: 720,
    },
    randomUUID(),
  );

  const [clock] = await db.$queryRawUnsafe<{ now: Date }[]>(
    "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
  );
  const policyEffectiveAt = new Date(clock!.now.getTime() - 60_000).toISOString();
  const openedDate = new Date(clock!.now.getTime() - 10 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const currentDefinition: AuthorityDefinition = {
    tiers: [
      {
        selectors: [
          {
            sourceType: "human_statement",
            instanceId: null,
            requiredApproval: "NOT_REQUIRED",
            validity: { basis: "observedAt", durationMs: 86_400_000 },
          },
        ],
      },
    ],
    conflictBehavior: "REQUEST_RECONCILIATION",
  };
  const openedAtDefinition: AuthorityDefinition = {
    tiers: [
      {
        selectors: [
          {
            sourceType: "human_statement",
            instanceId: null,
            requiredApproval: "NOT_REQUIRED",
            validity: { mode: "UNTIL_SUPERSEDED" },
          },
        ],
      },
    ],
    conflictBehavior: "REQUEST_RECONCILIATION",
  };
  const configure = async (
    factType: string,
    definition: AuthorityDefinition,
  ) => {
    await authority.appendPolicy(
      administrator,
      {
        projectId,
        factType,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        effectiveAt: policyEffectiveAt,
        definition,
      },
      context,
    );
  };
  const accessRevisions = new Map<string, number>();
  const append = async (
    factType: string,
    value: { type: "boolean"; value: boolean } | { type: "date"; value: string },
    expectedRevision = 0,
  ) => {
    const appended = await facts.appendHumanStatement(
      manager,
      {
        projectId,
        factType,
        expectedRevision,
        idempotencyKey: randomUUID(),
        value,
        effectiveAt: policyEffectiveAt,
        validUntil: null,
        originalStatement: "Synthetic authority input for blocker assessment.",
      },
      context,
    );
    if (!accessRevisions.has(appended.entry.sourceId)) {
      const access = await facts.setSourceAccess(
        administrator,
        {
          projectId,
          sourceId: appended.entry.sourceId,
          expectedRevision: appended.entry.sourceAccessRevision,
          state: "AVAILABLE",
          readers: [manager.subject, administrator.subject],
        },
        context,
      );
      accessRevisions.set(access.sourceId, access.revision);
    }
    return appended;
  };

  await configure("project.open_blocker_inventory_complete", currentDefinition);
  await append("project.open_blocker_inventory_complete", {
    type: "boolean",
    value: true,
  });

  const raidRows = await db.raidItem.findMany({
    where: { customerId, projectId, state: "OPEN" },
    orderBy: { id: "asc" },
  });
  expect(raidRows).toHaveLength(2);
  const first = raidRows[0]!;
  const second = raidRows[1]!;
  const firstClassification = "raid_item." + first.id + ".blocks_delivery";
  const firstOpenedAt = "raid_item." + first.id + ".opened_at";
  const secondClassification = "raid_item." + second.id + ".blocks_delivery";
  const acceptedOpenedRule = await db.$queryRawUnsafe<{ valid: boolean }[]>(
    "SELECT public.valid_authority_sources($1::uuid,$2::uuid,$3::varchar,$4::jsonb) AS valid",
    customerId,
    projectId,
    firstOpenedAt,
    JSON.stringify(openedAtDefinition),
  );
  const rejectedNonOpenedRule = await db.$queryRawUnsafe<{ valid: boolean }[]>(
    "SELECT public.valid_authority_sources($1::uuid,$2::uuid,$3::varchar,$4::jsonb) AS valid",
    customerId,
    projectId,
    "project.open_blocker_inventory_complete",
    JSON.stringify(openedAtDefinition),
  );
  expect(acceptedOpenedRule[0]?.valid).toBe(true);
  expect(rejectedNonOpenedRule[0]?.valid).toBe(false);
  await configure(firstClassification, currentDefinition);
  const firstFact = await append(firstClassification, {
    type: "boolean",
    value: true,
  });
  await configure(firstOpenedAt, openedAtDefinition);
  await append(firstOpenedAt, { type: "date", value: openedDate });

  const { partial, partialReplay, updatedSchedulePolicy } =
    await withoutAiProvider(async () => {
      const policyChangeCorrelationId = randomUUID();
      const [partial, updatedSchedulePolicy] = await Promise.all([
        health.create(
          manager,
          projectId,
          "partial-classification",
          randomUUID(),
        ),
        health.setScheduleHealthPolicy(
          administrator,
          projectId,
          {
            expectedRevision: schedulePolicy.revision,
            timeZone: scheduleTimeZone,
            defaultMinimumOverdueDays: 4,
            targetOverrides: proposedSchedulePolicy.targetOverrides,
          },
          policyChangeCorrelationId,
        ),
      ]);
      const partialReplay = await health.create(
        manager,
        projectId,
        "partial-classification",
        randomUUID(),
      );
      return { partial, partialReplay, updatedSchedulePolicy };
    });
  expect(partial.coverage).toBe("SCHEDULE_AND_BLOCKER_AGE");
  expect(partial.ruleRevision).toBe("schedule-health@2+blocker-age@1");
  expect(partial.blockerAgeCoverage).toBe("PARTIAL");
  const savedSchedulePolicy = (partial.input as {
    scheduleHealthPolicy: {
      revision: number;
      timeZone: string;
      defaultMinimumOverdueDays: number;
      targetOverrides: unknown[];
    };
  }).scheduleHealthPolicy;
  expect([schedulePolicy.revision, updatedSchedulePolicy.revision]).toContain(
    savedSchedulePolicy.revision,
  );
  expect(savedSchedulePolicy.timeZone).toBe(scheduleTimeZone);
  if (savedSchedulePolicy.revision === schedulePolicy.revision) {
    expect(savedSchedulePolicy.defaultMinimumOverdueDays).toBe(3);
  } else {
    expect(savedSchedulePolicy).toMatchObject({
      revision: updatedSchedulePolicy.revision,
      defaultMinimumOverdueDays: 4,
    });
  }
  const scheduleResults = (partial.result as {
    objectiveSignals: Array<{
      targetKey: string;
      kind: string;
      state: string;
      sourceFacts: Array<{ field: string; value: unknown }>;
      rule: { parameters: Array<{ name: string; value: unknown }> };
    }>;
  }).objectiveSignals;
  const milestoneSignal = scheduleResults.find(
    (signal) => signal.targetKey === "MS-1",
  );
  const workItemSignal = scheduleResults.find(
    (signal) => signal.targetKey === "WI-1",
  );
  expect(milestoneSignal).toMatchObject({
    kind: "OVERDUE_MILESTONE",
    state: "ACTIVE",
  });
  expect(milestoneSignal!.sourceFacts).toContainEqual(
    expect.objectContaining({
      field: "selectedDueDate",
      value: scheduledDueDate,
    }),
  );
  expect(milestoneSignal!.sourceFacts).toContainEqual(
    expect.objectContaining({
      field: "selectedDateField",
      value: "forecastEnd",
    }),
  );
  expect(milestoneSignal!.rule.parameters).toContainEqual({
    name: "minimumOverdueDays",
    value: 1,
  });
  expect(milestoneSignal!.rule.parameters).toContainEqual({
    name: "timeZone",
    value: scheduleTimeZone,
  });
  expect(workItemSignal).toMatchObject({
    kind: "OVERDUE_WORK_ITEM",
    state: "CLEAR",
  });
  expect(workItemSignal!.sourceFacts).toContainEqual(
    expect.objectContaining({
      field: "selectedDueDate",
      value: scheduledDueDate,
    }),
  );
  expect(workItemSignal!.rule.parameters).toContainEqual({
    name: "minimumOverdueDays",
    value: savedSchedulePolicy.defaultMinimumOverdueDays,
  });
  expect(partial.contentAvailable).toBe(true);
  const partialResult = partial.result as {
    calculated: { status: string };
    blockerAge: {
      coverage: string;
      candidateCount: number;
      assessedBlockerCount: number;
      unknownCandidateCount: number;
      noOpenBlockers: boolean | null;
      assessments: { targetKey: string; status: string; ageDays: number }[];
    };
  };
  expect(partialResult.blockerAge).toMatchObject({
    coverage: "PARTIAL",
    candidateCount: 2,
    assessedBlockerCount: 1,
    unknownCandidateCount: 1,
    noOpenBlockers: null,
  });
  expect(partialResult.blockerAge.assessments[0]).toMatchObject({
    targetKey: first.key,
    status: "AGED",
    ageDays: expect.any(Number),
  });
  expect(partialResult.blockerAge.assessments[0]!.ageDays).toBeGreaterThanOrEqual(5);
  expect(partialResult.calculated.status).toBe("RED");
  expect(
    JSON.stringify(partial.input),
  ).not.toContain("Synthetic authority input for blocker assessment.");

  expect(partialReplay.assessmentId).toBe(partial.assessmentId);
  expect(partialReplay.envelopeHash).toBe(partial.envelopeHash);
  expect(partialReplay.input).toEqual(partial.input);
  expect(partialReplay.result).toEqual(partial.result);
  expect(partialReplay.replayed).toBe(true);
  expect(partialReplay.input).toEqual(partial.input);
  expect(partialReplay.result).toEqual(partial.result);

  await configure(secondClassification, currentDefinition);
  await append(secondClassification, { type: "boolean", value: false });
  const allClassified = await health.create(
    manager,
    projectId,
    "all-classified",
    randomUUID(),
  );
  expect(allClassified.blockerAgeCoverage).toBe("COMPLETE");
  const classifiedResult = allClassified.result as {
    blockerAge: {
      coverage: string;
      assessedBlockerCount: number;
      unknownCandidateCount: number;
      noOpenBlockers: boolean | null;
    };
  };
  expect(classifiedResult.blockerAge).toMatchObject({
    coverage: "COMPLETE",
    assessedBlockerCount: 1,
    unknownCandidateCount: 0,
    noOpenBlockers: false,
  });

  await append(firstClassification, { type: "boolean", value: false }, 1);
  const completeClear = await health.create(
    manager,
    projectId,
    "all-classified-clear",
    randomUUID(),
  );
  expect(completeClear.blockerAgeCoverage).toBe("COMPLETE");
  const clearResult = completeClear.result as {
    blockerAge: {
      coverage: string;
      assessedBlockerCount: number;
      unknownCandidateCount: number;
      noOpenBlockers: boolean | null;
      assessments: unknown[];
    };
  };
  expect(clearResult.blockerAge).toMatchObject({
    coverage: "COMPLETE",
    assessedBlockerCount: 0,
    unknownCandidateCount: 0,
    noOpenBlockers: true,
    assessments: [],
  });

  const latestBeforeRevocation = await health.latest(manager, projectId);
  expect(latestBeforeRevocation?.contentAvailable).toBe(true);
  const sourceAccessRevision = accessRevisions.get(firstFact.entry.sourceId)!;
  await facts.setSourceAccess(
    administrator,
    {
      projectId,
      sourceId: firstFact.entry.sourceId,
      expectedRevision: sourceAccessRevision,
      state: "AVAILABLE",
      readers: [administrator.subject],
    },
    context,
  );
  const hiddenLatest = await health.latest(manager, projectId);
  expect(hiddenLatest).toMatchObject({
    assessmentId: completeClear.assessmentId,
    contentAvailable: false,
    input: null,
    result: null,
  });
  const hiddenReplay = await health.create(
    manager,
    projectId,
    "all-classified-clear",
    randomUUID(),
  );
  expect(hiddenReplay).toMatchObject({
    assessmentId: completeClear.assessmentId,
    replayed: true,
    contentAvailable: false,
    input: null,
    result: null,
  });


it("persists local-midnight and threshold-boundary schedule evidence and replays its old policy snapshot", async () => {
  const portfolioId = randomUUID();
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Schedule overdue boundary fixture" },
  });
  const manager: Actor = {
    customerId,
    subject: "schedule-boundary-manager-" + randomUUID(),
    roles: ["portfolio_manager", "project_manager"],
  };
  const administrator: Actor = {
    customerId,
    subject: "schedule-boundary-pmo-" + randomUUID(),
    roles: ["pmo_admin"],
  };
  await db.accessGrant.create({
    data: {
      customerId,
      subject: manager.subject,
      scopeType: "portfolio",
      scopeId: portfolioId,
      role: "portfolio_manager",
    },
  });

  const timeZone = "America/Los_Angeles";
  const formatLocalDate = (instant: Date) => {
    const parts = new Map(
      new Intl.DateTimeFormat("en-US", {
        calendar: "gregory",
        numberingSystem: "latn",
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(instant)
        .map((part) => [part.type, part.value] as const),
    );
    return [
      parts.get("year")!.padStart(4, "0"),
      parts.get("month")!,
      parts.get("day")!,
    ].join("-");
  };
  const shiftLocalDate = (value: string, days: number) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year!, month! - 1, day! + days))
      .toISOString()
      .slice(0, 10);
  };
  const [databaseClock] = await db.$queryRawUnsafe<{ now: Date }[]>(
    "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
  );
  const nextLocalDate = shiftLocalDate(formatLocalDate(databaseClock!.now), 1);
  const localMidnight = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    const desired = Date.UTC(year!, month! - 1, day!);
    let candidate = desired;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = new Map(
        new Intl.DateTimeFormat("en-US", {
          calendar: "gregory",
          numberingSystem: "latn",
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(new Date(candidate))
          .map((part) => [part.type, part.value] as const),
      );
      const rendered = Date.UTC(
        Number(parts.get("year")),
        Number(parts.get("month")) - 1,
        Number(parts.get("day")),
        Number(parts.get("hour")),
        Number(parts.get("minute")),
        Number(parts.get("second")),
      );
      const correction = desired - rendered;
      candidate += correction;
      if (correction === 0) break;
    }
    return new Date(candidate);
  };
  const localMidnightUtc = localMidnight(nextLocalDate);
  const justBeforeMidnight = new Date(localMidnightUtc.getTime() - 1);
  expect(formatLocalDate(justBeforeMidnight)).toBe(
    shiftLocalDate(nextLocalDate, -1),
  );
  expect(formatLocalDate(localMidnightUtc)).toBe(nextLocalDate);

  const dueYesterday = shiftLocalDate(nextLocalDate, -1);
  const dueTwoDaysEarlier = shiftLocalDate(nextLocalDate, -2);
  const earlierPlanned = shiftLocalDate(nextLocalDate, -30);
  const projectInput = canonicalFixture(portfolioId);
  projectInput.code = "SCH-" + randomUUID().slice(0, 8);
  projectInput.milestones = projectInput.milestones.map((item) => ({
    ...item,
    dates: { ...item.dates, forecastEnd: dueYesterday, plannedEnd: earlierPlanned },
  }));
  const originalWorkItem = projectInput.workItems[0]!;
  projectInput.workItems = [
    {
      ...originalWorkItem,
      dates: {
        ...originalWorkItem.dates,
        forecastEnd: dueTwoDaysEarlier,
        plannedEnd: earlierPlanned,
      },
    },
    {
      ...originalWorkItem,
      key: "WI-2",
      title: "One-day overdue but below default threshold",
      dates: {
        ...originalWorkItem.dates,
        forecastEnd: dueYesterday,
        plannedEnd: earlierPlanned,
      },
    },
    {
      ...originalWorkItem,
      key: "WI-3",
      title: "Missing schedule dates",
      dates: {
        ...originalWorkItem.dates,
        forecastEnd: null,
        plannedEnd: null,
      },
    },
  ];
  projectInput.raidItems = projectInput.raidItems.map((item) => ({
    ...item,
    state: "COMPLETE",
  }));
  const created = await canonical.createProject(
    manager,
    projectInput,
    randomUUID(),
  );
  const projectId = created.id;
  const canonicalProject = await db.canonicalProject.findUnique({
    where: { id: projectId },
  });
  if (!canonicalProject) throw new Error("Boundary canonical project missing");
  await db.accessGrant.create({
    data: {
      customerId,
      subject: administrator.subject,
      scopeType: "project",
      scopeId: projectId,
      role: "pmo_admin",
    },
  });

  const assessmentClock = { asOf: justBeforeMidnight };
  const policyRepository = new DatabaseHealthAssessmentRepository(
    db,
    () => assessmentClock.asOf,
  );
  await health.setRetention(
    administrator,
    {
      contentRetentionHours: 24,
      auditRetentionHours: 48,
      idempotencyRetentionHours: 72,
    },
    randomUUID(),
  );
  const policy = await policyRepository.scheduleHealthPolicy(
    manager,
    projectId,
  );
  const proposal = {
    timeZone,
    defaultMinimumOverdueDays: 2,
    targetOverrides: [
      {
        targetType: "MILESTONE" as const,
        targetKey: "MS-1",
        minimumOverdueDays: 1,
      },
    ],
  };
  const firstPolicy = await policyRepository.setScheduleHealthPolicy(
    administrator,
    projectId,
    { expectedRevision: policy.revision, ...proposal },
    randomUUID(),
  );

  const before = await policyRepository.create(
    manager,
    projectId,
    "schedule-boundary-before-midnight",
    randomUUID(),
  );
  const beforeRow = await db.healthAssessment.findUnique({
    where: { id: before.assessmentId },
  });
  if (!beforeRow?.input || !beforeRow.result)
    throw new Error("Persisted pre-midnight schedule evidence unavailable");
  const beforeInput = beforeRow.input as unknown as {
    scheduleHealthPolicy: {
      revision: number;
      timeZone: string;
      defaultMinimumOverdueDays: number;
    };
  };
  const beforeResult = beforeRow.result as unknown as {
    objectiveSignals: Array<{
      targetKey: string;
      targetType: string;
      state: string;
      targetSource: { kind: string; recordId: string; revision: number };
      rule: {
        key: string;
        revision: string;
        parameters: Array<{ name: string; value: unknown }>;
      };
      sourceFacts: Array<{ field: string; value: unknown }>;
    }>;
  };
  const findSignal = (
    result: typeof beforeResult,
    targetType: string,
    targetKey: string,
  ) => {
    const signal = result.objectiveSignals.find(
      (candidate) =>
        candidate.targetType === targetType &&
        candidate.targetKey === targetKey,
    );
    if (!signal) throw new Error("Expected schedule signal missing");
    return signal;
  };
  expect(beforeRow.assessedAt.toISOString()).toBe(
    justBeforeMidnight.toISOString(),
  );
  expect(beforeRow.ruleRevision).toBe("schedule-health@2+blocker-age@1");
  expect(beforeInput.scheduleHealthPolicy).toMatchObject({
    revision: firstPolicy.revision,
    timeZone,
    defaultMinimumOverdueDays: 2,
  });
  expect(findSignal(beforeResult, "MILESTONE", "MS-1").state).toBe("CLEAR");
  expect(findSignal(beforeResult, "WORK_ITEM", "WI-1").state).toBe("CLEAR");
  expect(findSignal(beforeResult, "WORK_ITEM", "WI-2").state).toBe("CLEAR");
  expect(findSignal(beforeResult, "WORK_ITEM", "WI-3").state).toBe(
    "UNASSESSABLE",
  );

  const secondPolicy = await policyRepository.setScheduleHealthPolicy(
    administrator,
    projectId,
    { expectedRevision: firstPolicy.revision, ...proposal },
    randomUUID(),
  );
  expect(secondPolicy.revision).toBe(firstPolicy.revision + 1);
  const replay = await policyRepository.create(
    manager,
    projectId,
    "schedule-boundary-before-midnight",
    randomUUID(),
  );
  const replayRow = await db.healthAssessment.findUnique({
    where: { id: replay.assessmentId },
  });
  expect(replay).toMatchObject({
    assessmentId: before.assessmentId,
    envelopeHash: before.envelopeHash,
    replayed: true,
  });
  expect(replayRow?.input).toEqual(beforeRow.input);
  expect(replayRow?.result).toEqual(beforeRow.result);
  expect(replayRow?.assessedAt).toEqual(beforeRow.assessedAt);
  expect(
    (replayRow!.input as unknown as typeof beforeInput).scheduleHealthPolicy
      .revision,
  ).toBe(firstPolicy.revision);

  assessmentClock.asOf = localMidnightUtc;
  const atMidnight = await policyRepository.create(
    manager,
    projectId,
    "schedule-boundary-at-midnight",
    randomUUID(),
  );
  const atMidnightRow = await db.healthAssessment.findUnique({
    where: { id: atMidnight.assessmentId },
  });
  if (!atMidnightRow?.input || !atMidnightRow.result)
    throw new Error("Persisted midnight schedule evidence unavailable");
  const midnightInput = atMidnightRow.input as unknown as typeof beforeInput;
  const midnightResult = atMidnightRow.result as unknown as typeof beforeResult;
  expect(atMidnightRow.assessedAt.toISOString()).toBe(
    localMidnightUtc.toISOString(),
  );
  expect(atMidnightRow.ruleRevision).toBe("schedule-health@2+blocker-age@1");
  expect(midnightInput.scheduleHealthPolicy.revision).toBe(secondPolicy.revision);

  const milestone = findSignal(midnightResult, "MILESTONE", "MS-1");
  expect(milestone.state).toBe("ACTIVE");
  expect(milestone.targetSource).toMatchObject({
    kind: "canonical_record",
    recordId: expect.any(String),
    revision: canonicalProject.revision,
  });
  expect(milestone.rule).toMatchObject({ key: "schedule-health", revision: "2" });
  expect(milestone.rule.parameters).toEqual(expect.arrayContaining([
    { name: "assessedLocalDate", value: nextLocalDate },
    { name: "timeZone", value: timeZone },
    { name: "scheduleHealthPolicyRevision", value: secondPolicy.revision },
    { name: "minimumOverdueDays", value: 1 },
    { name: "selectedDateField", value: "forecastEnd" },
    { name: "daysOverdue", value: 1 },
  ]));
  expect(milestone.sourceFacts).toEqual(expect.arrayContaining([
    { field: "selectedDueDate", value: dueYesterday },
    { field: "selectedDateField", value: "forecastEnd" },
  ]));

  const defaultActive = findSignal(midnightResult, "WORK_ITEM", "WI-1");
  expect(defaultActive.state).toBe("ACTIVE");
  expect(defaultActive.rule.parameters).toEqual(expect.arrayContaining([
    { name: "minimumOverdueDays", value: 2 },
    { name: "daysOverdue", value: 2 },
  ]));
  const defaultClear = findSignal(midnightResult, "WORK_ITEM", "WI-2");
  expect(defaultClear.state).toBe("CLEAR");
  expect(defaultClear.rule.parameters).toContainEqual({
    name: "daysOverdue",
    value: 1,
  });
  const unassessable = findSignal(midnightResult, "WORK_ITEM", "WI-3");
  expect(unassessable.state).toBe("UNASSESSABLE");
  expect(unassessable.targetSource.revision).toBe(canonicalProject.revision);
  expect(unassessable.rule.parameters).toEqual(expect.arrayContaining([
    { name: "selectedDateField", value: "none" },
    { name: "minimumOverdueDays", value: 2 },
    { name: "daysOverdue", value: null },
  ]));
  expect(unassessable.sourceFacts).toEqual(expect.arrayContaining([
    { field: "selectedDueDate", value: null },
    { field: "selectedDateField", value: "none" },
  ]));
});
