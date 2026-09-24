import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CredentialKeyRingVault } from "@pdaa/platform";
import type { Prisma, PrismaClient as Database } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;
const uuidSchema = z.uuid();
const subjectSchema = z.string().min(1).max(256).refine((value) => !/[\0\p{Surrogate}]/u.test(value));
const cloudIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const secretSchema = z.string().min(32).max(4096).refine((value) => !/[\0\p{Surrogate}]/u.test(value));
const tokenSchema = z.string().min(1).max(8192).refine((value) => !/[\0\p{Surrogate}]/u.test(value));
const scopesSchema = z.array(z.string().min(1).max(96)).max(32).refine((items) => new Set(items).size === items.length);
const oauthPayloadSchema = z.object({
  cloudId: cloudIdSchema,
  selectedUrl: z.url(),
  accessToken: tokenSchema,
  refreshToken: tokenSchema,
  expiresAt: z.iso.datetime(),
  scopes: scopesSchema,
}).strict()
  .refine((value) => value.scopes.includes("read:jira-work") && value.scopes.includes("offline_access"))
  .refine((value) => {
    try {
      const url = new URL(value.selectedUrl);
      return url.origin === value.selectedUrl && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  });
const webhookPayloadSchema = z.object({ secret: secretSchema }).strict();
const webhookEventTypeSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/);
export type JiraOAuthCredential = z.infer<typeof oauthPayloadSchema>;
export type JiraCredentialRotation = {
  customerId: string;
  sourceId: string;
  operationId: string;
  revision: number;
  configRevision: number;
  mappingRevision: number;
  credentials: JiraOAuthCredential;
};
export type JiraOAuthAccess =
  | { kind: "access"; credentials: JiraOAuthCredential; configRevision: number; mappingRevision: number }
  | { kind: "rotate"; rotation: JiraCredentialRotation }
  | { kind: "unavailable"; reason: "ROTATION_IN_PROGRESS" | "REAUTH_REQUIRED" | "NOT_CONFIGURED" | "STALE_CONFIGURATION" };
export type ConnectorRuntimeErrorCode =
  | "INVALID_REQUEST"
  | "DENIED"
  | "CONFLICT"
  | "NOT_FOUND"
  | "STALE_CONFIGURATION"
  | "REAUTH_REQUIRED"
  | "ROTATION_IN_PROGRESS"
  | "INVALID_WEBHOOK";
export class ConnectorRuntimeError extends Error {
  constructor(readonly code: ConnectorRuntimeErrorCode) {
    super(code);
    this.name = "ConnectorRuntimeError";
  }
}

const runtimeActor = "connector:jira-runtime";
const context = (customerId: string, sourceId: string, purpose: string) =>
  `connector-credential:${customerId}:${sourceId}:${purpose}`;
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const safeUuid = (value: unknown) => {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ConnectorRuntimeError("INVALID_REQUEST");
  return parsed.data;
};
const safeSubject = (value: unknown) => {
  const parsed = subjectSchema.safeParse(value);
  if (!parsed.success) throw new ConnectorRuntimeError("INVALID_REQUEST");
  return parsed.data;
};
const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

type SourceRow = {
  id: string;
  customerId: string;
  sourceType: string;
  origin: string;
  currentConfigRevision: number | null;
  mappingRevision: number;
  cursorRevision: bigint;
  syncGeneration: bigint;
  cursorEnvelope: string | null;
  cursorState: string;
  healthCheckedAt: Date | null;
};
type CredentialRow = {
  id: string;
  customerId: string;
  sourceId: string;
  purpose: string;
  envelope: string;
  keyId: string;
  revision: number;
  state: string;
  rotationOperationId: string | null;
  rotationDeadline: Date | null;
};

export class DatabaseConnectorRuntimeRepository {
  constructor(
    private readonly db: Database,
    private readonly vault: CredentialKeyRingVault,
  ) {}

  private async audit(
    tx: Tx,
    customerId: string,
    actor: string,
    event: string,
    detail: Record<string, unknown>,
    occurredAt = new Date(),
  ) {
    const id = randomUUID();
    const correlationId = `connector-${randomUUID()}`;
    await tx.$executeRaw`
      INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
      VALUES (${id}::uuid,${customerId}::uuid,${actor},${event},${correlationId},${JSON.stringify(detail)}::jsonb,${occurredAt})`;
    return id;
  }

  async acceptTaskNonce(input: { nonce: string; keyId: string; timestampSeconds: string; body: Uint8Array }, now = new Date()) {
    const nonce = safeUuid(input.nonce);
    const keyId = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/).parse(input.keyId);
    if (!/^\d{10}$/.test(input.timestampSeconds)) return false;
    const timestamp = Number(input.timestampSeconds);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > 60 || input.body.byteLength > 64)
      return false;
    const bodyHash = digest(input.body);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM public."ConnectorTaskReceipt" WHERE "createdAt"<${addSeconds(now, -600)}::timestamptz`;
      const rows = await tx.$queryRaw<{ nonce: string }[]>`
        INSERT INTO public."ConnectorTaskReceipt" (nonce,"keyId","requestTime","bodyHash","createdAt")
        VALUES (${nonce}::uuid,${keyId},${new Date(timestamp * 1000)},${bodyHash},${now})
        ON CONFLICT (nonce) DO NOTHING RETURNING nonce`;
      return rows.length === 1;
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  private async lockSource(tx: Tx, customerId: string, sourceId: string): Promise<SourceRow> {
    const rows = await tx.$queryRaw<SourceRow[]>`
      SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthCheckedAt"
      FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${sourceId}::uuid FOR UPDATE`;
    const source = rows[0];
    if (!source || source.currentConfigRevision === null || source.sourceType !== "jira")
      throw new ConnectorRuntimeError("NOT_FOUND");
    return source;
  }

  private async assertConnectorMapping(tx: Tx, source: SourceRow) {
    const rows = await tx.$queryRaw<{ mapping: unknown }[]>`
      SELECT mapping FROM public."IngestionConfigurationRevision"
      WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${source.id}::uuid
        AND revision=${source.currentConfigRevision} AND "mappingRevision"=${source.mappingRevision} AND sealed`;
    const mapping = rows[0]?.mapping;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || (mapping as Record<string, unknown>).kind !== "CONNECTOR")
      throw new ConnectorRuntimeError("STALE_CONFIGURATION");
  }

  private async lockCurrentServiceGrants(tx: Tx, source: SourceRow) {
    const rows = await tx.$queryRaw<{ projectId: string; grantId: string }[]>`
      SELECT cp."projectId",g.id AS "grantId"
      FROM public."IngestionConfigurationProject" cp
      JOIN public."IngestionConfigurationRevision" c ON c."customerId"=cp."customerId" AND c."sourceId"=cp."sourceId" AND c.revision=cp."configRevision" AND c.sealed AND c.mapping->>'kind'='CONNECTOR'
      JOIN public."ConnectorSyncGrant" g ON g."customerId"=cp."customerId" AND g."sourceId"=cp."sourceId" AND g."projectId"=cp."projectId" AND g."configRevision"=cp."configRevision" AND g.active
      WHERE cp."customerId"=${source.customerId}::uuid AND cp."sourceId"=${source.id}::uuid AND cp."configRevision"=${source.currentConfigRevision}
      ORDER BY cp."projectId" FOR SHARE OF g`;
    const configured = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM public."IngestionConfigurationProject"
      WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${source.id}::uuid AND "configRevision"=${source.currentConfigRevision}`;
    if (!Number.isSafeInteger(Number(configured[0]?.count)) || rows.length !== Number(configured[0]?.count) || rows.length === 0)
      throw new ConnectorRuntimeError("STALE_CONFIGURATION");
    return rows;
  }

  private async credential(tx: Tx, customerId: string, sourceId: string, purpose: "jira_oauth" | "jira_webhook_hmac", lock = true) {
    const rows = lock
      ? await tx.$queryRaw<CredentialRow[]>`
          SELECT id,"customerId","sourceId",purpose,envelope,"keyId",revision,state,"rotationOperationId","rotationDeadline"
          FROM public."ConnectorCredential" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid AND purpose=${purpose} FOR UPDATE`
      : await tx.$queryRaw<CredentialRow[]>`
          SELECT id,"customerId","sourceId",purpose,envelope,"keyId",revision,state,"rotationOperationId","rotationDeadline"
          FROM public."ConnectorCredential" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${sourceId}::uuid AND purpose=${purpose}`;
    return rows[0] ?? null;
  }

  private decryptOAuth(row: CredentialRow): JiraOAuthCredential {
    try {
      const value = JSON.parse(this.vault.decrypt(row.envelope, context(row.customerId, row.sourceId, row.purpose), row.keyId)) as unknown;
      return oauthPayloadSchema.parse(value);
    } catch {
      throw new ConnectorRuntimeError("REAUTH_REQUIRED");
    }
  }

  async setOAuthCredential(input: {
    customerId: string;
    sourceId: string;
    actorSubject: string;
    credential: JiraOAuthCredential;
  }) {
    const customerId = safeUuid(input.customerId);
    const sourceId = safeUuid(input.sourceId);
    const actor = safeSubject(input.actorSubject);
    const payload = oauthPayloadSchema.parse(input.credential);
    const encoded = this.vault.encrypt(JSON.stringify(payload), context(customerId, sourceId, "jira_oauth"));
    return this.db.$transaction(async (tx) => {
      const source = await this.lockSource(tx, customerId, sourceId);
      await this.assertConnectorMapping(tx, source);
      if (new URL(payload.selectedUrl).origin !== source.origin)
        throw new ConnectorRuntimeError("DENIED");
      const scopeRows = await tx.$queryRaw<{ projectId: string; portfolioId: string }[]>`
        SELECT p.id AS "projectId",p."portfolioId" FROM public."IngestionConfigurationProject" cp
        JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
        WHERE cp."customerId"=${customerId}::uuid AND cp."sourceId"=${sourceId}::uuid AND cp."configRevision"=${source.currentConfigRevision}
        ORDER BY p.id FOR SHARE OF p`;
      if (!scopeRows.length) throw new ConnectorRuntimeError("DENIED");
      const projectIds = scopeRows.map((row) => row.projectId);
      const admins = await tx.$queryRaw<{ projectId: string }[]>`
        SELECT p.id AS "projectId" FROM public."Project" p JOIN public."AccessGrant" g
          ON g."customerId"=p."customerId" AND g.subject=${actor} AND g.role='pmo_admin'
          AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
        WHERE p."customerId"=${customerId}::uuid AND p.id=ANY(${projectIds}::uuid[]) ORDER BY p.id,g.id FOR SHARE OF g`;
      if (new Set(admins.map((grant) => grant.projectId)).size !== projectIds.length) throw new ConnectorRuntimeError("DENIED");
      const existing = await this.credential(tx, customerId, sourceId, "jira_oauth");
      const revision = (existing?.revision ?? 0) + 1;
      const id = existing?.id ?? randomUUID();
      const changedAt = new Date();
      const event = "ingestion.connector_credential.configured";
      const auditEventId = await this.audit(tx, customerId, actor, event, {
        sourceId, purpose: "jira_oauth", state: "ACTIVE", revision, rotationOperationId: null,
      }, changedAt);
      if (!existing) {
        await tx.$executeRaw`
          INSERT INTO public."ConnectorCredential" (id,"customerId","sourceId",purpose,name,envelope,"keyId",revision,state,"rotationOperationId","rotationDeadline","auditEventId","changedBy")
          VALUES (${id}::uuid,${customerId}::uuid,${sourceId}::uuid,'jira_oauth',${`jira_oauth:${sourceId}`},${encoded.envelope},${encoded.keyId},${revision},'ACTIVE',NULL,NULL,${auditEventId}::uuid,${actor})`;
      } else {
        if (existing.state === "ROTATING") throw new ConnectorRuntimeError("ROTATION_IN_PROGRESS");
        await tx.$executeRaw`
          UPDATE public."ConnectorCredential" SET envelope=${encoded.envelope},"keyId"=${encoded.keyId},revision=${revision},state='ACTIVE',
            "rotationOperationId"=NULL,"rotationDeadline"=NULL,"auditEventId"=${auditEventId}::uuid,"changedBy"=${actor}
          WHERE id=${id}::uuid AND "customerId"=${customerId}::uuid`;
      }
      return { sourceId, revision };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  async setWebhookSecret(input: {
    customerId: string;
    sourceId: string;
    actorSubject: string;
    secret: string;
  }) {
    const customerId = safeUuid(input.customerId);
    const sourceId = safeUuid(input.sourceId);
    const actor = safeSubject(input.actorSubject);
    const secret = secretSchema.parse(input.secret);
    const payload = webhookPayloadSchema.parse({ secret });
    const encoded = this.vault.encrypt(JSON.stringify(payload), context(customerId, sourceId, "jira_webhook_hmac"));
    return this.db.$transaction(async (tx) => {
      const source = await this.lockSource(tx, customerId, sourceId);
      await this.assertConnectorMapping(tx, source);
      const scopeRows = await tx.$queryRaw<{ projectId: string; portfolioId: string }[]>`
        SELECT p.id AS "projectId",p."portfolioId" FROM public."IngestionConfigurationProject" cp
        JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
        WHERE cp."customerId"=${customerId}::uuid AND cp."sourceId"=${sourceId}::uuid AND cp."configRevision"=${source.currentConfigRevision}
        ORDER BY p.id FOR SHARE OF p`;
      const projectIds = scopeRows.map((row) => row.projectId);
      if (!projectIds.length) throw new ConnectorRuntimeError("DENIED");
      const admins = await tx.$queryRaw<{ projectId: string }[]>`
        SELECT p.id AS "projectId" FROM public."Project" p JOIN public."AccessGrant" g
          ON g."customerId"=p."customerId" AND g.subject=${actor} AND g.role='pmo_admin'
          AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
        WHERE p."customerId"=${customerId}::uuid AND p.id=ANY(${projectIds}::uuid[]) ORDER BY p.id,g.id FOR SHARE OF g`;
      if (new Set(admins.map((grant) => grant.projectId)).size !== projectIds.length) throw new ConnectorRuntimeError("DENIED");
      const existing = await this.credential(tx, customerId, sourceId, "jira_webhook_hmac");
      const revision = (existing?.revision ?? 0) + 1;
      const id = existing?.id ?? randomUUID();
      const changedAt = new Date();
      const event = existing ? "ingestion.connector_webhook_secret.rotated" : "ingestion.connector_credential.configured";
      const auditEventId = await this.audit(tx, customerId, actor, event, {
        sourceId, purpose: "jira_webhook_hmac", state: "ACTIVE", revision, rotationOperationId: null,
      }, changedAt);
      if (!existing) {
        await tx.$executeRaw`
          INSERT INTO public."ConnectorCredential" (id,"customerId","sourceId",purpose,name,envelope,"keyId",revision,state,"rotationOperationId","rotationDeadline","auditEventId","changedBy")
          VALUES (${id}::uuid,${customerId}::uuid,${sourceId}::uuid,'jira_webhook_hmac',${`jira_webhook_hmac:${sourceId}`},${encoded.envelope},${encoded.keyId},${revision},'ACTIVE',NULL,NULL,${auditEventId}::uuid,${actor})`;
      } else {
        await tx.$executeRaw`
          UPDATE public."ConnectorCredential" SET envelope=${encoded.envelope},"keyId"=${encoded.keyId},revision=${revision},
            "auditEventId"=${auditEventId}::uuid,"changedBy"=${actor}
          WHERE id=${id}::uuid AND "customerId"=${customerId}::uuid AND state='ACTIVE'`;
      }
      return { sourceId, revision };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  async accessOrBeginRotation(customerIdInput: string, sourceIdInput: string, now = new Date()): Promise<JiraOAuthAccess> {
    const customerId = safeUuid(customerIdInput);
    const sourceId = safeUuid(sourceIdInput);
    return this.db.$transaction(async (tx) => {
      const source = await this.lockSource(tx, customerId, sourceId);
      await this.lockCurrentServiceGrants(tx, source);
      const row = await this.credential(tx, customerId, sourceId, "jira_oauth");
      if (!row) return { kind: "unavailable", reason: "NOT_CONFIGURED" } as const;
      if (row.state === "REAUTH_REQUIRED") return { kind: "unavailable", reason: "REAUTH_REQUIRED" } as const;
      const credentials = this.decryptOAuth(row);
      if (row.state === "ROTATING") {
        if (row.rotationDeadline && row.rotationDeadline.getTime() > now.getTime())
          return { kind: "unavailable", reason: "ROTATION_IN_PROGRESS" } as const;
        const revision = row.revision + 1;
        const changedAt = new Date(now);
        const auditEventId = await this.audit(tx, customerId, runtimeActor, "ingestion.connector_credential.reauth_required", {
          sourceId, purpose: "jira_oauth", state: "REAUTH_REQUIRED", revision, rotationOperationId: null,
        }, changedAt);
        await tx.$executeRaw`
          UPDATE public."ConnectorCredential" SET state='REAUTH_REQUIRED',revision=${revision},"rotationOperationId"=NULL,"rotationDeadline"=NULL,
            "auditEventId"=${auditEventId}::uuid,"changedBy"=${runtimeActor}
          WHERE id=${row.id}::uuid AND revision=${row.revision} AND state='ROTATING'`;
        return { kind: "unavailable", reason: "REAUTH_REQUIRED" } as const;
      }
      if (Date.parse(credentials.expiresAt) > now.getTime() + 120_000)
        return { kind: "access", credentials, configRevision: source.currentConfigRevision!, mappingRevision: source.mappingRevision } as const;
      const operationId = randomUUID();
      const revision = row.revision + 1;
      const deadline = addSeconds(now, 60);
      const changedAt = new Date(now);
      const auditEventId = await this.audit(tx, customerId, runtimeActor, "ingestion.connector_credential.rotation_started", {
        sourceId, purpose: "jira_oauth", state: "ROTATING", revision, rotationOperationId: operationId,
      }, changedAt);
      await tx.$executeRaw`
        UPDATE public."ConnectorCredential" SET state='ROTATING',revision=${revision},"rotationOperationId"=${operationId}::uuid,
          "rotationDeadline"=${deadline},"auditEventId"=${auditEventId}::uuid,"changedBy"=${runtimeActor}
        WHERE id=${row.id}::uuid AND revision=${row.revision} AND state='ACTIVE'`;
      return {
        kind: "rotate",
        rotation: { customerId, sourceId, operationId, revision, configRevision: source.currentConfigRevision!, mappingRevision: source.mappingRevision, credentials },
      } as const;
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  async completeOAuthRotation(rotation: JiraCredentialRotation, updatedInput: JiraOAuthCredential, now = new Date()) {
    const updated = oauthPayloadSchema.parse(updatedInput);
    const encoded = this.vault.encrypt(JSON.stringify(updated), context(rotation.customerId, rotation.sourceId, "jira_oauth"));
    return this.db.$transaction(async (tx) => {
      const source = await this.lockSource(tx, rotation.customerId, rotation.sourceId);
      await this.lockCurrentServiceGrants(tx, source);
      const row = await this.credential(tx, rotation.customerId, rotation.sourceId, "jira_oauth");
      if (!row || row.state !== "ROTATING" || row.rotationOperationId !== rotation.operationId || row.revision !== rotation.revision)
        return { committed: false as const, reason: "FENCED" as const };
      if (row.rotationDeadline === null || row.rotationDeadline.getTime() <= now.getTime() || source.currentConfigRevision !== rotation.configRevision || source.mappingRevision !== rotation.mappingRevision || updated.cloudId !== rotation.credentials.cloudId || updated.selectedUrl !== rotation.credentials.selectedUrl || updated.scopes.some((scope) => !rotation.credentials.scopes.includes(scope))) {
        const revision = row.revision + 1;
        const changedAt = new Date(now);
        const auditEventId = await this.audit(tx, rotation.customerId, runtimeActor, "ingestion.connector_credential.reauth_required", {
          sourceId: rotation.sourceId, purpose: "jira_oauth", state: "REAUTH_REQUIRED", revision, rotationOperationId: null,
        }, changedAt);
        await tx.$executeRaw`
          UPDATE public."ConnectorCredential" SET state='REAUTH_REQUIRED',revision=${revision},"rotationOperationId"=NULL,"rotationDeadline"=NULL,
            "auditEventId"=${auditEventId}::uuid,"changedBy"=${runtimeActor}
          WHERE id=${row.id}::uuid AND revision=${row.revision} AND state='ROTATING' AND "rotationOperationId"=${rotation.operationId}::uuid`;
        return { committed: false as const, reason: "EXPIRED_OR_STALE" as const };
      }
      const revision = row.revision + 1;
      const changedAt = new Date(now);
      const auditEventId = await this.audit(tx, rotation.customerId, runtimeActor, "ingestion.connector_credential.rotation_completed", {
        sourceId: rotation.sourceId, purpose: "jira_oauth", state: "ACTIVE", revision, rotationOperationId: null,
      }, changedAt);
      const changed = await tx.$executeRaw`
        UPDATE public."ConnectorCredential" SET envelope=${encoded.envelope},"keyId"=${encoded.keyId},state='ACTIVE',revision=${revision},
          "rotationOperationId"=NULL,"rotationDeadline"=NULL,"auditEventId"=${auditEventId}::uuid,"changedBy"=${runtimeActor}
        WHERE id=${row.id}::uuid AND revision=${rotation.revision} AND state='ROTATING' AND "rotationOperationId"=${rotation.operationId}::uuid AND "rotationDeadline">${now}`;
      return { committed: Number(changed) === 1, reason: Number(changed) === 1 ? "COMMITTED" as const : "FENCED" as const };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  async failOAuthRotation(rotation: JiraCredentialRotation, now = new Date()) {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CredentialRow[]>`
        SELECT id,"customerId","sourceId",purpose,envelope,"keyId",revision,state,"rotationOperationId","rotationDeadline"
        FROM public."ConnectorCredential" WHERE "customerId"=${rotation.customerId}::uuid AND "sourceId"=${rotation.sourceId}::uuid AND purpose='jira_oauth' FOR UPDATE`;
      const row = rows[0];
      if (!row || row.state !== "ROTATING" || row.rotationOperationId !== rotation.operationId || row.revision !== rotation.revision) return false;
      const revision = row.revision + 1;
      const auditEventId = await this.audit(tx, rotation.customerId, runtimeActor, "ingestion.connector_credential.reauth_required", {
        sourceId: rotation.sourceId, purpose: "jira_oauth", state: "REAUTH_REQUIRED", revision, rotationOperationId: null,
      }, now);
      await tx.$executeRaw`
        UPDATE public."ConnectorCredential" SET state='REAUTH_REQUIRED',revision=${revision},"rotationOperationId"=NULL,"rotationDeadline"=NULL,
          "auditEventId"=${auditEventId}::uuid,"changedBy"=${runtimeActor}
        WHERE id=${row.id}::uuid AND revision=${rotation.revision} AND state='ROTATING' AND "rotationOperationId"=${rotation.operationId}::uuid`;
      return true;
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  async acceptWebhook(input: {
    sourceId: string;
    eventId: string;
    signature: string;
    rawBody: Uint8Array;
    now?: Date;
  }) {
    const sourceId = safeUuid(input.sourceId);
    const eventId = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/).parse(input.eventId);
    if (input.rawBody.byteLength < 1 || input.rawBody.byteLength > 1_048_576 || !/^sha256=[a-f0-9]{64}$/.test(input.signature))
      throw new ConnectorRuntimeError("INVALID_WEBHOOK");
    const now = input.now ?? new Date();
    const payloadHash = digest(input.rawBody);
    const authenticationRows = await this.db.$queryRaw<{
      id: string;
      customerId: string;
      sourceType: string;
      currentConfigRevision: number | null;
      credentialId: string;
      envelope: string;
      keyId: string;
      revision: number;
      state: string;
    }[]>`
      SELECT s.id,s."customerId",s."sourceType",s."currentConfigRevision",
        c.id AS "credentialId",c.envelope,c."keyId",c.revision,c.state
      FROM public."IngestionSource" s
      JOIN public."ConnectorCredential" c ON c."customerId"=s."customerId" AND c."sourceId"=s.id
        AND c.purpose='jira_webhook_hmac'
      WHERE s.id=${sourceId}::uuid`;
    const authentication = authenticationRows[0];
    if (!authentication || authentication.sourceType !== "jira" || authentication.currentConfigRevision === null)
      throw new ConnectorRuntimeError("NOT_FOUND");
    if (authentication.state !== "ACTIVE") throw new ConnectorRuntimeError("INVALID_WEBHOOK");
    let secret: string;
    try {
      const parsed = webhookPayloadSchema.parse(JSON.parse(this.vault.decrypt(
        authentication.envelope,
        context(authentication.customerId, sourceId, "jira_webhook_hmac"),
        authentication.keyId,
      )) as unknown);
      secret = parsed.secret;
    } catch {
      throw new ConnectorRuntimeError("INVALID_WEBHOOK");
    }
    const expected = createHmac("sha256", secret).update(input.rawBody).digest();
    const supplied = Buffer.from(input.signature.slice("sha256=".length), "hex");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
      throw new ConnectorRuntimeError("INVALID_WEBHOOK");
    let eventType: string;
    try {
      const body: unknown = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid webhook body");
      eventType = webhookEventTypeSchema.parse((body as Record<string, unknown>).webhookEvent);
    } catch {
      throw new ConnectorRuntimeError("INVALID_WEBHOOK");
    }
    return this.db.$transaction(async (tx) => {
      const sourceRows = await tx.$queryRaw<SourceRow[]>`
        SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthCheckedAt"
        FROM public."IngestionSource" WHERE id=${sourceId}::uuid AND "sourceType"='jira' FOR UPDATE`;
      const source = sourceRows[0];
      if (!source || source.currentConfigRevision === null) throw new ConnectorRuntimeError("NOT_FOUND");
      const credential = await this.credential(tx, source.customerId, sourceId, "jira_webhook_hmac");
      if (!credential || credential.state !== "ACTIVE" || credential.id !== authentication.credentialId || credential.revision !== authentication.revision)
        throw new ConnectorRuntimeError("INVALID_WEBHOOK");
      await this.lockCurrentServiceGrants(tx, source);
      const previous = await tx.$queryRaw<{ id: string; payloadHash: string; jobId: string }[]>`
        SELECT id,"payloadHash","jobId" FROM public."ConnectorWebhookReceipt"
        WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND "eventId"=${eventId}`;
      if (previous[0]) {
        if (previous[0].payloadHash !== payloadHash) throw new ConnectorRuntimeError("CONFLICT");
        return { receiptId: previous[0].id, jobId: previous[0].jobId, replayed: true };
      }
      const receiptId = randomUUID();
      const expiresAt = addSeconds(now, 24 * 60 * 60);
      const queued = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM public."ConnectorSyncJob" WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND kind='WEBHOOK' AND state='READY' ORDER BY "createdAt",id LIMIT 1 FOR UPDATE`;
      let jobId = queued[0]?.id;
      if (!jobId) {
        await tx.$executeRaw`
          UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
          WHERE "customerId"=${source.customerId}::uuid AND "sourceId"=${sourceId}::uuid AND kind='SCHEDULED' AND state='READY'`;
        jobId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO public."ConnectorSyncJob" (id,"customerId","sourceId","configRevision","mappingRevision",kind,state,"eventId","idempotencyKey","resetRequested","resetCompleted",attempts,"createdAt","availableAt","expiresAt")
          VALUES (${jobId}::uuid,${source.customerId}::uuid,${sourceId}::uuid,${source.currentConfigRevision},${source.mappingRevision},'WEBHOOK','READY',${eventId},${`webhook:${eventId}`},true,false,0,${now},${now},${expiresAt})`;
      }
      await tx.$executeRaw`
        INSERT INTO public."ConnectorWebhookReceipt" (id,"customerId","sourceId","eventId","payloadHash","eventType","jobId","createdAt")
        VALUES (${receiptId}::uuid,${source.customerId}::uuid,${sourceId}::uuid,${eventId},${payloadHash},${eventType},${jobId}::uuid,${now})`;
      return { receiptId, jobId, replayed: false };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
  }

  async enqueueDueJobs(customerIdInput: string, intervalMinutes = 15, limit = 20, now = new Date()) {
    const customerId = safeUuid(customerIdInput);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440 || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ConnectorRuntimeError("INVALID_REQUEST");
    return this.db.$transaction(async (tx) => {
      const due = await tx.$queryRaw<SourceRow[]>`
        SELECT s.id,s."customerId",s."sourceType",s.origin,s."currentConfigRevision",s."mappingRevision",s."cursorRevision",s."syncGeneration",s."cursorEnvelope",s."cursorState",s."healthCheckedAt"
        FROM public."IngestionSource" s
        WHERE s."customerId"=${customerId}::uuid AND s."sourceType"='jira' AND s."currentConfigRevision" IS NOT NULL
          AND EXISTS (SELECT 1 FROM public."IngestionConfigurationRevision" c WHERE c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision" AND c."mappingRevision"=s."mappingRevision" AND c.sealed AND c.mapping->>'kind'='CONNECTOR')
          AND (s."healthCheckedAt" IS NULL OR s."healthCheckedAt"<=${now}::timestamptz - make_interval(mins => ${intervalMinutes}))
          AND NOT EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j."customerId"=s."customerId" AND j."sourceId"=s.id AND j.state IN ('READY','RUNNING'))
        ORDER BY s."healthCheckedAt" ASC NULLS FIRST,s.id LIMIT ${limit} FOR UPDATE OF s SKIP LOCKED`;
      const ids: string[] = [];
      const slot = Math.floor(now.getTime() / (intervalMinutes * 60_000));
      for (const source of due) {
        if (source.currentConfigRevision === null) continue;
        const grantRows = await this.lockCurrentServiceGrants(tx, source);
        const id = randomUUID();
        const result = await tx.$executeRaw`
          INSERT INTO public."ConnectorSyncJob" (id,"customerId","sourceId","configRevision","mappingRevision",kind,state,"eventId","idempotencyKey","resetRequested","resetCompleted",attempts,"createdAt","availableAt","expiresAt")
          VALUES (${id}::uuid,${customerId}::uuid,${source.id}::uuid,${source.currentConfigRevision},${source.mappingRevision},'SCHEDULED','READY',NULL,${`schedule:${source.currentConfigRevision}:${source.mappingRevision}:${slot}`},${source.cursorState !== "READY"},false,0,${now},${now},${addSeconds(now, 24 * 60 * 60)})
          ON CONFLICT DO NOTHING`;
        if (Number(result) === 1) ids.push(id);
        void grantRows;
      }
      return ids;
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
  }

  async claimNextJob(customerIdInput: string, now = new Date()) {
    const customerId = safeUuid(customerIdInput);
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
        WHERE "customerId"=${customerId}::uuid AND state IN ('READY','RUNNING') AND "expiresAt"<=${now}::timestamptz`;
      const candidates = await tx.$queryRaw<{ id: string; sourceId: string }[]>`
        SELECT id,"sourceId" FROM public."ConnectorSyncJob"
        WHERE "customerId"=${customerId}::uuid AND "expiresAt">${now}::timestamptz AND "availableAt"<=${now}::timestamptz
          AND (state='READY' OR (state='RUNNING' AND "leaseUntil"<=${now}::timestamptz))
        ORDER BY "availableAt","createdAt",id LIMIT 100`;
      for (const candidate of candidates) {
        const sources = await tx.$queryRaw<SourceRow[]>`
          SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthCheckedAt"
          FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${candidate.sourceId}::uuid FOR UPDATE SKIP LOCKED`;
        const source = sources[0];
        if (!source) continue;
        const jobs = await tx.$queryRaw<{
          id: string; sourceId: string; state: string; configRevision: number; mappingRevision: number; attempts: number;
          leaseUntil: Date | null; expiresAt: Date;
        }[]>`
          SELECT id,"sourceId",state,"configRevision","mappingRevision",attempts,"leaseUntil","expiresAt"
          FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${candidate.id}::uuid FOR UPDATE`;
        const job = jobs[0];
        if (!job || job.expiresAt.getTime() <= now.getTime() || (job.state === "RUNNING" && job.leaseUntil && job.leaseUntil.getTime() > now.getTime())) continue;
        if (job.state !== "READY" && job.state !== "RUNNING") continue;
        if (job.attempts >= 100 || source.sourceType !== "jira" || source.currentConfigRevision !== job.configRevision || source.mappingRevision !== job.mappingRevision) {
          await tx.$executeRaw`
            UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
            WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${job.id}::uuid AND state IN ('READY','RUNNING')`;
          continue;
        }
        const running = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND state='RUNNING' AND id<>${job.id}::uuid LIMIT 1`;
        if (running.length) continue;
        try {
          await this.lockCurrentServiceGrants(tx, source);
        } catch {
          await tx.$executeRaw`
            UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
            WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${job.id}::uuid AND state IN ('READY','RUNNING')`;
          continue;
        }
        const claimed = await tx.$queryRaw<{ id: string; attempts: number }[]>`
          UPDATE public."ConnectorSyncJob" SET state='RUNNING',attempts=attempts+1,"leaseUntil"=CURRENT_TIMESTAMP+interval '60 seconds'
          WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${job.id}::uuid
            AND (state='READY' OR (state='RUNNING' AND "leaseUntil"<=${now}::timestamptz))
          RETURNING id,attempts`;
        if (!claimed[0]) continue;
        return { jobId: job.id, customerId, sourceId: source.id, claimGeneration: claimed[0].attempts };
      }
      return null;
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
  }

  async failRunningJob(input: {
    customerId: string;
    jobId: string;
    claimGeneration: number;
    code: "INVALID_CREDENTIALS" | "EXPIRED_CREDENTIALS" | "PERMISSION_DENIED" | "RATE_LIMITED" | "TEMPORARILY_UNAVAILABLE" | "INVALID_RESPONSE" | "NOT_FOUND" | "UNKNOWN_OUTCOME" | "INTEGRITY_CONFLICT" | "CURSOR_CONFLICT";
    retryAfterMs?: number | null;
  }, now = new Date()) {
    const customerId = safeUuid(input.customerId);
    const jobId = safeUuid(input.jobId);
    const retryAfterMs = input.retryAfterMs ?? 0;
    if (!Number.isInteger(input.claimGeneration) || input.claimGeneration < 1 || input.claimGeneration > 100 || !Number.isInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 86_400_000)
      throw new ConnectorRuntimeError("INVALID_REQUEST");
    return this.db.$transaction(async (tx) => {
      const locator = await tx.$queryRaw<{ sourceId: string }[]>`
        SELECT "sourceId" FROM public."ConnectorSyncJob" WHERE "customerId"=${customerId}::uuid AND id=${jobId}::uuid`;
      if (!locator[0]) throw new ConnectorRuntimeError("NOT_FOUND");
      const sources = await tx.$queryRaw<SourceRow[]>`
        SELECT id,"customerId","sourceType",origin,"currentConfigRevision","mappingRevision","cursorRevision","syncGeneration","cursorEnvelope","cursorState","healthCheckedAt"
        FROM public."IngestionSource" WHERE "customerId"=${customerId}::uuid AND id=${locator[0].sourceId}::uuid FOR UPDATE`;
      const source = sources[0];
      if (!source) throw new ConnectorRuntimeError("NOT_FOUND");
      const jobs = await tx.$queryRaw<{ state: string; configRevision: number; mappingRevision: number; attempts: number; leaseUntil: Date | null }[]>`
        SELECT state,"configRevision","mappingRevision",attempts,"leaseUntil" FROM public."ConnectorSyncJob"
        WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid FOR UPDATE`;
      const job = jobs[0];
      if (!job || job.state !== "RUNNING") return { state: job?.state ?? "MISSING" };
      if (job.attempts !== input.claimGeneration || !job.leaseUntil || job.leaseUntil.getTime() <= now.getTime())
        return { state: "STALE_CLAIM" };
      if (source.currentConfigRevision !== job.configRevision || source.mappingRevision !== job.mappingRevision) {
        await tx.$executeRaw`
          UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
          WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid AND state='RUNNING'`;
        return { state: "EXPIRED" };
      }
      try {
        await this.lockCurrentServiceGrants(tx, source);
      } catch {
        await tx.$executeRaw`
          UPDATE public."ConnectorSyncJob" SET state='EXPIRED',"leaseUntil"=NULL
          WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid AND state='RUNNING'`;
        return { state: "EXPIRED" };
      }
      const retryable = ["RATE_LIMITED", "TEMPORARILY_UNAVAILABLE", "UNKNOWN_OUTCOME"].includes(input.code) && job.attempts < 5;
      const backoffMs = Math.max(retryAfterMs, Math.min(15 * 60_000, 1000 * 2 ** Math.max(0, job.attempts - 1)));
      const availableAt = retryable ? addSeconds(now, backoffMs / 1000) : now;
      const nextState = retryable ? "READY" : "FAILED";
      await tx.$executeRaw`
        UPDATE public."ConnectorSyncJob" SET state=${nextState},"leaseUntil"=NULL,"availableAt"=${availableAt}
        WHERE "customerId"=${customerId}::uuid AND "sourceId"=${source.id}::uuid AND id=${jobId}::uuid AND state='RUNNING'`;
      const failedCredential = input.code === "INVALID_CREDENTIALS" || input.code === "EXPIRED_CREDENTIALS";
      const healthState = retryable ? "DEGRADED" : "FAILED";
      const healthCode = input.code;
      const auditEventId = await this.audit(tx, customerId, runtimeActor, "ingestion.health.updated", {
        sourceId: source.id, state: healthState, code: healthCode,
      }, now);
      void auditEventId;
      await tx.$executeRaw`
        UPDATE public."IngestionSource" SET "healthState"=${healthState},"healthCode"=${healthCode},"healthCheckedAt"=${now}
        WHERE "customerId"=${customerId}::uuid AND id=${source.id}::uuid`;
      if (failedCredential) {
        const row = await this.credential(tx, customerId, source.id, "jira_oauth");
        if (row && row.state === "ACTIVE") {
          const revision = row.revision + 1;
          const credentialAuditId = await this.audit(tx, customerId, runtimeActor, "ingestion.connector_credential.reauth_required", {
            sourceId: source.id, purpose: "jira_oauth", state: "REAUTH_REQUIRED", revision, rotationOperationId: null,
          }, now);
          await tx.$executeRaw`
            UPDATE public."ConnectorCredential" SET state='REAUTH_REQUIRED',revision=${revision},"auditEventId"=${credentialAuditId}::uuid,"changedBy"=${runtimeActor}
            WHERE id=${row.id}::uuid AND revision=${row.revision} AND state='ACTIVE'`;
        }
      }
      return { state: nextState, availableAt, healthState, healthCode };
    }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 30000 });
  }
}
