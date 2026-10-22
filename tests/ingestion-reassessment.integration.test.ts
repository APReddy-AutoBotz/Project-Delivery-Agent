// EXEC-019 / AC-CON-004: real receipt, claim and assessment transactions.
import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase, DatabaseCanonicalProjectRepository, DatabaseIngestionRepository,
  DatabaseConnectorRuntimeRepository, DatabaseProjectUpdateRepository,
  DatabaseProjectFactRepository, DatabaseAuthorityRepository,
} from "../packages/data/dist/index.js";
import { ProjectUpdateScanCoordinator, type Claim } from "../packages/data/src/project-update-scan.js";
import { reassessmentAudit, type ReassessmentTx } from "../packages/data/src/ingestion-reassessments.js";
import { CredentialVault, CredentialKeyRingVault, signConnectorTaskRequest } from "../packages/platform/src/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { JiraRuntimeService } from "../apps/api/src/jira-runtime.js";
import { installConnectorRoutes } from "../apps/api/src/connector-routes.js";
import { canonicalFixture } from "../scripts/acceptance/canonical-projects.mjs";
import { seedReassessmentRecovery, verifyRestoredReassessments, claimReassessmentFixtureJob } from "../scripts/acceptance/ingestion-reassessment.mjs";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || process.env.NODE_ENV === "production" || process.env.DATA_MODE !== "synthetic" ||
  !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Reassessment tests require an isolated synthetic database");
const db = createDatabase(url);
afterAll(() => db.$disconnect());
const key = Buffer.alloc(32, 37).toString("base64");
const keys = { currentKeyId: "handoff", keys: { handoff: key } };

async function fixture(options: { current?: boolean; service?: string; enabled?: boolean } = {}) {
  const customerId = randomUUID(), portfolioId = randomUUID(), sourceId = randomUUID();
  const admin: Actor = { customerId, subject: "handoff-pmo-" + randomUUID(), roles: ["pmo_admin"] };
  const service = options.service ?? "handoff-scanner-" + randomUUID();
  await db.customer.create({ data: { id: customerId, name: "Synthetic handoff" } });
  await db.portfolio.create({ data: { id: portfolioId, customerId, name: "Synthetic handoff" } });
  await db.accessGrant.create({ data: { customerId, subject: admin.subject, scopeType: "portfolio", scopeId: portfolioId, role: "pmo_admin" } });
  await db.accessGrant.create({ data: { customerId, subject: admin.subject + "-sys", scopeType: "portfolio", scopeId: portfolioId, role: "system_admin" } });
  // Backdate only the creation input through the real aggregate transaction.
  const creation = { $transaction: (operation: (tx: unknown) => Promise<unknown>, txOptions: unknown) => db.$transaction(async (tx) =>
    operation(new Proxy(tx, { get(target, name) {
      if (name === "canonicalProject") return new Proxy(target.canonicalProject, { get(delegate, method) {
        if (method === "create") return (args: Parameters<typeof delegate.create>[0]) => delegate.create({ ...args,
          data: { ...args.data, createdAt: new Date(Date.now() - (options.current ? 0 : 86_400_000)) } });
        const value = Reflect.get(delegate, method); return typeof value === "function" ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
    } })), txOptions as never) };
  const { id: projectId } = await new DatabaseCanonicalProjectRepository(creation as never)
    .createProject(admin, canonicalFixture(portfolioId), randomUUID());
  const updates = new DatabaseProjectUpdateRepository(db, service, { customerId, customerTimeZone: "UTC", recipientTimeZones: [] });
  const policy = { expectedRevision: 0, freshnessWindowSeconds: options.current ? 86400 : 1,
    timeZone: "UTC", requiredFacts: [{ factType: "project.status", label: "Current status" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: options.enabled !== false,
    reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0, escalationRecipientSubject: null,
    quietHoursStartLocal: null, quietHoursEndLocal: null };
  await updates.setPolicy(admin, projectId, policy, randomUUID());
  await db.projectUpdatePolicy.updateMany({ where: { customerId, projectId },
    data: { scheduledScanNextEligibleAt: new Date(Date.now() + 86_400_000) } });
  const ingestion = new DatabaseIngestionRepository(db, new CredentialVault(key));
  const runtime = new DatabaseConnectorRuntimeRepository(db, new CredentialKeyRingVault(keys));
  await ingestion.setRetention({ ...admin, subject: admin.subject + "-sys", roles: ["system_admin"] }, { retentionHours: 24 }, randomUUID());
  const binding = { customerId, sourceId, sourceType: "jira", origin: "https://tenant.atlassian.net" };
  const configuration = { binding, projects: [{ projectId, readers: [admin.subject] }],
    mapping: { kind: "CONNECTOR", factTypes: ["jira.status"], adapterConfiguration: JSON.stringify({
      projects: [{ projectId, projectKey: "SAFE" }], fields: [{ jiraField: "status", factType: "jira.status", valueType: "text" }],
    }) } };
  await ingestion.configure(admin, configuration as never, randomUUID());
  await runtime.setOAuthCredential({ customerId, sourceId, actorSubject: admin.subject, credential: {
    cloudId: "cloud-1", selectedUrl: binding.origin, accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: ["read:jira-work", "offline_access"],
  } });
  const secret = Buffer.alloc(32, 47).toString("hex");
  await runtime.setWebhookSecret({ customerId, sourceId, actorSubject: admin.subject, secret });
  let sequence = 0, updated = new Date().toISOString();
  const provider = vi.fn(async () => ({ issues: [{ id: "95001", key: "SAFE-77", fields: {
    project: { id: "950", key: "SAFE" }, updated, status: { name: "PRIVATE PROPOSAL VALUE" },
  } }], isLast: true }));
  // Only provider transport is stubbed. Durable jobs, grants, cursor, nonce,
  // receipt, proposal, cause and assessment use their production repositories.
  const scopedRuntime = new Proxy(runtime, { get(target, name) {
    if (name === "enqueueDueJobs") return async () => [];
    const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
  } });
  const jira = new JiraRuntimeService({ CUSTOMER_ID: customerId } as never, scopedRuntime, ingestion,
    async () => new Response(JSON.stringify([{ id: "cloud-1", url: binding.origin, scopes: ["read:jira-work"] }]),
      { status: 200, headers: { "content-type": "application/json" } }),
    () => ({ getProject: async ({ projectIdOrKey }: { projectIdOrKey: string }) => ({ key: projectIdOrKey }), searchIssues: provider }) as never);
  type Handler = (req: unknown, res: unknown, next: () => void) => Promise<void>;
  let handler: Handler;
  installConnectorRoutes({ use: (fn: Handler) => { handler = fn; } } as never,
    { projectUpdateTaskKeys: keys, connectorTaskKeys: keys } as never, runtime, jira, updates);
  const invoke = async (path: string, body = Buffer.from("{}"), suppliedHeaders?: Record<string, string>) => {
    const headers = { "content-type": "application/json", ...(suppliedHeaders ?? signConnectorTaskRequest({ method: "POST", path, body, keyRing: keys })) };
    let status = 0, result: unknown;
    const response = { status(code: number) { status = code; return response; }, json(value: unknown) { result = value; } };
    await handler!({ method: "POST", path, url: path, rawBody: body, headers,
      get: (name: string) => headers[name] }, response, () => { throw new Error("Unexpected route fallthrough"); });
    return { status, result, headers };
  };
  const webhook = async (changed = true) => {
    sequence++;
    if (changed) updated = new Date(Date.now() - 60_000 + sequence).toISOString();
    const body = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated", timestamp: Date.now() + sequence }));
    const headers = { "x-atlassian-webhook-identifier": randomUUID(),
      "x-hub-signature": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") };
    const accepted = await invoke("/webhooks/jira/" + sourceId, body, headers);
    expect(accepted.status).toBe(202);
    return { body, headers, accepted };
  };
  const pump = async () => {
    let result!: Awaited<ReturnType<typeof invoke>>;
    // Each call is a genuine worker tick with a fresh signed nonce. READY jobs
    // can be briefly idle under SKIP LOCKED or app/DB clock rounding; process the
    // reset and the page across bounded ticks, then require the real commit.
    for (let tick = 0; tick < 5; tick++) {
      result = await invoke("/internal/connectors/run"); expect(result.status).toBe(200);
      const status = (result.result as { status: string }).status;
      if (status === "page_committed") break;
      if (status === "cursor_reset") continue;
      if (status === "idle") { await new Promise((resolve) => setTimeout(resolve, 20)); continue; }
      if (status === "deferred") {
        const source = await db.ingestionSource.findUniqueOrThrow({ where: { id: sourceId } });
        throw new Error("Synthetic handoff provider deferred with safe code " + source.healthCode);
      }
      break;
    }
    expect(result).toMatchObject({ status: 200, result: { status: "page_committed" } });
    return result;
  };
  const ingest = async (changed = true) => {
    const delivery = await webhook(changed);
    await pump();
    const receipt = await db.connectorWebhookReceipt.findFirstOrThrow({ where: { sourceId,
      eventId: delivery.headers["x-atlassian-webhook-identifier"] } });
    expect(await db.connectorSyncJob.findUnique({ where: { id: receipt.jobId } })).toMatchObject({ state: "COMPLETED" });
    return db.ingestionProjectReassessment.findMany({ where: { customerId, projectId }, orderBy: { createdAt: "asc" } });
  };
  return { customerId, projectId, sourceId, admin, service, policy, configuration, updates, ingestion, runtime, jira, invoke, webhook, ingest, pump, provider,
    providerRevision: () => { sequence++; updated = new Date(Date.now() - 60_000 + sequence).toISOString(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type CoordinatorAccess = {
  claim(tx: ReassessmentTx): Promise<Claim | null>;
  complete(tx: ReassessmentTx, claim: Claim): Promise<void>;
  release(tx: ReassessmentTx, claim: Claim, contention: boolean): Promise<void>;
};
function coordinator(f: Fixture) {
  const assessor = f.updates as unknown as { assessInTransaction(tx: ReassessmentTx, actor: Actor, projectId: string, correlationId: string, scheduled: boolean): Promise<never> };
  const instance = new ProjectUpdateScanCoordinator(db, f.service,
    (tx, actor, id, correlationId) => assessor.assessInTransaction(tx, actor, id, correlationId, true));
  return { instance, access: instance as unknown as CoordinatorAccess };
}
const transact = <T>(run: (tx: ReassessmentTx) => Promise<T>) => db.$transaction(run, { isolationLevel: "ReadCommitted", timeout: 20000 });
const asApi = <T>(run: (tx: ReassessmentTx) => Promise<T>) => transact(async (tx) => {
  await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return run(tx);
});
async function claim(f: Fixture) {
  const result = await transact((tx) => coordinator(f).access.claim(tx));
  expect(result).not.toBeNull(); return result!;
}
async function expireLease(f: Fixture) {
  const head = await db.projectUpdatePolicy.findFirstOrThrow({ where: { projectId: f.projectId } });
  expect(head.scanClaimUntil!.getTime() - head.scheduledScanLastAttemptAt!.getTime()).toBe(120000);
  await db.projectUpdatePolicy.updateMany({ where: { projectId: f.projectId }, data: { scanClaimUntil: new Date(0) } });
}
async function ageWaits(f: Fixture) {
  // Synthetic-owner clock fixture only. First assert production delays in each
  // caller, then simulate elapsed waiting without rewriting lineage or counters.
  // Runtime/API roles cannot set session_replication_role or bypass this guard.
  const before = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } });
  await transact(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.$executeRaw`UPDATE public."IngestionProjectReassessment" SET "availableAt"=clock_timestamp()-interval '1 second'
      WHERE "customerId"=${f.customerId}::uuid AND "projectId"=${f.projectId}::uuid AND state='READY'`;
  });
  const after = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } });
  const withoutAvailability = (rows: typeof before) => rows.map((row) => ({ ...row, availableAt: null }));
  expect(withoutAvailability(after)).toEqual(withoutAvailability(before));
  await db.projectUpdatePolicy.updateMany({ where: { projectId: f.projectId }, data: { scanFailureNextEligibleAt: new Date(0) } });
}

async function holdSource(f: Fixture) {
  let release!: () => void, held!: () => void;
  const ready = new Promise<void>((resolve) => { held = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
  const locking = transact(async (tx) => {
    await tx.$queryRaw`SELECT id FROM public."IngestionSource" WHERE id=${f.sourceId}::uuid FOR UPDATE`;
    held(); await wait;
  });
  await ready; return async () => { release(); await locking; };
}

function transactionFault(match: (sql: string) => boolean) {
  let reached = 0;
  return { get reached() { return reached; }, database: {
    $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) =>
      operation(new Proxy(tx, { get(target, name) {
        if (name === "$executeRaw" || name === "$queryRaw") return (sql: TemplateStringsArray, ...values: unknown[]) => {
          if (match(sql.join("?"))) { reached++; throw new Error("Synthetic transaction boundary failure"); }
          return target[name](sql, ...values);
        };
        const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
      } })), options as never),
  } };
}

function transactionGate(match: (sql: string) => boolean) {
  let resume!: () => void, signal!: (pid: number) => void, used = false;
  const reached = new Promise<number>((resolve) => { signal = resolve; });
  const waiting = new Promise<void>((resolve) => { resume = resolve; });
  const database = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) =>
    db.$transaction((tx) => operation(new Proxy(tx, { get(target, name) {
      const value = Reflect.get(target, name);
      if (["$executeRaw", "$queryRaw", "$executeRawUnsafe", "$queryRawUnsafe"].includes(String(name)))
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === "string" ? args[0] : (args[0] as TemplateStringsArray).join("?");
          if (!used && match(sql)) {
            used = true;
            signal((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
            await waiting;
          }
          return Reflect.apply(value, target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    } })), options as never) };
  return { database, reached, resume };
}

async function waitForBlockedBy(pid: number) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const [row] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`;
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected a real PostgreSQL lock waiter");
}

function databaseMessage(error: unknown): string {
  const value = error as { message?: string; meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } } };
  return value.meta?.driverAdapterError?.cause?.originalMessage ?? value.message ?? "";
}

async function manualPage(f: Fixture, configuration: Fixture["configuration"], sequence: number) {
  const sourceId = configuration.binding.sourceId, secret = Buffer.alloc(32, 57).toString("hex");
  await f.runtime.setWebhookSecret({ customerId: f.customerId, sourceId, actorSubject: f.admin.subject, secret });
  const rawBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated", timestamp: Date.now() + sequence }));
  const accepted = await f.runtime.acceptWebhook({ sourceId, eventId: randomUUID(), rawBody,
    signature: "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex") });
  let job = await claimReassessmentFixtureJob(f.runtime, f.customerId, accepted.jobId);
  let state = await f.ingestion.readConnectorSyncSnapshot(f.customerId, job!.jobId, job!.claimGeneration);
  if (state.resetRequired) {
    await f.ingestion.resetConnectorCursorForJob(f.customerId, job!.jobId, job!.claimGeneration);
    job = await claimReassessmentFixtureJob(f.runtime, f.customerId, accepted.jobId);
    state = await f.ingestion.readConnectorSyncSnapshot(f.customerId, job!.jobId, job!.claimGeneration);
  }
  const at = new Date().toISOString();
  await f.ingestion.persistConnectorPageForJob({ customerId: f.customerId, jobId: job!.jobId, expectedClaimGeneration: job!.claimGeneration,
    expectedConfigRevision: state.configRevision, expectedMappingRevision: state.mappingRevision,
    expectedCursorRevision: state.cursorRevision, expectedGeneration: state.generation,
    page: { binding: configuration.binding, inputCursor: null, nextCursor: null, terminal: true, records: [{
      ref: { customerId: f.customerId, sourceId, projectId: f.projectId, recordType: "jira.issue", recordId: "SAFE-1" },
      revision: String(sequence), sourceContentHash: String(sequence).padStart(64, "0"), observedAt: at, effectiveAt: at,
      deepLink: configuration.binding.origin + "/browse/SAFE-1",
      observations: [{ factType: "jira.status", value: { type: "text", value: "Private pagination proposal" } }],
    }] } });
}

it("rolls the receipt/cursor/job/page back if the atomic cause insertion fails", async () => {
  const f = await fixture(); await f.webhook();
  expect(await f.invoke("/internal/connectors/run")).toMatchObject({ result: { status: "cursor_reset" } });
  const before = await db.ingestionSource.findUniqueOrThrow({ where: { id: f.sourceId } });
  const fault = transactionFault((sql) => sql.includes('INSERT INTO public."IngestionProjectReassessment"'));
  Reflect.set(f.ingestion, "db", fault.database);
  const result = await f.invoke("/internal/connectors/run");
  Reflect.set(f.ingestion, "db", db);
  expect(fault.reached).toBe(1);
  expect(result.result).not.toMatchObject({ status: "page_committed" });
  expect(await db.ingestionOperationReceipt.count({ where: { sourceId: f.sourceId, kind: "CONNECTOR_PAGE" } })).toBe(0);
  expect(await db.ingestionSourceRevision.count({ where: { sourceId: f.sourceId } })).toBe(0);
  expect(await db.ingestionProjectReassessment.count({ where: { sourceId: f.sourceId } })).toBe(0);
  expect(await db.ingestionSource.findUnique({ where: { id: f.sourceId } })).toMatchObject({ cursorRevision: before.cursorRevision, lastSuccessReceiptId: before.lastSuccessReceiptId });
  expect(await db.connectorSyncJob.count({ where: { sourceId: f.sourceId, state: "COMPLETED" } })).toBe(0);
});

it("rolls assessment/preview/acknowledgement back together and retries only after the failure fence", async () => {
  const f = await fixture(); await f.ingest();
  const fault = transactionFault((sql) => sql.includes('UPDATE public."IngestionProjectReassessment"') && sql.includes("SET state='COMPLETED'"));
  Reflect.set(f.updates, "db", fault.database);
  await expect(f.updates.scanScheduledProjects(1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  Reflect.set(f.updates, "db", db);
  expect(fault.reached).toBe(1);
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.projectUpdatePreview.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "READY", lastReason: "FAILED", attemptCount: 1 });
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  await ageWaits(f);
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
});

it("a lost response after committed completion cannot duplicate an assessment or obligation", async () => {
  const f = await fixture(); await f.ingest();
  let transactions = 0, lost = false;
  Reflect.set(f.updates, "db", { $transaction: async (operation: (tx: ReassessmentTx) => Promise<unknown>, options: unknown) => {
    const value = await db.$transaction(operation, options as never);
    transactions++;
    if (transactions === 2) { lost = true; throw new Error("Synthetic response lost AFTER commit"); }
    return value;
  } });
  await expect(f.updates.scanScheduledProjects(1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  Reflect.set(f.updates, "db", db); expect(lost).toBe(true);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "COMPLETED", totalAttempts: 1 });
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(1);
});

it("INT-CON-004: signed webhook/task duplicates produce one cause, assessment and total obligation with exact reused lineage", async () => {
  const f = await fixture();
  const versions = await db.projectFactVersion.count({ where: { customerId: f.customerId } });
  const delivery = await f.webhook();
  expect((await f.invoke("/webhooks/jira/" + f.sourceId, delivery.body, delivery.headers)).status).toBe(202);
  expect(await f.invoke("/internal/connectors/run")).toMatchObject({ status: 200, result: { status: "cursor_reset" } });
  expect(await f.invoke("/internal/connectors/run")).toMatchObject({ status: 200, result: { status: "page_committed" } });
  const scan = await f.invoke("/internal/project-updates/scan");
  expect(scan).toMatchObject({ status: 200, result: { processed: 1 } });
  expect((await f.invoke("/internal/project-updates/scan", Buffer.from("{}"), scan.headers)).status).toBe(409);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  const [cause] = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId } });
  expect(cause).toMatchObject({ state: "COMPLETED", attemptCount: 1, totalAttempts: 1 });
  const completedHead = await db.projectUpdatePolicy.findFirstOrThrow({ where: { projectId: f.projectId } });
  expect(completedHead.scheduledScanNextEligibleAt!.getTime() - cause!.completedAt!.getTime()).toBe(3600000);
  const view = await f.updates.latest(f.admin, f.projectId);
  expect(view).toMatchObject({ freshness: { state: "STALE", sourceDateField: "project.createdAt" },
    obligation: { id: cause!.obligationId }, preview: { id: cause!.previewId } });
  expect(await db.projectUpdatePreview.findUnique({ where: { id: cause!.previewId! } })).toMatchObject({ assessmentId: cause!.assessmentId, obligationId: cause!.obligationId });
  expect(await db.ingestionSourceRevision.count({ where: { sourceId: f.sourceId } })).toBe(1);
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.projectFactVersion.count({ where: { customerId: f.customerId } })).toBe(versions);
  expect(await db.projectUpdateEngagement.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(JSON.stringify(view)).not.toContain("PRIVATE PROPOSAL VALUE");
  const firstObservation = await db.ingestionSourceRevision.findFirstOrThrow({ where: { sourceId: f.sourceId } });
  await f.ingest(false);
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId } })).toBe(1);
  const unchanged = await db.ingestionRowOutcome.findMany({ where: { sourceId: f.sourceId, operation: "UNCHANGED" } });
  expect(unchanged).toHaveLength(1);
  expect(await db.ingestionSourceRevision.count({ where: { sourceId: f.sourceId } })).toBe(1);
  expect(await db.ingestionSourceRevision.findFirst({ where: { sourceId: f.sourceId } })).toEqual(firstObservation);
  await f.ingest();
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  const completed = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId } });
  expect(completed).toHaveLength(2);
  expect(completed.every((row) => row.obligationId === cause!.obligationId && row.state === "COMPLETED")).toBe(true);
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(1);
  expect((await db.$queryRaw<{ ok: boolean }[]>`SELECT bool_and(public.valid_ingestion_project_reassessment(id)) AS ok FROM public."IngestionProjectReassessment" WHERE "projectId"=${f.projectId}::uuid`)[0]!.ok).toBe(true);
});

it("completes a current canonical project without inventing an obligation, and skips disabled policies", async () => {
  const f = await fixture({ current: true });
  await f.ingest();
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "COMPLETED", obligationId: null, previewId: null });
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(0);
  const disabled = await fixture({ enabled: false });
  await disabled.ingest();
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: disabled.projectId } })).toBe(0);
});

it("uses trusted current canonical evidence without promoting the connector proposal or changing its evidence time", async () => {
  const f = await fixture({ current: true });
  const facts = new DatabaseProjectFactRepository(db);
  const existing = await db.projectFact.findFirst({ where: { customerId: f.customerId, projectId: f.projectId, factType: "project.status" } });
  const written = await facts.appendHumanStatement(f.admin, { projectId: f.projectId, factType: "project.status",
    expectedRevision: existing?.revision ?? 0, idempotencyKey: randomUUID(), effectiveAt: new Date().toISOString(),
    value: { type: "text", value: "Current confirmed synthetic status" }, originalStatement: "Current synthetic statement" }, { correlationId: randomUUID() });
  await facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: written.entry.sourceId,
    expectedRevision: written.entry.sourceAccessRevision, state: "AVAILABLE", readers: [f.admin.subject, f.service] }, { correlationId: randomUUID() });
  await new DatabaseAuthorityRepository(db).appendPolicy(f.admin, { projectId: f.projectId, factType: "project.status", expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt: new Date().toISOString(), definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 86400000 } }] }], conflictBehavior: "REQUEST_RECONCILIATION" } }, { correlationId: randomUUID() });
  const before = { versions: await db.projectFactVersion.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } }),
    evidence: await db.factEvidence.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } }) };
  await f.ingest(); expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  const latest = await f.updates.latest(f.admin, f.projectId);
  expect(latest).toMatchObject({ freshness: { state: "CURRENT", sourceDateField: "project.latestValidUpdateAt" },
    completeness: { state: "COMPLETE" }, obligation: null, preview: null });
  const assessed = await db.projectUpdateAssessment.findFirstOrThrow({ where: { projectId: f.projectId } });
  expect(assessed.input).toMatchObject({ timestampBasis: "REQUIRED_FACTS", latestValidUpdateAt: expect.any(String) });
  expect(assessed.result).toMatchObject({ engagementFacts: [{ factType: "project.status", state: "SATISFIED" }] });
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "COMPLETED", obligationId: null, previewId: null });
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.projectFactVersion.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } })).toEqual(before.versions);
  expect(await db.factEvidence.findMany({ where: { projectId: f.projectId }, orderBy: { id: "asc" } })).toEqual(before.evidence);
  expect(JSON.stringify(latest)).not.toContain("PRIVATE PROPOSAL VALUE");
  expect(await db.projectUpdateEngagement.count({ where: { projectId: f.projectId } })).toBe(0);
});

it("scheduled reconciliation creates one changed cause and preserves the first observation on an unchanged scheduled page", async () => {
  const f = await fixture();
  // A prior due bucket and a current due bucket are both claimable at real DB
  // time. Only the source health clock is aged between them in this fixture.
  const runScheduled = async (now: Date) => {
    const jobs = await f.runtime.enqueueDueJobs(f.customerId, 15, 20, now);
    expect(jobs).toHaveLength(1);
    expect(await db.connectorSyncJob.findUnique({ where: { id: jobs[0]! } })).toMatchObject({ kind: "SCHEDULED", state: "READY" });
    await f.pump();
    expect(await db.connectorSyncJob.findUnique({ where: { id: jobs[0]! } })).toMatchObject({ kind: "SCHEDULED", state: "COMPLETED" });
  };
  f.providerRevision();
  await runScheduled(new Date(Date.now() - 16 * 60000));
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  const observation = await db.ingestionSourceRevision.findFirstOrThrow({ where: { sourceId: f.sourceId } });
  const sourceBefore = await db.ingestionSource.findUniqueOrThrow({ where: { id: f.sourceId } });
  await transact(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.ingestionSource.update({ where: { id: f.sourceId }, data: { healthCheckedAt: new Date(Date.now() - 16 * 60000) } });
  });
  expect({ ...await db.ingestionSource.findUniqueOrThrow({ where: { id: f.sourceId } }), healthCheckedAt: null })
    .toEqual({ ...sourceBefore, healthCheckedAt: null });
  await runScheduled(new Date());
  expect(await db.connectorSyncJob.count({ where: { sourceId: f.sourceId, kind: "SCHEDULED", state: "COMPLETED" } })).toBe(2);
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.ingestionRowOutcome.count({ where: { sourceId: f.sourceId, operation: "UNCHANGED" } })).toBe(1);
  expect(await db.ingestionSourceRevision.findMany({ where: { sourceId: f.sourceId } })).toEqual([observation]);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(1);
});

it("charges crash attempts durably, fences stale completion/failure/refund and blocks before a sixth claim", async () => {
  const f = await fixture(); await f.ingest();
  let previous = await claim(f);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  for (let attempt = 2; attempt <= 5; attempt++) {
    await expireLease(f);
    const next = await claim(f);
    expect(next.causes[0]!.attemptCount).toBe(attempt);
    await expect(transact((tx) => coordinator(f).access.complete(tx, previous))).rejects.toThrow();
    const before = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId } });
    await transact((tx) => coordinator(f).access.release(tx, previous, false));
    await transact((tx) => coordinator(f).access.release(tx, previous, true));
    expect(await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId } })).toEqual(before);
    previous = next;
  }
  await expireLease(f);
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "BLOCKED", lastReason: "RETRY_EXHAUSTED", attemptCount: 5, totalAttempts: 5 });
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(0);
});

async function crashAfterCommittedClaim(f: Fixture) {
  const probe = `import {createDatabase} from './packages/data/dist/index.js';
    import {ProjectUpdateScanCoordinator} from './packages/data/dist/project-update-scan.js';
    const db=createDatabase(process.env.PDAA_DATABASE_URL);
    const c=new ProjectUpdateScanCoordinator(db,process.env.PDAA_TEST_SCAN_SUBJECT,async()=>{throw Error('unexpected assessment')});
    const claim=await db.$transaction(tx=>c.claim(tx));
    if(!claim||claim.causes.length!==1) process.exit(31);
    process.stdout.write('durable-claim-committed'); process.exit(17);`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: process.cwd(), env: { ...process.env, PDAA_TEST_SCAN_SUBJECT: f.service }, timeout: 15000,
  }).then(() => ({ code: 0, stdout: "" }), (error: { code: number; stdout: string }) => error);
  expect(result.code).toBe(17); expect(result.stdout).toBe("durable-claim-committed");
}

it("retains a durable claim across actual process death", async () => {
  const f = await fixture(); await f.ingest();
  await crashAfterCommittedClaim(f);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  await expireLease(f);
  expect(await new DatabaseProjectUpdateRepository(db, f.service).scanScheduledProjects(1)).toBe(1);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "COMPLETED", totalAttempts: 2, attemptCount: 2 });
});

// Each real child already has a 15s limit. Bound each ordered death separately
// at the default 20s instead of sharing one 20s allowance across all five.
describe.sequential("five actual child process deaths retain all charges and cannot obtain a sixth automatic attempt", () => {
  let shared: Fixture | undefined;
  let completed = 0;
  let healthy = true;
  let failed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    it(`retains actual death ${attempt} and its exact durable charge`, async ({ signal, onTestFailed }) => {
      onTestFailed(() => { failed = true; });
      expect(failed, "The scenario cannot resume after a failed step").toBe(false);
      expect(healthy, "A previous step failed or is incomplete").toBe(true);
      expect(completed, "Every earlier death must complete in order").toBe(attempt - 1);
      healthy = false;
      const started = performance.now();
      if (attempt === 1) {
        expect(shared, "A filtered or retried step must not reuse this fixture").toBeUndefined();
        shared = await fixture();
        await shared.ingest();
      }
      expect(shared).toBeDefined();
      const f = shared!;
      await crashAfterCommittedClaim(f);
      expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({
        state: "READY", lastReason: "CLAIMED", attemptCount: attempt, totalAttempts: attempt, claimedGeneration: attempt,
      });
      expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(0);
      expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(0);
      expect(await f.updates.scanScheduledProjects(1)).toBe(0);
      await expireLease(f);
      // A timed-out promise may finish later. It cannot re-enable later steps.
      expect(signal.aborted || failed).toBe(false);
      expect(performance.now() - started).toBeLessThan(20000);
      completed = attempt;
      healthy = true;
    });
  }
  it("blocks a sixth automatic claim after all five actual deaths", async ({ onTestFailed }) => {
    onTestFailed(() => { failed = true; });
    expect(failed, "The scenario cannot resume after a failed step").toBe(false);
    expect(healthy, "A previous step failed or is incomplete").toBe(true);
    expect(completed, "All five real deaths are prerequisites").toBe(5);
    healthy = false;
    expect(shared).toBeDefined();
    const f = shared!;
    expect(await new DatabaseProjectUpdateRepository(db, f.service).scanScheduledProjects(1)).toBe(1);
    expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({
      state: "BLOCKED", lastReason: "RETRY_EXHAUSTED", attemptCount: 5, totalAttempts: 5,
    });
    expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(0);
    expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  });
});

it("refunds repeated real source-lock contention without exhausting attempts and retains monotonic totals", async () => {
  const f = await fixture(); await f.ingest();
  for (let attempt = 1; attempt <= 6; attempt++) {
    let release!: () => void, held!: () => void;
    const ready = new Promise<void>((resolve) => { held = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const locking = transact(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public."IngestionSource" WHERE id=${f.sourceId}::uuid FOR UPDATE`;
      held(); await wait;
    });
    await ready;
    try { expect(await coordinator(f).instance.scan()).toBe(1); }
    finally { release(); await locking; }
    const row = await db.ingestionProjectReassessment.findFirstOrThrow({ where: { projectId: f.projectId } });
    expect(row).toMatchObject({ state: "READY", attemptCount: 0, totalAttempts: attempt, lastReason: "LOCK_CONTENDED", claimedGeneration: null });
    expect(row.availableAt.getTime() - Date.now()).toBeGreaterThan(55000);
    const audit = await db.auditEvent.findUniqueOrThrow({ where: { id: row.auditEventId } });
    expect(row.availableAt.getTime() - audit.occurredAt.getTime()).toBe(60000);
    expect(await f.updates.scanScheduledProjects(1)).toBe(0);
    await ageWaits(f);
  }
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({ state: "COMPLETED", attemptCount: 1, totalAttempts: 7 });
});

it("requires current project/source administration and exact recovery revision without resetting failure backoff", async () => {
  const f = await fixture(); await f.ingest();
  const c = await claim(f);
  await transact((tx) => coordinator(f).access.release(tx, c, false));
  const failed = await db.projectUpdatePolicy.findFirstOrThrow({ where: { projectId: f.projectId } });
  expect(failed.scanFailureNextEligibleAt!.getTime() - Date.now()).toBeGreaterThan(295000);
  const failedCause = await db.ingestionProjectReassessment.findFirstOrThrow({ where: { projectId: f.projectId } });
  const failedAudit = await db.auditEvent.findUniqueOrThrow({ where: { id: failedCause.auditEventId } });
  expect(failed.scanFailureNextEligibleAt!.getTime() - failedAudit.occurredAt.getTime()).toBe(300000);
  await f.ingest(); expect(await f.updates.scanScheduledProjects(1)).toBe(0);
  await f.updates.setPolicy(f.admin, f.projectId, { ...f.policy, expectedRevision: 1, scheduledScanEnabled: false }, randomUUID());
  const rows = await f.updates.reassessments(f.admin, f.projectId);
  expect(rows.items).toHaveLength(2); expect(rows.items.every((r) => r.reason === "POLICY_DISABLED")).toBe(true);
  const row = rows.items[0]!;
  await expect(f.updates.retryReassessment(f.admin, f.projectId, { workId: row.id, expectedRecoveryRevision: 0 }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
  await f.updates.setPolicy(f.admin, f.projectId, { ...f.policy, expectedRevision: 2 }, randomUUID());
  await expect(f.updates.reassessments({ ...f.admin, subject: "outsider" }, f.projectId)).rejects.toMatchObject({ code: "DENIED" });
  await expect(f.updates.retryReassessment(f.admin, f.projectId, { workId: row.id, expectedRecoveryRevision: 1 }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.updates.retryReassessment(f.admin, f.projectId, { workId: row.id, expectedRecoveryRevision: 0 }, randomUUID())).toMatchObject({ state: "READY", recoveryRevision: 1, attemptCount: 0, totalAttempts: row.totalAttempts });
  expect((await db.projectUpdatePolicy.findFirstOrThrow({ where: { projectId: f.projectId } })).scanFailureNextEligibleAt).toEqual(failed.scanFailureNextEligibleAt);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
});

it("denies double charging and mismatched audit generations through SQL guards", async () => {
  const f = await fixture(); await f.ingest(); const c = await claim(f), cause = c.causes[0]!;
  for (const generation of [c.generation, c.generation + 1]) {
    await expect(transact(async (tx) => {
      const auditId = await reassessmentAudit(tx, cause, f.service, "claimed", { generation }, new Date());
      await tx.$executeRaw`UPDATE public."IngestionProjectReassessment" SET "attemptCount"="attemptCount"+1,"totalAttempts"="totalAttempts"+1,
        "auditEventId"=${auditId}::uuid WHERE id=${cause.id}::uuid`;
    })).rejects.toThrow();
  }
  expect(await db.ingestionProjectReassessment.findUnique({ where: { id: cause.id } })).toMatchObject({ attemptCount: 1, totalAttempts: 1 });
});

it("charges only a fixed available batch of 25 and leaves future and later arrivals untouched", async () => {
  const f = await fixture();
  await f.ingest();
  const unlock = await holdSource(f);
  try { expect(await coordinator(f).instance.scan()).toBe(1); } finally { await unlock(); }
  const future = await db.ingestionProjectReassessment.findFirstOrThrow({ where: { projectId: f.projectId } });
  expect(future).toMatchObject({ state: "READY", attemptCount: 0, totalAttempts: 1, lastReason: "LOCK_CONTENDED" });
  for (let index = 0; index < 26; index++) await f.ingest();
  const c = await claim(f); expect(c.causes).toHaveLength(25);
  expect(c.causes.some((row) => row.id === future.id)).toBe(false);
  await f.ingest();
  const arrived = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId, attemptCount: 0 } });
  expect(arrived).toHaveLength(3);
  await transact((tx) => coordinator(f).access.complete(tx, c));
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId, state: "COMPLETED" } })).toBe(25);
  for (const row of arrived) expect(await db.ingestionProjectReassessment.findUnique({ where: { id: row.id } })).toEqual(row);
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId, state: "COMPLETED" } })).toBe(27);
  expect(await db.ingestionProjectReassessment.findUnique({ where: { id: future.id } })).toMatchObject({ attemptCount: 0, state: "READY" });
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(1);
}, 120000);

it("a never-attempted periodic project gets its fair turn beside a busy source", async () => {
  const service = "fair-scan-" + randomUUID();
  const busy = await fixture({ service }), periodic = await fixture({ service, current: true });
  await busy.ingest();
  await db.projectUpdatePolicy.updateMany({ where: { projectId: busy.projectId }, data: { scheduledScanLastAttemptAt: new Date(0) } });
  await db.projectUpdatePolicy.updateMany({ where: { projectId: periodic.projectId }, data: { scheduledScanNextEligibleAt: null } });
  let release!: () => void, held!: () => void;
  const ready = new Promise<void>((resolve) => { held = resolve; }), wait = new Promise<void>((resolve) => { release = resolve; });
  const locking = transact(async (tx) => {
    await tx.$queryRaw`SELECT id FROM public."IngestionSource" WHERE id=${busy.sourceId}::uuid FOR UPDATE`;
    held(); await wait;
  });
  await ready;
  try { expect(await coordinator(periodic).instance.scan()).toBe(1); }
  finally { release(); await locking; }
  expect(await db.projectUpdateAssessment.count({ where: { projectId: periodic.projectId } })).toBe(1);
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: busy.projectId } })).toMatchObject({ attemptCount: 0, totalAttempts: 0 });
});

it("exhausts a fifth crashed cause after an older deferred cohort has advanced the project generation", async () => {
  const f = await fixture();
  for (let index = 0; index < 25; index++) await f.ingest();
  const unlock = await holdSource(f);
  try { expect(await coordinator(f).instance.scan()).toBe(1); } finally { await unlock(); }
  await f.ingest();
  let crashed = await claim(f); expect(crashed.causes).toHaveLength(1);
  const exhaustedId = crashed.causes[0]!.id;
  for (let attempt = 2; attempt <= 5; attempt++) {
    await expireLease(f); crashed = await claim(f);
    expect(crashed.causes).toHaveLength(1);
    expect(crashed.causes[0]).toMatchObject({ id: exhaustedId, attemptCount: attempt, totalAttempts: attempt });
  }
  await expireLease(f); await ageWaits(f);
  const older = await claim(f);
  expect(older.generation).toBeGreaterThan(crashed.generation);
  expect(older.causes).toHaveLength(25);
  expect(older.causes.some((row) => row.id === exhaustedId)).toBe(false);
  await transact((tx) => coordinator(f).access.complete(tx, older));
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  expect(await db.ingestionProjectReassessment.findUnique({ where: { id: exhaustedId } })).toMatchObject({
    state: "BLOCKED", lastReason: "RETRY_EXHAUSTED", attemptCount: 5, totalAttempts: 5, claimedGeneration: crashed.generation,
  });
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId, state: "COMPLETED" } })).toBe(25);
}, 120000);

it("refunds a real sync-grant lock conflict without treating it as revoked scope", async () => {
  const f = await fixture(); await f.ingest();
  let release!: () => void, held!: () => void;
  const reached = new Promise<void>((resolve) => { held = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const locking = transact(async (tx) => {
    await tx.$queryRaw`SELECT id FROM public."ConnectorSyncGrant" WHERE "sourceId"=${f.sourceId}::uuid FOR UPDATE`;
    held(); await waiting;
  });
  await reached;
  try { expect(await coordinator(f).instance.scan()).toBe(1); } finally { release(); await locking; }
  expect(await db.ingestionProjectReassessment.findFirst({ where: { projectId: f.projectId } })).toMatchObject({
    state: "READY", attemptCount: 0, totalAttempts: 1, claimedGeneration: null, lastReason: "LOCK_CONTENDED",
  });
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(0);
  await ageWaits(f); expect(await f.updates.scanScheduledProjects(1)).toBe(1);
});

it("keeps runtime revision hash, effective date and mapped payload immutable while preserving the first observation", async () => {
  const f = await fixture();
  const persist = f.ingestion.persistConnectorPageForJob.bind(f.ingestion);
  let original!: Parameters<typeof persist>[0];
  const spy = vi.spyOn(f.ingestion, "persistConnectorPageForJob").mockImplementationOnce(async (input) => {
    original = structuredClone(input); return persist(input);
  });
  await f.ingest(); spy.mockRestore();
  const revision = await db.ingestionSourceRevision.findFirstOrThrow({ where: { sourceId: f.sourceId } });
  const delivery = await f.webhook(false);
  const receipt = await db.connectorWebhookReceipt.findFirstOrThrow({ where: { sourceId: f.sourceId,
    eventId: delivery.headers["x-atlassian-webhook-identifier"] } });
  let job = await claimReassessmentFixtureJob(f.runtime, f.customerId, receipt.jobId);
  let snapshot = await f.ingestion.readConnectorSyncSnapshot(f.customerId, job!.jobId, job!.claimGeneration);
  if (snapshot.resetRequired) {
    await f.ingestion.resetConnectorCursorForJob(f.customerId, job!.jobId, job!.claimGeneration);
    job = await claimReassessmentFixtureJob(f.runtime, f.customerId, receipt.jobId);
    snapshot = await f.ingestion.readConnectorSyncSnapshot(f.customerId, job!.jobId, job!.claimGeneration);
  }
  const request = { ...original, jobId: job!.jobId, expectedClaimGeneration: job!.claimGeneration,
    expectedCursorRevision: snapshot.cursorRevision, expectedGeneration: snapshot.generation };
  const later = new Date(Date.now() + 1000).toISOString();
  for (const mutation of [
    { sourceContentHash: "f".repeat(64) },
    { effectiveAt: later },
    { observations: [{ factType: "jira.status", value: { type: "text", value: "Changed same-revision payload" } }] },
  ]) {
    await expect(persist({ ...request, page: { ...request.page,
      records: [{ ...request.page.records[0]!, observedAt: later, ...mutation }] } } as never)).rejects.toMatchObject({ code: "INTEGRITY_CONFLICT" });
  }
  expect(await db.ingestionOperationReceipt.count({ where: { sourceId: f.sourceId, kind: "CONNECTOR_PAGE" } })).toBe(1);
  await persist({ ...request, page: { ...request.page, records: [{ ...request.page.records[0]!, observedAt: later }] } });
  expect(await db.ingestionSourceRevision.findMany({ where: { sourceId: f.sourceId } })).toEqual([revision]);
  expect(await db.ingestionRowOutcome.count({ where: { sourceId: f.sourceId, operation: "UNCHANGED" } })).toBe(1);
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId } })).toBe(1);
});

it("rejects a valid same-project assessment and preview created before the current claim", async () => {
  const f = await fixture(); await f.ingest();
  const old = await f.updates.assess(f.admin, f.projectId, randomUUID());
  const oldPreview = await db.projectUpdatePreview.findUniqueOrThrow({ where: { id: old.preview!.id } });
  const c = await claim(f), cause = c.causes[0]!;
  await expect(transact(async (tx) => {
    const now = new Date();
    const auditId = await reassessmentAudit(tx, cause, f.service, "completed", { generation: c.generation,
      claimAuditEventId: cause.auditEventId, assessmentId: oldPreview.assessmentId,
      obligationId: old.obligation!.id, previewId: old.preview!.id }, now, c.correlationId);
    await tx.$executeRaw`UPDATE public."IngestionProjectReassessment" SET state='COMPLETED',"lastReason"='COMPLETED',
      "assessmentId"=${oldPreview.assessmentId}::uuid,"obligationId"=${old.obligation!.id}::uuid,"previewId"=${old.preview!.id}::uuid,
      "completedAt"=${now},"auditEventId"=${auditId}::uuid WHERE id=${cause.id}::uuid`;
  })).rejects.toThrow();
  expect(await db.ingestionProjectReassessment.findUnique({ where: { id: cause.id } })).toMatchObject({ state: "READY" });
  await transact((tx) => coordinator(f).access.complete(tx, c));
  expect(await db.ingestionProjectReassessment.findUnique({ where: { id: cause.id } })).toMatchObject({ state: "COMPLETED", obligationId: old.obligation!.id });
});

it("binds the actual retained obligation and preview when active engagement falls back to CURRENT project creation", async () => {
  const f = await fixture({ current: true });
  await db.accessGrant.create({ data: { customerId: f.customerId, subject: "synthetic-owner-4", role: "contributor", scopeType: "project", scopeId: f.projectId } });
  const observedAt = new Date(Date.now() - 2 * 86400000);
  const birth = { $transaction: (operation: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) =>
    operation(new Proxy(tx, { get(target, name) {
      if (name === "factEvidence") return new Proxy(target.factEvidence, { get(delegate, method) {
        if (method === "create") return (args: Parameters<typeof delegate.create>[0]) => delegate.create({ ...args, data: { ...args.data, observedAt } });
        const value = Reflect.get(delegate, method); return typeof value === "function" ? value.bind(delegate) : value;
      } });
      const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
    } })), options as never) };
  const facts = new DatabaseProjectFactRepository(db), authority = new DatabaseAuthorityRepository(db);
  const existingFact = await db.projectFact.findFirst({ where: { customerId: f.customerId, projectId: f.projectId, factType: "project.status" } });
  const written = await new DatabaseProjectFactRepository(birth as never).appendHumanStatement(f.admin, {
    projectId: f.projectId, factType: "project.status", expectedRevision: existingFact?.revision ?? 0, idempotencyKey: randomUUID(),
    effectiveAt: observedAt.toISOString(), value: { type: "text", value: "Private historical status" }, originalStatement: "Historical fixture",
  }, { correlationId: randomUUID() });
  const access = await facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: written.entry.sourceId,
    expectedRevision: written.entry.sourceAccessRevision, state: "AVAILABLE", readers: [f.admin.subject, f.service] }, { correlationId: randomUUID() });
  await authority.appendPolicy(f.admin, { projectId: f.projectId, factType: "project.status", expectedRevision: 0,
    idempotencyKey: randomUUID(), effectiveAt: observedAt.toISOString(), definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null,
      requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 31536000000 } }] }], conflictBehavior: "REQUEST_RECONCILIATION" } }, { correlationId: randomUUID() });
  const initial = await f.updates.assess(f.admin, f.projectId, randomUUID());
  expect(initial.freshness.state).toBe("STALE");
  const engagement = await f.updates.activateEngagement(f.admin, f.projectId, 1, randomUUID());
  expect(engagement).not.toBeNull();
  await facts.setSourceAccess(f.admin, { projectId: f.projectId, sourceId: written.entry.sourceId,
    expectedRevision: access.revision, state: "REVOKED", readers: [] }, { correlationId: randomUUID() });
  await f.ingest(); expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  const row = await db.ingestionProjectReassessment.findFirstOrThrow({ where: { projectId: f.projectId } });
  const latest = await f.updates.latest(f.admin, f.projectId);
  expect(latest).toMatchObject({ freshness: { state: "CURRENT", sourceDateField: "project.createdAt" },
    obligation: { id: initial.obligation!.id }, preview: { id: row.previewId } });
  expect(row).toMatchObject({ state: "COMPLETED", obligationId: initial.obligation!.id });
  expect(row.previewId).not.toBeNull();
  expect(await db.projectUpdateObligation.count({ where: { projectId: f.projectId } })).toBe(1);
});

it("populates all recovery states using real API-role transactions and verifies finite grants and immutable completions", async () => {
  const customerId = randomUUID(); await db.customer.create({ data: { id: customerId, name: "Recovery handoff fixture" } });
  const { Pool } = createRequire(new URL("../packages/data/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: url });
  const priorMode = process.env.PDAA_ACCEPTANCE, priorRun = process.env.PDAA_ACCEPTANCE_RUN_ID;
  process.env.PDAA_ACCEPTANCE = "isolated";
  process.env.PDAA_ACCEPTANCE_RUN_ID = "pdaa-acceptance-" + Date.now() + "-" + randomUUID().slice(0, 8);
  let apiFailure = "none";
  const api = { $queryRaw: (sql: TemplateStringsArray, ...values: unknown[]) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return tx.$queryRaw(sql, ...values);
  }), $transaction: (operation: (tx: ReassessmentTx) => Promise<unknown>, options: unknown) =>
    db.$transaction(async (tx) => { await tx.$executeRawUnsafe("SET LOCAL ROLE pdaa_api"); return operation(tx); }, options as never).catch((error: unknown) => {
      const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } }).meta?.driverAdapterError?.cause;
      apiFailure = cause?.originalCode + "/" + (cause?.originalMessage?.startsWith("permission denied") ? cause.originalMessage : "structured database rejection");
      throw error;
    }),
    $disconnect: async () => undefined };
  try {
    const saved = await seedReassessmentRecovery(pool, url, customerId, () => api).catch((error: unknown) => {
      if (apiFailure === "none") throw error;
      throw new Error("API-role fixture: " + apiFailure);
    });
    expect(saved.causes).toHaveLength(4);
    expect(await verifyRestoredReassessments(pool, saved)).toMatchObject({ exactSchedulerAndLineage: true, immutableCompletionDenied: true });
  } finally {
    await pool.end();
    if (priorMode === undefined) delete process.env.PDAA_ACCEPTANCE; else process.env.PDAA_ACCEPTANCE = priorMode;
    if (priorRun === undefined) delete process.env.PDAA_ACCEPTANCE_RUN_ID; else process.env.PDAA_ACCEPTANCE_RUN_ID = priorRun;
  }
});

it("reconfiguration preserves historical proofs, blocks stale pending lineage and enforces current readers on status/retry", async () => {
  const f = await fixture(); await f.ingest(); expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  await f.ingest();
  const original = await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId } });
  await f.ingestion.configure(f.admin, f.configuration as never, randomUUID());
  expect(await f.updates.scanScheduledProjects(1)).toBe(1);
  const rows = await f.updates.reassessments(f.admin, f.projectId);
  expect(rows.items.find((row) => row.state === "BLOCKED")).toMatchObject({ reason: "SOURCE_SCOPE_CHANGED" });
  expect(await db.projectUpdateAssessment.count({ where: { projectId: f.projectId } })).toBe(1);
  for (const row of original) expect((await db.$queryRaw<{ valid: boolean }[]>`SELECT public.valid_ingestion_project_reassessment(${row.id}::uuid) AS valid`)[0]!.valid).toBe(true);
  const pending = rows.items.find((row) => row.state === "BLOCKED")!;
  await expect(f.updates.retryReassessment(f.admin, f.projectId, { workId: pending.id, expectedRecoveryRevision: 0 }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT" });
  await f.ingestion.configure(f.admin, { ...f.configuration, projects: [{ projectId: f.projectId, readers: ["another-reader"] }] } as never, randomUUID());
  expect(await f.updates.reassessments(f.admin, f.projectId)).toEqual({ items: [], nextCursor: null });
  await expect(f.updates.retryReassessment(f.admin, f.projectId, { workId: pending.id, expectedRecoveryRevision: 0 }, randomUUID())).rejects.toMatchObject({ code: "DENIED" });
  expect((await db.$queryRaw<{ invalid: number }[]>`SELECT count(*)::int AS invalid FROM public."IngestionOperationReceipt" WHERE "sourceId"=${f.sourceId}::uuid AND public.valid_ingestion_receipt(id) IS NOT TRUE`)[0]!.invalid).toBe(0);
});

it("paginates only current-readable source causes without hidden identifiers displacing a 25-row page", async () => {
  const f = await fixture();
  const hidden = { ...f.configuration, binding: { ...f.configuration.binding, sourceId: randomUUID() },
    projects: [{ projectId: f.projectId, readers: ["another-reader"] }] };
  await f.ingestion.configure(f.admin, hidden as never, randomUUID());
  const privateIds: string[] = [];
  for (let index = 1; index <= 4; index++) {
    await manualPage(f, hidden, index);
    await f.ingest();
  }
  for (let index = 4; index < 27; index++) await f.ingest();
  const hiddenRows = await db.ingestionProjectReassessment.findMany({ where: { sourceId: hidden.binding.sourceId } });
  for (const row of hiddenRows) privateIds.push(row.id, row.receiptId, row.sourceId);
  const first = await f.updates.reassessments(f.admin, f.projectId);
  expect(first.items).toHaveLength(25); expect(first.nextCursor).toBe(first.items[24]!.id);
  const second = await f.updates.reassessments(f.admin, f.projectId, first.nextCursor);
  expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
  const visible = await db.ingestionProjectReassessment.findMany({ where: { sourceId: f.sourceId }, orderBy: { id: "asc" } });
  expect([...first.items, ...second.items].map((row) => row.id)).toEqual(visible.map((row) => row.id));
  expect(new Set([...first.items, ...second.items].map((row) => row.id)).size).toBe(27);
  const serialized = JSON.stringify([first, second]);
  for (const id of privateIds) expect(serialized).not.toContain(id);
  expect(serialized).not.toMatch(/PRIVATE PROPOSAL|Private pagination proposal/);
}, 120000);

it("fails closed during a current-reader revocation lock race and hides the source after that revocation commits", async () => {
  const f = await fixture(); await f.ingest();
  const gate = transactionGate((sql) => sql.includes('FROM public."Project"') && sql.includes("FOR UPDATE"));
  Reflect.set(f.ingestion, "db", gate.database);
  const revoked = f.ingestion.configure(f.admin, { ...f.configuration,
    projects: [{ projectId: f.projectId, readers: ["another-reader"] }] } as never, randomUUID());
  await gate.reached;
  try { await expect(f.updates.reassessments(f.admin, f.projectId)).rejects.toMatchObject({ code: "UNAVAILABLE" }); }
  finally { gate.resume(); Reflect.set(f.ingestion, "db", db); }
  await revoked;
  expect(await f.updates.reassessments(f.admin, f.projectId)).toEqual({ items: [], nextCursor: null });
});

it("retains configuration seal, scope, mapping and PMO denials under the actual API role", async () => {
  const f = await fixture();
  const original = await db.ingestionConfigurationRevision.findFirstOrThrow({ where: { sourceId: f.sourceId } });
  const head = await db.ingestionSource.findUniqueOrThrow({ where: { id: f.sourceId } });
  const otherPortfolio = randomUUID(), otherProject = randomUUID();
  await db.portfolio.create({ data: { id: otherPortfolio, customerId: f.customerId, name: "Unadministered scope" } });
  await db.project.create({ data: { id: otherProject, customerId: f.customerId, portfolioId: otherPortfolio,
    code: "OTHER", name: "Unadministered scope", description: "Synthetic denial fixture", reportedStatus: "UNKNOWN" } });
  const seal = (changedBy: string, projects: string[], mapping: unknown = original.mapping) => asApi(async (tx) => {
    await tx.ingestionConfigurationRevision.create({ data: { ...original, revision: 2, changedBy, mapping: mapping as never, sealed: false } });
    for (const projectId of projects) await tx.ingestionConfigurationProject.create({ data: {
      customerId: f.customerId, sourceId: f.sourceId, configRevision: 2, projectId,
    } });
    await tx.ingestionConfigurationRevision.update({ where: { customerId_sourceId_revision: {
      customerId: f.customerId, sourceId: f.sourceId, revision: 2 } }, data: { sealed: true } });
  });
  const denied = async (operation: Promise<unknown>, message: RegExp) => {
    const error = await operation.then(() => null, (error: unknown) => error);
    expect(error).not.toBeNull(); expect(databaseMessage(error)).toMatch(message);
    expect(await db.ingestionConfigurationRevision.count({ where: { sourceId: f.sourceId } })).toBe(1);
  };
  await denied(seal("no-current-pmo", [f.projectId]), /requires current PMO/);
  await denied(seal(f.admin.subject, [otherProject]), /requires current PMO/);
  await denied(seal(f.admin.subject, []), /scope is empty/);
  await denied(seal(f.admin.subject, [f.projectId], { kind: "CONNECTOR", factTypes: [] }), /Invalid ingestion mapping/);
  const excess = Array.from({ length: 101 }, () => randomUUID());
  await db.project.createMany({ data: excess.map((id) => ({ id, customerId: f.customerId, portfolioId: otherPortfolio,
    code: "BOUND-" + id, name: "Bounded configuration fixture", description: "Synthetic denial fixture", reportedStatus: "UNKNOWN" })) });
  await denied(seal(f.admin.subject, excess), /project limit exceeded/);
  await expect(asApi((tx) => tx.ingestionConfigurationRevision.update({ where: { customerId_sourceId_revision: {
    customerId: f.customerId, sourceId: f.sourceId, revision: 1 } }, data: { sealed: true } }))).rejects.toThrow();
  await expect(asApi((tx) => tx.ingestionConfigurationRevision.create({ data: { ...original, revision: 2, sealed: true } }))).rejects.toThrow();
  expect(await db.ingestionSource.findUnique({ where: { id: f.sourceId } })).toEqual(head);
});

it("serializes policy disablement after ingestion and blocks the just-committed cause", async () => {
  const f = await fixture(); await f.webhook();
  expect(await f.invoke("/internal/connectors/run")).toMatchObject({ result: { status: "cursor_reset" } });
  const gate = transactionGate((sql) => sql.includes('INSERT INTO public."IngestionProjectReassessment"'));
  Reflect.set(f.ingestion, "db", gate.database);
  const page = f.invoke("/internal/connectors/run");
  const pid = await gate.reached;
  const disable = f.updates.setPolicy(f.admin, f.projectId, { ...f.policy, expectedRevision: 1, scheduledScanEnabled: false }, randomUUID());
  try { await waitForBlockedBy(pid); }
  finally { gate.resume(); Reflect.set(f.ingestion, "db", db); }
  expect(await page).toMatchObject({ result: { status: "page_committed" } });
  await disable;
  expect(await db.ingestionProjectReassessment.findMany({ where: { projectId: f.projectId } })).toEqual([
    expect.objectContaining({ state: "BLOCKED", lastReason: "POLICY_DISABLED", attemptCount: 0 }),
  ]);
  expect(await f.updates.scanScheduledProjects(1)).toBe(0);
});

it("serializes ingestion after policy disablement and creates no cause under the disabled policy", async () => {
  const f = await fixture(); await f.webhook();
  expect(await f.invoke("/internal/connectors/run")).toMatchObject({ result: { status: "cursor_reset" } });
  const gate = transactionGate((sql) => sql.startsWith('UPDATE public."ProjectUpdatePolicy" SET revision='));
  Reflect.set(f.updates, "db", gate.database);
  const disable = f.updates.setPolicy(f.admin, f.projectId, { ...f.policy, expectedRevision: 1, scheduledScanEnabled: false }, randomUUID());
  const pid = await gate.reached;
  const page = f.invoke("/internal/connectors/run");
  try { await waitForBlockedBy(pid); }
  finally { gate.resume(); Reflect.set(f.updates, "db", db); }
  await disable;
  expect(await page).toMatchObject({ result: { status: "page_committed" } });
  expect(await db.ingestionProjectReassessment.count({ where: { projectId: f.projectId } })).toBe(0);
  expect(await db.ingestionOperationReceipt.count({ where: { sourceId: f.sourceId, kind: "CONNECTOR_PAGE" } })).toBe(1);
});

it.each([
  ["completion-first", "ReadCommitted"], ["preview-first", "ReadCommitted"],
  ["completion-first", "RepeatableRead"], ["preview-first", "RepeatableRead"],
] as const)("rejects conflicting null completion/late-preview commits: %s / %s", async (ordering, isolationLevel) => {
  const f = await fixture({ current: true });
  await f.updates.setPolicy(f.admin, f.projectId, { ...f.policy, freshnessWindowSeconds: 1, expectedRevision: 1 }, randomUUID());
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const old = await f.updates.assess(f.admin, f.projectId, randomUUID());
  expect(old.obligation).not.toBeNull();
  await f.updates.setPolicy(f.admin, f.projectId, { ...f.policy, expectedRevision: 2 }, randomUUID());
  await f.ingest(); const c = await claim(f), cause = c.causes[0]!;
  const assessor = f.updates as unknown as { assessInTransaction(tx: ReassessmentTx, actor: Actor, id: string, correlation: string, scheduled: boolean): Promise<{ assessmentId: string; view: { obligation: unknown } }> };
  const assessment = await transact((tx) => assessor.assessInTransaction(tx, { customerId: f.customerId, subject: f.service, roles: [] }, f.projectId, c.correlationId, true));
  expect(assessment.view.obligation).toBeNull();
  const complete = async (tx: ReassessmentTx) => {
    const at = (await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds',clock_timestamp()) AS now`)[0]!.now;
    const auditId = await reassessmentAudit(tx, cause, f.service, "completed", { generation: c.generation,
      claimAuditEventId: cause.auditEventId, assessmentId: assessment.assessmentId, obligationId: null, previewId: null }, at, c.correlationId);
    await tx.$executeRaw`UPDATE public."IngestionProjectReassessment" SET state='COMPLETED',"lastReason"='COMPLETED',
      "assessmentId"=${assessment.assessmentId}::uuid,"completedAt"=${at},"auditEventId"=${auditId}::uuid WHERE id=${cause.id}::uuid`;
  };
  const previewId = randomUUID();
  const preview = async (tx: ReassessmentTx) => {
    await tx.projectUpdatePreview.create({ data: { id: previewId, customerId: f.customerId, projectId: f.projectId,
      assessmentId: assessment.assessmentId, obligationId: old.obligation!.id, revision: 2, state: "SUPERSEDED",
      preview: {}, envelopeHash: "a".repeat(64), createdAt: new Date() } });
  };
  let release!: () => void, held!: (pid: number) => void;
  const reached = new Promise<number>((resolve) => { held = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const first = db.$transaction(async (tx) => {
    await (ordering === "completion-first" ? complete(tx) : preview(tx));
    held((await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await waiting;
  }, { isolationLevel, timeout: 20000 });
  const pid = await reached;
  const second = db.$transaction(async (tx) => {
    // Establish the RR snapshot while the first transaction is uncommitted.
    await tx.$queryRaw`SELECT count(*) FROM public."IngestionProjectReassessment" WHERE "projectId"=${f.projectId}::uuid`;
    await (ordering === "completion-first" ? preview(tx) : complete(tx));
  }, { isolationLevel, timeout: 20000 }).then(() => null, (error: unknown) => error);
  try { await waitForBlockedBy(pid); } finally { release(); }
  await first;
  const error = await second;
  expect(error).not.toBeNull();
  if (isolationLevel === "ReadCommitted")
    expect(databaseMessage(error)).toMatch(/Completed reassessment has no obligation|Invalid reassessment lineage|Incomplete reassessment lineage/);
  else {
    const code = (error as { code?: string; meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause?.originalCode ?? (error as { code?: string }).code;
    expect(["40001", "P2034"]).toContain(code);
  }
  expect(await db.ingestionProjectReassessment.findUnique({ where: { id: cause.id } })).toMatchObject({
    state: ordering === "completion-first" ? "COMPLETED" : "READY",
  });
  expect(await db.projectUpdatePreview.count({ where: { id: previewId } })).toBe(ordering === "completion-first" ? 0 : 1);
});
