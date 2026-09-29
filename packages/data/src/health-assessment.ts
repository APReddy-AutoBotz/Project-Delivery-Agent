import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalActorSchema,
  buildScheduleHealthAssessment,
  healthAssessmentCommandSchema,
  healthAssessmentRetentionPolicySchema,
  healthAssessmentRetentionViewSchema,
  blockerAgeThresholdPolicyChangeSchema,
  blockerAgeThresholdPolicyViewSchema,
  defaultScheduleHealthPolicy,
  scheduleHealthPolicyChangeSchema,
  scheduleHealthPolicyViewSchema,
  healthAssessmentViewSchema,
  HealthAssessmentError,
  type Actor,
  type HealthAssessmentRepository,
  type HealthAssessmentRetentionPolicy,
  type HealthAssessmentRetentionView,
  type BlockerAgeThresholdPolicyChange,
  type BlockerAgeThresholdPolicyView,
  type ScheduleHealthPolicyChange,
  type ScheduleHealthPolicyView,
  type HealthAssessmentView,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";
import {
  blockerAgeDependencies,
  buildBlockerAgeAssessmentInTransaction,
} from "./blocker-age-assessment.js";

type Tx = Prisma.TransactionClient;
type PolicyRow = {
  customerId: string;
  contentRetentionHours: number;
  auditRetentionHours: number;
  idempotencyRetentionHours: number;
  revision: number;
  changedBy: string;
  changedAt: Date;
};
type BlockerAgeThresholdPolicyRow = {
  customerId: string;
  minimumBlockerAgeDays: number;
  auditRetentionHours: number;
  revision: number;
  changedBy: string;
  changedAt: Date;
};
type ScheduleHealthPolicyRow = {
  revision: number;
  timeZone: string;
  defaultMinimumOverdueDays: number;
  targetOverrides: unknown;
  changedBy: string;
  changedAt: Date;
};
type AssessmentRow = {
  assessmentId: string;
  projectId: string;
  assessedAt: Date;
  ruleRevision: string;
  blockerAgeCoverage: "COMPLETE" | "PARTIAL" | "UNASSESSABLE" | null;
  input: unknown | null;
  result: unknown | null;
  envelopeHash: string;
  contentExpiresAt: Date;
  auditExpiresAt: Date;
  redactedAt: Date | null;
};
type ReceiptRow = {
  assessmentId: string;
  actorSubject: string;
  requestHash: string;
  createdAt: Date;
  expiresAt: Date;
};
const readers = ["pmo_admin", "portfolio_manager", "leadership", "project_manager"];
const projectIdSchema = z.uuid().refine((value) => value === value.toLowerCase());
const objectSchema = z.record(z.string(), z.unknown());
const earlier = (a: Date, b: Date) => a.getTime() < b.getTime() ? a : b;
const plusHours = (time: Date, hours: number) =>
  new Date(time.getTime() + hours * 3600000);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
function json(value: unknown) { return JSON.stringify(stable(value)); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function actor(value: Actor): Actor {
  try { return canonicalActorSchema.parse(value); }
  catch { throw new HealthAssessmentError("INVALID_REQUEST"); }
}
function projectId(value: string) {
  try { return projectIdSchema.parse(value); }
  catch { throw new HealthAssessmentError("INVALID_REQUEST"); }
}
function admin(value: Actor) {
  if (!value.roles.includes("pmo_admin")) throw new HealthAssessmentError("FORBIDDEN");
}
function deadline(stored: Date, assessedAt: Date, hours?: number) {
  return hours === undefined ? stored : earlier(stored, plusHours(assessedAt, hours));
}
function toPolicyView(row: PolicyRow): HealthAssessmentRetentionView {
  return healthAssessmentRetentionViewSchema.parse({
    contentRetentionHours: row.contentRetentionHours,
    auditRetentionHours: row.auditRetentionHours,
    idempotencyRetentionHours: row.idempotencyRetentionHours,
    revision: row.revision,
    changedBy: row.changedBy,
    changedAt: row.changedAt.toISOString(),
  });
}
function toBlockerAgeThresholdPolicyView(
  row: BlockerAgeThresholdPolicyRow,
): BlockerAgeThresholdPolicyView {
  return blockerAgeThresholdPolicyViewSchema.parse({
    minimumBlockerAgeDays: row.minimumBlockerAgeDays,
    auditRetentionHours: row.auditRetentionHours,
    revision: row.revision,
    changedBy: row.changedBy,
    changedAt: row.changedAt.toISOString(),
  });
}
function toView(row: AssessmentRow, replayed: boolean, available: boolean): HealthAssessmentView {
  return healthAssessmentViewSchema.parse({
    assessmentId: row.assessmentId,
    projectId: row.projectId,
    assessedAt: row.assessedAt.toISOString(),
    coverage:
      row.blockerAgeCoverage !== null
        ? "SCHEDULE_AND_BLOCKER_AGE"
        : "SCHEDULE_ONLY",
    ruleRevision: row.ruleRevision,
    blockerAgeCoverage: row.blockerAgeCoverage ?? undefined,
    envelopeHash: row.envelopeHash,
    contentAvailable: available,
    input: available ? objectSchema.parse(row.input) : null,
    result: available ? objectSchema.parse(row.result) : null,
    replayed,
  });
}
function mapError(error: unknown): never {
  if (error instanceof HealthAssessmentError) throw error;
  if (error && typeof error === "object" && "code" in error &&
    ["P2002", "P2034"].includes(String(error.code)))
    throw new HealthAssessmentError("CONFLICT");
  throw new HealthAssessmentError("UNAVAILABLE");
}

export class DatabaseHealthAssessmentRepository implements HealthAssessmentRepository {
  // Production assessments use the database clock. Tests may inject a fixed as-of
  // value to exercise persisted date-boundary behavior without accepting client time.
  constructor(
    private readonly db: Database,
    private readonly assessmentAsOfForTests?: () => Date,
  ) {}
  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    // READ COMMITTED lets a retry see the receipt after an advisory-lock wait.
    // Source rows are read under locks and only from a sealed canonical graph.
    try { return await this.db.$transaction(operation, { timeout: 10000, isolationLevel: "ReadCommitted" }); }
    catch (error) { mapError(error); }
  }
  private async authorizeProject(tx: Tx, current: Actor, id: string) {
    const rows = await tx.$queryRawUnsafe<{ portfolioId: string }[]>(
      'SELECT "portfolioId" FROM public."Project" WHERE id=$1::uuid AND "customerId"=$2::uuid FOR SHARE',
      id, current.customerId,
    );
    const project = rows[0];
    if (!project) throw new HealthAssessmentError("DENIED");
    const grants = await tx.$queryRawUnsafe<{ role: string }[]>(
      'SELECT role FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND (("scopeType"=\'portfolio\' AND "scopeId"=$3::uuid) OR ("scopeType"=\'project\' AND "scopeId"=$4::uuid)) ORDER BY id FOR SHARE',
      current.customerId, current.subject, project.portfolioId, id,
    );
    if (!grants.some((grant) => readers.includes(grant.role) && current.roles.includes(grant.role as Actor["roles"][number])))
      throw new HealthAssessmentError("DENIED");
  }
  private async readPolicy(tx: Tx, customerId: string, update = false) {
    const lock = update ? " FOR UPDATE" : " FOR SHARE";
    const rows = await tx.$queryRawUnsafe<PolicyRow[]>(
      'SELECT "customerId","contentRetentionHours","auditRetentionHours","idempotencyRetentionHours",revision,"changedBy","changedAt" FROM public."HealthAssessmentRetentionPolicy" WHERE "customerId"=$1::uuid' + lock,
      customerId,
    );
    const row = rows[0];
    if (!row) return null;
    try {
      healthAssessmentRetentionPolicySchema.parse({
        contentRetentionHours: row.contentRetentionHours,
        auditRetentionHours: row.auditRetentionHours,
        idempotencyRetentionHours: row.idempotencyRetentionHours,
      });
      return row;
    } catch { throw new HealthAssessmentError("UNAVAILABLE"); }
  }
  private async readBlockerAgeThresholdPolicy(
    tx: Tx,
    customerId: string,
    update = false,
  ): Promise<BlockerAgeThresholdPolicyRow | null> {
    const lock = update ? " FOR UPDATE" : " FOR SHARE";
    const rows = await tx.$queryRawUnsafe<BlockerAgeThresholdPolicyRow[]>(
      'SELECT "customerId","minimumBlockerAgeDays","auditRetentionHours",revision,"changedBy","changedAt" FROM public."BlockerAgeThresholdPolicy" WHERE "customerId"=$1::uuid' + lock,
      customerId,
    );
    const row = rows[0];
    if (!row) return null;
    try {
      toBlockerAgeThresholdPolicyView(row);
      return row;
    } catch {
      throw new HealthAssessmentError("UNAVAILABLE");
    }
  }
  private async readScheduleHealthPolicy(
    tx: Tx,
    customerId: string,
    id: string,
  ): Promise<ScheduleHealthPolicyView> {
    const rows = await tx.$queryRawUnsafe<ScheduleHealthPolicyRow[]>(
      'SELECT revision,"timeZone","defaultMinimumOverdueDays","targetOverrides","changedBy","changedAt" FROM public."ScheduleHealthPolicyRevision" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY revision DESC LIMIT 1',
      customerId,
      id,
    );
    const row = rows[0];
    if (!row)
      return scheduleHealthPolicyViewSchema.parse({
        ...defaultScheduleHealthPolicy,
        changedBy: null,
        changedAt: null,
      });
    try {
      return scheduleHealthPolicyViewSchema.parse({
        revision: row.revision,
        timeZone: row.timeZone,
        defaultMinimumOverdueDays: row.defaultMinimumOverdueDays,
        targetOverrides: row.targetOverrides,
        changedBy: row.changedBy,
        changedAt: row.changedAt.toISOString(),
      });
    } catch {
      throw new HealthAssessmentError("UNAVAILABLE");
    }
  }
  private async now(tx: Tx) {
    const rows = await tx.$queryRawUnsafe<{ now: Date }[]>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
    );
    if (!rows[0]?.now) throw new HealthAssessmentError("UNAVAILABLE");
    return rows[0].now;
  }
  private async getReceipt(tx: Tx, customerId: string, id: string, commandHash: string) {
    const rows = await tx.$queryRawUnsafe<ReceiptRow[]>(
      'SELECT "assessmentId","actorSubject","requestHash","createdAt","expiresAt" FROM public."HealthAssessmentCommandReceipt" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND "commandKeyHash"=$3',
      customerId, id, commandHash,
    );
    return rows[0] ?? null;
  }
  private async getAssessment(tx: Tx, customerId: string, id: string, assessmentId: string) {
    const rows = await tx.$queryRawUnsafe<AssessmentRow[]>(
      'SELECT id AS "assessmentId","projectId","assessedAt","ruleRevision","blockerAgeCoverage",input,result,"envelopeHash","contentExpiresAt","auditExpiresAt","redactedAt" FROM public."HealthAssessment" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid',
      customerId, id, assessmentId,
    );
    return rows[0] ?? null;
  }
  private contentAvailable(row: AssessmentRow, now: Date, policy: PolicyRow | null) {
    return row.redactedAt === null &&
      deadline(row.contentExpiresAt, row.assessedAt, policy?.contentRetentionHours).getTime() > now.getTime();
  }
  private async sourcesReadable(
    tx: Tx,
    current: Actor,
    projectId: string,
    input: unknown,
  ): Promise<boolean> {
    const dependencies = blockerAgeDependencies(input);
    if (dependencies === null) return false;
    if (dependencies.length === 0) return true;
    const values = dependencies
      .map((_, index) => {
        const first = 3 + index * 2;
        return "($" + first + "::uuid,$" + (first + 1) + "::uuid)";
      })
      .join(",");
    const parameters = dependencies.flatMap((item) => [
      item.factId,
      item.sourceId,
    ]);
    const access = await tx.$queryRawUnsafe<
      { factId: string; sourceId: string; state: string }[]
    >(
      "SELECT a.\"factId\",a.\"sourceId\",a.state FROM public.\"FactSourceAccess\" a JOIN (VALUES " +
        values +
        ") AS p(\"factId\",\"sourceId\") ON p.\"factId\"=a.\"factId\" AND p.\"sourceId\"=a.\"sourceId\" WHERE a.\"customerId\"=$1::uuid AND a.\"projectId\"=$2::uuid ORDER BY a.\"factId\",a.\"sourceId\" FOR SHARE OF a",
      current.customerId,
      projectId,
      ...parameters,
    );
    const readerParameter = 3 + parameters.length;
    const readers = await tx.$queryRawUnsafe<
      { factId: string; sourceId: string; subject: string }[]
    >(
      "SELECT r.\"factId\",r.\"sourceId\",r.subject FROM public.\"FactSourceReader\" r JOIN (VALUES " +
        values +
        ") AS p(\"factId\",\"sourceId\") ON p.\"factId\"=r.\"factId\" AND p.\"sourceId\"=r.\"sourceId\" WHERE r.\"customerId\"=$1::uuid AND r.\"projectId\"=$2::uuid AND r.subject=$" +
        readerParameter +
        " ORDER BY r.\"factId\",r.\"sourceId\",r.subject FOR SHARE OF r",
      current.customerId,
      projectId,
      ...parameters,
      current.subject,
    );
    const available = new Set(
      access
        .filter((row) => row.state === "AVAILABLE")
        .map((row) => row.factId + ":" + row.sourceId),
    );
    const readable = new Set(
      readers.map((row) => row.factId + ":" + row.sourceId),
    );
    return dependencies.every((item) => {
      const key = item.factId + ":" + item.sourceId;
      return available.has(key) && readable.has(key);
    });
  }
  private async replay(
    tx: Tx,
    current: Actor,
    id: string,
    receipt: ReceiptRow,
    requestHash: string,
    now: Date,
    policy: PolicyRow | null,
  ) {
    if (receipt.actorSubject !== current.subject || receipt.requestHash !== requestHash)
      throw new HealthAssessmentError("CONFLICT");
    if (deadline(receipt.expiresAt, receipt.createdAt, policy?.idempotencyRetentionHours).getTime() <= now.getTime())
      throw new HealthAssessmentError("IDEMPOTENCY_RESULT_EXPIRED");
    const row = await this.getAssessment(tx, current.customerId, id, receipt.assessmentId);
    if (!row || deadline(row.auditExpiresAt, row.assessedAt, policy?.auditRetentionHours).getTime() <= now.getTime())
      throw new HealthAssessmentError("IDEMPOTENCY_RESULT_EXPIRED");
    const contentAvailable = this.contentAvailable(row, now, policy);
    const sourcesAvailable = contentAvailable
      ? await this.sourcesReadable(tx, current, id, row.input)
      : false;
    return toView(row, true, contentAvailable && sourcesAvailable);
  }
  async create(currentValue: Actor, idValue: string, commandKeyValue: string, correlationId: string) {
    const current = actor(currentValue);
    const id = projectId(idValue);
    let commandKey: string;
    try {
      commandKey = healthAssessmentCommandSchema.parse({ commandKey: commandKeyValue }).commandKey;
      z.uuid().parse(correlationId);
    } catch { throw new HealthAssessmentError("INVALID_REQUEST"); }
    const commandHash = hash(commandKey);
    const requestHash = hash(json({ operation: "health.assessment", projectId: id }));
    return this.transaction(async (tx) => {
      await this.authorizeProject(tx, current, id);
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
        current.customerId + ":" + id + ":" + commandHash,
      );
      const policy = await this.readPolicy(tx, current.customerId);
      const prior = await this.getReceipt(tx, current.customerId, id, commandHash);
      if (prior) {
        const replayNow = await this.now(tx);
        return this.replay(tx, current, id, prior, requestHash, replayNow, policy);
      }
      if (!policy) throw new HealthAssessmentError("RETENTION_REQUIRED");

      // Share this exact customer lock with the threshold writer. Replays above
      // return the frozen prior proof without observing a newer threshold.
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0)) IS NULL AS locked",
        "blocker-age-threshold:" + current.customerId,
      );
      const threshold = await this.readBlockerAgeThresholdPolicy(tx, current.customerId);
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0)) IS NULL AS locked",
        "schedule-health-policy:" + current.customerId + ":" + id,
      );
      const scheduleHealthPolicy = await this.readScheduleHealthPolicy(
        tx,
        current.customerId,
        id,
      );

      const projects = await tx.$queryRawUnsafe<{ reportedStatus: string }[]>(
        'SELECT "reportedStatus" FROM public."Project" WHERE id=$1::uuid AND "customerId"=$2::uuid',
        id, current.customerId,
      );
      const project = projects[0];
      if (!project) throw new HealthAssessmentError("DENIED");
      const canonical = await tx.$queryRawUnsafe<{ revision: number; sealed: boolean }[]>(
        'SELECT revision,sealed FROM public."CanonicalProject" WHERE id=$1::uuid AND "customerId"=$2::uuid FOR SHARE',
        id, current.customerId,
      );
      if (canonical[0] && !canonical[0].sealed) throw new HealthAssessmentError("UNAVAILABLE");
      const rowSql = 'SELECT id,key,state,"forecastEnd","plannedEnd" FROM public."TABLE" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY key,id LIMIT 51 FOR SHARE';
      const milestones = canonical[0]
        ? await tx.$queryRawUnsafe<{ id: string; key: string; state: string; forecastEnd: Date | null; plannedEnd: Date | null }[]>(
            rowSql.replace('"TABLE"', '"Milestone"'), current.customerId, id)
        : [];
      const workItems = canonical[0]
        ? await tx.$queryRawUnsafe<{ id: string; key: string; state: string; forecastEnd: Date | null; plannedEnd: Date | null }[]>(
            rowSql.replace('"TABLE"', '"WorkItem"'), current.customerId, id)
        : [];
      if (milestones.length > 50 || workItems.length > 50) throw new HealthAssessmentError("UNAVAILABLE");

      const blockerAge = await buildBlockerAgeAssessmentInTransaction(
        tx,
        this.db,
        current,
        id,
        canonical[0]?.sealed === true,
        threshold,
        this.assessmentAsOfForTests?.(),
      );
      const asOf = blockerAge.asOf;
      const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
      let built;
      try {
        built = buildScheduleHealthAssessment({
          projectId: id,
          projectRevision: canonical[0]?.revision ?? null,
          reportedStatus: project.reportedStatus,
          assessedAt: asOf.toISOString(),
          scheduleHealthPolicy: {
            revision: scheduleHealthPolicy.revision,
            timeZone: scheduleHealthPolicy.timeZone,
            defaultMinimumOverdueDays: scheduleHealthPolicy.defaultMinimumOverdueDays,
            targetOverrides: scheduleHealthPolicy.targetOverrides,
          },
          milestones: milestones.map((item) => ({ ...item, forecastEnd: date(item.forecastEnd), plannedEnd: date(item.plannedEnd) })),
          workItems: workItems.map((item) => ({ ...item, forecastEnd: date(item.forecastEnd), plannedEnd: date(item.plannedEnd) })),
        });
      } catch { throw new HealthAssessmentError("UNAVAILABLE"); }

      const ruleRevision = "schedule-health@2+blocker-age@1";
      let blockerAgeCoverage = blockerAge.coverage;
      let blockerAgeInput: Record<string, unknown> = blockerAge.input;
      let blockerAgeResult: Record<string, unknown> = blockerAge.result;
      let newConflicts = blockerAge.newConflicts;
      let input: Record<string, unknown> = {
        ...(built.input as unknown as Record<string, unknown>),
        scheduleHealthPolicy: built.scheduleHealthPolicy,
        blockerAge: blockerAgeInput,
      };
      let result: Record<string, unknown> = {
        coverage: built.coverage,
        ...built.result,
        blockerAge: blockerAgeResult,
      };
      const scheduleInputJson = json({
        ...(built.input as unknown as Record<string, unknown>),
        scheduleHealthPolicy: built.scheduleHealthPolicy,
      });
      const scheduleResultJson = json({ coverage: built.coverage, ...built.result });
      if (
        Buffer.byteLength(scheduleInputJson, "utf8") > 262144 ||
        Buffer.byteLength(scheduleResultJson, "utf8") > 262144
      )
        throw new HealthAssessmentError("UNAVAILABLE");
      let inputJson = json(input);
      let resultJson = json(result);
      if (
        Buffer.byteLength(inputJson, "utf8") > 262144 ||
        Buffer.byteLength(resultJson, "utf8") > 262144
      ) {
        blockerAgeCoverage = "UNASSESSABLE";
        blockerAgeInput = {
          rule: { key: "blocker-age", revision: "1" },
          asOf: asOf.toISOString(),
          timeZone: "UTC",
          coverage: "UNASSESSABLE",
          reason: "ENVELOPE_BOUND_EXCEEDED",
          thresholdRevision: threshold?.revision ?? null,
          dependencies: [],
        };
        blockerAgeResult = {
          asOf: asOf.toISOString(),
          timeZone: "UTC",
          ruleRevision: "blocker-age@1",
          thresholdRevision: threshold?.revision ?? null,
          coverage: "UNASSESSABLE",
          noOpenBlockers: null,
          candidateCount: 0,
          assessedBlockerCount: 0,
          unknownCandidateCount: 0,
          agedBlockerCount: 0,
          assessments: [],
        };
        newConflicts = [];
        input = {
          ...(built.input as unknown as Record<string, unknown>),
          scheduleHealthPolicy: built.scheduleHealthPolicy,
          blockerAge: blockerAgeInput,
        };
        result = {
          coverage: built.coverage,
          ...built.result,
          blockerAge: blockerAgeResult,
        };
        inputJson = json(input);
        resultJson = json(result);
        if (
          Buffer.byteLength(inputJson, "utf8") > 262144 ||
          Buffer.byteLength(resultJson, "utf8") > 262144
        )
          throw new HealthAssessmentError("UNAVAILABLE");
      }

      const envelopeHash = hash(json({
        coverage: "SCHEDULE_AND_BLOCKER_AGE",
        ruleRevision,
        input,
        result,
      }));
      const assessmentId = randomUUID();
      const auditEventId = randomUUID();
      const assessedAt = asOf;
      const contentExpiresAt = plusHours(assessedAt, policy.contentRetentionHours);
      const auditExpiresAt = plusHours(assessedAt, policy.auditRetentionHours);
      const receiptExpiresAt = plusHours(assessedAt, policy.idempotencyRetentionHours);
      if (newConflicts.length)
        await tx.factAuthorityConflict.createMany({ data: newConflicts });
      await tx.$executeRawUnsafe(
        "INSERT INTO public.\"HealthAssessment\" (id,\"customerId\",\"projectId\",\"actorSubject\",\"assessedAt\",\"commandKeyHash\",\"ruleRevision\",\"blockerAgeCoverage\",input,result,\"envelopeHash\",\"contentExpiresAt\",\"auditExpiresAt\") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'schedule-health@2+blocker-age@1',$7,$8::jsonb,$9::jsonb,$10,$11,$12)",
        assessmentId, current.customerId, id, current.subject, assessedAt, commandHash,
        blockerAgeCoverage, inputJson, resultJson, envelopeHash, contentExpiresAt, auditExpiresAt,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."HealthAssessmentCommandReceipt" ("customerId","projectId","commandKeyHash","actorSubject","requestHash","assessmentId","createdAt","expiresAt") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8)',
        current.customerId, id, commandHash, current.subject, requestHash, assessmentId, assessedAt, receiptExpiresAt,
      );
      const detail = json({
        healthAssessmentId: assessmentId,
        projectId: id,
        coverage: "SCHEDULE_AND_BLOCKER_AGE",
        ruleRevision,
        blockerAgeCoverage,
        thresholdRevision: threshold?.revision ?? null,
        envelopeHash,
      });
      await tx.$executeRawUnsafe(
        "INSERT INTO public.\"AuditEvent\" (id,\"customerId\",actor,event,\"correlationId\",detail,\"occurredAt\") VALUES ($1::uuid,$2::uuid,$3,'health.assessment.created',$4,$5::jsonb,$6)",
        auditEventId, current.customerId, current.subject, correlationId, detail, assessedAt,
      );
      const contentAvailable =
        await this.sourcesReadable(tx, current, id, input);
      return healthAssessmentViewSchema.parse({
        assessmentId,
        projectId: id,
        assessedAt: assessedAt.toISOString(),
        coverage: "SCHEDULE_AND_BLOCKER_AGE",
        ruleRevision,
        blockerAgeCoverage,
        envelopeHash,
        contentAvailable,
        input: contentAvailable ? input : null,
        result: contentAvailable ? result : null,
        replayed: false,
      });
    });
  }
  async latest(currentValue: Actor, idValue: string) {
    const current = actor(currentValue);
    const id = projectId(idValue);
    return this.transaction(async (tx) => {
      await this.authorizeProject(tx, current, id);
      const now = await this.now(tx);
      const policy = await this.readPolicy(tx, current.customerId);
      const rows = await tx.$queryRawUnsafe<AssessmentRow[]>(
        'SELECT id AS "assessmentId","projectId","assessedAt","ruleRevision","blockerAgeCoverage",input,result,"envelopeHash","contentExpiresAt","auditExpiresAt","redactedAt" FROM public."HealthAssessment" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY "assessedAt" DESC,id DESC LIMIT 1',
        current.customerId, id,
      );
      const row = rows[0];
      if (!row || deadline(row.auditExpiresAt, row.assessedAt, policy?.auditRetentionHours).getTime() <= now.getTime())
        return null;
      const contentAvailable = this.contentAvailable(row, now, policy);
      const sourcesAvailable = contentAvailable
        ? await this.sourcesReadable(tx, current, id, row.input)
        : false;
      return toView(row, false, contentAvailable && sourcesAvailable);
    });
  }
  async retention(currentValue: Actor) {
    const current = actor(currentValue);
    admin(current);
    return this.transaction(async (tx) => {
      const row = await this.readPolicy(tx, current.customerId);
      return row ? toPolicyView(row) : null;
    });
  }
  async setRetention(currentValue: Actor, policyValue: HealthAssessmentRetentionPolicy, correlationId: string) {
    const current = actor(currentValue);
    admin(current);
    let policy: HealthAssessmentRetentionPolicy;
    try {
      policy = healthAssessmentRetentionPolicySchema.parse(policyValue);
      z.uuid().parse(correlationId);
    } catch { throw new HealthAssessmentError("INVALID_REQUEST"); }
    return this.transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
        "health-assessment-retention:" + current.customerId,
      );
      const previous = await this.readPolicy(tx, current.customerId, true);
      const revision = (previous?.revision ?? 0) + 1;
      const changedAt = await this.now(tx);
      const auditEventId = randomUUID();
      const detail = json({ ...policy, revision });
      await tx.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'health.assessment.retention.changed\',$4,$5::jsonb,$6)',
        auditEventId, current.customerId, current.subject, correlationId, detail, changedAt,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."HealthAssessmentRetentionPolicy" ("customerId","contentRetentionHours","auditRetentionHours","idempotencyRetentionHours",revision,"changedBy","auditEventId","changedAt") VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8) ON CONFLICT ("customerId") DO UPDATE SET "contentRetentionHours"=EXCLUDED."contentRetentionHours","auditRetentionHours"=EXCLUDED."auditRetentionHours","idempotencyRetentionHours"=EXCLUDED."idempotencyRetentionHours",revision=EXCLUDED.revision,"changedBy"=EXCLUDED."changedBy","auditEventId"=EXCLUDED."auditEventId","changedAt"=EXCLUDED."changedAt"',
        current.customerId, policy.contentRetentionHours, policy.auditRetentionHours, policy.idempotencyRetentionHours, revision, current.subject, auditEventId, changedAt,
      );
      return healthAssessmentRetentionViewSchema.parse({
        ...policy, revision, changedBy: current.subject, changedAt: changedAt.toISOString(),
      });
    });
  }
  async scheduleHealthPolicy(currentValue: Actor, idValue: string) {
    const current = actor(currentValue);
    const id = projectId(idValue);
    return this.transaction(async (tx) => {
      await this.authorizeProject(tx, current, id);
      return this.readScheduleHealthPolicy(tx, current.customerId, id);
    });
  }
  async setScheduleHealthPolicy(
    currentValue: Actor,
    idValue: string,
    policyValue: ScheduleHealthPolicyChange,
    correlationId: string,
  ) {
    const current = actor(currentValue);
    const id = projectId(idValue);
    admin(current);
    let policy: ScheduleHealthPolicyChange;
    try {
      policy = scheduleHealthPolicyChangeSchema.parse(policyValue);
      z.uuid().parse(correlationId);
    } catch {
      throw new HealthAssessmentError("INVALID_REQUEST");
    }
    return this.transaction(async (tx) => {
      await this.authorizeProject(tx, current, id);
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
        "schedule-health-policy:" + current.customerId + ":" + id,
      );
      const previous = await this.readScheduleHealthPolicy(tx, current.customerId, id);
      if (previous.revision !== policy.expectedRevision)
        throw new HealthAssessmentError("CONFLICT");

      const milestoneKeys = policy.targetOverrides
        .filter((item) => item.targetType === "MILESTONE")
        .map((item) => item.targetKey);
      const workItemKeys = policy.targetOverrides
        .filter((item) => item.targetType === "WORK_ITEM")
        .map((item) => item.targetKey);
      const milestones = await tx.$queryRawUnsafe<{ key: string }[]>(
        'SELECT key FROM public."Milestone" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND key=ANY($3::text[]) FOR SHARE',
        current.customerId,
        id,
        milestoneKeys,
      );
      const workItems = await tx.$queryRawUnsafe<{ key: string }[]>(
        'SELECT key FROM public."WorkItem" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND key=ANY($3::text[]) FOR SHARE',
        current.customerId,
        id,
        workItemKeys,
      );
      const missingMilestones = new Set(milestoneKeys.filter((key) => !milestones.some((row) => row.key === key)));
      const missingWorkItems = new Set(workItemKeys.filter((key) => !workItems.some((row) => row.key === key)));
      if (missingMilestones.size || missingWorkItems.size)
        throw new HealthAssessmentError("INVALID_REQUEST");

      const revision = policy.expectedRevision + 1;
      const changedAt = await this.now(tx);
      const targetOverrides = policy.targetOverrides.map((item) => ({ ...item }));
      const detail = json({
        objectType: "ScheduleHealthPolicy",
        projectId: id,
        revision,
        timeZone: policy.timeZone,
        defaultMinimumOverdueDays: policy.defaultMinimumOverdueDays,
        targetOverrides,
      });
      await tx.$executeRawUnsafe(
        'INSERT INTO public."ScheduleHealthPolicyRevision" (id,"customerId","projectId",revision,"timeZone","defaultMinimumOverdueDays","targetOverrides","changedBy","changedAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,$9)',
        randomUUID(),
        current.customerId,
        id,
        revision,
        policy.timeZone,
        policy.defaultMinimumOverdueDays,
        json(targetOverrides),
        current.subject,
        changedAt,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'health.schedule.policy.changed\',$4,$5::jsonb,$6)',
        randomUUID(),
        current.customerId,
        current.subject,
        correlationId,
        detail,
        changedAt,
      );
      return scheduleHealthPolicyViewSchema.parse({
        revision,
        timeZone: policy.timeZone,
        defaultMinimumOverdueDays: policy.defaultMinimumOverdueDays,
        targetOverrides,
        changedBy: current.subject,
        changedAt: changedAt.toISOString(),
      });
    });
  }
  async blockerAgeThresholdPolicy(currentValue: Actor) {
    const current = actor(currentValue);
    admin(current);
    return this.transaction(async (tx) => {
      const row = await this.readBlockerAgeThresholdPolicy(tx, current.customerId);
      return row ? toBlockerAgeThresholdPolicyView(row) : null;
    });
  }
  async setBlockerAgeThresholdPolicy(
    currentValue: Actor,
    policyValue: BlockerAgeThresholdPolicyChange,
    correlationId: string,
  ) {
    const current = actor(currentValue);
    admin(current);
    let policy: BlockerAgeThresholdPolicyChange;
    try {
      policy = blockerAgeThresholdPolicyChangeSchema.parse(policyValue);
      z.uuid().parse(correlationId);
    } catch {
      throw new HealthAssessmentError("INVALID_REQUEST");
    }
    return this.transaction(async (tx) => {
      // Serialize even the first insert, where there is no policy row to lock.
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) IS NULL AS locked",
        "blocker-age-threshold:" + current.customerId,
      );
      const previous = await this.readBlockerAgeThresholdPolicy(
        tx,
        current.customerId,
        true,
      );
      if ((previous?.revision ?? 0) !== policy.expectedRevision)
        throw new HealthAssessmentError("CONFLICT");

      const revision = policy.expectedRevision + 1;
      const changedAt = await this.now(tx);
      const detail = json({
        objectType: "BlockerAgeThresholdPolicy",
        objectId: current.customerId,
        minimumBlockerAgeDays: policy.minimumBlockerAgeDays,
        auditRetentionHours: policy.auditRetentionHours,
        revision,
      });
      await tx.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'health.blocker_age.threshold.changed\',$4,$5::jsonb,$6)',
        randomUUID(),
        current.customerId,
        current.subject,
        correlationId,
        detail,
        changedAt,
      );
      let affected: number;
      if (previous) {
        affected = await tx.$executeRawUnsafe(
          'UPDATE public."BlockerAgeThresholdPolicy" SET "minimumBlockerAgeDays"=$2,"auditRetentionHours"=$3,revision=$4,"changedBy"=$5,"changedAt"=$6 WHERE "customerId"=$1::uuid AND revision=$7',
          current.customerId,
          policy.minimumBlockerAgeDays,
          policy.auditRetentionHours,
          revision,
          current.subject,
          changedAt,
          policy.expectedRevision,
        );
      } else {
        affected = await tx.$executeRawUnsafe(
          'INSERT INTO public."BlockerAgeThresholdPolicy" ("customerId","minimumBlockerAgeDays","auditRetentionHours",revision,"changedBy","changedAt") VALUES ($1::uuid,$2,$3,$4,$5,$6)',
          current.customerId,
          policy.minimumBlockerAgeDays,
          policy.auditRetentionHours,
          revision,
          current.subject,
          changedAt,
        );
      }
      if (affected !== 1) throw new HealthAssessmentError("CONFLICT");
      return blockerAgeThresholdPolicyViewSchema.parse({
        minimumBlockerAgeDays: policy.minimumBlockerAgeDays,
        auditRetentionHours: policy.auditRetentionHours,
        revision,
        changedBy: current.subject,
        changedAt: changedAt.toISOString(),
      });
    });
  }
}
