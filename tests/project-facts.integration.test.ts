import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseProjectFactRepository,
} from "../packages/data/dist/index.js";
import type { Actor, HumanStatement } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Fact tests require an isolated synthetic database");
const db = createDatabase(url);
const otherConnection = createDatabase(url);
const facts = new DatabaseProjectFactRepository(db);
const customerId = process.env.CUSTOMER_ID!;
const context = { correlationId: "project-fact-integration" };
afterAll(async () => {
  await db.$disconnect();
  await otherConnection.$disconnect();
});
async function fixture() {
  const portfolioId = randomUUID(),
    projectId = randomUUID();
  await db.portfolio.create({
    data: { id: portfolioId, customerId, name: "Fact fixture" },
  });
  await db.project.create({
    data: {
      id: projectId,
      customerId,
      portfolioId,
      code: "FACT-" + projectId,
      name: "Fact fixture",
      description: "Synthetic",
      reportedStatus: "UNKNOWN",
    },
  });
  const manager: Actor = {
    subject: "pm-" + randomUUID(),
    customerId,
    roles: ["project_manager"],
  };
  const second: Actor = {
    subject: "second-" + randomUUID(),
    customerId,
    roles: ["project_manager"],
  };
  const administrator: Actor = {
    subject: "pmo-" + randomUUID(),
    customerId,
    roles: ["pmo_admin"],
  };
  const leader: Actor = {
    subject: "leader-" + randomUUID(),
    customerId,
    roles: ["leadership"],
  };
  for (const actor of [manager, second, administrator, leader])
    await db.accessGrant.create({
      data: {
        customerId,
        subject: actor.subject,
        scopeType: "project",
        scopeId: projectId,
        role: actor.roles[0]!,
      },
    });
  const request: HumanStatement = {
    projectId,
    factType: "project.forecast",
    expectedRevision: 0,
    idempotencyKey: "initial",
    value: { type: "date", value: "2026-10-01" },
    effectiveAt: "2026-09-09T00:00:00.000Z",
    originalStatement: "Sensitive original forecast statement",
  };
  return {
    projectId,
    portfolioId,
    manager,
    second,
    administrator,
    leader,
    request,
  };
}
async function counts(projectId: string) {
  return {
    facts: await db.projectFact.count({ where: { projectId } }),
    sources: await db.factSource.count({ where: { projectId } }),
    evidence: await db.factEvidence.count({ where: { projectId } }),
    versions: await db.projectFactVersion.count({ where: { projectId } }),
    receipts: await db.factAppendReceipt.count({ where: { projectId } }),
  };
}
async function blocked(query: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const rows = await otherConnection.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND wait_event_type='Lock' AND query LIKE ${"%" + query + "%"}`;
    if (rows[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected PostgreSQL lock contention was not observed");
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe("Project fact persistence and current permission boundaries", () => {
  it("INT-EVD-001 partial: appends durable versions and distinct author streams without overwriting history", async () => {
    const f = await fixture();
    const before = Date.now();
    const first = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    const second = await facts.appendHumanStatement(
      f.manager,
      {
        ...f.request,
        expectedRevision: 1,
        idempotencyKey: "later",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        value: { type: "text", value: "late observation" },
      },
      context,
    );
    const alternative = await facts.appendHumanStatement(
      f.second,
      {
        ...f.request,
        expectedRevision: 2,
        idempotencyKey: "initial",
        value: { type: "boolean", value: false },
      },
      context,
    );
    expect(second.entry.sourceId).toBe(first.entry.sourceId);
    expect(alternative.entry.sourceId).not.toBe(first.entry.sourceId);
    expect(
      new Set([
        first.entry.evidenceId,
        second.entry.evidenceId,
        alternative.entry.evidenceId,
      ]).size,
    ).toBe(3);
    expect(first.entry.visibility).toBe("available");
    if (first.entry.visibility !== "available") throw new Error();
    expect(first.entry.content).toMatchObject({
      value: f.request.value,
      originalStatement: f.request.originalStatement,
      providedBy: f.manager.subject,
      provenance: "HUMAN_CONFIRMED",
    });
    expect(Date.parse(first.entry.content.observedAt)).toBeGreaterThanOrEqual(
      before,
    );
    expect(Date.parse(first.entry.content.observedAt)).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(first.entry.content.confirmedAt).toBe(
      first.entry.content.observedAt,
    );
    expect(first.entry.content.source.revision).toBe(first.entry.evidenceId);
    const freshRepository = new DatabaseProjectFactRepository(otherConnection);
    const history = await freshRepository.getHistory(f.manager, {
      projectId: f.projectId,
      factType: f.request.factType,
    });
    expect(history!.entries.map((entry) => entry.revision)).toEqual([1, 2, 3]);
    expect(history!.entries[0]).toEqual(first.entry);
    expect(history!.entries[2]!.visibility).toBe("restricted");
    expect(await counts(f.projectId)).toEqual({
      facts: 1,
      sources: 2,
      evidence: 3,
      versions: 3,
      receipts: 3,
    });
  });
  it("serializes identical retries and binds the actor/project key to a normalized body", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([
      facts.appendHumanStatement(f.manager, f.request, context),
      facts.appendHumanStatement(
        f.manager,
        { ...f.request, validUntil: null },
        context,
      ),
    ]);
    expect(a.entry).toEqual(b.entry);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const before = await counts(f.projectId);
    await expect(
      facts.appendHumanStatement(
        f.manager,
        {
          ...f.request,
          originalStatement: "different body",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await counts(f.projectId)).toEqual(before);
    const audit = await db.auditEvent.findMany({
      where: { actor: f.manager.subject },
    });
    expect(audit.filter((row) => row.event === "fact.appended")).toHaveLength(
      1,
    );
    expect(audit.some((row) => row.event === "fact.append.denied")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(f.request.originalStatement);
    expect(JSON.stringify(audit)).not.toContain("2026-10-01");
  });
  it("allows one optimistic winner and rolls back the losing append completely", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      facts.appendHumanStatement(f.manager, f.request, context),
      facts.appendHumanStatement(
        f.manager,
        { ...f.request, idempotencyKey: "competing" },
        context,
      ),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find((row) => row.status === "rejected")).toMatchObject({
      reason: { code: "REVISION_CONFLICT" },
    });
    expect(await counts(f.projectId)).toEqual({
      facts: 1,
      sources: 1,
      evidence: 1,
      versions: 1,
      receipts: 1,
    });
  });
  it("requires one matching business role and grant; global roles and unrelated scope cannot authorize", async () => {
    const f = await fixture(),
      other = await fixture();
    for (const actor of [
      { ...f.manager, roles: ["system_admin"] },
      { ...f.leader, roles: ["project_manager", "leadership"] },
      { ...f.manager, subject: "ungranted" },
      { ...f.manager, roles: ["contributor"] },
    ] as Actor[]) {
      await expect(
        facts.appendHumanStatement(actor, f.request, context),
      ).rejects.toMatchObject({ code: "DENIED" });
    }
    await expect(
      facts.appendHumanStatement(
        f.manager,
        { ...f.request, projectId: other.projectId },
        context,
      ),
    ).rejects.toMatchObject({ code: "DENIED" });
    expect(await counts(f.projectId)).toEqual({
      facts: 0,
      sources: 0,
      evidence: 0,
      versions: 0,
      receipts: 0,
    });
    expect(
      await facts.getHistory(f.manager, {
        projectId: other.projectId,
        factType: f.request.factType,
      }),
    ).toBe(null);
    await db.accessGrant.create({
      data: {
        customerId,
        subject: "portfolio-pm",
        scopeType: "portfolio",
        scopeId: f.portfolioId,
        role: "project_manager",
      },
    });
    await expect(
      facts.appendHumanStatement(
        { ...f.manager, subject: "portfolio-pm" },
        f.request,
        context,
      ),
    ).resolves.toMatchObject({ replayed: false });
  });
  it("rechecks evidence permission for history and idempotent replay, without restoring a removed reader", async () => {
    const f = await fixture();
    const first = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    const query = { projectId: f.projectId, factType: f.request.factType };
    const restricted = await facts.getHistory(f.leader, query);
    expect(restricted!.entries[0]).not.toHaveProperty("content");
    const change = {
      projectId: f.projectId,
      sourceId: first.entry.sourceId,
      expectedRevision: first.entry.sourceAccessRevision,
      state: "AVAILABLE" as const,
      readers: [f.manager.subject, f.leader.subject],
    };
    await expect(
      facts.setSourceAccess(f.manager, change, context),
    ).rejects.toMatchObject({ code: "DENIED" });
    const shared = await facts.setSourceAccess(
      f.administrator,
      change,
      context,
    );
    expect(
      (await facts.getHistory(f.leader, query))!.entries[0]!.visibility,
    ).toBe("available");
    const revoked = await facts.setSourceAccess(
      f.administrator,
      { ...change, expectedRevision: shared.revision, state: "REVOKED" },
      context,
    );
    const replay = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    expect(replay).toMatchObject({
      replayed: true,
      entry: {
        id: first.entry.id,
        visibility: "restricted",
        revalidationRequired: true,
      },
    });
    expect(replay.entry).not.toHaveProperty("content");
    const before = await counts(f.projectId);
    await expect(
      facts.appendHumanStatement(
        f.manager,
        { ...f.request, expectedRevision: 1, idempotencyKey: "denied-source" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    await facts.setSourceAccess(
      f.administrator,
      {
        ...change,
        expectedRevision: revoked.revision,
        readers: [f.leader.subject],
      },
      context,
    );
    await expect(
      facts.appendHumanStatement(
        f.manager,
        { ...f.request, expectedRevision: 1, idempotencyKey: "removed-reader" },
        context,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_RESTRICTED" });
    expect(await counts(f.projectId)).toEqual(before);
    expect(
      await db.factSourceReader.count({
        where: { sourceId: first.entry.sourceId, subject: f.manager.subject },
      }),
    ).toBe(0);
    for (const state of ["DELETED", "UNVERIFIABLE"] as const) {
      const current = await db.factSourceAccess.findUniqueOrThrow({
        where: { sourceId: first.entry.sourceId },
      });
      await facts.setSourceAccess(
        f.administrator,
        { ...change, expectedRevision: current.revision, state },
        context,
      );
      expect(
        (await facts.getHistory(f.leader, query))!.entries[0],
      ).not.toHaveProperty("content");
    }
  });
  it("keeps historical pagination fixed while new appends arrive and retains restricted rows", async () => {
    const f = await fixture();
    for (let n = 0; n < 3; n++)
      await facts.appendHumanStatement(
        n === 2 ? f.second : f.manager,
        {
          ...f.request,
          expectedRevision: n,
          idempotencyKey: "page-" + n,
        },
        context,
      );
    const target = {
      projectId: f.projectId,
      factType: f.request.factType,
      limit: 2,
    };
    const first = await facts.getHistory(f.manager, target);
    expect(first!.next).toEqual({ afterRevision: 2, throughRevision: 3 });
    await facts.appendHumanStatement(
      f.manager,
      { ...f.request, expectedRevision: 3, idempotencyKey: "newer" },
      context,
    );
    const last = await facts.getHistory(f.manager, {
      ...target,
      ...first!.next!,
    });
    expect(last!.entries).toHaveLength(1);
    expect(last!.entries[0]).toMatchObject({
      revision: 3,
      visibility: "restricted",
    });
    expect(last!.next).toBe(null);
    expect(last!.throughRevision).toBe(3);
  });
  it.each(["delete", "role update"])(
    "a grant %s that wins its lock denies the waiting append",
    async (operation) => {
      const f = await fixture(),
        held = barrier(),
        release = barrier();
      const holder = otherConnection.$transaction(
        async (tx) => {
          if (operation === "delete")
            await tx.accessGrant.deleteMany({
              where: { customerId, subject: f.manager.subject },
            });
          else
            await tx.accessGrant.updateMany({
              where: { customerId, subject: f.manager.subject },
              data: { role: "leadership" },
            });
          held.release();
          await release.promise;
        },
        { timeout: 15000 },
      );
      await held.promise;
      const append = facts
        .appendHumanStatement(f.manager, f.request, context)
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      try {
        await blocked("AccessGrant");
      } finally {
        release.release();
      }
      await holder;
      expect(await append).toMatchObject({ error: { code: "DENIED" } });
      expect((await counts(f.projectId)).versions).toBe(0);
    },
  );
  it("an authorized append commits before a subsequent grant revocation can complete", async () => {
    const f = await fixture(),
      held = barrier(),
      release = barrier();
    const holder = otherConnection.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'LOCK TABLE "AuditEvent" IN ACCESS EXCLUSIVE MODE',
        );
        held.release();
        await release.promise;
      },
      { timeout: 15000 },
    );
    await held.promise;
    const append = facts.appendHumanStatement(f.manager, f.request, context);
    let revoke: ReturnType<typeof db.accessGrant.deleteMany> | undefined;
    try {
      await blocked("AuditEvent");
      revoke = db.accessGrant.deleteMany({
        where: { customerId, subject: f.manager.subject },
      });
      // Prisma promises are lazy; attaching a handler starts the second transaction.
      const deleting = Promise.resolve(revoke);
      await blocked("AccessGrant");
      release.release();
      await holder;
      expect((await append).replayed).toBe(false);
      await deleting;
    } finally {
      release.release();
    }
    expect(
      await facts.getHistory(f.manager, {
        projectId: f.projectId,
        factType: f.request.factType,
      }),
    ).toBe(null);
    await expect(
      facts.appendHumanStatement(f.manager, f.request, context),
    ).rejects.toMatchObject({ code: "DENIED" });
  });
  it.each(["history", "replay"] as const)(
    "a source revocation that wins its lock redacts the waiting %s",
    async (operation) => {
      const f = await fixture(),
        held = barrier(),
        release = barrier();
      const first = await facts.appendHumanStatement(
        f.manager,
        f.request,
        context,
      );
      const holder = otherConnection.$transaction(
        async (tx) => {
          if (operation === "history")
            await tx.factSourceReader.deleteMany({
              where: {
                sourceId: first.entry.sourceId,
                subject: f.manager.subject,
              },
            });
          else
            await tx.factSourceAccess.update({
              where: { sourceId: first.entry.sourceId },
              data: { state: "REVOKED", revision: { increment: 1 } },
            });
          held.release();
          await release.promise;
        },
        { timeout: 15000 },
      );
      await held.promise;
      const reading =
        operation === "history"
          ? facts
              .getHistory(f.manager, {
                projectId: f.projectId,
                factType: f.request.factType,
              })
              .then((page) => page!.entries[0]!)
          : facts
              .appendHumanStatement(f.manager, f.request, context)
              .then((result) => result.entry);
      try {
        await blocked('FROM "Project"');
      } finally {
        release.release();
      }
      await holder;
      expect(await reading).toMatchObject({
        visibility: "restricted",
        revalidationRequired: true,
      });
      expect(await reading).not.toHaveProperty("content");
    },
  );
  it.each(["history", "replay"] as const)(
    "an authorized %s completes before a later source revocation",
    async (operation) => {
      const f = await fixture(),
        held = barrier(),
        release = barrier();
      const first = await facts.appendHumanStatement(
        f.manager,
        f.request,
        context,
      );
      const holder = otherConnection.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'LOCK TABLE "ProjectFactVersion" IN ACCESS EXCLUSIVE MODE',
          );
          held.release();
          await release.promise;
        },
        { timeout: 15000 },
      );
      await held.promise;
      const reading =
        operation === "history"
          ? facts
              .getHistory(f.manager, {
                projectId: f.projectId,
                factType: f.request.factType,
              })
              .then((page) => page!.entries[0]!)
          : facts
              .appendHumanStatement(f.manager, f.request, context)
              .then((result) => result.entry);
      try {
        await blocked("ProjectFactVersion");
        const revocation =
          operation === "history"
            ? Promise.resolve(
                db.factSourceAccess.update({
                  where: { sourceId: first.entry.sourceId },
                  data: { state: "REVOKED", revision: { increment: 1 } },
                }),
              )
            : Promise.resolve(
                db.factSourceReader.deleteMany({
                  where: {
                    sourceId: first.entry.sourceId,
                    subject: f.manager.subject,
                  },
                }),
              );
        await blocked(
          operation === "history" ? "FactSourceAccess" : "FactSourceReader",
        );
        release.release();
        await holder;
        expect(await reading).toMatchObject({ visibility: "available" });
        await revocation;
      } finally {
        release.release();
      }
      const later = await facts.getHistory(f.manager, {
        projectId: f.projectId,
        factType: f.request.factType,
      });
      expect(later!.entries[0]).not.toHaveProperty("content");
    },
  );
  it("database constraints reject cross-fact/source/author evidence and evidence reuse", async () => {
    const f = await fixture(),
      other = await fixture();
    const first = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    const second = await facts.appendHumanStatement(
      other.manager,
      other.request,
      context,
    );
    const evidence = await db.factEvidence.findUniqueOrThrow({
      where: { id: first.entry.evidenceId },
    });
    for (const patch of [
      { providedBy: other.manager.subject },
      { projectId: other.projectId },
      { factId: second.factId },
      { sourceId: second.entry.sourceId },
      { customerId: randomUUID() },
    ])
      await expect(
        db.factEvidence.create({
          data: { ...evidence, id: randomUUID(), ...patch },
        }),
      ).rejects.toThrow();
    const version = await db.projectFactVersion.findUniqueOrThrow({
      where: { id: first.entry.id },
    });
    await expect(
      db.projectFactVersion.create({
        data: { ...version, id: randomUUID(), revision: 2 },
      }),
    ).rejects.toThrow();
    await expect(
      db.projectFactVersion.create({
        data: {
          ...version,
          id: randomUUID(),
          revision: 2,
          evidenceId: second.entry.evidenceId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      db.factAppendReceipt.create({
        data: {
          id: randomUUID(),
          customerId,
          projectId: f.projectId,
          subject: f.manager.subject,
          idempotencyKey: "cross-project",
          requestHash: "a".repeat(64),
          factId: first.factId,
          versionId: second.entry.id,
        },
      }),
    ).rejects.toThrow();
    expect((await counts(f.projectId)).versions).toBe(1);
  });
  it("SQL scalar checks reject malformed objects, nonfinite-range numbers and impossible dates", async () => {
    for (const value of [
      [],
      null,
      {},
      { type: "text", value: 5 },
      { type: "number", value: "1" },
      { type: "boolean", value: "true" },
      { type: "empty", value: "" },
      { type: "date", value: "2026-02-30" },
      { type: "date", value: "0000-01-01" },
      { type: "text", value: "x", extra: true },
      { type: "text", value: "x".repeat(4097) },
    ]) {
      const result = await db.$queryRawUnsafe<{ valid: boolean }[]>(
        "SELECT public.valid_project_fact_value($1::jsonb) AS valid",
        JSON.stringify(value),
      );
      expect(result[0]!.valid).toBe(false);
    }
    for (const numeric of [
      "1e309",
      "1e-400",
      "9007199254740993",
      "1.0000000000000001",
    ])
      expect(
        (
          await db.$queryRawUnsafe<{ valid: boolean }[]>(
            "SELECT public.valid_project_fact_value($1::jsonb) AS valid",
            '{"type":"number","value":' + numeric + "}",
          )
        )[0]!.valid,
      ).toBe(false);
    for (const numeric of [
      "0.1",
      "1.7976931348623157e308",
      "9007199254740992",
      "5e-324",
    ])
      expect(
        (
          await db.$queryRawUnsafe<{ valid: boolean }[]>(
            "SELECT public.valid_project_fact_value($1::jsonb) AS valid",
            '{"type":"number","value":' + numeric + "}",
          )
        )[0]!.valid,
      ).toBe(true);
  });
  it("SQL required text rejects all ECMAScript-only whitespace without trimming evidence", async () => {
    const f = await fixture();
    const first = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    const source = await db.factSource.findUniqueOrThrow({
      where: { id: first.entry.sourceId },
    });
    const evidence = await db.factEvidence.findUniqueOrThrow({
      where: { id: first.entry.evidenceId },
    });
    for (const blank of [
      "",
      "\t\n\r",
      "\u00a0",
      "\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
    ]) {
      await expect(
        db.factSource.create({
          data: { ...source, id: randomUUID(), providedBy: blank },
        }),
      ).rejects.toThrow();
      await expect(
        db.factEvidence.create({
          data: { ...evidence, id: randomUUID(), originalStatement: blank },
        }),
      ).rejects.toThrow();
      await expect(
        db.factSourceReader.create({
          data: {
            customerId,
            projectId: f.projectId,
            factId: first.factId,
            sourceId: first.entry.sourceId,
            subject: blank,
          },
        }),
      ).rejects.toThrow();
      await expect(
        db.factAppendReceipt.create({
          data: {
            customerId,
            projectId: f.projectId,
            factId: first.factId,
            versionId: first.entry.id,
            subject: blank,
            idempotencyKey: "blank",
            requestHash: "a".repeat(64),
          },
        }),
      ).rejects.toThrow();
    }
    const originalStatement = "\t \u00a0Human statement.\u3000\n";
    const next = await facts.appendHumanStatement(
      f.manager,
      {
        ...f.request,
        expectedRevision: 1,
        idempotencyKey: "preserved-whitespace",
        originalStatement,
      },
      context,
    );
    expect(next.entry.visibility).toBe("available");
    if (next.entry.visibility === "available")
      expect(next.entry.content.originalStatement).toBe(originalStatement);
  });
  it("direct reader revocation invalidates a previously captured access revision", async () => {
    const f = await fixture();
    const first = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    await db.factSourceReader.deleteMany({
      where: { sourceId: first.entry.sourceId, subject: f.manager.subject },
    });
    await expect(
      facts.setSourceAccess(
        f.administrator,
        {
          projectId: f.projectId,
          sourceId: first.entry.sourceId,
          expectedRevision: first.entry.sourceAccessRevision,
          state: "AVAILABLE",
          readers: [f.manager.subject],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      (await facts.appendHumanStatement(f.manager, f.request, context)).entry
        .visibility,
    ).toBe("restricted");
  });
  it("owner-level SQL cannot mutate retained history, rewind counters or reparent its project", async () => {
    const f = await fixture(),
      other = await fixture();
    const first = await facts.appendHumanStatement(
      f.manager,
      f.request,
      context,
    );
    const tables = [
      "FactSource",
      "FactEvidence",
      "ProjectFactVersion",
      "FactAppendReceipt",
    ];
    const before = await counts(f.projectId);
    for (const table of tables) {
      await expect(
        db.$executeRawUnsafe(
          'UPDATE "' + table + '" SET id=id WHERE "projectId"=$1::uuid',
          f.projectId,
        ),
      ).rejects.toThrow();
      await expect(
        db.$executeRawUnsafe(
          'DELETE FROM "' + table + '" WHERE "projectId"=$1::uuid',
          f.projectId,
        ),
      ).rejects.toThrow();
      await expect(
        db.$executeRawUnsafe('TRUNCATE "' + table + '" CASCADE'),
      ).rejects.toThrow();
    }
    await expect(
      db.projectFact.update({
        where: { id: first.factId },
        data: { revision: 3 },
      }),
    ).rejects.toThrow();
    await expect(
      db.projectFact.update({
        where: { id: first.factId },
        data: { factType: "renamed" },
      }),
    ).rejects.toThrow();
    await expect(
      db.factSourceAccess.update({
        where: { sourceId: first.entry.sourceId },
        data: { revision: 1, state: "REVOKED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.project.update({
        where: { id: f.projectId },
        data: { portfolioId: other.portfolioId },
      }),
    ).rejects.toThrow();
    expect(await counts(f.projectId)).toEqual(before);
    expect(
      (await facts.getHistory(f.manager, {
        projectId: f.projectId,
        factType: f.request.factType,
      }))!.entries[0],
    ).toEqual(first.entry);
  });
});
