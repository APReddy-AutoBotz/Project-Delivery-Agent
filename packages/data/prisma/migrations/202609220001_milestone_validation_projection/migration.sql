-- FR-EVD-004/009, NFR-REL-001/002: extract each immutable child JSON projection
-- once before expanding versions. Preserve every predicate and proof boundary.
-- CREATE OR REPLACE retains the existing function identity, ownership and ACL.
CREATE OR REPLACE FUNCTION public.valid_milestone_consistency_assessment(target uuid) RETURNS boolean
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
    WITH child_inputs AS MATERIALIZED (
      SELECT t."targetKind",t."milestoneId",t."workItemId",t."bindingId",t."factId",t."factType",
        f.result->'versions' AS versions,f.result->'supportingVersionIds' AS supporting_ids,
        f.result->'resolvedValue'->>'value' AS resolved_state
      FROM public."MilestoneConsistencyTarget" t JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId"
      WHERE t."assessmentId"=a.id
    )
    SELECT replace(replace(jsonb_build_array(a."customerId",a."projectId",a."milestoneId",a."ruleRevision",COALESCE(jsonb_agg(tuple ORDER BY tuple::text COLLATE "C"),'[]'::jsonb))::text,': ',':'),', ',',') INTO expected_identity FROM (
      SELECT jsonb_build_array(t."targetKind",CASE WHEN t."targetKind"='MILESTONE' THEN t."milestoneId" ELSE t."workItemId" END,t."bindingId",t."factId",t."factType",version->>'id',
        (SELECT COALESCE(jsonb_agg(evidence #>> '{}' ORDER BY evidence #>> '{}'),'[]'::jsonb) FROM jsonb_array_elements(version->'evidenceIds') evidence)) AS tuple
      FROM child_inputs t CROSS JOIN LATERAL jsonb_array_elements(t.versions) version
      WHERE t.supporting_ids @> jsonb_build_array(version->>'id')
        AND ((t."targetKind"='MILESTONE' AND t.resolved_state='COMPLETE') OR (t."targetKind"='WORK_ITEM' AND t.resolved_state IN ('OPEN','IN_PROGRESS')))) tuples;
    IF contributors=0 OR contributors<>expected_contributor_rows OR a.result->'contributors' IS DISTINCT FROM expected_contributors OR a.result->>'contributorIdentity' IS DISTINCT FROM expected_identity
      OR NOT (a.result ?& ARRAY['scope','asOf','ruleRevision','status','evaluations','dependencies','contributors','contributorIdentity']) OR a.result-ARRAY['scope','asOf','ruleRevision','status','evaluations','dependencies','contributors','contributorIdentity']<>'{}'::jsonb THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public."MilestoneConsistencyContributorVersion" c JOIN public."MilestoneConsistencyTarget" t ON t.id=c."targetRowId" JOIN public."FactAssessment" f ON f.id=t."scalarAssessmentId" JOIN public."ProjectFactVersion" v ON v.id=c."versionId"
      WHERE c."assessmentId"=a.id AND (c."bindingId"<>t."bindingId" OR c."factId"<>t."factId" OR NOT (f.result->'supportingVersionIds' @> jsonb_build_array(c."versionId")) OR NOT (v."evidenceId"=c."evidenceId")
        OR NOT ((t."targetKind"='MILESTONE' AND f.result->'resolvedValue'->>'value'='COMPLETE') OR (t."targetKind"='WORK_ITEM' AND f.result->'resolvedValue'->>'value' IN ('OPEN','IN_PROGRESS'))))) THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
