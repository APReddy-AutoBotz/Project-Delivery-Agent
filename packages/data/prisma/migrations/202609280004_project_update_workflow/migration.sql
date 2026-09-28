-- EXEC-012: versioned reporting policy, read-only assessment snapshots,
-- one open update obligation per project, and an immutable review preview.
CREATE OR REPLACE FUNCTION public.valid_project_update_facts(f jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; seen text[] := ARRAY[]::text[]; kind text; caption text;
BEGIN
  IF jsonb_typeof(f) IS DISTINCT FROM 'array'
    OR jsonb_array_length(f) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(f) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item - 'factType' - 'label' <> '{}'::jsonb
      OR NOT (item ?& ARRAY['factType','label'])
      OR jsonb_typeof(item->'factType') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    kind := item->>'factType'; caption := item->>'label';
    IF kind !~ '^[a-z][a-z0-9_.-]{0,95}$'
      OR octet_length(caption) NOT BETWEEN 1 AND 160
      OR btrim(caption) = '' OR caption ~ '[[:cntrl:]]'
      OR kind = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen,kind);
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.project_update_json_has_values(v jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; k text;
BEGIN
  IF jsonb_typeof(v) = 'object' THEN
    FOR k,item IN SELECT key,value FROM jsonb_each(v) LOOP
      IF lower(k) IN ('value','factvalue','factvalues','resolvedvalue','originalstatement')
        OR public.project_update_json_has_values(item) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(v) = 'array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
      IF public.project_update_json_has_values(item) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN true;
END;
$$;

CREATE TABLE public."ProjectUpdatePolicy" (
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  key varchar(64) NOT NULL CHECK (key='project-update'),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  "changedBy" varchar(256) NOT NULL,
  "changedAt" timestamptz(3) NOT NULL,
  "scheduledScanLastAttemptAt" timestamptz(3),
  CONSTRAINT "ProjectUpdatePolicy_pkey" PRIMARY KEY ("customerId","projectId"),
  CONSTRAINT "ProjectUpdatePolicy_scope_key" UNIQUE ("customerId","projectId",key),
  CONSTRAINT "ProjectUpdatePolicy_project_fkey" FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public."ProjectUpdatePolicyRevision" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  "freshnessWindowSeconds" integer NOT NULL CHECK ("freshnessWindowSeconds" BETWEEN 1 AND 315360000),
  "timeZone" varchar(64) NOT NULL,
  "requiredFacts" jsonb NOT NULL CHECK (public.valid_project_update_facts("requiredFacts")),
  "responsibleSubject" varchar(256) NOT NULL CHECK (btrim("responsibleSubject") <> ''),
  "scheduledScanEnabled" boolean NOT NULL,
  "scheduledServiceSubject" varchar(256),
  "changedBy" varchar(256) NOT NULL,
  "changedAt" timestamptz(3) NOT NULL,
  CONSTRAINT "ProjectUpdatePolicyRevision_counter_key" UNIQUE ("customerId","projectId",revision),
  CONSTRAINT "ProjectUpdatePolicyRevision_scope_key" UNIQUE ("customerId","projectId",id,revision),
  CONSTRAINT "ProjectUpdatePolicyRevision_policy_fkey" FOREIGN KEY ("customerId","projectId")
    REFERENCES public."ProjectUpdatePolicy"("customerId","projectId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdatePolicyRevision_project_fkey" FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdatePolicyRevision_service_check" CHECK (
    ("scheduledScanEnabled" AND "scheduledServiceSubject" IS NOT NULL AND btrim("scheduledServiceSubject") <> '')
    OR (NOT "scheduledScanEnabled" AND "scheduledServiceSubject" IS NULL)
  )
);

CREATE TABLE public."ProjectUpdateAssessment" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "policyRevisionId" uuid NOT NULL,
  "policyRevision" integer NOT NULL,
  "assessedAt" timestamptz(3) NOT NULL,
  input jsonb NOT NULL CHECK (NOT public.project_update_json_has_values(input)),
  result jsonb NOT NULL CHECK (NOT public.project_update_json_has_values(result)),
  dependencies jsonb NOT NULL CHECK (jsonb_typeof(dependencies)='array'
    AND NOT public.project_update_json_has_values(dependencies)),
  "envelopeHash" char(64) NOT NULL CHECK ("envelopeHash" ~ '^[0-9a-f]{64}$'),
  "auditEventId" uuid NOT NULL,
  CONSTRAINT "ProjectUpdateAssessment_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateAssessment_revision_fkey" FOREIGN KEY ("customerId","projectId","policyRevisionId","policyRevision")
    REFERENCES public."ProjectUpdatePolicyRevision"("customerId","projectId",id,revision) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateAssessment_project_fkey" FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateAssessment_audit_fkey" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "ProjectUpdateAssessment_latest_idx"
  ON public."ProjectUpdateAssessment" ("customerId","projectId","assessedAt" DESC,id DESC);

CREATE TABLE public."ProjectUpdateObligation" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "policyRevisionId" uuid NOT NULL,
  "policyRevision" integer NOT NULL,
  "assessmentId" uuid NOT NULL,
  "cycleHash" char(64) NOT NULL CHECK ("cycleHash" ~ '^[0-9a-f]{64}$'),
  "sourceDateField" varchar(64) NOT NULL CHECK ("sourceDateField" IN ('project.createdAt','project.latestValidUpdateAt')),
  "sourceDate" timestamptz(3) NOT NULL,
  "freshnessThresholdAt" timestamptz(3) NOT NULL,
  "responsibleSubject" varchar(256) NOT NULL CHECK (btrim("responsibleSubject") <> ''),
  "requiredFacts" jsonb NOT NULL CHECK (public.valid_project_update_facts("requiredFacts")),
  state varchar(16) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL,
  "supersededAt" timestamptz(3),
  CONSTRAINT "ProjectUpdateObligation_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdateObligation_revision_fkey" FOREIGN KEY ("customerId","projectId","policyRevisionId","policyRevision")
    REFERENCES public."ProjectUpdatePolicyRevision"("customerId","projectId",id,revision) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateObligation_assessment_fkey" FOREIGN KEY ("customerId","projectId","assessmentId")
    REFERENCES public."ProjectUpdateAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateObligation_project_fkey" FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdateObligation_state_check" CHECK (
    (state='OPEN' AND "supersededAt" IS NULL)
    OR (state='SUPERSEDED' AND "supersededAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "ProjectUpdateObligation_one_open_per_project"
  ON public."ProjectUpdateObligation" ("customerId","projectId") WHERE state='OPEN';
CREATE INDEX "ProjectUpdateObligation_project_idx"
  ON public."ProjectUpdateObligation" ("customerId","projectId","createdAt" DESC,id DESC);

CREATE TABLE public."ProjectUpdatePreview" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "obligationId" uuid NOT NULL,
  "assessmentId" uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  state varchar(16) NOT NULL DEFAULT 'CURRENT' CHECK (state IN ('CURRENT','SUPERSEDED')),
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview)='object'
    AND NOT public.project_update_json_has_values(preview)),
  "envelopeHash" char(64) NOT NULL CHECK ("envelopeHash" ~ '^[0-9a-f]{64}$'),
  "createdAt" timestamptz(3) NOT NULL,
  CONSTRAINT "ProjectUpdatePreview_revision_key" UNIQUE ("customerId","projectId","obligationId",revision),
  CONSTRAINT "ProjectUpdatePreview_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "ProjectUpdatePreview_obligation_fkey" FOREIGN KEY ("customerId","projectId","obligationId")
    REFERENCES public."ProjectUpdateObligation"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectUpdatePreview_assessment_fkey" FOREIGN KEY ("customerId","projectId","assessmentId")
    REFERENCES public."ProjectUpdateAssessment"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ProjectUpdatePreview_one_current_per_obligation"
  ON public."ProjectUpdatePreview" ("customerId","projectId","obligationId")
  WHERE state='CURRENT';
CREATE INDEX "ProjectUpdatePreview_project_idx"
  ON public."ProjectUpdatePreview" ("customerId","projectId","createdAt" DESC,id DESC);

CREATE OR REPLACE FUNCTION public.prevent_project_update_immutable_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project update records are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER "ProjectUpdatePolicyRevision_immutable"
  BEFORE UPDATE OR DELETE ON public."ProjectUpdatePolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_project_update_immutable_rewrite();
CREATE TRIGGER "ProjectUpdateAssessment_immutable"
  BEFORE UPDATE OR DELETE ON public."ProjectUpdateAssessment"
  FOR EACH ROW EXECUTE FUNCTION public.prevent_project_update_immutable_rewrite();

CREATE OR REPLACE FUNCTION public.guard_project_update_preview()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'project update previews cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
    OR OLD.state <> 'CURRENT'
    OR NEW.state <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'project update preview content is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectUpdatePreview_immutable"
  BEFORE UPDATE OR DELETE ON public."ProjectUpdatePreview"
  FOR EACH ROW EXECUTE FUNCTION public.guard_project_update_preview();

CREATE OR REPLACE FUNCTION public.guard_project_update_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'project update obligations cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-'state'-'supersededAt') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'supersededAt')
    OR OLD.state <> 'OPEN'
    OR NEW.state <> 'SUPERSEDED'
    OR NEW."supersededAt" IS NULL THEN
    RAISE EXCEPTION 'project update obligation content is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ProjectUpdateObligation_immutable"
  BEFORE UPDATE OR DELETE ON public."ProjectUpdateObligation"
  FOR EACH ROW EXECUTE FUNCTION public.guard_project_update_obligation();

DO $$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public."ProjectUpdatePolicy" OWNER TO pdaa_migrate';
    EXECUTE 'ALTER TABLE public."ProjectUpdatePolicyRevision" OWNER TO pdaa_migrate';
    EXECUTE 'ALTER TABLE public."ProjectUpdateAssessment" OWNER TO pdaa_migrate';
    EXECUTE 'ALTER TABLE public."ProjectUpdateObligation" OWNER TO pdaa_migrate';
    EXECUTE 'ALTER TABLE public."ProjectUpdatePreview" OWNER TO pdaa_migrate';
    EXECUTE 'ALTER FUNCTION public.valid_project_update_facts(jsonb) OWNER TO pdaa_migrate';
    EXECUTE 'ALTER FUNCTION public.project_update_json_has_values(jsonb) OWNER TO pdaa_migrate';
    EXECUTE 'ALTER FUNCTION public.prevent_project_update_immutable_rewrite() OWNER TO pdaa_migrate';
    EXECUTE 'ALTER FUNCTION public.guard_project_update_preview() OWNER TO pdaa_migrate';
    EXECUTE 'ALTER FUNCTION public.guard_project_update_obligation() OWNER TO pdaa_migrate';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.valid_project_update_facts(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_update_json_has_values(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prevent_project_update_immutable_rewrite() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_project_update_preview() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_project_update_obligation() FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.valid_project_update_facts(jsonb) TO pdaa_api';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.project_update_json_has_values(jsonb) TO pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT,UPDATE ON TABLE public."ProjectUpdatePolicy" TO pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT ON TABLE public."ProjectUpdatePolicyRevision" TO pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT ON TABLE public."ProjectUpdateAssessment" TO pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT ON TABLE public."ProjectUpdateObligation" TO pdaa_api';
    EXECUTE 'GRANT UPDATE ("state","supersededAt") ON TABLE public."ProjectUpdateObligation" TO pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT ON TABLE public."ProjectUpdatePreview" TO pdaa_api';
    EXECUTE 'GRANT UPDATE ("state") ON TABLE public."ProjectUpdatePreview" TO pdaa_api';
  END IF;
  IF to_regrole('pdaa_backup') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public."ProjectUpdatePolicy" TO pdaa_backup';
    EXECUTE 'GRANT SELECT ON TABLE public."ProjectUpdatePolicyRevision" TO pdaa_backup';
    EXECUTE 'GRANT SELECT ON TABLE public."ProjectUpdateAssessment" TO pdaa_backup';
    EXECUTE 'GRANT SELECT ON TABLE public."ProjectUpdateObligation" TO pdaa_backup';
    EXECUTE 'GRANT SELECT ON TABLE public."ProjectUpdatePreview" TO pdaa_backup';
  END IF;
END $$;
