-- FR-EVD-007/009/012, NFR-REL-001/002: additive scalar request ownership.
-- Released scalar and milestone proofs remain untouched and cannot be adopted.
ALTER TABLE public."FactAssessment" ADD COLUMN "scalarReconciliationCheckId" uuid;
CREATE UNIQUE INDEX "FactAssessment_scalarReconciliationCheckId_key" ON public."FactAssessment"("scalarReconciliationCheckId");
ALTER TABLE public."FactAssessment" DROP CONSTRAINT "FactAssessment_capture_shape";
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactAssessment_capture_shape" CHECK (
  ("captureKind"='SCALAR' AND "milestoneAssessmentId" IS NULL AND "scalarReconciliationCheckId" IS NULL)
  OR ("captureKind"='MILESTONE' AND "milestoneAssessmentId" IS NOT NULL AND "scalarReconciliationCheckId" IS NULL)
  OR ("captureKind"='SCALAR_REQUEST' AND "milestoneAssessmentId" IS NULL AND "scalarReconciliationCheckId" IS NOT NULL));
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "ScalarAssessment_owner_key" UNIQUE ("customerId","projectId","factId",id,"scalarReconciliationCheckId");

CREATE TABLE public."ScalarReconciliationRequest" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL, "factId" uuid NOT NULL,
  "ruleRevision" varchar(48) NOT NULL, "originalAssessmentId" uuid NOT NULL UNIQUE, "originCommandId" uuid NOT NULL UNIQUE,
  "contributorHash" char(64) NOT NULL, "contributorIdentity" text NOT NULL,
  "createdBy" varchar(256) NOT NULL, "createdAt" timestamptz(3) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'OPEN', "auditEventId" uuid NOT NULL UNIQUE, sealed boolean NOT NULL DEFAULT false,
  CONSTRAINT "ScalarRequest_scope_key" UNIQUE ("customerId","projectId","factId",id),
  CONSTRAINT "ScalarRequest_proof_key" UNIQUE ("customerId","projectId","factId","originalAssessmentId"),
  CONSTRAINT "ScalarRequest_birth_key" UNIQUE ("customerId","projectId","factId",id,"originCommandId","originalAssessmentId"),
  CONSTRAINT "ScalarRequest_business_key" UNIQUE ("customerId","projectId","factId","ruleRevision","contributorHash"),
  CONSTRAINT "ScalarRequest_shape" CHECK (
    state='OPEN' AND "ruleRevision"='scalar-authority-conflict/v1' AND "contributorHash" ~ '^[a-f0-9]{64}$'
    AND octet_length("contributorIdentity") BETWEEN 1 AND 4194304 AND length(btrim("createdBy"))>0 AND isfinite("createdAt")
    AND "contributorHash"=encode(sha256(convert_to("contributorIdentity",'UTF8')),'hex')),
  CONSTRAINT "ScalarRequest_fact_fk" FOREIGN KEY ("customerId","projectId","factId") REFERENCES public."ProjectFact"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarRequest_assessment_fk" FOREIGN KEY ("customerId","projectId","factId","originalAssessmentId") REFERENCES public."FactAssessment"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarRequest_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX "ScalarRequest_page_idx" ON public."ScalarReconciliationRequest"("customerId","projectId","createdAt",id);
CREATE TABLE public."ScalarReconciliationCheck" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL, "factId" uuid NOT NULL,
  subject varchar(256) NOT NULL, "idempotencyKey" varchar(128) NOT NULL, "requestHash" char(64) NOT NULL,
  "assessmentId" uuid NOT NULL UNIQUE, "requestId" uuid, outcome varchar(16) NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL, "auditEventId" uuid NOT NULL UNIQUE,
  CONSTRAINT "ScalarCheck_retry_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  CONSTRAINT "ScalarCheck_owner_key" UNIQUE ("customerId","projectId","factId","assessmentId",id),
  CONSTRAINT "ScalarCheck_birth_key" UNIQUE ("customerId","projectId","factId","requestId",id,"assessmentId"),
  CONSTRAINT "ScalarCheck_shape" CHECK (
    length(btrim(subject))>0 AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$' AND "requestHash" ~ '^[a-f0-9]{64}$' AND isfinite("occurredAt")
    AND ((outcome='NO_REQUEST' AND "requestId" IS NULL) OR (outcome IN ('CREATED','REUSED') AND "requestId" IS NOT NULL))),
  CONSTRAINT "ScalarCheck_assessment_fk" FOREIGN KEY ("customerId","projectId","factId","assessmentId",id) REFERENCES public."FactAssessment"("customerId","projectId","factId",id,"scalarReconciliationCheckId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ScalarCheck_request_fk" FOREIGN KEY ("customerId","projectId","factId","requestId") REFERENCES public."ScalarReconciliationRequest"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarCheck_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "ScalarAssessment_check_fk" FOREIGN KEY ("customerId","projectId","factId",id,"scalarReconciliationCheckId") REFERENCES public."ScalarReconciliationCheck"("customerId","projectId","factId","assessmentId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public."ScalarReconciliationRequest" ADD CONSTRAINT "ScalarRequest_birth_fk" FOREIGN KEY ("customerId","projectId","factId",id,"originCommandId","originalAssessmentId") REFERENCES public."ScalarReconciliationCheck"("customerId","projectId","factId","requestId",id,"assessmentId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public."ScalarReconciliationAssignment" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL, "factId" uuid NOT NULL, "requestId" uuid NOT NULL,
  revision integer NOT NULL, "expectedRevision" integer NOT NULL, "previousAssignmentId" uuid,
  kind varchar(16) NOT NULL, "recipientSubject" varchar(256), "responsibilityId" uuid, reason varchar(32) NOT NULL,
  actor varchar(256) NOT NULL, "occurredAt" timestamptz(3) NOT NULL, "auditEventId" uuid NOT NULL UNIQUE,
  "idempotencyKey" varchar(128), "requestHash" char(64), "capturedPortfolioId" uuid NOT NULL, "configurationReceiptId" uuid,
  "grantId" uuid, "grantCustomerId" uuid, "grantSubject" varchar(256), "grantScopeType" varchar(16), "grantScopeId" uuid, "grantRole" varchar(32),
  CONSTRAINT "ScalarAssignment_revision_key" UNIQUE ("customerId","projectId","factId","requestId",revision),
  CONSTRAINT "ScalarAssignment_predecessor_key" UNIQUE ("customerId","projectId","factId","requestId",revision,id),
  CONSTRAINT "ScalarAssignment_retry_key" UNIQUE ("customerId","projectId","requestId",actor,"idempotencyKey"),
  CONSTRAINT "ScalarAssignment_shape" CHECK (
    revision BETWEEN 1 AND 2147483647 AND "expectedRevision" BETWEEN 0 AND 2147483646 AND revision::bigint="expectedRevision"::bigint+1
    AND length(btrim(actor))>0 AND isfinite("occurredAt")
    AND "occurredAt">=TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "occurredAt"<TIMESTAMPTZ '10000-01-01 00:00:00+00'
    AND ((kind='INITIAL' AND revision=1 AND "previousAssignmentId" IS NULL AND "idempotencyKey" IS NULL AND "requestHash" IS NULL)
      OR (kind='REFRESH' AND revision>1 AND "previousAssignmentId" IS NOT NULL AND "idempotencyKey" IS NOT NULL AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$' AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$'))
    AND ((reason='ASSIGNED' AND "recipientSubject" IS NOT NULL AND length(btrim("recipientSubject"))>0 AND "responsibilityId" IS NOT NULL
      AND "grantId" IS NOT NULL AND "grantCustomerId" IS NOT NULL AND "grantSubject" IS NOT NULL AND "grantScopeType" IS NOT NULL AND "grantScopeId" IS NOT NULL AND "grantRole" IS NOT NULL
      AND "grantCustomerId"="customerId" AND "grantSubject"="recipientSubject" AND "grantRole"='project_manager'
      AND (("grantScopeType"='project' AND "grantScopeId"="projectId") OR ("grantScopeType"='portfolio' AND "grantScopeId"="capturedPortfolioId")))
      OR (reason IN ('NO_CONFIGURED_PM','AMBIGUOUS_CONFIGURED_PM','PM_SCOPE_UNAVAILABLE') AND "recipientSubject" IS NULL AND "responsibilityId" IS NULL
        AND "grantId" IS NULL AND "grantCustomerId" IS NULL AND "grantSubject" IS NULL AND "grantScopeType" IS NULL AND "grantScopeId" IS NULL AND "grantRole" IS NULL))),
  CONSTRAINT "ScalarAssignment_request_fk" FOREIGN KEY ("customerId","projectId","factId","requestId") REFERENCES public."ScalarReconciliationRequest"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarAssignment_responsibility_fk" FOREIGN KEY ("customerId","projectId","responsibilityId") REFERENCES public."ProjectResponsibility"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarAssignment_previous_fk" FOREIGN KEY ("customerId","projectId","factId","requestId","expectedRevision","previousAssignmentId") REFERENCES public."ScalarReconciliationAssignment"("customerId","projectId","factId","requestId",revision,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarAssignment_configuration_fk" FOREIGN KEY ("customerId","projectId","configurationReceiptId") REFERENCES public."CanonicalCreationReceipt"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarAssignment_portfolio_fk" FOREIGN KEY ("customerId","capturedPortfolioId") REFERENCES public."Portfolio"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ScalarAssignment_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

-- Only immutable UUID/type tokens enter the ASCII identity. Actual values remain
-- bound by valid_fact_assessment and the original retained version rows.
CREATE FUNCTION public.scalar_reconciliation_identity(target uuid) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a public."FactAssessment"%ROWTYPE; body text; answer text; n integer;
BEGIN
  SELECT * INTO a FROM public."FactAssessment" WHERE id=target;
  IF NOT FOUND OR NOT a.sealed OR public.valid_fact_assessment(target) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid scalar reconciliation assessment'; END IF;
  IF a.complete IS NOT TRUE OR a.result->>'status'<>'CONFLICTING' OR a.result->>'revalidationRequired'<>'false'
    OR a.result->>'reconciliationRequired'<>'true' OR a."policyRevisionId" IS NULL
    OR a.result->'policy'->>'conflictBehavior'<>'REQUEST_RECONCILIATION' THEN RETURN NULL; END IF;
  IF jsonb_array_length(a.result->'versions')>1000 OR jsonb_array_length(a.result->'conflicts')>1002
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.result->'versions') v WHERE v->>'visibility'<>'available') THEN RAISE EXCEPTION 'Invalid scalar reconciliation assessment'; END IF;
  WITH contributors AS (
    SELECT DISTINCT v.value::uuid AS id FROM jsonb_array_elements(a.result->'conflicts') c CROSS JOIN LATERAL jsonb_array_elements_text(c->'versionIds') v
  ), tuples AS (
    SELECT v.id,format('["%s","%s","%s",["%s"]]',v.id,v."sourceId",v.value->>'type',v."evidenceId") AS value
    FROM contributors c JOIN public."FactAssessmentVersion" av ON av."assessmentId"=a.id AND av."versionId"=c.id
    JOIN public."ProjectFactVersion" v ON v.id=av."versionId" AND v."customerId"=a."customerId" AND v."projectId"=a."projectId" AND v."factId"=a."factId"
  ) SELECT count(*),string_agg(value,',' ORDER BY id::text COLLATE "C") INTO n,body FROM tuples;
  IF n<2 OR n>1000 OR n<>(SELECT count(DISTINCT v.value) FROM jsonb_array_elements(a.result->'conflicts') c CROSS JOIN LATERAL jsonb_array_elements_text(c->'versionIds') v) THEN RAISE EXCEPTION 'Invalid scalar reconciliation assessment'; END IF;
  answer:=format('["scalar-authority-conflict/v1","%s","%s","%s","%s",[%s]]',a."customerId",a."projectId",a."factId",a."policyRevisionId",body);
  IF octet_length(answer)>4194304 THEN RAISE EXCEPTION 'Invalid scalar reconciliation assessment'; END IF;
  RETURN answer;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid scalar reconciliation assessment';
END $$;

-- Historical routing deliberately does not read live grants or newly configured
-- project state. A null receipt records a genuine legacy unassigned snapshot.
CREATE FUNCTION public.valid_scalar_reconciliation_assignment(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a public."ScalarReconciliationAssignment"%ROWTYPE; r public."ScalarReconciliationRequest"%ROWTYPE; configured integer;
BEGIN
  SELECT * INTO a FROM public."ScalarReconciliationAssignment" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=a."requestId" AND "customerId"=a."customerId" AND "projectId"=a."projectId" AND "factId"=a."factId";
  IF NOT FOUND OR r.state<>'OPEN' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=a."auditEventId" AND "customerId"=a."customerId" AND actor=a.actor AND ("occurredAt" AT TIME ZONE 'UTC')=a."occurredAt" AND event='scalar.reconciliation.assigned'
    AND detail=jsonb_build_object('projectId',a."projectId",'factId',a."factId",'requestId',a."requestId",'assignmentId',a.id,'revision',a.revision,'reason',a.reason)) THEN RETURN false; END IF;
  IF a.kind='INITIAL' THEN
    IF a.revision<>1 OR a."expectedRevision"<>0 OR a."previousAssignmentId" IS NOT NULL OR a.actor<>r."createdBy" OR a."occurredAt"<>r."createdAt" THEN RETURN false; END IF;
  ELSIF a.kind='REFRESH' THEN
    IF a."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","requestId":"%s","expectedAssignmentRevision":%s}',a."projectId",a."requestId",a."expectedRevision"),'UTF8')),'hex') THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."ScalarReconciliationAssignment" p WHERE p.id=a."previousAssignmentId" AND p."customerId"=a."customerId" AND p."projectId"=a."projectId" AND p."factId"=a."factId" AND p."requestId"=a."requestId" AND p.revision=a."expectedRevision" AND a.revision::bigint=p.revision::bigint+1 AND p."occurredAt"<=a."occurredAt") THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF a."configurationReceiptId" IS NULL THEN RETURN a.reason='NO_CONFIGURED_PM'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."CanonicalCreationReceipt" c JOIN public."CanonicalProject" p ON p.id=c."projectId" AND p."customerId"=c."customerId" AND p.sealed
    WHERE c.id=a."configurationReceiptId" AND c."customerId"=a."customerId" AND c."projectId"=a."projectId" AND c.operation='PROJECT' AND c."portfolioId"=a."capturedPortfolioId") THEN RETURN false; END IF;
  SELECT count(*) INTO configured FROM public."ProjectResponsibility" WHERE "customerId"=a."customerId" AND "projectId"=a."projectId" AND role='PROJECT_MANAGER';
  IF a.reason='NO_CONFIGURED_PM' THEN RETURN configured=0; END IF;
  IF a.reason='AMBIGUOUS_CONFIGURED_PM' THEN RETURN configured>1; END IF;
  IF configured<>1 THEN RETURN false; END IF;
  IF a.reason='PM_SCOPE_UNAVAILABLE' THEN RETURN true; END IF;
  RETURN a.reason='ASSIGNED' AND EXISTS (SELECT 1 FROM public."ProjectResponsibility" WHERE id=a."responsibilityId" AND "customerId"=a."customerId" AND "projectId"=a."projectId" AND subject=a."recipientSubject" AND role='PROJECT_MANAGER');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.valid_scalar_reconciliation_request(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."ScalarReconciliationRequest"%ROWTYPE; a public."FactAssessment"%ROWTYPE; c public."ScalarReconciliationCheck"%ROWTYPE; initial_id uuid;
BEGIN
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=target;
  IF NOT FOUND OR r.state<>'OPEN' THEN RETURN false; END IF;
  SELECT * INTO a FROM public."FactAssessment" WHERE id=r."originalAssessmentId" AND "customerId"=r."customerId" AND "projectId"=r."projectId" AND "factId"=r."factId";
  IF NOT FOUND OR NOT a.sealed OR a."captureKind"<>'SCALAR_REQUEST' OR a."scalarReconciliationCheckId" IS DISTINCT FROM r."originCommandId"
    OR a.subject<>r."createdBy" OR a."asOf"<>r."createdAt" OR public.scalar_reconciliation_identity(a.id) IS DISTINCT FROM r."contributorIdentity" THEN RETURN false; END IF;
  SELECT * INTO c FROM public."ScalarReconciliationCheck" WHERE id=r."originCommandId" AND "customerId"=r."customerId" AND "projectId"=r."projectId" AND "factId"=r."factId";
  IF NOT FOUND OR c.outcome<>'CREATED' OR c."requestId" IS DISTINCT FROM r.id OR c."assessmentId"<>a.id OR c.subject<>a.subject OR c."occurredAt"<>a."asOf" OR c."requestHash"<>a."requestHash" THEN RETURN false; END IF;
  IF c."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","factId":"%s"}',c."projectId",c."factId"),'UTF8')),'hex') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=r."auditEventId" AND "customerId"=r."customerId" AND actor=r."createdBy" AND ("occurredAt" AT TIME ZONE 'UTC')=r."createdAt" AND event='scalar.reconciliation.requested'
    AND detail=jsonb_build_object('projectId',r."projectId",'factId',r."factId",'requestId',r.id,'assessmentId',r."originalAssessmentId",'checkId',r."originCommandId")) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=c."auditEventId" AND "customerId"=c."customerId" AND actor=c.subject AND ("occurredAt" AT TIME ZONE 'UTC')=c."occurredAt" AND event='scalar.reconciliation.checked'
    AND detail=jsonb_build_object('projectId',c."projectId",'factId',c."factId",'checkId',c.id,'assessmentId',c."assessmentId",'requestId',c."requestId",'outcome',c.outcome)) THEN RETURN false; END IF;
  SELECT id INTO initial_id FROM public."ScalarReconciliationAssignment" WHERE "customerId"=r."customerId" AND "projectId"=r."projectId" AND "factId"=r."factId" AND "requestId"=r.id AND revision=1;
  RETURN initial_id IS NOT NULL AND public.valid_scalar_reconciliation_assignment(initial_id) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.valid_scalar_reconciliation_check(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE c public."ScalarReconciliationCheck"%ROWTYPE; a public."FactAssessment"%ROWTYPE; r public."ScalarReconciliationRequest"%ROWTYPE; identity text;
BEGIN
  SELECT * INTO c FROM public."ScalarReconciliationCheck" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO a FROM public."FactAssessment" WHERE id=c."assessmentId" AND "customerId"=c."customerId" AND "projectId"=c."projectId" AND "factId"=c."factId";
  IF NOT FOUND OR NOT a.sealed OR a."captureKind"<>'SCALAR_REQUEST' OR a."scalarReconciliationCheckId" IS DISTINCT FROM c.id OR a.subject<>c.subject OR a."asOf"<>c."occurredAt" OR a."requestHash"<>c."requestHash" THEN RETURN false; END IF;
  IF c."requestHash" IS DISTINCT FROM encode(sha256(convert_to(format('{"projectId":"%s","factId":"%s"}',c."projectId",c."factId"),'UTF8')),'hex') THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" WHERE id=c."auditEventId" AND "customerId"=c."customerId" AND actor=c.subject AND ("occurredAt" AT TIME ZONE 'UTC')=c."occurredAt" AND event='scalar.reconciliation.checked'
    AND detail=jsonb_build_object('projectId',c."projectId",'factId',c."factId",'checkId',c.id,'assessmentId',c."assessmentId",'requestId',c."requestId",'outcome',c.outcome)) THEN RETURN false; END IF;
  identity:=public.scalar_reconciliation_identity(a.id);
  IF c.outcome='NO_REQUEST' THEN RETURN c."requestId" IS NULL AND identity IS NULL; END IF;
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=c."requestId" AND "customerId"=c."customerId" AND "projectId"=c."projectId" AND "factId"=c."factId";
  IF NOT FOUND OR NOT r.sealed OR identity IS NULL OR r."contributorIdentity" IS DISTINCT FROM identity OR public.valid_scalar_reconciliation_request(r.id) IS NOT TRUE THEN RETURN false; END IF;
  RETURN (c.outcome='CREATED' AND r."originCommandId"=c.id AND r."originalAssessmentId"=a.id)
    OR (c.outcome='REUSED' AND r."originCommandId"<>c.id AND r."originalAssessmentId"<>a.id);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.guard_scalar_reconciliation_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scalar reconciliation request is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Scalar reconciliation request must start unsealed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."FactAssessment" WHERE id=NEW."originalAssessmentId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW."factId" AND sealed AND "captureKind"='SCALAR_REQUEST' AND "scalarReconciliationCheckId"=NEW."originCommandId")
      OR public.scalar_reconciliation_identity(NEW."originalAssessmentId") IS NULL THEN RAISE EXCEPTION 'Scalar reconciliation requires its fresh positive proof'; END IF;
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') OR public.valid_scalar_reconciliation_request(NEW.id) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid scalar reconciliation request seal'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_scalar_reconciliation_check() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."ScalarReconciliationRequest"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Scalar reconciliation check is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF NEW.outcome<>'NO_REQUEST' THEN
    SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=NEW."requestId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW."factId";
    IF NOT FOUND OR r.state<>'OPEN' OR (NEW.outcome='CREATED' AND (r.sealed OR r."originCommandId"<>NEW.id OR r."originalAssessmentId"<>NEW."assessmentId")) OR (NEW.outcome='REUSED' AND (NOT r.sealed OR r."originCommandId"=NEW.id)) THEN RAISE EXCEPTION 'Invalid scalar reconciliation check birth'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_scalar_reconciliation_assignment() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."ScalarReconciliationRequest"%ROWTYPE; configured integer; pm public."ProjectResponsibility"%ROWTYPE; g public."AccessGrant"%ROWTYPE; locked_grant public."AccessGrant"%ROWTYPE; portfolio uuid; receipt uuid; expected_reason text; last_revision integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Scalar reconciliation assignment is immutable'; END IF;
  SELECT "portfolioId" INTO portfolio FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  SELECT c.id INTO receipt FROM public."CanonicalCreationReceipt" c JOIN public."CanonicalProject" p ON p.id=c."projectId" AND p."customerId"=c."customerId" AND p.sealed
    WHERE c."customerId"=NEW."customerId" AND c."projectId"=NEW."projectId" AND c.operation='PROJECT';
  IF NEW."capturedPortfolioId" IS DISTINCT FROM portfolio OR NEW."configurationReceiptId" IS DISTINCT FROM receipt THEN RAISE EXCEPTION 'Invalid scalar reconciliation configuration snapshot'; END IF;
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=NEW."requestId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW."factId";
  IF NOT FOUND OR r.state<>'OPEN' OR (NEW.kind='INITIAL' AND r.sealed) OR (NEW.kind='REFRESH' AND NOT r.sealed) THEN RAISE EXCEPTION 'Invalid scalar reconciliation assignment parent'; END IF;
  SELECT COALESCE(max(revision),0) INTO last_revision FROM public."ScalarReconciliationAssignment" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW."factId" AND "requestId"=r.id;
  IF NEW."expectedRevision"<>last_revision OR NEW.revision::bigint<>last_revision::bigint+1 THEN RAISE EXCEPTION 'Invalid scalar reconciliation assignment revision'; END IF;
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
  IF NEW.reason IS DISTINCT FROM expected_reason OR (receipt IS NULL AND expected_reason<>'NO_CONFIGURED_PM') THEN RAISE EXCEPTION 'Invalid scalar reconciliation routing'; END IF;
  IF expected_reason='ASSIGNED' AND (NEW."responsibilityId" IS DISTINCT FROM pm.id OR NEW."recipientSubject" IS DISTINCT FROM pm.subject
    OR NEW."grantId" IS DISTINCT FROM g.id OR NEW."grantCustomerId" IS DISTINCT FROM g."customerId" OR NEW."grantSubject" IS DISTINCT FROM g.subject OR NEW."grantRole" IS DISTINCT FROM g.role OR NEW."grantScopeType" IS DISTINCT FROM g."scopeType" OR NEW."grantScopeId" IS DISTINCT FROM g."scopeId") THEN RAISE EXCEPTION 'Invalid scalar reconciliation grant snapshot'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.require_scalar_reconciliation_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='ScalarReconciliationRequest' THEN
    IF NOT EXISTS (SELECT 1 FROM public."ScalarReconciliationRequest" WHERE id=NEW.id AND sealed) OR public.valid_scalar_reconciliation_request(NEW.id) IS NOT TRUE THEN RAISE EXCEPTION 'Incomplete scalar reconciliation request cannot commit'; END IF;
  ELSIF TG_TABLE_NAME='ScalarReconciliationCheck' THEN
    IF public.valid_scalar_reconciliation_check(NEW.id) IS NOT TRUE THEN RAISE EXCEPTION 'Incomplete scalar reconciliation check cannot commit'; END IF;
  ELSIF TG_TABLE_NAME='ScalarReconciliationAssignment' THEN
    IF public.valid_scalar_reconciliation_assignment(NEW.id) IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM public."ScalarReconciliationRequest" WHERE id=NEW."requestId" AND sealed) THEN RAISE EXCEPTION 'Incomplete scalar reconciliation assignment cannot commit'; END IF;
  ELSE
    IF NEW."scalarReconciliationCheckId" IS NOT NULL AND public.valid_scalar_reconciliation_check(NEW."scalarReconciliationCheckId") IS NOT TRUE THEN RAISE EXCEPTION 'Unowned scalar reconciliation assessment cannot commit'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER scalar_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ScalarReconciliationRequest" FOR EACH ROW EXECUTE FUNCTION public.guard_scalar_reconciliation_request();
CREATE TRIGGER scalar_check_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ScalarReconciliationCheck" FOR EACH ROW EXECUTE FUNCTION public.guard_scalar_reconciliation_check();
CREATE TRIGGER scalar_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON public."ScalarReconciliationAssignment" FOR EACH ROW EXECUTE FUNCTION public.guard_scalar_reconciliation_assignment();
CREATE CONSTRAINT TRIGGER scalar_assessment_commit AFTER INSERT ON public."FactAssessment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_scalar_reconciliation_complete();
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['ScalarReconciliationRequest','ScalarReconciliationCheck','ScalarReconciliationAssignment'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER scalar_reconciliation_commit AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_scalar_reconciliation_complete()',name);
    EXECUTE format('CREATE TRIGGER scalar_reconciliation_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation()',name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.scalar_reconciliation_identity(uuid),public.valid_scalar_reconciliation_assignment(uuid),public.valid_scalar_reconciliation_request(uuid),public.valid_scalar_reconciliation_check(uuid),public.guard_scalar_reconciliation_request(),public.guard_scalar_reconciliation_check(),public.guard_scalar_reconciliation_assignment(),public.require_scalar_reconciliation_complete() FROM PUBLIC;
