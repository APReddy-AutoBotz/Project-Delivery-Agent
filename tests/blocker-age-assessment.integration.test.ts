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

  const { partial, partialReplay } = await withoutAiProvider(async () => {
    const partial = await health.create(
      manager,
      projectId,
      "partial-classification",
      randomUUID(),
    );
    const partialReplay = await health.create(
      manager,
      projectId,
      "partial-classification",
      randomUUID(),
    );
    return { partial, partialReplay };
  });
  expect(partial.coverage).toBe("SCHEDULE_AND_BLOCKER_AGE");
  expect(partial.blockerAgeCoverage).toBe("PARTIAL");
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
});
