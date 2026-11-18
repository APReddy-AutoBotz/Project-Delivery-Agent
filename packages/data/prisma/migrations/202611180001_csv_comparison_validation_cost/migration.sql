-- FR-CON-006/007/012 / NFR-SEC-001: reduce the cost of existing CSV context validation.
-- The existing codec, retention checks, locks, receipt and projection invariants
-- continue to validate both populated observations and unchanged predecessors.

CREATE OR REPLACE FUNCTION public.valid_ingestion_csv_context(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE
  c public."IngestionCsvContext"%ROWTYPE;
  h public."IngestionCsvHead"%ROWTYPE;
  r public."IngestionOperationReceipt"%ROWTYPE;
  parent public."IngestionCsvContext"%ROWTYPE;
  mapping_value jsonb;
  activation_mapping jsonb;
  expected_dictionary jsonb;
  prior_rows jsonb := '[]'::jsonb;
  encoded text;
  prior_encoded text;
  expected_rows jsonb;
BEGIN
  SELECT * INTO c FROM public."IngestionCsvContext" WHERE "receiptId"=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO h FROM public."IngestionCsvHead" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId";
  IF NOT FOUND OR h.readiness<>'READY' OR c."mappingRevision"<>h."mappingRevision"
    OR c.revision NOT BETWEEN 1 AND h.revision OR c."predecessorRevision"<>c.revision-1 THEN RETURN false; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=c."receiptId" AND "customerId"=c."customerId" AND "sourceId"=c."sourceId";
  IF NOT FOUND OR r.kind<>'CSV_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
    OR ROW(r."configRevision",r."mappingRevision") IS DISTINCT FROM ROW(c."configRevision",c."mappingRevision") THEN RETURN false; END IF;
  SELECT mapping INTO mapping_value FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND revision=c."configRevision" AND "mappingRevision"=c."mappingRevision" AND sealed;
  SELECT mapping INTO activation_mapping FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId" AND revision=h."activationConfigRevision" AND "mappingRevision"=h."mappingRevision" AND sealed;
  IF mapping_value IS NULL OR activation_mapping IS NULL OR mapping_value->>'kind' IS DISTINCT FROM 'CSV'
    OR mapping_value IS DISTINCT FROM activation_mapping OR public.valid_ingestion_mapping(mapping_value) IS NOT TRUE THEN RETURN false; END IF;
  SELECT jsonb_agg(jsonb_build_array(value->>'factType',value->>'type') ORDER BY (value->>'factType') COLLATE "C")
    INTO expected_dictionary FROM jsonb_array_elements(mapping_value->'fields');
  IF h.dictionary IS DISTINCT FROM expected_dictionary THEN RETURN false; END IF;
  encoded := public.ingestion_csv_state_text(c."customerId",c."sourceId",c."mappingRevision",h.dictionary,c.rows);
  IF encoded IS NULL OR octet_length(convert_to(encoded,'UTF8'))<>c."canonicalBytes"
    OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>c."stateHash" THEN RETURN false; END IF;
  IF c.revision=1 THEN
    IF c."predecessorReceiptId" IS NOT NULL THEN RETURN false; END IF;
    prior_encoded := public.ingestion_csv_state_text(c."customerId",c."sourceId",c."mappingRevision",h.dictionary,prior_rows);
    IF prior_encoded IS NULL OR encode(sha256(convert_to(prior_encoded,'UTF8')),'hex')<>c."predecessorHash" THEN RETURN false; END IF;
  ELSE
    SELECT * INTO parent FROM public."IngestionCsvContext"
      WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND "receiptId"=c."predecessorReceiptId"
        AND revision=c."predecessorRevision" AND "stateHash"=c."predecessorHash" AND "mappingRevision"=c."mappingRevision";
    IF NOT FOUND THEN RETURN false; END IF;
    prior_rows := parent.rows;
    -- Identical rows under these same codec inputs have the same validated bytes.
    prior_encoded := CASE WHEN prior_rows=c.rows THEN encoded
      ELSE public.ingestion_csv_state_text(c."customerId",c."sourceId",c."mappingRevision",h.dictionary,prior_rows) END;
    IF prior_encoded IS NULL OR octet_length(convert_to(prior_encoded,'UTF8'))<>parent."canonicalBytes"
      OR encode(sha256(convert_to(prior_encoded,'UTF8')),'hex')<>parent."stateHash" THEN RETURN false; END IF;
  END IF;

  -- A comparison can widen the complete prior configuration scope, never narrow
  -- it merely because one configured project had no accepted observation yet.
  IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" previous_scope
    WHERE previous_scope."customerId"=c."customerId" AND previous_scope."sourceId"=c."sourceId"
      AND previous_scope."configRevision"=CASE WHEN c.revision=1 THEN h."activationConfigRevision" ELSE parent."configRevision" END
      AND NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" current_scope
        WHERE current_scope."customerId"=c."customerId" AND current_scope."sourceId"=c."sourceId"
          AND current_scope."configRevision"=c."configRevision" AND current_scope."projectId"=previous_scope."projectId")) THEN RETURN false; END IF;
  -- Every retained identity belongs to the receipt's immutable mapping and scope.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(c.rows) identity_row
    WHERE NOT EXISTS (
      SELECT 1 FROM public."IngestionExternalRecord" e
      JOIN public."IngestionConfigurationProject" cp ON cp."customerId"=e."customerId" AND cp."sourceId"=e."sourceId"
        AND cp."projectId"=e."projectId" AND cp."configRevision"=c."configRevision"
      WHERE e."customerId"=c."customerId" AND e."sourceId"=c."sourceId" AND e.id=(identity_row->>1)::uuid
        AND e."projectId"=(identity_row->>2)::uuid AND e."recordKey" COLLATE "C"=(identity_row->>0) COLLATE "C"
        AND e."recordType" COLLATE "C"=('spreadsheet:'||(mapping_value->>'sheet')) COLLATE "C"
    )
  ) THEN RETURN false; END IF;
  -- Validate each projection binding once with all fields it must supply.
  IF EXISTS (
    WITH required_pairs AS MATERIALIZED (
      SELECT (identity_row->>1)::uuid AS record_id,(field_ref->>1)::uuid AS projection_id,
        array_agg((h.dictionary->((field_ref->>0)::integer)->>0) COLLATE "C") AS field_names
      FROM jsonb_array_elements(c.rows) identity_row
      CROSS JOIN LATERAL jsonb_array_elements(identity_row->3) field_ref
      GROUP BY 1,2
    )
    SELECT 1 FROM required_pairs required
    LEFT JOIN public."IngestionProposalProjection" p ON p.id=required.projection_id
      AND p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
      AND p."recordId"=required.record_id AND p."mappingRevision"=c."mappingRevision"
    LEFT JOIN public."IngestionProposalContent" content ON content."customerId"=p."customerId" AND content."sourceId"=p."sourceId"
      AND content."recordId"=p."recordId" AND content."projectionId"=p.id
    WHERE p.id IS NULL OR content."projectionId" IS NULL
      OR (required.field_names COLLATE "C" <@ p."factTypes" COLLATE "C") IS NOT TRUE
  ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id
    AND ROW(o."customerId",o."sourceId") IS DISTINCT FROM ROW(c."customerId",c."sourceId")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND o.state='ACCEPTED'
    AND (cardinality(o."errorCodes")<>0 OR NOT EXISTS (
      SELECT 1 FROM public."IngestionProposalProjection" p
      JOIN public."IngestionExternalRecord" e ON e."customerId"=p."customerId" AND e."sourceId"=p."sourceId" AND e.id=p."recordId"
      JOIN public."IngestionProposalContent" content ON content."customerId"=p."customerId" AND content."sourceId"=p."sourceId"
        AND content."recordId"=p."recordId" AND content."projectionId"=p.id
      WHERE p.id=o."projectionId" AND p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
        AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=c."mappingRevision"
        AND e."recordKey" COLLATE "C"=o."recordKey" COLLATE "C" AND e."projectId"=o."projectId"
        AND e."recordType" COLLATE "C"=('spreadsheet:'||(mapping_value->>'sheet')) COLLATE "C"
    ))) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id
    GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED' AND (
      (cardinality(p."factTypes")=0 AND o.operation IS DISTINCT FROM
        CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior
          WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C") THEN 'UNCHANGED' ELSE 'NONE' END)
      OR EXISTS (SELECT 1 FROM unnest(p."factTypes") ft(value) WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(h.dictionary) entry WHERE (entry->>0) COLLATE "C"=ft.value COLLATE "C"))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(mapping_value->'fields') field
        WHERE field->>'required'='true' AND NOT ((field->>'factType') COLLATE "C"=ANY(p."factTypes")))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C"
        AND ROW((prior->>1)::uuid,(prior->>2)::uuid) IS DISTINCT FROM ROW(o."recordId",o."projectId"))
      OR (cardinality(p."factTypes")>0 AND (
        (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C") AND o.operation<>'CREATE')
        OR (EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C") AND o.operation NOT IN ('UPDATE','UNCHANGED'))
      ))
    )
  ) THEN RETURN false; END IF;

  -- An overlay with no accepted rows is exactly the validated predecessor.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id AND state='ACCEPTED'
  ) THEN (
    WITH dictionary AS (
      SELECT (ordinal-1)::integer AS field_index,entry->>0 AS fact_type
      FROM jsonb_array_elements(h.dictionary) WITH ORDINALITY d(entry,ordinal)
    ), prior AS (
      SELECT (entry->>0) COLLATE "C" AS key,(entry->>1)::uuid AS record_id,(entry->>2)::uuid AS project_id,entry->3 AS refs
      FROM jsonb_array_elements(prior_rows) entry
    ), observed AS (
      SELECT o."recordKey" COLLATE "C" AS key,o."recordId" AS record_id,o."projectId" AS project_id,p.id AS projection_id,p."factTypes" AS fact_types
      FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
      WHERE o."receiptId"=r.id AND o.state='ACCEPTED'
    ), identities AS (
      SELECT key,record_id,project_id FROM prior UNION SELECT key,record_id,project_id FROM observed
    ), supplied AS (
      SELECT o.key,d.field_index,o.projection_id FROM observed o CROSS JOIN LATERAL unnest(o.fact_types) ft(value)
      JOIN dictionary d ON d.fact_type COLLATE "C"=ft.value COLLATE "C"
    ), carried AS (
      SELECT p.key,(ref->>0)::integer AS field_index,(ref->>1)::uuid AS projection_id
      FROM prior p CROSS JOIN LATERAL jsonb_array_elements(p.refs) ref
      WHERE NOT EXISTS (SELECT 1 FROM supplied s WHERE s.key=p.key AND s.field_index=(ref->>0)::integer)
    ), refs AS (
      SELECT * FROM supplied UNION ALL SELECT * FROM carried
    ), grouped_refs AS (
      SELECT key,jsonb_agg(jsonb_build_array(field_index::text,projection_id::text) ORDER BY field_index) AS refs
      FROM refs GROUP BY key
    ), merged AS (
      SELECT i.key,jsonb_build_array(i.key,i.record_id::text,i.project_id::text,COALESCE(g.refs,'[]'::jsonb)) AS entry
      FROM identities i LEFT JOIN grouped_refs g ON g.key=i.key
    ) SELECT COALESCE(jsonb_agg(entry ORDER BY key COLLATE "C"),'[]'::jsonb) FROM merged
  ) ELSE prior_rows END INTO expected_rows;
  RETURN c.rows=expected_rows;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.guard_ingestion_csv_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  r public."IngestionOperationReceipt"%ROWTYPE;
  h public."IngestionCsvHead"%ROWTYPE;
  planned_head public."IngestionCsvHead"%ROWTYPE;
  s public."IngestionSource"%ROWTYPE;
  policy public."IngestionRetentionPolicy"%ROWTYPE;
  cfg public."IngestionConfigurationRevision"%ROWTYPE;
  activation_mapping jsonb;
  parent public."IngestionCsvContext"%ROWTYPE;
  prior_rows jsonb := '[]'::jsonb;
  project_ids uuid[];
  projection_ids uuid[];
  item record;
  projection_row record;
  outcome_row record;
  locked_projects integer := 0;
  locked_content integer := 0;
  actual_outcomes integer;
  first_ordinal integer;
  last_ordinal integer;
  content_bytes bigint;
  content_valid boolean;
  encoded text;
  prior_encoded text;
  expected_rows jsonb;
  proposal jsonb;
  field_type text;
  field_types jsonb;
  identity_uncertain boolean;
  missing_previous boolean;
  prior_identity jsonb;
  expected_operation text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CSV comparison history is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR r.kind<>'CSV_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
    OR ROW(r."configRevision",r."mappingRevision") IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN
    RAISE EXCEPTION 'Invalid CSV comparison context';
  END IF;
  SELECT * INTO planned_head FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR planned_head.readiness<>'READY' OR planned_head."mappingRevision"<>NEW."mappingRevision"
    OR NEW.revision<>planned_head.revision+1 OR NEW."predecessorRevision"<>planned_head.revision
    OR NEW."predecessorReceiptId" IS DISTINCT FROM planned_head."currentReceiptId"
    OR NEW."predecessorHash" IS DISTINCT FROM planned_head."stateHash" THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  encoded:=public.ingestion_csv_state_text(NEW."customerId",NEW."sourceId",NEW."mappingRevision",planned_head.dictionary,NEW.rows);
  IF encoded IS NULL OR NEW."canonicalBytes" IS DISTINCT FROM octet_length(convert_to(encoded,'UTF8'))
    OR NEW."stateHash"::text IS DISTINCT FROM encode(sha256(convert_to(encoded,'UTF8')),'hex') THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  IF planned_head.revision>0 THEN
    SELECT * INTO parent FROM public."IngestionCsvContext" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
      AND "receiptId"=planned_head."currentReceiptId" AND revision=planned_head.revision AND "stateHash"=planned_head."stateHash";
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
    prior_rows:=parent.rows;
  END IF;
  prior_encoded:=CASE WHEN prior_rows=NEW.rows THEN encoded
    ELSE public.ingestion_csv_state_text(NEW."customerId",NEW."sourceId",NEW."mappingRevision",planned_head.dictionary,prior_rows) END;
  IF prior_encoded IS NULL OR encode(sha256(convert_to(prior_encoded,'UTF8')),'hex')<>planned_head."stateHash" THEN
    RAISE EXCEPTION 'Invalid CSV comparison context';
  END IF;
  SELECT COALESCE(array_agg(project_id ORDER BY project_id),'{}'::uuid[]) INTO project_ids FROM (
    SELECT "projectId" AS project_id FROM public."IngestionConfigurationProject"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW."configRevision"
    UNION SELECT "projectId" FROM public."IngestionConfigurationProject"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
        AND "configRevision"=CASE WHEN planned_head.revision=0 THEN planned_head."activationConfigRevision" ELSE parent."configRevision" END
    UNION SELECT (value->>2)::uuid FROM jsonb_array_elements(prior_rows)
  ) planned;
  IF cardinality(project_ids) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  -- All projects, then all applicable grants, then policy/source/head/content.
  -- Direct callers cannot assert that the repository already owns these fences.
  FOR item IN SELECT p.id FROM public."Project" p WHERE p."customerId"=NEW."customerId" AND p.id=ANY(project_ids) ORDER BY p.id FOR UPDATE LOOP
    locked_projects:=locked_projects+1;
  END LOOP;
  IF locked_projects<>cardinality(project_ids) THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  FOR item IN SELECT g.id FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=r.subject AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
      AND EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=NEW."customerId" AND p.id=ANY(project_ids)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
    ORDER BY g.id FOR SHARE LOOP
    NULL;
  END LOOP;
  SELECT * INTO policy FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
  IF NOT FOUND OR ROW(s."currentConfigRevision",s."mappingRevision") IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN
    RAISE EXCEPTION USING ERRCODE='PDC02',MESSAGE='CSV comparison conflict';
  END IF;
  SELECT * INTO h FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" FOR UPDATE;
  IF NOT FOUND OR to_jsonb(h) IS DISTINCT FROM to_jsonb(planned_head) OR public.valid_ingestion_csv_head(h."customerId",h."sourceId") IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='PDC02',MESSAGE='CSV comparison conflict';
  END IF;
  IF h.revision>=4096 OR h."canonicalHistoryBytes"+NEW."canonicalBytes">268435456 THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  SELECT * INTO cfg FROM public."IngestionConfigurationRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
    AND revision=NEW."configRevision" AND "mappingRevision"=NEW."mappingRevision" AND sealed;
  SELECT mapping INTO activation_mapping FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId" AND revision=h."activationConfigRevision" AND "mappingRevision"=h."mappingRevision" AND sealed;
  IF cfg.revision IS NULL OR cfg.mapping->>'kind' IS DISTINCT FROM 'CSV' OR cfg.mapping IS DISTINCT FROM activation_mapping THEN
    RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(project_ids) scope(project_id) JOIN public."Project" project ON project."customerId"=NEW."customerId" AND project.id=scope.project_id
    WHERE NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW."sourceId"
        AND cp."configRevision"=NEW."configRevision" AND cp."projectId"=scope.project_id)
      OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader WHERE reader."customerId"=NEW."customerId" AND reader."sourceId"=NEW."sourceId"
        AND reader."configRevision"=NEW."configRevision" AND reader."projectId"=scope.project_id AND reader.subject=r.subject)
      OR NOT EXISTS (
        SELECT 1 FROM public."IngestionReceiptProjectScope" snap JOIN public."AccessGrant" g ON g.id=snap."grantId"
        WHERE snap."receiptId"=r.id AND snap."customerId"=NEW."customerId" AND snap."sourceId"=NEW."sourceId" AND snap."projectId"=scope.project_id
          AND g."customerId"=NEW."customerId" AND g.subject=r.subject AND g.role=snap."grantRole" AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
          AND g."scopeType"=snap."grantScopeType" AND g."scopeId"=snap."grantScopeId"
          AND ((g."scopeType"='project' AND g."scopeId"=project.id) OR (g."scopeType"='portfolio' AND g."scopeId"=project."portfolioId"))
      )
  ) THEN RAISE EXCEPTION USING ERRCODE='PDC03',MESSAGE='CSV comparison denied'; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_outcomes,first_ordinal,last_ordinal
    FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_outcomes<>r."outcomeCount" OR (actual_outcomes>0 AND (first_ordinal<>1 OR last_ordinal<>actual_outcomes))
    OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND ROW(o."customerId",o."sourceId") IS DISTINCT FROM ROW(NEW."customerId",NEW."sourceId")) THEN
    RAISE EXCEPTION 'Invalid CSV comparison context';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND o.state='ACCEPTED' AND (
      cardinality(o."errorCodes")<>0 OR NOT EXISTS (
        SELECT 1 FROM public."IngestionProposalProjection" p JOIN public."IngestionExternalRecord" e
          ON e."customerId"=p."customerId" AND e."sourceId"=p."sourceId" AND e.id=p."recordId"
        WHERE p.id=o."projectionId" AND p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p."recordId"=o."recordId"
          AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=NEW."mappingRevision" AND e."projectId"=o."projectId"
          AND e."projectId"=ANY(project_ids) AND e."recordKey" COLLATE "C"=o."recordKey" COLLATE "C"
          AND e."recordType" COLLATE "C"=('spreadsheet:'||(cfg.mapping->>'sheet')) COLLATE "C"
      )
    )
  ) OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id
    GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED' AND (
      EXISTS (SELECT 1 FROM unnest(p."factTypes") ft(value) WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(h.dictionary) entry WHERE (entry->>0) COLLATE "C"=ft.value COLLATE "C"))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(cfg.mapping->'fields') field WHERE field->>'required'='true'
        AND NOT ((field->>'factType') COLLATE "C"=ANY(p."factTypes")))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C"
        AND ROW((prior->>1)::uuid,(prior->>2)::uuid) IS DISTINCT FROM ROW(o."recordId",o."projectId"))
    )
  ) THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;

  -- Exact metadata overlay, before dereferencing any supplied state references.
  -- An overlay with no accepted rows is exactly the validated predecessor.
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id AND state='ACCEPTED'
  ) THEN (
    WITH dictionary AS (
      SELECT (ordinal-1)::integer AS field_index,entry->>0 AS fact_type FROM jsonb_array_elements(h.dictionary) WITH ORDINALITY d(entry,ordinal)
    ), prior AS (
      SELECT (entry->>0) COLLATE "C" AS key,(entry->>1)::uuid AS record_id,(entry->>2)::uuid AS project_id,entry->3 AS refs FROM jsonb_array_elements(prior_rows) entry
    ), observed AS (
      SELECT o."recordKey" COLLATE "C" AS key,o."recordId" AS record_id,o."projectId" AS project_id,p.id AS projection_id,p."factTypes" AS fact_types
      FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId" WHERE o."receiptId"=r.id AND o.state='ACCEPTED'
    ), identities AS (
      SELECT key,record_id,project_id FROM prior UNION SELECT key,record_id,project_id FROM observed
    ), supplied AS (
      SELECT o.key,d.field_index,o.projection_id FROM observed o CROSS JOIN LATERAL unnest(o.fact_types) ft(value)
      JOIN dictionary d ON d.fact_type COLLATE "C"=ft.value COLLATE "C"
    ), carried AS (
      SELECT p.key,(ref->>0)::integer AS field_index,(ref->>1)::uuid AS projection_id FROM prior p CROSS JOIN LATERAL jsonb_array_elements(p.refs) ref
      WHERE NOT EXISTS (SELECT 1 FROM supplied v WHERE v.key=p.key AND v.field_index=(ref->>0)::integer)
    ), refs AS (
      SELECT * FROM supplied UNION ALL SELECT * FROM carried
    ), grouped_refs AS (
      SELECT key,jsonb_agg(jsonb_build_array(field_index::text,projection_id::text) ORDER BY field_index) AS refs
      FROM refs GROUP BY key
    ), merged AS (
      SELECT i.key,jsonb_build_array(i.key,i.record_id::text,i.project_id::text,COALESCE(g.refs,'[]'::jsonb)) AS entry
      FROM identities i LEFT JOIN grouped_refs g ON g.key=i.key
    ) SELECT COALESCE(jsonb_agg(entry ORDER BY key COLLATE "C"),'[]'::jsonb) FROM merged
  ) ELSE prior_rows END INTO expected_rows;
  IF NEW.rows IS DISTINCT FROM expected_rows THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO projection_ids FROM (
    SELECT (ref->>1)::uuid AS id FROM jsonb_array_elements(prior_rows) identity_row CROSS JOIN LATERAL jsonb_array_elements(identity_row->3) ref
    UNION SELECT "projectionId" FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id AND state='ACCEPTED'
  ) required;
  IF cardinality(projection_ids)>33000 THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  FOR item IN SELECT content."projectionId" FROM public."IngestionProposalContent" content
    WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids)
    ORDER BY content."projectionId" FOR SHARE LOOP
    locked_content:=locked_content+1;
  END LOOP;
  IF locked_content<>cardinality(projection_ids) THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  -- Only count/byte/availability metadata is returned until the entire bound passes.
  SELECT count(*)::integer,COALESCE(sum(octet_length(content.proposals::text)),0),
    COALESCE(bool_and(content.proposals IS NOT NULL AND content."redactedAt" IS NULL
      AND revision."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp()),true)
    INTO locked_content,content_bytes,content_valid
    FROM public."IngestionProposalContent" content
    JOIN public."IngestionProposalProjection" p ON p.id=content."projectionId" AND p."customerId"=content."customerId"
      AND p."sourceId"=content."sourceId" AND p."recordId"=content."recordId" AND p."mappingRevision"=NEW."mappingRevision"
    JOIN public."IngestionSourceRevision" revision ON revision.id=p."sourceRevisionId" AND revision."customerId"=p."customerId"
      AND revision."sourceId"=p."sourceId" AND revision."recordId"=p."recordId"
    WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids);
  IF locked_content<>cardinality(projection_ids) OR content_valid IS NOT TRUE OR content_bytes>4194304 THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  SELECT jsonb_object_agg(entry->>0,entry->1) INTO field_types
    FROM jsonb_array_elements(h.dictionary) AS d(entry);
  FOR projection_row IN SELECT p.id,content.proposals FROM public."IngestionProposalProjection" p
    JOIN public."IngestionProposalContent" content ON content."projectionId"=p.id AND content."customerId"=p."customerId"
      AND content."sourceId"=p."sourceId" AND content."recordId"=p."recordId"
    WHERE p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p.id=ANY(projection_ids) ORDER BY p.id
  LOOP
    IF public.valid_ingestion_projection_content(projection_row.id,projection_row.proposals) IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
    FOR proposal IN SELECT value FROM jsonb_array_elements(projection_row.proposals) LOOP
      field_type:=field_types->>(proposal->>'factType');
      IF field_type IS NULL OR (proposal->'value'->>'type') IS DISTINCT FROM field_type THEN RAISE EXCEPTION 'Invalid CSV comparison value'; END IF;
      IF field_type='number' AND abs((proposal->'value'->>'value')::numeric)>9007199254740991 THEN RAISE EXCEPTION 'Invalid CSV comparison value'; END IF;
      IF field_type='text' AND proposal->'value'->>'value'='' THEN RAISE EXCEPTION 'Invalid CSV comparison value'; END IF;
      IF field_type='text' AND left(ltrim(proposal->'value'->>'value',E'\t\n\f\r '||U&'\000b\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff'),1) IN ('=','+','-','@') THEN
        RAISE EXCEPTION 'Invalid CSV comparison value';
      END IF;
    END LOOP;
  END LOOP;
  SELECT EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id
    AND (o."recordKey" IS NULL OR o."errorCodes" && ARRAY['INVALID_KEY','DUPLICATE_KEY','INVALID_PROJECT','PROJECT_CHANGED','ROW_IDENTITY_REVIEW']::text[]))
    OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id AND "recordKey" IS NOT NULL GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1)
    INTO identity_uncertain;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE NOT EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND o."recordKey" COLLATE "C"=(prior->>0) COLLATE "C")) INTO missing_previous;
  FOR outcome_row IN SELECT o.*,content.proposals FROM public."IngestionRowOutcome" o
    JOIN public."IngestionProposalContent" content ON content."projectionId"=o."projectionId" AND content."customerId"=o."customerId"
      AND content."sourceId"=o."sourceId" AND content."recordId"=o."recordId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED' ORDER BY o.ordinal
  LOOP
    SELECT value INTO prior_identity FROM jsonb_array_elements(prior_rows) WHERE (value->>0) COLLATE "C"=outcome_row."recordKey" COLLATE "C";
    IF prior_identity IS NULL AND (identity_uncertain OR missing_previous) THEN RAISE EXCEPTION 'Invalid CSV comparison identity'; END IF;
    IF jsonb_array_length(outcome_row.proposals)=0 THEN
      expected_operation:=CASE WHEN prior_identity IS NULL THEN 'NONE' ELSE 'UNCHANGED' END;
    ELSIF prior_identity IS NULL THEN expected_operation:='CREATE';
    ELSIF EXISTS (
      SELECT 1 FROM jsonb_array_elements(outcome_row.proposals) supplied WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(prior_identity->3) ref
        JOIN public."IngestionProposalContent" previous ON previous."projectionId"=(ref->>1)::uuid
          AND previous."customerId"=NEW."customerId" AND previous."sourceId"=NEW."sourceId" AND previous."recordId"=outcome_row."recordId"
        CROSS JOIN LATERAL jsonb_array_elements(previous.proposals) prior_value
        WHERE (h.dictionary->((ref->>0)::integer)->>0) COLLATE "C"=(supplied->>'factType') COLLATE "C"
          AND (prior_value->>'factType') COLLATE "C"=(supplied->>'factType') COLLATE "C" AND prior_value->'value'=supplied->'value'
      )
    ) THEN expected_operation:='UPDATE';
    ELSE expected_operation:='UNCHANGED'; END IF;
    IF outcome_row.operation IS DISTINCT FROM expected_operation THEN RAISE EXCEPTION 'Invalid CSV comparison operation'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Check each reference and compare its canonical index directly with the prior
-- ordinal. Check the unchanged UUID grammar once per distinct projection.
CREATE OR REPLACE FUNCTION public.ingestion_csv_state_text(
  state_customer uuid, state_source uuid, state_mapping integer,
  state_dictionary jsonb, state_rows jsonb
) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE
  entry jsonb;
  identity_row jsonb;
  field_name text;
  previous_field text := '';
  identity_key text;
  previous_key text := '';
  record_id text;
  project_id text;
  dictionary_length integer;
  field_indexes jsonb;
  identity_count integer;
  distinct_records integer;
  distinct_projects integer;
  canonical_text text;
BEGIN
  IF state_customer IS NULL OR state_source IS NULL OR state_mapping IS NULL OR state_mapping<=0 THEN RETURN NULL; END IF;
  IF jsonb_typeof(state_dictionary) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF jsonb_typeof(state_rows) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  dictionary_length := jsonb_array_length(state_dictionary);
  identity_count := jsonb_array_length(state_rows);
  IF dictionary_length NOT BETWEEN 1 AND 32 OR identity_count>1000 THEN RETURN NULL; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(state_dictionary) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF jsonb_array_length(entry)<>2 THEN RETURN NULL; END IF;
    IF jsonb_typeof(entry->0) IS DISTINCT FROM 'string' OR jsonb_typeof(entry->1) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
    field_name := entry->>0;
    IF octet_length(field_name) NOT BETWEEN 1 AND 96 THEN RETURN NULL; END IF;
    IF field_name COLLATE "C" !~ '^[a-z][a-z0-9_.-]{0,95}$'
      OR field_name COLLATE "C" ~ '[^a-z0-9_.-]'
      OR field_name COLLATE "C" <= previous_field COLLATE "C"
      OR entry->>1 NOT IN ('text','date','number','boolean') THEN RETURN NULL; END IF;
    previous_field := field_name;
  END LOOP;
  FOR identity_row IN SELECT value FROM jsonb_array_elements(state_rows) LOOP
    IF jsonb_typeof(identity_row) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF jsonb_array_length(identity_row)<>4 THEN RETURN NULL; END IF;
    IF jsonb_typeof(identity_row->0) IS DISTINCT FROM 'string'
      OR jsonb_typeof(identity_row->1) IS DISTINCT FROM 'string'
      OR jsonb_typeof(identity_row->2) IS DISTINCT FROM 'string'
      OR jsonb_typeof(identity_row->3) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    identity_key := identity_row->>0;
    record_id := identity_row->>1;
    project_id := identity_row->>2;
    IF octet_length(identity_key)<>64 OR octet_length(record_id)<>36 OR octet_length(project_id)<>36 THEN RETURN NULL; END IF;
    IF identity_key COLLATE "C" !~ '^[a-f0-9]{64}$'
      OR identity_key COLLATE "C" <= previous_key COLLATE "C"
      OR record_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      OR project_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN NULL; END IF;
    IF jsonb_array_length(identity_row->3)>32 THEN RETURN NULL; END IF;
    previous_key := identity_key;
  END LOOP;
  -- The first pass bounds every identity's reference array. Check the bounded
  -- references against the canonical decimal keys of the validated dictionary.
  SELECT jsonb_object_agg(value::text,true) INTO field_indexes
    FROM generate_series(0,dictionary_length-1) value;
  IF EXISTS (
    WITH parsed AS MATERIALIZED (
      SELECT CASE WHEN field.ordinal>1 THEN row_entry.row_value->3->(field.ordinal::integer-2)->>0 END AS previous_index,
        CASE WHEN jsonb_typeof(field.ref)='array' THEN jsonb_array_length(field.ref) END AS arity,
        CASE WHEN jsonb_typeof(field.ref->0)='string'
          AND octet_length(field.ref->>0) BETWEEN 1 AND 2
          THEN field.ref->>0 END AS field_index,
        CASE WHEN jsonb_typeof(field.ref->1)='string' THEN (field.ref->>1) COLLATE "C" END AS projection_id
      FROM jsonb_array_elements(state_rows) row_entry(row_value)
      CROSS JOIN LATERAL jsonb_array_elements(row_entry.row_value->3) WITH ORDINALITY field(ref,ordinal)
    ), distinct_projections AS MATERIALIZED (
      SELECT DISTINCT projection_id FROM parsed
    )
    SELECT 1 FROM parsed WHERE arity IS DISTINCT FROM 2 OR octet_length(projection_id) IS DISTINCT FROM 36
      OR (field_indexes ? field_index) IS NOT TRUE OR octet_length(previous_index)>octet_length(field_index)
      OR (octet_length(previous_index)=octet_length(field_index)
        AND previous_index COLLATE "C">=field_index COLLATE "C")
    UNION ALL
    SELECT 1 FROM distinct_projections WHERE projection_id COLLATE "C" !~
      '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  ) THEN RETURN NULL; END IF;
  -- Set-based bounded counts avoid a growing per-row linear membership scan.
  SELECT count(DISTINCT (value->>1) COLLATE "C"),count(DISTINCT (value->>2) COLLATE "C")
    INTO distinct_records,distinct_projects FROM jsonb_array_elements(state_rows);
  IF distinct_records<>identity_count OR distinct_projects>100 THEN RETURN NULL; END IF;
  -- Permitted tokens are all ASCII and contain neither spaces nor escapes.
  canonical_text := replace(jsonb_build_array('pdaa.csv.state.v1',state_customer::text,
    state_source::text,state_mapping::text,state_dictionary,state_rows)::text,' ','');
  IF octet_length(convert_to(canonical_text,'UTF8'))>2097152 THEN RETURN NULL; END IF;
  RETURN canonical_text;
END $$;
