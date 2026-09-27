import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseHealthAssessmentRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Blocker threshold tests require an isolated synthetic database");
const db = createDatabase(url);
const repository = new DatabaseHealthAssessmentRepository(db);
const customerId = randomUUID();
const administrator: Actor = {
  subject: "threshold-admin-" + randomUUID(),
  customerId,
  roles: ["pmo_admin"],
};
const manager: Actor = {
  subject: "threshold-manager-" + randomUUID(),
  customerId,
  roles: ["project_manager"],
};
afterAll(async () => {
  await db.$disconnect();
});

describe("EXEC-011 customer blocker-age threshold persistence", () => {
  it("requires a customer PMO administrator and records each finite retention window", async () => {
    await db.customer.create({
      data: { id: customerId, name: "Blocker threshold fixture" },
    });
    expect(await repository.blockerAgeThresholdPolicy(administrator)).toBeNull();
    await expect(repository.blockerAgeThresholdPolicy(manager)).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(
      repository.setBlockerAgeThresholdPolicy(
        manager,
        {
          expectedRevision: 0,
          minimumBlockerAgeDays: 30,
          auditRetentionHours: 720,
        },
        randomUUID(),
      ),
    ).rejects.toThrow("FORBIDDEN");

    const first = await repository.setBlockerAgeThresholdPolicy(
      administrator,
      {
        expectedRevision: 0,
        minimumBlockerAgeDays: 30,
        auditRetentionHours: 720,
      },
      randomUUID(),
    );
    expect(first).toMatchObject({
      minimumBlockerAgeDays: 30,
      auditRetentionHours: 720,
      revision: 1,
      changedBy: administrator.subject,
    });
    await expect(
      repository.setBlockerAgeThresholdPolicy(
        administrator,
        {
          expectedRevision: 0,
          minimumBlockerAgeDays: 15,
          auditRetentionHours: 96,
        },
        randomUUID(),
      ),
    ).rejects.toThrow("CONFLICT");

    const second = await repository.setBlockerAgeThresholdPolicy(
      administrator,
      {
        expectedRevision: 1,
        minimumBlockerAgeDays: 15,
        auditRetentionHours: 96,
      },
      randomUUID(),
    );
    expect(second).toMatchObject({
      minimumBlockerAgeDays: 15,
      auditRetentionHours: 96,
      revision: 2,
    });
    expect(await repository.blockerAgeThresholdPolicy(administrator)).toEqual(second);
    expect(
      await repository.blockerAgeThresholdPolicy({
        ...administrator,
        customerId: "10000000-0000-4000-8000-000000000099",
      }),
    ).toBeNull();

    const events = await db.auditEvent.findMany({
      where: {
        customerId,
        event: "health.blocker_age.threshold.changed",
      },
      orderBy: { occurredAt: "asc" },
    });
    expect(events).toHaveLength(2);
    const details = events
      .map((event) => event.detail as unknown as Record<string, unknown>)
      .sort((a, b) => Number(a.revision) - Number(b.revision));
    expect(details).toEqual([
      {
        objectType: "BlockerAgeThresholdPolicy",
        objectId: customerId,
        minimumBlockerAgeDays: 30,
        auditRetentionHours: 720,
        revision: 1,
      },
      {
        objectType: "BlockerAgeThresholdPolicy",
        objectId: customerId,
        minimumBlockerAgeDays: 15,
        auditRetentionHours: 96,
        revision: 2,
      },
    ]);
    await expect(
      db.$executeRawUnsafe(
        'DELETE FROM public."AuditEvent" WHERE "customerId"=$1::uuid AND event=\'health.blocker_age.threshold.changed\'',
        customerId,
      ),
    ).rejects.toThrow();
    await expect(
      db.$queryRawUnsafe(
        "SELECT public.purge_expired_blocker_age_threshold_audit_events()",
      ),
    ).rejects.toThrow();
  });
});
