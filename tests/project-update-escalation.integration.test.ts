// EXEC-020 / FR-ESC-005, NFR-SEC-001/005. Real protected views; no delivery claim.
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase, DatabaseProjectUpdateRepository, DatabaseProjectFactRepository } from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
    !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Escalation history requires an isolated synthetic database");
const db = createDatabase(url);
type Capture = { requestId: string; stageId: string; generation: number; recipientRole: "OWNER" | "PROJECT_MANAGER";
  locator: string; capturedAt: string; body: string };
type Fixture = { customerId: string; projectId: string; admin: Actor; owner: Actor; pm: Actor;
  service: string; zones: unknown; configuration: unknown; readers: string[];
  sourceA: { sourceId: string }; sourceB: { sourceId: string }; sourceMarkerA: string; sourceMarkerB: string;
  privateResponse: string; request: Capture; reminder: Capture; secondReminder: Capture;
  ownerEscalation: Capture; escalation: Capture; olderCycle: Capture[]; engagementId: string };
let f: Fixture;
beforeAll(() => {
  const path = resolve(process.env.PDAA_ESCALATION_FIXTURE_PATH ?? "missing-escalation-fixture");
  if (!path.startsWith(resolve("tmp") + sep)) throw new Error("Use the native harness's retained private escalation fixture");
  f = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  expect(f.customerId).toBe(process.env.PDAA_ESCALATION_CUSTOMER_ID);
  expect(f.customerId).not.toBe(process.env.CUSTOMER_ID);
  expect(f.reminder.capturedAt).toBe(f.request.capturedAt);
  expect(f.reminder.requestId < f.request.requestId).toBe(true);
});
afterAll(async () => { await db.$disconnect(); });

type Seam = { clock?: Date; rows?: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  noSourceABodies?: boolean; noWorkAfterBound?: boolean; contextCalls?: number;
  sourceABodyQueries?: number; responseRequestIds?: string[] };
function repository(seam: Seam = {}) {
  let contextStarted = false;
  const originIds = new Set([f.request.requestId, f.reminder.requestId, f.secondReminder.requestId, f.ownerEscalation.requestId]);
  const sourceARequests = new Set([f.request.requestId, f.reminder.requestId, f.secondReminder.requestId]);
  const database = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
      return operation(new Proxy(tx, { get(target, key) {
        if (key === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
          if (/FROM public\."ProjectUpdateResponse" r/.test(query)) {
            const requestId = String(values.at(-1));
            (seam.responseRequestIds ??= []).push(requestId);
            if (originIds.has(requestId)) throw new Error("Historical origin responses must not be queried");
          }
          if (query === "SELECT date_trunc('milliseconds',clock_timestamp()) AS now" && seam.clock)
            return [{ now: seam.clock }];
          if (query.startsWith("SELECT c.body FROM") && sourceARequests.has(String(values.at(-1)))) {
            seam.sourceABodyQueries = (seam.sourceABodyQueries ?? 0) + 1;
            if (seam.noSourceABodies) throw new Error("Restricted origin bodies must not be queried");
          }
          if (contextStarted && seam.noWorkAfterBound && (query.startsWith("WITH d AS") || query.startsWith("SELECT c.body FROM")))
            throw new Error("The bound must precede origin disclosure work");
          const rows = await target.$queryRawUnsafe(query, ...values);
          if (query.startsWith("WITH pm AS")) {
            contextStarted = true;
            seam.contextCalls = (seam.contextCalls ?? 0) + 1;
            return seam.rows ? seam.rows(rows as Array<Record<string, unknown>>) : rows;
          }
          return rows;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } }));
    }, options as never) };
  return new DatabaseProjectUpdateRepository(database as never, f.service, f.zones as never,
    () => ({ globalShadowMode: "false", configuration: f.configuration }));
}

async function sourceReaders(readers: string[]) {
  const access = await db.factSourceAccess.findUniqueOrThrow({ where: { sourceId: f.sourceA.sourceId } });
  await new DatabaseProjectFactRepository(db).setSourceAccess(f.admin,
    { projectId: f.projectId, sourceId: f.sourceA.sourceId, expectedRevision: access.revision,
      state: "AVAILABLE", readers }, { correlationId: randomUUID() });
}

it("returns the exact real request/reminder cycle including equal-clock lower UUID history", async () => {
  const view = await repository().invitation(f.pm, f.escalation.locator);
  const context = view.escalationContext!;
  expect(context.state).toBe("AVAILABLE");
  expect(context.impact).toBe("UNKNOWN");
  expect(context.originalRequestId).toBe(f.request.requestId);
  expect(context.entries.map((entry) => entry.requestId)).toEqual([
    f.request.requestId, f.reminder.requestId, f.secondReminder.requestId, f.ownerEscalation.requestId,
  ]);
  expect(context.entries.map((entry) => entry.stageId)).toEqual([
    f.request.stageId, f.reminder.stageId, f.secondReminder.stageId, f.ownerEscalation.stageId,
  ]);
  expect(context.entries[0].capturedAt).toBe(context.entries[1].capturedAt);
  expect(context.entries[1].requestId < context.entries[0].requestId).toBe(true);
  expect(context.entries[0].body).toContain(f.sourceMarkerA);
  expect(context.entries[3].body).toContain(f.sourceMarkerB);
  expect(view.body).toContain(f.sourceMarkerB);
  expect(view.body).not.toContain(f.sourceMarkerA);
  expect(JSON.stringify(context)).not.toMatch(/contentDigest|reviewerSubjects|recipientPath|responses/);
  expect(JSON.stringify(context)).not.toContain(f.admin.subject);
  expect(JSON.stringify(view)).not.toContain(f.privateResponse);
  expect(view.responses.map((entry) => entry.text)).toEqual(["PM own unconfirmed reply"]);
});

it("selects the latest real same-engagement anchor and excludes the older captured generation", async () => {
  expect(f.olderCycle).toHaveLength(5);
  const rows = await db.projectUpdateStage.findMany({ where: {
    customerId: f.customerId, projectId: f.projectId, engagementId: f.engagementId,
  }, select: { id: true, generation: true, policyRevision: true } });
  expect(rows.filter((row) => row.generation === 1)).toHaveLength(5);
  expect(rows.filter((row) => row.generation === 2)).toHaveLength(5);
  expect(rows.every((row) => row.policyRevision === 1)).toBe(true);
  expect((await db.projectUpdateEngagement.findUniqueOrThrow({ where: { id: f.engagementId } })).generation).toBe(2);
  const olderCaptured = await db.projectUpdateCapturedRequest.findMany({ where: {
    customerId: f.customerId, projectId: f.projectId,
    stageId: { in: rows.filter((row) => row.generation === 1).map((row) => row.id) },
  }, select: { id: true } });
  expect(olderCaptured.map((row) => row.id).sort()).toEqual(f.olderCycle.map((entry) => entry.requestId).sort());
  const view = await repository().invitation(f.pm, f.escalation.locator);
  expect(view.escalationContext?.state).toBe("AVAILABLE");
  expect(view.escalationContext?.originalRequestId).toBe(f.request.requestId);
  expect(view.escalationContext?.entries.map((entry) => [entry.requestId, entry.generation])).toEqual([
    [f.request.requestId, 2], [f.reminder.requestId, 2], [f.secondReminder.requestId, 2], [f.ownerEscalation.requestId, 2],
  ]);
  const visible = new Set(view.escalationContext?.entries.map((entry) => entry.requestId));
  expect(f.olderCycle.every((entry) => !visible.has(entry.requestId))).toBe(true);
  expect(Date.parse(f.ownerEscalation.capturedAt)).toBeGreaterThan(Date.parse(f.escalation.capturedAt));
  expect(view.escalationContext?.entries.at(-1)?.capturedAt).toBe(f.ownerEscalation.capturedAt);
  const oldPm = f.olderCycle.find((entry) => entry.recipientRole === "PROJECT_MANAGER");
  expect(oldPm).toBeDefined();
  const seam: Seam = { contextCalls: 0 };
  // Both epoch and generation fencing deny an old locator before context work.
  await expect(repository(seam).invitation(f.pm, oldPm!.locator)).rejects.toMatchObject({ code: "DENIED" });
  expect(seam.contextCalls).toBe(0);
});

it("retains owner response access with null context on requests and non-PM escalations", async () => {
  // Owner reads intentionally retain their own response query, unlike added PM-origin projection.
  const direct = new DatabaseProjectUpdateRepository(db, f.service, f.zones as never,
    () => ({ globalShadowMode: "false", configuration: f.configuration }));
  const owner = await direct.invitation(f.owner, f.request.locator);
  expect(owner.escalationContext).toBeNull();
  expect(owner.responses.map((entry) => entry.text)).toContain(f.privateResponse);
  expect((await direct.invitation(f.owner, f.ownerEscalation.locator)).escalationContext).toBeNull();
});

it.each(["PM", "OWNER"])("redacts historical source A revoked for %s while own source B remains readable", async (who) => {
  const subject = who === "PM" ? f.pm.subject : f.owner.subject;
  const seam: Seam = { noSourceABodies: true, sourceABodyQueries: 0 };
  try {
    await sourceReaders(f.readers.filter((reader) => reader !== subject));
    const view = await repository(seam).invitation(f.pm, f.escalation.locator);
    expect(seam.sourceABodyQueries).toBe(0);
    expect(seam.responseRequestIds).toEqual([f.escalation.requestId]);
    expect(view.responses.map((entry) => entry.text)).toEqual(["PM own unconfirmed reply"]);
    expect(view.body).toContain(f.sourceMarkerB);
    expect(view.escalationContext?.entries.slice(0, 3).map((entry) => entry.contentState))
      .toEqual(["RESTRICTED", "RESTRICTED", "RESTRICTED"]);
    expect(view.escalationContext?.entries[3].body).toContain(f.sourceMarkerB);
    expect(JSON.stringify(view)).not.toContain(f.sourceMarkerA);
    expect(JSON.stringify(view)).not.toContain(f.privateResponse);
  } finally { await sourceReaders(f.readers); }
});

it.each(["PM", "OWNER"])("keeps whole-view current %s grant denial ahead of history projection", async (who) => {
  const actor = who === "PM" ? f.pm : f.owner;
  const grant = await db.accessGrant.findFirstOrThrow({ where: {
    customerId: f.customerId, subject: actor.subject, scopeType: "project", scopeId: f.projectId,
  } });
  const seam: Seam = { contextCalls: 0 };
  try {
    await db.accessGrant.delete({ where: { id: grant.id } });
    await expect(repository(seam).invitation(f.pm, f.escalation.locator)).rejects.toMatchObject({ code: "DENIED" });
    expect(seam.contextCalls).toBe(0);
  } finally { await db.accessGrant.create({ data: grant }); }
});

it("withholds expired origin bodies at read-as-of while the newer PM invitation remains valid", async () => {
  // A read-only clock seam challenges retention without altering stored birth times or scheduler rules.
  const clock = new Date(Math.max(...[f.request, f.reminder, f.secondReminder]
    .map((entry) => Date.parse(entry.capturedAt))) + 86401000);
  const seam: Seam = { clock, noSourceABodies: true, sourceABodyQueries: 0 };
  const view = await repository(seam).invitation(f.pm, f.escalation.locator);
  expect(seam.sourceABodyQueries).toBe(0);
  expect(view.escalationContext?.asOf).toBe(clock.toISOString());
  expect(view.escalationContext?.entries.slice(0, 3).map((entry) => entry.contentState))
    .toEqual(["EXPIRED", "EXPIRED", "EXPIRED"]);
  expect(view.escalationContext?.entries.slice(0, 3).every((entry) => entry.body === null)).toBe(true);
  expect(view.escalationContext?.entries[3].contentState).toBe("PRESENT");
  expect(view.body).toContain(f.sourceMarkerB);
});

it("does not read historical origin replies or mutate facts, messages, lineage and attempts", async () => {
  const snapshot = async () => Promise.all([
    db.projectFactVersion.findMany({ where: { customerId: f.customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    db.projectUpdateCapturedRequest.findMany({ where: { customerId: f.customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    db.projectUpdateRequestContent.findMany({ where: { customerId: f.customerId, projectId: f.projectId }, orderBy: { requestId: "asc" } }),
    db.projectUpdateOutbox.findMany({ where: { customerId: f.customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
    db.projectUpdateDispatchAttempt.findMany({ where: { customerId: f.customerId, projectId: f.projectId }, orderBy: { id: "asc" } }),
  ]);
  const before = await snapshot();
  const seam: Seam = { sourceABodyQueries: 0 };
  const view = await repository(seam).invitation(f.pm, f.escalation.locator);
  expect(seam.sourceABodyQueries).toBe(3);
  expect(seam.responseRequestIds).toEqual([f.escalation.requestId]);
  expect(view.responses).toHaveLength(1); // Its own reply remains available.
  expect(view.escalationContext?.entries).toHaveLength(4);
  expect(await snapshot()).toEqual(before);
});

it("arms the historical body and response query seams with positive controls", async () => {
  const bodySeam: Seam = { noSourceABodies: true, sourceABodyQueries: 0 };
  await expect(repository(bodySeam).invitation(f.pm, f.escalation.locator)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(bodySeam.sourceABodyQueries).toBe(1);
  // The real owner is allowed to read its own reply; this deliberate test-only guard must catch that query.
  const responseSeam: Seam = {};
  await expect(repository(responseSeam).invitation(f.owner, f.request.locator)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(responseSeam.responseRequestIds).toEqual([f.request.requestId]);
});

it("returns unavailable for a missing anchor before attempting any origin disclosure", async () => {
  const view = await repository({ rows: () => [], noWorkAfterBound: true }).invitation(f.pm, f.escalation.locator);
  expect(view.escalationContext).toMatchObject({ state: "UNAVAILABLE", originalRequestId: null, entries: [] });
});

it("bounds twenty-one rows before origin work and admits a complete twenty-row projection", async () => {
  const expand = (count: number) => (rows: Array<Record<string, unknown>>) => {
    const anchor = rows[0];
    const ids = Array.from({ length: count - 1 }, () => randomUUID()).sort();
    return [anchor, ...ids.map((requestId, index) => ({ ...anchor, requestId, stageId: randomUUID(),
      stageKind: "REMINDER", ordinal: index + 1 }))];
  };
  const overflow = await repository({ rows: expand(21), noWorkAfterBound: true }).invitation(f.pm, f.escalation.locator);
  expect(overflow.escalationContext).toMatchObject({ state: "UNAVAILABLE", entries: [] });
  const admitted = await repository({ rows: expand(20) }).invitation(f.pm, f.escalation.locator);
  expect(admitted.escalationContext?.state).toBe("AVAILABLE");
  expect(admitted.escalationContext?.entries).toHaveLength(20);
});

it("excludes genuine captured rows belonging to other projects", async () => {
  // The harness prepares a separate protected project in this fixture's isolated customer.
  const unrelated = await db.projectUpdateCapturedRequest.findMany({
    where: { customerId: f.customerId, projectId: { not: f.projectId } }, select: { id: true },
  });
  expect(unrelated.length).toBeGreaterThan(0);
  const view = await repository().invitation(f.pm, f.escalation.locator);
  expect(view.escalationContext?.state).toBe("AVAILABLE");
  expect(view.escalationContext?.entries.map((entry) => entry.requestId)).toEqual([
    f.request.requestId, f.reminder.requestId, f.secondReminder.requestId, f.ownerEscalation.requestId,
  ]);
  const visible = new Set(view.escalationContext?.entries.map((entry) => entry.requestId));
  expect(unrelated.every((row) => !visible.has(row.id))).toBe(true);
});
