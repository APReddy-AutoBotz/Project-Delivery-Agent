-- FR-ADM-005, FR-EVD-003/004/006/007/009/010/012, NFR-SEC-001.
-- Additive policy history and sealed assessments. Existing migration bytes stay intact.
ALTER TABLE "ProjectFact" ADD CONSTRAINT "ProjectFact_typed_scope_key" UNIQUE ("customerId","projectId",id,"factType");
CREATE TABLE "AuthorityPolicy" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL, revision integer NOT NULL DEFAULT 0,
  CHECK ("factType" ~ '^[a-z][a-z0-9_.-]{0,95}$'), CHECK (revision >= 0),
  UNIQUE ("customerId","projectId","factType"),
  CONSTRAINT "AuthorityPolicy_scope_key" UNIQUE ("customerId","projectId","factType",id),
  FOREIGN KEY ("customerId","projectId") REFERENCES "Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "AuthorityPolicyRevision" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL, "policyId" uuid NOT NULL, revision integer NOT NULL,
  "recordedAt" timestamptz(3) NOT NULL, "recordedBy" varchar(256) NOT NULL,
  "effectiveAt" timestamptz(3) NOT NULL, state varchar(16) NOT NULL, definition jsonb,
  CHECK (revision > 0), CHECK (public.nonblank_fact_text("recordedBy")),
  CHECK ("recordedAt" >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "recordedAt" < TIMESTAMPTZ '10000-01-01 00:00:00+00'),
  CHECK ("effectiveAt" >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "effectiveAt" < TIMESTAMPTZ '10000-01-01 00:00:00+00'),
  CHECK ((state='DISABLED' AND definition IS NULL) OR (state='ENABLED' AND definition IS NOT NULL)),
  CONSTRAINT "AuthorityPolicyRevision_scope_key" UNIQUE ("customerId","projectId","factType",id),
  CONSTRAINT "AuthorityPolicyRevision_counter_key" UNIQUE ("customerId","projectId","factType","policyId",revision),
  FOREIGN KEY ("customerId","projectId","factType","policyId") REFERENCES "AuthorityPolicy"("customerId","projectId","factType",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "AuthorityPolicyReceipt" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL, subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL, "requestHash" char(64) NOT NULL, "revisionId" uuid NOT NULL,
  CHECK (public.nonblank_fact_text(subject)), CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$'),
  CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AuthorityPolicyReceipt_request_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  FOREIGN KEY ("customerId","projectId","factType","revisionId") REFERENCES "AuthorityPolicyRevision"("customerId","projectId","factType",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactAuthorityConflict" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL, "factType" varchar(96) NOT NULL,
  "leftVersionId" uuid NOT NULL, "rightVersionId" uuid NOT NULL,
  "policyRevisionId" uuid NOT NULL, "detectedAt" timestamptz(3) NOT NULL, revision integer NOT NULL,
  CHECK (revision > 0),
  CONSTRAINT "FactAuthorityConflict_revision_key" UNIQUE ("customerId","projectId","factId",revision),
  CHECK ("leftVersionId" < "rightVersionId"),
  CHECK ("detectedAt" >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "detectedAt" < TIMESTAMPTZ '10000-01-01 00:00:00+00'),
  CONSTRAINT "FactAuthorityConflict_scope_key" UNIQUE ("customerId","projectId","factId",id),
  CONSTRAINT "FactAuthorityConflict_pair_key" UNIQUE ("customerId","projectId","factId","leftVersionId","rightVersionId"),
  FOREIGN KEY ("customerId","projectId","factId","factType") REFERENCES "ProjectFact"("customerId","projectId",id,"factType") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","leftVersionId") REFERENCES "ProjectFactVersion"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","rightVersionId") REFERENCES "ProjectFactVersion"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factType","policyRevisionId") REFERENCES "AuthorityPolicyRevision"("customerId","projectId","factType",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactAssessment" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL, "factType" varchar(96) NOT NULL, "factRevision" integer NOT NULL,
  "policyId" uuid, "policyThroughRevision" integer, "policyRevisionId" uuid,
  "asOf" timestamptz(3) NOT NULL, subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL, "requestHash" char(64) NOT NULL,
  "evaluatorVersion" integer NOT NULL DEFAULT 1, complete boolean NOT NULL,
  "versionCount" integer NOT NULL, "conflictCount" integer NOT NULL, "conflictThroughRevision" integer, result jsonb NOT NULL,
  sealed boolean NOT NULL DEFAULT false,
  CHECK ("factRevision" >= 0 AND "versionCount" BETWEEN 0 AND 1000 AND "conflictCount" BETWEEN 0 AND 1000),
  CHECK (("policyId" IS NULL AND "policyThroughRevision" IS NULL AND "policyRevisionId" IS NULL)
    OR ("policyId" IS NOT NULL AND "policyThroughRevision" IS NOT NULL AND "policyThroughRevision" > 0)),
  CHECK ("evaluatorVersion"=1), CHECK (public.nonblank_fact_text(subject)),
  CHECK ("asOf" >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "asOf" < TIMESTAMPTZ '10000-01-01 00:00:00+00'),
  CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$'), CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(result)='object' AND octet_length(result::text) <= 33554432),
  CONSTRAINT "FactAssessment_scope_key" UNIQUE ("customerId","projectId","factId",id),
  CONSTRAINT "FactAssessment_request_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  FOREIGN KEY ("customerId","projectId","factId","factType") REFERENCES "ProjectFact"("customerId","projectId",id,"factType") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","conflictThroughRevision") REFERENCES "FactAuthorityConflict"("customerId","projectId","factId",revision) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factType","policyRevisionId") REFERENCES "AuthorityPolicyRevision"("customerId","projectId","factType",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factType","policyId","policyThroughRevision") REFERENCES "AuthorityPolicyRevision"("customerId","projectId","factType","policyId",revision) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactAssessmentVersion" (
  "customerId" uuid NOT NULL, "projectId" uuid NOT NULL, "factId" uuid NOT NULL,
  "assessmentId" uuid NOT NULL, "versionId" uuid NOT NULL, "sourceAccessRevision" integer NOT NULL,
  CHECK ("sourceAccessRevision" >= 0),
  CONSTRAINT "FactAssessmentVersion_pkey" PRIMARY KEY ("assessmentId","versionId"),
  FOREIGN KEY ("customerId","projectId","factId","assessmentId") REFERENCES "FactAssessment"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","versionId") REFERENCES "ProjectFactVersion"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactAssessmentConflict" (
  "customerId" uuid NOT NULL, "projectId" uuid NOT NULL, "factId" uuid NOT NULL,
  "assessmentId" uuid NOT NULL, "conflictId" uuid NOT NULL,
  CONSTRAINT "FactAssessmentConflict_pkey" PRIMARY KEY ("assessmentId","conflictId"),
  FOREIGN KEY ("customerId","projectId","factId","assessmentId") REFERENCES "FactAssessment"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","factId","conflictId") REFERENCES "FactAuthorityConflict"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.valid_authority_definition(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tier jsonb; selector jsonb; previous jsonb := '[]'::jsonb; v jsonb; duration numeric;
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d - 'tiers' - 'conflictBehavior' <> '{}'::jsonb
    OR NOT (d ?& ARRAY['tiers','conflictBehavior']) OR d->>'conflictBehavior' NOT IN ('RETAIN_CONFLICT','REQUEST_RECONCILIATION')
    OR jsonb_typeof(d->'conflictBehavior') IS DISTINCT FROM 'string'
    OR jsonb_typeof(d->'tiers') IS DISTINCT FROM 'array' OR octet_length(d::text)>262144
    THEN RETURN false; END IF;
  IF jsonb_array_length(d->'tiers') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
  FOR tier IN SELECT value FROM jsonb_array_elements(d->'tiers') LOOP
    IF jsonb_typeof(tier) IS DISTINCT FROM 'object' OR tier - 'selectors' <> '{}'::jsonb
      OR jsonb_typeof(tier->'selectors') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(tier->'selectors') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
    FOR selector IN SELECT value FROM jsonb_array_elements(tier->'selectors') LOOP
      IF jsonb_typeof(selector) IS DISTINCT FROM 'object'
        OR NOT (selector ?& ARRAY['sourceType','instanceId','requiredApproval','validity'])
        OR selector - 'sourceType' - 'instanceId' - 'requiredApproval' - 'validity' <> '{}'::jsonb
        OR jsonb_typeof(selector->'sourceType') IS DISTINCT FROM 'string'
        OR selector->>'sourceType' !~ '^[a-z][a-z0-9_.-]{0,95}$'
        OR selector->>'requiredApproval' NOT IN ('APPROVED','NOT_REQUIRED')
        OR jsonb_typeof(selector->'requiredApproval') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF selector->'instanceId' <> 'null'::jsonb AND (jsonb_typeof(selector->'instanceId') IS DISTINCT FROM 'string'
        OR selector->>'instanceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(previous) p WHERE p->>'sourceType'=selector->>'sourceType'
        AND (p->'instanceId'='null'::jsonb OR selector->'instanceId'='null'::jsonb OR p->'instanceId'=selector->'instanceId')) THEN RETURN false; END IF;
      previous := previous || jsonb_build_array(selector);
      v := selector->'validity';
      IF v <> 'null'::jsonb THEN
        IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT(v ?& ARRAY['basis','durationMs'])
          OR v - 'basis' - 'durationMs' <> '{}'::jsonb OR v->>'basis' NOT IN ('effectiveAt','observedAt')
          OR jsonb_typeof(v->'basis') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'durationMs') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
        duration := (v->>'durationMs')::numeric;
        IF duration<1 OR duration>9007199254740991 OR trunc(duration)<>duration THEN RETURN false; END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE "AuthorityPolicyRevision" ADD CHECK (definition IS NULL OR public.valid_authority_definition(definition));
CREATE FUNCTION public.valid_authority_sources(c uuid,p uuid,f varchar,d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE selector jsonb;
BEGIN
  IF d IS NULL THEN RETURN true; END IF;
  IF NOT public.valid_authority_definition(d) THEN RETURN false; END IF;
  FOR selector IN SELECT s.value FROM jsonb_array_elements(d->'tiers') t CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s LOOP
    IF selector->'instanceId' <> 'null'::jsonb AND (selector->>'sourceType'<>'human_statement' OR NOT EXISTS (
      SELECT 1 FROM public."FactSource" s JOIN public."ProjectFact" fct ON fct.id=s."factId"
      WHERE s.id=(selector->>'instanceId')::uuid AND s."customerId"=c AND s."projectId"=p AND fct."factType"=f
    )) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
CREATE FUNCTION public.guard_authority_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Authority policy identity is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE id=NEW."projectId" AND "customerId"=NEW."customerId" FOR UPDATE;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>0 THEN RAISE EXCEPTION 'Initial policy revision must be zero'; END IF;
  ELSIF (to_jsonb(NEW)-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'revision') OR NEW.revision<>OLD.revision+1
    OR NOT EXISTS (SELECT 1 FROM public."AuthorityPolicyRevision" WHERE "policyId"=NEW.id AND revision=NEW.revision)
    THEN RAISE EXCEPTION 'Invalid policy revision transition'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON "AuthorityPolicy" FOR EACH ROW EXECUTE FUNCTION public.guard_authority_policy();
CREATE FUNCTION public.guard_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision integer; previous_time timestamptz;
BEGIN
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  SELECT revision INTO current_revision FROM public."AuthorityPolicy" WHERE id=NEW."policyId" FOR UPDATE;
  SELECT "recordedAt" INTO previous_time FROM public."AuthorityPolicyRevision" WHERE "policyId"=NEW."policyId" AND revision=current_revision;
  IF current_revision IS NULL OR NEW.revision<>current_revision+1 OR NEW."recordedAt"<previous_time
    OR NOT public.valid_authority_sources(NEW."customerId",NEW."projectId",NEW."factType",NEW.definition)
    THEN RAISE EXCEPTION 'Invalid authority revision'; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.advance_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public."AuthorityPolicy" SET revision=NEW.revision WHERE id=NEW."policyId";
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_revision_append BEFORE INSERT ON "AuthorityPolicyRevision" FOR EACH ROW EXECUTE FUNCTION public.guard_authority_revision();
CREATE TRIGGER authority_revision_advance AFTER INSERT ON "AuthorityPolicyRevision" FOR EACH ROW EXECUTE FUNCTION public.advance_authority_revision();

CREATE FUNCTION public.valid_authority_history(pid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public."AuthorityPolicy" p WHERE p.id=pid AND p.revision>0
    AND p.revision=(SELECT count(*) FROM public."AuthorityPolicyRevision" WHERE "policyId"=pid)
    AND p.revision=COALESCE((SELECT max(revision) FROM public."AuthorityPolicyRevision" WHERE "policyId"=pid),0)
    AND NOT EXISTS (SELECT 1 FROM public."AuthorityPolicyRevision" r
      LEFT JOIN public."AuthorityPolicyRevision" prev ON prev."policyId"=r."policyId" AND prev.revision=r.revision-1
      WHERE r."policyId"=pid AND (r."recordedAt"<prev."recordedAt" OR NOT public.valid_authority_sources(r."customerId",r."projectId",r."factType",r.definition))));
$$;
CREATE FUNCTION public.require_authority_published() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT public.valid_authority_history(NEW.id) THEN RAISE EXCEPTION 'Unpublished authority policy cannot commit'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER authority_published_at_commit AFTER INSERT ON "AuthorityPolicy" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_authority_published();

CREATE FUNCTION public.authority_instant(t timestamptz) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
CREATE FUNCTION public.valid_authority_conflict(cid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public."FactAuthorityConflict" c
    JOIN public."ProjectFactVersion" l ON l.id=c."leftVersionId"
    JOIN public."ProjectFactVersion" r ON r.id=c."rightVersionId"
    JOIN public."FactEvidence" le ON le.id=l."evidenceId"
    JOIN public."FactEvidence" re ON re.id=r."evidenceId"
    JOIN public."AuthorityPolicyRevision" p ON p.id=c."policyRevisionId"
    WHERE c.id=cid AND l.value IS DISTINCT FROM r.value
      AND le."observedAt"<=c."detectedAt" AND re."observedAt"<=c."detectedAt"
      AND l."effectiveAt"<=c."detectedAt" AND r."effectiveAt"<=c."detectedAt"
      AND p.state='ENABLED' AND p."recordedAt"<=c."detectedAt" AND p."effectiveAt"<=c."detectedAt");
$$;
CREATE FUNCTION public.guard_authority_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_WHEN='BEFORE' THEN
    PERFORM 1 FROM public."Project" WHERE id=NEW."projectId" AND "customerId"=NEW."customerId" FOR UPDATE;
    IF NEW.revision<>(SELECT COALESCE(max(revision),0)+1 FROM public."FactAuthorityConflict" WHERE "factId"=NEW."factId") THEN RAISE EXCEPTION 'Invalid conflict revision'; END IF;
  ELSIF NOT public.valid_authority_conflict(NEW.id) THEN RAISE EXCEPTION 'Invalid authority conflict'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_conflict_lock BEFORE INSERT ON "FactAuthorityConflict" FOR EACH ROW EXECUTE FUNCTION public.guard_authority_conflict();
CREATE TRIGGER authority_conflict_validate AFTER INSERT ON "FactAuthorityConflict" FOR EACH ROW EXECUTE FUNCTION public.guard_authority_conflict();
-- A pure read predicate also validates already-loaded archives, whose data can
-- precede trigger restoration. No caller JSON is accepted by product methods.
CREATE FUNCTION public.valid_fact_assessment(aid uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE a public."FactAssessment"%ROWTYPE; pol public."AuthorityPolicyRevision"%ROWTYPE;
  expected_policy jsonb := 'null'::jsonb; expected_scope jsonb; item jsonb; v record;
  actual_ids jsonb; output_ids jsonb; conflict_item jsonb; linked_count integer;
  freshness text; conflict_state text; selector jsonb; tier integer; expiry timestamptz; deadline timestamptz;
  applicability text; reasons jsonb; selected_tier integer; selected_ids jsonb;
  expected_status text; needs_revalidation boolean; has_ambiguity boolean; disagreement_ids jsonb; higher_ids jsonb;
BEGIN
  SELECT * INTO a FROM public."FactAssessment" WHERE id=aid;
  IF NOT FOUND OR a."evaluatorVersion"<>1 OR octet_length(a.result::text)>33554432
    OR a."factRevision">(SELECT revision FROM public."ProjectFact" WHERE id=a."factId") THEN RETURN false; END IF;
  IF NOT (a.result ?& ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'])
    OR a.result - ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'] <> '{}'::jsonb THEN RETURN false; END IF;
  expected_scope := jsonb_build_object('customerId',a."customerId",'projectId',a."projectId",'factId',a."factId",'factType',a."factType");
  IF a.result->'scope' IS DISTINCT FROM expected_scope OR a.result->>'asOf' IS DISTINCT FROM public.authority_instant(a."asOf")
    OR a.result->>'mode' IS DISTINCT FROM 'HISTORICAL' OR a.result->'complete' IS DISTINCT FROM to_jsonb(a.complete)
    OR jsonb_typeof(a.result->'versions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'conflicts') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'candidateVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingEvidenceIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  SELECT * INTO pol FROM public."AuthorityPolicyRevision" WHERE "policyId"=a."policyId"
    AND revision<=a."policyThroughRevision" AND "recordedAt"<=a."asOf" AND "effectiveAt"<=a."asOf" ORDER BY revision DESC LIMIT 1;
  IF pol.id IS DISTINCT FROM a."policyRevisionId" THEN RETURN false; END IF;
  IF pol.state='ENABLED' THEN expected_policy := pol.definition || jsonb_build_object('revisionId',pol.id,'customerId',pol."customerId",'projectId',pol."projectId",'factType',pol."factType",'recordedAt',public.authority_instant(pol."recordedAt"),'effectiveAt',public.authority_instant(pol."effectiveAt")); END IF;
  IF a.result->'policy' IS DISTINCT FROM expected_policy THEN RETURN false; END IF;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  IF linked_count<>a."versionCount" OR jsonb_array_length(a.result->'versions')<>a."versionCount" THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("versionId"::text ORDER BY "versionId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(a.result->'versions');
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  IF a.complete THEN
    IF (SELECT count(*) FROM public."ProjectFactVersion" WHERE "factId"=a."factId" AND revision<=a."factRevision")<>a."versionCount" THEN RETURN false; END IF;
  ELSIF a."versionCount"<>0 OR a."conflictCount"<>0 OR a.result->>'status' IS DISTINCT FROM 'INCOMPLETE'
    OR a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(a.result->'versions') LOOP
    SELECT fv.*,e."observedAt" INTO v FROM public."ProjectFactVersion" fv JOIN public."FactEvidence" e ON e.id=fv."evidenceId" WHERE fv.id=(item->>'id')::uuid;
    IF NOT FOUND OR v."factId"<>a."factId" OR v.revision>a."factRevision"
      OR item->'evidenceIds' IS DISTINCT FROM jsonb_build_array(v."evidenceId") THEN RETURN false; END IF;
    IF item->>'visibility'='restricted' THEN
      IF item IS DISTINCT FROM jsonb_build_object('id',v.id,'evidenceIds',jsonb_build_array(v."evidenceId"),'visibility','restricted','revalidationRequired',true) THEN RETURN false; END IF;
    ELSIF item->>'visibility'='available' THEN
      IF NOT(item ?& ARRAY['id','scope','source','value','provenance','effectiveAt','observedAt','validUntil','evidenceIds','temporalApplicability','assessedValidUntil','unresolvedConflictIds','assessment','visibility','revalidationRequired','sourceType','approval','approvalStateAsOf','authorityTier','eligibilityReasons'])
        OR item - ARRAY['id','scope','source','value','provenance','effectiveAt','observedAt','validUntil','evidenceIds','temporalApplicability','assessedValidUntil','unresolvedConflictIds','assessment','visibility','revalidationRequired','sourceType','approval','approvalStateAsOf','authorityTier','eligibilityReasons'] <> '{}'::jsonb
        OR item->'revalidationRequired' IS DISTINCT FROM 'false'::jsonb
        OR item->>'approvalStateAsOf' IS DISTINCT FROM 'NOT_REQUIRED'
        OR item->>'temporalApplicability' NOT IN ('NOT_YET_OBSERVED','NOT_YET_EFFECTIVE','SUPERSEDED','AMBIGUOUS','APPLICABLE')
        OR jsonb_typeof(item->'temporalApplicability') IS DISTINCT FROM 'string'
        OR jsonb_typeof(item->'eligibilityReasons') IS DISTINCT FROM 'array'
        OR jsonb_typeof(item->'unresolvedConflictIds') IS DISTINCT FROM 'array'
        THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(item->'eligibilityReasons') reason WHERE jsonb_typeof(reason) IS DISTINCT FROM 'string'
        OR reason #>> '{}' NOT IN ('NO_AUTHORITY_RULE','NOT_APPLICABLE','AMBIGUOUS_STREAM','APPROVAL_REQUIRED','REJECTED','STALE','UNKNOWN_VALIDITY','UNVERIFIED_ORIGIN')) THEN RETURN false; END IF;
      SELECT COALESCE(jsonb_agg(c.id::text ORDER BY c.id),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
        WHERE ac."assessmentId"=aid AND (c."leftVersionId"=v.id OR c."rightVersionId"=v.id);
      IF item->'unresolvedConflictIds' IS DISTINCT FROM actual_ids THEN RETURN false; END IF;
      SELECT s.value,(t.ordinality-1)::integer INTO selector,tier
        FROM jsonb_array_elements(expected_policy->'tiers') WITH ORDINALITY t(value,ordinality)
        CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s(value)
        WHERE s.value->>'sourceType'='human_statement' AND (s.value->'instanceId'='null'::jsonb OR s.value->>'instanceId'=v."sourceId"::text);
      expiry := v."validUntil";
      IF selector->'validity' <> 'null'::jsonb THEN
        deadline := ((CASE WHEN selector->'validity'->>'basis'='observedAt' THEN v."observedAt" ELSE v."effectiveAt" END AT TIME ZONE 'UTC')
          + ((selector->'validity'->>'durationMs')::bigint / 86400000) * interval '1 day'
          + ((selector->'validity'->>'durationMs')::bigint % 86400000) * interval '1 millisecond') AT TIME ZONE 'UTC';
        IF NOT isfinite(deadline) OR deadline>='10000-01-01 00:00:00+00'::timestamptz THEN RETURN false; END IF;
        expiry := LEAST(expiry,deadline);
      END IF;
      applicability := CASE WHEN v."observedAt">a."asOf" THEN 'NOT_YET_OBSERVED' WHEN v."effectiveAt">a."asOf" THEN 'NOT_YET_EFFECTIVE'
        WHEN EXISTS (SELECT 1 FROM public."ProjectFactVersion" newer JOIN public."FactEvidence" ne ON ne.id=newer."evidenceId"
          WHERE newer."sourceId"=v."sourceId" AND newer.revision<=a."factRevision" AND ne."observedAt"<=a."asOf" AND newer."effectiveAt"<=a."asOf"
          AND (newer."effectiveAt",ne."observedAt")>(v."effectiveAt",v."observedAt")) THEN 'SUPERSEDED'
        WHEN (SELECT count(*) FROM public."ProjectFactVersion" tied JOIN public."FactEvidence" te ON te.id=tied."evidenceId"
          WHERE tied."sourceId"=v."sourceId" AND tied.revision<=a."factRevision" AND tied."effectiveAt"=v."effectiveAt" AND te."observedAt"=v."observedAt")>1 THEN 'AMBIGUOUS' ELSE 'APPLICABLE' END;
      freshness := CASE WHEN applicability IN ('NOT_YET_OBSERVED','NOT_YET_EFFECTIVE') OR expiry IS NULL THEN 'UNKNOWN'
        WHEN expiry<=a."asOf" THEN 'STALE' ELSE 'CURRENT' END;
      reasons := '[]'::jsonb;
      IF selector IS NULL THEN reasons := reasons || '"NO_AUTHORITY_RULE"'::jsonb; END IF;
      IF applicability NOT IN ('APPLICABLE','AMBIGUOUS') THEN reasons := reasons || '"NOT_APPLICABLE"'::jsonb; END IF;
      IF applicability='AMBIGUOUS' THEN reasons := reasons || '"AMBIGUOUS_STREAM"'::jsonb; END IF;
      IF selector->>'requiredApproval'='APPROVED' THEN reasons := reasons || '"APPROVAL_REQUIRED"'::jsonb; END IF;
      IF freshness='STALE' THEN reasons := reasons || '"STALE"'::jsonb; END IF;
      IF freshness='UNKNOWN' THEN reasons := reasons || '"UNKNOWN_VALIDITY"'::jsonb; END IF;
      IF item->'authorityTier' IS DISTINCT FROM COALESCE(to_jsonb(tier),'null'::jsonb)
        OR item->'assessedValidUntil' IS DISTINCT FROM COALESCE(to_jsonb(public.authority_instant(expiry)),'null'::jsonb)
        OR item->>'temporalApplicability' IS DISTINCT FROM applicability OR item->'eligibilityReasons' IS DISTINCT FROM reasons THEN RETURN false; END IF;
      conflict_state := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(a.result->'conflicts') c WHERE c->'versionIds' @> jsonb_build_array(v.id)) THEN 'CONFLICTING' ELSE 'NONE' END;
      IF item->'assessment' IS DISTINCT FROM jsonb_build_object('provenance',v.provenance,'freshness',freshness,'conflict',conflict_state,'classification',CASE WHEN conflict_state='CONFLICTING' THEN 'CONFLICTING' WHEN freshness<>'CURRENT' THEN freshness ELSE v.provenance END,'assessedAt',public.authority_instant(a."asOf")) THEN RETURN false; END IF;
      IF item->'scope' IS DISTINCT FROM expected_scope OR item->'value' IS DISTINCT FROM v.value
        OR item->>'provenance' IS DISTINCT FROM v.provenance OR item->>'sourceType' IS DISTINCT FROM 'human_statement'
        OR item->>'effectiveAt' IS DISTINCT FROM public.authority_instant(v."effectiveAt")
        OR item->>'observedAt' IS DISTINCT FROM public.authority_instant(v."observedAt")
        OR item->'validUntil' IS DISTINCT FROM COALESCE(to_jsonb(public.authority_instant(v."validUntil")),'null'::jsonb)
        OR item->'source' IS DISTINCT FROM jsonb_build_object('instanceId',v."sourceId",'recordType','human_statement','recordId',v."sourceId",'revision',v."evidenceId")
        OR item->'approval' IS DISTINCT FROM jsonb_build_object('state','NOT_REQUIRED','decisionAt',NULL,'decisionId',NULL)
        THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
  END LOOP;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentConflict" WHERE "assessmentId"=aid;
  IF linked_count<>a."conflictCount" THEN RETURN false; END IF;
  IF a.complete AND (SELECT count(*) FROM public."FactAuthorityConflict" WHERE "factId"=a."factId" AND revision<=a."conflictThroughRevision")<>a."conflictCount" THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
    WHERE ac."assessmentId"=aid AND (a."conflictThroughRevision" IS NULL OR c.revision>a."conflictThroughRevision")) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("conflictId"::text ORDER BY "conflictId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentConflict" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'recordedConflictId' ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(a.result->'conflicts') WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  -- Compare the complete recorded set in one query. A per-pair query loop
  -- repeatedly expanded the large capture JSON and exhausted transaction time.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','RECORDED','recordedConflictId',c.id,
      'versionIds',jsonb_build_array(c."leftVersionId",c."rightVersionId"),
      'evidenceIds',jsonb_build_array(LEAST(l."evidenceId",r."evidenceId"),GREATEST(l."evidenceId",r."evidenceId"))) ORDER BY c.id),'[]'::jsonb)
    INTO actual_ids FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
    JOIN public."ProjectFactVersion" l ON l.id=c."leftVersionId" JOIN public."ProjectFactVersion" r ON r.id=c."rightVersionId"
    JOIN public."FactAssessmentVersion" al ON al."assessmentId"=aid AND al."versionId"=l.id
    JOIN public."FactAssessmentVersion" ar ON ar."assessmentId"=aid AND ar."versionId"=r.id
    WHERE ac."assessmentId"=aid AND c."detectedAt"<=a."asOf" AND public.valid_authority_conflict(c.id);
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids
    FROM jsonb_array_elements(a.result->'conflicts') WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.result->'conflicts') WHERE jsonb_typeof(value->'kind') IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(a.result->'conflicts') WHERE value->>'kind'<>'RECORDED' LOOP
    IF NOT(conflict_item ?& ARRAY['kind','recordedConflictId','versionIds','evidenceIds'])
      OR conflict_item - ARRAY['kind','recordedConflictId','versionIds','evidenceIds'] <> '{}'::jsonb
      OR jsonb_typeof(conflict_item->'kind') IS DISTINCT FROM 'string'
      OR conflict_item->>'kind' NOT IN ('RECORDED','AUTHORITY_DISAGREEMENT','HIGHER_AUTHORITY_CONTRADICTION')
      OR (conflict_item->>'kind'<>'RECORDED' AND conflict_item->'recordedConflictId' IS DISTINCT FROM 'null'::jsonb)
      OR jsonb_typeof(conflict_item->'versionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(conflict_item->'versionIds')<2 THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(conflict_item->'versionIds') x WHERE NOT EXISTS
      (SELECT 1 FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid AND "versionId"=x::uuid)) THEN RETURN false; END IF;
    SELECT COALESCE(jsonb_agg("evidenceId"::text ORDER BY "evidenceId"),'[]'::jsonb) INTO actual_ids FROM public."ProjectFactVersion" WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(conflict_item->'versionIds'));
    IF actual_ids IS DISTINCT FROM conflict_item->'evidenceIds' THEN RETURN false; END IF;
  END LOOP;
  -- Validate selection and claims against the already bound immutable version
  -- assessments. Human attribution cannot satisfy an APPROVED selector.
  SELECT min((value->>'authorityTier')::integer) INTO selected_tier FROM jsonb_array_elements(a.result->'versions')
    WHERE value->>'visibility'='available' AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb),COALESCE(bool_or(value->>'temporalApplicability'='AMBIGUOUS'),false)
    INTO selected_ids,has_ambiguity FROM jsonb_array_elements(a.result->'versions')
    WHERE value->>'visibility'='available' AND (value->>'authorityTier')::integer=selected_tier AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT CASE WHEN count(DISTINCT value->'value')>1 THEN selected_ids ELSE '[]'::jsonb END INTO disagreement_ids
    FROM jsonb_array_elements(a.result->'versions') WHERE selected_ids @> jsonb_build_array(value->>'id');
  SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO higher_ids FROM (
    SELECT DISTINCT id FROM jsonb_array_elements(a.result->'versions') human(value)
    CROSS JOIN jsonb_array_elements(a.result->'versions') higher(value)
    CROSS JOIN LATERAL (VALUES (human.value->>'id'),(higher.value->>'id')) participants(id)
    WHERE selected_ids @> jsonb_build_array(human.value->>'id') AND human.value->>'provenance'='HUMAN_CONFIRMED'
      AND higher.value->>'visibility'='available' AND (higher.value->>'authorityTier')::integer<selected_tier
      AND higher.value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM","STALE","UNKNOWN_VALIDITY"]'::jsonb
      AND higher.value->'value' IS DISTINCT FROM human.value->'value'
  ) participants;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(a.result->'conflicts') WHERE value->>'kind'<>'RECORDED' LOOP
    IF conflict_item->'versionIds' IS DISTINCT FROM (CASE WHEN conflict_item->>'kind'='AUTHORITY_DISAGREEMENT' THEN disagreement_ids ELSE higher_ids END) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(a.result->'conflicts') WHERE value->>'kind'='AUTHORITY_DISAGREEMENT')<>(CASE WHEN jsonb_array_length(disagreement_ids)>0 THEN 1 ELSE 0 END)
    OR (SELECT count(*) FROM jsonb_array_elements(a.result->'conflicts') WHERE value->>'kind'='HIGHER_AUTHORITY_CONTRADICTION')<>(CASE WHEN jsonb_array_length(higher_ids)>0 THEN 1 ELSE 0 END) THEN RETURN false; END IF;
  needs_revalidation := EXISTS (SELECT 1 FROM jsonb_array_elements(a.result->'versions') WHERE value->>'visibility'='restricted');
  expected_status := CASE WHEN NOT a.complete THEN 'INCOMPLETE' WHEN needs_revalidation THEN 'REVALIDATION_REQUIRED'
    WHEN expected_policy='null'::jsonb THEN 'NO_POLICY' WHEN jsonb_array_length(a.result->'conflicts')>0 THEN 'CONFLICTING'
    WHEN has_ambiguity THEN 'AMBIGUOUS' WHEN jsonb_array_length(selected_ids)>0 THEN 'RESOLVED' ELSE 'UNKNOWN' END;
  IF a.result->'selectedTier' IS DISTINCT FROM COALESCE(to_jsonb(selected_tier),'null'::jsonb)
    OR a.result->'candidateVersionIds' IS DISTINCT FROM selected_ids OR a.result->>'status' IS DISTINCT FROM expected_status
    OR a.result->'revalidationRequired' IS DISTINCT FROM to_jsonb(needs_revalidation)
    OR a.result->>'conflict' IS DISTINCT FROM (CASE WHEN jsonb_array_length(a.result->'conflicts')>0 THEN 'CONFLICTING' ELSE 'NONE' END)
    OR a.result->'reconciliationRequired' IS DISTINCT FROM to_jsonb(jsonb_array_length(a.result->'conflicts')>0 AND COALESCE(pol.state='ENABLED' AND pol.definition->>'conflictBehavior'='REQUEST_RECONCILIATION',false))
    THEN RETURN false; END IF;
  IF a.result->>'status'='RESOLVED' THEN
    IF a.result->'supportingVersionIds' IS DISTINCT FROM selected_ids THEN RETURN false; END IF;
    IF NOT a.complete OR jsonb_array_length(a.result->'supportingVersionIds')<1 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(a.result->'supportingVersionIds') LOOP
      IF NOT EXISTS (SELECT 1 FROM public."FactAssessmentVersion" av JOIN public."ProjectFactVersion" fv ON fv.id=av."versionId"
        WHERE av."assessmentId"=aid AND to_jsonb(fv.id)=item AND fv.value=a.result->'resolvedValue') THEN RETURN false; END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg("evidenceId"::text ORDER BY "evidenceId"),'[]'::jsonb) INTO actual_ids
      FROM public."ProjectFactVersion" WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(a.result->'supportingVersionIds'));
    IF a.result->'supportingEvidenceIds' IS DISTINCT FROM actual_ids THEN RETURN false; END IF;
  ELSIF a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb OR a.result->'supportingVersionIds' IS DISTINCT FROM '[]'::jsonb
    OR a.result->'supportingEvidenceIds' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.result->'candidateVersionIds') x WHERE NOT EXISTS
    (SELECT 1 FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid AND "versionId"=x::uuid)) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
CREATE FUNCTION public.guard_assessment_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy_row public."AuthorityPolicy"%ROWTYPE; conflict_revision integer;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Assessment must be assembled before sealing'; END IF;
    PERFORM 1 FROM public."Project" WHERE id=NEW."projectId" AND "customerId"=NEW."customerId" FOR UPDATE;
    SELECT * INTO policy_row FROM public."AuthorityPolicy" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factType"=NEW."factType";
    SELECT max(revision) INTO conflict_revision FROM public."FactAuthorityConflict" WHERE "factId"=NEW."factId";
    IF NEW."factRevision" IS DISTINCT FROM (SELECT revision FROM public."ProjectFact" WHERE id=NEW."factId")
      OR NEW."policyId" IS DISTINCT FROM policy_row.id OR NEW."policyThroughRevision" IS DISTINCT FROM policy_row.revision
      OR NEW."conflictThroughRevision" IS DISTINCT FROM conflict_revision
      THEN RAISE EXCEPTION 'Assessment must pin current publication prefixes'; END IF;
  ELSIF TG_OP='DELETE' THEN RAISE EXCEPTION 'Assessment is immutable';
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed')
    OR NOT public.valid_fact_assessment(NEW.id) THEN RAISE EXCEPTION 'Invalid assessment seal'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_header_guard BEFORE INSERT OR UPDATE OR DELETE ON "FactAssessment" FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_header();
CREATE FUNCTION public.guard_assessment_dependency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_sealed boolean; access_revision integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Assessment dependency is immutable'; END IF;
  SELECT sealed INTO is_sealed FROM public."FactAssessment" WHERE id=NEW."assessmentId" FOR UPDATE;
  IF is_sealed IS DISTINCT FROM false THEN RAISE EXCEPTION 'Assessment dependencies are sealed'; END IF;
  IF TG_TABLE_NAME='FactAssessmentVersion' THEN
    SELECT a.revision INTO access_revision FROM public."ProjectFactVersion" v LEFT JOIN public."FactSourceAccess" a ON a."sourceId"=v."sourceId" WHERE v.id=NEW."versionId";
    IF NEW."sourceAccessRevision"<>COALESCE(access_revision,0) THEN RAISE EXCEPTION 'Invalid captured source access revision'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessment_version_guard BEFORE INSERT OR UPDATE OR DELETE ON "FactAssessmentVersion" FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_dependency();
CREATE TRIGGER assessment_conflict_guard BEFORE INSERT OR UPDATE OR DELETE ON "FactAssessmentConflict" FOR EACH ROW EXECUTE FUNCTION public.guard_assessment_dependency();
CREATE FUNCTION public.require_assessment_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."FactAssessment" WHERE id=NEW.id AND sealed) THEN RAISE EXCEPTION 'Unsealed assessment cannot commit'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER assessment_sealed_at_commit AFTER INSERT ON "FactAssessment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_assessment_sealed();

CREATE TRIGGER authority_revision_immutable BEFORE UPDATE OR DELETE ON "AuthorityPolicyRevision" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER authority_receipt_immutable BEFORE UPDATE OR DELETE ON "AuthorityPolicyReceipt" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER authority_conflict_immutable BEFORE UPDATE OR DELETE ON "FactAuthorityConflict" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER authority_policy_no_truncate BEFORE TRUNCATE ON "AuthorityPolicy" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER authority_revision_no_truncate BEFORE TRUNCATE ON "AuthorityPolicyRevision" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER authority_receipt_no_truncate BEFORE TRUNCATE ON "AuthorityPolicyReceipt" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER authority_conflict_no_truncate BEFORE TRUNCATE ON "FactAuthorityConflict" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER assessment_no_truncate BEFORE TRUNCATE ON "FactAssessment" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER assessment_version_no_truncate BEFORE TRUNCATE ON "FactAssessmentVersion" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER assessment_conflict_no_truncate BEFORE TRUNCATE ON "FactAssessmentConflict" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
