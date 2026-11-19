-- FR-CON-006/007: scoped native workbook preview read and append for the API.
-- All locks belong to the caller's short post-decode transaction.
CREATE FUNCTION public.lock_ingestion_xlsx_preview(
  customer uuid, source uuid, actor_subject text, actor_roles text[], command_key text,
  config_revision integer, mapping_revision integer, sheet text, parser_contract text
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  denied CONSTANT jsonb := '{"status":"DENIED"}';
  unavailable CONSTANT jsonb := '{"status":"INVALID_PREVIEW"}';
  planned_config integer;
  projects uuid[];
  eligible uuid[];
  locked_count integer;
  retained_config integer;
  live_source public."IngestionSource"%ROWTYPE;
  head public."IngestionXlsxHead"%ROWTYPE;
  policy public."IngestionRetentionPolicy"%ROWTYPE;
  mapping jsonb;
  prior_rows jsonb := '[]';
  witness jsonb;
BEGIN
  IF session_user<>'pdaa_api' OR customer IS NULL OR source IS NULL
    OR public.ingestion_xlsx_v1_text(to_jsonb(actor_subject),256) IS NULL
    OR array_ndims(actor_roles) IS DISTINCT FROM 1 OR cardinality(actor_roles) NOT BETWEEN 1 AND 3
    OR EXISTS (SELECT 1 FROM unnest(actor_roles) a(role)
      WHERE role IS NULL OR role NOT IN ('project_manager','portfolio_manager','pmo_admin'))
    OR (command_key COLLATE "C" ~ '^[A-Za-z0-9_-]{1,128}$') IS NOT TRUE
    OR config_revision IS NULL OR config_revision<1 OR mapping_revision IS NULL OR mapping_revision<1
    OR public.ingestion_xlsx_v1_text(to_jsonb(sheet),31) IS NULL
    OR translate(sheet,E'\\/*?:[]','')<>sheet OR sheet COLLATE "C" ~* '_x[0-9a-f]{4}_'
    OR (parser_contract IN ('portable-v1','excel-text-v1')) IS NOT TRUE
  THEN RETURN denied; END IF;

  SELECT s."currentConfigRevision" INTO planned_config FROM public."IngestionSource" s
    WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX';
  IF NOT FOUND OR planned_config IS NULL THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT p."projectId" FROM public."IngestionConfigurationProject" p
    WHERE p."customerId"=customer AND p."sourceId"=source AND p."configRevision"=planned_config
    ORDER BY p."projectId" LIMIT 101) INTO projects;
  IF cardinality(projects) NOT BETWEEN 1 AND 100 OR EXISTS (
    SELECT 1 FROM unnest(projects) scope(project_id)
    WHERE NOT EXISTS (SELECT 1 FROM public."Project" p JOIN public."AccessGrant" g
      ON g."customerId"=p."customerId" AND g.subject=actor_subject AND g.role=ANY(actor_roles)
      AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
      WHERE p."customerId"=customer AND p.id=scope.project_id)
    OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
      AND r."sourceId"=source AND r."configRevision"=planned_config AND r."projectId"=scope.project_id AND r.subject=actor_subject)
  ) THEN RETURN denied; END IF;

  PERFORM p.id FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(projects)
    ORDER BY p.id FOR UPDATE OF p NOWAIT;
  GET DIAGNOSTICS locked_count=ROW_COUNT;
  IF locked_count<>cardinality(projects) THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT g.id FROM public."AccessGrant" g
    WHERE g."customerId"=customer AND g.subject=actor_subject AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
      AND EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(projects)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
    ORDER BY g.id FOR SHARE OF g NOWAIT) INTO eligible;
  IF EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(projects)
    AND NOT EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g.id=ANY(eligible) AND g.role=ANY(actor_roles)
      AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))))
  THEN RETURN denied; END IF;
  SELECT p.* INTO policy FROM public."IngestionRetentionPolicy" p WHERE p."customerId"=customer FOR SHARE OF p NOWAIT;
  IF NOT FOUND THEN RETURN unavailable; END IF;
  SELECT s.* INTO live_source FROM public."IngestionSource" s
    WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX' FOR UPDATE OF s NOWAIT;
  IF NOT FOUND OR live_source."currentConfigRevision" IS DISTINCT FROM planned_config THEN
    RETURN '{"status":"RETRY"}';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(projects) scope(project_id) WHERE NOT EXISTS (
    SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
      AND r."sourceId"=source AND r."configRevision"=planned_config AND r."projectId"=scope.project_id AND r.subject=actor_subject
  )) THEN RETURN denied; END IF;

  SELECT r."configRevision" INTO retained_config FROM public."IngestionOperationReceipt" r
    WHERE r."customerId"=customer AND r."sourceId"=source AND r.subject=actor_subject
      AND r.kind='XLSX_PREVIEW' AND r."commandKey"=command_key;
  IF FOUND THEN
    -- Do not upgrade M33 locks or expose receipt metadata under a current-only
    -- grant. The service leaves this transaction before invoking exact replay.
    IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=customer
      AND p."sourceId"=source AND p."configRevision"=retained_config
      AND (NOT (p."projectId"=ANY(projects)) OR NOT EXISTS (
        SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer AND r."sourceId"=source
          AND r."configRevision"=retained_config AND r."projectId"=p."projectId" AND r.subject=actor_subject)))
    THEN RETURN denied; END IF;
    RETURN '{"status":"RECHECK"}';
  END IF;
  SELECT c.mapping INTO mapping FROM public."IngestionConfigurationRevision" c
    WHERE c."customerId"=customer AND c."sourceId"=source AND c.revision=planned_config
      AND c."mappingRevision"=live_source."mappingRevision" AND c.sealed;
  IF NOT FOUND OR public.valid_ingestion_xlsx_mapping(mapping) IS NOT TRUE THEN RETURN unavailable; END IF;
  IF ROW(config_revision,mapping_revision,sheet,parser_contract) IS DISTINCT FROM
    ROW(planned_config,live_source."mappingRevision",mapping->>'sheet',mapping->>'parserContract')
  THEN RETURN '{"status":"STALE_CONFIGURATION"}'; END IF;

  SELECT h.* INTO head FROM public."IngestionXlsxHead" h
    WHERE h."customerId"=customer AND h."sourceId"=source FOR UPDATE OF h NOWAIT;
  IF NOT FOUND OR head.revision>=4096 OR head."canonicalHistoryBytes">=268435456
    OR public.valid_ingestion_xlsx_head(customer,source) IS NOT TRUE THEN RETURN unavailable; END IF;
  retained_config := head."activationConfigRevision";
  IF head.revision>0 THEN
    SELECT r."configRevision" INTO retained_config FROM public."IngestionOperationReceipt" r
      WHERE r."customerId"=customer AND r."sourceId"=source AND r.id=head."currentReceiptId" AND r.kind='XLSX_PREVIEW';
    IF NOT FOUND THEN RETURN unavailable; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p
    WHERE p."customerId"=customer AND p."sourceId"=source AND p."configRevision"=retained_config)
    OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=customer
      AND p."sourceId"=source AND p."configRevision"=retained_config AND NOT (p."projectId"=ANY(projects)))
  THEN RETURN unavailable; END IF;
  IF head.revision>0 THEN
    IF public.valid_ingestion_xlsx_context(head."currentReceiptId") IS NOT TRUE THEN RETURN unavailable; END IF;
    SELECT c.rows INTO prior_rows FROM public."IngestionXlsxContext" c WHERE c."customerId"=customer AND c."sourceId"=source
      AND c.revision=head.revision AND c."receiptId"=head."currentReceiptId" AND c."stateSha256"=head."stateSha256";
    IF NOT FOUND THEN RETURN unavailable; END IF;
  END IF;
  witness := jsonb_build_object('revision',head.revision,'receiptId',head."currentReceiptId",
    'stateSha256',coalesce(head."stateSha256",head."genesisSha256")::text);
  RETURN jsonb_build_object('status','READY','mapping',mapping,'projectIds',projects,'lockedGrantIds',eligible,
    'witness',witness,'rows',prior_rows,'dictionary',head.dictionary,'retentionHours',policy."retentionHours",
    'policyRevision',policy.revision);
END $$;

-- Resolve each field through the exact retained identity while the source and
-- head are still locked. Return only the fields used by the current overlay.
CREATE FUNCTION public.materialize_ingestion_xlsx_fields(
  customer uuid, source uuid, mapping_revision integer, sheet text, snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  ids uuid[];
  actual integer;
  bytes bigint;
  live boolean;
  resolved integer;
  expected integer;
  value_rows jsonb;
BEGIN
  SELECT coalesce(array_agg(DISTINCT (ref->>1)::uuid ORDER BY (ref->>1)::uuid),'{}'),count(*)::integer
    INTO ids,expected FROM jsonb_array_elements(snapshot->'rows') i(row)
      CROSS JOIN LATERAL jsonb_array_elements(i.row->3) f(ref);
  IF expected>32000 THEN RETURN NULL; END IF;
  PERFORM c."projectionId" FROM public."IngestionProposalContent" c WHERE c."customerId"=customer
    AND c."sourceId"=source AND c."projectionId"=ANY(ids) ORDER BY c."projectionId" FOR SHARE OF c NOWAIT;
  SELECT count(*)::integer,coalesce(sum(octet_length(c.proposals::text)),0),
    coalesce(bool_and(c.proposals IS NOT NULL AND c."redactedAt" IS NULL
      AND v."receivedAt"+make_interval(hours=>(snapshot->>'retentionHours')::integer)>clock_timestamp()),true)
    INTO actual,bytes,live FROM public."IngestionProposalContent" c
    JOIN public."IngestionProposalProjection" p ON p.id=c."projectionId" AND p."customerId"=c."customerId"
      AND p."sourceId"=c."sourceId" AND p."recordId"=c."recordId" AND p."mappingRevision"=mapping_revision
    JOIN public."IngestionSourceRevision" v ON v.id=p."sourceRevisionId" AND v."customerId"=p."customerId"
      AND v."sourceId"=p."sourceId" AND v."recordId"=p."recordId"
    WHERE c."customerId"=customer AND c."sourceId"=source AND c."projectionId"=ANY(ids);
  IF actual<>cardinality(ids) OR bytes>4194304 OR NOT live OR EXISTS (
    SELECT 1 FROM public."IngestionProposalContent" c WHERE c."customerId"=customer AND c."sourceId"=source
      AND c."projectionId"=ANY(ids) AND public.valid_ingestion_projection_content(c."projectionId",c.proposals) IS NOT TRUE
  ) THEN RETURN NULL; END IF;

  WITH identities AS MATERIALIZED (
    SELECT (i.row->>0) COLLATE "C" AS key_hash,(i.row->>1)::uuid AS record_id,(i.row->>2)::uuid AS project_id,i.row->3 AS refs
      FROM jsonb_array_elements(snapshot->'rows') i(row)
  ), refs AS (
    SELECT i.*,(f.ref->>0)::integer AS idx,(f.ref->>1)::uuid AS projection_id
      FROM identities i CROSS JOIN LATERAL jsonb_array_elements(i.refs) f(ref)
  ), fields AS (
    SELECT r.key_hash,r.idx,proposal.item FROM refs r
    JOIN public."IngestionExternalRecord" e ON e."customerId"=customer AND e."sourceId"=source
      AND e.id=r.record_id AND e."projectId"=r.project_id AND e."recordKey" COLLATE "C"=r.key_hash
      AND e."recordType" COLLATE "C"=('xlsx:'||sheet) COLLATE "C"
    JOIN public."IngestionProposalContent" c ON c."customerId"=e."customerId" AND c."sourceId"=e."sourceId"
      AND c."recordId"=e.id AND c."projectionId"=r.projection_id
    JOIN public."IngestionProposalProjection" p ON p.id=c."projectionId" AND p."customerId"=c."customerId"
      AND p."sourceId"=c."sourceId" AND p."recordId"=c."recordId" AND p."mappingRevision"=mapping_revision
    JOIN public."IngestionSourceRevision" v ON v.id=p."sourceRevisionId" AND v."customerId"=p."customerId"
      AND v."sourceId"=p."sourceId" AND v."recordId"=p."recordId"
    CROSS JOIN LATERAL jsonb_array_elements(c.proposals) proposal(item)
    WHERE c."redactedAt" IS NULL
      AND v."receivedAt"+make_interval(hours=>(snapshot->>'retentionHours')::integer)>clock_timestamp()
      AND proposal.item->>'factType'=snapshot->'dictionary'->r.idx->>0
      AND proposal.item->'value'->>'type'=snapshot->'dictionary'->r.idx->>1
      AND CASE proposal.item->'value'->>'type'
        WHEN 'number' THEN abs((proposal.item->'value'->>'value')::numeric)<=9007199254740991
        WHEN 'text' THEN proposal.item->'value'->>'value'<>'' AND left(ltrim(proposal.item->'value'->>'value',
          U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),1)
          NOT IN ('=','+','-','@')
        ELSE true END
  ), grouped AS (
    SELECT key_hash,jsonb_agg(item ORDER BY idx) AS field_values FROM fields GROUP BY key_hash
  )
  SELECT (SELECT count(*)::integer FROM fields), coalesce(jsonb_agg(jsonb_build_object(
    'keyHash',i.key_hash,'projectId',i.project_id,'fields',coalesce(g.field_values,'[]'::jsonb)) ORDER BY i.key_hash),'[]'::jsonb)
    INTO resolved,value_rows FROM identities i LEFT JOIN grouped g ON g.key_hash=i.key_hash;
  IF resolved<>expected OR octet_length(value_rows::text)>4194304 THEN RETURN NULL; END IF;
  RETURN value_rows;
END $$;

CREATE FUNCTION public.read_ingestion_xlsx_preview(
  customer uuid, source uuid, actor_subject text, actor_roles text[], command_key text,
  config_revision integer, mapping_revision integer, sheet text, parser_contract text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE snapshot jsonb; materialized jsonb;
BEGIN
  snapshot := public.lock_ingestion_xlsx_preview(customer,source,actor_subject,actor_roles,command_key,
    config_revision,mapping_revision,sheet,parser_contract);
  IF snapshot->>'status'<>'READY' THEN RETURN snapshot; END IF;
  materialized := public.materialize_ingestion_xlsx_fields(customer,source,mapping_revision,sheet,snapshot);
  IF materialized IS NULL THEN RETURN '{"status":"INVALID_PREVIEW"}'; END IF;
  RETURN jsonb_build_object('status','READY','mapping',snapshot->'mapping','projectIds',snapshot->'projectIds',
    'witness',snapshot->'witness','baseline',jsonb_build_object('customerId',customer,'sourceId',source,
      'sheet',sheet,'mappingRevision',mapping_revision::text,'rows',materialized));
EXCEPTION WHEN lock_not_available THEN RETURN '{"status":"RETRY"}';
END $$;

CREATE FUNCTION public.finalize_ingestion_xlsx_preview(
  customer uuid, source uuid, actor_subject text, actor_roles text[], command_key text,
  config_revision integer, mapping_revision integer, sheet text, parser_contract text,
  workbook_bytes integer, workbook_digest text, correlation text, witness jsonb, outcome_input jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  invalid CONSTANT jsonb := '{"status":"INVALID_REQUEST"}';
  snapshot jsonb;
  request_doc jsonb;
  request_sha text;
  projects uuid[];
  eligible uuid[];
  target uuid := gen_random_uuid();
  audit_id uuid := gen_random_uuid();
  observed_at timestamp(3) := clock_timestamp();
  item jsonb;
  keys CONSTANT text[] := ARRAY['state','operation','errorCodes','projectId','keySha256','sourceContentSha256','proposals'];
  outcome_count integer;
  ordinal integer := 0;
  project_id uuid;
  key_sha text;
  source_sha text;
  row_state text;
  row_operation text;
  errors text[];
  proposals jsonb;
  facts text[];
  record_id uuid;
  revision_id uuid;
  projection_id uuid;
  proposal_sha text;
  proofs jsonb;
  prior_revision integer;
  parent_receipt uuid;
  prior_sha text;
  parent_doc jsonb;
  next_rows jsonb;
  encoded text;
  context_sha text;
BEGIN
  snapshot := public.lock_ingestion_xlsx_preview(customer,source,actor_subject,actor_roles,command_key,
    config_revision,mapping_revision,sheet,parser_contract);
  IF snapshot->>'status'<>'READY' THEN RETURN snapshot; END IF;
  IF witness IS DISTINCT FROM snapshot->'witness' THEN RETURN '{"status":"CONFLICT"}'; END IF;
  IF (correlation COLLATE "C" ~ '^[A-Za-z0-9_.:-]{1,128}$') IS NOT TRUE
    OR jsonb_typeof(outcome_input) IS DISTINCT FROM 'array' OR octet_length(outcome_input::text)>4194304
  THEN RETURN invalid; END IF;
  outcome_count := jsonb_array_length(outcome_input);
  IF outcome_count>1000 THEN RETURN invalid; END IF;
  request_doc := jsonb_build_object('customerId',customer,'sourceId',source,'subject',actor_subject,'commandKey',command_key,
    'configRevision',config_revision,'mappingRevision',mapping_revision,'sheet',sheet,'parserContract',parser_contract,
    'workbookBytes',workbook_bytes,'workbookSha256',workbook_digest);
  request_sha := public.ingestion_xlsx_v1_request_hash(request_doc);
  IF request_sha IS NULL THEN RETURN invalid; END IF;
  IF public.materialize_ingestion_xlsx_fields(customer,source,mapping_revision,sheet,snapshot) IS NULL
  THEN RETURN '{"status":"INVALID_PREVIEW"}'; END IF;

  SELECT ARRAY(SELECT v::uuid FROM jsonb_array_elements_text(snapshot->'projectIds') p(v)),
    ARRAY(SELECT v::uuid FROM jsonb_array_elements_text(snapshot->'lockedGrantIds') g(v)) INTO projects,eligible;
  prior_revision := (snapshot->'witness'->>'revision')::integer;
  parent_receipt := (snapshot->'witness'->>'receiptId')::uuid;
  prior_sha := snapshot->'witness'->>'stateSha256';
  parent_doc := CASE WHEN prior_revision=0 THEN '{"kind":"GENESIS"}'::jsonb
    ELSE jsonb_build_object('kind','RETAINED','receiptId',parent_receipt,'revision',prior_revision,'stateSha256',prior_sha) END;

  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
    VALUES (audit_id,customer,actor_subject,'ingestion.xlsx_preview.persisted',correlation,observed_at,
      jsonb_build_object('receiptId',target,'kind','XLSX_PREVIEW','sourceId',source,'configRevision',config_revision,
        'mappingRevision',mapping_revision,'scopeProjectIds',snapshot->'projectIds','requestHash',request_sha,'outcomeCount',outcome_count));
  INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash",
    "configRevision","mappingRevision","outcomeCount","auditEventId","createdAt")
    VALUES (target,customer,source,actor_subject,'XLSX_PREVIEW',command_key,request_sha,
      config_revision,mapping_revision,outcome_count,audit_id,observed_at);
  INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId",
    "grantId","grantRole","grantScopeType","grantScopeId")
    SELECT customer,source,target,p.id,captured.id,captured.role,captured."scopeType",captured."scopeId"
    FROM public."Project" p CROSS JOIN LATERAL (
      SELECT g.id,g.role,g."scopeType",g."scopeId" FROM public."AccessGrant" g
      WHERE g.id=ANY(eligible) AND g.role=ANY(actor_roles) AND ((g."scopeType"='project' AND g."scopeId"=p.id)
        OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")) ORDER BY g.id LIMIT 1
    ) captured WHERE p."customerId"=customer AND p.id=ANY(projects) ORDER BY p.id;

  FOR item IN SELECT value FROM jsonb_array_elements(outcome_input) LOOP
    ordinal := ordinal+1;
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT (item ?& keys) OR item-keys<>'{}'::jsonb
      OR jsonb_typeof(item->'errorCodes') IS DISTINCT FROM 'array'
      OR (item->'projectId'<>'null'::jsonb AND public.ingestion_xlsx_v1_uuid(item->'projectId') IS NOT TRUE)
      OR (item->'keySha256'<>'null'::jsonb AND public.ingestion_xlsx_v1_digest(item->'keySha256') IS NOT TRUE)
    THEN RAISE SQLSTATE 'P4X01'; END IF;
    project_id := (item->>'projectId')::uuid;
    key_sha := item->>'keySha256';
    row_state := item->>'state';
    row_operation := item->>'operation';
    SELECT ARRAY(SELECT value FROM jsonb_array_elements_text(item->'errorCodes')) INTO errors;
    IF (project_id IS NOT NULL AND NOT (project_id=ANY(projects))) OR cardinality(errors)>16
      OR NOT (errors <@ ARRAY['INVALID_INPUT','INVALID_KEY','DUPLICATE_KEY','INVALID_PROJECT','PROJECT_CHANGED',
        'INVALID_FIELDS','ROW_IDENTITY_REVIEW','REQUIRED_VALUE','INVALID_FORMULA','INVALID_NUMBER','INVALID_VALUE']::text[])
    THEN RAISE SQLSTATE 'P4X01'; END IF;
    record_id := NULL; revision_id := NULL; projection_id := NULL;
    IF row_state='ACCEPTED' THEN
      IF project_id IS NULL OR key_sha IS NULL OR cardinality(errors)<>0
        OR (row_operation IN ('CREATE','UPDATE','UNCHANGED','NONE')) IS NOT TRUE
        OR public.ingestion_xlsx_v1_digest(item->'sourceContentSha256') IS NOT TRUE
        OR public.valid_ingestion_proposals(item->'proposals') IS NOT TRUE
      THEN RAISE SQLSTATE 'P4X01'; END IF;
      source_sha := item->>'sourceContentSha256';
      SELECT coalesce(jsonb_agg(p.value ORDER BY p.value->>'factType' COLLATE "C"),'[]'::jsonb),
        coalesce(array_agg(p.value->>'factType' ORDER BY p.value->>'factType' COLLATE "C"),'{}')
        INTO proposals,facts FROM jsonb_array_elements(item->'proposals') p(value);
      proposal_sha := encode(sha256(convert_to(proposals::text,'UTF8')),'hex');

      INSERT INTO public."IngestionExternalRecord" (id,"customerId","sourceId","projectId","recordType","recordKey")
        VALUES (gen_random_uuid(),customer,source,project_id,'xlsx:'||sheet,key_sha)
        ON CONFLICT ON CONSTRAINT "IngestionExternalRecord_identity_key" DO NOTHING;
      SELECT e.id INTO record_id FROM public."IngestionExternalRecord" e WHERE e."customerId"=customer AND e."sourceId"=source
        AND e."projectId"=project_id AND e."recordType"='xlsx:'||sheet AND e."recordKey"=key_sha;
      IF NOT FOUND THEN RAISE SQLSTATE 'P4X02'; END IF;
      INSERT INTO public."IngestionFactStream" (id,"customerId","sourceId","recordId","factType")
        SELECT gen_random_uuid(),customer,source,record_id,fact FROM unnest(facts) f(fact)
        ON CONFLICT ON CONSTRAINT "IngestionFactStream_identity_key" DO NOTHING;
      INSERT INTO public."IngestionSourceRevision" (id,"customerId","sourceId","recordId",revision,"sourceContentHash","receivedAt")
        VALUES (gen_random_uuid(),customer,source,record_id,'sha256:'||source_sha,source_sha,observed_at)
        ON CONFLICT ON CONSTRAINT "IngestionSourceRevision_identity_key" DO NOTHING;
      SELECT v.id INTO revision_id FROM public."IngestionSourceRevision" v WHERE v."customerId"=customer AND v."sourceId"=source
        AND v."recordId"=record_id AND v.revision='sha256:'||source_sha AND v."sourceContentHash"=source_sha;
      IF NOT FOUND THEN RAISE SQLSTATE 'P4X02'; END IF;
      INSERT INTO public."IngestionProposalProjection" (id,"customerId","sourceId","recordId","sourceRevisionId","mappingRevision",
        "proposalHash","factTypes") VALUES (gen_random_uuid(),customer,source,record_id,revision_id,mapping_revision,proposal_sha,facts)
        ON CONFLICT ON CONSTRAINT "IngestionProposalProjection_identity_key" DO NOTHING RETURNING id INTO projection_id;
      IF FOUND THEN
        INSERT INTO public."IngestionProposalContent" ("customerId","sourceId","recordId","projectionId",proposals,"policyRevision")
          VALUES (customer,source,record_id,projection_id,proposals,(snapshot->>'policyRevision')::integer);
      ELSE
        SELECT p.id INTO projection_id FROM public."IngestionProposalProjection" p WHERE p."customerId"=customer AND p."sourceId"=source
          AND p."recordId"=record_id AND p."sourceRevisionId"=revision_id AND p."mappingRevision"=mapping_revision
          AND p."proposalHash"=proposal_sha AND p."factTypes"=facts;
        IF NOT FOUND THEN RAISE SQLSTATE 'P4X02'; END IF;
      END IF;
    ELSIF (row_state IN ('INVALID','REVIEW_REQUIRED') AND row_operation='NONE' AND cardinality(errors)>0
      AND item->'sourceContentSha256'='null'::jsonb AND item->'proposals'='null'::jsonb) IS NOT TRUE
    THEN RAISE SQLSTATE 'P4X01'; END IF;
    INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes",
      "projectId","recordKey","recordId","sourceRevisionId","projectionId")
      VALUES (customer,source,target,ordinal,row_state,row_operation,errors,project_id,key_sha,record_id,revision_id,projection_id);
  END LOOP;

  -- Hash the persisted outcomes in ordinal order without rebuilding a whole
  -- JSON array for each row. Use the same proof shape as historical validation.
  SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',o.ordinal,'state',o.state,'operation',o.operation,
      'errorCodes',o."errorCodes",'projectId',o."projectId",'keySha256',o."recordKey",
      'record',CASE WHEN o.state='ACCEPTED' THEN jsonb_build_object('id',o."recordId",'revisionId',v.id,
        'sourceContentSha256',v."sourceContentHash"::text,'projectionId',p.id,'proposalSha256',p."proposalHash"::text) END)
      ORDER BY o.ordinal),'[]'::jsonb) INTO proofs
  FROM public."IngestionRowOutcome" o
  LEFT JOIN public."IngestionSourceRevision" v ON v.id=o."sourceRevisionId" AND v."customerId"=o."customerId"
    AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId"
  LEFT JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId" AND p."customerId"=o."customerId"
    AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=v.id
  WHERE o."receiptId"=target AND o."customerId"=customer AND o."sourceId"=source;

  next_rows := public.ingestion_xlsx_overlay(target,snapshot->'dictionary',snapshot->'rows');
  encoded := public.ingestion_xlsx_v1_state_text(customer,source,mapping_revision,to_jsonb(sheet),to_jsonb(parser_contract),
    snapshot->'dictionary',next_rows);
  context_sha := public.ingestion_xlsx_v1_context_hash(jsonb_build_object('request',request_doc,'previewReceiptId',target,
    'baseline',parent_doc,'projectIds',snapshot->'projectIds','outcomes',proofs));
  IF encoded IS NULL OR context_sha IS NULL THEN RAISE SQLSTATE 'P4X03'; END IF;
  INSERT INTO public."IngestionXlsxContext" ("customerId","sourceId","receiptId",revision,"predecessorReceiptId",
    "predecessorRevision","predecessorSha256","workbookBytes","workbookSha256","contextSha256",rows,"canonicalBytes","stateSha256")
    VALUES (customer,source,target,prior_revision+1,parent_receipt,prior_revision,prior_sha,workbook_bytes,workbook_digest,
      context_sha,next_rows,octet_length(encoded),encode(sha256(convert_to(encoded,'UTF8')),'hex'));
  RETURN jsonb_build_object('status','STORED','receiptId',target,'rowCount',outcome_count);
EXCEPTION
  WHEN lock_not_available THEN RETURN '{"status":"RETRY"}';
  WHEN SQLSTATE 'P4X01' THEN RETURN invalid;
  WHEN SQLSTATE 'P4X02' THEN RETURN '{"status":"INTEGRITY_CONFLICT"}';
  WHEN SQLSTATE 'P4X03' OR raise_exception OR check_violation OR foreign_key_violation OR unique_violation
    THEN RETURN '{"status":"INVALID_PREVIEW"}';
END $$;

-- Build the lookup only after canonical validation has established unique
-- row keys. All receipt and live-content checks still run on the full state.
CREATE OR REPLACE FUNCTION public.valid_ingestion_xlsx_context(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $$
DECLARE
    c public."IngestionXlsxContext"%ROWTYPE;
    h public."IngestionXlsxHead"%ROWTYPE;
    r public."IngestionOperationReceipt"%ROWTYPE;
    parent public."IngestionXlsxContext"%ROWTYPE;
    mapping_value jsonb;
    prior_config integer;
    prior_rows jsonb := '[]'::jsonb;
    prior_by_key jsonb;
    baseline jsonb := '{"kind":"GENESIS"}'::jsonb;
    request_doc jsonb;
    projects jsonb;
    outcomes jsonb;
    encoded text;
BEGIN
    SELECT * INTO c FROM public."IngestionXlsxContext" WHERE "receiptId"=target;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO h FROM public."IngestionXlsxHead" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId";
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND id=target;
    IF NOT FOUND OR r.kind<>'XLSX_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
        OR r."mappingRevision"<>h."mappingRevision" OR public.valid_ingestion_receipt(target) IS NOT TRUE
    THEN RETURN false; END IF;
    SELECT activation.mapping INTO mapping_value FROM public."IngestionConfigurationRevision" activation
    JOIN public."IngestionConfigurationRevision" receipt_config ON receipt_config."customerId"=activation."customerId"
      AND receipt_config."sourceId"=activation."sourceId" AND receipt_config.revision=r."configRevision"
      AND receipt_config."mappingRevision"=activation."mappingRevision" AND receipt_config.sealed
      AND receipt_config.mapping=activation.mapping
    WHERE activation."customerId"=c."customerId" AND activation."sourceId"=c."sourceId"
      AND activation.revision=h."activationConfigRevision" AND activation."mappingRevision"=h."mappingRevision" AND activation.sealed;
    IF NOT FOUND OR mapping_value->>'kind' IS DISTINCT FROM 'XLSX' THEN RETURN false; END IF;
    prior_config := h."activationConfigRevision";
    IF c.revision=1 THEN
        IF c."predecessorSha256" IS DISTINCT FROM h."genesisSha256" THEN RETURN false; END IF;
    ELSE
        SELECT * INTO parent FROM public."IngestionXlsxContext" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId"
          AND revision=c."predecessorRevision" AND "receiptId"=c."predecessorReceiptId" AND "stateSha256"=c."predecessorSha256";
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT "configRevision" INTO prior_config FROM public."IngestionOperationReceipt"
          WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND id=parent."receiptId" AND kind='XLSX_PREVIEW';
        IF NOT FOUND THEN RETURN false; END IF;
        prior_rows := parent.rows;
        baseline := jsonb_build_object('kind','RETAINED','receiptId',parent."receiptId",'revision',parent.revision,'stateSha256',parent."stateSha256"::text);
    END IF;
    encoded := public.ingestion_xlsx_v1_state_text(c."customerId",c."sourceId",h."mappingRevision",
        mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,c.rows);
    IF encoded IS NULL OR octet_length(encoded)<>c."canonicalBytes"
        OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>c."stateSha256"::text THEN RETURN false; END IF;
    IF c.revision>1 THEN
        IF prior_rows IS DISTINCT FROM c.rows THEN
            encoded := public.ingestion_xlsx_v1_state_text(c."customerId",c."sourceId",h."mappingRevision",
                mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,prior_rows);
        END IF;
        IF encoded IS NULL OR octet_length(encoded)<>parent."canonicalBytes"
            OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>parent."stateSha256"::text THEN RETURN false; END IF;
    END IF;
    SELECT coalesce(jsonb_object_agg(entry->>0,entry),'{}'::jsonb) INTO prior_by_key
      FROM jsonb_array_elements(prior_rows) AS prior(entry);
    IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" old_scope
      WHERE old_scope."customerId"=c."customerId" AND old_scope."sourceId"=c."sourceId" AND old_scope."configRevision"=prior_config
        AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" captured WHERE captured."receiptId"=target
          AND captured."customerId"=old_scope."customerId" AND captured."sourceId"=old_scope."sourceId"
          AND captured."projectId"=old_scope."projectId")) THEN RETURN false; END IF;
    -- The immutable reader and exact project grant scope survive revocation.
    -- Restore must not consult today's AccessGrant or project portfolio.
    IF EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" captured WHERE captured."receiptId"=target
      AND (ROW(captured."customerId",captured."sourceId") IS DISTINCT FROM ROW(c."customerId",c."sourceId")
        OR (captured."grantScopeType"='project' AND captured."grantScopeId"<>captured."projectId")
        OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
          WHERE reader."customerId"=c."customerId" AND reader."sourceId"=c."sourceId" AND reader."configRevision"=r."configRevision"
            AND reader."projectId"=captured."projectId" AND reader.subject=r.subject))) THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.rows) AS identities(identity)
      WHERE NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e
        JOIN public."IngestionReceiptProjectScope" scope ON scope."receiptId"=target AND scope."customerId"=e."customerId"
          AND scope."sourceId"=e."sourceId" AND scope."projectId"=e."projectId"
        WHERE e."customerId"=c."customerId" AND e."sourceId"=c."sourceId" AND e.id=(identity->>1)::uuid
          AND e."projectId"=(identity->>2)::uuid AND e."recordKey" COLLATE "C"=(identity->>0) COLLATE "C"
          AND e."recordType" COLLATE "C"=('xlsx:'||(mapping_value->>'sheet')) COLLATE "C")) THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1 FROM public."IngestionRowOutcome" o LEFT JOIN public."IngestionProposalProjection" p
        ON p.id=o."projectionId" AND p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
          AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision"
      LEFT JOIN public."IngestionExternalRecord" e ON e.id=o."recordId" AND e."customerId"=c."customerId" AND e."sourceId"=c."sourceId"
      LEFT JOIN LATERAL (SELECT prior_by_key->o."recordKey" AS entry) prior ON true
      WHERE o."receiptId"=target AND o.state='ACCEPTED' AND (
        p.id IS NULL OR (e."recordType" COLLATE "C"=('xlsx:'||(mapping_value->>'sheet')) COLLATE "C") IS NOT TRUE
        OR EXISTS (SELECT 1 FROM unnest(p."factTypes") AS fact(value) WHERE NOT EXISTS
          (SELECT 1 FROM jsonb_array_elements(h.dictionary) AS field(entry) WHERE entry->>0=fact.value))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(mapping_value->'fields') AS field(entry)
          WHERE entry->>'required'='true' AND NOT ((entry->>'factType')=ANY(p."factTypes")))
        OR (prior.entry IS NOT NULL AND ROW((prior.entry->>1)::uuid,(prior.entry->>2)::uuid)
          IS DISTINCT FROM ROW(o."recordId",o."projectId"))
        OR CASE WHEN prior.entry IS NOT NULL
          THEN CASE WHEN cardinality(p."factTypes")=0 THEN o.operation<>'UNCHANGED' ELSE o.operation NOT IN ('UPDATE','UNCHANGED') END
          ELSE CASE WHEN cardinality(p."factTypes")=0 THEN o.operation<>'NONE' ELSE o.operation<>'CREATE' END END
      )
    ) THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=target AND "recordKey" IS NOT NULL
      GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RETURN false; END IF;
    IF c.rows IS DISTINCT FROM public.ingestion_xlsx_overlay(target,h.dictionary,prior_rows) THEN RETURN false; END IF;

    request_doc := jsonb_build_object('customerId',r."customerId",'sourceId',r."sourceId",'subject',r.subject,
        'commandKey',r."commandKey",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",
        'sheet',mapping_value->'sheet','parserContract',mapping_value->'parserContract',
        'workbookBytes',c."workbookBytes",'workbookSha256',c."workbookSha256"::text);
    IF public.ingestion_xlsx_v1_request_hash(request_doc) IS DISTINCT FROM r."requestHash"::text THEN RETURN false; END IF;
    SELECT coalesce(jsonb_agg("projectId" ORDER BY "projectId"),'[]'::jsonb) INTO projects
      FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=target AND "customerId"=c."customerId" AND "sourceId"=c."sourceId";
    SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',o.ordinal,'state',o.state,'operation',o.operation,
        'errorCodes',o."errorCodes",'projectId',o."projectId",'keySha256',o."recordKey",
        'record',CASE WHEN o.state='ACCEPTED' THEN jsonb_build_object('id',o."recordId",'revisionId',v.id,
          'sourceContentSha256',v."sourceContentHash"::text,'projectionId',p.id,'proposalSha256',p."proposalHash"::text) END)
        ORDER BY o.ordinal),'[]'::jsonb) INTO outcomes
    FROM public."IngestionRowOutcome" o
    LEFT JOIN public."IngestionSourceRevision" v ON v.id=o."sourceRevisionId" AND v."customerId"=o."customerId"
      AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId"
    LEFT JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId" AND p."customerId"=o."customerId"
      AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=v.id
    WHERE o."receiptId"=target AND o."customerId"=c."customerId" AND o."sourceId"=c."sourceId";
    RETURN public.ingestion_xlsx_v1_context_hash(jsonb_build_object('request',request_doc,'previewReceiptId',target,
      'baseline',baseline,'projectIds',projects,'outcomes',outcomes)) IS NOT DISTINCT FROM c."contextSha256"::text;
END $$;

CREATE OR REPLACE FUNCTION public.append_ingestion_xlsx_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
    h public."IngestionXlsxHead"%ROWTYPE;
    s public."IngestionSource"%ROWTYPE;
    r public."IngestionOperationReceipt"%ROWTYPE;
    policy_hours integer;
    prior_rows jsonb := '[]'::jsonb;
    prior_by_key jsonb;
    projection_ids uuid[];
    actual_count integer;
    content_bytes bigint;
    available boolean;
    uncertain_identity boolean;
    prior_identity jsonb;
    observed record;
    expected_operation text;
BEGIN
    SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId"
        AND "sourceId"=NEW."sourceId" AND kind='XLSX_PREVIEW';
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook context requires a native receipt'; END IF;
    -- The existing receipt scope guard acquires the project, reader and grant
    -- fences. A missing predecessor scope fails the historical proof below.
    SELECT "retentionHours" INTO policy_hours FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR s."inputFamily"<>'XLSX' OR ROW(s."currentConfigRevision",s."mappingRevision")
        IS DISTINCT FROM ROW(r."configRevision",r."mappingRevision") THEN RAISE EXCEPTION 'Workbook source configuration changed'; END IF;
    SELECT * INTO h FROM public."IngestionXlsxHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR NEW."predecessorRevision"<>h.revision OR NEW."predecessorReceiptId" IS DISTINCT FROM h."currentReceiptId"
        OR NEW."predecessorSha256" IS DISTINCT FROM coalesce(h."stateSha256",h."genesisSha256")
        OR h."canonicalHistoryBytes"+NEW."canonicalBytes">268435456
    THEN RAISE EXCEPTION 'Workbook comparison predecessor or capacity changed'; END IF;
    IF public.valid_ingestion_xlsx_context(NEW."receiptId") IS NOT TRUE THEN RAISE EXCEPTION 'Invalid workbook preview context'; END IF;
    IF h.revision>0 THEN
        SELECT rows INTO prior_rows FROM public."IngestionXlsxContext" WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId"
            AND "receiptId"=h."currentReceiptId" AND revision=h.revision AND "stateSha256"=h."stateSha256";
        IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison predecessor is unavailable'; END IF;
    END IF;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO projection_ids FROM (
        SELECT (ref->>1)::uuid AS id FROM jsonb_array_elements(prior_rows) AS identities(entry)
          CROSS JOIN LATERAL jsonb_array_elements(entry->3) AS refs(ref)
        UNION SELECT "projectionId" FROM public."IngestionRowOutcome" WHERE "receiptId"=NEW."receiptId" AND state='ACCEPTED'
    ) required;
    IF cardinality(projection_ids)>33000 THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    PERFORM content."projectionId" FROM public."IngestionProposalContent" content
      WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids)
      ORDER BY content."projectionId" FOR SHARE;
    SELECT count(*)::integer,coalesce(sum(octet_length(content.proposals::text)),0),
      coalesce(bool_and(content.proposals IS NOT NULL AND content."redactedAt" IS NULL
        AND revision."receivedAt"+make_interval(hours=>policy_hours)>clock_timestamp()),true)
      INTO actual_count,content_bytes,available
    FROM public."IngestionProposalContent" content
    JOIN public."IngestionProposalProjection" p ON p.id=content."projectionId" AND p."customerId"=content."customerId"
      AND p."sourceId"=content."sourceId" AND p."recordId"=content."recordId" AND p."mappingRevision"=r."mappingRevision"
    JOIN public."IngestionSourceRevision" revision ON revision.id=p."sourceRevisionId" AND revision."customerId"=p."customerId"
      AND revision."sourceId"=p."sourceId" AND revision."recordId"=p."recordId"
    WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids);
    IF actual_count<>cardinality(projection_ids) OR available IS NOT TRUE OR content_bytes>4194304
    THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionProposalContent" content WHERE content."projectionId"=ANY(projection_ids)
      AND (public.valid_ingestion_projection_content(content."projectionId",content.proposals) IS NOT TRUE
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(content.proposals) AS proposals(item) WHERE NOT EXISTS
          (SELECT 1 FROM jsonb_array_elements(h.dictionary) AS fields(entry)
            WHERE entry->>0=item->>'factType' AND entry->>1=item->'value'->>'type')
          OR CASE item->'value'->>'type'
            WHEN 'number' THEN abs((item->'value'->>'value')::numeric)>9007199254740991
            WHEN 'text' THEN (item->'value'->>'value'='' OR left(ltrim(item->'value'->>'value',
              U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),1) IN ('=','+','-','@'))
            ELSE false END)))
    THEN RAISE EXCEPTION 'Workbook comparison projection is invalid'; END IF;
    SELECT EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=NEW."receiptId"
        AND (o."recordKey" IS NULL OR o."errorCodes" && ARRAY['INVALID_KEY','DUPLICATE_KEY','INVALID_PROJECT','PROJECT_CHANGED','ROW_IDENTITY_REVIEW']::text[]))
      OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=NEW."receiptId" AND "recordKey" IS NOT NULL
        GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) AS identities(entry) WHERE NOT EXISTS
        (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=NEW."receiptId" AND o."recordKey" COLLATE "C"=(entry->>0) COLLATE "C"))
      INTO uncertain_identity;
    SELECT coalesce(jsonb_object_agg(entry->>0,entry),'{}'::jsonb) INTO prior_by_key
      FROM jsonb_array_elements(prior_rows) AS prior(entry);
    FOR observed IN SELECT o."recordKey",o."recordId",o.operation,content.proposals FROM public."IngestionRowOutcome" o
      JOIN public."IngestionProposalContent" content ON content."projectionId"=o."projectionId"
        AND content."customerId"=o."customerId" AND content."sourceId"=o."sourceId" AND content."recordId"=o."recordId"
      WHERE o."receiptId"=NEW."receiptId" AND o.state='ACCEPTED' ORDER BY o.ordinal
    LOOP
        prior_identity := prior_by_key->observed."recordKey";
        IF prior_identity IS NULL AND uncertain_identity THEN RAISE EXCEPTION 'Workbook comparison identity requires review'; END IF;
        IF jsonb_array_length(observed.proposals)=0 THEN
            expected_operation := CASE WHEN prior_identity IS NULL THEN 'NONE' ELSE 'UNCHANGED' END;
        ELSIF prior_identity IS NULL THEN expected_operation := 'CREATE';
        ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(observed.proposals) AS supplied(item) WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(prior_identity->3) AS field_refs(ref)
          JOIN public."IngestionProposalContent" previous ON previous."projectionId"=(ref->>1)::uuid
            AND previous."customerId"=NEW."customerId" AND previous."sourceId"=NEW."sourceId" AND previous."recordId"=observed."recordId"
          CROSS JOIN LATERAL jsonb_array_elements(previous.proposals) AS prior_values(prior_item)
          WHERE h.dictionary->((ref->>0)::integer)->>0=supplied.item->>'factType'
            AND prior_item->>'factType'=supplied.item->>'factType' AND prior_item->'value'=supplied.item->'value'
        )) THEN expected_operation := 'UPDATE';
        ELSE expected_operation := 'UNCHANGED'; END IF;
        IF observed.operation IS DISTINCT FROM expected_operation THEN RAISE EXCEPTION 'Workbook comparison operation is invalid'; END IF;
    END LOOP;
    UPDATE public."IngestionXlsxHead" SET revision=NEW.revision,"currentReceiptId"=NEW."receiptId",
      "stateSha256"=NEW."stateSha256","canonicalHistoryBytes"=h."canonicalHistoryBytes"+NEW."canonicalBytes"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND revision=h.revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison predecessor changed'; END IF;
    RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.require_ingestion_receipt_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  target uuid;
  receipt public."IngestionOperationReceipt"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='IngestionOperationReceipt' THEN
    target:=NEW.id;
  ELSE
    target:=NEW."receiptId";
    SELECT * INTO receipt FROM public."IngestionOperationReceipt" WHERE id=target;
    IF FOUND AND TG_TABLE_NAME='IngestionRowOutcome' AND receipt.kind IN ('CSV_PREVIEW','XLSX_PREVIEW')
      AND receipt."executionMode"='HUMAN' AND receipt."syncJobId" IS NULL THEN
      IF ROW(receipt."customerId",receipt."sourceId") IS DISTINCT FROM ROW(NEW."customerId",NEW."sourceId")
        OR (NEW.ordinal BETWEEN 1 AND receipt."outcomeCount") IS NOT TRUE
        OR (NEW."projectId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public."IngestionReceiptProjectScope" s
          WHERE s."receiptId"=target AND s."customerId"=NEW."customerId"
            AND s."sourceId"=NEW."sourceId" AND s."projectId"=NEW."projectId"
        )) OR (NEW.state='ACCEPTED' AND (
          NEW."recordKey" IS NULL OR NEW."projectId" IS NULL OR NOT EXISTS (
            SELECT 1 FROM public."IngestionExternalRecord" e
            JOIN public."IngestionSourceRevision" v ON v."customerId"=e."customerId" AND v."sourceId"=e."sourceId"
              AND v."recordId"=e.id AND v.id=NEW."sourceRevisionId"
            JOIN public."IngestionProposalProjection" p ON p."customerId"=v."customerId" AND p."sourceId"=v."sourceId"
              AND p."recordId"=v."recordId" AND p."sourceRevisionId"=v.id AND p.id=NEW."projectionId"
              AND p."mappingRevision"=receipt."mappingRevision"
            JOIN public."IngestionProposalContent" c ON c."customerId"=p."customerId" AND c."sourceId"=p."sourceId"
              AND c."recordId"=p."recordId" AND c."projectionId"=p.id
            WHERE e.id=NEW."recordId" AND e."customerId"=NEW."customerId" AND e."sourceId"=NEW."sourceId"
              AND e."projectId"=NEW."projectId" AND e."recordKey"=NEW."recordKey"
          )
        )) OR (NEW.state<>'ACCEPTED' AND (NEW."projectionId" IS NOT NULL OR cardinality(NEW."errorCodes")=0)) THEN
        RAISE EXCEPTION 'Incomplete ingestion receipt cannot commit';
      END IF;
      RETURN NULL;
    END IF;
  END IF;
  IF public.valid_ingestion_receipt(target) IS NOT TRUE THEN
    RAISE EXCEPTION 'Incomplete ingestion receipt cannot commit';
  END IF;
  RETURN NULL;
END $$;


-- PostgreSQL 17 fires deferred triggers at the outer transaction's role.
-- Only this native receipt check needs the private head and context, so keep
-- the generic receipt trigger invoker and grant runtime no table read.
CREATE FUNCTION public.require_ingestion_xlsx_preview_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_RELID<>'public."IngestionOperationReceipt"'::regclass OR TG_OP<>'INSERT'
    OR NEW.kind<>'XLSX_PREVIEW' OR NOT EXISTS (
      SELECT 1 FROM public."IngestionXlsxContext" c JOIN public."IngestionXlsxHead" h
        ON h."customerId"=c."customerId" AND h."sourceId"=c."sourceId" AND h.revision>=c.revision
      WHERE c."customerId"=NEW."customerId" AND c."sourceId"=NEW."sourceId" AND c."receiptId"=NEW.id
    ) THEN RAISE EXCEPTION 'Incomplete workbook preview cannot commit'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ingestion_xlsx_preview_commit AFTER INSERT ON public."IngestionOperationReceipt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='XLSX_PREVIEW')
  EXECUTE FUNCTION public.require_ingestion_xlsx_preview_complete();

DO $roles$
DECLARE
  signature text;
  repository_role text;
  api boolean;
BEGIN
  FOR signature,api IN SELECT * FROM (VALUES
    ('public.lock_ingestion_xlsx_preview(uuid,uuid,text,text[],text,integer,integer,text,text)',false),
    ('public.materialize_ingestion_xlsx_fields(uuid,uuid,integer,text,jsonb)',false),
    ('public.require_ingestion_xlsx_preview_complete()',false),
    ('public.read_ingestion_xlsx_preview(uuid,uuid,text,text[],text,integer,integer,text,text)',true),
    ('public.finalize_ingestion_xlsx_preview(uuid,uuid,text,text[],text,integer,integer,text,text,integer,text,text,jsonb,jsonb)',true)
  ) AS functions(signature,api)
  LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC';
    FOREACH repository_role IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
      IF to_regrole(repository_role) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,repository_role);
      END IF;
    END LOOP;
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO pdaa_migrate';
      IF api AND to_regrole('pdaa_api') IS NOT NULL THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO pdaa_api';
      END IF;
    END IF;
  END LOOP;
END $roles$;
