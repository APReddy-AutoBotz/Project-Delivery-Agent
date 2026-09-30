-- EXEC-015 Stage 2b; FR-UPD-007/010, FR-ESC-006, NFR-SEC-001, NFR-REL-002.
-- Existing activation, stages and receipts retain their immutable lineage.
ALTER TABLE public."ProjectUpdateEngagement"
  ADD COLUMN "sourceSatisfiedFactTypes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN "sourceAssessmentId" uuid,
  ADD COLUMN "sourceAssessedAt" timestamptz(3),
  ADD CONSTRAINT "ProjectUpdateEngagement_source_assessment_fk"
    FOREIGN KEY ("customerId","projectId","sourceAssessmentId")
    REFERENCES public."ProjectUpdateAssessment" ("customerId","projectId",id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE OR REPLACE FUNCTION public.guard_update_engagement_storage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND (
    cardinality(NEW."sourceSatisfiedFactTypes")>100
    OR (cardinality(NEW."sourceSatisfiedFactTypes")>0 AND (
      array_ndims(NEW."sourceSatisfiedFactTypes")<>1 OR array_lower(NEW."sourceSatisfiedFactTypes",1)<>1))
    OR cardinality(NEW."sourceSatisfiedFactTypes")<>(SELECT count(DISTINCT f) FROM unnest(NEW."sourceSatisfiedFactTypes") f)
    OR EXISTS (SELECT 1 FROM unnest(NEW."sourceSatisfiedFactTypes") f WHERE f IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdateObligation" o,
        LATERAL jsonb_array_elements(o."requiredFacts") r
      WHERE o."customerId"=NEW."customerId" AND o."projectId"=NEW."projectId"
        AND o.id=NEW."obligationId" AND r->>'factType'=f))
    OR (NEW."sourceAssessmentId" IS NULL AND (
      cardinality(NEW."sourceSatisfiedFactTypes")<>0 OR NEW."sourceAssessedAt" IS NOT NULL))
    OR (NEW."sourceAssessmentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdateAssessment" a
      WHERE a."customerId"=NEW."customerId" AND a."projectId"=NEW."projectId"
        AND a.id=NEW."sourceAssessmentId" AND a."policyRevisionId"=NEW."policyRevisionId"
        AND a."policyRevision"=NEW."policyRevision" AND a."assessedAt"=NEW."sourceAssessedAt"
        AND NEW."sourceSatisfiedFactTypes"=COALESCE((
          SELECT array_agg(f->>'factType' ORDER BY f->>'factType')
          FROM jsonb_array_elements(a.result->'engagementFacts') f WHERE f->>'state'='SATISFIED'
        ),ARRAY[]::text[])
    ))
  ) THEN RAISE EXCEPTION 'Invalid engagement source satisfaction' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.generation<>1 OR NEW.state<>'ACTIVE' OR NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdateObligation" o JOIN public."ProjectUpdatePolicy" p
        ON p."customerId"=o."customerId" AND p."projectId"=o."projectId"
      WHERE o."customerId"=NEW."customerId" AND o."projectId"=NEW."projectId" AND o.id=NEW."obligationId"
        AND o.state='OPEN' AND o."responsibleSubject"=NEW."ownerSubject" AND p.revision=NEW."policyRevision"
    ) THEN
      RAISE EXCEPTION 'Invalid engagement storage activation' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Engagement storage history cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-'ownerSubject'-'generation'-'state'-'auditEventId'-'changedAt'-'sourceSatisfiedFactTypes'-'sourceAssessmentId'-'sourceAssessedAt')
      IS DISTINCT FROM (to_jsonb(OLD)-'ownerSubject'-'generation'-'state'-'auditEventId'-'changedAt'-'sourceSatisfiedFactTypes'-'sourceAssessmentId'-'sourceAssessedAt')
    OR OLD.state='CLOSED' OR NEW."auditEventId"=OLD."auditEventId"
    OR NEW."changedAt"<OLD."changedAt"
    OR (NEW."ownerSubject"<>OLD."ownerSubject" AND NEW.generation<>OLD.generation+1)
    OR NEW.generation NOT IN (OLD.generation,OLD.generation+1) THEN
    RAISE EXCEPTION 'Invalid engagement storage transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

-- Future intents can be cancelled atomically without making them due or
-- claiming a fictitious lease. The automatic append-only receipt still applies.
CREATE OR REPLACE FUNCTION public.guard_update_outbox()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE stage public."ProjectUpdateStage"%ROWTYPE; valid boolean := false; current_time_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Engagement outbox history cannot be deleted' USING ERRCODE='55000';
  END IF;
  SELECT * INTO stage FROM public."ProjectUpdateStage"
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."stageId" FOR SHARE;
  IF stage.id IS NULL OR NEW."availableAt"<stage."scheduledAt" THEN
    RAISE EXCEPTION 'Invalid engagement outbox identity' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'READY' OR NEW."claimGeneration"<>0 OR NEW.reason IS NOT NULL THEN
      RAISE EXCEPTION 'Engagement outbox must begin ready' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'state'-'claimGeneration'-'availableAt'-'leaseUntil'-'handoffAt'-'completedAt'-'reason'-'auditEventId')
      IS DISTINCT FROM (to_jsonb(OLD)-'state'-'claimGeneration'-'availableAt'-'leaseUntil'-'handoffAt'-'completedAt'-'reason'-'auditEventId')
    OR NEW."auditEventId"=OLD."auditEventId"
    OR (OLD."handoffAt" IS NOT NULL AND NEW."handoffAt" IS DISTINCT FROM OLD."handoffAt") THEN
    RAISE EXCEPTION 'Invalid engagement outbox rewrite' USING ERRCODE='55000';
  END IF;
  IF OLD.state='READY' AND NEW.state='CLAIMED' THEN
    valid := NEW."claimGeneration"=OLD."claimGeneration"+1 AND NEW."availableAt"=OLD."availableAt"
      AND NEW."availableAt"<=current_time_at AND NEW."leaseUntil">current_time_at
      AND NEW."leaseUntil"<=current_time_at+interval '5 minutes' AND NEW.reason IS NULL;
  ELSIF OLD.state='READY' AND NEW.state='SUPPRESSED' THEN
    valid := NEW."claimGeneration"=OLD."claimGeneration" AND NEW."availableAt"=OLD."availableAt"
      AND NEW."leaseUntil" IS NULL AND NEW."handoffAt" IS NULL AND NEW."completedAt" IS NOT NULL
      AND NEW.reason IN ('OBLIGATION_ENDED','REQUIRED_FACTS_SATISFIED','POLICY_CHANGED',
        'OWNER_CHANGED','RECIPIENT_ZONE_CHANGED','RECIPIENT_REVOKED','SOURCE_REASSESSMENT_REQUIRED');
  ELSIF OLD.state='CLAIMED' AND NEW.state='READY' THEN
    valid := NEW."claimGeneration"=OLD."claimGeneration" AND (
      (NEW.reason='LEASE_EXPIRED' AND OLD."leaseUntil"<=current_time_at AND NEW."availableAt"=OLD."availableAt")
      OR (NEW.reason IN ('QUIET_HOURS','WEEKEND','DST_GAP','SOURCE_REASSESSMENT_REQUIRED',
        'SOURCE_UNKNOWN','RECIPIENT_REVOKED','ENGAGEMENT_PAUSED','EMAIL_GATE_CLOSED','CALENDAR_RECHECK_REQUIRED')
        AND NEW."availableAt">OLD."availableAt" AND NEW."availableAt">current_time_at)
    );
  ELSIF OLD.state='CLAIMED' AND NEW.state='HANDED_OFF' THEN
    valid := stage.mode='EMAIL' AND NEW."claimGeneration"=OLD."claimGeneration"
      AND NEW."availableAt"=OLD."availableAt" AND NEW."leaseUntil"=OLD."leaseUntil"
      AND OLD."leaseUntil">current_time_at AND NEW."handoffAt" IS NOT NULL
      AND NEW."handoffAt"<=current_time_at AND NEW."handoffAt">=NEW."createdAt" AND NEW.reason IS NULL;
  ELSIF OLD.state='CLAIMED' AND NEW.state IN ('CAPTURED','SUPPRESSED') THEN
    valid := NEW."claimGeneration"=OLD."claimGeneration" AND NEW."availableAt"=OLD."availableAt"
      AND OLD."leaseUntil">current_time_at AND (
        (NEW.state='CAPTURED' AND stage.mode='CAPTURE' AND NEW.reason IS NULL)
        OR (NEW.state='SUPPRESSED' AND NEW.reason IS NOT NULL)
      );
  ELSIF OLD.state='HANDED_OFF' AND NEW.state IN ('SENT','UNKNOWN') THEN
    valid := NEW."claimGeneration"=OLD."claimGeneration" AND NEW."availableAt"=OLD."availableAt"
      AND ((NEW.state='UNKNOWN' AND NEW.reason='HANDOFF_UNCERTAIN') OR (NEW.state='SENT' AND NEW.reason IS NULL));
  END IF;
  IF valid IS NOT TRUE OR (NEW."completedAt" IS NOT NULL AND (
    NEW."completedAt">current_time_at OR NEW."completedAt"<NEW."createdAt"
    OR (NEW."handoffAt" IS NOT NULL AND NEW."completedAt"<NEW."handoffAt")
  )) THEN
    RAISE EXCEPTION 'Invalid engagement outbox transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DO $engagement_processing_grants$
BEGIN
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    GRANT SELECT,INSERT ON "ProjectUpdateEngagement","ProjectUpdateStage","ProjectUpdateOutbox","ProjectUpdateDispatchAttempt" TO pdaa_api;
    GRANT UPDATE ("ownerSubject",generation,state,"auditEventId","changedAt","sourceSatisfiedFactTypes","sourceAssessmentId","sourceAssessedAt") ON "ProjectUpdateEngagement" TO pdaa_api;
    GRANT UPDATE (state,"claimGeneration","availableAt","leaseUntil","handoffAt","completedAt",reason,"auditEventId") ON "ProjectUpdateOutbox" TO pdaa_api;
  END IF;
END $engagement_processing_grants$;
