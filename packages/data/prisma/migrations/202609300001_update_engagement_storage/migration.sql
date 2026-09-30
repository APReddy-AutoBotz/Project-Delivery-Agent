-- EXEC-015 Stage 2a; FR-ESC-006, NFR-REL-002, TR-DATA-001.
-- Storage only. No activation/backfill, dispatcher, address or network capability.
ALTER TABLE public."ProjectUpdateObligation"
  ADD CONSTRAINT "ProjectUpdateObligation_lineage_key"
  UNIQUE ("customerId","projectId",id,"policyRevisionId","policyRevision","assessmentId");

CREATE TABLE public."ProjectUpdateEngagement" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "obligationId" uuid NOT NULL,
  "policyRevisionId" uuid NOT NULL,
  "policyRevision" integer NOT NULL,
  "assessmentId" uuid NOT NULL,
  "ownerSubject" varchar(256) NOT NULL CHECK (char_length("ownerSubject") BETWEEN 1 AND 200
    AND "ownerSubject" !~ '[[:cntrl:]]|^[[:space:]]|[[:space:]]$'),
  generation integer NOT NULL DEFAULT 1 CHECK (generation BETWEEN 1 AND 2147483647),
  state varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','PAUSED','CLOSED')),
  "auditEventId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectUpdateEngagement_obligation_key" UNIQUE ("customerId","projectId","obligationId"),
  CONSTRAINT "ProjectUpdateEngagement_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateEngagement_lineage_key"
    UNIQUE ("customerId","projectId",id,"obligationId","policyRevisionId","policyRevision","assessmentId"),
  CONSTRAINT "ProjectUpdateEngagement_obligation_fk"
    FOREIGN KEY ("customerId","projectId","obligationId","policyRevisionId","policyRevision","assessmentId")
    REFERENCES public."ProjectUpdateObligation" ("customerId","projectId",id,"policyRevisionId","policyRevision","assessmentId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateEngagement_audit_fk" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("changedAt" >= "createdAt")
);

CREATE TABLE public."ProjectUpdateStage" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "engagementId" uuid NOT NULL,
  "obligationId" uuid NOT NULL,
  "policyRevisionId" uuid NOT NULL,
  "policyRevision" integer NOT NULL,
  "assessmentId" uuid NOT NULL,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  kind varchar(16) NOT NULL CHECK (kind IN ('REQUEST','REMINDER','ESCALATION')),
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 0 AND 90),
  "recipientSubject" varchar(256) NOT NULL CHECK (char_length("recipientSubject") BETWEEN 1 AND 200
    AND "recipientSubject" !~ '[[:cntrl:]]|^[[:space:]]|[[:space:]]$'),
  "recipientRole" varchar(16) NOT NULL CHECK ("recipientRole" IN ('OWNER','PROJECT_MANAGER')),
  "factTypes" text[] NOT NULL,
  "timeZone" varchar(64) NOT NULL CHECK (char_length("timeZone") BETWEEN 1 AND 64),
  "zoneSource" varchar(16) NOT NULL CHECK ("zoneSource" IN ('RECIPIENT','PROJECT','CUSTOMER')),
  "logicalDueAt" timestamptz(3) NOT NULL,
  "candidateAt" timestamptz(3) NOT NULL,
  "scheduledAt" timestamptz(3) NOT NULL,
  "localAt" varchar(19) NOT NULL CHECK ("localAt" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'),
  "utcOffset" varchar(6) NOT NULL CHECK ("utcOffset" ~ '^[+-][0-9]{2}:[0-9]{2}$'),
  "deferralReasons" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "ruleRevision" varchar(64) NOT NULL CHECK ("ruleRevision"='engagement-schedule@1'),
  mode varchar(16) NOT NULL DEFAULT 'SHADOW' CHECK (mode IN ('SHADOW','CAPTURE','EMAIL')),
  "replacesStageId" uuid,
  "auditEventId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectUpdateStage_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateStage_intent_key"
    UNIQUE ("customerId","projectId","engagementId",generation,kind,ordinal,"recipientSubject"),
  CONSTRAINT "ProjectUpdateStage_engagement_fk"
    FOREIGN KEY ("customerId","projectId","engagementId","obligationId","policyRevisionId","policyRevision","assessmentId")
    REFERENCES public."ProjectUpdateEngagement" ("customerId","projectId",id,"obligationId","policyRevisionId","policyRevision","assessmentId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateStage_replaces_fk" FOREIGN KEY ("customerId","projectId","replacesStageId")
    REFERENCES public."ProjectUpdateStage" ("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateStage_audit_fk" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("scheduledAt" >= "candidateAt" AND "candidateAt">="logicalDueAt"),
  CHECK ((kind='REQUEST' AND ordinal=0 AND "recipientRole"='OWNER')
    OR (kind='REMINDER' AND ordinal>0 AND "recipientRole"='OWNER')
    OR (kind='ESCALATION' AND ordinal>0))
);

CREATE TABLE public."ProjectUpdateOutbox" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "stageId" uuid NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'READY'
    CHECK (state IN ('READY','CLAIMED','HANDED_OFF','CAPTURED','SUPPRESSED','SENT','UNKNOWN')),
  "claimGeneration" integer NOT NULL DEFAULT 0 CHECK ("claimGeneration" BETWEEN 0 AND 2147483647),
  "availableAt" timestamptz(3) NOT NULL,
  "leaseUntil" timestamptz(3),
  "handoffAt" timestamptz(3),
  "completedAt" timestamptz(3),
  reason varchar(64) CHECK (reason IN ('LEASE_EXPIRED','QUIET_HOURS','WEEKEND','DST_GAP',
    'OBLIGATION_ENDED','REQUIRED_FACTS_SATISFIED','SHADOW_MODE','POLICY_CHANGED','OWNER_CHANGED',
    'RECIPIENT_ZONE_CHANGED','RECIPIENT_REVOKED','SOURCE_REASSESSMENT_REQUIRED',
    'SOURCE_UNKNOWN','CALENDAR_RECHECK_REQUIRED','ENGAGEMENT_PAUSED','EMAIL_GATE_CLOSED',
    'HANDOFF_UNCERTAIN')),
  "auditEventId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectUpdateOutbox_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateOutbox_stage_key" UNIQUE ("customerId","projectId","stageId"),
  CONSTRAINT "ProjectUpdateOutbox_stage_fk" FOREIGN KEY ("customerId","projectId","stageId")
    REFERENCES public."ProjectUpdateStage" ("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateOutbox_audit_fk" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (
    (state='READY' AND "leaseUntil" IS NULL AND "handoffAt" IS NULL AND "completedAt" IS NULL)
    OR (state='CLAIMED' AND "leaseUntil" IS NOT NULL AND "handoffAt" IS NULL AND "completedAt" IS NULL)
    OR (state='HANDED_OFF' AND "leaseUntil" IS NOT NULL AND "handoffAt" IS NOT NULL AND "completedAt" IS NULL)
    OR (state IN ('CAPTURED','SUPPRESSED') AND "leaseUntil" IS NULL AND "handoffAt" IS NULL AND "completedAt" IS NOT NULL)
    OR (state IN ('SENT','UNKNOWN') AND "leaseUntil" IS NULL AND "handoffAt" IS NOT NULL AND "completedAt" IS NOT NULL)
  )
);
CREATE INDEX "ProjectUpdateOutbox_due_idx" ON public."ProjectUpdateOutbox" ("availableAt",id) WHERE state='READY';
CREATE INDEX "ProjectUpdateOutbox_lease_idx" ON public."ProjectUpdateOutbox" ("leaseUntil",id)
  WHERE state IN ('CLAIMED','HANDED_OFF');

CREATE TABLE public."ProjectUpdateDispatchAttempt" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "outboxId" uuid NOT NULL,
  "claimGeneration" integer NOT NULL CHECK ("claimGeneration" BETWEEN 0 AND 2147483647),
  event varchar(16) NOT NULL CHECK (event IN
    ('ENQUEUED','CLAIMED','RELEASED','HANDED_OFF','CAPTURED','SUPPRESSED','SENT','UNKNOWN')),
  reason varchar(64),
  "availableAt" timestamptz(3) NOT NULL,
  "leaseUntil" timestamptz(3),
  "handoffAt" timestamptz(3),
  "auditEventId" uuid NOT NULL,
  "recordedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectUpdateDispatchAttempt_event_key"
    UNIQUE ("customerId","projectId","outboxId","claimGeneration",event),
  CONSTRAINT "ProjectUpdateDispatchAttempt_outbox_fk" FOREIGN KEY ("customerId","projectId","outboxId")
    REFERENCES public."ProjectUpdateOutbox" ("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateDispatchAttempt_audit_fk" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.guard_update_engagement_storage()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
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
  IF (to_jsonb(NEW)-'ownerSubject'-'generation'-'state'-'auditEventId'-'changedAt')
      IS DISTINCT FROM (to_jsonb(OLD)-'ownerSubject'-'generation'-'state'-'auditEventId'-'changedAt')
    OR OLD.state='CLOSED' OR NEW."auditEventId"=OLD."auditEventId"
    OR NEW."changedAt"<OLD."changedAt"
    OR (NEW."ownerSubject"<>OLD."ownerSubject" AND NEW.generation<>OLD.generation+1)
    OR NEW.generation NOT IN (OLD.generation,OLD.generation+1) THEN
    RAISE EXCEPTION 'Invalid engagement storage transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateEngagement_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ProjectUpdateEngagement"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_engagement_storage();

CREATE FUNCTION public.reject_update_engagement_history()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  RAISE EXCEPTION 'Engagement storage history is immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER "ProjectUpdateStage_immutable" BEFORE UPDATE OR DELETE ON public."ProjectUpdateStage"
  FOR EACH ROW EXECUTE FUNCTION public.reject_update_engagement_history();
CREATE TRIGGER "ProjectUpdateDispatchAttempt_immutable" BEFORE UPDATE OR DELETE ON public."ProjectUpdateDispatchAttempt"
  FOR EACH ROW EXECUTE FUNCTION public.reject_update_engagement_history();

CREATE FUNCTION public.guard_update_stage_snapshot()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE engagement public."ProjectUpdateEngagement"%ROWTYPE; obligation public."ProjectUpdateObligation"%ROWTYPE;
BEGIN
  SELECT * INTO engagement FROM public."ProjectUpdateEngagement"
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."engagementId" FOR SHARE;
  SELECT * INTO obligation FROM public."ProjectUpdateObligation"
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."obligationId" FOR SHARE;
  IF NOT FOUND OR engagement.id IS NULL OR engagement.state<>'ACTIVE'
    OR obligation.state<>'OPEN' OR NEW.generation<>engagement.generation
    OR (NEW."recipientRole"='OWNER' AND NEW."recipientSubject"<>engagement."ownerSubject")
    OR (NEW."recipientRole"='PROJECT_MANAGER' AND NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdatePolicyRevision" p WHERE p.id=NEW."policyRevisionId"
        AND p."customerId"=NEW."customerId" AND p."projectId"=NEW."projectId"
        AND p.revision=NEW."policyRevision" AND p."escalationAfterBusinessDays">0
        AND p."escalationRecipientSubject"=NEW."recipientSubject"
    ))
    OR NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdatePolicyRevision" p WHERE p.id=NEW."policyRevisionId"
        AND p."customerId"=NEW."customerId" AND p."projectId"=NEW."projectId" AND p.revision=NEW."policyRevision"
        AND (NEW.kind='REQUEST'
          OR (NEW.kind='REMINDER' AND NEW.ordinal=ANY(p."reminderBusinessDayOffsets"))
          OR (NEW.kind='ESCALATION' AND p."escalationAfterBusinessDays">0 AND NEW.ordinal=p."escalationAfterBusinessDays"))
    )
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW."timeZone")

    OR NEW."localAt"<>to_char(NEW."scheduledAt" AT TIME ZONE NEW."timeZone",'YYYY-MM-DD"T"HH24:MI:SS')
    OR extract(epoch FROM ((NEW."scheduledAt" AT TIME ZONE NEW."timeZone") -
      (NEW."scheduledAt" AT TIME ZONE 'UTC'))) <>
      (CASE WHEN left(NEW."utcOffset",1)='-' THEN -1 ELSE 1 END) *
      (substring(NEW."utcOffset",2,2)::integer*3600 + substring(NEW."utcOffset",5,2)::integer*60)
    OR (NEW."replacesStageId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdateStage" s WHERE s.id=NEW."replacesStageId"
        AND s."customerId"=NEW."customerId" AND s."projectId"=NEW."projectId"
        AND s."engagementId"=NEW."engagementId" AND s.kind=NEW.kind AND s.ordinal=NEW.ordinal
        AND s."recipientRole"=NEW."recipientRole" AND s.generation<NEW.generation
    ))
    OR cardinality(NEW."factTypes") NOT BETWEEN 1 AND 100
    OR array_ndims(NEW."factTypes")<>1 OR array_lower(NEW."factTypes",1)<>1
    OR EXISTS (SELECT 1 FROM unnest(NEW."factTypes") f WHERE f IS NULL OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(obligation."requiredFacts") r WHERE r->>'factType'=f
    ))
    OR cardinality(NEW."factTypes")<>(SELECT count(DISTINCT f) FROM unnest(NEW."factTypes") f)
    OR cardinality(NEW."deferralReasons")>3
    OR EXISTS (SELECT 1 FROM unnest(NEW."deferralReasons") r WHERE r IS NULL
      OR r NOT IN ('WEEKEND','QUIET_HOURS','DST_GAP'))
    OR cardinality(NEW."deferralReasons")<>(SELECT count(DISTINCT r) FROM unnest(NEW."deferralReasons") r)
    OR (NEW."scheduledAt">NEW."candidateAt" AND cardinality(NEW."deferralReasons")=0)
    OR (NEW."scheduledAt"=NEW."candidateAt" AND EXISTS (
      SELECT 1 FROM unnest(NEW."deferralReasons") r WHERE r<>'DST_GAP'
    )) THEN
    RAISE EXCEPTION 'Invalid engagement stage snapshot' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateStage_snapshot" BEFORE INSERT ON public."ProjectUpdateStage"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_stage_snapshot();

CREATE FUNCTION public.guard_update_outbox()
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
CREATE TRIGGER "ProjectUpdateOutbox_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ProjectUpdateOutbox"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_outbox();

CREATE FUNCTION public.guard_update_attempt_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $
BEGIN
  IF pg_trigger_depth()<>2 OR NOT EXISTS (
    SELECT 1 FROM public."ProjectUpdateOutbox" o WHERE o.id=NEW."outboxId"
      AND o."customerId"=NEW."customerId" AND o."projectId"=NEW."projectId"
      AND o."claimGeneration"=NEW."claimGeneration" AND o."auditEventId"=NEW."auditEventId"
      AND o.reason IS NOT DISTINCT FROM NEW.reason AND o."availableAt"=NEW."availableAt"
      AND o."leaseUntil" IS NOT DISTINCT FROM NEW."leaseUntil" AND o."handoffAt" IS NOT DISTINCT FROM NEW."handoffAt"
      AND NEW.event=CASE WHEN o.state='READY' AND o."claimGeneration"=0 THEN 'ENQUEUED'
        WHEN o.state='READY' THEN 'RELEASED' ELSE o.state END
  ) THEN
    RAISE EXCEPTION 'Engagement attempts require an outbox transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $;
CREATE TRIGGER "ProjectUpdateDispatchAttempt_birth" BEFORE INSERT ON public."ProjectUpdateDispatchAttempt"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_attempt_insert();

-- Stage and intent are committed together; a crash cannot strand a stage.
CREATE FUNCTION public.require_update_stage_outbox()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ProjectUpdateOutbox"
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "stageId"=NEW.id) THEN
    RAISE EXCEPTION 'Engagement stage requires an outbox intent' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ProjectUpdateStage_outbox_complete" AFTER INSERT ON public."ProjectUpdateStage"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_update_stage_outbox();

-- Receipts are generated in the same transaction, not supplied as outcome claims.
CREATE FUNCTION public.record_update_dispatch_attempt()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public."ProjectUpdateDispatchAttempt"
    (id,"customerId","projectId","outboxId","claimGeneration",event,reason,"availableAt","leaseUntil","handoffAt","auditEventId","recordedAt")
  VALUES (gen_random_uuid(),NEW."customerId",NEW."projectId",NEW.id,NEW."claimGeneration",
    CASE WHEN TG_OP='INSERT' THEN 'ENQUEUED' WHEN NEW.state='READY' THEN 'RELEASED' ELSE NEW.state END,
    NEW.reason,NEW."availableAt",NEW."leaseUntil",NEW."handoffAt",NEW."auditEventId",date_trunc('milliseconds',clock_timestamp()));
  RETURN NULL;
END $$;
CREATE TRIGGER "ProjectUpdateOutbox_receipt" AFTER INSERT OR UPDATE ON public."ProjectUpdateOutbox"
  FOR EACH ROW EXECUTE FUNCTION public.record_update_dispatch_attempt();

DO $engagement_storage_guards$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ProjectUpdateEngagement','ProjectUpdateStage','ProjectUpdateOutbox','ProjectUpdateDispatchAttempt'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_update_engagement_history()',table_name||'_no_truncate',table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',table_name);
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO pdaa_migrate',table_name);
    END IF;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM pdaa_api',table_name);
    END IF;
    IF to_regrole('pdaa_worker') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM pdaa_worker',table_name);
    END IF;
    IF to_regrole('pdaa_backup') IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO pdaa_backup',table_name);
    END IF;
  END LOOP;
END $engagement_storage_guards$;
DO $engagement_storage_functions$
DECLARE function_name text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['guard_update_engagement_storage','reject_update_engagement_history','guard_update_stage_snapshot',
    'guard_update_outbox','guard_update_attempt_insert','require_update_stage_outbox','record_update_dispatch_attempt'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC',function_name);
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%I() OWNER TO pdaa_migrate',function_name);
    END IF;
  END LOOP;
END $engagement_storage_functions$;
