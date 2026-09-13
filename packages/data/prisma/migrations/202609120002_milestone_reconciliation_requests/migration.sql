-- FR-EVD-007/012, FR-HLT-008/009, NFR-REL-001/002: immutable internal requests.
-- Additive migration 6. Released proofs remain null-owned; no historical adoption.
ALTER TABLE public."MilestoneConsistencyAssessment" ADD COLUMN "reconciliationCheckId" uuid;
CREATE UNIQUE INDEX "MilestoneConsistencyAssessment_reconciliationCheckId_key" ON public."MilestoneConsistencyAssessment"("reconciliationCheckId");
ALTER TABLE public."MilestoneConsistencyAssessment" ADD CONSTRAINT "ReconciliationAssessment_owner_key" UNIQUE ("customerId","projectId",id,"reconciliationCheckId");
ALTER TABLE public."ProjectResponsibility" ADD CONSTRAINT "ReconciliationResponsibility_scope_key" UNIQUE ("customerId","projectId",id);

CREATE TABLE public."MilestoneReconciliationRequest" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "milestoneId" uuid NOT NULL,
  "ruleRevision" varchar(48) NOT NULL,
  "originalAssessmentId" uuid NOT NULL UNIQUE,
  "originCommandId" uuid NOT NULL UNIQUE,
  "contributorHash" char(64) NOT NULL,
  "contributorIdentity" text NOT NULL,
  "createdBy" varchar(256) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'OPEN',
  "auditEventId" uuid NOT NULL UNIQUE,
  sealed boolean NOT NULL DEFAULT false,
  CONSTRAINT "ReconciliationRequest_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ReconciliationRequest_proof_key" UNIQUE ("customerId","projectId","originalAssessmentId"),
  CONSTRAINT "ReconciliationRequest_birth_key" UNIQUE ("customerId","projectId",id,"originCommandId","originalAssessmentId"),
  CONSTRAINT "ReconciliationRequest_business_key" UNIQUE ("customerId","projectId","milestoneId","ruleRevision","contributorHash"),
  CONSTRAINT "ReconciliationRequest_shape" CHECK (
    state='OPEN' AND "ruleRevision"='milestone-required-state/v1'
    AND "contributorHash" ~ '^[a-f0-9]{64}$'
    AND octet_length("contributorIdentity") BETWEEN 1 AND 4194304
    AND length(btrim("createdBy"))>0 AND isfinite("createdAt")
    AND "contributorHash"=encode(sha256(convert_to("contributorIdentity",'UTF8')),'hex')),
  CONSTRAINT "ReconciliationRequest_milestone_fk" FOREIGN KEY ("customerId","projectId","milestoneId") REFERENCES public."Milestone"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ReconciliationRequest_assessment_fk" FOREIGN KEY ("customerId","projectId","originalAssessmentId") REFERENCES public."MilestoneConsistencyAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ReconciliationRequest_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX "ReconciliationRequest_page_idx" ON public."MilestoneReconciliationRequest"("customerId","projectId","createdAt",id);

CREATE TABLE public."MilestoneReconciliationCheck" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL,
  "assessmentId" uuid NOT NULL UNIQUE,
  "requestId" uuid,
  outcome varchar(16) NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  CONSTRAINT "ReconciliationCheck_retry_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  CONSTRAINT "ReconciliationCheck_owner_key" UNIQUE ("customerId","projectId","assessmentId",id),
  CONSTRAINT "ReconciliationCheck_birth_key" UNIQUE ("customerId","projectId","requestId",id,"assessmentId"),
  CONSTRAINT "ReconciliationCheck_shape" CHECK (
    length(btrim(subject))>0 AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "requestHash" ~ '^[a-f0-9]{64}$' AND isfinite("occurredAt")
    AND ((outcome='NO_REQUEST' AND "requestId" IS NULL) OR (outcome IN ('CREATED','REUSED') AND "requestId" IS NOT NULL))),
  CONSTRAINT "ReconciliationCheck_assessment_fk" FOREIGN KEY ("customerId","projectId","assessmentId",id) REFERENCES public."MilestoneConsistencyAssessment"("customerId","projectId",id,"reconciliationCheckId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ReconciliationCheck_request_fk" FOREIGN KEY ("customerId","projectId","requestId") REFERENCES public."MilestoneReconciliationRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ReconciliationCheck_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public."MilestoneConsistencyAssessment" ADD CONSTRAINT "ReconciliationAssessment_check_fk" FOREIGN KEY ("customerId","projectId",id,"reconciliationCheckId") REFERENCES public."MilestoneReconciliationCheck"("customerId","projectId","assessmentId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."MilestoneReconciliationRequest" ADD CONSTRAINT "ReconciliationRequest_birth_fk" FOREIGN KEY ("customerId","projectId",id,"originCommandId","originalAssessmentId") REFERENCES public."MilestoneReconciliationCheck"("customerId","projectId","requestId",id,"assessmentId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public."MilestoneReconciliationAssignment" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "requestId" uuid NOT NULL,
  revision integer NOT NULL,
  "expectedRevision" integer NOT NULL,
  "previousAssignmentId" uuid,
  kind varchar(16) NOT NULL,
  "recipientSubject" varchar(256),
  "responsibilityId" uuid,
  reason varchar(32) NOT NULL,
  actor varchar(256) NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  "idempotencyKey" varchar(128),
  "requestHash" char(64),
  "grantId" uuid,
  "grantCustomerId" uuid,
  "grantSubject" varchar(256),
  "grantScopeType" varchar(16),
  "grantScopeId" uuid,
  "grantRole" varchar(32),
  CONSTRAINT "ReconciliationAssignment_revision_key" UNIQUE ("customerId","projectId","requestId",revision),
  CONSTRAINT "ReconciliationAssignment_predecessor_key" UNIQUE ("customerId","projectId","requestId",revision,id),
  CONSTRAINT "ReconciliationAssignment_retry_key" UNIQUE ("customerId","projectId","requestId",actor,"idempotencyKey"),
  CONSTRAINT "ReconciliationAssignment_shape" CHECK (
    revision BETWEEN 1 AND 2147483647 AND "expectedRevision" BETWEEN 0 AND 2147483646
    AND revision::bigint="expectedRevision"::bigint+1 AND length(btrim(actor))>0 AND isfinite("occurredAt")
    AND ((kind='INITIAL' AND revision=1 AND "previousAssignmentId" IS NULL AND "idempotencyKey" IS NULL AND "requestHash" IS NULL)
      OR (kind='REFRESH' AND revision>1 AND "previousAssignmentId" IS NOT NULL AND "idempotencyKey" IS NOT NULL AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$' AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$'))
    AND ((reason='ASSIGNED' AND "recipientSubject" IS NOT NULL AND length(btrim("recipientSubject"))>0 AND "responsibilityId" IS NOT NULL
      AND "grantId" IS NOT NULL AND "grantCustomerId" IS NOT NULL AND "grantSubject" IS NOT NULL AND "grantScopeType" IS NOT NULL AND "grantScopeId" IS NOT NULL AND "grantRole" IS NOT NULL
      AND "grantCustomerId"="customerId" AND "grantSubject"="recipientSubject" AND "grantScopeType" IN ('project','portfolio') AND "grantRole"='project_manager')
      OR (reason IN ('NO_CONFIGURED_PM','AMBIGUOUS_CONFIGURED_PM','PM_SCOPE_UNAVAILABLE') AND "recipientSubject" IS NULL AND "responsibilityId" IS NULL
        AND "grantId" IS NULL AND "grantCustomerId" IS NULL AND "grantSubject" IS NULL AND "grantScopeType" IS NULL AND "grantScopeId" IS NULL AND "grantRole" IS NULL))),
  CONSTRAINT "ReconciliationAssignment_request_fk" FOREIGN KEY ("customerId","projectId","requestId") REFERENCES public."MilestoneReconciliationRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ReconciliationAssignment_responsibility_fk" FOREIGN KEY ("customerId","projectId","responsibilityId") REFERENCES public."ProjectResponsibility"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ReconciliationAssignment_previous_fk" FOREIGN KEY ("customerId","projectId","requestId","expectedRevision","previousAssignmentId") REFERENCES public."MilestoneReconciliationAssignment"("customerId","projectId","requestId",revision,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ReconciliationAssignment_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

-- Acyclic historical validators deliberately do not read current AccessGrant or
-- current evidence visibility. Revocation cannot invalidate immutable history.
CREATE FUNCTION public.valid_milestone_reconciliation_assignment(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a public."MilestoneReconciliationAssignment"%ROWTYPE; r public."MilestoneReconciliationRequest"%ROWTYPE; configured integer; portfolio uuid;
BEGIN
  SELECT * INTO a FROM public."MilestoneReconciliationAssignment" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO r FROM public."MilestoneReconciliationRequest" WHERE id=a."requestId" AND "customerId"=a."customerId" AND "projectId"=a."projectId";
  IF NOT FOUND OR r.state<>'OPEN' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=a."auditEventId" AND "customerId"=a."customerId" AND actor=a.actor AND "occurredAt"=a."occurredAt" AND event='milestone.reconciliation.assigned'
    AND detail=jsonb_build_object('projectId',a."projectId",'requestId',a."requestId",'assignmentId',a.id,'revision',a.revision,'reason',a.reason)) THEN RETURN false; END IF;
  IF a.kind='INITIAL' THEN
    IF a.revision<>1 OR a."expectedRevision"<>0 OR a."previousAssignmentId" IS NOT NULL OR a.actor<>r."createdBy" OR a."occurredAt"<>r."createdAt" THEN RETURN false; END IF;
  ELSIF a.kind='REFRESH' THEN
    IF a."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","requestId":"%s","expectedAssignmentRevision":%s}',a."projectId",a."requestId",a."expectedRevision"),'UTF8')),'hex') THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."MilestoneReconciliationAssignment" p WHERE p.id=a."previousAssignmentId" AND p."customerId"=a."customerId" AND p."projectId"=a."projectId" AND p."requestId"=a."requestId" AND p.revision=a."expectedRevision" AND a.revision::bigint=p.revision::bigint+1 AND p."occurredAt"<=a."occurredAt") THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  SELECT count(*) INTO configured FROM public."ProjectResponsibility" WHERE "customerId"=a."customerId" AND "projectId"=a."projectId" AND role='PROJECT_MANAGER';
  IF a.reason='NO_CONFIGURED_PM' THEN RETURN configured=0; END IF;
  IF a.reason='AMBIGUOUS_CONFIGURED_PM' THEN RETURN configured>1; END IF;
  IF configured<>1 THEN RETURN false; END IF;
  IF a.reason='PM_SCOPE_UNAVAILABLE' THEN RETURN true; END IF;
  IF a.reason<>'ASSIGNED' OR NOT EXISTS (SELECT 1 FROM public."ProjectResponsibility" WHERE id=a."responsibilityId" AND "customerId"=a."customerId" AND "projectId"=a."projectId" AND subject=a."recipientSubject" AND role='PROJECT_MANAGER') THEN RETURN false; END IF;
  SELECT "portfolioId" INTO portfolio FROM public."CanonicalProject" WHERE id=a."projectId" AND "customerId"=a."customerId" AND sealed;
  RETURN a."grantCustomerId"=a."customerId" AND a."grantSubject"=a."recipientSubject" AND a."grantRole"='project_manager'
    AND ((a."grantScopeType"='project' AND a."grantScopeId"=a."projectId") OR (a."grantScopeType"='portfolio' AND a."grantScopeId"=portfolio));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.valid_milestone_reconciliation_request(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."MilestoneReconciliationRequest"%ROWTYPE; a public."MilestoneConsistencyAssessment"%ROWTYPE; c public."MilestoneReconciliationCheck"%ROWTYPE; initial_id uuid;
BEGIN
  SELECT * INTO r FROM public."MilestoneReconciliationRequest" WHERE id=target;
  IF NOT FOUND OR r.state<>'OPEN' THEN RETURN false; END IF;
  SELECT * INTO a FROM public."MilestoneConsistencyAssessment" WHERE id=r."originalAssessmentId" AND "customerId"=r."customerId" AND "projectId"=r."projectId";
  IF NOT FOUND OR NOT a.sealed OR a.status<>'CONFLICTING' OR a."milestoneId"<>r."milestoneId" OR a."ruleRevision"<>r."ruleRevision" OR a."asOf"<>r."createdAt" OR a.subject<>r."createdBy"
    OR a."reconciliationCheckId" IS DISTINCT FROM r."originCommandId" OR a.result->>'contributorIdentity' IS DISTINCT FROM r."contributorIdentity" OR NOT public.valid_milestone_consistency_assessment(a.id) THEN RETURN false; END IF;
  SELECT * INTO c FROM public."MilestoneReconciliationCheck" WHERE id=r."originCommandId" AND "customerId"=r."customerId" AND "projectId"=r."projectId";
  IF NOT FOUND OR c.outcome<>'CREATED' OR c."requestId" IS DISTINCT FROM r.id OR c."assessmentId"<>a.id OR c.subject<>a.subject OR c."occurredAt"<>a."asOf" OR c."requestHash"<>a."requestHash" THEN RETURN false; END IF;
  IF c."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","milestoneId":"%s","ruleRevision":"%s","enabled":%s}',a."projectId",a."milestoneId",a."ruleRevision",CASE WHEN a.enabled THEN 'true' ELSE 'false' END),'UTF8')),'hex') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=r."auditEventId" AND "customerId"=r."customerId" AND actor=r."createdBy" AND "occurredAt"=r."createdAt" AND event='milestone.reconciliation.requested'
    AND detail=jsonb_build_object('projectId',r."projectId",'requestId',r.id,'assessmentId',r."originalAssessmentId",'checkId',r."originCommandId")) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=c."auditEventId" AND "customerId"=c."customerId" AND actor=c.subject AND "occurredAt"=c."occurredAt" AND event='milestone.reconciliation.checked'
    AND detail=jsonb_build_object('projectId',c."projectId",'checkId',c.id,'assessmentId',c."assessmentId",'requestId',c."requestId",'outcome',c.outcome)) THEN RETURN false; END IF;
  SELECT id INTO initial_id FROM public."MilestoneReconciliationAssignment" WHERE "customerId"=r."customerId" AND "projectId"=r."projectId" AND "requestId"=r.id AND revision=1;
  RETURN initial_id IS NOT NULL AND public.valid_milestone_reconciliation_assignment(initial_id);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- NFR-REL-001/002: released scalar validators inspect a source's temporal prefix.
-- Descending time lets EXISTS find newer candidates without repeated global scans.
-- No predicate, permission, immutable history or transaction deadline changes.
CREATE INDEX "ProjectFactVersion_source_temporal_idx"
  ON public."ProjectFactVersion" ("sourceId", "effectiveAt" DESC, revision);

CREATE FUNCTION public.valid_milestone_reconciliation_check(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public."MilestoneReconciliationCheck"%ROWTYPE; a public."MilestoneConsistencyAssessment"%ROWTYPE; r public."MilestoneReconciliationRequest"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public."MilestoneReconciliationCheck" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO a FROM public."MilestoneConsistencyAssessment" WHERE id=c."assessmentId" AND "customerId"=c."customerId" AND "projectId"=c."projectId";
  IF NOT FOUND OR NOT a.sealed OR a."reconciliationCheckId" IS DISTINCT FROM c.id OR a.subject<>c.subject OR a."asOf"<>c."occurredAt" OR a."requestHash"<>c."requestHash" OR NOT public.valid_milestone_consistency_assessment(a.id) THEN RETURN false; END IF;
  IF c."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","milestoneId":"%s","ruleRevision":"%s","enabled":%s}',a."projectId",a."milestoneId",a."ruleRevision",CASE WHEN a.enabled THEN 'true' ELSE 'false' END),'UTF8')),'hex') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=c."auditEventId" AND "customerId"=c."customerId" AND actor=c.subject AND "occurredAt"=c."occurredAt" AND event='milestone.reconciliation.checked'
    AND detail=jsonb_build_object('projectId',c."projectId",'checkId',c.id,'assessmentId',c."assessmentId",'requestId',c."requestId",'outcome',c.outcome)) THEN RETURN false; END IF;
  IF c.outcome='NO_REQUEST' THEN RETURN c."requestId" IS NULL AND a.status<>'CONFLICTING'; END IF;
  SELECT * INTO r FROM public."MilestoneReconciliationRequest" WHERE id=c."requestId" AND "customerId"=c."customerId" AND "projectId"=c."projectId";
  IF NOT FOUND OR NOT r.sealed OR a.status<>'CONFLICTING' OR r."milestoneId"<>a."milestoneId" OR r."ruleRevision"<>a."ruleRevision" OR r."contributorIdentity" IS DISTINCT FROM a.result->>'contributorIdentity' OR NOT public.valid_milestone_reconciliation_request(r.id) THEN RETURN false; END IF;
  RETURN (c.outcome='CREATED' AND r."originCommandId"=c.id AND r."originalAssessmentId"=a.id)
    OR (c.outcome='REUSED' AND r."originCommandId"<>c.id AND r."originalAssessmentId"<>a.id);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.guard_milestone_reconciliation_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reconciliation request is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Reconciliation request must start unsealed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."MilestoneConsistencyAssessment" WHERE id=NEW."originalAssessmentId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND sealed AND status='CONFLICTING' AND "reconciliationCheckId"=NEW."originCommandId") THEN RAISE EXCEPTION 'Reconciliation requires its fresh positive proof'; END IF;
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') OR NOT public.valid_milestone_reconciliation_request(NEW.id) THEN RAISE EXCEPTION 'Invalid reconciliation request seal'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_milestone_reconciliation_check() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."MilestoneReconciliationRequest"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reconciliation check is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF NEW.outcome<>'NO_REQUEST' THEN
    SELECT * INTO r FROM public."MilestoneReconciliationRequest" WHERE id=NEW."requestId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId";
    IF NOT FOUND OR r.state<>'OPEN' OR (NEW.outcome='CREATED' AND (r.sealed OR r."originCommandId"<>NEW.id OR r."originalAssessmentId"<>NEW."assessmentId")) OR (NEW.outcome='REUSED' AND (NOT r.sealed OR r."originCommandId"=NEW.id)) THEN RAISE EXCEPTION 'Invalid reconciliation check birth'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_milestone_reconciliation_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."MilestoneReconciliationRequest"%ROWTYPE; configured integer; pm public."ProjectResponsibility"%ROWTYPE; g public."AccessGrant"%ROWTYPE; locked_grant public."AccessGrant"%ROWTYPE; portfolio uuid; expected_reason text; last_revision integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reconciliation assignment is immutable'; END IF;
  SELECT "portfolioId" INTO portfolio FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  SELECT * INTO r FROM public."MilestoneReconciliationRequest" WHERE id=NEW."requestId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId";
  IF NOT FOUND OR r.state<>'OPEN' OR (NEW.kind='INITIAL' AND r.sealed) OR (NEW.kind='REFRESH' AND NOT r.sealed) THEN RAISE EXCEPTION 'Invalid reconciliation assignment parent'; END IF;
  SELECT COALESCE(max(revision),0) INTO last_revision FROM public."MilestoneReconciliationAssignment" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "requestId"=r.id;
  IF NEW."expectedRevision"<>last_revision OR NEW.revision::bigint<>last_revision::bigint+1 THEN RAISE EXCEPTION 'Invalid reconciliation assignment revision'; END IF;
  SELECT count(*) INTO configured FROM public."ProjectResponsibility" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND role='PROJECT_MANAGER';
  IF configured=0 THEN expected_reason:='NO_CONFIGURED_PM';
  ELSIF configured>1 THEN expected_reason:='AMBIGUOUS_CONFIGURED_PM';
  ELSE
    SELECT * INTO pm FROM public."ProjectResponsibility" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND role='PROJECT_MANAGER';
    FOR locked_grant IN SELECT * FROM public."AccessGrant" WHERE "customerId"=NEW."customerId" AND subject IN (NEW.actor,pm.subject)
      AND (("scopeType"='project' AND "scopeId"=NEW."projectId") OR ("scopeType"='portfolio' AND "scopeId"=portfolio)) ORDER BY id FOR SHARE LOOP
      IF locked_grant.subject=pm.subject AND locked_grant.role='project_manager'
        AND (g.id IS NULL OR (g."scopeType"='portfolio' AND locked_grant."scopeType"='project')) THEN g:=locked_grant; END IF;
    END LOOP;
    expected_reason:=CASE WHEN g.id IS NULL THEN 'PM_SCOPE_UNAVAILABLE' ELSE 'ASSIGNED' END;
  END IF;
  IF NEW.reason IS DISTINCT FROM expected_reason THEN RAISE EXCEPTION 'Invalid reconciliation routing'; END IF;
  IF expected_reason='ASSIGNED' AND (NEW."responsibilityId" IS DISTINCT FROM pm.id OR NEW."recipientSubject" IS DISTINCT FROM pm.subject
    OR NEW."grantId" IS DISTINCT FROM g.id OR NEW."grantCustomerId" IS DISTINCT FROM g."customerId" OR NEW."grantSubject" IS DISTINCT FROM g.subject OR NEW."grantRole" IS DISTINCT FROM g.role OR NEW."grantScopeType" IS DISTINCT FROM g."scopeType" OR NEW."grantScopeId" IS DISTINCT FROM g."scopeId") THEN RAISE EXCEPTION 'Invalid reconciliation grant snapshot'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.require_milestone_reconciliation_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='MilestoneReconciliationRequest' THEN
    IF NOT EXISTS (SELECT 1 FROM public."MilestoneReconciliationRequest" WHERE id=NEW.id AND sealed) OR NOT public.valid_milestone_reconciliation_request(NEW.id) THEN RAISE EXCEPTION 'Incomplete reconciliation request cannot commit'; END IF;
  ELSIF TG_TABLE_NAME='MilestoneReconciliationCheck' THEN
    IF NOT public.valid_milestone_reconciliation_check(NEW.id) THEN RAISE EXCEPTION 'Incomplete reconciliation check cannot commit'; END IF;
  ELSIF TG_TABLE_NAME='MilestoneReconciliationAssignment' THEN
    IF NOT public.valid_milestone_reconciliation_assignment(NEW.id) OR NOT EXISTS (SELECT 1 FROM public."MilestoneReconciliationRequest" WHERE id=NEW."requestId" AND sealed) THEN RAISE EXCEPTION 'Incomplete reconciliation assignment cannot commit'; END IF;
  ELSE
    IF NEW."reconciliationCheckId" IS NOT NULL AND NOT public.valid_milestone_reconciliation_check(NEW."reconciliationCheckId") THEN RAISE EXCEPTION 'Unowned reconciliation assessment cannot commit'; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER reconciliation_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public."MilestoneReconciliationRequest" FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_reconciliation_request();
CREATE TRIGGER reconciliation_check_guard BEFORE INSERT OR UPDATE OR DELETE ON public."MilestoneReconciliationCheck" FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_reconciliation_check();
CREATE TRIGGER reconciliation_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON public."MilestoneReconciliationAssignment" FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_reconciliation_assignment();
CREATE CONSTRAINT TRIGGER reconciliation_assessment_commit AFTER INSERT ON public."MilestoneConsistencyAssessment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_milestone_reconciliation_complete();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['MilestoneReconciliationRequest','MilestoneReconciliationCheck','MilestoneReconciliationAssignment'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER reconciliation_commit AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_milestone_reconciliation_complete()',name);
    EXECUTE format('CREATE TRIGGER reconciliation_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation()',name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.valid_milestone_reconciliation_assignment(uuid),public.valid_milestone_reconciliation_request(uuid),public.valid_milestone_reconciliation_check(uuid),public.guard_milestone_reconciliation_request(),public.guard_milestone_reconciliation_check(),public.guard_milestone_reconciliation_assignment(),public.require_milestone_reconciliation_complete() FROM PUBLIC;
