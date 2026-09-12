-- EXEC-007 Stage 2: immutable canonical state bindings and coherent cross-fact proof.
ALTER TABLE public."AuditEvent" ADD CONSTRAINT "AuditEvent_customer_key" UNIQUE ("customerId",id);
ALTER TABLE public."ProjectFact" ADD COLUMN "bindingBirthId" uuid;
ALTER TABLE public."ProjectFact" ADD CONSTRAINT "ProjectFact_bindingBirthId_key" UNIQUE ("bindingBirthId");
ALTER TABLE public."ProjectFact" ADD CONSTRAINT "ProjectFact_binding_birth_key" UNIQUE ("customerId","projectId","bindingBirthId");
ALTER TABLE public."ProjectFactVersion" ADD CONSTRAINT "ProjectFactVersion_exact_evidence_key" UNIQUE ("customerId","projectId","factId",id,"sourceId","evidenceId");
ALTER TABLE public."RequiredWorkItem" ADD CONSTRAINT "RequiredWorkItem_exact_key" UNIQUE ("customerId","projectId","milestoneId","workItemId",id);
ALTER TABLE public."CanonicalCreationReceipt" ADD CONSTRAINT "CanonicalCreationReceipt_assessment_key" UNIQUE ("customerId","projectId",id);

CREATE TABLE public."CanonicalStateBinding" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "targetKind" varchar(16) NOT NULL,
  "milestoneId" uuid,
  "workItemId" uuid,
  field varchar(16) NOT NULL DEFAULT 'state',
  "factId" uuid NOT NULL UNIQUE,
  "factType" varchar(96) NOT NULL,
  "createdBy" varchar(256) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL,
  sealed boolean NOT NULL DEFAULT false,
  CONSTRAINT "CanonicalStateBinding_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "CanonicalStateBinding_fact_key" UNIQUE ("customerId","projectId","factId"),
  CONSTRAINT "CanonicalStateBinding_typed_fact_key" UNIQUE ("customerId","projectId","factId","factType"),
  CONSTRAINT "CanonicalStateBinding_exact_fact_key" UNIQUE ("customerId","projectId",id,"factId"),
  CONSTRAINT "CanonicalStateBinding_milestone_key" UNIQUE ("customerId","projectId","milestoneId",field),
  CONSTRAINT "CanonicalStateBinding_work_item_key" UNIQUE ("customerId","projectId","workItemId",field),
  CONSTRAINT "CanonicalStateBinding_shape" CHECK (
    field='state' AND "factType" ~ '^canonical[.]state[.][a-f0-9]{32}$'
    AND length("createdBy") BETWEEN 1 AND 256 AND "createdBy"=btrim("createdBy")
    AND (("targetKind"='MILESTONE' AND "milestoneId" IS NOT NULL AND "workItemId" IS NULL)
      OR ("targetKind"='WORK_ITEM' AND "milestoneId" IS NULL AND "workItemId" IS NOT NULL))
  ),
  FOREIGN KEY ("customerId","projectId") REFERENCES public."CanonicalProject"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","milestoneId") REFERENCES public."Milestone"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","workItemId") REFERENCES public."WorkItem"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","factType") REFERENCES public."ProjectFact"("customerId","projectId",id,"factType") ON DELETE RESTRICT ON UPDATE RESTRICT
);
ALTER TABLE public."ProjectFact" ADD CONSTRAINT "ProjectFact_binding_birth_fkey"
  FOREIGN KEY ("customerId","projectId","bindingBirthId")
  REFERENCES public."CanonicalStateBinding"("customerId","projectId",id)
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public."CanonicalStateBindingReceipt" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL,
  "bindingId" uuid NOT NULL UNIQUE,
  "factId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "evidenceId" uuid NOT NULL,
  "versionId" uuid NOT NULL,
  "initialSourceAccessRevision" integer NOT NULL,
  "initialSourceAccessState" varchar(16) NOT NULL,
  "initialReaderSubject" varchar(256) NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  CONSTRAINT "CanonicalStateBindingReceipt_request_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  CONSTRAINT "CanonicalStateBindingReceipt_binding_key" UNIQUE ("customerId","projectId","bindingId","factId"),
  CONSTRAINT "CanonicalStateBindingReceipt_shape" CHECK (
    length(subject) BETWEEN 1 AND 256 AND subject=btrim(subject)
    AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "initialSourceAccessRevision"=2 AND "initialSourceAccessState"='AVAILABLE'
    AND "initialReaderSubject"=subject
  ),
  CONSTRAINT "StateBindingReceipt_binding_fk" FOREIGN KEY ("customerId","projectId","bindingId","factId") REFERENCES public."CanonicalStateBinding"("customerId","projectId",id,"factId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StateBindingReceipt_source_fk" FOREIGN KEY ("customerId","projectId","factId","sourceId") REFERENCES public."FactSource"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StateBindingReceipt_evidence_fk" FOREIGN KEY ("customerId","projectId","factId","sourceId","evidenceId") REFERENCES public."FactEvidence"("customerId","projectId","factId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StateBindingReceipt_version_fk" FOREIGN KEY ("customerId","projectId","factId","versionId","sourceId","evidenceId") REFERENCES public."ProjectFactVersion"("customerId","projectId","factId",id,"sourceId","evidenceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "StateBindingReceipt_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public."MilestoneConsistencyAssessment" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "milestoneId" uuid NOT NULL,
  "canonicalReceiptId" uuid NOT NULL,
  "ruleRevision" varchar(48) NOT NULL,
  enabled boolean NOT NULL,
  "asOf" timestamptz(3) NOT NULL,
  subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL,
  status varchar(32) NOT NULL,
  complete boolean NOT NULL,
  "targetCount" integer NOT NULL,
  "requiredLinkCount" integer NOT NULL,
  "versionCount" integer NOT NULL,
  "evidenceCount" integer NOT NULL,
  "conflictCount" integer NOT NULL,
  "contributorCount" integer NOT NULL,
  result jsonb NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  sealed boolean NOT NULL DEFAULT false,
  CONSTRAINT "MilestoneConsistencyAssessment_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "MilestoneConsistencyAssessment_request_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  CONSTRAINT "MilestoneConsistencyAssessment_shape" CHECK (
    "ruleRevision"='milestone-required-state/v1' AND status IN ('INCOMPLETE','DISABLED','REVALIDATION_REQUIRED','UNKNOWN','NOT_DETECTED','CONFLICTING')
    AND length(subject) BETWEEN 1 AND 256 AND subject=btrim(subject)
    AND "idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$' AND "requestHash" ~ '^[a-f0-9]{64}$'
    AND "targetCount" BETWEEN 0 AND 51 AND "requiredLinkCount" BETWEEN 0 AND 50
    AND "versionCount" BETWEEN 0 AND 1000 AND "evidenceCount" BETWEEN 0 AND 64000
    AND "conflictCount" BETWEEN 0 AND 1000 AND "contributorCount" BETWEEN 0 AND 64000
    AND octet_length(result::text)<=33554432
  ),
  FOREIGN KEY ("customerId","projectId") REFERENCES public."CanonicalProject"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","milestoneId") REFERENCES public."Milestone"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","canonicalReceiptId") REFERENCES public."CanonicalCreationReceipt"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneConsistencyAssessment_audit_fk" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public."FactAssessment" ADD COLUMN "captureKind" varchar(16) NOT NULL DEFAULT 'SCALAR';
ALTER TABLE public."FactAssessment" ADD COLUMN "milestoneAssessmentId" uuid;
ALTER TABLE public."FactAssessment" DROP CONSTRAINT "FactAssessment_request_key";
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactAssessment_request_kind_key" UNIQUE ("customerId","projectId",subject,"captureKind","idempotencyKey");
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactAssessment_milestone_fact_key" UNIQUE ("milestoneAssessmentId","factId");
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactAssessment_capture_shape" CHECK (("captureKind"='SCALAR' AND "milestoneAssessmentId" IS NULL) OR ("captureKind"='MILESTONE' AND "milestoneAssessmentId" IS NOT NULL));
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactAssessment_milestone_parent_fk"
  FOREIGN KEY ("customerId","projectId","milestoneAssessmentId") REFERENCES public."MilestoneConsistencyAssessment"("customerId","projectId",id)
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public."MilestoneConsistencyTarget" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "assessmentId" uuid NOT NULL,
  "targetKind" varchar(16) NOT NULL,
  "milestoneId" uuid,
  "workItemId" uuid,
  "requiredWorkItemId" uuid,
  "bindingId" uuid,
  "factId" uuid,
  "factType" varchar(96),
  "scalarAssessmentId" uuid UNIQUE,
  CONSTRAINT "MilestoneConsistencyTarget_scope_key" UNIQUE ("customerId","projectId","assessmentId",id),
  CONSTRAINT "MilestoneConsistencyTarget_identity_key" UNIQUE ("assessmentId","targetKind","milestoneId","workItemId"),
  CONSTRAINT "MilestoneConsistencyTarget_binding_key" UNIQUE ("assessmentId","bindingId","factId"),
  CONSTRAINT "MilestoneConsistencyTarget_scalar_key" UNIQUE ("customerId","projectId","factId","scalarAssessmentId"),
  CONSTRAINT "MilestoneConsistencyTarget_shape" CHECK (
    (("targetKind"='MILESTONE' AND "milestoneId" IS NOT NULL AND "workItemId" IS NULL AND "requiredWorkItemId" IS NULL)
      OR ("targetKind"='WORK_ITEM' AND "milestoneId" IS NOT NULL AND "workItemId" IS NOT NULL AND "requiredWorkItemId" IS NOT NULL))
    AND (("bindingId" IS NULL AND "factId" IS NULL AND "factType" IS NULL AND "scalarAssessmentId" IS NULL)
      OR ("bindingId" IS NOT NULL AND "factId" IS NOT NULL AND "factType" IS NOT NULL AND "scalarAssessmentId" IS NOT NULL))
  ),
  FOREIGN KEY ("customerId","projectId","assessmentId") REFERENCES public."MilestoneConsistencyAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneConsistencyTarget_milestone_fk" FOREIGN KEY ("customerId","projectId","milestoneId") REFERENCES public."Milestone"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","workItemId") REFERENCES public."WorkItem"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneConsistencyTarget_required_fk" FOREIGN KEY ("customerId","projectId","milestoneId","workItemId","requiredWorkItemId") REFERENCES public."RequiredWorkItem"("customerId","projectId","milestoneId","workItemId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","bindingId") REFERENCES public."CanonicalStateBinding"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","scalarAssessmentId") REFERENCES public."FactAssessment"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public."MilestoneConsistencyContributorVersion" (
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "assessmentId" uuid NOT NULL,
  "targetRowId" uuid NOT NULL,
  "bindingId" uuid NOT NULL,
  "factId" uuid NOT NULL,
  "versionId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "evidenceId" uuid NOT NULL,
  PRIMARY KEY ("assessmentId","targetRowId","versionId","evidenceId"),
  CONSTRAINT "MilestoneContributor_assessment_fk" FOREIGN KEY ("customerId","projectId","assessmentId") REFERENCES public."MilestoneConsistencyAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneContributor_target_fk" FOREIGN KEY ("customerId","projectId","assessmentId","targetRowId") REFERENCES public."MilestoneConsistencyTarget"("customerId","projectId","assessmentId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneContributor_binding_fk" FOREIGN KEY ("customerId","projectId","bindingId","factId") REFERENCES public."CanonicalStateBinding"("customerId","projectId",id,"factId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneContributor_version_fk" FOREIGN KEY ("customerId","projectId","factId","versionId","sourceId","evidenceId") REFERENCES public."ProjectFactVersion"("customerId","projectId","factId",id,"sourceId","evidenceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "MilestoneContributor_evidence_fk" FOREIGN KEY ("customerId","projectId","factId","sourceId","evidenceId") REFERENCES public."FactEvidence"("customerId","projectId","factId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE OR REPLACE FUNCTION public.guard_project_fact_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target_customer uuid; target_project uuid;
BEGIN
  target_customer:=CASE WHEN TG_OP='DELETE' THEN OLD."customerId" ELSE NEW."customerId" END;
  target_project:=CASE WHEN TG_OP='DELETE' THEN OLD."projectId" ELSE NEW."projectId" END;
  PERFORM 1 FROM public."Project" WHERE "customerId"=target_customer AND id=target_project FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fact project unavailable'; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Fact identity is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 THEN RAISE EXCEPTION 'Initial fact revision must be zero'; END IF;
    IF NEW."factType" LIKE 'canonical.state.%' AND (NEW."bindingBirthId" IS NULL OR NEW."factType" !~ '^canonical[.]state[.][a-f0-9]{32}$') THEN RAISE EXCEPTION 'Reserved fact type'; END IF;
    IF NEW."bindingBirthId" IS NOT NULL AND (NEW."factType" !~ '^canonical[.]state[.][a-f0-9]{32}$' OR EXISTS (SELECT 1 FROM public."AuthorityPolicy" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factType"=NEW."factType")) THEN RAISE EXCEPTION 'Invalid binding birth'; END IF;
  ELSE
    IF ROW(NEW.id,NEW."customerId",NEW."projectId",NEW."factType",NEW."createdAt",NEW."bindingBirthId") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."projectId",OLD."factType",OLD."createdAt",OLD."bindingBirthId")
      OR NEW.revision<>OLD.revision+1 OR NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW.id AND revision=NEW.revision)
      THEN RAISE EXCEPTION 'Invalid fact revision transition'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_fact_version_append() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_revision integer; birth uuid;
BEGIN
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  SELECT revision,"bindingBirthId" INTO current_revision,birth FROM public."ProjectFact" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."factId" FOR UPDATE;
  IF current_revision IS NULL OR NEW.revision<>current_revision+1 THEN RAISE EXCEPTION 'Invalid fact append revision'; END IF;
  IF birth IS NOT NULL AND NEW.value NOT IN ('{"type":"text","value":"OPEN"}'::jsonb,'{"type":"text","value":"IN_PROGRESS"}'::jsonb,'{"type":"text","value":"COMPLETE"}'::jsonb,'{"type":"text","value":"CANCELLED"}'::jsonb) THEN RAISE EXCEPTION 'Invalid bound state'; END IF;
  RETURN NEW;
END $$;

-- The executor acquires an UPDATE tuple before BEFORE ROW triggers run.
-- Reject standalone revision writes before that acquisition; only the nested
-- append trigger may advance a fact. Arbitrary manual row-lock SQL is not a
-- supported command workflow and must still handle transaction rollback.
CREATE FUNCTION public.reject_direct_fact_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'Fact revision advances only through a version append'; END $$;
CREATE TRIGGER fact_revision_statement_guard BEFORE UPDATE ON public."ProjectFact"
  FOR EACH STATEMENT WHEN (pg_trigger_depth()=0) EXECUTE FUNCTION public.reject_direct_fact_revision();

CREATE FUNCTION public.guard_fact_source_birth() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fact source project unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fact_source_birth_guard BEFORE INSERT ON public."FactSource"
  FOR EACH ROW EXECUTE FUNCTION public.guard_fact_source_birth();

CREATE FUNCTION public.valid_canonical_state_binding(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE b public."CanonicalStateBinding"%ROWTYPE; r public."CanonicalStateBindingReceipt"%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public."CanonicalStateBinding" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO r FROM public."CanonicalStateBindingReceipt" WHERE "bindingId"=target;
  IF NOT FOUND OR r."factId"<>b."factId" OR r.subject<>b."createdBy" OR r."initialSourceAccessRevision"<>2 OR r."initialSourceAccessState"<>'AVAILABLE' OR r."initialReaderSubject"<>r.subject THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ProjectFact" f WHERE f.id=b."factId" AND f."customerId"=b."customerId" AND f."projectId"=b."projectId" AND f."factType"=b."factType" AND f."bindingBirthId"=b.id AND f.revision>=1) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."ProjectFactVersion" v WHERE v."factId"=b."factId" AND v.value NOT IN (
    '{"type":"text","value":"OPEN"}'::jsonb,'{"type":"text","value":"IN_PROGRESS"}'::jsonb,
    '{"type":"text","value":"COMPLETE"}'::jsonb,'{"type":"text","value":"CANCELLED"}'::jsonb)) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" v JOIN public."FactEvidence" e ON e.id=v."evidenceId" JOIN public."FactSource" s ON s.id=v."sourceId" WHERE v.id=r."versionId" AND v."factId"=b."factId" AND v.revision=1 AND v.provenance='HUMAN_CONFIRMED' AND v."evidenceId"=r."evidenceId" AND v."sourceId"=r."sourceId" AND e."providedBy"=b."createdBy" AND s."providedBy"=b."createdBy") THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."FactSourceAccess" a WHERE a."sourceId"=r."sourceId" AND a.revision>=2) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=b."customerId" AND a.actor=b."createdBy" AND a.event='fact.binding.created' AND a.detail @> jsonb_build_object('projectId',b."projectId",'bindingId',b.id,'factId',b."factId",'versionId',r."versionId",'evidenceId',r."evidenceId")) THEN RETURN false; END IF;
  RETURN (b."targetKind"='MILESTONE' AND EXISTS (SELECT 1 FROM public."Milestone" m WHERE m.id=b."milestoneId" AND m."customerId"=b."customerId" AND m."projectId"=b."projectId"))
    OR (b."targetKind"='WORK_ITEM' AND EXISTS (SELECT 1 FROM public."WorkItem" w WHERE w.id=b."workItemId" AND w."customerId"=b."customerId" AND w."projectId"=b."projectId"));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.guard_authority_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Authority policy identity is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE id=NEW."projectId" AND "customerId"=NEW."customerId" FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 THEN RAISE EXCEPTION 'Initial policy revision must be zero'; END IF;
    IF NEW."factType" LIKE 'canonical.state.%' AND NOT EXISTS (SELECT 1 FROM public."CanonicalStateBinding" b WHERE b."customerId"=NEW."customerId" AND b."projectId"=NEW."projectId" AND b."factType"=NEW."factType" AND b.sealed AND public.valid_canonical_state_binding(b.id)) THEN RAISE EXCEPTION 'Reserved authority target unavailable'; END IF;
  ELSIF (to_jsonb(NEW)-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'revision') OR NEW.revision<>OLD.revision+1
    OR NOT EXISTS (SELECT 1 FROM public."AuthorityPolicyRevision" WHERE "policyId"=NEW.id AND revision=NEW.revision)
    THEN RAISE EXCEPTION 'Invalid policy revision transition'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_canonical_state_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public."Project" WHERE "customerId"=COALESCE(NEW."customerId",OLD."customerId") AND id=COALESCE(NEW."projectId",OLD."projectId") FOR UPDATE;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'State binding is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sealed OR NOT EXISTS (SELECT 1 FROM public."CanonicalProject" p WHERE p.id=NEW."projectId" AND p."customerId"=NEW."customerId" AND p.sealed AND public.valid_canonical_project(p.id))
      OR NOT EXISTS (SELECT 1 FROM public."ProjectFact" f WHERE f.id=NEW."factId" AND f."bindingBirthId"=NEW.id AND f."factType"=NEW."factType") THEN RAISE EXCEPTION 'Invalid state binding birth'; END IF;
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') OR NOT public.valid_canonical_state_binding(NEW.id) THEN RAISE EXCEPTION 'Invalid state binding seal'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_canonical_state_binding_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'State binding receipt is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  PERFORM 1 FROM public."CanonicalStateBinding" WHERE id=NEW."bindingId" AND NOT sealed AND "createdBy"=NEW.subject FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public."FactSourceAccess" a WHERE a."sourceId"=NEW."sourceId" AND a.state='AVAILABLE' AND a.revision=2)
    OR (SELECT count(*) FROM public."FactSourceReader" r WHERE r."sourceId"=NEW."sourceId")<>1
    OR NOT EXISTS (SELECT 1 FROM public."FactSourceReader" r WHERE r."sourceId"=NEW."sourceId" AND r.subject=NEW.subject)
    THEN RAISE EXCEPTION 'Invalid state binding receipt'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.require_canonical_state_binding_sealed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CanonicalStateBinding" WHERE id=NEW.id AND sealed) OR NOT public.valid_canonical_state_binding(NEW.id) THEN RAISE EXCEPTION 'Unsealed state binding cannot commit'; END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER canonical_state_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON public."CanonicalStateBinding" FOR EACH ROW EXECUTE FUNCTION public.guard_canonical_state_binding();
CREATE TRIGGER canonical_state_binding_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public."CanonicalStateBindingReceipt" FOR EACH ROW EXECUTE FUNCTION public.guard_canonical_state_binding_receipt();
CREATE CONSTRAINT TRIGGER canonical_state_binding_commit AFTER INSERT ON public."CanonicalStateBinding" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_canonical_state_binding_sealed();

CREATE FUNCTION public.valid_milestone_consistency_assessment(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE a public."MilestoneConsistencyAssessment"%ROWTYPE; expected_status text; minimal jsonb; links integer; targets integer; bound_targets integer; child_count integer; contributors integer;
  target_row record; assessment_result jsonb; version_ids jsonb; evidence_ids jsonb;
  expected_evaluations jsonb := '[]'::jsonb; expected_dependencies jsonb := '[]'::jsonb; expected_contributors jsonb := '[]'::jsonb;
  expected_contributor_rows integer := 0; expected_identity text; positive boolean;
BEGIN
  SELECT * INTO a FROM public."MilestoneConsistencyAssessment" WHERE id=target;
  IF NOT FOUND OR a."ruleRevision"<>'milestone-required-state/v1' THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."CanonicalProject" p WHERE p.id=a."projectId" AND p."customerId"=a."customerId" AND p.sealed AND public.valid_canonical_project(p.id))
    OR NOT EXISTS (SELECT 1 FROM public."CanonicalCreationReceipt" r WHERE r.id=a."canonicalReceiptId" AND r."projectId"=a."projectId")
    OR NOT EXISTS (SELECT 1 FROM public."AuditEvent" e WHERE e.id=a."auditEventId" AND e."customerId"=a."customerId" AND e.actor=a.subject AND e.event='milestone.consistency.captured' AND e.detail @> jsonb_build_object('projectId',a."projectId",'assessmentId',a.id,'milestoneId',a."milestoneId")) THEN RETURN false; END IF;
  minimal:=jsonb_build_object('scope',jsonb_build_object('customerId',a."customerId",'projectId',a."projectId",'milestoneId',a."milestoneId"),'asOf',public.authority_instant(a."asOf"),'ruleRevision',a."ruleRevision",'status',a.status);
  IF NOT a.complete THEN RETURN a.status='INCOMPLETE' AND a.result=minimal AND a."targetCount"=0 AND a."requiredLinkCount"=0 AND a."versionCount"=0 AND a."evidenceCount"=0 AND a."conflictCount"=0 AND a."contributorCount"=0
    AND NOT EXISTS (SELECT 1 FROM public."FactAssessment" WHERE "milestoneAssessmentId"=a.id)
    AND NOT EXISTS (SELECT 1 FROM public."MilestoneConsistencyTarget" WHERE "assessmentId"=a.id)
    AND NOT EXISTS (SELECT 1 FROM public."MilestoneConsistencyContributorVersion" WHERE "assessmentId"=a.id); END IF;
  SELECT count(*) INTO links FROM public."RequiredWorkItem" WHERE "customerId"=a."customerId" AND "projectId"=a."projectId" AND "milestoneId"=a."milestoneId";
  SELECT count(*),count("bindingId") INTO targets,bound_targets FROM public."MilestoneConsistencyTarget" WHERE "assessmentId"=a.id;
  IF links<>a."requiredLinkCount" OR targets<>a."targetCount" OR targets<>links+1 OR targets>51 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM public."MilestoneConsistencyTarget" WHERE "assessmentId"=a.id AND "targetKind"='MILESTONE' AND "milestoneId"=a."milestoneId")<>1 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."RequiredWorkItem" r WHERE r."customerId"=a."customerId" AND r."projectId"=a."projectId" AND r."milestoneId"=a."milestoneId" AND NOT EXISTS (SELECT 1 FROM public."MilestoneConsistencyTarget" t WHERE t."assessmentId"=a.id AND t."requiredWorkItemId"=r.id AND t."workItemId"=r."workItemId")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."MilestoneConsistencyTarget" t LEFT JOIN public."CanonicalStateBinding" b ON b.id=t."bindingId" LEFT JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId" WHERE t."assessmentId"=a.id AND (t."bindingId" IS NOT NULL AND (
    b.sealed IS DISTINCT FROM true OR NOT public.valid_canonical_state_binding(b.id)
    OR b."factId" IS DISTINCT FROM t."factId" OR b."factType" IS DISTINCT FROM t."factType"
    OR b."targetKind" IS DISTINCT FROM t."targetKind"
    OR (t."targetKind"='MILESTONE' AND b."milestoneId" IS DISTINCT FROM t."milestoneId")
    OR (t."targetKind"='WORK_ITEM' AND b."workItemId" IS DISTINCT FROM t."workItemId")
    OR f."captureKind" IS DISTINCT FROM 'MILESTONE' OR f."milestoneAssessmentId" IS DISTINCT FROM a.id
    OR f."factId" IS DISTINCT FROM t."factId" OR f."asOf" IS DISTINCT FROM a."asOf"
    OR f.complete IS DISTINCT FROM true OR f.sealed IS DISTINCT FROM true OR NOT public.valid_fact_assessment(f.id)))) THEN RETURN false; END IF;
  -- Seal-time absence is an immutable historical snapshot, like the birth
  -- access receipt. Later bindings must not invalidate already sealed UNKNOWN.
  IF NOT a.sealed AND EXISTS (SELECT 1 FROM public."MilestoneConsistencyTarget" t
    JOIN public."CanonicalStateBinding" b ON b."customerId"=t."customerId" AND b."projectId"=t."projectId" AND b."targetKind"=t."targetKind"
      AND ((t."targetKind"='MILESTONE' AND b."milestoneId"=t."milestoneId") OR (t."targetKind"='WORK_ITEM' AND b."workItemId"=t."workItemId"))
    WHERE t."assessmentId"=a.id AND t."bindingId" IS NULL) THEN RETURN false; END IF;
  SELECT count(*) INTO child_count FROM public."FactAssessment" WHERE "milestoneAssessmentId"=a.id;
  IF child_count<>bound_targets OR EXISTS (SELECT 1 FROM public."FactAssessment" f WHERE f."milestoneAssessmentId"=a.id AND (SELECT count(*) FROM public."MilestoneConsistencyTarget" t WHERE t."assessmentId"=a.id AND t."scalarAssessmentId"=f.id)<>1) THEN RETURN false; END IF;
  IF a."versionCount"<>(SELECT COALESCE(sum(f."versionCount"),0) FROM public."FactAssessment" f WHERE f."milestoneAssessmentId"=a.id)
    OR a."evidenceCount"<>a."versionCount" OR a."conflictCount"<>(SELECT COALESCE(sum(f."conflictCount"),0) FROM public."FactAssessment" f WHERE f."milestoneAssessmentId"=a.id) THEN RETURN false; END IF;
  expected_status:=CASE WHEN NOT a.enabled THEN 'DISABLED'
    WHEN EXISTS (SELECT 1 FROM public."FactAssessment" f WHERE f."milestoneAssessmentId"=a.id AND (f.result->>'revalidationRequired')::boolean) THEN 'REVALIDATION_REQUIRED'
    WHEN links=0 OR bound_targets<targets OR EXISTS (SELECT 1 FROM public."FactAssessment" f WHERE f."milestoneAssessmentId"=a.id AND (f.result->>'status'<>'RESOLVED' OR f.result->'resolvedValue'->>'value'='CANCELLED')) THEN 'UNKNOWN'
    WHEN EXISTS (SELECT 1 FROM public."MilestoneConsistencyTarget" t JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId" WHERE t."assessmentId"=a.id AND t."targetKind"='MILESTONE' AND f.result->'resolvedValue'->>'value'='COMPLETE')
      AND EXISTS (SELECT 1 FROM public."MilestoneConsistencyTarget" t JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId" WHERE t."assessmentId"=a.id AND t."targetKind"='WORK_ITEM' AND f.result->'resolvedValue'->>'value' IN ('OPEN','IN_PROGRESS')) THEN 'CONFLICTING'
    ELSE 'NOT_DETECTED' END;
  IF a.status IS DISTINCT FROM expected_status OR a.result->>'status' IS DISTINCT FROM expected_status OR a.result->'scope' IS DISTINCT FROM minimal->'scope' OR a.result->>'asOf' IS DISTINCT FROM public.authority_instant(a."asOf") OR a.result->>'ruleRevision' IS DISTINCT FROM a."ruleRevision" THEN RETURN false; END IF;
  IF expected_status IN ('DISABLED','REVALIDATION_REQUIRED') THEN
    IF a.result<>minimal THEN RETURN false; END IF;
  ELSE
    FOR target_row IN SELECT t.*,CASE WHEN t."targetKind"='MILESTONE' THEN t."milestoneId" ELSE t."workItemId" END AS "targetId",f.result AS scalar_result
      FROM public."MilestoneConsistencyTarget" t LEFT JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId"
      WHERE t."assessmentId"=a.id ORDER BY t."targetKind",CASE WHEN t."targetKind"='MILESTONE' THEN t."milestoneId" ELSE t."workItemId" END LOOP
      assessment_result:=target_row.scalar_result;
      expected_evaluations:=expected_evaluations || jsonb_build_array(jsonb_build_object(
        'targetKind',target_row."targetKind",'targetId',target_row."targetId",
        'binding',CASE WHEN target_row."bindingId" IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
          'id',target_row."bindingId",'customerId',a."customerId",'projectId',a."projectId",'targetKind',target_row."targetKind",
          'targetId',target_row."targetId",'field','state','factId',target_row."factId",'factType',target_row."factType") END,
        'assessment',COALESCE(assessment_result,'null'::jsonb)));
      IF assessment_result IS NOT NULL THEN
        SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY ordinality),'[]'::jsonb) INTO version_ids FROM jsonb_array_elements(assessment_result->'versions') WITH ORDINALITY;
        SELECT COALESCE(jsonb_agg(evidence_id ORDER BY evidence_id),'[]'::jsonb) INTO evidence_ids FROM (
          SELECT DISTINCT evidence #>> '{}' AS evidence_id FROM jsonb_array_elements(assessment_result->'versions') version CROSS JOIN LATERAL jsonb_array_elements(version->'evidenceIds') evidence) listed;
        expected_dependencies:=expected_dependencies || jsonb_build_array(jsonb_build_object('bindingId',target_row."bindingId",'factId',target_row."factId",'versionIds',version_ids,'evidenceIds',evidence_ids));
      END IF;
      positive:=expected_status='CONFLICTING' AND assessment_result->>'status'='RESOLVED' AND
        ((target_row."targetKind"='MILESTONE' AND assessment_result->'resolvedValue'->>'value'='COMPLETE') OR
         (target_row."targetKind"='WORK_ITEM' AND assessment_result->'resolvedValue'->>'value' IN ('OPEN','IN_PROGRESS')));
      IF positive THEN
        expected_contributors:=expected_contributors || jsonb_build_array(jsonb_build_object(
          'targetKind',target_row."targetKind",'targetId',target_row."targetId",'bindingId',target_row."bindingId",'factId',target_row."factId",'factType',target_row."factType",
          'supportingVersionIds',assessment_result->'supportingVersionIds','supportingEvidenceIds',assessment_result->'supportingEvidenceIds'));
        SELECT expected_contributor_rows+COALESCE(sum(jsonb_array_length(version->'evidenceIds')),0)::integer INTO expected_contributor_rows
          FROM jsonb_array_elements(assessment_result->'versions') version
          WHERE assessment_result->'supportingVersionIds' @> jsonb_build_array(version->>'id');
      END IF;
    END LOOP;
    IF a.result->'evaluations' IS DISTINCT FROM expected_evaluations OR a.result->'dependencies' IS DISTINCT FROM expected_dependencies THEN RETURN false; END IF;
    IF expected_status IN ('UNKNOWN','NOT_DETECTED') THEN
      IF NOT (a.result ?& ARRAY['scope','asOf','ruleRevision','status','evaluations','dependencies']) OR a.result-ARRAY['scope','asOf','ruleRevision','status','evaluations','dependencies']<>'{}'::jsonb THEN RETURN false; END IF;
    END IF;
  END IF;
  SELECT count(*) INTO contributors FROM public."MilestoneConsistencyContributorVersion" WHERE "assessmentId"=a.id;
  IF contributors<>a."contributorCount" OR (expected_status<>'CONFLICTING' AND contributors<>0) THEN RETURN false; END IF;
  IF expected_status='CONFLICTING' THEN
    SELECT replace(replace(jsonb_build_array(a."customerId",a."projectId",a."milestoneId",a."ruleRevision",COALESCE(jsonb_agg(tuple ORDER BY tuple::text COLLATE "C"),'[]'::jsonb))::text,': ',':'),', ',',') INTO expected_identity FROM (
      SELECT jsonb_build_array(t."targetKind",CASE WHEN t."targetKind"='MILESTONE' THEN t."milestoneId" ELSE t."workItemId" END,t."bindingId",t."factId",t."factType",version->>'id',
        (SELECT COALESCE(jsonb_agg(evidence #>> '{}' ORDER BY evidence #>> '{}'),'[]'::jsonb) FROM jsonb_array_elements(version->'evidenceIds') evidence)) AS tuple
      FROM public."MilestoneConsistencyTarget" t JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId"
      CROSS JOIN LATERAL jsonb_array_elements(f.result->'versions') version
      WHERE t."assessmentId"=a.id AND f.result->'supportingVersionIds' @> jsonb_build_array(version->>'id')
        AND ((t."targetKind"='MILESTONE' AND f.result->'resolvedValue'->>'value'='COMPLETE') OR (t."targetKind"='WORK_ITEM' AND f.result->'resolvedValue'->>'value' IN ('OPEN','IN_PROGRESS')))) tuples;
    IF contributors=0 OR contributors<>expected_contributor_rows OR a.result->'contributors' IS DISTINCT FROM expected_contributors OR a.result->>'contributorIdentity' IS DISTINCT FROM expected_identity
      OR NOT (a.result ?& ARRAY['scope','asOf','ruleRevision','status','evaluations','dependencies','contributors','contributorIdentity']) OR a.result-ARRAY['scope','asOf','ruleRevision','status','evaluations','dependencies','contributors','contributorIdentity']<>'{}'::jsonb THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public."MilestoneConsistencyContributorVersion" c JOIN public."MilestoneConsistencyTarget" t ON t.id=c."targetRowId" JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId" JOIN public."ProjectFactVersion" v ON v.id=c."versionId"
      WHERE c."assessmentId"=a.id AND (c."bindingId"<>t."bindingId" OR c."factId"<>t."factId" OR NOT (f.result->'supportingVersionIds' @> jsonb_build_array(c."versionId")) OR NOT (v."evidenceId"=c."evidenceId")
        OR NOT ((t."targetKind"='MILESTONE' AND f.result->'resolvedValue'->>'value'='COMPLETE') OR (t."targetKind"='WORK_ITEM' AND f.result->'resolvedValue'->>'value' IN ('OPEN','IN_PROGRESS'))))) THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.guard_assessment_header() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE policy_row public."AuthorityPolicy"%ROWTYPE; conflict_revision integer; parent public."MilestoneConsistencyAssessment"%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Assessment must be assembled before sealing'; END IF;
    PERFORM 1 FROM public."Project" WHERE id=NEW."projectId" AND "customerId"=NEW."customerId" FOR UPDATE;
    IF NEW."captureKind"='MILESTONE' THEN
      SELECT * INTO parent FROM public."MilestoneConsistencyAssessment" WHERE id=NEW."milestoneAssessmentId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" FOR UPDATE;
      IF NOT FOUND OR parent.sealed OR parent.subject<>NEW.subject OR parent."asOf"<>NEW."asOf" OR NOT EXISTS (SELECT 1 FROM public."CanonicalStateBinding" WHERE "factId"=NEW."factId" AND sealed) THEN RAISE EXCEPTION 'Milestone scalar parent unavailable'; END IF;
    END IF;
    SELECT * INTO policy_row FROM public."AuthorityPolicy" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factType"=NEW."factType";
    SELECT max(revision) INTO conflict_revision FROM public."FactAuthorityConflict" WHERE "factId"=NEW."factId";
    IF NEW."factRevision" IS DISTINCT FROM (SELECT revision FROM public."ProjectFact" WHERE id=NEW."factId") OR NEW."policyId" IS DISTINCT FROM policy_row.id OR NEW."policyThroughRevision" IS DISTINCT FROM policy_row.revision OR NEW."conflictThroughRevision" IS DISTINCT FROM conflict_revision THEN RAISE EXCEPTION 'Assessment must pin current publication prefixes'; END IF;
  ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'Assessment is immutable';
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') OR NOT public.valid_fact_assessment(NEW.id) THEN RAISE EXCEPTION 'Invalid assessment seal'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_milestone_consistency_header() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Milestone consistency history is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF TG_OP='INSERT' THEN IF NEW.sealed THEN RAISE EXCEPTION 'Milestone consistency proof must start unsealed'; END IF;
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') OR NOT public.valid_milestone_consistency_assessment(NEW.id) THEN RAISE EXCEPTION 'Invalid milestone consistency seal'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_milestone_consistency_child() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE header_sealed boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Milestone consistency dependency is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  SELECT sealed INTO header_sealed FROM public."MilestoneConsistencyAssessment" WHERE id=NEW."assessmentId" AND "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" FOR UPDATE;
  IF header_sealed IS DISTINCT FROM false THEN RAISE EXCEPTION 'Milestone consistency dependencies are sealed'; END IF;
  IF TG_TABLE_NAME='MilestoneConsistencyTarget' THEN
    IF NEW."bindingId" IS NULL AND EXISTS (SELECT 1 FROM public."CanonicalStateBinding" b
      WHERE b."customerId"=NEW."customerId" AND b."projectId"=NEW."projectId" AND b."targetKind"=NEW."targetKind"
        AND ((NEW."targetKind"='MILESTONE' AND b."milestoneId"=NEW."milestoneId") OR (NEW."targetKind"='WORK_ITEM' AND b."workItemId"=NEW."workItemId")))
      THEN RAISE EXCEPTION 'Existing state binding cannot be omitted'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.require_milestone_consistency_sealed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."MilestoneConsistencyAssessment" WHERE id=NEW.id AND sealed) OR NOT public.valid_milestone_consistency_assessment(NEW.id) THEN RAISE EXCEPTION 'Unsealed milestone consistency proof cannot commit'; END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER milestone_consistency_header_guard BEFORE INSERT OR UPDATE OR DELETE ON public."MilestoneConsistencyAssessment" FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_consistency_header();
CREATE TRIGGER milestone_consistency_target_guard BEFORE INSERT OR UPDATE OR DELETE ON public."MilestoneConsistencyTarget" FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_consistency_child();
CREATE TRIGGER milestone_consistency_contributor_guard BEFORE INSERT OR UPDATE OR DELETE ON public."MilestoneConsistencyContributorVersion" FOR EACH ROW EXECUTE FUNCTION public.guard_milestone_consistency_child();
CREATE CONSTRAINT TRIGGER milestone_consistency_commit AFTER INSERT ON public."MilestoneConsistencyAssessment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_milestone_consistency_sealed();

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['CanonicalStateBinding','CanonicalStateBindingReceipt','MilestoneConsistencyAssessment','MilestoneConsistencyTarget','MilestoneConsistencyContributorVersion'] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation()',lower(name),name);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.guard_project_fact_revision(),public.guard_fact_version_append(),public.guard_authority_policy(),public.valid_canonical_state_binding(uuid),public.guard_canonical_state_binding(),public.guard_canonical_state_binding_receipt(),public.require_canonical_state_binding_sealed(),public.valid_milestone_consistency_assessment(uuid),public.guard_assessment_header(),public.guard_milestone_consistency_header(),public.guard_milestone_consistency_child(),public.require_milestone_consistency_sealed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_direct_fact_revision(),public.guard_fact_source_birth() FROM PUBLIC;
