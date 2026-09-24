-- EXEC-009 Stage 4: crash-safe Jira runtime, narrowly scoped service grants,
-- durable webhook receipts, and one-time sync jobs. Applied migrations 1..10
-- remain byte-for-byte unchanged.

ALTER TABLE public."ConnectorCredential"
  ADD COLUMN "sourceId" uuid,
  ADD COLUMN purpose varchar(32),
  ADD COLUMN state varchar(24) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "rotationOperationId" uuid,
  ADD COLUMN "rotationDeadline" timestamptz(3),
  ADD COLUMN "auditEventId" uuid,
  ADD COLUMN "changedBy" varchar(256),
  ADD CONSTRAINT "ConnectorCredential_source_fkey"
    FOREIGN KEY ("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ConnectorCredential_audit_fkey"
    FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ConnectorCredential_scope_check"
    CHECK (("sourceId" IS NULL AND purpose IS NULL AND "auditEventId" IS NULL AND "changedBy" IS NULL AND state='ACTIVE' AND "rotationOperationId" IS NULL AND "rotationDeadline" IS NULL) OR ("sourceId" IS NOT NULL AND purpose IN ('jira_oauth','jira_webhook_hmac') AND "auditEventId" IS NOT NULL AND public.nonblank_fact_text("changedBy") AND state IN ('ACTIVE','ROTATING','REAUTH_REQUIRED') AND ((state='ROTATING' AND purpose='jira_oauth' AND "rotationOperationId" IS NOT NULL AND "rotationDeadline" IS NOT NULL) OR (state<>'ROTATING' AND "rotationOperationId" IS NULL AND "rotationDeadline" IS NULL))));
CREATE UNIQUE INDEX "ConnectorCredential_source_purpose_key"
  ON public."ConnectorCredential"("customerId","sourceId",purpose) WHERE purpose IS NOT NULL;

CREATE TABLE public."ConnectorSyncGrant" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "configRevision" integer NOT NULL,
  revision integer NOT NULL,
  active boolean NOT NULL,
  "changedBy" varchar(256) NOT NULL,
  "auditEventId" uuid NOT NULL,
  "changedAt" timestamptz(3) NOT NULL,
  CONSTRAINT "ConnectorSyncGrant_pkey" PRIMARY KEY(id),
  CONSTRAINT "ConnectorSyncGrant_identity_key" UNIQUE("customerId","sourceId","projectId"),
  CONSTRAINT "ConnectorSyncGrant_scope_key" UNIQUE("customerId","sourceId","projectId",id),
  CONSTRAINT "ConnectorSyncGrant_source_fkey" FOREIGN KEY("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorSyncGrant_project_fkey" FOREIGN KEY("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorSyncGrant_configuration_fkey" FOREIGN KEY("customerId","sourceId","configRevision") REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorSyncGrant_audit_fkey" FOREIGN KEY("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorSyncGrant_revision_check" CHECK(revision>0 AND "configRevision">0)
);

CREATE TABLE public."ConnectorSyncJob" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "configRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  kind varchar(16) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'READY',
  "eventId" varchar(256),
  "idempotencyKey" varchar(320) NOT NULL,
  "resetRequested" boolean NOT NULL DEFAULT false,
  "resetCompleted" boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" timestamptz(3) NOT NULL,
  "leaseUntil" timestamptz(3),
  "completedAt" timestamptz(3),
  CONSTRAINT "ConnectorSyncJob_pkey" PRIMARY KEY(id),
  CONSTRAINT "ConnectorSyncJob_scope_key" UNIQUE("customerId","sourceId",id),
  CONSTRAINT "ConnectorSyncJob_idempotency_key" UNIQUE("customerId","sourceId","idempotencyKey"),
  CONSTRAINT "ConnectorSyncJob_source_fkey" FOREIGN KEY("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorSyncJob_configuration_fkey" FOREIGN KEY("customerId","sourceId","configRevision","mappingRevision") REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision,"mappingRevision") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorSyncJob_shape_check" CHECK(kind IN ('SCHEDULED','WEBHOOK') AND state IN ('READY','RUNNING','COMPLETED','FAILED','EXPIRED') AND attempts BETWEEN 0 AND 100 AND "configRevision">0 AND "mappingRevision">0 AND length("idempotencyKey") BETWEEN 1 AND 320 AND "expiresAt">"createdAt" AND ("eventId" IS NULL OR (length("eventId") BETWEEN 1 AND 256 AND "eventId" !~ '[[:cntrl:]]')) AND ((state='RUNNING')=("leaseUntil" IS NOT NULL)) AND ((state='COMPLETED')=("completedAt" IS NOT NULL)) AND (kind<>'WEBHOOK' OR "eventId" IS NOT NULL))
);
ALTER TABLE public."ConnectorSyncJob" ADD CONSTRAINT "ConnectorSyncJob_reset_check" CHECK (NOT "resetCompleted" OR "resetRequested");
CREATE INDEX "ConnectorSyncJob_dispatch_idx" ON public."ConnectorSyncJob"("customerId",state,"availableAt","createdAt") WHERE state IN ('READY','RUNNING');
CREATE UNIQUE INDEX "ConnectorSyncJob_running_source_key" ON public."ConnectorSyncJob"("customerId","sourceId") WHERE state='RUNNING';
CREATE UNIQUE INDEX "ConnectorSyncJob_ready_webhook_source_key" ON public."ConnectorSyncJob"("customerId","sourceId") WHERE state='READY' AND kind='WEBHOOK';

CREATE TABLE public."ConnectorWebhookReceipt" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "eventId" varchar(256) NOT NULL,
  "payloadHash" char(64) NOT NULL,
  "eventType" varchar(96) NOT NULL,
  "jobId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorWebhookReceipt_pkey" PRIMARY KEY(id),
  CONSTRAINT "ConnectorWebhookReceipt_event_key" UNIQUE("customerId","sourceId","eventId"),
  CONSTRAINT "ConnectorWebhookReceipt_scope_key" UNIQUE("customerId","sourceId",id),
  CONSTRAINT "ConnectorWebhookReceipt_source_fkey" FOREIGN KEY("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorWebhookReceipt_job_fkey" FOREIGN KEY("customerId","sourceId","jobId") REFERENCES public."ConnectorSyncJob"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorWebhookReceipt_event_check" CHECK(length("eventId") BETWEEN 1 AND 256 AND "eventId" !~ '[[:cntrl:]]' AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "eventType" ~ '^[A-Za-z0-9_.:-]{1,96}$')
);

CREATE TABLE public."ConnectorTaskReceipt" (
  nonce uuid NOT NULL,
  "keyId" varchar(64) NOT NULL,
  "requestTime" timestamptz(3) NOT NULL,
  "bodyHash" char(64) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorTaskReceipt_pkey" PRIMARY KEY(nonce),
  CONSTRAINT "ConnectorTaskReceipt_shape_check" CHECK("keyId" ~ '^[A-Za-z0-9._-]{1,64}$' AND "bodyHash" ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION public.guard_connector_task_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND OLD."createdAt"<CURRENT_TIMESTAMP-interval '10 minutes' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Connector task receipts are immutable while replayable';
END $$;
CREATE TRIGGER connector_task_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ConnectorTaskReceipt" FOR EACH ROW EXECUTE FUNCTION public.guard_connector_task_receipt();
CREATE TRIGGER connector_task_receipt_no_truncate BEFORE TRUNCATE ON public."ConnectorTaskReceipt" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

ALTER TABLE public."IngestionOperationReceipt"
  ADD COLUMN "executionMode" varchar(24) NOT NULL DEFAULT 'HUMAN',
  ADD COLUMN "syncJobId" uuid,
  ADD CONSTRAINT "IngestionOperationReceipt_execution_check" CHECK (("executionMode"='HUMAN' AND "syncJobId" IS NULL) OR ("executionMode"='CONNECTOR_SYNC' AND "syncJobId" IS NOT NULL)),
  ADD CONSTRAINT "IngestionOperationReceipt_sync_job_fkey" FOREIGN KEY("customerId","sourceId","syncJobId") REFERENCES public."ConnectorSyncJob"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE public."IngestionSyncReceiptProjectScope" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "syncGrantId" uuid NOT NULL,
  CONSTRAINT "IngestionSyncReceiptProjectScope_pkey" PRIMARY KEY("receiptId","projectId"),
  CONSTRAINT "IngestionSyncReceiptProjectScope_receipt_fkey" FOREIGN KEY("customerId","sourceId","receiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionSyncReceiptProjectScope_project_fkey" FOREIGN KEY("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionSyncReceiptProjectScope_grant_fkey" FOREIGN KEY("customerId","sourceId","projectId","syncGrantId") REFERENCES public."ConnectorSyncGrant"("customerId","sourceId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.guard_connector_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE audit_row public."AuditEvent"%ROWTYPE; expected_event text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connector credential history is retained'; END IF;
  IF NEW."sourceId" IS NULL AND NEW.purpose IS NULL THEN
    IF TG_OP='UPDATE' AND ROW(NEW.id,NEW."customerId",NEW.name,NEW.envelope,NEW."keyId",NEW.revision) IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD.name,OLD.envelope,OLD."keyId",OLD.revision) THEN RAISE EXCEPTION 'Legacy credentials are immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.state<>'ACTIVE' OR NEW."rotationOperationId" IS NOT NULL OR NEW."rotationDeadline" IS NOT NULL THEN RAISE EXCEPTION 'Invalid connector credential creation'; END IF;
    expected_event:='ingestion.connector_credential.configured';
  ELSE
    IF ROW(NEW.id,NEW."customerId",NEW."sourceId",NEW.purpose) IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."sourceId",OLD.purpose) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid connector credential revision'; END IF;
    IF OLD.state='ACTIVE' AND NEW.state='ROTATING' AND NEW.purpose='jira_oauth' AND NEW."rotationOperationId" IS NOT NULL AND NEW."rotationDeadline">CURRENT_TIMESTAMP AND NEW."rotationDeadline"<=CURRENT_TIMESTAMP+interval '60 seconds' THEN
      expected_event:='ingestion.connector_credential.rotation_started';
    ELSIF OLD.state='ROTATING' AND NEW.state='ACTIVE' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.rotation_completed';
    ELSIF OLD.state='ROTATING' AND NEW.state='REAUTH_REQUIRED' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.reauth_required';
    ELSIF OLD.purpose='jira_oauth' AND OLD.state='ACTIVE' AND NEW.state='REAUTH_REQUIRED' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.reauth_required';
    ELSIF OLD.purpose='jira_webhook_hmac' AND NEW.purpose=OLD.purpose AND NEW.state='ACTIVE' AND OLD.state='ACTIVE' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_webhook_secret.rotated';
    ELSIF OLD.purpose='jira_oauth' AND OLD.state IN ('ACTIVE','REAUTH_REQUIRED') AND NEW.purpose=OLD.purpose AND NEW.state='ACTIVE' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.configured';
    ELSIF OLD.state='REAUTH_REQUIRED' AND NEW.state='ACTIVE' AND NEW.purpose='jira_oauth' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.configured';
    ELSE
      RAISE EXCEPTION 'Invalid connector credential state transition';
    END IF;
  END IF;
  SELECT * INTO audit_row FROM public."AuditEvent" WHERE id=NEW."auditEventId" AND "customerId"=NEW."customerId" AND actor=NEW."changedBy" AND event=expected_event AND detail=jsonb_build_object('sourceId',NEW."sourceId",'purpose',NEW.purpose,'state',NEW.state,'revision',NEW.revision,'rotationOperationId',NEW."rotationOperationId");
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector credential update lacks matching audit'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_credential_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ConnectorCredential" FOR EACH ROW EXECUTE FUNCTION public.guard_connector_credential();
CREATE TRIGGER connector_credential_no_truncate BEFORE TRUNCATE ON public."ConnectorCredential" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE OR REPLACE FUNCTION public.guard_ingestion_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ingestion source identity is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."currentConfigRevision" IS NOT NULL OR NEW."mappingRevision"<>0 OR NEW."cursorRevision"<>0 OR NEW."syncGeneration"<>1 THEN RAISE EXCEPTION 'Invalid initial ingestion source'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW."customerId",NEW."sourceType",NEW.origin,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."sourceType",OLD.origin,OLD."createdAt") THEN RAISE EXCEPTION 'Ingestion source identity is immutable'; END IF;
  IF NEW."currentConfigRevision" IS DISTINCT FROM OLD."currentConfigRevision" OR NEW."mappingRevision" IS DISTINCT FROM OLD."mappingRevision" THEN
    IF (OLD."currentConfigRevision" IS NULL AND (NEW."currentConfigRevision"<>1 OR NEW."mappingRevision"<>1)) OR (OLD."currentConfigRevision" IS NOT NULL AND NEW."currentConfigRevision"<>OLD."currentConfigRevision"+1) THEN RAISE EXCEPTION 'Invalid ingestion configuration revision'; END IF;
    SELECT * INTO cfg FROM public."IngestionConfigurationRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW.id AND revision=NEW."currentConfigRevision" AND sealed;
    IF NOT FOUND OR cfg."mappingRevision"<>NEW."mappingRevision" OR NEW."mappingRevision"<OLD."mappingRevision" OR NEW."mappingRevision">OLD."mappingRevision"+1
      OR NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=cfg."auditEventId" AND a."customerId"=cfg."customerId" AND a.actor=cfg."changedBy" AND a.event='ingestion.configuration.changed' AND a."occurredAt"=cfg."createdAt" AND a.detail=jsonb_build_object('sourceId',NEW.id,'configRevision',cfg.revision,'mappingRevision',cfg."mappingRevision")) THEN RAISE EXCEPTION 'Invalid ingestion mapping revision'; END IF;
    IF OLD."currentConfigRevision" IS NOT NULL AND EXISTS (
      SELECT 1 FROM public."IngestionConfigurationRevision" prev
      WHERE prev."customerId"=OLD."customerId" AND prev."sourceId"=OLD.id AND prev.revision=OLD."currentConfigRevision"
        AND ((prev.mapping IS DISTINCT FROM cfg.mapping AND cfg."mappingRevision"<>prev."mappingRevision"+1)
          OR (prev.mapping IS NOT DISTINCT FROM cfg.mapping AND cfg."mappingRevision"<>prev."mappingRevision"))) THEN RAISE EXCEPTION 'Mapping revision does not match mapping semantics'; END IF;
    IF NEW."cursorRevision"<>OLD."cursorRevision" OR NEW."syncGeneration"<>OLD."syncGeneration" OR NEW."cursorEnvelope" IS NOT NULL OR NEW."cursorState"<>'RESET_REQUIRED' THEN RAISE EXCEPTION 'Configuration change must fence the current cursor'; END IF;
  ELSE
    IF NEW."cursorRevision" NOT IN (OLD."cursorRevision",OLD."cursorRevision"+1) OR NEW."syncGeneration" NOT IN (OLD."syncGeneration",OLD."syncGeneration"+1) THEN RAISE EXCEPTION 'Invalid cursor revision'; END IF;
    IF NEW."syncGeneration"=OLD."syncGeneration"+1 AND (NEW."cursorRevision"<>OLD."cursorRevision"+1 OR NEW."cursorEnvelope" IS NOT NULL OR NEW."cursorState"<>'READY') THEN RAISE EXCEPTION 'Invalid cursor reset'; END IF;
    IF NEW."syncGeneration"=OLD."syncGeneration" AND NEW."cursorRevision"=OLD."cursorRevision" AND ROW(NEW."cursorEnvelope",NEW."cursorState") IS DISTINCT FROM ROW(OLD."cursorEnvelope",OLD."cursorState") THEN RAISE EXCEPTION 'Cursor content requires a revision'; END IF;
    IF NEW."cursorRevision"=OLD."cursorRevision"+1 AND NOT EXISTS (
      SELECT 1 FROM public."IngestionCursorTransition" t
      JOIN public."IngestionOperationReceipt" r ON r.id=t."receiptId" AND r."customerId"=t."customerId" AND r."sourceId"=t."sourceId"
      WHERE t."customerId"=NEW."customerId" AND t."sourceId"=NEW.id AND t."generationBefore"=OLD."syncGeneration" AND t."generationAfter"=NEW."syncGeneration" AND t."cursorRevisionBefore"=OLD."cursorRevision" AND t."cursorRevisionAfter"=NEW."cursorRevision" AND t."stateAfter"=NEW."cursorState" AND t."cursorEnvelopeHash" IS NOT DISTINCT FROM CASE WHEN NEW."cursorEnvelope" IS NULL THEN NULL ELSE encode(sha256(convert_to(NEW."cursorEnvelope",'UTF8')),'hex') END
        AND ((r.kind='SYNC_RESET' AND NEW."lastSuccessReceiptId" IS NOT DISTINCT FROM OLD."lastSuccessReceiptId") OR (r.kind='CONNECTOR_PAGE' AND NEW."lastSuccessReceiptId"=r.id))
    ) THEN RAISE EXCEPTION 'Cursor advance requires an exact operation receipt'; END IF;
  END IF;
  IF NEW."healthState" NOT IN ('UNKNOWN','HEALTHY','DEGRADED','FAILED') OR NEW."healthCode" NOT IN ('NONE','INVALID_CREDENTIALS','EXPIRED_CREDENTIALS','PERMISSION_DENIED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE','INVALID_RESPONSE','NOT_FOUND','UNKNOWN_OUTCOME','INTEGRITY_CONFLICT','CURSOR_CONFLICT') THEN RAISE EXCEPTION 'Invalid ingestion health'; END IF;
  IF ROW(NEW."healthState",NEW."healthCode",NEW."healthCheckedAt") IS DISTINCT FROM ROW(OLD."healthState",OLD."healthCode",OLD."healthCheckedAt") AND NOT EXISTS (
    SELECT 1 FROM public."AuditEvent" a WHERE a."customerId"=NEW."customerId" AND a.event='ingestion.health.updated' AND a."occurredAt"=NEW."healthCheckedAt" AND a.detail=jsonb_build_object('sourceId',NEW.id,'state',NEW."healthState",'code',NEW."healthCode")
      AND (
        (a.actor IS NOT NULL AND a.actor<>'connector:jira-runtime' AND NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
          WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW.id AND cp."configRevision"=NEW."currentConfigRevision"
            AND (NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" cr WHERE cr."customerId"=cp."customerId" AND cr."sourceId"=cp."sourceId" AND cr."configRevision"=cp."configRevision" AND cr."projectId"=cp."projectId" AND cr.subject=a.actor)
              OR NOT EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g."customerId"=cp."customerId" AND g.subject=a.actor AND g.role IN ('project_manager','portfolio_manager','pmo_admin') AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))))))
        OR (a.actor='connector:jira-runtime' AND EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j."customerId"=NEW."customerId" AND j."sourceId"=NEW.id AND j."configRevision"=NEW."currentConfigRevision" AND j."mappingRevision"=NEW."mappingRevision" AND j.state IN ('RUNNING','READY','FAILED','COMPLETED'))
          AND NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW.id AND cp."configRevision"=NEW."currentConfigRevision"
            AND NOT EXISTS (SELECT 1 FROM public."ConnectorSyncGrant" g WHERE g."customerId"=cp."customerId" AND g."sourceId"=cp."sourceId" AND g."projectId"=cp."projectId" AND g."configRevision"=cp."configRevision" AND g.active)))
      )
  ) THEN RAISE EXCEPTION 'Ingestion health update lacks current source and project authorization'; END IF;
  IF NEW."lastSuccessReceiptId" IS DISTINCT FROM OLD."lastSuccessReceiptId" AND NEW."lastSuccessReceiptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r.id=NEW."lastSuccessReceiptId" AND r."customerId"=NEW."customerId" AND r."sourceId"=NEW.id AND r.kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT')) THEN RAISE EXCEPTION 'Invalid last successful ingestion receipt'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_connector_sync_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE project_row public."Project"%ROWTYPE; source_row public."IngestionSource"%ROWTYPE; admin_row public."AccessGrant"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connector sync grant history is retained'; END IF;
  SELECT * INTO project_row FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector sync scope unavailable'; END IF;
  SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector sync scope unavailable'; END IF;
  IF NEW.active AND (source_row."currentConfigRevision" IS DISTINCT FROM NEW."configRevision" OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW."sourceId" AND cp."configRevision"=NEW."configRevision" AND cp."projectId"=NEW."projectId")) THEN RAISE EXCEPTION 'Connector sync grant is outside current configuration'; END IF;
  SELECT * INTO admin_row FROM public."AccessGrant" g WHERE g."customerId"=NEW."customerId" AND g.subject=NEW."changedBy" AND g.role='pmo_admin' AND ((g."scopeType"='project' AND g."scopeId"=NEW."projectId") OR (g."scopeType"='portfolio' AND g."scopeId"=project_row."portfolioId")) ORDER BY g.id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector sync grant requires current administrator scope'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NOT NEW.active THEN RAISE EXCEPTION 'Invalid connector sync grant creation'; END IF;
  ELSE
    IF ROW(NEW.id,NEW."customerId",NEW."sourceId",NEW."projectId") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."sourceId",OLD."projectId") OR NEW.revision<>OLD.revision+1 OR (OLD.active AND NOT NEW.active AND NEW."configRevision"<>OLD."configRevision") THEN RAISE EXCEPTION 'Invalid connector sync grant transition'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=NEW."auditEventId" AND a."customerId"=NEW."customerId" AND a.actor=NEW."changedBy" AND a.event=CASE WHEN NEW.active THEN 'ingestion.sync_scope.granted' ELSE 'ingestion.sync_scope.revoked' END AND a."occurredAt"=NEW."changedAt" AND a.detail=jsonb_build_object('sourceId',NEW."sourceId",'projectId',NEW."projectId",'configRevision',NEW."configRevision",'revision',NEW.revision,'active',NEW.active)) THEN RAISE EXCEPTION 'Connector sync grant update lacks audit'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_sync_grant_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ConnectorSyncGrant" FOR EACH ROW EXECUTE FUNCTION public.guard_connector_sync_grant();
CREATE TRIGGER connector_sync_grant_no_truncate BEFORE TRUNCATE ON public."ConnectorSyncGrant" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE FUNCTION public.guard_connector_sync_job() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public."IngestionSource"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connector sync jobs are retained'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'READY' OR NEW.attempts<>0 OR NEW."leaseUntil" IS NOT NULL OR NEW."completedAt" IS NOT NULL THEN RAISE EXCEPTION 'Invalid connector sync job creation'; END IF;
    SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
    IF NOT FOUND OR s."sourceType"<>'jira' OR s."currentConfigRevision" IS DISTINCT FROM NEW."configRevision" OR s."mappingRevision"<>NEW."mappingRevision" THEN RAISE EXCEPTION 'Connector sync job configuration is stale'; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW."sourceId" AND cp."configRevision"=NEW."configRevision" AND NOT EXISTS (SELECT 1 FROM public."ConnectorSyncGrant" g WHERE g."customerId"=cp."customerId" AND g."sourceId"=cp."sourceId" AND g."projectId"=cp."projectId" AND g."configRevision"=cp."configRevision" AND g.active)) THEN RAISE EXCEPTION 'Connector sync job lacks complete current scope'; END IF;
  ELSE
    IF ROW(NEW.id,NEW."customerId",NEW."sourceId",NEW."configRevision",NEW."mappingRevision",NEW.kind,NEW."eventId",NEW."idempotencyKey",NEW."createdAt",NEW."expiresAt") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."sourceId",OLD."configRevision",OLD."mappingRevision",OLD.kind,OLD."eventId",OLD."idempotencyKey",OLD."createdAt",OLD."expiresAt") THEN RAISE EXCEPTION 'Connector sync job identity is immutable'; END IF;
    IF NOT ((OLD.state='READY' AND NEW.state IN ('RUNNING','EXPIRED')) OR (OLD.state='RUNNING' AND NEW.state IN ('RUNNING','READY','COMPLETED','FAILED','EXPIRED')) OR (OLD.state=NEW.state AND OLD.state IN ('READY','RUNNING') AND NOT OLD."resetRequested" AND NEW."resetRequested")) THEN RAISE EXCEPTION 'Invalid connector sync job state transition'; END IF;
    IF (OLD."resetRequested" AND NOT NEW."resetRequested") OR (NEW."resetCompleted" AND (NOT NEW."resetRequested" OR OLD."resetCompleted" OR OLD.state<>'RUNNING')) THEN RAISE EXCEPTION 'Invalid connector sync reset marker'; END IF;
    IF NEW.state='RUNNING' AND (NEW."leaseUntil"<=CURRENT_TIMESTAMP OR NEW."leaseUntil">CURRENT_TIMESTAMP+interval '60 seconds' OR NEW.attempts<>OLD.attempts+1 OR (OLD.state='RUNNING' AND OLD."leaseUntil">CURRENT_TIMESTAMP)) THEN RAISE EXCEPTION 'Invalid connector sync lease'; END IF;
    IF NEW.state<>'RUNNING' AND NEW.attempts<>OLD.attempts THEN RAISE EXCEPTION 'Connector sync attempt count cannot change outside claim'; END IF;
    IF (NEW.state='COMPLETED')<>(NEW."completedAt" IS NOT NULL) THEN RAISE EXCEPTION 'Invalid connector sync completion'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_sync_job_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ConnectorSyncJob" FOR EACH ROW EXECUTE FUNCTION public.guard_connector_sync_job();
CREATE TRIGGER connector_sync_job_no_truncate BEFORE TRUNCATE ON public."ConnectorSyncJob" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE FUNCTION public.guard_connector_webhook_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE j public."ConnectorSyncJob"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Connector webhook receipts are immutable'; END IF;
  SELECT * INTO j FROM public."ConnectorSyncJob" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND id=NEW."jobId";
  IF NOT FOUND OR j.kind<>'WEBHOOK' THEN RAISE EXCEPTION 'Webhook receipt requires its source-bound reconciliation job'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connector_webhook_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ConnectorWebhookReceipt" FOR EACH ROW EXECUTE FUNCTION public.guard_connector_webhook_receipt();
CREATE TRIGGER connector_webhook_receipt_no_truncate BEFORE TRUNCATE ON public."ConnectorWebhookReceipt" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE FUNCTION public.guard_ingestion_sync_receipt_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; project_row public."Project"%ROWTYPE; source_row public."IngestionSource"%ROWTYPE; grant_row public."ConnectorSyncGrant"%ROWTYPE; job_row public."ConnectorSyncJob"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion sync receipt scope is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR r."executionMode"<>'CONNECTOR_SYNC' OR r."syncJobId" IS NULL THEN RAISE EXCEPTION 'Ingestion sync scope requires a service receipt'; END IF;
  SELECT * INTO project_row FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=r."configRevision" AND "projectId"=NEW."projectId") THEN RAISE EXCEPTION 'Ingestion sync receipt scope is outside its configuration'; END IF;
  SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND OR source_row."currentConfigRevision" IS DISTINCT FROM r."configRevision" THEN RAISE EXCEPTION 'Ingestion sync receipt configuration is stale'; END IF;
  SELECT * INTO grant_row FROM public."ConnectorSyncGrant" g WHERE g."customerId"=NEW."customerId" AND g."sourceId"=NEW."sourceId" AND g."projectId"=NEW."projectId" AND g.id=NEW."syncGrantId" AND g."configRevision"=r."configRevision" AND g.active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion sync receipt lacks current source/project service scope'; END IF;
  SELECT * INTO job_row FROM public."ConnectorSyncJob" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND id=r."syncJobId" FOR SHARE;
  IF NOT FOUND OR job_row.state<>'RUNNING' OR job_row."configRevision"<>r."configRevision" OR job_row."mappingRevision"<>r."mappingRevision" THEN RAISE EXCEPTION 'Ingestion sync receipt job is not current'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ingestion_sync_receipt_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionSyncReceiptProjectScope" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_sync_receipt_scope();
CREATE TRIGGER ingestion_sync_receipt_scope_no_truncate BEFORE TRUNCATE ON public."IngestionSyncReceiptProjectScope" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE OR REPLACE FUNCTION public.guard_ingestion_receipt_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; project_row public."Project"%ROWTYPE; source_row public."IngestionSource"%ROWTYPE; grant_row public."AccessGrant"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion receipt scope is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR r."executionMode"<>'HUMAN' THEN RAISE EXCEPTION 'Human receipt scope requires a human receipt'; END IF;
  SELECT * INTO project_row FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=r."configRevision" AND "projectId"=NEW."projectId") THEN RAISE EXCEPTION 'Ingestion receipt scope is outside its configuration'; END IF;
  SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND OR source_row."currentConfigRevision" IS DISTINCT FROM r."configRevision" THEN RAISE EXCEPTION 'Ingestion receipt configuration is no longer current'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=source_row."currentConfigRevision" AND "projectId"=NEW."projectId" AND subject=r.subject) THEN RAISE EXCEPTION 'Ingestion receipt actor lacks current source-reader access'; END IF;
  SELECT * INTO grant_row FROM public."AccessGrant" g WHERE g."customerId"=NEW."customerId" AND g.subject=r.subject AND g.role=NEW."grantRole" AND NEW."grantRole" IN ('project_manager','portfolio_manager','pmo_admin') AND ((g."scopeType"='project' AND g."scopeId"=project_row.id) OR (g."scopeType"='portfolio' AND g."scopeId"=project_row."portfolioId")) AND g.id=NEW."grantId" AND g."scopeType"=NEW."grantScopeType" AND g."scopeId"=NEW."grantScopeId" ORDER BY g.id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion receipt requires a current project grant'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.valid_ingestion_receipt(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; actual_count integer; min_ordinal integer; max_ordinal integer; expected_event text;
BEGIN
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_count,min_ordinal,max_ordinal FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_count<>r."outcomeCount" OR (actual_count>0 AND (min_ordinal<>1 OR max_ordinal<>actual_count)) THEN RETURN false; END IF;
  IF r."executionMode"='HUMAN' THEN
    IF r."syncJobId" IS NOT NULL OR (SELECT count(*) FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" s WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) OR EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id) THEN RETURN false; END IF;
  ELSIF r."executionMode"='CONNECTOR_SYNC' THEN
    IF r."syncJobId" IS NULL OR (SELECT count(*) FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" s JOIN public."ConnectorSyncGrant" g ON g.id=s."syncGrantId" AND g."customerId"=s."customerId" AND g."sourceId"=s."sourceId" AND g."projectId"=s."projectId" WHERE s."receiptId"=r.id AND s."projectId"=p."projectId" AND g.active AND g."configRevision"=r."configRevision")) OR EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id) OR NOT EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j.id=r."syncJobId" AND j."customerId"=r."customerId" AND j."sourceId"=r."sourceId" AND j."configRevision"=r."configRevision" AND j."mappingRevision"=r."mappingRevision" AND j.state IN ('READY','COMPLETED')) THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  expected_event:=CASE r.kind WHEN 'CONNECTOR_PAGE' THEN 'ingestion.connector_page.persisted' WHEN 'CONNECTOR_EVENT' THEN 'ingestion.connector_event.persisted' WHEN 'CSV_PREVIEW' THEN 'ingestion.csv_preview.persisted' WHEN 'SYNC_RESET' THEN 'ingestion.sync_reset' END;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=r."customerId" AND a.actor=r.subject AND a.event=expected_event AND a."occurredAt"=r."createdAt" AND a.detail=jsonb_build_object('receiptId',r.id,'kind',r.kind,'sourceId',r."sourceId",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",'scopeProjectIds',(SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id) || (SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionSyncReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id),'requestHash',r."requestHash",'outcomeCount',r."outcomeCount"')) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND ((o.state='ACCEPTED' AND (o."recordKey" IS NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e.id=o."recordId" AND e."customerId"=o."customerId" AND e."sourceId"=o."sourceId" AND e."projectId"=o."projectId" AND e."recordKey"=o."recordKey") OR NOT EXISTS (SELECT 1 FROM public."IngestionSourceRevision" v WHERE v.id=o."sourceRevisionId" AND v."customerId"=o."customerId" AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" p WHERE p.id=o."projectionId" AND p."customerId"=o."customerId" AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalContent" c WHERE c."customerId"=o."customerId" AND c."sourceId"=o."sourceId" AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId") OR o."projectId" IS NULL)) OR (o.state<>'ACCEPTED' AND (o."projectionId" IS NOT NULL OR cardinality(o."errorCodes")=0)))) THEN RETURN false; END IF;
  IF r.kind='SYNC_RESET' AND (r."outcomeCount"<>0 OR r."generationAfter"<>r."generationBefore"+1 OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind='CONNECTOR_PAGE' AND (r."generationAfter"<>r."generationBefore" OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind IN ('CONNECTOR_PAGE','SYNC_RESET') AND NOT EXISTS (SELECT 1 FROM public."IngestionCursorTransition" t WHERE t."customerId"=r."customerId" AND t."sourceId"=r."sourceId" AND t."receiptId"=r.id AND t."generationBefore"=r."generationBefore" AND t."generationAfter"=r."generationAfter" AND t."cursorRevisionBefore"=r."cursorRevisionBefore" AND t."cursorRevisionAfter"=r."cursorRevisionAfter" AND ((r.kind='SYNC_RESET' AND t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NULL) OR (r.kind='CONNECTOR_PAGE' AND ((t."stateAfter"='TERMINAL' AND t."cursorEnvelopeHash" IS NULL) OR (t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NOT NULL))))) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.guard_connector_credential(),public.guard_connector_sync_grant(),public.guard_connector_sync_job(),public.guard_connector_webhook_receipt(),public.guard_ingestion_sync_receipt_scope(),public.guard_connector_task_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_ingestion_receipt(uuid) FROM PUBLIC;
