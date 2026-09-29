import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseProjectRepository,
  DatabaseProjectUpdateRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Project update cadence integration requires an isolated synthetic database");
const db = createDatabase(url);
const customerId = process.env.CUSTOMER_ID!;
const portfolioId = randomUUID();
const administrator: Actor = {
  customerId,
  subject: "cadence-pmo-" + randomUUID(),
  roles: ["pmo_admin"],
};
const portfolioManager: Actor = {
  customerId,
  subject: "cadence-manager-" + randomUUID(),
  roles: ["portfolio_manager"],
};
const recipientSubject = "synthetic-owner-1";
const nonManagerSubject = "synthetic-owner-2";
const canonical = new DatabaseCanonicalProjectRepository(db);
const updates = new DatabaseProjectUpdateRepository(db);
const access = new DatabaseProjectRepository(db);
let projectId: string;

beforeAll(async () => {
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Cadence synthetic portfolio" },
  });
  for (const actor of [administrator, portfolioManager])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "portfolio",
        scopeId: portfolioId,
        role: actor.roles[0]!,
      },
    });
  const created = await canonical.createProject(
    portfolioManager,
    canonicalFixture(portfolioId),
    randomUUID(),
  );
  projectId = created.id;
});

afterAll(async () => {
  await db.$disconnect();
});

function change(expectedRevision: number, escalationRecipientSubject = recipientSubject) {
  return {
    expectedRevision,
    freshnessWindowSeconds: 1,
    timeZone: "UTC",
    requiredFacts: [{ factType: "project.status", label: "Current status" }],
    responsibleSubject: "synthetic-owner-4",
    scheduledScanEnabled: false,
    reminderBusinessDayOffsets: [1, 2],
    escalationAfterBusinessDays: 3,
    escalationRecipientSubject,
    quietHoursStartLocal: "22:00",
    quietHoursEndLocal: "07:00",
  };
}

it("keeps old policy rows silent, authorizes PM scope on save and preview, and stores no schedule preview", async () => {
  const initialChangedAt = new Date();
  await db.$executeRawUnsafe(
    'INSERT INTO public."ProjectUpdatePolicy" ("customerId","projectId",key,revision,"changedBy","changedAt") VALUES ($1::uuid,$2::uuid,\'project-update\',0,$3,$4)',
    customerId,
    projectId,
    administrator.subject,
    initialChangedAt,
  );
  await db.$executeRawUnsafe(
    'INSERT INTO public."ProjectUpdatePolicyRevision" (id,"customerId","projectId",revision,"freshnessWindowSeconds","timeZone","requiredFacts","responsibleSubject","scheduledScanEnabled","scheduledServiceSubject","changedBy","changedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,1,1,\'UTC\',$4::jsonb,\'synthetic-owner-4\',false,NULL,$5,$6)',
    randomUUID(),
    customerId,
    projectId,
    JSON.stringify([{ factType: "project.status", label: "Current status" }]),
    administrator.subject,
    initialChangedAt,
  );
  await db.$executeRawUnsafe(
    'UPDATE public."ProjectUpdatePolicy" SET revision=1 WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid',
    customerId,
    projectId,
  );

  const oldPolicy = await updates.policy(administrator, projectId);
  expect(oldPolicy).toMatchObject({
    revision: 1,
    reminderBusinessDayOffsets: [],
    escalationAfterBusinessDays: 0,
    escalationRecipientSubject: null,
    quietHoursStartLocal: null,
    quietHoursEndLocal: null,
  });

  await expect(updates.setPolicy(
    administrator,
    projectId,
    change(1),
    randomUUID(),
  )).rejects.toMatchObject({ code: "DENIED" });

  await db.accessGrant.create({
    data: {
      customerId,
      subject: nonManagerSubject,
      scopeType: "project",
      scopeId: projectId,
      role: "project_manager",
    },
  });
  await expect(updates.setPolicy(
    administrator,
    projectId,
    change(1, nonManagerSubject),
    randomUUID(),
  )).rejects.toMatchObject({ code: "INVALID_REQUEST" });

  await access.setGrant(
    administrator,
    {
      subject: recipientSubject,
      scopeType: "portfolio",
      scopeId: portfolioId,
      role: "project_manager",
    },
    randomUUID(),
  );
  const saved = await updates.setPolicy(
    administrator,
    projectId,
    change(1),
    randomUUID(),
  );
  expect(saved).toMatchObject({
    revision: 2,
    reminderBusinessDayOffsets: [1, 2],
    escalationAfterBusinessDays: 3,
    escalationRecipientSubject: recipientSubject,
    quietHoursStartLocal: "22:00",
    quietHoursEndLocal: "07:00",
  });
  const oldRow = await db.$queryRawUnsafe<Array<{
    reminderBusinessDayOffsets: number[];
    escalationAfterBusinessDays: number;
    escalationRecipientSubject: string | null;
  }>>(
    'SELECT "reminderBusinessDayOffsets","escalationAfterBusinessDays","escalationRecipientSubject" FROM public."ProjectUpdatePolicyRevision" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND revision=1',
    customerId,
    projectId,
  );
  expect(oldRow[0]).toMatchObject({
    reminderBusinessDayOffsets: [],
    escalationAfterBusinessDays: 0,
    escalationRecipientSubject: null,
  });
  await expect(updates.setPolicy(
    administrator,
    projectId,
    change(1),
    randomUUID(),
  )).rejects.toMatchObject({ code: "CONFLICT" });

  await new Promise((resolve) => setTimeout(resolve, 1300));
  const assessment = await updates.assess(administrator, projectId, randomUUID());
  expect(assessment).toMatchObject({
    policy: { revision: 2 },
    freshness: { state: "STALE", sourceDateField: "project.createdAt" },
    obligation: { state: "OPEN" },
  });

  const beforeRows = await db.$queryRawUnsafe<{ count: number }[]>(
    'SELECT count(*)::int AS count FROM public."ProjectUpdatePreview" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid',
    customerId,
    projectId,
  );
  const preview = await updates.schedulePreview(administrator, projectId);
  const afterRows = await db.$queryRawUnsafe<{ count: number }[]>(
    'SELECT count(*)::int AS count FROM public."ProjectUpdatePreview" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid',
    customerId,
    projectId,
  );
  expect(preview).toMatchObject({
    assessmentPolicyRevision: 2,
    policyRevision: 2,
    logicalDueAt: assessment.obligation!.dueAt,
    sourceTimeBasis: "PROJECT_CREATED_AT",
    timeZone: "UTC",
  });
  expect(preview.events.map((event) => event.kind)).toEqual([
    "REQUEST",
    "REMINDER",
    "REMINDER",
    "ESCALATION",
  ]);
  expect(beforeRows[0]!.count).toBe(afterRows[0]!.count);

  await access.revokeGrant(
    administrator,
    {
      subject: recipientSubject,
      scopeType: "portfolio",
      scopeId: portfolioId,
    },
    randomUUID(),
  );
  await expect(updates.schedulePreview(administrator, projectId))
    .rejects.toMatchObject({ code: "DENIED" });
});
