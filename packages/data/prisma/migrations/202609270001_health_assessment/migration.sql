CREATE TABLE public."HealthAssessmentRetentionPolicy" (
  "customerId" uuid PRIMARY KEY REFERENCES public."Customer"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "contentRetentionHours" integer NOT NULL CHECK ("contentRetentionHours" BETWEEN 1 AND 87600),
  "auditRetentionHours" integer NOT NULL CHECK ("auditRetentionHours" BETWEEN 1 AND 87600),
  "idempotencyRetentionHours" integer NOT NULL CHECK ("idempotencyRetentionHours" BETWEEN 1 AND 87600),
  revision integer NOT NULL CHECK (revision >= 1),
  "changedBy" varchar(256) NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  "changedAt" timestamptz(3) NOT NULL,
  CONSTRAINT "HealthAssessmentRetentionPolicy_order_check"
    CHECK ("auditRetentionHours" >= "contentRetentionHours"
      AND "idempotencyRetentionHours" >= "auditRetentionHours"),
  CONSTRAINT "HealthAssessmentRetentionPolicy_audit_fk"
    FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public."HealthAssessment" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "actorSubject" varchar(256) NOT NULL,
  "assessedAt" timestamptz(3) NOT NULL,
  "commandKeyHash" char(64) NOT NULL CHECK ("commandKeyHash" ~ '^[0-9a-f]{64}$'),
  "ruleRevision" varchar(64) NOT NULL CHECK ("ruleRevision" = 'schedule-health@1'),
  input jsonb,
  result jsonb,
  "envelopeHash" char(64) NOT NULL CHECK ("envelopeHash" ~ '^[0-9a-f]{64}$'),
  "contentExpiresAt" timestamptz(3) NOT NULL,
  "auditExpiresAt" timestamptz(3) NOT NULL,
  "redactedAt" timestamptz(3),
  CONSTRAINT "HealthAssessment_content_expiry_check" CHECK ("contentExpiresAt" > "assessedAt"),
  CONSTRAINT "HealthAssessment_audit_expiry_check" CHECK ("auditExpiresAt" >= "contentExpiresAt"),
  CONSTRAINT "HealthAssessment_redaction_check" CHECK (
    ("redactedAt" IS NULL AND input IS NOT NULL AND result IS NOT NULL)
    OR ("redactedAt" IS NOT NULL AND input IS NULL AND result IS NULL)
  ),
  CONSTRAINT "HealthAssessment_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "HealthAssessment_command_key" UNIQUE ("customerId","projectId","commandKeyHash"),
  CONSTRAINT "HealthAssessment_project_fk"
    FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "HealthAssessment_latest_idx"
  ON public."HealthAssessment" ("customerId","projectId","assessedAt" DESC,id DESC);
CREATE INDEX "HealthAssessment_content_expiry_idx"
  ON public."HealthAssessment" ("contentExpiresAt") WHERE "redactedAt" IS NULL;
CREATE INDEX "HealthAssessment_audit_expiry_idx"
  ON public."HealthAssessment" ("auditExpiresAt");

CREATE TABLE public."HealthAssessmentCommandReceipt" (
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "commandKeyHash" char(64) NOT NULL CHECK ("commandKeyHash" ~ '^[0-9a-f]{64}$'),
  "actorSubject" varchar(256) NOT NULL,
  "requestHash" char(64) NOT NULL CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  "assessmentId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL,
  "expiresAt" timestamptz(3) NOT NULL,
  CONSTRAINT "HealthAssessmentCommandReceipt_pkey"
    PRIMARY KEY ("customerId","projectId","commandKeyHash"),
  CONSTRAINT "HealthAssessmentCommandReceipt_expiry_check" CHECK ("expiresAt" >= "createdAt"),
  CONSTRAINT "HealthAssessmentCommandReceipt_project_fk"
    FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "HealthAssessmentCommandReceipt_expiry_idx"
  ON public."HealthAssessmentCommandReceipt" ("expiresAt");

CREATE OR REPLACE FUNCTION public.guard_health_assessment_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF session_user <> 'pdaa_worker' OR current_user = session_user THEN
    RAISE EXCEPTION 'Health assessment history is append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_health_assessment_mutation() FROM PUBLIC;

CREATE TRIGGER "HealthAssessment_immutable"
  BEFORE UPDATE OR DELETE ON public."HealthAssessment"
  FOR EACH ROW EXECUTE FUNCTION public.guard_health_assessment_mutation();
CREATE TRIGGER "HealthAssessmentCommandReceipt_immutable"
  BEFORE DELETE ON public."HealthAssessmentCommandReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.guard_health_assessment_mutation();

-- Keep the existing append-only audit trigger, with one narrow expiry path.
CREATE OR REPLACE FUNCTION public.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF session_user = 'pdaa_worker'
      AND current_user <> session_user
      AND OLD.event IN ('health.assessment.created','health.assessment.redacted')
      AND OLD.detail ? 'healthAssessmentId'
    THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Audit records are immutable';
END $$;
CREATE FUNCTION public.purge_expired_health_assessments()
RETURNS TABLE(redacted_count integer, purged_assessment_count integer, purged_receipt_count integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  cutoff timestamptz := clock_timestamp();
  item record;
  redacted integer := 0;
  purged_assessments integer := 0;
  purged_receipts integer := 0;
BEGIN
  IF session_user <> 'pdaa_worker' THEN
    RAISE EXCEPTION 'Health retention worker role required';
  END IF;

  FOR item IN
    SELECT a.id,a."customerId",a."projectId"
    FROM public."HealthAssessment" a
    LEFT JOIN public."HealthAssessmentRetentionPolicy" p ON p."customerId"=a."customerId"
    WHERE a."redactedAt" IS NULL
      AND CASE WHEN p."customerId" IS NULL THEN a."contentExpiresAt"
        ELSE LEAST(a."contentExpiresAt",a."assessedAt"+make_interval(hours=>p."contentRetentionHours")) END <= cutoff
    ORDER BY a."contentExpiresAt",a.id
    LIMIT 500
    FOR UPDATE OF a SKIP LOCKED
  LOOP
    UPDATE public."HealthAssessment" SET input=NULL,result=NULL,"redactedAt"=cutoff
      WHERE id=item.id AND "customerId"=item."customerId";
    INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
    VALUES (gen_random_uuid(),item."customerId",'health_assessment_retention_worker',
      'health.assessment.redacted','health-assessment-retention',jsonb_build_object(
      'healthAssessmentId',item.id::text,'projectId',item."projectId"::text,'redactedAt',cutoff),cutoff);
    redacted := redacted + 1;
  END LOOP;

  FOR item IN
    SELECT a.id,a."customerId" FROM public."HealthAssessment" a
    LEFT JOIN public."HealthAssessmentRetentionPolicy" p ON p."customerId"=a."customerId"
    WHERE CASE WHEN p."customerId" IS NULL THEN a."auditExpiresAt"
      ELSE LEAST(a."auditExpiresAt",a."assessedAt"+make_interval(hours=>p."auditRetentionHours")) END <= cutoff
    ORDER BY a."auditExpiresAt",a.id
    LIMIT 500
    FOR UPDATE OF a SKIP LOCKED
  LOOP
    DELETE FROM public."AuditEvent" e
      WHERE e."customerId"=item."customerId"
        AND e.event IN ('health.assessment.created','health.assessment.redacted')
        AND e.detail->>'healthAssessmentId'=item.id::text;
    DELETE FROM public."HealthAssessment" WHERE id=item.id AND "customerId"=item."customerId";
    purged_assessments := purged_assessments + 1;
  END LOOP;

  WITH expired AS (
    SELECT r."customerId",r."projectId",r."commandKeyHash"
    FROM public."HealthAssessmentCommandReceipt" r
    LEFT JOIN public."HealthAssessmentRetentionPolicy" p ON p."customerId"=r."customerId"
    WHERE CASE WHEN p."customerId" IS NULL THEN r."expiresAt"
      ELSE LEAST(r."expiresAt",r."createdAt"+make_interval(hours=>p."idempotencyRetentionHours")) END <= cutoff
    ORDER BY r."expiresAt",r."commandKeyHash"
    LIMIT 1000
    FOR UPDATE OF r SKIP LOCKED
  )
  DELETE FROM public."HealthAssessmentCommandReceipt" r USING expired e
    WHERE r."customerId"=e."customerId" AND r."projectId"=e."projectId"
      AND r."commandKeyHash"=e."commandKeyHash";
  GET DIAGNOSTICS purged_receipts = ROW_COUNT;

  RETURN QUERY SELECT redacted,purged_assessments,purged_receipts;
END $$;
REVOKE ALL ON FUNCTION public.purge_expired_health_assessments() FROM PUBLIC,pdaa_api;
GRANT EXECUTE ON FUNCTION public.purge_expired_health_assessments() TO pdaa_worker;

REVOKE ALL ON TABLE public."HealthAssessment" FROM PUBLIC,pdaa_worker,pdaa_api;
REVOKE ALL ON TABLE public."HealthAssessmentCommandReceipt" FROM PUBLIC,pdaa_worker,pdaa_api;
REVOKE ALL ON TABLE public."HealthAssessmentRetentionPolicy" FROM PUBLIC,pdaa_worker,pdaa_api;
GRANT SELECT,INSERT ON TABLE public."HealthAssessment" TO pdaa_api;
GRANT SELECT,INSERT ON TABLE public."HealthAssessmentCommandReceipt" TO pdaa_api;
GRANT SELECT,INSERT,UPDATE ON TABLE public."HealthAssessmentRetentionPolicy" TO pdaa_api;
