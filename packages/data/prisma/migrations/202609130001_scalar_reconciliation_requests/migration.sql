-- FR-EVD-007/009/012, FR-ADM-005, NFR-REL-001/002: durable generic scalar reconciliation requests.
-- Additive migration 7. Preserves all released milestone history without modification.

ALTER TABLE public."FactAssessment" ADD COLUMN "reconciliationCheckId" uuid;
CREATE UNIQUE INDEX "FactAssessment_reconciliationCheckId_key" ON public."FactAssessment"("reconciliationCheckId");
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactReconciliationAssessment_owner_key" UNIQUE ("customerId","projectId","factId",id,"reconciliationCheckId");

CREATE TABLE public."ScalarReconciliationRequest" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL,
  "originalAssessmentId" uuid NOT NULL UNIQUE,
  "originCommandId" uuid NOT NULL UNIQUE,
  "policyRevisionId" uuid NOT NULL,
  "contributorHash" char(64) NOT NULL,
  "contributorIdentity" text NOT NULL,
  "createdBy" varchar(256) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'OPEN',
  "resolvedAssessmentId" uuid,
  "auditEventId" uuid NOT NULL UNIQUE,
  sealed boolean NOT NULL DEFAULT false,
  CONSTRAINT "ScalarReconciliationRequest_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ScalarReconciliationRequest_proof_key" UNIQUE ("customerId","projectId","factId","originalAssessmentId"),
  CONSTRAINT "ScalarReconciliationRequest_birth_key" UNIQUE ("customerId","projectId","factId",id,"originCommandId","originalAssessmentId"),
  CONSTRAINT "ScalarReconciliationRequest_business_key" UNIQUE ("customerId","projectId","factId","policyRevisionId","contributorHash"),
  CONSTRAINT "ScalarReconciliationRequest_shape" CHECK (
    state IN ('OPEN','RESOLVED')
    AND "contributorHash" ~ '^[a-f0-9]{64}$'
    AND octet_length("contributorIdentity") BETWEEN 1 AND 4194304
    AND length(btrim("createdBy"))>0 AND isfinite("createdAt")
    AND "contributorHash"=encode(sha256(convert_to("contributorIdentity",'UTF8')),'hex')
    AND ((state='OPEN' AND "resolvedAssessmentId" IS NULL) OR (state='RESOLVED' AND "resolvedAssessmentId" IS NOT NULL))),
  CONSTRAINT "ScalarReconciliationRequest_fact_fk" FOREIGN KEY ("customerId","projectId","factId","factType") REFERENCES public."ProjectFact"("customerId","projectId",id,"factType") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationRequest_assessment_fk" FOREIGN KEY ("customerId","projectId","factId","originalAssessmentId") REFERENCES public."FactAssessment"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationRequest_resolved_fk" FOREIGN KEY ("customerId","projectId","factId","resolvedAssessmentId") REFERENCES public."FactAssessment"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationRequest_policy_fk" FOREIGN KEY ("customerId","projectId","factType","policyRevisionId") REFERENCES public."AuthorityPolicyRevision"("customerId","projectId","factType",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationRequest_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX "ScalarReconciliationRequest_page_idx" ON public."ScalarReconciliationRequest"("customerId","projectId","createdAt",id);

CREATE TABLE public."ScalarReconciliationCheck" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL,
  subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL,
  "assessmentId" uuid NOT NULL UNIQUE,
  "requestId" uuid,
  outcome varchar(16) NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  CONSTRAINT "ScalarReconciliationCheck_retry_key" UNIQUE ("customerId","projectId","factId",subject,"idempotencyKey"),
  CONSTRAINT "ScalarReconciliationCheck_owner_key" UNIQUE ("customerId","projectId","factId","assessmentId",id),
  CONSTRAINT "ScalarReconciliationCheck_birth_key" UNIQUE ("customerId","projectId","factId","requestId",id,"assessmentId"),
  CONSTRAINT "ScalarReconciliationCheck_shape" CHECK (
    length(btrim(subject))>0 AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "requestHash" ~ '^[a-f0-9]{64}$' AND isfinite("occurredAt")
    AND ((outcome='NO_REQUEST' AND "requestId" IS NULL) OR (outcome IN ('CREATED','REUSED','RESOLVED') AND "requestId" IS NOT NULL))),
  CONSTRAINT "ScalarReconciliationCheck_assessment_fk" FOREIGN KEY ("customerId","projectId","factId","assessmentId",id) REFERENCES public."FactAssessment"("customerId","projectId","factId",id,"reconciliationCheckId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ScalarReconciliationCheck_request_fk" FOREIGN KEY ("customerId","projectId","requestId") REFERENCES public."ScalarReconciliationRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationCheck_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "ScalarReconciliationAssessment_check_fk" FOREIGN KEY ("customerId","projectId","factId",id,"reconciliationCheckId") REFERENCES public."ScalarReconciliationCheck"("customerId","projectId","factId","assessmentId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."ScalarReconciliationRequest" ADD CONSTRAINT "ScalarReconciliationRequest_birth_fk" FOREIGN KEY ("customerId","projectId","factId",id,"originCommandId","originalAssessmentId") REFERENCES public."ScalarReconciliationCheck"("customerId","projectId","factId","requestId",id,"assessmentId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public."ScalarReconciliationAssignment" (
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
  CONSTRAINT "ScalarReconciliationAssignment_revision_key" UNIQUE ("customerId","projectId","requestId",revision),
  CONSTRAINT "ScalarReconciliationAssignment_predecessor_key" UNIQUE ("customerId","projectId","requestId",revision,id),
  CONSTRAINT "ScalarReconciliationAssignment_retry_key" UNIQUE ("customerId","projectId","requestId",actor,"idempotencyKey"),
  CONSTRAINT "ScalarReconciliationAssignment_shape" CHECK (
    revision BETWEEN 1 AND 2147483647 AND "expectedRevision" BETWEEN 0 AND 2147483646
    AND revision::bigint="expectedRevision"::bigint+1 AND length(btrim(actor))>0 AND isfinite("occurredAt")
    AND ((kind='INITIAL' AND revision=1 AND "previousAssignmentId" IS NULL AND "idempotencyKey" IS NULL AND "requestHash" IS NULL)
      OR (kind='REFRESH' AND revision>1 AND "previousAssignmentId" IS NOT NULL AND "idempotencyKey" IS NOT NULL AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$' AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$'))
    AND ((reason='ASSIGNED' AND "recipientSubject" IS NOT NULL AND length(btrim("recipientSubject"))>0 AND "responsibilityId" IS NOT NULL
      AND "grantId" IS NOT NULL AND "grantCustomerId" IS NOT NULL AND "grantSubject" IS NOT NULL AND "grantScopeType" IS NOT NULL AND "grantScopeId" IS NOT NULL AND "grantRole" IS NOT NULL
      AND "grantCustomerId"="customerId" AND "grantSubject"="recipientSubject" AND "grantScopeType" IN ('project','portfolio') AND "grantRole"='project_manager')
      OR (reason IN ('NO_CONFIGURED_PM','AMBIGUOUS_CONFIGURED_PM','PM_SCOPE_UNAVAILABLE') AND "recipientSubject" IS NULL AND "responsibilityId" IS NULL
        AND "grantId" IS NULL AND "grantCustomerId" IS NULL AND "grantSubject" IS NULL AND "grantScopeType" IS NULL AND "grantScopeId" IS NULL AND "grantRole" IS NULL))),
  CONSTRAINT "ScalarReconciliationAssignment_request_fk" FOREIGN KEY ("customerId","projectId","requestId") REFERENCES public."ScalarReconciliationRequest"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationAssignment_responsibility_fk" FOREIGN KEY ("customerId","projectId","responsibilityId") REFERENCES public."ProjectResponsibility"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationAssignment_previous_fk" FOREIGN KEY ("customerId","projectId","requestId","expectedRevision","previousAssignmentId") REFERENCES public."ScalarReconciliationAssignment"("customerId","projectId","requestId",revision,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarReconciliationAssignment_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION public.valid_scalar_reconciliation_assignment(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a public."ScalarReconciliationAssignment"%ROWTYPE; r public."ScalarReconciliationRequest"%ROWTYPE; configured integer; portfolio uuid;
BEGIN
  SELECT * INTO a FROM public."ScalarReconciliationAssignment" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=a."requestId" AND "customerId"=a."customerId" AND "projectId"=a."projectId";
  IF NOT FOUND OR r.state NOT IN ('OPEN','RESOLVED') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=a."auditEventId" AND "customerId"=a."customerId" AND actor=a.actor AND "occurredAt"=a."occurredAt" AND event='scalar.reconciliation.assigned'
    AND detail=jsonb_build_object('projectId',a."projectId",'requestId',a."requestId",'assignmentId',a.id,'revision',a.revision,'reason',a.reason)) THEN RETURN false; END IF;
  IF a.kind='INITIAL' THEN
    IF a.revision<>1 OR a."expectedRevision"<>0 OR a."previousAssignmentId" IS NOT NULL OR a.actor<>r."createdBy" OR a."occurredAt"<>r."createdAt" THEN RETURN false; END IF;
  ELSIF a.kind='REFRESH' THEN
    IF a."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","requestId":"%s","expectedAssignmentRevision":%s}',a."projectId",a."requestId",a."expectedRevision"),'UTF8')),'hex') THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."ScalarReconciliationAssignment" p WHERE p.id=a."previousAssignmentId" AND p."customerId"=a."customerId" AND p."projectId"=a."projectId" AND p."requestId"=a."requestId" AND p.revision=a."expectedRevision" AND a.revision::bigint=p.revision::bigint+1 AND p."occurredAt"<=a."occurredAt") THEN RETURN false; END IF;
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

CREATE FUNCTION public.valid_scalar_reconciliation_request(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."ScalarReconciliationRequest"%ROWTYPE; a public."FactAssessment"%ROWTYPE; c public."ScalarReconciliationCheck"%ROWTYPE; res public."FactAssessment"%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=target;
  IF NOT FOUND OR r.state NOT IN ('OPEN','RESOLVED') THEN RETURN false; END IF;
  SELECT * INTO a FROM public."FactAssessment" WHERE id=r."originalAssessmentId" AND "customerId"=r."customerId" AND "projectId"=r."projectId" AND "factId"=r."factId";
  IF NOT FOUND OR NOT a.sealed OR a."reconciliationCheckId" IS DISTINCT FROM r."originCommandId" OR a.subject<>r."createdBy"
    OR a.result->>'status'<>'CONFLICTING' OR NOT public.valid_fact_assessment(a.id) THEN RETURN false; END IF;
  SELECT * INTO c FROM public."ScalarReconciliationCheck" WHERE id=r."originCommandId" AND "customerId"=r."customerId" AND "projectId"=r."projectId" AND "factId"=r."factId";
  IF NOT FOUND OR c.outcome<>'CREATED' OR c."requestId" IS DISTINCT FROM r.id OR c."assessmentId"<>a.id OR c.subject<>a.subject OR c."occurredAt"<>a."asOf" THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=r."auditEventId" AND "customerId"=r."customerId" AND actor=r."createdBy" AND "occurredAt"=r."createdAt" AND event='scalar.reconciliation.requested'
    AND detail=jsonb_build_object('projectId',r."projectId",'factId',r."factId",'requestId',r.id,'assessmentId',r."originalAssessmentId",'checkId',r."originCommandId")) THEN RETURN false; END IF;
  IF r.state='RESOLVED' THEN
    IF r."resolvedAssessmentId" IS NULL THEN RETURN false; END IF;
    SELECT * INTO res FROM public."FactAssessment" WHERE id=r."resolvedAssessmentId" AND "customerId"=r."customerId" AND "projectId"=r."projectId" AND "factId"=r."factId";
    IF NOT FOUND OR NOT res.sealed OR res.result->>'status'='CONFLICTING' OR NOT public.valid_fact_assessment(res.id) THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.valid_scalar_reconciliation_check(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public."ScalarReconciliationCheck"%ROWTYPE; a public."FactAssessment"%ROWTYPE; r public."ScalarReconciliationRequest"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public."ScalarReconciliationCheck" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO a FROM public."FactAssessment" WHERE id=c."assessmentId" AND "customerId"=c."customerId" AND "projectId"=c."projectId" AND "factId"=c."factId";
  IF NOT FOUND OR a.subject<>c.subject OR a."asOf"<>c."occurredAt" OR NOT a.sealed OR a."reconciliationCheckId" IS DISTINCT FROM c.id OR NOT public.valid_fact_assessment(a.id) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=c."auditEventId" AND "customerId"=c."customerId" AND actor=c.subject AND "occurredAt"=c."occurredAt" AND event='scalar.reconciliation.checked'
    AND detail=jsonb_build_object('projectId',c."projectId",'factId',c."factId",'checkId',c.id,'outcome',c.outcome)) THEN RETURN false; END IF;
  IF c.outcome='NO_REQUEST' THEN
    RETURN c."requestId" IS NULL AND a.result->>'status'<>'CONFLICTING';
  END IF;
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=c."requestId" AND "customerId"=c."customerId" AND "projectId"=c."projectId" AND "factId"=c."factId";
  IF NOT FOUND OR NOT r.sealed THEN RETURN false; END IF;
  IF c.outcome='CREATED' THEN
    RETURN a.result->>'status'='CONFLICTING' AND r.state='OPEN' AND r."originCommandId"=c.id AND r."originalAssessmentId"=a.id;
  ELSIF c.outcome='REUSED' THEN
    RETURN a.result->>'status'='CONFLICTING' AND r.state='OPEN' AND (r."originCommandId"<>c.id OR r."originalAssessmentId"<>a.id);
  ELSIF c.outcome='RESOLVED' THEN
    RETURN a.result->>'status'<>'CONFLICTING' AND r.state='RESOLVED' AND r."resolvedAssessmentId"=a.id;
  ELSE
    RETURN false;
  END IF;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE CONSTRAINT TRIGGER "ScalarReconciliationAssignment_audit_trigger"
AFTER INSERT OR UPDATE ON public."ScalarReconciliationAssignment"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.audit_deferred_check('public.valid_scalar_reconciliation_assignment');

CREATE CONSTRAINT TRIGGER "ScalarReconciliationRequest_audit_trigger"
AFTER INSERT OR UPDATE ON public."ScalarReconciliationRequest"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.audit_deferred_check('public.valid_scalar_reconciliation_request');

CREATE CONSTRAINT TRIGGER "ScalarReconciliationCheck_audit_trigger"
AFTER INSERT OR UPDATE ON public."ScalarReconciliationCheck"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.audit_deferred_check('public.valid_scalar_reconciliation_check');
