-- EXEC-015 Stage 2c/3; FR-UPD-004/006, NFR-SEC-001, NFR-REL-002.
-- Additive storage and finite maintenance controls. No invitation backfill.
CREATE TABLE public."ProjectUpdateIssuanceGate" (
  "customerId" uuid PRIMARY KEY REFERENCES public."Customer"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "issuanceEnabled" boolean NOT NULL DEFAULT false,
  "issuanceEpoch" uuid NOT NULL DEFAULT gen_random_uuid(),
  revision integer NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 2147483647),
  "changedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "auditEventId" uuid,
  FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((revision=0 AND NOT "issuanceEnabled" AND "auditEventId" IS NULL)
    OR (revision>0 AND "auditEventId" IS NOT NULL))
);
INSERT INTO public."ProjectUpdateIssuanceGate" ("customerId") SELECT id FROM public."Customer";

CREATE TABLE public."ProjectUpdateCapturedRequest" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "stageId" uuid NOT NULL,
  "sourceAssessmentId" uuid NOT NULL,
  "issuanceEpoch" uuid NOT NULL,
  "recipientSubject" varchar(256) NOT NULL,
  "reviewerSubjects" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "requiredFacts" jsonb NOT NULL,
  dependencies jsonb NOT NULL,
  "rendererRevision" varchar(64) NOT NULL CHECK ("rendererRevision"='project-update-capture@1'),
  "contentDigest" char(64) NOT NULL CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  "capturedAt" timestamptz(3) NOT NULL,
  "invitationLifetimeSeconds" integer NOT NULL CHECK ("invitationLifetimeSeconds" BETWEEN 900 AND 604800),
  "contentRetentionSeconds" integer NOT NULL CHECK ("contentRetentionSeconds" BETWEEN 86400 AND 31536000),
  "purgeAfter" timestamptz(3) NOT NULL,
  "auditEventId" uuid NOT NULL,
  CONSTRAINT "ProjectUpdateCapturedRequest_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateCapturedRequest_stage_key" UNIQUE ("customerId","projectId","stageId"),
  FOREIGN KEY ("customerId","projectId","stageId")
    REFERENCES public."ProjectUpdateStage"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","sourceAssessmentId")
    REFERENCES public."ProjectUpdateAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("contentRetentionSeconds">="invitationLifetimeSeconds"
    AND "purgeAfter"="capturedAt"+make_interval(secs=>"contentRetentionSeconds")),
  CHECK (jsonb_typeof("requiredFacts")='array' AND jsonb_array_length("requiredFacts") BETWEEN 1 AND 100
    AND jsonb_typeof(dependencies)='array' AND jsonb_array_length(dependencies)<=1000)
);

CREATE TABLE public."ProjectUpdateInvitation" (
  id uuid PRIMARY KEY,
  locator uuid NOT NULL UNIQUE,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "requestId" uuid NOT NULL,
  "recipientSubject" varchar(256) NOT NULL,
  "issuanceEpoch" uuid NOT NULL,
  "issuedAt" timestamptz(3) NOT NULL,
  "expiresAt" timestamptz(3) NOT NULL,
  CONSTRAINT "ProjectUpdateInvitation_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateInvitation_request_key" UNIQUE ("customerId","projectId","requestId"),
  FOREIGN KEY ("customerId","projectId","requestId")
    REFERENCES public."ProjectUpdateCapturedRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("expiresAt">"issuedAt")
);

CREATE TABLE public."ProjectUpdateResponse" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "requestId" uuid NOT NULL,
  "invitationId" uuid NOT NULL,
  "submittedBy" varchar(256) NOT NULL,
  "receivedAt" timestamptz(3) NOT NULL,
  "idempotencyKey" varchar(96) NOT NULL CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._-]{1,96}$'),
  "payloadDigest" char(64) NOT NULL CHECK ("payloadDigest" ~ '^[0-9a-f]{64}$'),
  "contentDigest" char(64) NOT NULL CHECK ("contentDigest" ~ '^[0-9a-f]{64}$'),
  "correctsResponseId" uuid,
  "contentRetentionSeconds" integer NOT NULL CHECK ("contentRetentionSeconds" BETWEEN 86400 AND 31536000),
  "purgeAfter" timestamptz(3) NOT NULL,
  "auditEventId" uuid NOT NULL,
  CONSTRAINT "ProjectUpdateResponse_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateResponse_retry_key"
    UNIQUE ("customerId","projectId","invitationId","submittedBy","idempotencyKey"),
  FOREIGN KEY ("customerId","projectId","requestId")
    REFERENCES public."ProjectUpdateCapturedRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","invitationId")
    REFERENCES public."ProjectUpdateInvitation"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","correctsResponseId")
    REFERENCES public."ProjectUpdateResponse"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("purgeAfter"="receivedAt"+make_interval(secs=>"contentRetentionSeconds"))
);
CREATE INDEX "ProjectUpdateResponse_history_idx" ON public."ProjectUpdateResponse"
  ("customerId","projectId","requestId","receivedAt",id);

CREATE TABLE public."ProjectUpdateRequestContent" (
  "requestId" uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  body text,
  state varchar(16) NOT NULL DEFAULT 'PRESENT' CHECK (state IN ('PRESENT','PURGED')),
  "purgedAt" timestamptz(3),
  "purgeAuditEventId" uuid,
  FOREIGN KEY ("customerId","projectId","requestId")
    REFERENCES public."ProjectUpdateCapturedRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","purgeAuditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((state='PRESENT' AND body IS NOT NULL AND octet_length(body) BETWEEN 1 AND 65536
    AND "purgedAt" IS NULL AND "purgeAuditEventId" IS NULL)
    OR (state='PURGED' AND body IS NULL AND "purgedAt" IS NOT NULL AND "purgeAuditEventId" IS NOT NULL))
);
CREATE TABLE public."ProjectUpdateResponseContent" (
  "responseId" uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  body text,
  state varchar(16) NOT NULL DEFAULT 'PRESENT' CHECK (state IN ('PRESENT','PURGED')),
  "purgedAt" timestamptz(3),
  "purgeAuditEventId" uuid,
  FOREIGN KEY ("customerId","projectId","responseId")
    REFERENCES public."ProjectUpdateResponse"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","purgeAuditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ((state='PRESENT' AND body IS NOT NULL AND char_length(body) BETWEEN 1 AND 8000
    AND octet_length(body)<=16384 AND body !~ '^[[:space:]]*$'
    AND "purgedAt" IS NULL AND "purgeAuditEventId" IS NULL)
    OR (state='PURGED' AND body IS NULL AND "purgedAt" IS NOT NULL AND "purgeAuditEventId" IS NOT NULL))
);

CREATE FUNCTION public.guard_update_issuance_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 OR NEW."issuanceEnabled" OR NEW."auditEventId" IS NOT NULL THEN
      RAISE EXCEPTION 'Issuance begins disabled' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR NEW."customerId"<>OLD."customerId"
    OR NEW.revision<>OLD.revision+1 OR NEW."changedAt"<OLD."changedAt"
    OR NEW."changedAt">clock_timestamp() OR NEW."auditEventId" IS NULL
    OR NEW."auditEventId" IS NOT DISTINCT FROM OLD."auditEventId"
    OR (NOT NEW."issuanceEnabled" AND NEW."issuanceEpoch"=OLD."issuanceEpoch")
    OR (NEW."issuanceEnabled" AND (OLD."issuanceEnabled" OR NEW."issuanceEpoch"<>OLD."issuanceEpoch"))
    OR NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a."customerId"=NEW."customerId"
      AND a.id=NEW."auditEventId" AND a.event='project_update.issuance.changed')
    OR (NEW."issuanceEnabled" AND coalesce(shobj_description(
      (SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database'),'') LIKE 'pdaa.restore.quarantine.%')
  THEN RAISE EXCEPTION 'Invalid issuance gate transition' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateIssuanceGate_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON public."ProjectUpdateIssuanceGate" FOR EACH ROW EXECUTE FUNCTION public.guard_update_issuance_gate();

-- Row locking requires UPDATE privileges. Keep gate UPDATE exclusive to
-- maintenance; this narrow definer locks and returns only the selected gate.
CREATE FUNCTION public.lock_update_issuance_gate(selected_customer uuid)
RETURNS TABLE(issuance_enabled boolean,issuance_epoch uuid,gate_revision integer,not_quarantined boolean)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $
  SELECT g."issuanceEnabled",g."issuanceEpoch",g.revision,
    coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database'),'')
      NOT LIKE 'pdaa.restore.quarantine.%'
  FROM public."ProjectUpdateIssuanceGate" g WHERE g."customerId"=selected_customer FOR SHARE OF g
$;

CREATE FUNCTION public.guard_update_capture_birth()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE stage public."ProjectUpdateStage"%ROWTYPE; assessment public."ProjectUpdateAssessment"%ROWTYPE;
BEGIN
  PERFORM * FROM public.lock_update_issuance_gate(NEW."customerId");
  SELECT * INTO stage FROM public."ProjectUpdateStage" WHERE "customerId"=NEW."customerId"
    AND "projectId"=NEW."projectId" AND id=NEW."stageId";
  SELECT * INTO assessment FROM public."ProjectUpdateAssessment" WHERE "customerId"=NEW."customerId"
    AND "projectId"=NEW."projectId" AND id=NEW."sourceAssessmentId";
  IF coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database'),'')
      LIKE 'pdaa.restore.quarantine.%'
    OR stage.id IS NULL OR assessment.id IS NULL OR stage.mode<>'CAPTURE'
    OR NEW."recipientSubject"<>stage."recipientSubject"
    OR assessment."policyRevisionId"<>stage."policyRevisionId"
    OR NEW.dependencies IS DISTINCT FROM assessment.dependencies
    OR NEW."capturedAt"<assessment."assessedAt" OR NEW."capturedAt">clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM public."ProjectUpdateIssuanceGate" g WHERE g."customerId"=NEW."customerId"
      AND g."issuanceEnabled" AND g."issuanceEpoch"=NEW."issuanceEpoch")
    OR NOT EXISTS (SELECT 1 FROM public."ProjectUpdateEngagement" e JOIN public."ProjectUpdateObligation" o
      ON o."customerId"=e."customerId" AND o."projectId"=e."projectId" AND o.id=e."obligationId"
      JOIN public."ProjectUpdatePolicy" p ON p."customerId"=e."customerId" AND p."projectId"=e."projectId"
      WHERE e."customerId"=stage."customerId" AND e."projectId"=stage."projectId" AND e.id=stage."engagementId"
      AND e.state='ACTIVE' AND e.generation=stage.generation AND o.state='OPEN' AND p.revision=stage."policyRevision")
    OR NOT EXISTS (SELECT 1 FROM public."ProjectUpdateOutbox" o WHERE o."customerId"=stage."customerId"
      AND o."projectId"=stage."projectId" AND o."stageId"=stage.id AND o.state='CLAIMED'
      AND o."handoffAt" IS NULL AND o."leaseUntil">clock_timestamp())
    OR cardinality(NEW."reviewerSubjects")>32
    OR cardinality(NEW."reviewerSubjects")<>(SELECT count(DISTINCT s) FROM unnest(NEW."reviewerSubjects") s)
    OR EXISTS (SELECT 1 FROM unnest(NEW."reviewerSubjects") s WHERE s IS NULL OR char_length(s) NOT BETWEEN 1 AND 200
      OR s ~ '[[:cntrl:]]|^[[:space:]]|[[:space:]]$')
    OR (SELECT array_agg(r->>'factType' ORDER BY r->>'factType') FROM jsonb_array_elements(NEW."requiredFacts") r)
      IS DISTINCT FROM (SELECT array_agg(f ORDER BY f) FROM unnest(stage."factTypes") f)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW."requiredFacts") r WHERE NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdatePolicyRevision" p,jsonb_array_elements(p."requiredFacts") f
      WHERE p."customerId"=stage."customerId" AND p."projectId"=stage."projectId"
      AND p.id=stage."policyRevisionId" AND f=r))
  THEN RAISE EXCEPTION 'Invalid captured request lineage' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateCapturedRequest_birth" BEFORE INSERT ON public."ProjectUpdateCapturedRequest"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_capture_birth();

CREATE FUNCTION public.guard_update_invitation_birth()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."ProjectUpdateCapturedRequest" r WHERE r."customerId"=NEW."customerId"
    AND r."projectId"=NEW."projectId" AND r.id=NEW."requestId"
    AND r."recipientSubject"=NEW."recipientSubject" AND r."issuanceEpoch"=NEW."issuanceEpoch"
    AND NEW."issuedAt"=r."capturedAt"
    AND NEW."expiresAt"=r."capturedAt"+make_interval(secs=>r."invitationLifetimeSeconds"))
  THEN RAISE EXCEPTION 'Invalid invitation lineage' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateInvitation_birth" BEFORE INSERT ON public."ProjectUpdateInvitation"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_invitation_birth();

CREATE FUNCTION public.guard_update_response_birth()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM * FROM public.lock_update_issuance_gate(NEW."customerId");
  IF coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database'),'')
      LIKE 'pdaa.restore.quarantine.%'
    OR NEW."receivedAt">clock_timestamp() OR NOT EXISTS (
    SELECT 1 FROM public."ProjectUpdateInvitation" i JOIN public."ProjectUpdateCapturedRequest" r
      ON r."customerId"=i."customerId" AND r."projectId"=i."projectId" AND r.id=i."requestId"
      JOIN public."ProjectUpdateIssuanceGate" g ON g."customerId"=i."customerId"
      JOIN public."ProjectUpdateStage" s ON s."customerId"=r."customerId" AND s."projectId"=r."projectId" AND s.id=r."stageId"
      JOIN public."ProjectUpdateEngagement" e ON e."customerId"=s."customerId" AND e."projectId"=s."projectId" AND e.id=s."engagementId"
      JOIN public."ProjectUpdateObligation" o ON o."customerId"=e."customerId" AND o."projectId"=e."projectId" AND o.id=e."obligationId"
      JOIN public."ProjectUpdatePolicy" p ON p."customerId"=e."customerId" AND p."projectId"=e."projectId"
      JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id
    WHERE i."customerId"=NEW."customerId" AND i."projectId"=NEW."projectId" AND i.id=NEW."invitationId"
      AND i."requestId"=NEW."requestId" AND i."recipientSubject"=NEW."submittedBy"
      AND NEW."receivedAt">=i."issuedAt" AND NEW."receivedAt"<i."expiresAt"
      AND clock_timestamp()<i."expiresAt" AND clock_timestamp()<r."purgeAfter" AND c.state='PRESENT'
      AND g."issuanceEnabled" AND g."issuanceEpoch"=i."issuanceEpoch"
      AND e.state='ACTIVE' AND o.state='OPEN' AND e.generation=s.generation AND p.revision=s."policyRevision"
      AND NEW."contentRetentionSeconds"=r."contentRetentionSeconds")
    OR (NEW."correctsResponseId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public."ProjectUpdateResponse" prior WHERE prior."customerId"=NEW."customerId"
        AND prior."projectId"=NEW."projectId" AND prior.id=NEW."correctsResponseId"
        AND prior."requestId"=NEW."requestId" AND prior."submittedBy"=NEW."submittedBy"
        AND prior."receivedAt"<=NEW."receivedAt"))
  THEN RAISE EXCEPTION 'Invalid response lineage' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateResponse_birth" BEFORE INSERT ON public."ProjectUpdateResponse"
  FOR EACH ROW EXECUTE FUNCTION public.guard_update_response_birth();

CREATE FUNCTION public.guard_update_capture_content()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE metadata jsonb; record_id uuid; current_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Capture content history cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='ProjectUpdateRequestContent' THEN
    record_id := NEW."requestId";
    SELECT to_jsonb(r) INTO metadata FROM public."ProjectUpdateCapturedRequest" r
      WHERE r."customerId"=NEW."customerId" AND r."projectId"=NEW."projectId" AND r.id=record_id;
  ELSE
    record_id := NEW."responseId";
    SELECT to_jsonb(r) INTO metadata FROM public."ProjectUpdateResponse" r
      WHERE r."customerId"=NEW."customerId" AND r."projectId"=NEW."projectId" AND r.id=record_id;
  END IF;
  IF metadata IS NULL THEN
    RAISE EXCEPTION 'Missing capture content metadata' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PRESENT' OR NEW."purgedAt" IS NOT NULL OR NEW."purgeAuditEventId" IS NOT NULL
      OR encode(sha256(convert_to(NEW.body,'UTF8')),'hex') IS DISTINCT FROM metadata->>'contentDigest'
      OR (metadata->>'purgeAfter')::timestamptz<=current_at
    THEN RAISE EXCEPTION 'Invalid capture content birth' USING ERRCODE='55000'; END IF;
  ELSE
    IF (to_jsonb(NEW)-'body'-'state'-'purgedAt'-'purgeAuditEventId')
      IS DISTINCT FROM (to_jsonb(OLD)-'body'-'state'-'purgedAt'-'purgeAuditEventId')
      OR OLD.state<>'PRESENT' OR NEW.state<>'PURGED' OR NEW.body IS NOT NULL
      OR NEW."purgedAt" IS NULL OR NEW."purgedAt">current_at
      OR NEW."purgedAt"<(metadata->>'purgeAfter')::timestamptz
      OR current_at<(metadata->>'purgeAfter')::timestamptz OR NEW."purgeAuditEventId" IS NULL
      OR NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a."customerId"=NEW."customerId"
        AND a.id=NEW."purgeAuditEventId" AND a.event='project_update.content.purged')
    THEN RAISE EXCEPTION 'Invalid one-way capture content purge' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProjectUpdateRequestContent_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON public."ProjectUpdateRequestContent" FOR EACH ROW EXECUTE FUNCTION public.guard_update_capture_content();
CREATE TRIGGER "ProjectUpdateResponseContent_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON public."ProjectUpdateResponseContent" FOR EACH ROW EXECUTE FUNCTION public.guard_update_capture_content();

-- Deferred completeness prevents a committed capture or response without its
-- immutable metadata, bounded content and automatic completion receipt.
CREATE FUNCTION public.require_update_capture_complete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE request_id uuid;
BEGIN
  IF TG_TABLE_NAME='ProjectUpdateResponse' THEN
    IF NOT EXISTS (SELECT 1 FROM public."ProjectUpdateResponseContent" c
      WHERE c."customerId"=NEW."customerId" AND c."projectId"=NEW."projectId" AND c."responseId"=NEW.id)
    THEN RAISE EXCEPTION 'Response requires committed content' USING ERRCODE='55000'; END IF;
    RETURN NULL;
  ELSIF TG_TABLE_NAME='ProjectUpdateOutbox' THEN
    IF NEW.state<>'CAPTURED' THEN RETURN NULL; END IF;
    SELECT r.id INTO request_id FROM public."ProjectUpdateCapturedRequest" r
      WHERE r."customerId"=NEW."customerId" AND r."projectId"=NEW."projectId" AND r."stageId"=NEW."stageId";
  ELSE request_id:=NEW.id;
  END IF;
  IF request_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public."ProjectUpdateCapturedRequest" r
    JOIN public."ProjectUpdateInvitation" i ON i."customerId"=r."customerId" AND i."projectId"=r."projectId" AND i."requestId"=r.id
    JOIN public."ProjectUpdateRequestContent" c ON c."customerId"=r."customerId" AND c."projectId"=r."projectId" AND c."requestId"=r.id
    JOIN public."ProjectUpdateOutbox" o ON o."customerId"=r."customerId" AND o."projectId"=r."projectId" AND o."stageId"=r."stageId"
    JOIN public."ProjectUpdateDispatchAttempt" a ON a."customerId"=o."customerId" AND a."projectId"=o."projectId"
      AND a."outboxId"=o.id AND a."claimGeneration"=o."claimGeneration" AND a.event='CAPTURED'
    WHERE r."customerId"=NEW."customerId" AND r."projectId"=NEW."projectId" AND r.id=request_id
      AND o.state='CAPTURED' AND o."handoffAt" IS NULL)
  THEN RAISE EXCEPTION 'Capture requires committed invitation, content and receipt' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ProjectUpdateCapturedRequest_complete" AFTER INSERT ON public."ProjectUpdateCapturedRequest"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_update_capture_complete();
CREATE CONSTRAINT TRIGGER "ProjectUpdateResponse_complete" AFTER INSERT ON public."ProjectUpdateResponse"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_update_capture_complete();
CREATE CONSTRAINT TRIGGER "ProjectUpdateOutbox_capture_complete" AFTER UPDATE ON public."ProjectUpdateOutbox"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_update_capture_complete();

-- New reason for an explicitly configured, disabled or mismatched capture gate.
ALTER TABLE public."ProjectUpdateOutbox" DROP CONSTRAINT "ProjectUpdateOutbox_reason_check";
ALTER TABLE public."ProjectUpdateOutbox" ADD CONSTRAINT "ProjectUpdateOutbox_reason_check"
  CHECK (reason IN ('LEASE_EXPIRED','QUIET_HOURS','WEEKEND','DST_GAP',
    'OBLIGATION_ENDED','REQUIRED_FACTS_SATISFIED','SHADOW_MODE','POLICY_CHANGED','OWNER_CHANGED',
    'RECIPIENT_ZONE_CHANGED','RECIPIENT_REVOKED','SOURCE_REASSESSMENT_REQUIRED',
    'SOURCE_UNKNOWN','CALENDAR_RECHECK_REQUIRED','ENGAGEMENT_PAUSED','EMAIL_GATE_CLOSED',
    'HANDOFF_UNCERTAIN','CAPTURE_GATE_CLOSED'));

-- Fixed server-time retention operation. EXECUTE does not grant callers UPDATE
-- or DELETE on content; identifiers, ownership, predicates and audit actor are
-- fixed in this function. No dynamic SQL or user-supplied purge time.
CREATE FUNCTION public.purge_update_capture_content(selected_customer uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_id uuid; audit_id uuid; purged_count integer:=0;
BEGIN
  FOR selected_id IN
    SELECT c."requestId" FROM public."ProjectUpdateRequestContent" c
      JOIN public."ProjectUpdateCapturedRequest" r ON r."customerId"=c."customerId" AND r."projectId"=c."projectId" AND r.id=c."requestId"
      WHERE c."customerId"=selected_customer AND c.state='PRESENT' AND r."purgeAfter"<=clock_timestamp()
      ORDER BY r."purgeAfter",c."requestId" LIMIT 50 FOR UPDATE OF c SKIP LOCKED
  LOOP
    audit_id:=gen_random_uuid();
    INSERT INTO public."AuditEvent"(id,"customerId",actor,event,"correlationId",detail)
      VALUES(audit_id,selected_customer,'system:update-engagement-retention','project_update.content.purged',
        'project-update-retention',jsonb_build_object('contentKind','REQUEST'));
    UPDATE public."ProjectUpdateRequestContent" SET body=NULL,state='PURGED',
      "purgedAt"=date_trunc('milliseconds',clock_timestamp()),"purgeAuditEventId"=audit_id
      WHERE "customerId"=selected_customer AND "requestId"=selected_id AND state='PRESENT';
    purged_count:=purged_count+1;
  END LOOP;
  FOR selected_id IN
    SELECT c."responseId" FROM public."ProjectUpdateResponseContent" c
      JOIN public."ProjectUpdateResponse" r ON r."customerId"=c."customerId" AND r."projectId"=c."projectId" AND r.id=c."responseId"
      WHERE c."customerId"=selected_customer AND c.state='PRESENT' AND r."purgeAfter"<=clock_timestamp()
      ORDER BY r."purgeAfter",c."responseId" LIMIT 50 FOR UPDATE OF c SKIP LOCKED
  LOOP
    audit_id:=gen_random_uuid();
    INSERT INTO public."AuditEvent"(id,"customerId",actor,event,"correlationId",detail)
      VALUES(audit_id,selected_customer,'system:update-engagement-retention','project_update.content.purged',
        'project-update-retention',jsonb_build_object('contentKind','RESPONSE'));
    UPDATE public."ProjectUpdateResponseContent" SET body=NULL,state='PURGED',
      "purgedAt"=date_trunc('milliseconds',clock_timestamp()),"purgeAuditEventId"=audit_id
      WHERE "customerId"=selected_customer AND "responseId"=selected_id AND state='PRESENT';
    purged_count:=purged_count+1;
  END LOOP;
  RETURN purged_count;
END $$;

DO $capture_metadata_guards$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ProjectUpdateCapturedRequest','ProjectUpdateInvitation','ProjectUpdateResponse'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_update_engagement_history()',table_name||'_immutable',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['ProjectUpdateIssuanceGate','ProjectUpdateCapturedRequest','ProjectUpdateInvitation',
    'ProjectUpdateResponse','ProjectUpdateRequestContent','ProjectUpdateResponseContent'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_update_engagement_history()',table_name||'_no_truncate',table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',table_name);
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO pdaa_migrate',table_name);
    END IF;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM pdaa_api',table_name);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO pdaa_api',table_name);
      IF table_name<>'ProjectUpdateIssuanceGate' THEN
        EXECUTE format('GRANT INSERT ON TABLE public.%I TO pdaa_api',table_name);
      END IF;
    END IF;
    IF to_regrole('pdaa_worker') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM pdaa_worker',table_name);
    END IF;
    IF to_regrole('pdaa_backup') IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO pdaa_backup',table_name);
    END IF;
  END LOOP;
END $capture_metadata_guards$;
DO $capture_functions$
DECLARE function_name text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY['guard_update_issuance_gate','guard_update_capture_birth',
    'guard_update_invitation_birth','guard_update_response_birth','guard_update_capture_content','require_update_capture_complete'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I() FROM PUBLIC',function_name);
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION public.%I() OWNER TO pdaa_migrate',function_name);
    END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION public.lock_update_issuance_gate(uuid) FROM PUBLIC;
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.lock_update_issuance_gate(uuid) OWNER TO pdaa_migrate;
  END IF;
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.lock_update_issuance_gate(uuid) TO pdaa_api;
  END IF;
  REVOKE ALL ON FUNCTION public.purge_update_capture_content(uuid) FROM PUBLIC;
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.purge_update_capture_content(uuid) OWNER TO pdaa_migrate;
  END IF;
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.purge_update_capture_content(uuid) TO pdaa_api;
  END IF;
END $capture_functions$;

CREATE OR REPLACE FUNCTION public.guard_update_outbox()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE stage public."ProjectUpdateStage"%ROWTYPE; valid boolean := false; current_time_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Engagement outbox history cannot be deleted' USING ERRCODE='55000';
  END IF;
  SELECT * INTO stage FROM public."ProjectUpdateStage"
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."stageId";
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
        'SOURCE_UNKNOWN','RECIPIENT_REVOKED','ENGAGEMENT_PAUSED','EMAIL_GATE_CLOSED','CAPTURE_GATE_CLOSED','CALENDAR_RECHECK_REQUIRED')
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
