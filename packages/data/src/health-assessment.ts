import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalActorSchema,
  buildScheduleHealthAssessment,
  healthAssessmentCommandSchema,
  healthAssessmentRetentionPolicySchema,
  healthAssessmentRetentionViewSchema,
  healthAssessmentViewSchema,
  HealthAssessmentError,
  type Actor,
  type HealthAssessmentRepository,
  type HealthAssessmentRetentionPolicy,
  type HealthAssessmentRetentionView,
  type HealthAssessmentView,
} from "@pdaa/domain";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";

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
type AssessmentRow = {
  assessmentId: string;
  projectId: string;
  assessedAt: Date;
  ruleRevision: string;
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
function toView(row: AssessmentRow, replayed: boolean, available: boolean): HealthAssessmentView {
  return healthAssessmentViewSchema.parse({
    assessmentId: row.assessmentId,
    projectId: row.projectId,
    assessedAt: row.assessedAt.toISOString(),
    coverage: "SCHEDULE_ONLY",
    ruleRevision: row.ruleRevision,
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
  constructor(private readonly db: Database) {}
  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    // READ COMMITTED lets a retry see the receipt after an advisory-lock wait.
    // Source rows are read under locks and only from a sealed canonical graph.
    try { return await this.db.$transaction(operation, { timeout: 10000, isolationLevel: "ReadCommitted" }); }
    catch (error) { mapError(error); }
  }
  private async authorizeProject(tx: Tx, current: Actor, id: string) {
    const rows = await tx.$queryRawUnsafe<{ portfolioId: string }[]>(
      'SELECT "portfolioId" FROM public."Project" WHERE id=$1::uuid AND "customerId"=$2::uuid',
      id, current.customerId,
    );
    const project = rows[0];
    if (!project) throw new HealthAssessmentError("DENIED");
    const grants = await tx.$queryRawUnsafe<{ role: string }[]>(
      'SELECT role FROM public."AccessGrant" WHERE "customerId"=$1::uuid AND subject=$2 AND ((\"scopeType\"=\'portfolio\' AND \"scopeId\"=$3::uuid) OR (\"scopeType\"=\'project\' AND \"scopeId\"=$4::uuid)) ORDER BY id FOR SHARE',
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
      'SELECT id AS "assessmentId","projectId","assessedAt","ruleRevision",input,result,"envelopeHash","contentExpiresAt","auditExpiresAt","redactedAt" FROM public."HealthAssessment" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid AND id=$3::uuid',
      customerId, id, assessmentId,
    );
    return rows[0] ?? null;
  }
  private contentAvailable(row: AssessmentRow, now: Date, policy: PolicyRow | null) {
    return row.redactedAt === null &&
      deadline(row.contentExpiresAt, row.assessedAt, policy?.contentRetentionHours).getTime() > now.getTime();
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
    return toView(row, true, this.contentAvailable(row, now, policy));
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
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        current.customerId + ":" + id + ":" + commandHash,
      );
      const now = await this.now(tx);
      const policy = await this.readPolicy(tx, current.customerId);
      const prior = await this.getReceipt(tx, current.customerId, id, commandHash);
      if (prior) return this.replay(tx, current, id, prior, requestHash, now, policy);
      if (!policy) throw new HealthAssessmentError("RETENTION_REQUIRED");

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
      const rowSql = 'SELECT id,key,state,"forecastEnd","plannedEnd" FROM public."TABLE" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY key,id LIMIT 51';
      const milestones = canonical[0]
        ? await tx.$queryRawUnsafe<{ id: string; key: string; state: string; forecastEnd: Date | null; plannedEnd: Date | null }[]>(
            rowSql.replace('"TABLE"', '"Milestone"'), current.customerId, id)
        : [];
      const workItems = canonical[0]
        ? await tx.$queryRawUnsafe<{ id: string; key: string; state: string; forecastEnd: Date | null; plannedEnd: Date | null }[]>(
            rowSql.replace('"TABLE"', '"WorkItem"'), current.customerId, id)
        : [];
      if (milestones.length > 50 || workItems.length > 50) throw new HealthAssessmentError("UNAVAILABLE");
      const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
      let built;
      try {
        built = buildScheduleHealthAssessment({
          projectId: id,
          projectRevision: canonical[0]?.revision ?? null,
          reportedStatus: project.reportedStatus,
          assessedAt: now.toISOString(),
          milestones: milestones.map((item) => ({ ...item, forecastEnd: date(item.forecastEnd), plannedEnd: date(item.plannedEnd) })),
          workItems: workItems.map((item) => ({ ...item, forecastEnd: date(item.forecastEnd), plannedEnd: date(item.plannedEnd) })),
        });
      } catch { throw new HealthAssessmentError("UNAVAILABLE"); }
      const inputJson = json(built.input);
      const resultJson = json({ coverage: built.coverage, ...built.result });
      if (Buffer.byteLength(inputJson, "utf8") > 262144 || Buffer.byteLength(resultJson, "utf8") > 262144)
        throw new HealthAssessmentError("UNAVAILABLE");
      const envelopeHash = hash(json({ coverage: built.coverage, input: built.input, result: built.result }));
      const assessmentId = randomUUID();
      const auditEventId = randomUUID();
      const contentExpiresAt = plusHours(now, policy.contentRetentionHours);
      const auditExpiresAt = plusHours(now, policy.auditRetentionHours);
      const receiptExpiresAt = plusHours(now, policy.idempotencyRetentionHours);
      await tx.$executeRawUnsafe(
        'INSERT INTO public."HealthAssessment" (id,"customerId","projectId","actorSubject","assessedAt","commandKeyHash","ruleRevision",input,result,"envelopeHash","contentExpiresAt","auditExpiresAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,\'schedule-health@1\',$7::jsonb,$8::jsonb,$9,$10,$11)',
        assessmentId, current.customerId, id, current.subject, now, commandHash, inputJson, resultJson, envelopeHash, contentExpiresAt, auditExpiresAt,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO public."HealthAssessmentCommandReceipt" ("customerId","projectId","commandKeyHash","actorSubject","requestHash","assessmentId","createdAt","expiresAt") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8)',
        current.customerId, id, commandHash, current.subject, requestHash, assessmentId, now, receiptExpiresAt,
      );
      const detail = json({ healthAssessmentId: assessmentId, projectId: id, coverage: "SCHEDULE_ONLY", ruleRevision: "schedule-health@1", envelopeHash });
      await tx.$executeRawUnsafe(
        'INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt") VALUES ($1::uuid,$2::uuid,$3,\'health.assessment.created\',$4,$5::jsonb,$6)',
        auditEventId, current.customerId, current.subject, correlationId, detail, now,
      );
      return healthAssessmentViewSchema.parse({
        assessmentId, projectId: id, assessedAt: now.toISOString(), coverage: "SCHEDULE_ONLY",
        ruleRevision: "schedule-health@1", envelopeHash, contentAvailable: true,
        input: built.input, result: { coverage: built.coverage, ...built.result }, replayed: false,
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
        'SELECT id AS "assessmentId","projectId","assessedAt","ruleRevision",input,result,"envelopeHash","contentExpiresAt","auditExpiresAt","redactedAt" FROM public."HealthAssessment" WHERE "customerId"=$1::uuid AND "projectId"=$2::uuid ORDER BY "assessedAt" DESC,id DESC LIMIT 1',
        current.customerId, id,
      );
      const row = rows[0];
      if (!row || deadline(row.auditExpiresAt, row.assessedAt, policy?.auditRetentionHours).getTime() <= now.getTime())
        return null;
      return toView(row, false, this.contentAvailable(row, now, policy));
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
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
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
}
