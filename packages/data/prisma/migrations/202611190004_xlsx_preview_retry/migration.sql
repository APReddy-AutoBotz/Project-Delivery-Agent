-- FR-CON-006/007: exact native workbook retry for the authenticated API service.
-- The service asserts the actor and its verified role claims. The database
-- independently intersects those claims with current grants and source readers.
CREATE FUNCTION public.probe_ingestion_xlsx_retry(
    customer uuid, source uuid, actor_subject text, actor_roles text[], command_key text,
    config_revision integer, mapping_revision integer, sheet text, workbook_bytes integer, workbook_digest text
) RETURNS TABLE(status text, receipt_id uuid, row_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
    planned_config integer;
    planned_mapping integer;
    locked_source public."IngestionSource"%ROWTYPE;
    planned_receipt uuid;
    retained public."IngestionOperationReceipt"%ROWTYPE;
    original_config integer;
    current_provenance jsonb;
    provenance jsonb;
    current_projects uuid[];
    original_projects uuid[] := '{}'::uuid[];
    scope_projects uuid[];
    locked_projects integer;
    eligible_grants uuid[];
    incoming_hash text;
BEGIN
    status := 'DENIED';
    IF session_user <> 'pdaa_api' OR customer IS NULL OR source IS NULL
        OR public.ingestion_xlsx_v1_text(to_jsonb(actor_subject),256) IS NULL
        OR array_ndims(actor_roles) IS DISTINCT FROM 1 OR cardinality(actor_roles) NOT BETWEEN 1 AND 3
        OR EXISTS (SELECT 1 FROM unnest(actor_roles) AS claim(role)
          WHERE role IS NULL OR role NOT IN ('project_manager','portfolio_manager','pmo_admin'))
        OR (command_key COLLATE "C" ~ '^[A-Za-z0-9_-]{1,128}$') IS NOT TRUE
        OR config_revision IS NULL OR config_revision<1 OR mapping_revision IS NULL OR mapping_revision<1
        OR public.ingestion_xlsx_v1_text(to_jsonb(sheet),31) IS NULL
        OR translate(sheet,E'\\/*?:[]','')<>sheet OR sheet COLLATE "C" ~* '_x[0-9a-f]{4}_'
        OR ((workbook_bytes IS NULL) <> (workbook_digest IS NULL))
        OR (workbook_bytes IS NOT NULL AND (workbook_bytes NOT BETWEEN 1 AND 1048576
          OR public.ingestion_xlsx_v1_digest(to_jsonb(workbook_digest)) IS NOT TRUE))
    THEN RETURN NEXT; RETURN; END IF;

    SELECT s."currentConfigRevision",s."mappingRevision" INTO planned_config,planned_mapping
      FROM public."IngestionSource" s WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX';
    IF NOT FOUND OR planned_config IS NULL THEN RETURN NEXT; RETURN; END IF;
    SELECT r.id,r."configRevision" INTO planned_receipt,original_config FROM public."IngestionOperationReceipt" r
      WHERE r."customerId"=customer AND r."sourceId"=source AND r.subject=actor_subject
        AND r.kind='XLSX_PREVIEW' AND r."commandKey"=command_key;
    SELECT ARRAY(SELECT scope."projectId" FROM public."IngestionConfigurationProject" scope
      WHERE scope."customerId"=customer AND scope."sourceId"=source AND scope."configRevision"=planned_config
      ORDER BY scope."projectId" LIMIT 101) INTO current_projects;
    IF planned_receipt IS NOT NULL THEN
        SELECT ARRAY(SELECT scope."projectId" FROM public."IngestionConfigurationProject" scope
          WHERE scope."customerId"=customer AND scope."sourceId"=source AND scope."configRevision"=original_config
          ORDER BY scope."projectId" LIMIT 101) INTO original_projects;
        IF cardinality(original_projects) NOT BETWEEN 1 AND 100 THEN RETURN NEXT; RETURN; END IF;
    END IF;
    IF cardinality(current_projects) NOT BETWEEN 1 AND 100 THEN RETURN NEXT; RETURN; END IF;
    SELECT ARRAY(SELECT DISTINCT member FROM unnest(current_projects || original_projects) AS scope(member)
      ORDER BY member) INTO scope_projects;

    -- An unentitled caller must get the same denial even while an existing
    -- source or retained receipt's project scope is locked. This preliminary
    -- check authorizes no result; the locked checks below still decide access.
    IF EXISTS (SELECT 1 FROM unnest(scope_projects) AS scope(project_id)
      WHERE NOT EXISTS (SELECT 1 FROM public."Project" p JOIN public."AccessGrant" g
        ON g."customerId"=p."customerId" AND g.subject=actor_subject AND g.role=ANY(actor_roles)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
        WHERE p."customerId"=customer AND p.id=scope.project_id)
      OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
        WHERE reader."customerId"=customer AND reader."sourceId"=source AND reader."configRevision"=planned_config
          AND reader."projectId"=scope.project_id AND reader.subject=actor_subject)
      OR (scope.project_id=ANY(original_projects) AND NOT EXISTS (
        SELECT 1 FROM public."IngestionConfigurationReader" reader
        WHERE reader."customerId"=customer AND reader."sourceId"=source AND reader."configRevision"=original_config
          AND reader."projectId"=scope.project_id AND reader.subject=actor_subject)))
    THEN RETURN NEXT; RETURN; END IF;

    -- Lock in the same order as workbook append. A racing writer yields a
    -- generic retry status, with no indication of which command exists.
    PERFORM p.id FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
      ORDER BY p.id FOR SHARE OF p NOWAIT;
    GET DIAGNOSTICS locked_projects = ROW_COUNT;
    IF locked_projects<>cardinality(scope_projects) THEN RETURN NEXT; RETURN; END IF;
    SELECT ARRAY(SELECT g.id FROM public."AccessGrant" g
      WHERE g."customerId"=customer AND g.subject=actor_subject AND g.role=ANY(actor_roles)
        AND EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
          AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
      ORDER BY g.id FOR SHARE OF g NOWAIT) INTO eligible_grants;
    IF EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
      AND NOT EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g.id=ANY(eligible_grants)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))))
    THEN RETURN NEXT; RETURN; END IF;
    SELECT s.* INTO locked_source FROM public."IngestionSource" s
      WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX' FOR SHARE OF s NOWAIT;
    IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
    IF ROW(locked_source."currentConfigRevision",locked_source."mappingRevision") IS DISTINCT FROM ROW(planned_config,planned_mapping)
    THEN status := 'RETRY'; RETURN NEXT; RETURN; END IF;
    SELECT r.* INTO retained FROM public."IngestionOperationReceipt" r
      WHERE r."customerId"=customer AND r."sourceId"=source AND r.subject=actor_subject
        AND r.kind='XLSX_PREVIEW' AND r."commandKey"=command_key;
    IF retained.id IS DISTINCT FROM planned_receipt THEN status := 'RETRY'; RETURN NEXT; RETURN; END IF;
    -- A reader of the current source must still be permitted on every project
    -- captured by the original command, including an empty original preview.
    IF EXISTS (SELECT 1 FROM unnest(scope_projects) AS scope(project_id)
      WHERE NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
        WHERE reader."customerId"=customer AND reader."sourceId"=source AND reader."configRevision"=planned_config
          AND reader."projectId"=scope.project_id AND reader.subject=actor_subject)) THEN RETURN NEXT; RETURN; END IF;
    IF retained.id IS NOT NULL AND EXISTS (SELECT 1 FROM unnest(original_projects) AS scope(project_id)
      WHERE NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
        WHERE reader."customerId"=customer AND reader."sourceId"=source AND reader."configRevision"=retained."configRevision"
          AND reader."projectId"=scope.project_id AND reader.subject=actor_subject)) THEN RETURN NEXT; RETURN; END IF;

    SELECT c.mapping INTO current_provenance FROM public."IngestionConfigurationRevision" c
      WHERE c."customerId"=customer AND c."sourceId"=source AND c.revision=planned_config
        AND c."mappingRevision"=planned_mapping AND c.sealed;
    IF NOT FOUND OR public.valid_ingestion_xlsx_mapping(current_provenance) IS NOT TRUE THEN
      status := 'INTEGRITY_CONFLICT'; RETURN NEXT; RETURN;
    END IF;
    IF retained.id IS NULL THEN
        status := CASE WHEN config_revision=planned_config AND mapping_revision=planned_mapping AND sheet=current_provenance->>'sheet'
          THEN 'ABSENT' ELSE 'STALE_CONFIGURATION' END;
        RETURN NEXT; RETURN;
    END IF;
    IF workbook_bytes IS NULL THEN status := 'CHECK_BYTES'; RETURN NEXT; RETURN; END IF;
    SELECT c.mapping INTO provenance FROM public."IngestionConfigurationRevision" c
      WHERE c."customerId"=customer AND c."sourceId"=source AND c.revision=retained."configRevision"
        AND c."mappingRevision"=retained."mappingRevision" AND c.sealed;
    IF NOT FOUND OR provenance IS DISTINCT FROM current_provenance OR retained."mappingRevision"<>planned_mapping THEN
      status := 'INTEGRITY_CONFLICT'; RETURN NEXT; RETURN;
    END IF;
    incoming_hash := public.ingestion_xlsx_v1_request_hash(jsonb_build_object('customerId',customer,'sourceId',source,
      'subject',actor_subject,'commandKey',command_key,'configRevision',config_revision,'mappingRevision',mapping_revision,
      'sheet',sheet,'parserContract',provenance->'parserContract','workbookBytes',workbook_bytes,'workbookSha256',workbook_digest));
    IF incoming_hash IS DISTINCT FROM retained."requestHash"::text THEN status := 'CONFLICT'; RETURN NEXT; RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."IngestionXlsxHead" h JOIN public."IngestionXlsxContext" context
        ON context."customerId"=h."customerId" AND context."sourceId"=h."sourceId"
        WHERE h."customerId"=customer AND h."sourceId"=source AND context."receiptId"=retained.id
          AND (context.revision<h.revision OR (context.revision=h.revision AND context."receiptId"=h."currentReceiptId"
            AND context."stateSha256"=h."stateSha256")))
      OR public.valid_ingestion_xlsx_context(retained.id) IS NOT TRUE
    THEN status := 'INTEGRITY_CONFLICT'; RETURN NEXT; RETURN; END IF;
    status := 'REPLAYED'; receipt_id := retained.id; row_count := retained."outcomeCount";
    RETURN NEXT; RETURN;
EXCEPTION WHEN lock_not_available THEN
    status := 'RETRY'; receipt_id := NULL; row_count := NULL;
    RETURN NEXT; RETURN;
END $$;

REVOKE ALL ON FUNCTION public.probe_ingestion_xlsx_retry(uuid,uuid,text,text[],text,integer,integer,text,integer,text) FROM PUBLIC;
DO $xlsx_retry_acl$
DECLARE repository_role text;
BEGIN
    FOREACH repository_role IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
        IF to_regrole(repository_role) IS NOT NULL THEN
            EXECUTE format('REVOKE ALL ON FUNCTION public.probe_ingestion_xlsx_retry(uuid,uuid,text,text[],text,integer,integer,text,integer,text) FROM %I',repository_role);
        END IF;
    END LOOP;
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
        ALTER FUNCTION public.probe_ingestion_xlsx_retry(uuid,uuid,text,text[],text,integer,integer,text,integer,text) OWNER TO pdaa_migrate;
        IF to_regrole('pdaa_api') IS NOT NULL THEN
            GRANT EXECUTE ON FUNCTION public.probe_ingestion_xlsx_retry(uuid,uuid,text,text[],text,integer,integer,text,integer,text) TO pdaa_api;
        END IF;
    END IF;
END $xlsx_retry_acl$;
