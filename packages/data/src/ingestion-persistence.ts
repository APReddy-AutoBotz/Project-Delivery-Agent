import { createHash, randomUUID } from "node:crypto";
import {
  connectorChangePageSchema,
  ingestionCommandKeySchema,
  ingestionConfigurationSchema,
  ingestionCursorStateSchema,
  ingestionHealthCodeSchema,
  ingestionProposalSchema,
  ingestionPreviewRequestSchema,
  ingestionReceiptReadSchema,
  ingestionRetentionSchema,
  ingestionSafeErrorSchema,
  ingestionRowOperationSchema,
  ingestionRowStateSchema,
  IngestionInputError,
  ingestionText,
  parseIngestion,
  parseCsvPreview,
  persistedSpreadsheetConfigSchema,
  previewSpreadsheetCsv,
  projectFactIdSchema,
  spreadsheetBaselineSchema,
  validateConnectorPage,
  validateConnectorRecord,
  type Actor,
  type IngestionConfiguration,
  type IngestionRepository,
  type IngestionSyncSnapshot,
  type SpreadsheetRowPreview,
} from "@pdaa/domain";
import { CredentialVault } from "@pdaa/platform";
import type {
  Prisma,
  PrismaClient as Database,
} from "./generated/prisma/client.js";
import { actorInput } from "./fact-authorization.js";

type Tx = Prisma.TransactionClient;
type MappingRow = { id: string; customerId: string; sourceId: string; sourceType: string; origin: string; currentConfigRevision: number | null; mappingRevision: number; cursorRevision: bigint; syncGeneration: bigint; cursorEnvelope: string | null; cursorState: string; healthState: string; healthCode: string; healthCheckedAt: Date | null; lastSuccessReceiptId: string | null };
type ConfigSnapshot = {
  source: MappingRow;
  configuration: IngestionConfiguration;
  configRevision: number;
  mappingRevision: number;
};
type PendingRecord = {
  recordType: string;
  recordKey: string;
  projectId: string;
  revision: string;
  sourceContentHash: string;
  remoteObservedAt: Date | null;
  remoteEffectiveAt: Date | null;
  proposals: { factType: string; value: unknown }[];
};
type PreparedRecord = PendingRecord & {
  recordId: string;
  sourceRevisionId: string;
  projectionId: string;
  recordCreated: boolean;
  revisionCreated: boolean;
  projectionCreated: boolean;
};
type OutcomeInput = {
  state: "ACCEPTED" | "INVALID" | "REVIEW_REQUIRED";
  operation: "CREATE" | "UPDATE" | "UNCHANGED" | "NONE";
  errorCodes: string[];
  projectId: string | null;
  recordKey: string | null;
  recordId: string | null;
  sourceRevisionId: string | null;
  projectionId: string | null;
};
type ReceiptRow = {
  id: string;
  customerId: string;
  sourceId: string;
  subject: string;
  kind: string;
  commandKey: string;
  requestHash: string;
  eventId: string | null;
  configRevision: number;
  mappingRevision: number;
  generationBefore: bigint | null;
  generationAfter: bigint | null;
  cursorRevisionBefore: bigint | null;
  cursorRevisionAfter: bigint | null;
  outcomeCount: number;
  auditEventId: string;
  createdAt: Date;
};

export class IngestionPersistenceError extends Error {
  constructor(
    readonly code:
      | "DENIED"
      | "INVALID_REQUEST"
      | "CONFLICT"
      | "STALE_CONFIGURATION"
      | "CURSOR_CONFLICT"
      | "RETENTION_REQUIRED"
      | "NOT_FOUND"
      | "INVALID_PREVIEW"
      | "INTEGRITY_CONFLICT"
      | "PERSISTENCE_FAILED",
  ) {
    super(code);
    this.name = "IngestionPersistenceError";
  }
}

const idSchema = projectFactIdSchema;
const contextSchema = (value: unknown) => {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z0-9_.:-]+$/.test(value)
  )
    throw new IngestionPersistenceError("INVALID_REQUEST");
  return value;
};
function stable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, stable(item)]));
  }
  return value;
}
function canonical(value: unknown): string {
  return JSON.stringify(stable(value));
}
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
const addSeconds = (date: Date, seconds: number) =>
  new Date(date.getTime() + seconds * 1000);
function boundedJson(value: unknown, maxBytes = 4 * 1024 * 1024): string {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes)
    throw new IngestionPersistenceError("INVALID_REQUEST");
  return encoded;
}
function exactCompare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function normalizeProposals(
  proposals: readonly { factType: string; value: unknown }[],
) {
  return [...proposals]
    .map((proposal) => ({ factType: proposal.factType, value: stable(proposal.value) }))
    .sort((a, b) => exactCompare(a.factType, b.factType));
}
function mapError(error: unknown, fallback: IngestionPersistenceError["code"]) {
  if (error instanceof IngestionPersistenceError) return error;
  if (error instanceof IngestionInputError)
    return new IngestionPersistenceError("INVALID_REQUEST");
  if (error instanceof Error && error.name === "ZodError")
    return new IngestionPersistenceError("INVALID_REQUEST");
  return new IngestionPersistenceError(fallback);
}
function uuid(value: unknown) {
  try {
    return idSchema.parse(value);
  } catch {
    throw new IngestionPersistenceError("INVALID_REQUEST");
  }
}
function parseActor(value: Actor): Actor {
  try {
    return actorInput(value);
  } catch {
    throw new IngestionPersistenceError("INVALID_REQUEST");
  }
}
function currentRoleMatches(actor: Actor, role: string) {
  return actor.roles.some((candidate) => candidate === role);
}
function configMapping(config: IngestionConfiguration) {
  if (config.mapping.kind === "CSV")
    return {
      kind: config.mapping.kind,
      sheet: config.mapping.sheet,
      identityColumn: config.mapping.identityColumn,
      projectColumn: config.mapping.projectColumn,
      fields: [...config.mapping.fields].sort((a, b) => exactCompare(a.factType, b.factType)),
    };
  return {
    kind: config.mapping.kind,
    factTypes: [...config.mapping.factTypes].sort(exactCompare),
    ...(config.mapping.adapterConfiguration === undefined
      ? {}
      : { adapterConfiguration: config.mapping.adapterConfiguration }),
  };
}
function stableConfig(config: IngestionConfiguration): IngestionConfiguration {
  return {
    binding: config.binding,
    projects: [...config.projects]
      .map((project) => ({
        projectId: project.projectId,
        readers: [...project.readers].sort(exactCompare),
      }))
      .sort((a, b) => exactCompare(a.projectId, b.projectId)),
    mapping: configMapping(config) as IngestionConfiguration["mapping"],
  };
}
function requireJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
  return value as Record<string, unknown>;
}
function canonicalCsvRow(headers: readonly string[], row: readonly string[]) {
  return sha256(
    canonical(
      headers
        .map((header, index) => [header, row[index]!] as const)
        .sort(([a], [b]) => exactCompare(a, b)),
    ),
  );
}
function csvType(sheet: string) {
  return `spreadsheet:${sheet}`;
}
function csvIdentityKey(sheet: string, identity: string) {
  return sha256(canonical([sheet, identity]));
}
function readSafeErrors(row: SpreadsheetRowPreview) {
  const supplied = [
    ...row.errors,
    ...row.fields.flatMap((field) =>
      field.state === "INVALID" ? [field.code] : [],
    ),
  ];
  const allowed = new Set([
    "INVALID_INPUT",
    "INVALID_KEY",
    "DUPLICATE_KEY",
    "INVALID_PROJECT",
    "PROJECT_CHANGED",
    "INVALID_FIELDS",
    "ROW_IDENTITY_REVIEW",
    "REQUIRED_VALUE",
    "INVALID_FORMULA",
    "INVALID_NUMBER",
    "INVALID_VALUE",
  ]);
  const result = [...new Set(supplied.filter((code) => allowed.has(code)))];
  return result.length ? result : ["INVALID_INPUT"];
}

export class DatabaseIngestionRepository implements IngestionRepository {
  constructor(
    private readonly db: Database,
    private readonly vault: CredentialVault,
  ) {}

  private async denialAudit(
    actor: Actor,
    operation: string,
    correlationId: string,
    reason: string,
  ) {
    try {
      await this.db.auditEvent.create({
        data: {
          customerId: actor.customerId,
          actor: actor.subject,
          event: "ingestion.operation.denied",
          correlationId,
          detail: { operation, reason },
        },
      });
    } catch {
      throw new IngestionPersistenceError("PERSISTENCE_FAILED");
    }
  }

  private async authorizedProjects(
    tx: Tx,
    actor: Actor,
    projectsInput: readonly string[],
    action: "read" | "write" | "configure",
  ) {
    const projectIds = [...new Set(projectsInput)].sort(exactCompare);
    if (!projectIds.length || projectIds.length > 100)
      throw new IngestionPersistenceError("DENIED");
    const projects = action === "read"
      ? await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
          SELECT id,"portfolioId" FROM public."Project"
          WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${projectIds}::uuid[])
          ORDER BY id FOR SHARE`
      : await tx.$queryRaw<{ id: string; portfolioId: string }[]>`
          SELECT id,"portfolioId" FROM public."Project"
          WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${projectIds}::uuid[])
          ORDER BY id FOR UPDATE`;
    if (projects.length !== projectIds.length)
      throw new IngestionPersistenceError("DENIED");
    const portfolioIds = [...new Set(projects.map((project) => project.portfolioId))].sort(exactCompare);
    const grants = await tx.$queryRaw<
      { id: string; scopeType: string; scopeId: string; role: string }[]
    >`
      SELECT id,"scopeType","scopeId",role FROM public."AccessGrant"
      WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject}
        AND (("scopeType"='project' AND "scopeId"=ANY(${projectIds}::uuid[]))
          OR ("scopeType"='portfolio' AND "scopeId"=ANY(${portfolioIds}::uuid[])))
      ORDER BY id FOR SHARE`;
    const allowed: readonly string[] =
      action === "read"
        ? ["leadership", "project_manager", "portfolio_manager", "pmo_admin"]
        : action === "write"
          ? ["project_manager", "portfolio_manager", "pmo_admin"]
          : ["pmo_admin"];
    for (const project of projects) {
      const hasGrant = grants.some(
        (grant) =>
          allowed.includes(grant.role) &&
          currentRoleMatches(actor, grant.role) &&
          ((grant.scopeType === "project" && grant.scopeId === project.id) ||
            (grant.scopeType === "portfolio" && grant.scopeId === project.portfolioId)),
      );
      if (!hasGrant) throw new IngestionPersistenceError("DENIED");
    }
    return { projectIds, projects, grants };
  }

  private async currentSource(tx: Tx, customerId: string, sourceId: string, lock: "UPDATE" | "SHARE" = "UPDATE") {
    const rows = lock === "UPDATE"
      ? await tx.$queryRaw<MappingRow[]>`
          SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthState","healthCode","healthCheckedAt","lastSuccessReceiptId"
          FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid FOR UPDATE`
      : await tx.$queryRaw<MappingRow[]>`
          SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthState","healthCode","healthCheckedAt","lastSuccessReceiptId"
          FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid FOR SHARE`;
    if (!rows[0]) throw new IngestionPersistenceError("NOT_FOUND");
    if (rows[0].currentConfigRevision === null)
      throw new IngestionPersistenceError("STALE_CONFIGURATION");
    return rows[0];
  }

  private async currentConfiguration(
    tx: Tx,
    source: MappingRow,
  ): Promise<IngestionConfiguration> {
    const revision = source.currentConfigRevision;
    if (revision === null) throw new IngestionPersistenceError("STALE_CONFIGURATION");
    const configs = await tx.$queryRaw<{ mapping: unknown }[]>`
      SELECT mapping FROM public."IngestionConfigurationRevision"
      WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${source.id}::uuid AND revision=${revision} AND sealed`;
    if (!configs[0]) throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
    const projects = await tx.$queryRaw<
      { projectId: string; subject: string | null }[]
    >`
      SELECT p."projectId",r.subject FROM public."IngestionConfigurationProject" p
      LEFT JOIN public."IngestionConfigurationReader" r
        ON r."customerId"=p."customerId" AND r."sourceId"=p."sourceId" AND r."configRevision"=p."configRevision" AND r."projectId"=p."projectId"
      WHERE p."customerId"=${source.customerId}::uuid AND p."sourceId"=${source.id}::uuid AND p."configRevision"=${revision}
      ORDER BY p."projectId",r.subject`;
    const grouped = new Map<string, string[]>();
    for (const row of projects) {
      const readers = grouped.get(row.projectId) ?? [];
      if (row.subject !== null) readers.push(row.subject);
      grouped.set(row.projectId, readers);
    }
    const mapping = requireJsonObject(configs[0].mapping);
    try {
      return parseIngestion(ingestionConfigurationSchema, {
        binding: {
          customerId: source.customerId,
          sourceId: source.id,
          sourceType: source.sourceType,
          origin: source.origin,
        },
        projects: [...grouped.entries()].map(([projectId, readers]) => ({ projectId, readers })),
        mapping,
      });
    } catch {
      throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
    }
  }

  private async preflight(sourceIdInput: string, actor: Actor): Promise<ConfigSnapshot> {
    const sourceId = uuid(sourceIdInput);
    const rows = await this.db.$queryRaw<MappingRow[]>`
      SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthState","healthCode","healthCheckedAt","lastSuccessReceiptId"
      FROM public."IngestionSource" WHERE "customerId"=${actor.customerId}::uuid AND id=${sourceId}::uuid`;
    const source = rows[0];
    if (!source || source.currentConfigRevision === null)
      throw new IngestionPersistenceError("DENIED");
    const projectRows = await this.db.$queryRaw<
      { projectId: string }[]
    >`
      SELECT "projectId" FROM public."IngestionConfigurationProject"
      WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND "configRevision"=${source.currentConfigRevision}
      ORDER BY "projectId"`;
    const projectIds = projectRows.map((row) => row.projectId);
    if (!projectIds.length) throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
    const locked = await this.db.$transaction(async (tx) => {
      const current = await this.lockAuthorizedSource(tx, actor, sourceId, projectIds, "write");
      if (current.source.currentConfigRevision !== source.currentConfigRevision || current.source.mappingRevision !== source.mappingRevision)
        throw new IngestionPersistenceError("STALE_CONFIGURATION");
      return current;
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
    return {
      source: locked.source,
      configuration: locked.config,
      configRevision: locked.source.currentConfigRevision!,
      mappingRevision: locked.source.mappingRevision,
    };
  }

  private async sourceReaders(
    tx: Tx,
    actor: Actor,
    source: MappingRow,
    config: IngestionConfiguration,
    scope: readonly string[],
  ) {
    const currentConfigRevision = source.currentConfigRevision;
    if (currentConfigRevision === null) throw new IngestionPersistenceError("STALE_CONFIGURATION");
    const configProjects = new Set(config.projects.map((project) => project.projectId));
    if (scope.some((projectId) => !configProjects.has(projectId)))
      throw new IngestionPersistenceError("DENIED");
    const rows = await tx.$queryRaw<{ projectId: string }[]>`
      SELECT "projectId" FROM public."IngestionConfigurationReader"
      WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${source.id}::uuid
        AND "configRevision"=${currentConfigRevision} AND subject=${actor.subject}
        AND "projectId"=ANY(${[...scope]}::uuid[])
      ORDER BY "projectId"`;
    if (rows.length !== new Set(scope).size)
      throw new IngestionPersistenceError("DENIED");
  }

  private async lockAuthorizedSource(
    tx: Tx,
    actor: Actor,
    sourceId: string,
    scope: readonly string[],
    action: "read" | "write",
  ) {
    await this.authorizedProjects(tx, actor, scope, action);
    const source = await this.currentSource(
      tx,
      actor.customerId,
      sourceId,
      action === "read" ? "SHARE" : "UPDATE",
    );
    const config = await this.currentConfiguration(tx, source);
    await this.sourceReaders(tx, actor, source, config, scope);
    return { source, config };
  }

  private async retention(tx: Tx, customerId: string) {
    const policies = await tx.$queryRaw<{ retentionHours: number; revision: number }[]>`
      SELECT "retentionHours",revision FROM public."IngestionRetentionPolicy" WHERE "customerId"=${customerId}::uuid`;
    if (!policies[0]) throw new IngestionPersistenceError("RETENTION_REQUIRED");
    return policies[0];
  }

  private async audit(
    tx: Tx,
    actor: Actor,
    correlationId: string,
    event: string,
    detail: Record<string, unknown>,
    occurredAt: Date,
  ) {
    const id = randomUUID();
    await tx.auditEvent.create({
      data: {
        id,
        customerId: actor.customerId,
        actor: actor.subject,
        event,
        correlationId,
        detail: JSON.parse(JSON.stringify(detail)) as Prisma.InputJsonObject,
        occurredAt,
      },
    });
    return id;
  }

  private async commandReceipt(
    tx: Tx,
    customerId: string,
    sourceId: string,
    subject: string,
    kind: string,
    commandKey: string,
  ) {
    const rows = await tx.$queryRaw<ReceiptRow[]>`
      SELECT id,"customerId","sourceId",subject,kind,"commandKey","requestHash","eventId","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt"
      FROM public."IngestionOperationReceipt"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid AND subject=${subject} AND kind=${kind} AND "commandKey"=${commandKey}`;
    return rows[0] ?? null;
  }

  private async eventReceipt(
    tx: Tx,
    customerId: string,
    sourceId: string,
    eventId: string,
  ) {
    const rows = await tx.$queryRaw<ReceiptRow[]>`
      SELECT id,"customerId","sourceId",subject,kind,"commandKey","requestHash","eventId","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt"
      FROM public."IngestionOperationReceipt"
      WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid AND "eventId"=${eventId}`;
    return rows[0] ?? null;
  }

  private async replay(
    existing: ReceiptRow,
    requestHash: string,
  ): Promise<{ receiptId: string; replayed: boolean; cursorRevision?: number; generation?: number; rowCount?: number }> {
    if (existing.requestHash !== requestHash)
      throw new IngestionPersistenceError("CONFLICT");
    return {
      receiptId: existing.id,
      replayed: true,
      ...(existing.cursorRevisionAfter === null ? {} : { cursorRevision: Number(existing.cursorRevisionAfter) }),
      ...(existing.generationAfter === null ? {} : { generation: Number(existing.generationAfter) }),
      rowCount: existing.outcomeCount,
    };
  }

  private async prepareRecords(
    tx: Tx,
    source: MappingRow,
    mappingRevision: number,
    pending: readonly PendingRecord[],
  ): Promise<PreparedRecord[]> {
    if (!pending.length) return [];
    const recordRows = pending.map((item) => ({
      id: randomUUID(),
      customerId: source.customerId,
      sourceId: source.id,
      projectId: item.projectId,
      recordType: item.recordType,
      recordKey: item.recordKey,
    }));
    const recordInput = canonical(recordRows);
    const insertedRecords = await tx.$queryRaw<{ recordType: string; recordKey: string }[]>`
      INSERT INTO public."IngestionExternalRecord" (id,"customerId","sourceId","projectId","recordType","recordKey")
      SELECT x.id,x."customerId",x."sourceId",x."projectId",x."recordType",x."recordKey"
      FROM jsonb_to_recordset(${recordInput}::jsonb) AS x(id uuid,"customerId" uuid,"sourceId" uuid,"projectId" uuid,"recordType" text,"recordKey" text)
      ORDER BY x."recordType",x."recordKey"
      ON CONFLICT ("customerId","sourceId","recordType","recordKey") DO NOTHING
      RETURNING "recordType","recordKey"`;
    const insertedRecordKeys = new Set(insertedRecords.map((item) => `${item.recordType}\u0000${item.recordKey}`));
    const recordResult = await tx.$queryRaw<{
      recordType: string; recordKey: string; projectId: string; id: string;
    }[]>`
      SELECT r."recordType",r."recordKey",r."projectId",r.id
      FROM jsonb_to_recordset(${recordInput}::jsonb) AS x("recordType" text,"recordKey" text,"projectId" uuid)
      JOIN public."IngestionExternalRecord" r ON r."customerId"=${source.customerId}::uuid AND r."sourceId"=${source.id}::uuid AND r."recordType"=x."recordType" AND r."recordKey"=x."recordKey"
      ORDER BY r."recordType",r."recordKey" FOR UPDATE OF r`;
    const recordByIdentity = new Map<string, { id: string; projectId: string }>();
    for (const record of recordResult) {
      const key = `${record.recordType}\u0000${record.recordKey}`;
      const expected = pending.find((item) => `${item.recordType}\u0000${item.recordKey}` === key);
      if (!expected || expected.projectId !== record.projectId)
        throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
      recordByIdentity.set(key, { id: record.id, projectId: record.projectId });
    }
    if (recordByIdentity.size !== pending.length)
      throw new IngestionPersistenceError("INTEGRITY_CONFLICT");

    const streamRows = pending.flatMap((record) =>
      normalizeProposals(record.proposals).map((proposal) => ({
        id: randomUUID(),
        customerId: source.customerId,
        sourceId: source.id,
        recordId: recordByIdentity.get(`${record.recordType}\u0000${record.recordKey}`)!.id,
        factType: proposal.factType,
      })),
    );
    if (streamRows.length) {
      await tx.$executeRaw`
        INSERT INTO public."IngestionFactStream" (id,"customerId","sourceId","recordId","factType")
        SELECT x.id,x."customerId",x."sourceId",x."recordId",x."factType"
        FROM jsonb_to_recordset(${canonical(streamRows)}::jsonb) AS x(id uuid,"customerId" uuid,"sourceId" uuid,"recordId" uuid,"factType" text)
        ORDER BY x."recordId",x."factType"
        ON CONFLICT ("customerId","sourceId","recordId","factType") DO NOTHING`;
    }

    const revisionRows = pending.map((record) => ({
      id: randomUUID(),
      customerId: source.customerId,
      sourceId: source.id,
      recordId: recordByIdentity.get(`${record.recordType}\u0000${record.recordKey}`)!.id,
      revision: record.revision,
      sourceContentHash: record.sourceContentHash,
      remoteObservedAt: record.remoteObservedAt,
      remoteEffectiveAt: record.remoteEffectiveAt,
    }));
    const revisionInput = canonical(revisionRows);
    const insertedRevisions = await tx.$queryRaw<{ id: string; revision: string }[]>`
      INSERT INTO public."IngestionSourceRevision" (id,"customerId","sourceId","recordId",revision,"sourceContentHash","remoteObservedAt","remoteEffectiveAt")
      SELECT x.id,x."customerId",x."sourceId",x."recordId",x.revision,x."sourceContentHash",x."remoteObservedAt",x."remoteEffectiveAt"
      FROM jsonb_to_recordset(${revisionInput}::jsonb) AS x(id uuid,"customerId" uuid,"sourceId" uuid,"recordId" uuid,revision text,"sourceContentHash" text,"remoteObservedAt" timestamptz,"remoteEffectiveAt" timestamptz)
      ORDER BY x."recordId",x.revision
      ON CONFLICT ("customerId","sourceId","recordId",revision) DO NOTHING
      RETURNING id,revision`;
    const insertedRevisionIds = new Set(insertedRevisions.map((item) => item.id));
    const revisions = await tx.$queryRaw<{
      recordId: string; revision: string; sourceContentHash: string; remoteObservedAt: Date | null; remoteEffectiveAt: Date | null; id: string;
    }[]>`
      SELECT r."recordId",r.revision,r."sourceContentHash",r."remoteObservedAt",r."remoteEffectiveAt",r.id
      FROM jsonb_to_recordset(${revisionInput}::jsonb) AS x("recordId" uuid,revision text)
      JOIN public."IngestionSourceRevision" r ON r."customerId"=${source.customerId}::uuid AND r."sourceId"=${source.id}::uuid AND r."recordId"=x."recordId" AND r.revision=x.revision
      ORDER BY r."recordId",r.revision FOR UPDATE OF r`;
    const revisionByIdentity = new Map<string, { id: string; created: boolean }>();
    for (const row of revisions) {
      const expected = revisionRows.find((item) => item.recordId === row.recordId && item.revision === row.revision);
      if (!expected || row.sourceContentHash !== expected.sourceContentHash ||
        (row.remoteObservedAt?.getTime() ?? null) !== (expected.remoteObservedAt?.getTime() ?? null) ||
        (row.remoteEffectiveAt?.getTime() ?? null) !== (expected.remoteEffectiveAt?.getTime() ?? null))
        throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
      revisionByIdentity.set(`${row.recordId}\u0000${row.revision}`, {
        id: row.id,
        created: insertedRevisionIds.has(row.id),
      });
    }
    if (revisionByIdentity.size !== pending.length)
      throw new IngestionPersistenceError("INTEGRITY_CONFLICT");

    const projectionRows = pending.map((record) => {
      const recordId = recordByIdentity.get(`${record.recordType}\u0000${record.recordKey}`)!.id;
      const revisionId = revisionByIdentity.get(`${recordId}\u0000${record.revision}`)!.id;
      const proposals = normalizeProposals(record.proposals);
      return {
      id: randomUUID(),
      customerId: source.customerId,
      sourceId: source.id,
      recordId,
      sourceRevisionId: revisionId,
      mappingRevision,
      factTypes: proposals.map((proposal) => proposal.factType),
      proposals,
    };
    });
    const projectionInput = canonical(projectionRows);
    const insertedProjections = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO public."IngestionProposalProjection" (id,"customerId","sourceId","recordId","sourceRevisionId","mappingRevision","proposalHash","factTypes")
      SELECT x.id,x."customerId",x."sourceId",x."recordId",x."sourceRevisionId",x."mappingRevision",encode(sha256(convert_to(x.proposals::text,'UTF8')),'hex'),x."factTypes"
      FROM jsonb_to_recordset(${projectionInput}::jsonb) AS x(id uuid,"customerId" uuid,"sourceId" uuid,"recordId" uuid,"sourceRevisionId" uuid,"mappingRevision" integer,"factTypes" text[],proposals jsonb)
      ORDER BY x."recordId",x."sourceRevisionId",x."mappingRevision"
      ON CONFLICT ("customerId","sourceId","recordId","sourceRevisionId","mappingRevision") DO NOTHING
      RETURNING id`;
    const insertedProjectionIds = new Set(insertedProjections.map((item) => item.id));
    const projections = await tx.$queryRaw<{
      recordId: string; sourceRevisionId: string; mappingRevision: number; proposalHash: string; expectedProposalHash: string; id: string;
    }[]>`
      SELECT p."recordId",p."sourceRevisionId",p."mappingRevision",p."proposalHash",encode(sha256(convert_to(x.proposals::text,'UTF8')),'hex') AS "expectedProposalHash",p.id
      FROM jsonb_to_recordset(${projectionInput}::jsonb) AS x("recordId" uuid,"sourceRevisionId" uuid,"mappingRevision" integer,proposals jsonb)
      JOIN public."IngestionProposalProjection" p ON p."customerId"=${source.customerId}::uuid AND p."sourceId"=${source.id}::uuid AND p."recordId"=x."recordId" AND p."sourceRevisionId"=x."sourceRevisionId" AND p."mappingRevision"=x."mappingRevision"
      ORDER BY p."recordId",p."sourceRevisionId",p."mappingRevision" FOR UPDATE OF p`;
    const projectionByIdentity = new Map<string, { id: string; created: boolean }>();
    for (const row of projections) {
      const expected = projectionRows.find((item) => item.recordId === row.recordId && item.sourceRevisionId === row.sourceRevisionId && item.mappingRevision === row.mappingRevision);
      if (!expected || row.expectedProposalHash !== row.proposalHash)
        throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
      projectionByIdentity.set(`${row.recordId}\u0000${row.sourceRevisionId}\u0000${row.mappingRevision}`, {
        id: row.id,
        created: insertedProjectionIds.has(row.id),
      });
    }
    if (projectionByIdentity.size !== pending.length)
      throw new IngestionPersistenceError("INTEGRITY_CONFLICT");

    const newContent = projectionRows.flatMap((row) => {
      const projection = projectionByIdentity.get(`${row.recordId}\u0000${row.sourceRevisionId}\u0000${row.mappingRevision}`)!;
      return projection.created
        ? [{ customerId: row.customerId, sourceId: row.sourceId, recordId: row.recordId, projectionId: projection.id, proposals: row.proposals }]
        : [];
    });
    if (newContent.length) {
      const policy = await this.retention(tx, source.customerId);
      await tx.$executeRaw`
        INSERT INTO public."IngestionProposalContent" ("customerId","sourceId","recordId","projectionId",proposals,"policyRevision")
        SELECT x."customerId",x."sourceId",x."recordId",x."projectionId",x.proposals,${policy.revision}
        FROM jsonb_to_recordset(${canonical(newContent)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"recordId" uuid,"projectionId" uuid,proposals jsonb)
        ORDER BY x."recordId",x."projectionId"`;
    }
    return pending.map((record) => {
      const identity = `${record.recordType}\u0000${record.recordKey}`;
      const recordRow = recordByIdentity.get(identity)!;
      const revisionRow = revisionByIdentity.get(`${recordRow.id}\u0000${record.revision}`)!;
      const projectionRow = projectionByIdentity.get(`${recordRow.id}\u0000${revisionRow.id}\u0000${mappingRevision}`)!;
      return {
        ...record,
        recordId: recordRow.id,
        sourceRevisionId: revisionRow.id,
        projectionId: projectionRow.id,
        recordCreated: insertedRecordKeys.has(identity),
        revisionCreated: revisionRow.created,
        projectionCreated: projectionRow.created,
      };
    });
  }

  private async createReceipt(
    tx: Tx,
    actor: Actor,
    correlationId: string,
    input: {
      sourceId: string;
      kind: "CONNECTOR_PAGE" | "CONNECTOR_EVENT" | "CSV_PREVIEW" | "SYNC_RESET";
      commandKey: string;
      requestHash: string;
      eventId?: string | null;
      configRevision: number;
      mappingRevision: number;
      generationBefore?: bigint | null;
      generationAfter?: bigint | null;
      cursorRevisionBefore?: bigint | null;
      cursorRevisionAfter?: bigint | null;
      scopeProjectIds: readonly string[];
      cursorTransition?: {
        generationBefore: bigint;
        generationAfter: bigint;
        cursorRevisionBefore: bigint;
        cursorRevisionAfter: bigint;
        stateAfter: "READY" | "TERMINAL";
        cursorEnvelopeHash: string | null;
      };
      outcomes: readonly OutcomeInput[];
    },
  ) {
    const id = randomUUID();
    const createdAt = new Date();
    const projectIds = [...new Set(input.scopeProjectIds)].sort(exactCompare);
    if (!projectIds.length || projectIds.length > 100)
      throw new IngestionPersistenceError("DENIED");
    const auditEventId = await this.audit(
      tx,
      actor,
      correlationId,
      input.kind === "CONNECTOR_PAGE"
        ? "ingestion.connector_page.persisted"
        : input.kind === "CONNECTOR_EVENT"
          ? "ingestion.connector_event.persisted"
          : input.kind === "CSV_PREVIEW"
          ? "ingestion.csv_preview.persisted"
            : "ingestion.sync_reset",
      {
        receiptId: id,
        kind: input.kind,
        sourceId: input.sourceId,
        configRevision: input.configRevision,
        mappingRevision: input.mappingRevision,
        scopeProjectIds: projectIds,
        requestHash: input.requestHash,
        outcomeCount: input.outcomes.length,
      },
      createdAt,
    );
    await tx.$executeRaw`
      INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","eventId","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt")
      VALUES (${id}::uuid,${actor.customerId}::uuid,${input.sourceId}::uuid,${actor.subject},${input.kind},${input.commandKey},${input.requestHash},${input.eventId ?? null},${input.configRevision},${input.mappingRevision},${input.generationBefore ?? null},${input.generationAfter ?? null},${input.cursorRevisionBefore ?? null},${input.cursorRevisionAfter ?? null},${input.outcomes.length},${auditEventId}::uuid,${createdAt})`;
    const grantRows = await tx.$queryRaw<{
      projectId: string; portfolioId: string; grantId: string; grantRole: string; grantScopeType: string; grantScopeId: string;
    }[]>`
      SELECT p.id AS "projectId",p."portfolioId",g.id AS "grantId",g.role AS "grantRole",g."scopeType" AS "grantScopeType",g."scopeId" AS "grantScopeId"
      FROM public."Project" p JOIN public."AccessGrant" g ON g."customerId"=p."customerId" AND g.subject=${actor.subject}
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
      WHERE p."customerId"=${actor.customerId}::uuid AND p.id=ANY(${projectIds}::uuid[])
        AND g.role IN ('project_manager','portfolio_manager','pmo_admin') AND g.role=ANY(${actor.roles}::text[])
      ORDER BY p.id,(g."scopeType"='project') DESC,g.id FOR SHARE OF g`;
    const grantByProject = new Map<string, (typeof grantRows)[number]>();
    for (const grant of grantRows)
      if (!grantByProject.has(grant.projectId)) grantByProject.set(grant.projectId, grant);
    if (grantByProject.size !== projectIds.length)
      throw new IngestionPersistenceError("DENIED");
    const sourceRows = await tx.$queryRaw<{ currentConfigRevision: number | null }[]>`
      SELECT "currentConfigRevision" FROM public."IngestionSource"
      WHERE "customerId"=${actor.customerId}::uuid AND id=${input.sourceId}::uuid`;
    if (sourceRows[0]?.currentConfigRevision !== input.configRevision)
      throw new IngestionPersistenceError("STALE_CONFIGURATION");
    const sourceReaderRows = await tx.$queryRaw<{ projectId: string }[]>`
      SELECT "projectId" FROM public."IngestionConfigurationReader"
      WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${input.sourceId}::uuid
        AND "configRevision"=${input.configRevision} AND subject=${actor.subject}
        AND "projectId"=ANY(${projectIds}::uuid[]) ORDER BY "projectId"`;
    if (sourceReaderRows.length !== projectIds.length)
      throw new IngestionPersistenceError("DENIED");
    const scopeRows = projectIds.map((projectId) => {
      const grant = grantByProject.get(projectId)!;
      return {
        customerId: actor.customerId,
        sourceId: input.sourceId,
        receiptId: id,
        projectId,
        grantId: grant.grantId,
        grantRole: grant.grantRole,
        grantScopeType: grant.grantScopeType,
        grantScopeId: grant.grantScopeId,
      };
    });
    await tx.$executeRaw`
      INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","grantId","grantRole","grantScopeType","grantScopeId")
      SELECT x."customerId",x."sourceId",x."receiptId",x."projectId",x."grantId",x."grantRole",x."grantScopeType",x."grantScopeId"
      FROM jsonb_to_recordset(${canonical(scopeRows)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"receiptId" uuid,"projectId" uuid,"grantId" uuid,"grantRole" text,"grantScopeType" text,"grantScopeId" uuid)
      ORDER BY x."projectId"`;
    if (input.cursorTransition) {
      const transition = input.cursorTransition;
      await tx.$executeRaw`
        INSERT INTO public."IngestionCursorTransition" ("customerId","sourceId","receiptId","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","stateAfter","cursorEnvelopeHash")
        VALUES (${actor.customerId}::uuid,${input.sourceId}::uuid,${id}::uuid,${transition.generationBefore},${transition.generationAfter},${transition.cursorRevisionBefore},${transition.cursorRevisionAfter},${transition.stateAfter},${transition.cursorEnvelopeHash})`;
    }
    if (input.outcomes.length) {
      const rows = input.outcomes.map((outcome, ordinal) => ({
        customerId: actor.customerId,
        sourceId: input.sourceId,
        receiptId: id,
        ordinal,
        state: outcome.state,
        operation: outcome.operation,
        errorCodes: outcome.errorCodes,
        projectId: outcome.projectId,
        recordKey: outcome.recordKey,
        recordId: outcome.recordId,
        sourceRevisionId: outcome.sourceRevisionId,
        projectionId: outcome.projectionId,
      }));
      await tx.$executeRaw`
        INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId","recordKey","recordId","sourceRevisionId","projectionId")
        SELECT x."customerId",x."sourceId",x."receiptId",x.ordinal+1,x.state,x.operation,x."errorCodes",x."projectId",x."recordKey",x."recordId",x."sourceRevisionId",x."projectionId"
        FROM jsonb_to_recordset(${canonical(rows)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"receiptId" uuid,ordinal integer,state text,operation text,"errorCodes" text[],"projectId" uuid,"recordKey" text,"recordId" uuid,"sourceRevisionId" uuid,"projectionId" uuid)
        ORDER BY x."receiptId",x.ordinal`;
    }
    return id;
  }

  private async run<T>(
    actor: Actor,
    operation: string,
    correlationId: string,
    fallback: IngestionPersistenceError["code"],
    execute: () => Promise<T>,
  ) {
    try {
      return await execute();
    } catch (error) {
      const safe = mapError(error, fallback);
      if (safe.code === "DENIED")
        await this.denialAudit(actor, operation, correlationId, safe.code);
      throw safe;
    }
  }

  private async currentSyncGrants(tx: Tx, source: MappingRow) {
    if (source.currentConfigRevision === null)
      throw new IngestionPersistenceError("STALE_CONFIGURATION");
    const grants = await tx.$queryRaw<{ projectId: string; grantId: string }[]>`
      SELECT p.id AS "projectId",g.id AS "grantId"
      FROM public."IngestionConfigurationProject" cp
      JOIN public."IngestionConfigurationRevision" c ON c."customerId"=cp."customerId" AND c."sourceId"=cp."sourceId" AND c.revision=cp."configRevision" AND c.sealed AND c.mapping->>'kind'='CONNECTOR'
      JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
      JOIN public."ConnectorSyncGrant" g ON g."customerId"=cp."customerId" AND g."sourceId"=cp."sourceId" AND g."projectId"=cp."projectId" AND g."configRevision"=cp."configRevision" AND g.active
      WHERE cp."customerId"=${source.customerId}::uuid AND cp."sourceId"=${source.id}::uuid AND cp."configRevision"=${source.currentConfigRevision}
      ORDER BY p.id FOR SHARE OF p,g`;
    const configured = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM public."IngestionConfigurationProject"
      WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${source.id}::uuid AND "configRevision"=${source.currentConfigRevision}`;
    if (!grants.length || grants.length !== Number(configured[0]?.count))
      throw new IngestionPersistenceError("DENIED");
    return grants;
  }

  private async serviceAudit(
    tx: Tx,
    customerId: string,
    event: string,
    detail: Record<string, unknown>,
    occurredAt: Date,
  ) {
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
      VALUES (${id}::uuid,${customerId}::uuid,'connector:jira-runtime',${event},${`connector-${randomUUID()}`},${JSON.stringify(detail)}::jsonb,${occurredAt})`;
    return id;
  }

  private async createSyncReceipt(
    tx: Tx,
    source: MappingRow,
    input: {
      jobId: string;
      kind: "CONNECTOR_PAGE" | "SYNC_RESET";
      commandKey: string;
      requestHash: string;
      configRevision: number;
      mappingRevision: number;
      grants: readonly { projectId: string; grantId: string }[];
      generationBefore: bigint;
      generationAfter: bigint;
      cursorRevisionBefore: bigint;
      cursorRevisionAfter: bigint;
      cursorTransition: { stateAfter: "READY" | "TERMINAL"; cursorEnvelopeHash: string | null };
      outcomes: readonly OutcomeInput[];
      createdAt: Date;
    },
  ) {
    const id = randomUUID();
    const projectIds = input.grants.map((grant) => grant.projectId).sort(exactCompare);
    const auditEventId = await this.serviceAudit(tx, source.customerId, input.kind === "CONNECTOR_PAGE" ? "ingestion.connector_page.persisted" : "ingestion.sync_reset", {
      receiptId: id,
      kind: input.kind,
      sourceId: source.id,
      configRevision: input.configRevision,
      mappingRevision: input.mappingRevision,
      scopeProjectIds: projectIds,
      requestHash: input.requestHash,
      outcomeCount: input.outcomes.length,
    }, input.createdAt);
    await tx.$executeRaw`
      INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash","eventId","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt","executionMode","syncJobId")
      VALUES (${id}::uuid,${source.customerId}::uuid,${source.id}::uuid,'connector:jira-runtime',${input.kind},${input.commandKey},${input.requestHash},NULL,${input.configRevision},${input.mappingRevision},${input.generationBefore},${input.generationAfter},${input.cursorRevisionBefore},${input.cursorRevisionAfter},${input.outcomes.length},${auditEventId}::uuid,${input.createdAt},'CONNECTOR_SYNC',${input.jobId}::uuid)`;
    const scopeRows = input.grants.map((grant) => ({
      customerId: source.customerId,
      sourceId: source.id,
      receiptId: id,
      projectId: grant.projectId,
      syncGrantId: grant.grantId,
    }));
    await tx.$executeRaw`
      INSERT INTO public."IngestionSyncReceiptProjectScope" ("customerId","sourceId","receiptId","projectId","syncGrantId")
      SELECT x."customerId",x."sourceId",x."receiptId",x."projectId",x."syncGrantId"
      FROM jsonb_to_recordset(${canonical(scopeRows)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"receiptId" uuid,"projectId" uuid,"syncGrantId" uuid)
      ORDER BY x."projectId"`;
    await tx.$executeRaw`
      INSERT INTO public."IngestionCursorTransition" ("customerId","sourceId","receiptId","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","stateAfter","cursorEnvelopeHash")
      VALUES (${source.customerId}::uuid,${source.id}::uuid,${id}::uuid,${input.generationBefore},${input.generationAfter},${input.cursorRevisionBefore},${input.cursorRevisionAfter},${input.cursorTransition.stateAfter},${input.cursorTransition.cursorEnvelopeHash})`;
    if (input.outcomes.length) {
      const rows = input.outcomes.map((outcome, ordinal) => ({
        customerId: source.customerId,
        sourceId: source.id,
        receiptId: id,
        ordinal,
        state: outcome.state,
        operation: outcome.operation,
        errorCodes: outcome.errorCodes,
        projectId: outcome.projectId,
        recordKey: outcome.recordKey,
        recordId: outcome.recordId,
        sourceRevisionId: outcome.sourceRevisionId,
        projectionId: outcome.projectionId,
      }));
      await tx.$executeRaw`
        INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes","projectId","recordKey","recordId","sourceRevisionId","projectionId")
        SELECT x."customerId",x."sourceId",x."receiptId",x.ordinal+1,x.state,x.operation,x."errorCodes",x."projectId",x."recordKey",x."recordId",x."sourceRevisionId",x."projectionId"
        FROM jsonb_to_recordset(${canonical(rows)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"receiptId" uuid,ordinal integer,state text,operation text,"errorCodes" text[],"projectId" uuid,"recordKey" text,"recordId" uuid,"sourceRevisionId" uuid,"projectionId" uuid)
        ORDER BY x."receiptId",x.ordinal`;
    }
    return id;
  }

  async readConnectorSyncSnapshot(customerIdInput: string, jobIdInput: string, now = new Date()) {
    const customerId = uuid(customerIdInput);
    const jobId = uuid(jobIdInput);
    return this.db.$transaction(async (tx) => {
      const locator = await tx.$queryRaw<{ sourceId: string }[]>`
        SELECT "sourceId" FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND id=${jobId}::uuid`;
      if (!locator[0]) throw new IngestionPersistenceError("NOT_FOUND");
      const source = await this.currentSource(tx, customerId, locator[0].sourceId, "SHARE");
      const jobs = await tx.$queryRaw<{
        id: string; state: string; configRevision: number; mappingRevision: number; resetRequested: boolean;
        resetCompleted: boolean; leaseUntil: Date | null; expiresAt: Date;
      }[]>`
        SELECT id,state,"configRevision","mappingRevision","resetRequested","resetCompleted","leaseUntil","expiresAt"
        FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid FOR SHARE`;
      const job = jobs[0];
      if (!job || job.state !== "RUNNING" || !job.leaseUntil || job.leaseUntil.getTime() <= now.getTime() || job.expiresAt.getTime() <= now.getTime())
        throw new IngestionPersistenceError("CONFLICT");
      if (job.configRevision !== source.currentConfigRevision || job.mappingRevision !== source.mappingRevision)
        throw new IngestionPersistenceError("STALE_CONFIGURATION");
      const configuration = await this.currentConfiguration(tx, source);
      if (configuration.mapping.kind !== "CONNECTOR" || configuration.mapping.adapterConfiguration === undefined)
        throw new IngestionPersistenceError("STALE_CONFIGURATION");
      await this.currentSyncGrants(tx, source);
      const resetRequired = job.resetRequested && !job.resetCompleted;
      if (!resetRequired && source.cursorState !== "READY")
        throw new IngestionPersistenceError("CURSOR_CONFLICT");
      const cursorRevision = Number(source.cursorRevision);
      const generation = Number(source.syncGeneration);
      if (!Number.isSafeInteger(cursorRevision) || !Number.isSafeInteger(generation))
        throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
      return {
        jobId,
        sourceId: source.id,
        configRevision: job.configRevision,
        mappingRevision: job.mappingRevision,
        configuration,
        cursor: resetRequired || source.cursorEnvelope === null
          ? null
          : this.vault.decrypt(source.cursorEnvelope, `ingestion-cursor:${customerId}:${source.id}`),
        cursorRevision,
        generation,
        cursorState: resetRequired ? "RESET_REQUIRED" : source.cursorState,
        resetRequired,
      };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
  }

  async resetConnectorCursorForJob(customerIdInput: string, jobIdInput: string, now = new Date()) {
    const customerId = uuid(customerIdInput);
    const jobId = uuid(jobIdInput);
    return this.db.$transaction(async (tx) => {
      const locator = await tx.$queryRaw<{ sourceId: string }[]>`
        SELECT "sourceId" FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND id=${jobId}::uuid`;
      if (!locator[0]) throw new IngestionPersistenceError("NOT_FOUND");
      const source = await this.currentSource(tx, customerId, locator[0].sourceId, "UPDATE");
      const jobs = await tx.$queryRaw<{
        state: string; configRevision: number; mappingRevision: number; resetRequested: boolean; resetCompleted: boolean; leaseUntil: Date | null;
      }[]>`
        SELECT state,"configRevision","mappingRevision","resetRequested","resetCompleted","leaseUntil"
        FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid FOR UPDATE`;
      const job = jobs[0];
      if (!job || job.state !== "RUNNING" || !job.leaseUntil || job.leaseUntil.getTime() <= now.getTime())
        throw new IngestionPersistenceError("CONFLICT");
      if (source.currentConfigRevision !== job.configRevision || source.mappingRevision !== job.mappingRevision)
        throw new IngestionPersistenceError("STALE_CONFIGURATION");
      if (!job.resetRequested || job.resetCompleted) return { reset: false, sourceId: source.id };
      const grants = await this.currentSyncGrants(tx, source);
      const nextGeneration = source.syncGeneration + 1n;
      const nextCursorRevision = source.cursorRevision + 1n;
      const requestHash = sha256(boundedJson({ jobId, configRevision: job.configRevision, mappingRevision: job.mappingRevision, generation: source.syncGeneration, cursorRevision: source.cursorRevision, reset: true }));
      const receiptId = await this.createSyncReceipt(tx, source, {
        jobId,
        kind: "SYNC_RESET",
        commandKey: `sync_reset_${jobId.replaceAll("-", "")}`,
        requestHash,
        configRevision: job.configRevision,
        mappingRevision: job.mappingRevision,
        grants,
        generationBefore: source.syncGeneration,
        generationAfter: nextGeneration,
        cursorRevisionBefore: source.cursorRevision,
        cursorRevisionAfter: nextCursorRevision,
        cursorTransition: { stateAfter: "READY", cursorEnvelopeHash: null },
        outcomes: [],
        createdAt: now,
      });
      await tx.$executeRaw`
        UPDATE public."IngestionSource" SET "cursorRevision"=${nextCursorRevision},"syncGeneration"=${nextGeneration},
          "cursorEnvelope"=NULL,"cursorState"='READY'
        WHERE "customerId"=${customerId}::uuid AND id=${source.id}::uuid`;
      await tx.$executeRaw`
        UPDATE public."ConnectorSyncJob" SET state='READY',"resetCompleted"=true,"leaseUntil"=NULL,"availableAt"=${now}
        WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid AND state='RUNNING'`;
      return { reset: true, receiptId, sourceId: source.id, cursorRevision: Number(nextCursorRevision), generation: Number(nextGeneration) };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
  }

  async persistConnectorPageForJob(input: {
    customerId: string;
    jobId: string;
    expectedConfigRevision: number;
    expectedMappingRevision: number;
    expectedCursorRevision: number;
    expectedGeneration: number;
    page: unknown;
  }, now = new Date()) {
    const customerId = uuid(input.customerId);
    const jobId = uuid(input.jobId);
    const pageInput = parseIngestion(connectorChangePageSchema, input.page);
    return this.db.$transaction(async (tx) => {
      const locator = await tx.$queryRaw<{ sourceId: string }[]>`
        SELECT "sourceId" FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND id=${jobId}::uuid`;
      if (!locator[0]) throw new IngestionPersistenceError("NOT_FOUND");
      const source = await this.currentSource(tx, customerId, locator[0].sourceId, "UPDATE");
      const jobs = await tx.$queryRaw<{
        state: string; configRevision: number; mappingRevision: number; resetRequested: boolean; resetCompleted: boolean; leaseUntil: Date | null; expiresAt: Date;
      }[]>`
        SELECT state,"configRevision","mappingRevision","resetRequested","resetCompleted","leaseUntil","expiresAt"
        FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid FOR UPDATE`;
      const job = jobs[0];
      if (!job || job.state !== "RUNNING" || !job.leaseUntil || job.leaseUntil.getTime() <= now.getTime() || job.expiresAt.getTime() <= now.getTime())
        throw new IngestionPersistenceError("CONFLICT");
      if (job.resetRequested && !job.resetCompleted)
        throw new IngestionPersistenceError("CURSOR_CONFLICT");
      if (source.currentConfigRevision !== job.configRevision || source.mappingRevision !== job.mappingRevision ||
        job.configRevision !== input.expectedConfigRevision || job.mappingRevision !== input.expectedMappingRevision ||
        Number(source.cursorRevision) !== input.expectedCursorRevision || Number(source.syncGeneration) !== input.expectedGeneration || source.cursorState !== "READY")
        throw new IngestionPersistenceError("STALE_CONFIGURATION");
      const configuration = await this.currentConfiguration(tx, source);
      if (configuration.mapping.kind !== "CONNECTOR" || configuration.mapping.adapterConfiguration === undefined)
        throw new IngestionPersistenceError("STALE_CONFIGURATION");
      const grants = await this.currentSyncGrants(tx, source);
      const projectIds = grants.map((grant) => grant.projectId);
      const allowedFactTypes = configuration.mapping.factTypes;
      if (pageInput.records.some((record) => record.observations.some((observation) => !allowedFactTypes.includes(observation.factType))))
        throw new IngestionPersistenceError("INVALID_REQUEST");
      const persistedCursor = source.cursorEnvelope === null
        ? null
        : this.vault.decrypt(source.cursorEnvelope, `ingestion-cursor:${customerId}:${source.id}`);
      const scope = { binding: configuration.binding, projectIds };
      const validated = validateConnectorPage({ scope, cursor: persistedCursor }, pageInput);
      const pending: PendingRecord[] = validated.records.map((record) => ({
        recordType: record.ref.recordType,
        recordKey: record.ref.recordId,
        projectId: record.ref.projectId,
        revision: record.revision,
        sourceContentHash: record.sourceContentHash,
        remoteObservedAt: new Date(record.observedAt),
        remoteEffectiveAt: new Date(record.effectiveAt),
        proposals: normalizeProposals(record.observations),
      }));
      const prepared = await this.prepareRecords(tx, source, job.mappingRevision, pending);
      const byIdentity = new Map(prepared.map((record) => [`${record.recordType}\u0000${record.recordKey}`, record]));
      const outcomes: OutcomeInput[] = validated.records.map((record) => {
        const saved = byIdentity.get(`${record.ref.recordType}\u0000${record.ref.recordId}`);
        if (!saved) throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
        return {
          state: "ACCEPTED",
          operation: saved.recordCreated ? "CREATE" : saved.projectionCreated || saved.revisionCreated ? "UPDATE" : "UNCHANGED",
          errorCodes: [],
          projectId: saved.projectId,
          recordKey: saved.recordKey,
          recordId: saved.recordId,
          sourceRevisionId: saved.sourceRevisionId,
          projectionId: saved.projectionId,
        };
      });
      await this.retention(tx, customerId);
      const nextCursorRevision = source.cursorRevision + 1n;
      const cursorEnvelope = validated.terminal || validated.nextCursor === null
        ? null
        : this.vault.encrypt(validated.nextCursor, `ingestion-cursor:${customerId}:${source.id}`);
      const requestHash = sha256(boundedJson({
        jobId,
        configRevision: job.configRevision,
        mappingRevision: job.mappingRevision,
        cursorRevision: input.expectedCursorRevision,
        generation: input.expectedGeneration,
        page: pageInput,
      }));
      const receiptId = await this.createSyncReceipt(tx, source, {
        jobId,
        kind: "CONNECTOR_PAGE",
        commandKey: `sync_page_${jobId.replaceAll("-", "")}`,
        requestHash,
        configRevision: job.configRevision,
        mappingRevision: job.mappingRevision,
        grants,
        generationBefore: source.syncGeneration,
        generationAfter: source.syncGeneration,
        cursorRevisionBefore: source.cursorRevision,
        cursorRevisionAfter: nextCursorRevision,
        cursorTransition: {
          stateAfter: validated.terminal ? "TERMINAL" : "READY",
          cursorEnvelopeHash: cursorEnvelope === null ? null : sha256(cursorEnvelope),
        },
        outcomes,
        createdAt: now,
      });
      const healthAuditId = await this.serviceAudit(tx, customerId, "ingestion.health.updated", {
        sourceId: source.id, state: "HEALTHY", code: "NONE",
      }, now);
      void healthAuditId;
      await tx.$executeRaw`
        UPDATE public."IngestionSource" SET "cursorRevision"=${nextCursorRevision},"cursorEnvelope"=${cursorEnvelope},
          "cursorState"=${validated.terminal ? "TERMINAL" : "READY"},"lastSuccessReceiptId"=${receiptId}::uuid,
          "healthState"='HEALTHY',"healthCode"='NONE',"healthCheckedAt"=${now}
        WHERE "customerId"=${customerId}::uuid AND id=${source.id}::uuid`;
      await tx.$executeRaw`
        UPDATE public."ConnectorSyncJob" SET state='COMPLETED',"leaseUntil"=NULL,"completedAt"=${now}
        WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid AND state='RUNNING'`;
      let nextJobId: string | null = null;
      if (!validated.terminal && validated.nextCursor !== null) {
        nextJobId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO public."ConnectorSyncJob" (id,"customerId","sourceId","configRevision","mappingRevision",kind,state,"eventId","idempotencyKey","resetRequested","resetCompleted",attempts,"createdAt","availableAt","expiresAt")
          VALUES (${nextJobId}::uuid,${customerId}::uuid,${source.id}::uuid,${job.configRevision},${job.mappingRevision},'SCHEDULED','READY',NULL,${`continue:${jobId}:${nextCursorRevision}`},false,false,0,${now},${now},${addSeconds(now, 24 * 60 * 60)})`;
      }
      return { receiptId, cursorRevision: Number(nextCursorRevision), terminal: validated.terminal, nextJobId };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
  }

  async configure(actorInputValue: Actor, input: IngestionConfiguration, correlationInput: string) {
    const actor = parseActor(actorInputValue);
    const correlationId = contextSchema(correlationInput);
    return this.run(actor, "configure", correlationId, "PERSISTENCE_FAILED", async () => {
      const configuration = stableConfig(parseIngestion(ingestionConfigurationSchema, input));
      if (configuration.binding.customerId !== actor.customerId)
        throw new IngestionPersistenceError("DENIED");
      return this.db.$transaction(async (tx) => {
        const found = await tx.$queryRaw<MappingRow[]>`
          SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthState","healthCode","healthCheckedAt","lastSuccessReceiptId"
          FROM public."IngestionSource" WHERE "customerId"=${actor.customerId}::uuid AND id=${configuration.binding.sourceId}::uuid FOR UPDATE`;
        let source = found[0];
        if (source && (source.sourceType !== configuration.binding.sourceType || source.origin !== configuration.binding.origin))
          throw new IngestionPersistenceError("CONFLICT");
        const previousSyncGrants = source
          ? await tx.$queryRaw<{ id: string; projectId: string; configRevision: number; revision: number; active: boolean }[]>`
              SELECT id,"projectId","configRevision",revision,active FROM public."ConnectorSyncGrant"
              WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${configuration.binding.sourceId}::uuid
              ORDER BY "projectId" FOR UPDATE`
          : [];
        const projectIds = [...new Set([
          ...configuration.projects.map((project) => project.projectId),
          ...previousSyncGrants.map((grant) => grant.projectId),
        ])].sort(exactCompare);
        await this.authorizedProjects(tx, actor, projectIds, "configure");
        let configRevision = 1;
        let mappingRevision = 1;
        if (source) {
          if (source.currentConfigRevision !== null) {
            const previous = await tx.$queryRaw<{ mapping: unknown; revision: number; mappingRevision: number }[]>`
              SELECT mapping,revision,"mappingRevision" FROM public."IngestionConfigurationRevision"
              WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${configuration.binding.sourceId}::uuid AND revision=${source.currentConfigRevision} AND sealed`;
            if (!previous[0]) throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
            const priorMapping = canonical(requireJsonObject(previous[0].mapping));
            mappingRevision = previous[0].mappingRevision;
            configRevision = previous[0].revision + 1;
            if (priorMapping !== canonical(configuration.mapping)) mappingRevision++;
          }
        } else {
          await tx.$executeRaw`
            INSERT INTO public."IngestionSource" (id,"customerId","sourceType",origin)
            VALUES (${configuration.binding.sourceId}::uuid,${actor.customerId}::uuid,${configuration.binding.sourceType},${configuration.binding.origin})`;
          const inserted = await tx.$queryRaw<MappingRow[]>`
            SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthState","healthCode","healthCheckedAt","lastSuccessReceiptId"
            FROM public."IngestionSource" WHERE "customerId"=${actor.customerId}::uuid AND id=${configuration.binding.sourceId}::uuid FOR UPDATE`;
          source = inserted[0];
          if (!source) throw new IngestionPersistenceError("PERSISTENCE_FAILED");
        }
        const createdAt = new Date();
        const auditEventId = await this.audit(
          tx,
          actor,
          correlationId,
          "ingestion.configuration.changed",
          { sourceId: configuration.binding.sourceId, configRevision, mappingRevision },
          createdAt,
        );
        await tx.$executeRaw`
          INSERT INTO public."IngestionConfigurationRevision" ("customerId","sourceId",revision,"mappingRevision",mapping,"changedBy","auditEventId","createdAt")
          VALUES (${actor.customerId}::uuid,${configuration.binding.sourceId}::uuid,${configRevision},${mappingRevision},${canonical(configuration.mapping)}::jsonb,${actor.subject},${auditEventId}::uuid,${createdAt})`;
        const projectRows = configuration.projects.map((project) => ({
          customerId: actor.customerId,
          sourceId: configuration.binding.sourceId,
          configRevision,
          projectId: project.projectId,
        }));
        await tx.$executeRaw`
          INSERT INTO public."IngestionConfigurationProject" ("customerId","sourceId","configRevision","projectId")
          SELECT x."customerId",x."sourceId",x."configRevision",x."projectId"
          FROM jsonb_to_recordset(${canonical(projectRows)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"configRevision" integer,"projectId" uuid)
          ORDER BY x."projectId"`;
        const readerRows = configuration.projects.flatMap((project) =>
          project.readers.map((subject) => ({
            customerId: actor.customerId,
            sourceId: configuration.binding.sourceId,
            configRevision,
            projectId: project.projectId,
            subject,
          })),
        );
        if (readerRows.length)
          await tx.$executeRaw`
            INSERT INTO public."IngestionConfigurationReader" ("customerId","sourceId","configRevision","projectId",subject)
            SELECT x."customerId",x."sourceId",x."configRevision",x."projectId",x.subject
            FROM jsonb_to_recordset(${canonical(readerRows)}::jsonb) AS x("customerId" uuid,"sourceId" uuid,"configRevision" integer,"projectId" uuid,subject text)
            ORDER BY x."projectId",x.subject`;
        await tx.$executeRaw`
          UPDATE public."IngestionConfigurationRevision" SET sealed=true
          WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${configuration.binding.sourceId}::uuid AND revision=${configRevision}`;
        await tx.$executeRaw`
          UPDATE public."IngestionSource"
          SET "currentConfigRevision"=${configRevision},"mappingRevision"=${mappingRevision},
              "cursorEnvelope"=NULL,"cursorState"='RESET_REQUIRED'
          WHERE "customerId"=${actor.customerId}::uuid AND id=${configuration.binding.sourceId}::uuid`;
        await tx.$executeRaw`
          UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
          WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${configuration.binding.sourceId}::uuid AND state IN ('READY','RUNNING')`;
        const syncProjectIds = configuration.binding.sourceType === "jira" && configuration.mapping.kind === "CONNECTOR"
          ? configuration.projects.map((project) => project.projectId).sort(exactCompare)
          : [];
        const syncGrantByProject = new Map(previousSyncGrants.map((grant) => [grant.projectId, grant]));
        for (const projectId of syncProjectIds) {
          const previousGrant = syncGrantByProject.get(projectId);
          const grantId = previousGrant?.id ?? randomUUID();
          const revision = previousGrant ? previousGrant.revision + 1 : 1;
          const changedAt = new Date();
          const auditEventId = await this.audit(tx, actor, correlationId, "ingestion.sync_scope.granted", {
            sourceId: configuration.binding.sourceId,
            projectId,
            configRevision,
            revision,
            active: true,
          }, changedAt);
          if (previousGrant) {
            await tx.$executeRaw`
              UPDATE public."ConnectorSyncGrant"
              SET "configRevision"=${configRevision},revision=${revision},active=true,
                  "changedBy"=${actor.subject},"auditEventId"=${auditEventId}::uuid,"changedAt"=${changedAt}
              WHERE id=${grantId}::uuid AND "customerId"=${actor.customerId}::uuid AND "sourceId"=${configuration.binding.sourceId}::uuid`;
          } else {
            await tx.$executeRaw`
              INSERT INTO public."ConnectorSyncGrant" (id,"customerId","sourceId","projectId","configRevision",revision,active,"changedBy","auditEventId","changedAt")
              VALUES (${grantId}::uuid,${actor.customerId}::uuid,${configuration.binding.sourceId}::uuid,${projectId}::uuid,${configRevision},${revision},true,${actor.subject},${auditEventId}::uuid,${changedAt})`;
          }
          syncGrantByProject.delete(projectId);
        }
        for (const previousGrant of syncGrantByProject.values()) {
          if (!previousGrant.active) continue;
          const revision = previousGrant.revision + 1;
          const changedAt = new Date();
          const auditEventId = await this.audit(tx, actor, correlationId, "ingestion.sync_scope.revoked", {
            sourceId: configuration.binding.sourceId,
            projectId: previousGrant.projectId,
            configRevision: previousGrant.configRevision,
            revision,
            active: false,
          }, changedAt);
          await tx.$executeRaw`
            UPDATE public."ConnectorSyncGrant"
            SET revision=${revision},active=false,"changedBy"=${actor.subject},
                "auditEventId"=${auditEventId}::uuid,"changedAt"=${changedAt}
            WHERE id=${previousGrant.id}::uuid AND "customerId"=${actor.customerId}::uuid AND "sourceId"=${configuration.binding.sourceId}::uuid`;
        }
        return { sourceId: configuration.binding.sourceId, configRevision, mappingRevision };
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
    });
  }

  async readSyncSnapshot(
    actorInputValue: Actor,
    sourceIdInput: string,
  ): Promise<IngestionSyncSnapshot> {
    const actor = parseActor(actorInputValue);
    const sourceId = uuid(sourceIdInput);
    return this.run(actor, "sync_snapshot", randomUUID(), "PERSISTENCE_FAILED", async () => {
      const snapshot = await this.preflight(sourceId, actor);
      if (
        snapshot.source.sourceType !== "jira" ||
        snapshot.configuration.mapping.kind !== "CONNECTOR" ||
        snapshot.configuration.mapping.adapterConfiguration === undefined
      )
        throw new IngestionPersistenceError("NOT_FOUND");
      const cursorRevision = Number(snapshot.source.cursorRevision);
      const generation = Number(snapshot.source.syncGeneration);
      if (!Number.isSafeInteger(cursorRevision) || !Number.isSafeInteger(generation))
        throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
      return {
        sourceId,
        configuration: snapshot.configuration,
        configRevision: snapshot.configRevision,
        mappingRevision: snapshot.mappingRevision,
        cursor:
          snapshot.source.cursorEnvelope === null
            ? null
            : this.vault.decrypt(
                snapshot.source.cursorEnvelope,
                `ingestion-cursor:${actor.customerId}:${sourceId}`,
              ),
        cursorRevision,
        generation,
        cursorState: ingestionCursorStateSchema.parse(snapshot.source.cursorState),
      };
    });
  }

  async listDueJiraSourceIds(
    customerIdInput: string,
    intervalMinutes: number,
    limit: number,
    now = new Date(),
  ): Promise<string[]> {
    const customerId = uuid(customerIdInput);
    if (
      !Number.isInteger(intervalMinutes) ||
      intervalMinutes < 1 ||
      intervalMinutes > 1440 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isFinite(now.getTime())
    )
      throw new IngestionPersistenceError("INVALID_REQUEST");
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."IngestionSource"
      WHERE "customerId"=${customerId}::uuid AND "sourceType"='jira'
        AND "currentConfigRevision" IS NOT NULL
        AND ("healthCheckedAt" IS NULL OR "healthCheckedAt"<=${now}::timestamptz - make_interval(mins => ${intervalMinutes}))
      ORDER BY "healthCheckedAt" ASC NULLS FIRST,id
      LIMIT ${limit}`;
    return rows.map((row) => uuid(row.id));
  }

  async persistConnectorPage(
    actorInputValue: Actor,
    input: { sourceId: string; configRevision: number; mappingRevision: number; expectedCursorRevision: number; expectedGeneration: number; commandKey: string; page: unknown },
    correlationInput: string,
  ) {
    const actor = parseActor(actorInputValue);
    const correlationId = contextSchema(correlationInput);
    const sourceId = uuid(input.sourceId);
    const commandKey = parseIngestion(ingestionCommandKeySchema, input.commandKey);
    return this.run(actor, "connector_page", correlationId, "PERSISTENCE_FAILED", async () => {
      const snapshot = await this.preflight(sourceId, actor);
      if (snapshot.configuration.mapping.kind !== "CONNECTOR")
        throw new IngestionPersistenceError("INVALID_REQUEST");
      const allowedFactTypes = snapshot.configuration.mapping.factTypes;
      const projectIds = snapshot.configuration.projects.map((project) => project.projectId);
      const pageInput = parseIngestion(connectorChangePageSchema, input.page);
      const inputCursor = pageInput.inputCursor;
      const hashInput = boundedJson({
        configRevision: input.configRevision,
        mappingRevision: input.mappingRevision,
        expectedCursorRevision: input.expectedCursorRevision,
        expectedGeneration: input.expectedGeneration,
        page: pageInput,
      });
      const requestHash = sha256(hashInput);
      if (pageInput.records.some((record) => record.observations.some((item) => !allowedFactTypes.includes(item.factType))))
        throw new IngestionPersistenceError("INVALID_REQUEST");
      return this.db.$transaction(async (tx) => {
        const { source, config } = await this.lockAuthorizedSource(tx, actor, sourceId, projectIds, "write");
        if (source.currentConfigRevision !== input.configRevision || source.mappingRevision !== input.mappingRevision || snapshot.configRevision !== input.configRevision || snapshot.mappingRevision !== input.mappingRevision)
          throw new IngestionPersistenceError("STALE_CONFIGURATION");
        const existing = await this.commandReceipt(tx, actor.customerId, sourceId, actor.subject, "CONNECTOR_PAGE", commandKey);
        if (existing) {
          await this.sourceReaders(tx, actor, source, config, projectIds);
          const replayed = await this.replay(existing, requestHash);
          return { receiptId: replayed.receiptId, replayed: true, cursorRevision: replayed.cursorRevision! };
        }
        if (Number(source.cursorRevision) !== input.expectedCursorRevision || Number(source.syncGeneration) !== input.expectedGeneration)
          throw new IngestionPersistenceError("CURSOR_CONFLICT");
        if (source.cursorState !== "READY") throw new IngestionPersistenceError("CURSOR_CONFLICT");
        const persistedCursor = source.cursorEnvelope === null
          ? null
          : this.vault.decrypt(source.cursorEnvelope, `ingestion-cursor:${actor.customerId}:${sourceId}`);
        if (persistedCursor !== inputCursor) throw new IngestionPersistenceError("CURSOR_CONFLICT");
        const scope = { binding: config.binding, projectIds };
        const page = parseIngestion(connectorChangePageSchema, input.page);
        const requestCursor = page.inputCursor;
        const validated = validateConnectorPage({ scope, cursor: requestCursor }, page);
        const pending: PendingRecord[] = validated.records.map((record) => ({
          recordType: record.ref.recordType,
          recordKey: record.ref.recordId,
          projectId: record.ref.projectId,
          revision: record.revision,
          sourceContentHash: record.sourceContentHash,
          remoteObservedAt: new Date(record.observedAt),
          remoteEffectiveAt: new Date(record.effectiveAt),
          proposals: normalizeProposals(record.observations),
        }));
        const prepared = await this.prepareRecords(tx, source, input.mappingRevision, pending);
        const byIdentity = new Map(prepared.map((record) => [`${record.recordType}\u0000${record.recordKey}`, record]));
        const outcomes: OutcomeInput[] = validated.records.map((record) => {
          const saved = byIdentity.get(`${record.ref.recordType}\u0000${record.ref.recordId}`)!;
          return {
            state: ingestionRowStateSchema.parse("ACCEPTED"),
            operation: ingestionRowOperationSchema.parse(saved.recordCreated ? "CREATE" : saved.projectionCreated || saved.revisionCreated ? "UPDATE" : "UNCHANGED"),
            errorCodes: [],
            projectId: saved.projectId,
            recordKey: saved.recordKey,
            recordId: saved.recordId,
            sourceRevisionId: saved.sourceRevisionId,
            projectionId: saved.projectionId,
          };
        });
        await this.retention(tx, actor.customerId);
        const nextCursorRevision = source.cursorRevision + 1n;
        const nextGeneration = source.syncGeneration;
        const cursorEnvelope = validated.terminal || validated.nextCursor === null
          ? null
          : this.vault.encrypt(validated.nextCursor, `ingestion-cursor:${actor.customerId}:${sourceId}`);
        const receiptId = await this.createReceipt(tx, actor, correlationId, {
          sourceId,
          kind: "CONNECTOR_PAGE",
          commandKey,
          requestHash,
          configRevision: input.configRevision,
          mappingRevision: input.mappingRevision,
          scopeProjectIds: projectIds,
          generationBefore: source.syncGeneration,
          generationAfter: nextGeneration,
          cursorRevisionBefore: source.cursorRevision,
          cursorRevisionAfter: nextCursorRevision,
          cursorTransition: {
            generationBefore: source.syncGeneration,
            generationAfter: nextGeneration,
            cursorRevisionBefore: source.cursorRevision,
            cursorRevisionAfter: nextCursorRevision,
            stateAfter: validated.terminal ? "TERMINAL" : "READY",
            cursorEnvelopeHash: cursorEnvelope === null ? null : sha256(cursorEnvelope),
          },
          outcomes,
        });
        const checkedAt = new Date();
        await this.audit(
          tx,
          actor,
          correlationId,
          "ingestion.health.updated",
          { sourceId, state: "HEALTHY", code: "NONE" },
          checkedAt,
        );
        await tx.$executeRaw`
          UPDATE public."IngestionSource"
          SET "cursorRevision"=${nextCursorRevision},"cursorEnvelope"=${cursorEnvelope},
              "cursorState"=${validated.terminal ? "TERMINAL" : "READY"},
              "lastSuccessReceiptId"=${receiptId}::uuid,"healthState"='HEALTHY',"healthCode"='NONE',"healthCheckedAt"=${checkedAt}
          WHERE "customerId"=${actor.customerId}::uuid AND id=${sourceId}::uuid`;
        return { receiptId, replayed: false, cursorRevision: Number(nextCursorRevision) };
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
    });
  }

  async persistConnectorEvent(
    actorInputValue: Actor,
    input: { sourceId: string; configRevision: number; mappingRevision: number; commandKey: string; eventId: string; record: unknown },
    correlationInput: string,
  ) {
    const actor = parseActor(actorInputValue);
    const correlationId = contextSchema(correlationInput);
    const sourceId = uuid(input.sourceId);
    const commandKey = parseIngestion(ingestionCommandKeySchema, input.commandKey);
    const eventId = parseIngestion(ingestionText(256), input.eventId);
    return this.run(actor, "connector_event", correlationId, "PERSISTENCE_FAILED", async () => {
      const snapshot = await this.preflight(sourceId, actor);
      if (snapshot.configuration.mapping.kind !== "CONNECTOR")
        throw new IngestionPersistenceError("INVALID_REQUEST");
      const allowedFactTypes = snapshot.configuration.mapping.factTypes;
      const scope = {
        binding: snapshot.configuration.binding,
        projectIds: snapshot.configuration.projects.map((project) => project.projectId),
      };
      const parsed = validateConnectorRecord(scope, (input.record as { ref?: unknown } | null)?.ref, input.record);
      const requestHash = sha256(boundedJson({
        eventId,
        configRevision: input.configRevision,
        mappingRevision: input.mappingRevision,
        record: parsed,
      }));
      return this.db.$transaction(async (tx) => {
        const projectIds = scope.projectIds;
        const { source, config } = await this.lockAuthorizedSource(tx, actor, sourceId, projectIds, "write");
        if (source.currentConfigRevision !== snapshot.configRevision || source.mappingRevision !== snapshot.mappingRevision)
          throw new IngestionPersistenceError("STALE_CONFIGURATION");
        if (source.currentConfigRevision !== input.configRevision || source.mappingRevision !== input.mappingRevision)
          throw new IngestionPersistenceError("STALE_CONFIGURATION");
        if (parsed.observations.some((item) => !allowedFactTypes.includes(item.factType)))
          throw new IngestionPersistenceError("INVALID_REQUEST");
        const command = await this.commandReceipt(tx, actor.customerId, sourceId, actor.subject, "CONNECTOR_EVENT", commandKey);
        if (command) {
          await this.sourceReaders(tx, actor, source, config, projectIds);
          const replayed = await this.replay(command, requestHash);
          return { receiptId: replayed.receiptId, replayed: true };
        }
        const previousEvent = await this.eventReceipt(tx, actor.customerId, sourceId, eventId);
        if (previousEvent) {
          await this.sourceReaders(tx, actor, source, config, projectIds);
          if (previousEvent.requestHash !== requestHash)
            throw new IngestionPersistenceError("CONFLICT");
          return { receiptId: previousEvent.id, replayed: true };
        }
        const pending: PendingRecord[] = [{
          recordType: parsed.ref.recordType,
          recordKey: parsed.ref.recordId,
          projectId: parsed.ref.projectId,
          revision: parsed.revision,
          sourceContentHash: parsed.sourceContentHash,
          remoteObservedAt: new Date(parsed.observedAt),
          remoteEffectiveAt: new Date(parsed.effectiveAt),
          proposals: normalizeProposals(parsed.observations),
        }];
        boundedJson(pending);
        const [saved] = await this.prepareRecords(tx, source, input.mappingRevision, pending);
        if (!saved) throw new IngestionPersistenceError("PERSISTENCE_FAILED");
        await this.retention(tx, actor.customerId);
        const outcome: OutcomeInput = {
          state: "ACCEPTED",
          operation: saved.recordCreated ? "CREATE" : saved.projectionCreated || saved.revisionCreated ? "UPDATE" : "UNCHANGED",
          errorCodes: [],
          projectId: saved.projectId,
          recordKey: saved.recordKey,
          recordId: saved.recordId,
          sourceRevisionId: saved.sourceRevisionId,
          projectionId: saved.projectionId,
        };
        const receiptId = await this.createReceipt(tx, actor, correlationId, {
          sourceId,
          kind: "CONNECTOR_EVENT",
          commandKey,
          requestHash,
          eventId,
          configRevision: input.configRevision,
          mappingRevision: input.mappingRevision,
          scopeProjectIds: projectIds,
          outcomes: [outcome],
        });
        const checkedAt = new Date();
        await this.audit(
          tx,
          actor,
          correlationId,
          "ingestion.health.updated",
          { sourceId, state: "HEALTHY", code: "NONE" },
          checkedAt,
        );
        await tx.$executeRaw`
          UPDATE public."IngestionSource" SET "lastSuccessReceiptId"=${receiptId}::uuid,
            "healthState"='HEALTHY',"healthCode"='NONE',"healthCheckedAt"=${checkedAt}
          WHERE "customerId"=${actor.customerId}::uuid AND id=${sourceId}::uuid`;
        return { receiptId, replayed: false };
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
    });
  }

  async persistCsvPreview(
    actorInputValue: Actor,
    input: { sourceId: string; configRevision: number; mappingRevision: number; commandKey: string; fileName: string; csv: unknown; baseline?: unknown },
    correlationInput: string,
  ) {
    const actor = parseActor(actorInputValue);
    const correlationId = contextSchema(correlationInput);
    const sourceId = uuid(input.sourceId);
    const request = parseIngestion(ingestionPreviewRequestSchema, {
      sourceId,
      fileName: input.fileName,
      csv: input.csv,
      commandKey: input.commandKey,
    });
    const commandKey = parseIngestion(ingestionCommandKeySchema, request.commandKey);
    return this.run(actor, "csv_preview", correlationId, "PERSISTENCE_FAILED", async () => {
      const snapshot = await this.preflight(sourceId, actor);
      if (snapshot.configuration.mapping.kind !== "CSV")
        throw new IngestionPersistenceError("INVALID_REQUEST");
      const projectIds = snapshot.configuration.projects.map((project) => project.projectId);
      const baseline = input.baseline === undefined ? undefined : parseIngestion(spreadsheetBaselineSchema, input.baseline);
      const config = parseIngestion(persistedSpreadsheetConfigSchema, {
        customerId: actor.customerId,
        sourceId,
        sheet: snapshot.configuration.mapping.sheet,
        mappingRevision: String(snapshot.mappingRevision),
        fileName: request.fileName,
        identityColumn: snapshot.configuration.mapping.identityColumn,
        projectColumn: snapshot.configuration.mapping.projectColumn,
        projectIds,
        fields: snapshot.configuration.mapping.fields,
      });
      const preview = previewSpreadsheetCsv(request.csv, config, baseline);
      const parsedCsv = parseCsvPreview(request.csv);
      const csvHash = sha256(Buffer.from(request.csv, "utf8"));
      const requestHash = sha256(boundedJson({
        csvHash,
        configRevision: input.configRevision,
        mappingRevision: input.mappingRevision,
        baseline: baseline ?? null,
      }));
      const projectSet = new Set(projectIds);
      const pending: PendingRecord[] = [];
      for (const [index, row] of preview.rows.entries()) {
        if (row.status !== "VALID") continue;
        const sourceHash = canonicalCsvRow(parsedCsv.headers, parsedCsv.rows[index]!);
        pending.push({
          recordType: csvType(preview.sheet),
          recordKey: csvIdentityKey(preview.sheet, row.key),
          projectId: row.projectId,
          revision: `sha256:${sourceHash}`,
          sourceContentHash: sourceHash,
          remoteObservedAt: null,
          remoteEffectiveAt: null,
          proposals: normalizeProposals(row.proposals),
        });
      }
      const projectedOutcomes = preview.rows.map((row): OutcomeInput => {
        if (row.status !== "VALID") {
          const projectId = projectSet.has(row.projectId) ? row.projectId : null;
          const validKey = row.identity !== null && projectId !== null;
          return {
            state: row.status === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "INVALID",
            operation: "NONE",
            errorCodes: readSafeErrors(row),
            projectId,
            recordKey: validKey ? csvIdentityKey(preview.sheet, row.key) : null,
            recordId: null,
            sourceRevisionId: null,
            projectionId: null,
          };
        }
        return {
          state: "ACCEPTED",
          operation: row.operation,
          errorCodes: [],
          projectId: row.projectId,
          recordKey: csvIdentityKey(preview.sheet, row.key),
          recordId: null,
          sourceRevisionId: null,
          projectionId: null,
        };
      });
      boundedJson({ rows: projectedOutcomes, records: pending });
      return this.db.$transaction(async (tx) => {
        const { source, config } = await this.lockAuthorizedSource(tx, actor, sourceId, projectIds, "write");
        if (source.currentConfigRevision !== input.configRevision || source.mappingRevision !== input.mappingRevision || snapshot.configRevision !== input.configRevision || snapshot.mappingRevision !== input.mappingRevision)
          throw new IngestionPersistenceError("STALE_CONFIGURATION");
        const existing = await this.commandReceipt(tx, actor.customerId, sourceId, actor.subject, "CSV_PREVIEW", commandKey);
        if (existing) {
          await this.sourceReaders(tx, actor, source, config, projectIds);
          const replayed = await this.replay(existing, requestHash);
          return { receiptId: replayed.receiptId, replayed: true, rowCount: replayed.rowCount ?? 0 };
        }
        await this.retention(tx, actor.customerId);
        const prepared = await this.prepareRecords(tx, source, input.mappingRevision, pending);
        const preparedByKey = new Map(prepared.map((item) => [item.recordKey, item]));
        const outcomes = projectedOutcomes.map((outcome) => {
          if (outcome.state !== "ACCEPTED") return outcome;
          const saved = preparedByKey.get(outcome.recordKey!);
          if (!saved) throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
          return {
            ...outcome,
            recordId: saved.recordId,
            sourceRevisionId: saved.sourceRevisionId,
            projectionId: saved.projectionId,
          };
        });
        const receiptId = await this.createReceipt(tx, actor, correlationId, {
          sourceId,
          kind: "CSV_PREVIEW",
          commandKey,
          requestHash,
          configRevision: input.configRevision,
          mappingRevision: input.mappingRevision,
          scopeProjectIds: projectIds,
          outcomes,
        });
        return { receiptId, replayed: false, rowCount: outcomes.length };
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
    });
  }

  async resetSync(
    actorInputValue: Actor,
    input: { sourceId: string; configRevision: number; expectedCursorRevision: number; expectedGeneration: number; commandKey: string },
    correlationInput: string,
  ) {
    const actor = parseActor(actorInputValue);
    const correlationId = contextSchema(correlationInput);
    const sourceId = uuid(input.sourceId);
    const commandKey = parseIngestion(ingestionCommandKeySchema, input.commandKey);
    return this.run(actor, "sync_reset", correlationId, "PERSISTENCE_FAILED", async () => {
      const snapshot = await this.preflight(sourceId, actor);
      if (snapshot.configuration.mapping.kind !== "CONNECTOR")
        throw new IngestionPersistenceError("INVALID_REQUEST");
      const projectIds = snapshot.configuration.projects.map((project) => project.projectId);
      const requestHash = sha256(boundedJson({
        sourceId,
        configRevision: input.configRevision,
        expectedCursorRevision: input.expectedCursorRevision,
        expectedGeneration: input.expectedGeneration,
      }));
      return this.db.$transaction(async (tx) => {
        const { source, config } = await this.lockAuthorizedSource(tx, actor, sourceId, projectIds, "write");
        if (source.currentConfigRevision !== input.configRevision || snapshot.configRevision !== input.configRevision)
          throw new IngestionPersistenceError("STALE_CONFIGURATION");
        const existing = await this.commandReceipt(tx, actor.customerId, sourceId, actor.subject, "SYNC_RESET", commandKey);
        if (existing) {
          await this.sourceReaders(tx, actor, source, config, projectIds);
          const replayed = await this.replay(existing, requestHash);
          return { receiptId: replayed.receiptId, generation: replayed.generation!, cursorRevision: replayed.cursorRevision! };
        }
        if (Number(source.cursorRevision) !== input.expectedCursorRevision || Number(source.syncGeneration) !== input.expectedGeneration)
          throw new IngestionPersistenceError("CURSOR_CONFLICT");
        const nextGeneration = source.syncGeneration + 1n;
        const nextCursorRevision = source.cursorRevision + 1n;
        const receiptId = await this.createReceipt(tx, actor, correlationId, {
          sourceId,
          kind: "SYNC_RESET",
          commandKey,
          requestHash,
          configRevision: input.configRevision,
          mappingRevision: source.mappingRevision,
          generationBefore: source.syncGeneration,
          generationAfter: nextGeneration,
          cursorRevisionBefore: source.cursorRevision,
          cursorRevisionAfter: nextCursorRevision,
          scopeProjectIds: projectIds,
          cursorTransition: {
            generationBefore: source.syncGeneration,
            generationAfter: nextGeneration,
            cursorRevisionBefore: source.cursorRevision,
            cursorRevisionAfter: nextCursorRevision,
            stateAfter: "READY",
            cursorEnvelopeHash: null,
          },
          outcomes: [],
        });
        await tx.$executeRaw`
          UPDATE public."IngestionSource"
          SET "syncGeneration"=${nextGeneration},"cursorRevision"=${nextCursorRevision},
              "cursorEnvelope"=NULL,"cursorState"='READY'
          WHERE "customerId"=${actor.customerId}::uuid AND id=${sourceId}::uuid`;
        return { receiptId, generation: Number(nextGeneration), cursorRevision: Number(nextCursorRevision) };
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 });
    });
  }

  async readReceipt(actorInputValue: Actor, input: { sourceId: string; receiptId: string }) {
    const actor = parseActor(actorInputValue);
    const request = parseIngestion(ingestionReceiptReadSchema, input);
    const sourceId = uuid(request.sourceId);
    const receiptId = uuid(request.receiptId);
    return this.run(actor, "receipt_read", "ingestion.receipt.read", "PERSISTENCE_FAILED", async () => {
      const header = await this.db.$queryRaw<{ configRevision: number }[]>`
        SELECT "configRevision" FROM public."IngestionOperationReceipt"
        WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND id=${receiptId}::uuid`;
      if (!header[0]) throw new IngestionPersistenceError("DENIED");
      const originalScope = await this.db.$queryRaw<{ projectId: string }[]>`
        SELECT "projectId" FROM public."IngestionConfigurationProject"
        WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND "configRevision"=${header[0].configRevision}
        ORDER BY "projectId"`;
      const originalProjectIds = originalScope.map((row) => row.projectId);
      return this.db.$transaction(async (tx) => {
        await this.authorizedProjects(tx, actor, originalProjectIds, "read");
        const source = await this.currentSource(tx, actor.customerId, sourceId, "SHARE");
        const config = await this.currentConfiguration(tx, source);
        await this.sourceReaders(tx, actor, source, config, originalProjectIds);
        const receipts = await tx.$queryRaw<ReceiptRow[]>`
          SELECT id,"customerId","sourceId",subject,kind,"commandKey","requestHash","eventId","configRevision","mappingRevision","generationBefore","generationAfter","cursorRevisionBefore","cursorRevisionAfter","outcomeCount","auditEventId","createdAt"
          FROM public."IngestionOperationReceipt"
          WHERE "customerId"=${actor.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND id=${receiptId}::uuid`;
        const receipt = receipts[0];
        if (!receipt || receipt.configRevision !== header[0]!.configRevision)
          throw new IngestionPersistenceError("NOT_FOUND");
        const rows = await tx.$queryRaw<{
          ordinal: number; state: string; operation: string; errorCodes: string[]; projectId: string | null; recordKey: string | null; recordType: string | null; proposals: unknown; contentAvailable: boolean; proposalHash: string | null; actualProposalHash: string | null;
        }[]>`
          SELECT o.ordinal,o.state,o.operation,o."errorCodes",o."projectId",o."recordKey",e."recordType",
            CASE WHEN c.proposals IS NOT NULL AND c."redactedAt" IS NULL AND v."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp() THEN c.proposals ELSE NULL END AS proposals,
            (c.proposals IS NOT NULL AND c."redactedAt" IS NULL AND v."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp()) AS "contentAvailable",
            p."proposalHash",CASE WHEN c.proposals IS NOT NULL THEN encode(sha256(convert_to(c.proposals::text,'UTF8')),'hex') ELSE NULL END AS "actualProposalHash"
          FROM public."IngestionRowOutcome" o
          LEFT JOIN public."IngestionExternalRecord" e ON e.id=o."recordId" AND e."customerId"=o."customerId" AND e."sourceId"=o."sourceId"
          LEFT JOIN public."IngestionSourceRevision" v ON v.id=o."sourceRevisionId" AND v."customerId"=o."customerId"
          LEFT JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId" AND p."customerId"=o."customerId"
          LEFT JOIN public."IngestionProposalContent" c ON c."projectionId"=o."projectionId" AND c."customerId"=o."customerId"
          LEFT JOIN public."IngestionRetentionPolicy" policy ON policy."customerId"=o."customerId"
          WHERE o."customerId"=${actor.customerId}::uuid AND o."sourceId"=${sourceId}::uuid AND o."receiptId"=${receiptId}::uuid
          ORDER BY o.ordinal`;
        return {
          receipt: {
            id: receipt.id,
            sourceId: receipt.sourceId,
            actor: receipt.subject,
            kind: receipt.kind,
            eventId: receipt.eventId,
            configRevision: receipt.configRevision,
            mappingRevision: receipt.mappingRevision,
            cursorRevisionBefore: receipt.cursorRevisionBefore === null ? null : Number(receipt.cursorRevisionBefore),
            cursorRevisionAfter: receipt.cursorRevisionAfter === null ? null : Number(receipt.cursorRevisionAfter),
            generationBefore: receipt.generationBefore === null ? null : Number(receipt.generationBefore),
            generationAfter: receipt.generationAfter === null ? null : Number(receipt.generationAfter),
            rowCount: receipt.outcomeCount,
            createdAt: receipt.createdAt.toISOString(),
          },
          outcomes: rows.map((row) => {
            const codes = row.errorCodes.map((code) => ingestionSafeErrorSchema.parse(code));
            if (row.contentAvailable && row.proposalHash !== row.actualProposalHash)
              throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
            const proposals = row.contentAvailable
              ? Array.isArray(row.proposals)
                ? row.proposals.map((proposal) => ingestionProposalSchema.parse(proposal))
                : (() => { throw new IngestionPersistenceError("INTEGRITY_CONFLICT"); })()
              : null;
            return {
              ordinal: row.ordinal,
              state: ingestionRowStateSchema.parse(row.state),
              operation: ingestionRowOperationSchema.parse(row.operation),
              errorCodes: codes,
              projectId: row.projectId,
              identity: row.recordKey === null ? null : [row.recordType, row.recordKey],
              contentAvailable: row.contentAvailable,
              proposals,
            };
          }),
        };
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
    });
  }

  private async authorizeSystemAdministrator(tx: Tx, actor: Actor) {
    if (!actor.roles.includes("system_admin"))
      throw new IngestionPersistenceError("DENIED");
    const projectRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."Project" WHERE "customerId"=${actor.customerId}::uuid ORDER BY id FOR SHARE`;
    const portfolioRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM public."Portfolio" WHERE "customerId"=${actor.customerId}::uuid ORDER BY id FOR SHARE`;
    const projectIds = projectRows.map((row) => row.id);
    const portfolioIds = portfolioRows.map((row) => row.id);
    const grants = await tx.$queryRaw<{ id: string; scopeType: string; scopeId: string; role: string }[]>`
      SELECT id,"scopeType","scopeId",role FROM public."AccessGrant"
      WHERE "customerId"=${actor.customerId}::uuid AND subject=${actor.subject} AND role='system_admin'
        AND (("scopeType"='project' AND "scopeId"=ANY(${projectIds}::uuid[])) OR ("scopeType"='portfolio' AND "scopeId"=ANY(${portfolioIds}::uuid[])))
      ORDER BY id FOR SHARE`;
    if (!grants.some((grant) => currentRoleMatches(actor, grant.role)))
      throw new IngestionPersistenceError("DENIED");
  }

  async recordHealth(
    actorInputValue: Actor,
    sourceIdInput: string,
    state: "HEALTHY" | "DEGRADED" | "FAILED",
    codeInput: string,
    correlationInput: string,
  ) {
    const actor = parseActor(actorInputValue);
    const sourceId = uuid(sourceIdInput);
    const correlationId = contextSchema(correlationInput);
    const code = parseIngestion(ingestionHealthCodeSchema, codeInput);
    if ((state === "HEALTHY") !== (code === "NONE"))
      throw new IngestionPersistenceError("INVALID_REQUEST");
    return this.run(actor, "health_update", correlationId, "PERSISTENCE_FAILED", async () => {
      const snapshot = await this.preflight(sourceId, actor);
      const projectIds = snapshot.configuration.projects.map((project) => project.projectId);
      return this.db.$transaction(async (tx) => {
        const { source, config } = await this.lockAuthorizedSource(tx, actor, sourceId, projectIds, "write");
        if (source.currentConfigRevision !== snapshot.configRevision)
          throw new IngestionPersistenceError("STALE_CONFIGURATION");
        await this.sourceReaders(tx, actor, source, config, projectIds);
        const checkedAt = new Date();
        await this.audit(
          tx,
          actor,
          correlationId,
          "ingestion.health.updated",
          { sourceId, state, code },
          checkedAt,
        );
        await tx.$executeRaw`
          UPDATE public."IngestionSource" SET "healthState"=${state},"healthCode"=${code},"healthCheckedAt"=${checkedAt}
          WHERE "customerId"=${actor.customerId}::uuid AND id=${sourceId}::uuid`;
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
    });
  }

  async setRetention(actorInputValue: Actor, input: { retentionHours: number }, correlationInput: string) {
    const actor = parseActor(actorInputValue);
    const correlationId = contextSchema(correlationInput);
    const policy = parseIngestion(ingestionRetentionSchema, input);
    return this.run(actor, "retention_update", correlationId, "PERSISTENCE_FAILED", async () =>
      this.db.$transaction(async (tx) => {
        await this.authorizeSystemAdministrator(tx, actor);
        const previous = await tx.$queryRaw<{ revision: number }[]>`
          SELECT revision FROM public."IngestionRetentionPolicy" WHERE "customerId"=${actor.customerId}::uuid FOR UPDATE`;
        const revision = (previous[0]?.revision ?? 0) + 1;
        const changedAt = new Date();
        const auditEventId = await this.audit(
          tx,
          actor,
          correlationId,
          "ingestion.retention.changed",
          { retentionHours: policy.retentionHours, revision },
          changedAt,
        );
        if (previous[0])
          await tx.$executeRaw`
            UPDATE public."IngestionRetentionPolicy" SET "retentionHours"=${policy.retentionHours},revision=${revision},"changedBy"=${actor.subject},"auditEventId"=${auditEventId}::uuid,"changedAt"=${changedAt}
            WHERE "customerId"=${actor.customerId}::uuid`;
        else
          await tx.$executeRaw`
            INSERT INTO public."IngestionRetentionPolicy" ("customerId","retentionHours",revision,"changedBy","auditEventId","changedAt")
            VALUES (${actor.customerId}::uuid,${policy.retentionHours},${revision},${actor.subject},${auditEventId}::uuid,${changedAt})`;
        return revision;
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 }),
    );
  }

  async purgeExpired(actorInputValue: Actor) {
    const actor = parseActor(actorInputValue);
    return this.run(actor, "content_purge", "ingestion.content.purge", "PERSISTENCE_FAILED", async () =>
      this.db.$transaction(async (tx) => {
        await this.authorizeSystemAdministrator(tx, actor);
        const policyRows = await tx.$queryRaw<{ retentionHours: number }[]>`
          SELECT "retentionHours" FROM public."IngestionRetentionPolicy" WHERE "customerId"=${actor.customerId}::uuid FOR SHARE`;
        if (!policyRows[0]) return 0;
        const sourceIds = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM public."IngestionSource" WHERE "customerId"=${actor.customerId}::uuid ORDER BY id FOR UPDATE`;
        if (!sourceIds.length) return 0;
        const candidates = await tx.$queryRaw<{
          sourceId: string; recordId: string; sourceRevisionId: string; projectionId: string;
        }[]>`
          SELECT p."sourceId",p."recordId",p."sourceRevisionId",c."projectionId"
          FROM public."IngestionProposalContent" c
          JOIN public."IngestionProposalProjection" p ON p.id=c."projectionId" AND p."customerId"=c."customerId"
          JOIN public."IngestionSourceRevision" r ON r.id=p."sourceRevisionId" AND r."customerId"=p."customerId"
          WHERE c."customerId"=${actor.customerId}::uuid AND c.proposals IS NOT NULL
            AND c."redactedAt" IS NULL AND r."receivedAt"+make_interval(hours=>${policyRows[0].retentionHours})<=clock_timestamp()
          ORDER BY p."sourceId",p."recordId",p."sourceRevisionId",p.id LIMIT 1000`;
        if (!candidates.length) return 0;
        const recordIds = [...new Set(candidates.map((row) => row.recordId))].sort(exactCompare);
        const revisionIds = [...new Set(candidates.map((row) => row.sourceRevisionId))].sort(exactCompare);
        const projectionIds = candidates.map((row) => row.projectionId).sort(exactCompare);
        await tx.$queryRaw`SELECT id FROM public."IngestionExternalRecord" WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${recordIds}::uuid[]) ORDER BY "sourceId",id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM public."IngestionSourceRevision" WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${revisionIds}::uuid[]) ORDER BY "recordId",id FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM public."IngestionProposalProjection" WHERE "customerId"=${actor.customerId}::uuid AND id=ANY(${projectionIds}::uuid[]) ORDER BY "recordId",id FOR UPDATE`;
        const locked = await tx.$queryRaw<{ projectionId: string }[]>`
          SELECT "projectionId" FROM public."IngestionProposalContent"
          WHERE "customerId"=${actor.customerId}::uuid AND "projectionId"=ANY(${projectionIds}::uuid[]) AND proposals IS NOT NULL
          ORDER BY "projectionId" FOR UPDATE`;
        if (!locked.length) return 0;
        const redactedAt = new Date();
        const auditEventId = await this.audit(
          tx,
          actor,
          "ingestion.content.purge",
          "ingestion.content.purged",
          { redactedCount: locked.length },
          redactedAt,
        );
        const rows = locked.map((row) => ({ projectionId: row.projectionId }));
        const changed = await tx.$executeRaw`
          UPDATE public."IngestionProposalContent" c
          SET proposals=NULL,"redactedAt"=${redactedAt},"redactionAuditEventId"=${auditEventId}::uuid
          FROM jsonb_to_recordset(${canonical(rows)}::jsonb) AS x("projectionId" uuid)
          WHERE c."customerId"=${actor.customerId}::uuid AND c."projectionId"=x."projectionId" AND c.proposals IS NOT NULL`;
        if (changed !== locked.length)
          throw new IngestionPersistenceError("INTEGRITY_CONFLICT");
        return changed;
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 60000 }),
    );
  }
}
