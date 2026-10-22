-- EXEC-019 / AC-CON-004: durable causes and fenced project assessment claims.
-- Retain all prior migration bytes and the legacy failure/success not-before fence.
ALTER TABLE public."ProjectUpdatePolicy"
  ADD COLUMN "scanFailureNextEligibleAt" timestamptz(3),
  ADD COLUMN "scanClaimGeneration" integer NOT NULL DEFAULT 0 CHECK ("scanClaimGeneration">=0),
  ADD COLUMN "scanClaimUntil" timestamptz(3);
UPDATE public."ProjectUpdatePolicy" SET "scanFailureNextEligibleAt"="scheduledScanNextEligibleAt";

CREATE TABLE public."IngestionProjectReassessment" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "configRevision" integer NOT NULL CHECK ("configRevision">0),
  "mappingRevision" integer NOT NULL CHECK ("mappingRevision">0),
  reason varchar(32) NOT NULL DEFAULT 'CONNECTOR_CHANGED' CHECK (reason='CONNECTOR_CHANGED'),
  "createdAt" timestamptz(3) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','COMPLETED','BLOCKED')),
  "attemptCount" integer NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 5),
  "totalAttempts" integer NOT NULL DEFAULT 0 CHECK ("totalAttempts">="attemptCount"),
  "recoveryRevision" integer NOT NULL DEFAULT 0 CHECK ("recoveryRevision">=0),
  "availableAt" timestamptz(3) NOT NULL,
  "lastReason" varchar(32) NOT NULL DEFAULT 'QUEUED' CHECK ("lastReason" IN
    ('QUEUED','CLAIMED','FAILED','LOCK_CONTENDED','POLICY_DISABLED','SOURCE_SCOPE_CHANGED','RETRY_EXHAUSTED','RETRY_REQUESTED','COMPLETED')),
  "claimedGeneration" integer CHECK ("claimedGeneration">0),
  "assessmentId" uuid,
  "obligationId" uuid,
  "previewId" uuid,
  "completedAt" timestamptz(3),
  "auditEventId" uuid NOT NULL,
  CONSTRAINT "IngestionReassessment_cause_key" UNIQUE ("customerId","sourceId","receiptId","projectId"),
  CONSTRAINT "IngestionReassessment_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "IngestionReassessment_receipt_fk" FOREIGN KEY ("customerId","sourceId","receiptId")
    REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReassessment_project_fk" FOREIGN KEY ("customerId","projectId")
    REFERENCES public."CanonicalProject"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReassessment_assessment_fk" FOREIGN KEY ("customerId","projectId","assessmentId")
    REFERENCES public."ProjectUpdateAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReassessment_obligation_fk" FOREIGN KEY ("customerId","projectId","obligationId")
    REFERENCES public."ProjectUpdateObligation"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReassessment_preview_fk" FOREIGN KEY ("customerId","projectId","previewId")
    REFERENCES public."ProjectUpdatePreview"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReassessment_audit_fk" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReassessment_completion_check" CHECK (
    (state='COMPLETED' AND "assessmentId" IS NOT NULL AND "completedAt" IS NOT NULL AND "claimedGeneration" IS NOT NULL
      AND "lastReason"='COMPLETED' AND (("obligationId" IS NULL AND "previewId" IS NULL) OR ("obligationId" IS NOT NULL AND "previewId" IS NOT NULL)))
    OR (state IN ('READY','BLOCKED') AND "assessmentId" IS NULL AND "obligationId" IS NULL AND "previewId" IS NULL AND "completedAt" IS NULL))
);
CREATE INDEX "IngestionReassessment_project_idx" ON public."IngestionProjectReassessment" ("customerId","projectId","createdAt",id);
CREATE INDEX "IngestionReassessment_ready_idx" ON public."IngestionProjectReassessment" ("customerId","projectId","availableAt","createdAt",id) WHERE state='READY';
CREATE INDEX "IngestionReassessment_assessment_idx" ON public."IngestionProjectReassessment" ("customerId","projectId","assessmentId") WHERE "assessmentId" IS NOT NULL;
CREATE INDEX "IngestionReassessment_obligation_idx" ON public."IngestionProjectReassessment" ("customerId","projectId","obligationId") WHERE "obligationId" IS NOT NULL;
CREATE INDEX "IngestionReassessment_preview_idx" ON public."IngestionProjectReassessment" ("customerId","projectId","previewId") WHERE "previewId" IS NOT NULL;
CREATE INDEX "IngestionReassessment_audit_idx" ON public."IngestionProjectReassessment" ("customerId","auditEventId");

CREATE FUNCTION public.valid_ingestion_reassessment_row(w public."IngestionProjectReassessment")
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."IngestionOperationReceipt" r
    JOIN public."IngestionSyncReceiptProjectScope" s ON s."receiptId"=r.id AND s."customerId"=r."customerId" AND s."sourceId"=r."sourceId"
    WHERE r.id=w."receiptId" AND r."customerId"=w."customerId" AND r."sourceId"=w."sourceId"
      AND r.kind='CONNECTOR_PAGE' AND r."executionMode"='CONNECTOR_SYNC' AND r."syncJobId" IS NOT NULL
      AND r."configRevision"=w."configRevision" AND r."mappingRevision"=w."mappingRevision"
      AND r."createdAt"<=w."createdAt" AND s."projectId"=w."projectId"
      AND public.valid_ingestion_receipt(r.id)
      AND EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id
        AND o."customerId"=w."customerId" AND o."sourceId"=w."sourceId" AND o."projectId"=w."projectId"
        AND o.state='ACCEPTED' AND o.operation IN ('CREATE','UPDATE'))
  ) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=w."auditEventId" AND a."customerId"=w."customerId"
    AND a.detail @> jsonb_build_object('causeId',w.id::text,'projectId',w."projectId"::text,'receiptId',w."receiptId"::text,'sourceId',w."sourceId"::text)) THEN RETURN false; END IF;
  IF w.state='COMPLETED' THEN
    IF NOT EXISTS (SELECT 1 FROM public."ProjectUpdateAssessment" a
      JOIN public."AuditEvent" assessed ON assessed."customerId"=a."customerId" AND assessed.id=a."auditEventId"
      JOIN public."AuditEvent" completed ON completed."customerId"=a."customerId" AND completed.id=w."auditEventId"
      JOIN public."AuditEvent" claimed ON claimed."customerId"=a."customerId" AND claimed.id::text=completed.detail->>'claimAuditEventId'
      WHERE a.id=w."assessmentId"
      AND a."customerId"=w."customerId" AND a."projectId"=w."projectId" AND a."assessedAt">=w."createdAt"
      AND a."assessedAt"<=w."completedAt" AND a."assessedAt">=claimed."occurredAt"
      AND assessed.event='project_update.assessed' AND claimed.event='ingestion.reassessment.claimed'
      AND claimed.detail @> jsonb_build_object('causeId',w.id::text,'projectId',w."projectId"::text,
        'sourceId',w."sourceId"::text,'receiptId',w."receiptId"::text,'generation',w."claimedGeneration")
      AND assessed."correlationId"=claimed."correlationId" AND completed."correlationId"=claimed."correlationId"
      AND assessed.actor=claimed.actor AND completed.actor=claimed.actor
      AND assessed.detail->>'assessmentId'=a.id::text AND assessed.detail->>'projectId'=w."projectId"::text)
      THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=w."auditEventId" AND a."customerId"=w."customerId"
      AND a.event='ingestion.reassessment.completed' AND a."occurredAt"=w."completedAt"
      AND a.detail @> jsonb_build_object('generation',w."claimedGeneration",'assessmentId',w."assessmentId"::text,
        'obligationId',w."obligationId"::text,'previewId',w."previewId"::text)) THEN RETURN false; END IF;
    IF w."previewId" IS NULL THEN
      IF EXISTS (SELECT 1 FROM public."ProjectUpdatePreview" p WHERE p."customerId"=w."customerId" AND p."projectId"=w."projectId" AND p."assessmentId"=w."assessmentId") THEN RETURN false; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public."ProjectUpdatePreview" p WHERE p.id=w."previewId" AND p."customerId"=w."customerId"
      AND p."projectId"=w."projectId" AND p."assessmentId"=w."assessmentId" AND p."obligationId"=w."obligationId") THEN RETURN false; END IF;
  END IF;
  RETURN true;
END;
$$;
CREATE FUNCTION public.valid_ingestion_project_reassessment(target uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT public.valid_ingestion_reassessment_row(w) FROM public."IngestionProjectReassessment" w WHERE w.id=target),false)
$$;

CREATE FUNCTION public.guard_ingestion_project_reassessment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_name text; audit_detail jsonb; current_generation integer; lease_until timestamptz; controls text[] := ARRAY[
  'state','attemptCount','totalAttempts','recoveryRevision','availableAt','lastReason','claimedGeneration',
  'assessmentId','obligationId','previewId','completedAt','auditEventId'];
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reassessment history is immutable'; END IF;
  SELECT event,detail INTO event_name,audit_detail FROM public."AuditEvent" WHERE id=NEW."auditEventId" AND "customerId"=NEW."customerId";
  IF TG_OP='UPDATE' AND NEW.state='COMPLETED' THEN
    PERFORM id FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
    -- An actual tuple version fences older RepeatableRead/Serializable snapshots
    -- against preview insertion. No policy value, counter or timer changes.
    UPDATE public."ProjectUpdatePolicy" SET "scanClaimGeneration"="scanClaimGeneration"
      WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId"
      RETURNING "scanClaimGeneration","scanClaimUntil" INTO current_generation,lease_until;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reassessment completion requires policy head'; END IF;
  ELSE
    SELECT "scanClaimGeneration","scanClaimUntil" INTO current_generation,lease_until FROM public."ProjectUpdatePolicy"
      WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId";
  END IF;
  IF TG_OP='INSERT' THEN
    PERFORM id FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId"
      AND "currentConfigRevision"=NEW."configRevision" AND "mappingRevision"=NEW."mappingRevision" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reassessment birth requires current source'; END IF;
    PERFORM g.id FROM public."ConnectorSyncGrant" g JOIN public."IngestionSyncReceiptProjectScope" s
      ON s."customerId"=g."customerId" AND s."sourceId"=g."sourceId" AND s."projectId"=g."projectId" AND s."syncGrantId"=g.id
      WHERE s."receiptId"=NEW."receiptId" AND s."customerId"=NEW."customerId" AND s."sourceId"=NEW."sourceId"
        AND s."projectId"=NEW."projectId" AND g.active AND g."configRevision"=NEW."configRevision" FOR SHARE OF g;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reassessment birth requires current grant'; END IF;
    PERFORM h."projectId" FROM public."ProjectUpdatePolicy" h JOIN public."ProjectUpdatePolicyRevision" p
      ON p."customerId"=h."customerId" AND p."projectId"=h."projectId" AND p.revision=h.revision
      WHERE h."customerId"=NEW."customerId" AND h."projectId"=NEW."projectId"
        AND p."scheduledScanEnabled" AND p."scheduledServiceSubject" IS NOT NULL FOR SHARE OF h;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reassessment birth requires enabled policy'; END IF;
    IF NEW.state<>'READY' OR NEW."attemptCount"<>0 OR NEW."totalAttempts"<>0 OR NEW."recoveryRevision"<>0
      OR NEW."claimedGeneration" IS NOT NULL OR NEW."availableAt"<>NEW."createdAt" OR NEW."lastReason"<>'QUEUED'
      OR event_name IS DISTINCT FROM 'ingestion.reassessment.queued'
      OR NOT EXISTS (SELECT 1 FROM public."ProjectUpdatePolicy" h JOIN public."ProjectUpdatePolicyRevision" p
        ON p."customerId"=h."customerId" AND p."projectId"=h."projectId" AND p.revision=h.revision
        WHERE h."customerId"=NEW."customerId" AND h."projectId"=NEW."projectId" AND p."scheduledScanEnabled" AND p."scheduledServiceSubject" IS NOT NULL)
    THEN RAISE EXCEPTION 'Invalid reassessment birth'; END IF;
  ELSE
    IF OLD.state='COMPLETED' OR to_jsonb(NEW)-controls IS DISTINCT FROM to_jsonb(OLD)-controls
      OR NEW."auditEventId"=OLD."auditEventId" OR NEW."totalAttempts"<OLD."totalAttempts" THEN
      RAISE EXCEPTION 'Immutable reassessment identity'; END IF;
    IF event_name='ingestion.reassessment.claimed' THEN
      IF OLD.state<>'READY' OR NEW.state<>'READY' OR OLD."attemptCount">=5
        OR NEW."attemptCount"<>OLD."attemptCount"+1 OR NEW."totalAttempts"<>OLD."totalAttempts"+1
        OR NEW."recoveryRevision"<>OLD."recoveryRevision" OR NEW."claimedGeneration" IS DISTINCT FROM current_generation
        OR NEW."claimedGeneration" IS NOT DISTINCT FROM OLD."claimedGeneration"
        OR audit_detail->'generation' IS DISTINCT FROM to_jsonb(NEW."claimedGeneration")
        OR lease_until IS NULL OR lease_until<=clock_timestamp() OR NEW."lastReason"<>'CLAIMED'
        OR OLD."availableAt">clock_timestamp() OR NEW."availableAt"<>OLD."availableAt"
      THEN RAISE EXCEPTION 'Invalid reassessment claim'; END IF;
    ELSIF event_name='ingestion.reassessment.contention' THEN
      IF OLD.state<>'READY' OR NEW.state<>'READY' OR OLD."claimedGeneration" IS DISTINCT FROM current_generation
        OR lease_until IS NULL OR lease_until<=clock_timestamp() OR OLD."attemptCount"<1
        OR NEW."attemptCount"<>OLD."attemptCount"-1 OR NEW."totalAttempts"<>OLD."totalAttempts"
        OR NEW."recoveryRevision"<>OLD."recoveryRevision" OR NEW."claimedGeneration" IS NOT NULL
        OR NEW."lastReason"<>'LOCK_CONTENDED' OR NEW."availableAt"<=OLD."availableAt"
        OR audit_detail->'generation' IS DISTINCT FROM to_jsonb(OLD."claimedGeneration")
        OR audit_detail->>'reason' IS DISTINCT FROM NEW."lastReason"
      THEN RAISE EXCEPTION 'Invalid reassessment contention release'; END IF;
    ELSIF event_name='ingestion.reassessment.retried' THEN
      IF OLD.state<>'BLOCKED' OR NEW.state<>'READY' OR NEW."attemptCount"<>0
        OR NEW."totalAttempts"<>OLD."totalAttempts" OR NEW."recoveryRevision"<>OLD."recoveryRevision"+1
        OR NEW."claimedGeneration" IS NOT NULL OR NEW."lastReason"<>'RETRY_REQUESTED'
        OR audit_detail->'expectedRecoveryRevision' IS DISTINCT FROM to_jsonb(OLD."recoveryRevision")
      THEN RAISE EXCEPTION 'Invalid reassessment recovery'; END IF;
    ELSIF event_name IN ('ingestion.reassessment.completed','ingestion.reassessment.failed','ingestion.reassessment.blocked') THEN
      IF OLD.state<>'READY' OR NEW."attemptCount"<>OLD."attemptCount" OR NEW."totalAttempts"<>OLD."totalAttempts"
        OR NEW."recoveryRevision"<>OLD."recoveryRevision" OR NEW."claimedGeneration" IS DISTINCT FROM OLD."claimedGeneration"
      THEN RAISE EXCEPTION 'Invalid reassessment result'; END IF;
      IF event_name='ingestion.reassessment.completed' AND (NEW.state<>'COMPLETED' OR OLD."claimedGeneration" IS DISTINCT FROM current_generation
        OR lease_until IS NULL OR lease_until<=clock_timestamp()
        OR audit_detail->>'claimAuditEventId' IS DISTINCT FROM OLD."auditEventId"::text)
        THEN RAISE EXCEPTION 'Stale reassessment completion'; END IF;
      IF event_name='ingestion.reassessment.failed' AND (NEW.state NOT IN ('READY','BLOCKED') OR OLD."claimedGeneration" IS DISTINCT FROM current_generation
        OR audit_detail->'generation' IS DISTINCT FROM to_jsonb(OLD."claimedGeneration")
        OR audit_detail->>'reason' IS DISTINCT FROM NEW."lastReason"
        OR lease_until IS NULL OR lease_until<=clock_timestamp() OR (NEW.state='BLOCKED') IS DISTINCT FROM (NEW."attemptCount"=5)
        OR NEW."lastReason"<>CASE WHEN NEW.state='BLOCKED' THEN 'RETRY_EXHAUSTED' ELSE 'FAILED' END)
        THEN RAISE EXCEPTION 'Stale reassessment failure'; END IF;
      IF event_name='ingestion.reassessment.blocked' AND (NEW.state<>'BLOCKED'
        OR audit_detail->>'reason' IS DISTINCT FROM NEW."lastReason"
        OR NEW."lastReason" NOT IN ('SOURCE_SCOPE_CHANGED','POLICY_DISABLED','RETRY_EXHAUSTED')
        OR (NEW."lastReason"='RETRY_EXHAUSTED' AND NEW."attemptCount"<>5))
        THEN RAISE EXCEPTION 'Invalid reassessment block'; END IF;
      IF event_name='ingestion.reassessment.blocked' THEN
        IF NEW."lastReason"='RETRY_EXHAUSTED' AND (OLD."claimedGeneration" IS NULL OR current_generation IS NULL
          OR OLD."claimedGeneration">current_generation
          OR (OLD."claimedGeneration"=current_generation AND lease_until IS NOT NULL AND lease_until>clock_timestamp()))
          THEN RAISE EXCEPTION 'Unexpired reassessment attempt'; END IF;
        IF NEW."lastReason"='POLICY_DISABLED' AND EXISTS (SELECT 1 FROM public."ProjectUpdatePolicy" h
          JOIN public."ProjectUpdatePolicyRevision" p ON p."customerId"=h."customerId" AND p."projectId"=h."projectId" AND p.revision=h.revision
          WHERE h."customerId"=NEW."customerId" AND h."projectId"=NEW."projectId" AND p."scheduledScanEnabled")
          THEN RAISE EXCEPTION 'Reassessment policy remains enabled'; END IF;
        IF NEW."lastReason"='SOURCE_SCOPE_CHANGED' THEN
          IF OLD."claimedGeneration" IS DISTINCT FROM current_generation OR lease_until IS NULL OR lease_until<=clock_timestamp()
            THEN RAISE EXCEPTION 'Stale reassessment scope result'; END IF;
          IF EXISTS (SELECT 1 FROM public."IngestionSource" s JOIN public."ConnectorSyncGrant" g
            ON g."customerId"=s."customerId" AND g."sourceId"=s.id AND g."projectId"=NEW."projectId"
            JOIN public."IngestionSyncReceiptProjectScope" scope ON scope."customerId"=g."customerId" AND scope."sourceId"=g."sourceId"
              AND scope."projectId"=g."projectId" AND scope."syncGrantId"=g.id AND scope."receiptId"=NEW."receiptId"
            WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId" AND s."currentConfigRevision"=NEW."configRevision"
              AND s."mappingRevision"=NEW."mappingRevision" AND g.active AND g."configRevision"=NEW."configRevision")
            THEN RAISE EXCEPTION 'Reassessment source scope remains current'; END IF;
        END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Unrecognized reassessment transition'; END IF;
  END IF;
  IF NOT public.valid_ingestion_reassessment_row(NEW) THEN RAISE EXCEPTION 'Invalid reassessment lineage'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "IngestionReassessment_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionProjectReassessment"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_project_reassessment();
CREATE FUNCTION public.reject_ingestion_reassessment_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Reassessment history is immutable';
END;
$$;
CREATE TRIGGER "IngestionReassessment_no_truncate" BEFORE TRUNCATE ON public."IngestionProjectReassessment"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ingestion_reassessment_history();
CREATE FUNCTION public.lock_ingestion_reassessment_preview()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  UPDATE public."ProjectUpdatePolicy" SET "scanClaimGeneration"="scanClaimGeneration"
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Reassessment preview requires policy head'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "IngestionReassessment_preview_lock" BEFORE INSERT ON public."ProjectUpdatePreview"
  FOR EACH ROW EXECUTE FUNCTION public.lock_ingestion_reassessment_preview();
-- Validate the final transaction state too: a completed no-obligation outcome
-- cannot acquire a later preview for that assessment, even in another transaction.
CREATE FUNCTION public.require_ingestion_reassessment_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='IngestionProjectReassessment' THEN
    IF NOT public.valid_ingestion_project_reassessment(NEW.id) THEN RAISE EXCEPTION 'Incomplete reassessment lineage'; END IF;
  ELSIF EXISTS (SELECT 1 FROM public."IngestionProjectReassessment" w
    WHERE w."customerId"=NEW."customerId" AND w."projectId"=NEW."projectId" AND w."assessmentId"=NEW."assessmentId"
      AND w.state='COMPLETED' AND w."previewId" IS NULL) THEN
    RAISE EXCEPTION 'Completed reassessment has no obligation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "IngestionReassessment_complete" AFTER INSERT OR UPDATE ON public."IngestionProjectReassessment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_reassessment_complete();
CREATE CONSTRAINT TRIGGER "IngestionReassessment_preview_complete" AFTER INSERT ON public."ProjectUpdatePreview"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_reassessment_complete();
REVOKE ALL ON public."IngestionProjectReassessment" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid),public.guard_ingestion_project_reassessment(),public.require_ingestion_reassessment_complete(),public.lock_ingestion_reassessment_preview(),public.reject_ingestion_reassessment_history() FROM PUBLIC;
-- The configuration trigger calls this pure validator as its API invoker.
-- Migration 10 revoked its PUBLIC execution; retain that private boundary.
REVOKE ALL ON FUNCTION public.valid_ingestion_mapping(jsonb) FROM PUBLIC;
-- Prisma bootstrap may precede role creation. Each role is independent; later
-- controlled bootstrap/restore rebuilds these same finite ACLs.
DO $reassessment_grants$
BEGIN
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public."IngestionProjectReassessment" FROM pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT ON public."IngestionProjectReassessment" TO pdaa_api';
    EXECUTE 'GRANT UPDATE (state,"attemptCount","totalAttempts","recoveryRevision","availableAt","lastReason","claimedGeneration","assessmentId","obligationId","previewId","completedAt","auditEventId") ON public."IngestionProjectReassessment" TO pdaa_api';
    EXECUTE 'REVOKE ALL ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid),public.guard_ingestion_project_reassessment(),public.require_ingestion_reassessment_complete(),public.lock_ingestion_reassessment_preview(),public.reject_ingestion_reassessment_history(),public.valid_ingestion_mapping(jsonb) FROM pdaa_api';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid),public.valid_ingestion_mapping(jsonb) TO pdaa_api';
  END IF;
  IF to_regrole('pdaa_worker') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public."IngestionProjectReassessment" FROM pdaa_worker';
    EXECUTE 'REVOKE ALL ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid),public.guard_ingestion_project_reassessment(),public.require_ingestion_reassessment_complete(),public.lock_ingestion_reassessment_preview(),public.reject_ingestion_reassessment_history(),public.valid_ingestion_mapping(jsonb) FROM pdaa_worker';
  END IF;
  IF to_regrole('pdaa_backup') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public."IngestionProjectReassessment" FROM pdaa_backup';
    EXECUTE 'GRANT SELECT ON public."IngestionProjectReassessment" TO pdaa_backup';
    EXECUTE 'REVOKE ALL ON FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment"),public.valid_ingestion_project_reassessment(uuid),public.guard_ingestion_project_reassessment(),public.require_ingestion_reassessment_complete(),public.lock_ingestion_reassessment_preview(),public.reject_ingestion_reassessment_history(),public.valid_ingestion_mapping(jsonb) FROM pdaa_backup';
  END IF;
END;
$reassessment_grants$;
DO $reassessment_owner$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER TABLE public."IngestionProjectReassessment" OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_ingestion_reassessment_row(public."IngestionProjectReassessment") OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_ingestion_project_reassessment(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.guard_ingestion_project_reassessment() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_ingestion_reassessment_complete() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.lock_ingestion_reassessment_preview() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.reject_ingestion_reassessment_history() OWNER TO pdaa_migrate;
  END IF;
END;
$reassessment_owner$;

-- Historical receipts retain exact grant identity; mutable current grants are checked at birth and use.
CREATE OR REPLACE FUNCTION public.valid_ingestion_receipt(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; actual_count integer; min_ordinal integer; max_ordinal integer; expected_event text; parent_id uuid;
BEGIN
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_count,min_ordinal,max_ordinal FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_count<>r."outcomeCount" OR (actual_count>0 AND (min_ordinal<>1 OR max_ordinal<>actual_count)) THEN RETURN false; END IF;
  IF r."executionMode"='HUMAN' THEN
    IF r."syncJobId" IS NOT NULL OR (SELECT count(*) FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" s WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) OR EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id) THEN RETURN false; END IF;
  ELSIF r."executionMode"='CONNECTOR_SYNC' THEN
    IF r."syncJobId" IS NULL OR (SELECT count(*) FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" s JOIN public."ConnectorSyncGrant" g ON g.id=s."syncGrantId" AND g."customerId"=s."customerId" AND g."sourceId"=s."sourceId" AND g."projectId"=s."projectId" WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) OR EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id) OR NOT EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j.id=r."syncJobId" AND j."customerId"=r."customerId" AND j."sourceId"=r."sourceId" AND j."configRevision"=r."configRevision" AND j."mappingRevision"=r."mappingRevision" AND j.state IN ('READY','COMPLETED')) THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  expected_event:=CASE r.kind WHEN 'CONNECTOR_PAGE' THEN 'ingestion.connector_page.persisted' WHEN 'CONNECTOR_EVENT' THEN 'ingestion.connector_event.persisted' WHEN 'CSV_PREVIEW' THEN 'ingestion.csv_preview.persisted' WHEN 'CSV_REVIEWED_IMPORT' THEN 'ingestion.csv_reviewed_import.persisted' WHEN 'SYNC_RESET' THEN 'ingestion.sync_reset' END;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=r."customerId" AND a.actor=r.subject AND a.event=expected_event AND a."occurredAt"=r."createdAt" AND a.detail=jsonb_build_object('receiptId',r.id,'kind',r.kind,'sourceId',r."sourceId",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",'scopeProjectIds',(SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id) || (SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionSyncReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id),'requestHash',r."requestHash",'outcomeCount',r."outcomeCount")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND ((o.state='ACCEPTED' AND (o."recordKey" IS NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e.id=o."recordId" AND e."customerId"=o."customerId" AND e."sourceId"=o."sourceId" AND e."projectId"=o."projectId" AND e."recordKey"=o."recordKey") OR NOT EXISTS (SELECT 1 FROM public."IngestionSourceRevision" v WHERE v.id=o."sourceRevisionId" AND v."customerId"=o."customerId" AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" p WHERE p.id=o."projectionId" AND p."customerId"=o."customerId" AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalContent" c WHERE c."customerId"=o."customerId" AND c."sourceId"=o."sourceId" AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId") OR o."projectId" IS NULL)) OR (o.state<>'ACCEPTED' AND (o."projectionId" IS NOT NULL OR cardinality(o."errorCodes")=0)))) THEN RETURN false; END IF;
  IF r.kind='SYNC_RESET' AND (r."outcomeCount"<>0 OR r."generationAfter"<>r."generationBefore"+1 OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind='CONNECTOR_PAGE' AND (r."generationAfter"<>r."generationBefore" OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind IN ('CONNECTOR_PAGE','SYNC_RESET') AND NOT EXISTS (SELECT 1 FROM public."IngestionCursorTransition" t WHERE t."customerId"=r."customerId" AND t."sourceId"=r."sourceId" AND t."receiptId"=r.id AND t."generationBefore"=r."generationBefore" AND t."generationAfter"=r."generationAfter" AND t."cursorRevisionBefore"=r."cursorRevisionBefore" AND t."cursorRevisionAfter"=r."cursorRevisionAfter" AND ((r.kind='SYNC_RESET' AND t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NULL) OR (r.kind='CONNECTOR_PAGE' AND ((t."stateAfter"='TERMINAL' AND t."cursorEnvelopeHash" IS NULL) OR (t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NOT NULL))))) THEN RETURN false; END IF;
  IF r.kind='CSV_REVIEWED_IMPORT' THEN
    SELECT "previewReceiptId" INTO parent_id FROM public."IngestionReviewedImport" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "receiptId"=r.id;
    IF r."outcomeCount" NOT BETWEEN 1 AND 1000 OR parent_id IS NULL
      OR (SELECT count(*) FROM public."IngestionReviewedImportRow" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "receiptId"=r.id)<>r."outcomeCount"
      OR NOT EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" p WHERE p.id=parent_id AND p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p.kind='CSV_PREVIEW' AND p."executionMode"='HUMAN' AND p."syncJobId" IS NULL AND p."configRevision"=r."configRevision" AND p."mappingRevision"=r."mappingRevision" AND public.valid_ingestion_receipt(p.id) IS TRUE)
      OR EXISTS (
        SELECT 1 FROM public."IngestionReviewedImportRow" link
        JOIN public."IngestionRowOutcome" child ON child."customerId"=link."customerId" AND child."sourceId"=link."sourceId" AND child."receiptId"=link."receiptId" AND child.ordinal=link.ordinal
        JOIN public."IngestionRowOutcome" parent ON parent."customerId"=link."customerId" AND parent."sourceId"=link."sourceId" AND parent."receiptId"=link."previewReceiptId" AND parent.ordinal=link."previewOrdinal"
        WHERE link."customerId"=r."customerId" AND link."sourceId"=r."sourceId" AND link."receiptId"=r.id
          AND (child.state<>'ACCEPTED' OR child.operation NOT IN ('CREATE','UPDATE','UNCHANGED') OR cardinality(child."errorCodes")<>0
            OR ROW(child."projectId",child."recordKey",child."recordId",child."sourceRevisionId",child."projectionId",child.operation) IS DISTINCT FROM ROW(parent."projectId",parent."recordKey",parent."recordId",parent."sourceRevisionId",parent."projectionId",parent.operation))
      ) THEN RETURN false; END IF;
  ELSIF EXISTS (SELECT 1 FROM public."IngestionReviewedImport" WHERE "receiptId"=r.id)
    OR EXISTS (SELECT 1 FROM public."IngestionReviewedImportRow" WHERE "receiptId"=r.id) THEN RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- Immutable children remain INSERT/SELECT only; Project and PMO locks authorize sealing.
CREATE OR REPLACE FUNCTION public.guard_ingestion_configuration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE project_row record; grant_row public."AccessGrant"%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Ingestion configuration must start unsealed'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') THEN
    RAISE EXCEPTION 'Invalid ingestion configuration seal';
  END IF;
  IF public.valid_ingestion_mapping(NEW.mapping) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid ingestion mapping configuration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW.revision)
    THEN RAISE EXCEPTION 'Ingestion configuration scope is empty'; END IF;
  IF (SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW.revision)>100 THEN RAISE EXCEPTION 'Ingestion configuration project limit exceeded'; END IF;
  FOR project_row IN
    SELECT p."projectId",pr."portfolioId" FROM public."IngestionConfigurationProject" p
    JOIN public."Project" pr ON pr."customerId"=p."customerId" AND pr.id=p."projectId"
    WHERE p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p."configRevision"=NEW.revision
    ORDER BY p."projectId" FOR UPDATE OF pr
  LOOP
    SELECT * INTO grant_row FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=NEW."changedBy" AND g.role='pmo_admin'
      AND ((g."scopeType"='project' AND g."scopeId"=project_row."projectId") OR (g."scopeType"='portfolio' AND g."scopeId"=project_row."portfolioId"))
    ORDER BY (g."scopeType"='project') DESC,g.id LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion configuration requires current PMO project grants'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
