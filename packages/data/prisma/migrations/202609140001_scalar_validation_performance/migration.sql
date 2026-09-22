-- FR-EVD-004/007/009/012, NFR-REL-001/002: bounded proof validation work.
-- Additive replacement; no old migration, data, ACL, trigger or deadline changes.
CREATE OR REPLACE FUNCTION public.valid_fact_assessment(aid uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE temporal_by_version jsonb; recorded_by_version jsonb; result_versions jsonb; result_conflicts jsonb; a public."FactAssessment"%ROWTYPE; pol public."AuthorityPolicyRevision"%ROWTYPE;
  expected_policy jsonb := 'null'::jsonb; expected_scope jsonb; item jsonb; v record;
  actual_ids jsonb; output_ids jsonb; conflict_item jsonb; linked_count integer;
  freshness text; conflict_state text; selector jsonb; tier integer; expiry timestamptz; deadline timestamptz;
  applicability text; reasons jsonb; selected_tier integer; selected_ids jsonb;
  expected_status text; needs_revalidation boolean; has_ambiguity boolean; disagreement_ids jsonb; higher_ids jsonb;
BEGIN
  SELECT * INTO a FROM public."FactAssessment" WHERE id=aid;
  IF NOT FOUND OR a."evaluatorVersion"<>1 OR octet_length(a.result::text)>33554432
    OR a."factRevision">(SELECT revision FROM public."ProjectFact" WHERE id=a."factId") THEN RETURN false; END IF;
  result_versions := a.result->'versions';
  result_conflicts := a.result->'conflicts';
  IF NOT (a.result ?& ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'])
    OR a.result - ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'] <> '{}'::jsonb THEN RETURN false; END IF;
  expected_scope := jsonb_build_object('customerId',a."customerId",'projectId',a."projectId",'factId',a."factId",'factType',a."factType");
  IF a.result->'scope' IS DISTINCT FROM expected_scope OR a.result->>'asOf' IS DISTINCT FROM public.authority_instant(a."asOf")
    OR a.result->>'mode' IS DISTINCT FROM 'HISTORICAL' OR a.result->'complete' IS DISTINCT FROM to_jsonb(a.complete)
    OR jsonb_typeof(result_versions) IS DISTINCT FROM 'array'
    OR jsonb_typeof(result_conflicts) IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'candidateVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingEvidenceIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  SELECT * INTO pol FROM public."AuthorityPolicyRevision" WHERE "policyId"=a."policyId"
    AND revision<=a."policyThroughRevision" AND "recordedAt"<=a."asOf" AND "effectiveAt"<=a."asOf" ORDER BY revision DESC LIMIT 1;
  IF pol.id IS DISTINCT FROM a."policyRevisionId" THEN RETURN false; END IF;
  IF pol.state='ENABLED' THEN expected_policy := pol.definition || jsonb_build_object('revisionId',pol.id,'customerId',pol."customerId",'projectId',pol."projectId",'factType',pol."factType",'recordedAt',public.authority_instant(pol."recordedAt"),'effectiveAt',public.authority_instant(pol."effectiveAt")); END IF;
  IF a.result->'policy' IS DISTINCT FROM expected_policy THEN RETURN false; END IF;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  IF linked_count<>a."versionCount" OR jsonb_array_length(result_versions)<>a."versionCount" THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("versionId"::text ORDER BY "versionId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(result_versions);
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  IF a.complete THEN
    IF (SELECT count(*) FROM public."ProjectFactVersion" WHERE "factId"=a."factId" AND revision<=a."factRevision")<>a."versionCount" THEN RETURN false; END IF;
  ELSIF a."versionCount"<>0 OR a."conflictCount"<>0 OR a.result->>'status' IS DISTINCT FROM 'INCOMPLETE'
    OR a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  -- Derive applicability once from the same immutable, historical prefix.
  -- Future evidence must not supersede a currently applicable version.
  IF a."versionCount">0 THEN
    WITH prefix AS MATERIALIZED (
      SELECT fv.id,fv."sourceId",fv."effectiveAt",e."observedAt"
      FROM public."ProjectFactVersion" fv JOIN public."FactEvidence" e ON e.id=fv."evidenceId"
      WHERE fv."factId"=a."factId" AND fv.revision<=a."factRevision"
    ), visible AS (
      SELECT id,
        dense_rank() OVER (PARTITION BY "sourceId" ORDER BY "effectiveAt" DESC,"observedAt" DESC) AS position,
        count(*) OVER (PARTITION BY "sourceId","effectiveAt","observedAt") AS ties
      FROM prefix WHERE "observedAt"<=a."asOf" AND "effectiveAt"<=a."asOf"
    )
    -- Partition visible/future rows without a self-join: sparse statistics must
    -- not cause PostgreSQL to re-run both windows for every prefix row.
    SELECT jsonb_object_agg(classified.id::text,classified.applicability) INTO temporal_by_version
      FROM (
        SELECT id,CASE WHEN position>1 THEN 'SUPERSEDED'
          WHEN ties>1 THEN 'AMBIGUOUS' ELSE 'APPLICABLE' END AS applicability
        FROM visible
        UNION ALL
        SELECT id,CASE WHEN "observedAt">a."asOf" THEN 'NOT_YET_OBSERVED'
          ELSE 'NOT_YET_EFFECTIVE' END AS applicability
        FROM prefix WHERE "observedAt">a."asOf" OR "effectiveAt">a."asOf"
      ) classified;
  END IF;
  -- Materialize the scoped dependency set once, rather than repeatedly joining
  -- the growing global conflict history for every version.
  SELECT COALESCE(jsonb_object_agg(participant::text,ids),'{}'::jsonb) INTO recorded_by_version
    FROM (
      SELECT participant,jsonb_agg(c.id::text ORDER BY c.id) AS ids
      FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
      CROSS JOIN LATERAL (VALUES (c."leftVersionId"),(c."rightVersionId")) sides(participant)
      WHERE ac."assessmentId"=aid GROUP BY participant
    ) grouped;
  -- LEFT joins preserve malformed/missing rows for explicit rejection.
  FOR v IN SELECT fv.*,e."observedAt",output.value AS output_item
    FROM jsonb_array_elements(result_versions) output(value)
    LEFT JOIN public."ProjectFactVersion" fv ON fv.id=(output.value->>'id')::uuid
    LEFT JOIN public."FactEvidence" e ON e.id=fv."evidenceId"
  LOOP
    item := v.output_item;
    IF v.id IS NULL OR v."observedAt" IS NULL OR v."factId"<>a."factId" OR v.revision>a."factRevision"
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
      actual_ids := COALESCE(recorded_by_version->v.id::text,'[]'::jsonb);
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
      applicability := temporal_by_version->>v.id::text;
      IF applicability IS NULL THEN RETURN false; END IF;
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
      conflict_state := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(result_conflicts) c WHERE c->'versionIds' @> jsonb_build_array(v.id)) THEN 'CONFLICTING' ELSE 'NONE' END;
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
  SELECT COALESCE(jsonb_agg(value->>'recordedConflictId' ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='RECORDED';
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
    FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids OR EXISTS (SELECT 1 FROM jsonb_array_elements(result_conflicts) WHERE jsonb_typeof(value->'kind') IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'<>'RECORDED' LOOP
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
  SELECT min((value->>'authorityTier')::integer) INTO selected_tier FROM jsonb_array_elements(result_versions)
    WHERE value->>'visibility'='available' AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb),COALESCE(bool_or(value->>'temporalApplicability'='AMBIGUOUS'),false)
    INTO selected_ids,has_ambiguity FROM jsonb_array_elements(result_versions)
    WHERE value->>'visibility'='available' AND (value->>'authorityTier')::integer=selected_tier AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT CASE WHEN count(DISTINCT value->'value')>1 THEN selected_ids ELSE '[]'::jsonb END INTO disagreement_ids
    FROM jsonb_array_elements(result_versions) WHERE selected_ids @> jsonb_build_array(value->>'id');
  SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO higher_ids FROM (
    SELECT DISTINCT id FROM jsonb_array_elements(result_versions) human(value)
    CROSS JOIN jsonb_array_elements(result_versions) higher(value)
    CROSS JOIN LATERAL (VALUES (human.value->>'id'),(higher.value->>'id')) participants(id)
    WHERE selected_ids @> jsonb_build_array(human.value->>'id') AND human.value->>'provenance'='HUMAN_CONFIRMED'
      AND higher.value->>'visibility'='available' AND (higher.value->>'authorityTier')::integer<selected_tier
      AND higher.value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM","STALE","UNKNOWN_VALIDITY"]'::jsonb
      AND higher.value->'value' IS DISTINCT FROM human.value->'value'
  ) participants;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'<>'RECORDED' LOOP
    IF conflict_item->'versionIds' IS DISTINCT FROM (CASE WHEN conflict_item->>'kind'='AUTHORITY_DISAGREEMENT' THEN disagreement_ids ELSE higher_ids END) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='AUTHORITY_DISAGREEMENT')<>(CASE WHEN jsonb_array_length(disagreement_ids)>0 THEN 1 ELSE 0 END)
    OR (SELECT count(*) FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='HIGHER_AUTHORITY_CONTRADICTION')<>(CASE WHEN jsonb_array_length(higher_ids)>0 THEN 1 ELSE 0 END) THEN RETURN false; END IF;
  needs_revalidation := EXISTS (SELECT 1 FROM jsonb_array_elements(result_versions) WHERE value->>'visibility'='restricted');
  expected_status := CASE WHEN NOT a.complete THEN 'INCOMPLETE' WHEN needs_revalidation THEN 'REVALIDATION_REQUIRED'
    WHEN expected_policy='null'::jsonb THEN 'NO_POLICY' WHEN jsonb_array_length(result_conflicts)>0 THEN 'CONFLICTING'
    WHEN has_ambiguity THEN 'AMBIGUOUS' WHEN jsonb_array_length(selected_ids)>0 THEN 'RESOLVED' ELSE 'UNKNOWN' END;
  IF a.result->'selectedTier' IS DISTINCT FROM COALESCE(to_jsonb(selected_tier),'null'::jsonb)
    OR a.result->'candidateVersionIds' IS DISTINCT FROM selected_ids OR a.result->>'status' IS DISTINCT FROM expected_status
    OR a.result->'revalidationRequired' IS DISTINCT FROM to_jsonb(needs_revalidation)
    OR a.result->>'conflict' IS DISTINCT FROM (CASE WHEN jsonb_array_length(result_conflicts)>0 THEN 'CONFLICTING' ELSE 'NONE' END)
    OR a.result->'reconciliationRequired' IS DISTINCT FROM to_jsonb(jsonb_array_length(result_conflicts)>0 AND COALESCE(pol.state='ENABLED' AND pol.definition->>'conflictBehavior'='REQUEST_RECONCILIATION',false))
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

CREATE OR REPLACE FUNCTION public.valid_scalar_reconciliation_check(target uuid) RETURNS boolean
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
  -- A CREATED request owns exactly this proof. valid_request checks its identity
  -- and every proof/audit/assignment binding; do not traverse that same proof twice.
  IF c.outcome='CREATED' THEN
    SELECT * INTO r FROM public."ScalarReconciliationRequest"
      WHERE id=c."requestId" AND "customerId"=c."customerId" AND "projectId"=c."projectId" AND "factId"=c."factId";
    IF NOT FOUND OR NOT r.sealed OR r."originCommandId" IS DISTINCT FROM c.id
      OR r."originalAssessmentId" IS DISTINCT FROM a.id THEN RETURN false; END IF;
    RETURN public.valid_scalar_reconciliation_request(r.id) IS TRUE;
  END IF;
  identity:=public.scalar_reconciliation_identity(a.id);
  IF c.outcome='NO_REQUEST' THEN RETURN c."requestId" IS NULL AND identity IS NULL; END IF;
  SELECT * INTO r FROM public."ScalarReconciliationRequest" WHERE id=c."requestId" AND "customerId"=c."customerId" AND "projectId"=c."projectId" AND "factId"=c."factId";
  IF NOT FOUND OR NOT r.sealed OR identity IS NULL OR r."contributorIdentity" IS DISTINCT FROM identity OR public.valid_scalar_reconciliation_request(r.id) IS NOT TRUE THEN RETURN false; END IF;
  RETURN (c.outcome='CREATED' AND r."originCommandId"=c.id AND r."originalAssessmentId"=a.id)
    OR (c.outcome='REUSED' AND r."originCommandId"<>c.id AND r."originalAssessmentId"<>a.id);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
