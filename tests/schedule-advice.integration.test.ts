import { afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  DatabaseCanonicalProjectRepository,
  DatabaseHealthAssessmentRepository,
} from "../packages/data/dist/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Schedule advice tests require an isolated synthetic database");
const customerId = process.env.CUSTOMER_ID!;
const db = createDatabase(url);
const canonical = new DatabaseCanonicalProjectRepository(db);
const health = new DatabaseHealthAssessmentRepository(db);
afterAll(async () => { await db.$disconnect(); });

it("recomputes schedule-only advice for current assigned PMs and scoped leaders without writes", async () => {
  const portfolioId = randomUUID();
  const pm: Actor = { customerId, subject: `advice-pm-${randomUUID()}`, roles: ["portfolio_manager", "project_manager"] };
  const leader: Actor = { customerId, subject: `advice-leader-${randomUUID()}`, roles: ["leadership"] };
  const unassigned: Actor = { customerId, subject: `advice-other-${randomUUID()}`, roles: ["project_manager"] };
  const secondPm: Actor = { customerId, subject: `advice-second-${randomUUID()}`, roles: ["project_manager", "leadership"] };
  const dual: Actor = { customerId, subject: `advice-dual-${randomUUID()}`, roles: ["project_manager", "leadership"] };
  const admin: Actor = { customerId, subject: `advice-admin-${randomUUID()}`, roles: ["pmo_admin"] };
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Advice fixture" } });
  const hiddenPortfolioId = randomUUID(), hiddenProjectId = randomUUID();
  await db.portfolio.create({ data: { id: hiddenPortfolioId, customerId, name: "Other advice fixture" } });
  await db.project.create({ data: {
    id: hiddenProjectId, customerId, portfolioId: hiddenPortfolioId, code: `HID-${randomUUID().slice(0, 8)}`,
    name: "Unshared project", description: "Synthetic hidden project", reportedStatus: "UNKNOWN",
  } });
  await db.accessGrant.create({ data: {
    customerId, subject: pm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "portfolio_manager",
  } });
  const input = canonicalFixture(portfolioId);
  input.code = `ADV-${randomUUID().slice(0, 8)}`;
  input.responsibilities = input.responsibilities.map((item: { role: string; subject: string }) =>
    item.role === "PROJECT_MANAGER" ? { ...item, subject: pm.subject } : item,
  );
  input.responsibilities.push({ role: "PROJECT_MANAGER", subject: secondPm.subject, displayName: "Second synthetic manager" });
  const projectId = (await canonical.createProject(pm, input, randomUUID())).id;
  await db.accessGrant.createMany({ data: [
    { customerId, subject: pm.subject, scopeType: "project", scopeId: projectId, role: "project_manager" },
    { customerId, subject: leader.subject, scopeType: "project", scopeId: projectId, role: "leadership" },
    { customerId, subject: unassigned.subject, scopeType: "project", scopeId: projectId, role: "project_manager" },
    { customerId, subject: secondPm.subject, scopeType: "project", scopeId: projectId, role: "project_manager" },
    { customerId, subject: secondPm.subject, scopeType: "portfolio", scopeId: portfolioId, role: "leadership" },
    { customerId, subject: dual.subject, scopeType: "project", scopeId: projectId, role: "leadership" },
    { customerId, subject: admin.subject, scopeType: "project", scopeId: projectId, role: "pmo_admin" },
  ] });
  // Exercise the repository under the production API role, not the fixture owner.
  // The child tables intentionally have no UPDATE privilege for row locking.
  let apiTransactions = 0;
  const apiRoleDatabase = {
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api");
        const identity = await tx.$queryRawUnsafe<{ role: string; responsibility: boolean; milestone: boolean; workItem: boolean }[]>(
          `SELECT current_user AS role,
            has_any_column_privilege(current_user, 'public."ProjectResponsibility"', 'UPDATE') AS responsibility,
            has_any_column_privilege(current_user, 'public."Milestone"', 'UPDATE') AS milestone,
            has_any_column_privilege(current_user, 'public."WorkItem"', 'UPDATE') AS "workItem"`,
        );
        expect(identity[0]).toEqual({ role: "pdaa_api", responsibility: false, milestone: false, workItem: false });
        apiTransactions += 1;
        return operation(tx);
      }, options as never),
  };
  const apiHealth = new DatabaseHealthAssessmentRepository(apiRoleDatabase as never);
  const beforeAssessments = await db.healthAssessment.count({ where: { customerId, projectId } });
  const beforeAudits = await db.auditEvent.count({ where: { customerId } });
  const pmView = await health.scheduleSuggestions(pm, projectId);
  const leadershipView = await health.scheduleSuggestions(leader, projectId);
  const apiPmView = await apiHealth.scheduleSuggestions(pm, projectId);
  const apiLeaderView = await apiHealth.scheduleSuggestions(leader, projectId);
  expect(apiPmView).toMatchObject({ projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY" });
  expect(apiLeaderView).toMatchObject({ projectId, audience: "leadership", coverage: "SCHEDULE_ONLY" });
  expect(apiPmView.items.length).toBeGreaterThan(0);
  expect(apiLeaderView.items.length).toBeGreaterThan(0);
  expect(apiTransactions).toBe(2);
  await expect(apiHealth.scheduleSuggestions(unassigned, projectId)).rejects.toMatchObject({ code: "DENIED" });
  expect(pmView).toMatchObject({ projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", approvalItems: "UNAVAILABLE" });
  expect(leadershipView.audience).toBe("leadership");
  expect((await health.scheduleSuggestions(secondPm, projectId)).audience).toBe("project_manager");
  expect((await health.scheduleSuggestions(dual, projectId)).audience).toBe("leadership");
  expect(pmView.items.some((item) => item.category === "SCHEDULE_REVIEW")).toBe(true);
  await expect(health.scheduleSuggestions(unassigned, projectId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(health.scheduleSuggestions(admin, projectId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(health.scheduleSuggestions(pm, hiddenProjectId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(health.scheduleSuggestions({ ...leader, roles: ["project_manager"] }, projectId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(health.scheduleSuggestions({ ...leader, customerId: randomUUID() }, projectId)).rejects.toMatchObject({ code: "DENIED" });
  expect(await db.healthAssessment.count({ where: { customerId, projectId } })).toBe(beforeAssessments);
  expect(await db.auditEvent.count({ where: { customerId } })).toBe(beforeAudits);
  await health.setScheduleHealthPolicy(admin, projectId, {
    expectedRevision: 0,
    timeZone: "UTC",
    defaultMinimumOverdueDays: 3650,
    targetOverrides: [],
  }, randomUUID());
  const afterPolicy = await health.scheduleSuggestions(pm, projectId);
  expect(afterPolicy.items.some((item) => item.category === "SCHEDULE_REVIEW")).toBe(false);

  // Hold the same policy lock as a writer. The reader must wait, then use
  // the committed policy and a database timestamp taken after that wait.
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { locked = resolve; });
  let changedAt: Date | undefined;
  const writer = db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM public."Project" WHERE "customerId"=$1::uuid AND id=$2::uuid FOR SHARE', customerId, projectId);
    await tx.$queryRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
      `schedule-health-policy:${customerId}:${projectId}`,
    );
    locked();
    await gate;
    const rows = await tx.$queryRawUnsafe<{ now: Date }[]>("SELECT date_trunc('milliseconds',clock_timestamp()) AS now");
    changedAt = rows[0]!.now;
    await tx.$executeRawUnsafe(
      'INSERT INTO public."ScheduleHealthPolicyRevision" (id,"customerId","projectId",revision,"timeZone","defaultMinimumOverdueDays","targetOverrides","changedBy","changedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,2,\'UTC\',1,\'[]\'::jsonb,$4,$5)',
      randomUUID(), customerId, projectId, admin.subject, changedAt,
    );
  }, { timeout: 10000 });
  await Promise.race([ready, writer.then(() => { throw new Error("Policy writer exited before locking"); })]);
  let settled = false;
  const pending = apiHealth.scheduleSuggestions(pm, projectId);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  let settledBeforeRelease: boolean;
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    settledBeforeRelease = settled;
  } finally {
    release();
    await writer;
  }
  expect(settledBeforeRelease).toBe(false);
  const afterConcurrentPolicy = await pending;
  expect(Date.parse(afterConcurrentPolicy.asOf)).toBeGreaterThanOrEqual(changedAt!.getTime());
  expect(afterConcurrentPolicy.items.some((item) => item.category === "SCHEDULE_REVIEW")).toBe(true);

  await db.accessGrant.deleteMany({ where: { customerId, subject: leader.subject, scopeType: "project", scopeId: projectId } });
  await expect(apiHealth.scheduleSuggestions(leader, projectId)).rejects.toMatchObject({ code: "DENIED" });
});
