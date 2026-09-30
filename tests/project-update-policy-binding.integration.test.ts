// EXEC-015, FR-UPD-006/010, FR-ESC-006: policy lineage before activation.
import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseProjectUpdateRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.DATA_MODE !== "synthetic" ||
    !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Policy binding checks require an isolated synthetic database");
const db = createDatabase(url);
afterAll(async () => { await db.$disconnect(); });

it("reuses only the same revision and supersedes an old policy after explicit re-assessment", async () => {
  const customerId = process.env.CUSTOMER_ID!;
  const portfolioId = randomUUID();
  const administrator: Actor = { customerId, subject: "binding-pmo-" + randomUUID(), roles: ["pmo_admin"] };
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Policy binding fixture" } });
  await db.accessGrant.create({ data: {
    customerId, subject: administrator.subject, scopeType: "portfolio",
    scopeId: portfolioId, role: "pmo_admin",
  } });
  const project = await new DatabaseCanonicalProjectRepository(db).createProject(
    administrator, canonicalFixture(portfolioId), randomUUID(),
  );
  const updates = new DatabaseProjectUpdateRepository(db);
  const change = {
    freshnessWindowSeconds: 1, timeZone: "UTC",
    requiredFacts: [{ factType: "project.status", label: "Current status" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false,
    reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0,
    escalationRecipientSubject: null, quietHoursStartLocal: null, quietHoursEndLocal: null,
  };
  await updates.setPolicy(administrator, project.id, { ...change, expectedRevision: 0 }, randomUUID());
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const first = await updates.assess(administrator, project.id, randomUUID());
  expect(first.obligation?.state).toBe("OPEN");
  const priorId = first.obligation!.id;
  const previous = await db.projectUpdateObligation.findUniqueOrThrow({ where: { id: priorId } });
  const repeatedBefore = await updates.assess(administrator, project.id, randomUUID());
  expect(repeatedBefore.obligation!.id).toBe(priorId);

  await updates.setPolicy(administrator, project.id, {
    ...change, expectedRevision: 1, reminderBusinessDayOffsets: [1],
  }, randomUUID());
  expect((await db.projectUpdateObligation.findUniqueOrThrow({ where: { id: priorId } })).state).toBe("OPEN");
  const reassessed = await updates.assess(administrator, project.id, randomUUID());
  expect(reassessed.policy.revision).toBe(2);
  expect(reassessed.obligation?.id).not.toBe(priorId);
  const ended = await db.projectUpdateObligation.findUniqueOrThrow({ where: { id: priorId } });
  expect(ended.state).toBe("SUPERSEDED");
  expect(ended.supersededAt).toBeInstanceOf(Date);
  expect({ ...ended, state: previous.state, supersededAt: previous.supersededAt }).toEqual(previous);
  const current = await db.projectUpdateObligation.findUniqueOrThrow({
    where: { id: reassessed.obligation!.id },
  });
  expect(current.policyRevision).toBe(2);
  expect(current.cycleHash).toBe(previous.cycleHash);
  expect(current.policyRevisionId).not.toBe(previous.policyRevisionId);
  const repeatedAfter = await updates.assess(administrator, project.id, randomUUID());
  expect(repeatedAfter.obligation!.id).toBe(current.id);
  expect((await db.projectUpdateObligation.findUniqueOrThrow({
    where: { id: current.id },
  })).assessmentId).toBe(current.assessmentId);
});
