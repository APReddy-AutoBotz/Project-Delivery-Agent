-- FR-CON-006/007: disclose only a bounded, authorized review page.
CREATE FUNCTION public.can_read_ingestion_xlsx_preview(
  customer uuid, source uuid, reader text, roles text[], current_config integer,
  original_config integer, projects uuid[], original_projects uuid[], locked_grants uuid[]
) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(projects) scope(project_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public."Project" p JOIN public."AccessGrant" g
        ON g."customerId"=p."customerId" AND g.subject=reader AND g.role=ANY(roles)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id)
          OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
      WHERE p."customerId"=customer AND p.id=scope.project_id
        AND (locked_grants IS NULL OR g.id=ANY(locked_grants))
    ) OR NOT EXISTS (
      SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
        AND r."sourceId"=source AND r."configRevision"=current_config
        AND r."projectId"=scope.project_id AND r.subject=reader
    ) OR (scope.project_id=ANY(original_projects) AND NOT EXISTS (
      SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
        AND r."sourceId"=source AND r."configRevision"=original_config
        AND r."projectId"=scope.project_id AND r.subject=reader
    ))
  )
$$;

CREATE FUNCTION public.read_ingestion_xlsx_preview_receipt(
  customer uuid, source uuid, actor_subject text, actor_roles text[], preview uuid, after_ordinal integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  denied CONSTANT jsonb := '{"status":"DENIED"}';
  invalid CONSTANT jsonb := '{"status":"INTEGRITY_CONFLICT"}';
  byte_limit CONSTANT integer := 8388608;
  planned_config integer;
  live_source public."IngestionSource"%ROWTYPE;
  receipt public."IngestionOperationReceipt"%ROWTYPE;
  context public."IngestionXlsxContext"%ROWTYPE;
  head public."IngestionXlsxHead"%ROWTYPE;
  current_projects uuid[];
  original_projects uuid[];
  scope_projects uuid[];
  grants uuid[];
  locked_count integer;
  policy_hours integer;
  checked_at timestamptz;
  reviewed_receipt uuid;
  selection_state text;
  page_end integer;
  item record;
  proposals jsonb;
  available boolean;
  selectable boolean;
  entry jsonb;
  envelope jsonb;
  result jsonb;
  entries jsonb[] := '{}'::jsonb[];
  page_bytes integer;
  entry_bytes integer;
  last_ordinal integer := after_ordinal;
BEGIN
  IF session_user<>'pdaa_api' OR customer IS NULL OR source IS NULL
    OR public.ingestion_xlsx_v1_text(to_jsonb(actor_subject),256) IS NULL
    OR array_ndims(actor_roles) IS DISTINCT FROM 1 OR cardinality(actor_roles) NOT BETWEEN 1 AND 3
    OR EXISTS (SELECT 1 FROM unnest(actor_roles) a(role)
      WHERE role IS NULL OR role NOT IN ('project_manager','portfolio_manager','pmo_admin'))
  THEN RETURN denied; END IF;
  IF preview IS NULL OR (after_ordinal BETWEEN 0 AND 1000) IS NOT TRUE
  THEN RETURN '{"status":"INVALID_REQUEST"}'; END IF;

  SELECT s."currentConfigRevision" INTO planned_config FROM public."IngestionSource" s
    WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX';
  IF NOT FOUND OR planned_config IS NULL THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT p."projectId" FROM public."IngestionConfigurationProject" p
    WHERE p."customerId"=customer AND p."sourceId"=source AND p."configRevision"=planned_config
    ORDER BY p."projectId" LIMIT 101) INTO current_projects;
  IF cardinality(current_projects) NOT BETWEEN 1 AND 100 OR
    public.can_read_ingestion_xlsx_preview(customer,source,actor_subject,actor_roles,planned_config,
      planned_config,current_projects,'{}'::uuid[],NULL) IS NOT TRUE THEN RETURN denied; END IF;

  SELECT r.* INTO receipt FROM public."IngestionOperationReceipt" r WHERE r."customerId"=customer
    AND r."sourceId"=source AND r.id=preview AND r.kind='XLSX_PREVIEW';
  IF NOT FOUND THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT p."projectId" FROM public."IngestionConfigurationProject" p
    WHERE p."customerId"=customer AND p."sourceId"=source AND p."configRevision"=receipt."configRevision"
    ORDER BY p."projectId" LIMIT 101) INTO original_projects;
  IF cardinality(original_projects) NOT BETWEEN 1 AND 100 THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT DISTINCT id FROM unnest(current_projects || original_projects) p(id) ORDER BY id)
    INTO scope_projects;
  IF public.can_read_ingestion_xlsx_preview(customer,source,actor_subject,actor_roles,planned_config,
    receipt."configRevision",scope_projects,original_projects,NULL) IS NOT TRUE THEN RETURN denied; END IF;

  PERFORM p.id FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
    ORDER BY p.id FOR SHARE OF p;
  GET DIAGNOSTICS locked_count=ROW_COUNT;
  IF locked_count<>cardinality(scope_projects) THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT g.id FROM public."AccessGrant" g
    WHERE g."customerId"=customer AND g.subject=actor_subject AND g.role=ANY(actor_roles)
      AND EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id)
          OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
    ORDER BY g.id FOR SHARE OF g) INTO grants;
  SELECT p."retentionHours" INTO policy_hours FROM public."IngestionRetentionPolicy" p
    WHERE p."customerId"=customer FOR SHARE OF p;
  SELECT s.* INTO live_source FROM public."IngestionSource" s WHERE s."customerId"=customer
    AND s.id=source AND s."inputFamily"='XLSX' FOR SHARE OF s;
  IF NOT FOUND OR live_source."currentConfigRevision" IS DISTINCT FROM planned_config
  THEN RETURN '{"status":"RETRY"}'; END IF;
  IF public.can_read_ingestion_xlsx_preview(customer,source,actor_subject,actor_roles,planned_config,
    receipt."configRevision",scope_projects,original_projects,grants) IS NOT TRUE THEN RETURN denied; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationRevision" c WHERE c."customerId"=customer
    AND c."sourceId"=source AND c.revision=planned_config AND c."mappingRevision"=live_source."mappingRevision"
    AND c.sealed AND c.mapping->>'kind'='XLSX') THEN RETURN invalid; END IF;
  IF policy_hours IS NULL THEN RETURN '{"status":"RETENTION_REQUIRED"}'; END IF;

  SELECT h.* INTO head FROM public."IngestionXlsxHead" h WHERE h."customerId"=customer AND h."sourceId"=source
    FOR SHARE OF h;
  IF NOT FOUND THEN RETURN invalid; END IF;
  SELECT c.* INTO context FROM public."IngestionXlsxContext" c WHERE c."customerId"=customer
    AND c."sourceId"=source AND c."receiptId"=preview AND (c.revision<head.revision OR
      (c.revision=head.revision AND c."receiptId"=head."currentReceiptId" AND c."stateSha256"=head."stateSha256"));
  IF NOT FOUND OR public.verified_ingestion_xlsx_context(preview) IS NULL THEN RETURN invalid; END IF;

  SELECT r."receiptId" INTO reviewed_receipt FROM public."IngestionReviewedImport" r
    WHERE r."customerId"=customer AND r."sourceId"=source AND r."previewReceiptId"=preview;
  IF reviewed_receipt IS NOT NULL AND public.valid_ingestion_xlsx_reviewed_import(reviewed_receipt) IS NOT TRUE
  THEN RETURN invalid; END IF;
  -- A durable review remains the visible state after a configuration advance.
  selection_state := CASE WHEN reviewed_receipt IS NOT NULL THEN 'REVIEWED'
    WHEN ROW(receipt."configRevision",receipt."mappingRevision") IS DISTINCT FROM
      ROW(planned_config,live_source."mappingRevision") THEN 'STALE' ELSE 'OPEN' END;
  page_end := least(after_ordinal+50,receipt."outcomeCount");
  PERFORM c."projectionId" FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalContent" c
    ON c."customerId"=o."customerId" AND c."sourceId"=o."sourceId" AND c."recordId"=o."recordId"
      AND c."projectionId"=o."projectionId"
    WHERE o."customerId"=customer AND o."sourceId"=source AND o."receiptId"=preview
      AND o.ordinal>after_ordinal AND o.ordinal<=page_end
    ORDER BY c."projectionId" FOR SHARE OF c;
  checked_at := clock_timestamp();

  envelope := jsonb_build_object('sourceId',source,'previewReceiptId',preview,
    'createdAt',to_char(receipt."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'configRevision',receipt."configRevision",'mappingRevision',receipt."mappingRevision",
    'rowCount',receipt."outcomeCount",'previewContextSha256',context."contextSha256"::text,
    'selectionState',selection_state);
  -- Reserve room for the result wrapper, array delimiters and continuation.
  page_bytes := octet_length(envelope::text)+128;
  FOR item IN SELECT o.ordinal,o.state,o.operation,o."errorCodes",o."projectId",o."projectionId",
      c.proposals,c."redactedAt",v."receivedAt"
    FROM public."IngestionRowOutcome" o
    LEFT JOIN public."IngestionProposalContent" c ON c."customerId"=o."customerId" AND c."sourceId"=o."sourceId"
      AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId"
    LEFT JOIN public."IngestionSourceRevision" v ON v."customerId"=o."customerId" AND v."sourceId"=o."sourceId"
      AND v."recordId"=o."recordId" AND v.id=o."sourceRevisionId"
    WHERE o."customerId"=customer AND o."sourceId"=source AND o."receiptId"=preview
      AND o.ordinal>after_ordinal AND o.ordinal<=page_end ORDER BY o.ordinal
  LOOP
    available := (item.state='ACCEPTED' AND item.proposals IS NOT NULL AND item."redactedAt" IS NULL
      AND item."receivedAt"+make_interval(hours=>policy_hours)>checked_at) IS TRUE;
    proposals := NULL;
    IF available THEN
      IF public.valid_ingestion_projection_content(item."projectionId",item.proposals) IS NOT TRUE
      THEN RETURN invalid; END IF;
      proposals := item.proposals;
    END IF;
    selectable := selection_state='OPEN' AND available AND item.operation IN ('CREATE','UPDATE','UNCHANGED');
    entry := jsonb_build_object('ordinal',item.ordinal,'state',item.state,'operation',item.operation,
      'errorCodes',item."errorCodes",'projectId',item."projectId",'contentAvailable',available,
      'selectable',selectable,'proposals',proposals);
    entry_bytes := octet_length(entry::text)+2;
    IF item.ordinal=last_ordinal+1 AND page_bytes+entry_bytes<=byte_limit THEN
      entries := array_append(entries,entry);
      page_bytes := page_bytes+entry_bytes;
      last_ordinal := item.ordinal;
    END IF;
  END LOOP;
  -- Legal proposal field limits always allow at least one complete outcome.
  IF last_ordinal=after_ordinal AND after_ordinal<receipt."outcomeCount" THEN RETURN invalid; END IF;
  result := jsonb_build_object('status','READY','view',envelope || jsonb_build_object(
    'outcomes',to_jsonb(entries),'nextOrdinal',CASE WHEN last_ordinal<receipt."outcomeCount" THEN last_ordinal END));
  IF octet_length(result::text)>byte_limit THEN RETURN invalid; END IF;
  RETURN result;
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN '{"status":"RETRY"}';
END $$;

DO $roles$
DECLARE signature text; runtime_role text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.can_read_ingestion_xlsx_preview(uuid,uuid,text,text[],integer,integer,uuid[],uuid[],uuid[])',
    'public.read_ingestion_xlsx_preview_receipt(uuid,uuid,text,text[],uuid,integer)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC';
    FOREACH runtime_role IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
      IF to_regrole(runtime_role) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,runtime_role);
      END IF;
    END LOOP;
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO pdaa_migrate';
    END IF;
  END LOOP;
  IF to_regrole('pdaa_api') IS NOT NULL AND to_regrole('pdaa_migrate') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.read_ingestion_xlsx_preview_receipt(uuid,uuid,text,text[],uuid,integer) TO pdaa_api;
  END IF;
END $roles$;
