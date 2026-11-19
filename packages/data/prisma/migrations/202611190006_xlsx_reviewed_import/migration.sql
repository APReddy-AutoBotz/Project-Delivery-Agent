-- FR-CON-006/007: reviewed native workbook rows remain immutable proposals.
ALTER TABLE public."IngestionOperationReceipt"
  DROP CONSTRAINT "IngestionOperationReceipt_kind_check",
  ADD CONSTRAINT "IngestionOperationReceipt_kind_check" CHECK (
    kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT','CSV_PREVIEW','CSV_REVIEWED_IMPORT','SYNC_RESET','XLSX_PREVIEW','XLSX_REVIEWED_IMPORT')
    AND (kind<>'CONNECTOR_PAGE' OR "outcomeCount"<=100)
    AND (kind<>'CONNECTOR_EVENT' OR "outcomeCount"=1)
    AND (kind NOT IN ('CSV_REVIEWED_IMPORT','XLSX_REVIEWED_IMPORT') OR "outcomeCount" BETWEEN 1 AND 1000)
    AND (kind NOT IN ('XLSX_PREVIEW','XLSX_REVIEWED_IMPORT') OR ("executionMode"='HUMAN' AND "syncJobId" IS NULL))
  ),
  DROP CONSTRAINT "IngestionOperationReceipt_cursor_check",
  ADD CONSTRAINT "IngestionOperationReceipt_cursor_check" CHECK (
    (kind='CONNECTOR_PAGE' AND "generationBefore" IS NOT NULL AND "generationAfter"="generationBefore" AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0)
    OR (kind='SYNC_RESET' AND "generationBefore">0 AND "generationAfter"="generationBefore"+1 AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0 AND "outcomeCount"=0)
    OR (kind IN ('CONNECTOR_EVENT','CSV_PREVIEW','CSV_REVIEWED_IMPORT','XLSX_PREVIEW','XLSX_REVIEWED_IMPORT') AND "generationBefore" IS NULL AND "generationAfter" IS NULL AND "cursorRevisionBefore" IS NULL AND "cursorRevisionAfter" IS NULL)
  );

CREATE OR REPLACE FUNCTION public.guard_ingestion_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_row public."IngestionSource"%ROWTYPE; mapping_value jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion operation receipt is immutable'; END IF;
  IF NEW.kind IN ('XLSX_PREVIEW','XLSX_REVIEWED_IMPORT') THEN
    IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
      RAISE EXCEPTION 'Workbook ingestion owner required';
    END IF;
    -- Take the project and grant fences before the source/head write locks.
    -- Acquiring only a source SHARE lock here creates an upgrade deadlock at append.
    PERFORM p.id FROM public."IngestionConfigurationProject" scope
      JOIN public."Project" p ON p."customerId"=scope."customerId" AND p.id=scope."projectId"
      WHERE scope."customerId"=NEW."customerId" AND scope."sourceId"=NEW."sourceId"
        AND scope."configRevision"=NEW."configRevision" ORDER BY p.id FOR UPDATE OF p;
    PERFORM g.id FROM public."AccessGrant" g WHERE g."customerId"=NEW."customerId" AND g.subject=NEW.subject
      AND g.role IN ('project_manager','portfolio_manager','pmo_admin') AND EXISTS (
        SELECT 1 FROM public."IngestionConfigurationProject" scope
        JOIN public."Project" p ON p."customerId"=scope."customerId" AND p.id=scope."projectId"
        WHERE scope."customerId"=NEW."customerId" AND scope."sourceId"=NEW."sourceId"
          AND scope."configRevision"=NEW."configRevision" AND ((g."scopeType"='project' AND g."scopeId"=p.id)
            OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))) ORDER BY g.id FOR SHARE OF g;
    PERFORM "customerId" FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR source_row."inputFamily" IS DISTINCT FROM 'XLSX' THEN
      RAISE EXCEPTION 'Workbook preview requires a workbook source';
    END IF;
    PERFORM "sourceId" FROM public."IngestionXlsxHead"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" FOR UPDATE;
  ELSE
    SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  END IF;
  IF source_row.id IS NULL OR ROW(source_row."currentConfigRevision",source_row."mappingRevision")
    IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN RAISE EXCEPTION 'Ingestion receipt uses stale configuration'; END IF;
  SELECT mapping INTO mapping_value FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND revision=NEW."configRevision" AND "mappingRevision"=NEW."mappingRevision" AND sealed;
  IF mapping_value IS NULL OR (NEW.kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT') AND mapping_value->>'kind' IS DISTINCT FROM 'CONNECTOR')
    OR (NEW.kind IN ('CSV_PREVIEW','CSV_REVIEWED_IMPORT') AND mapping_value->>'kind' IS DISTINCT FROM 'CSV')
    OR (NEW.kind IN ('XLSX_PREVIEW','XLSX_REVIEWED_IMPORT') AND mapping_value->>'kind' IS DISTINCT FROM 'XLSX') THEN
    RAISE EXCEPTION 'Ingestion receipt mapping family is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.valid_ingestion_receipt(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; actual_count integer; min_ordinal integer; max_ordinal integer; expected_event text; parent_id uuid; csv_head public."IngestionCsvHead"%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_count,min_ordinal,max_ordinal FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_count<>r."outcomeCount" OR (actual_count>0 AND (min_ordinal<>1 OR max_ordinal<>actual_count)) THEN RETURN false; END IF;
  IF r."executionMode"='HUMAN' THEN
    IF r."syncJobId" IS NOT NULL OR (SELECT count(*) FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" s WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) OR EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id) THEN RETURN false; END IF;
  ELSIF r."executionMode"='CONNECTOR_SYNC' THEN
    IF r."syncJobId" IS NULL OR (SELECT count(*) FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" s JOIN public."ConnectorSyncGrant" g ON g.id=s."syncGrantId" AND g."customerId"=s."customerId" AND g."sourceId"=s."sourceId" AND g."projectId"=s."projectId" WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) OR EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id) OR NOT EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j.id=r."syncJobId" AND j."customerId"=r."customerId" AND j."sourceId"=r."sourceId" AND j."configRevision"=r."configRevision" AND j."mappingRevision"=r."mappingRevision" AND j.state IN ('READY','COMPLETED')) THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  expected_event:=CASE r.kind WHEN 'CONNECTOR_PAGE' THEN 'ingestion.connector_page.persisted' WHEN 'CONNECTOR_EVENT' THEN 'ingestion.connector_event.persisted' WHEN 'CSV_PREVIEW' THEN 'ingestion.csv_preview.persisted' WHEN 'XLSX_PREVIEW' THEN 'ingestion.xlsx_preview.persisted' WHEN 'XLSX_REVIEWED_IMPORT' THEN 'ingestion.xlsx_reviewed_import.persisted' WHEN 'CSV_REVIEWED_IMPORT' THEN 'ingestion.csv_reviewed_import.persisted' WHEN 'SYNC_RESET' THEN 'ingestion.sync_reset' END;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=r."customerId" AND a.actor=r.subject AND a.event=expected_event AND a."occurredAt"=r."createdAt" AND a.detail=jsonb_build_object('receiptId',r.id,'kind',r.kind,'sourceId',r."sourceId",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",'scopeProjectIds',(SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id) || (SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionSyncReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id),'requestHash',r."requestHash",'outcomeCount',r."outcomeCount")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND ((o.state='ACCEPTED' AND (o."recordKey" IS NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e.id=o."recordId" AND e."customerId"=o."customerId" AND e."sourceId"=o."sourceId" AND e."projectId"=o."projectId" AND e."recordKey"=o."recordKey") OR NOT EXISTS (SELECT 1 FROM public."IngestionSourceRevision" v WHERE v.id=o."sourceRevisionId" AND v."customerId"=o."customerId" AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" p WHERE p.id=o."projectionId" AND p."customerId"=o."customerId" AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalContent" c WHERE c."customerId"=o."customerId" AND c."sourceId"=o."sourceId" AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId") OR o."projectId" IS NULL)) OR (o.state<>'ACCEPTED' AND (o."projectionId" IS NOT NULL OR cardinality(o."errorCodes")=0)))) THEN RETURN false; END IF;
  IF r.kind='SYNC_RESET' AND (r."outcomeCount"<>0 OR r."generationAfter"<>r."generationBefore"+1 OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind='CONNECTOR_PAGE' AND (r."generationAfter"<>r."generationBefore" OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind IN ('CONNECTOR_PAGE','SYNC_RESET') AND NOT EXISTS (SELECT 1 FROM public."IngestionCursorTransition" t WHERE t."customerId"=r."customerId" AND t."sourceId"=r."sourceId" AND t."receiptId"=r.id AND t."generationBefore"=r."generationBefore" AND t."generationAfter"=r."generationAfter" AND t."cursorRevisionBefore"=r."cursorRevisionBefore" AND t."cursorRevisionAfter"=r."cursorRevisionAfter" AND ((r.kind='SYNC_RESET' AND t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NULL) OR (r.kind='CONNECTOR_PAGE' AND ((t."stateAfter"='TERMINAL' AND t."cursorEnvelopeHash" IS NULL) OR (t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NOT NULL))))) THEN RETURN false; END IF;
  IF r.kind IN ('CSV_REVIEWED_IMPORT','XLSX_REVIEWED_IMPORT') THEN
    SELECT "previewReceiptId" INTO parent_id FROM public."IngestionReviewedImport" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "receiptId"=r.id;
    IF r."outcomeCount" NOT BETWEEN 1 AND 1000 OR parent_id IS NULL
      OR (SELECT count(*) FROM public."IngestionReviewedImportRow" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "receiptId"=r.id)<>r."outcomeCount"
      OR NOT EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" p WHERE p.id=parent_id AND p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p.kind=CASE r.kind WHEN 'XLSX_REVIEWED_IMPORT' THEN 'XLSX_PREVIEW' ELSE 'CSV_PREVIEW' END AND p."executionMode"='HUMAN' AND p."syncJobId" IS NULL AND p."configRevision"=r."configRevision" AND p."mappingRevision"=r."mappingRevision" AND public.valid_ingestion_receipt(p.id) IS TRUE)
      OR EXISTS (
        SELECT 1 FROM public."IngestionReviewedImportRow" link
        JOIN public."IngestionRowOutcome" child ON child."customerId"=link."customerId" AND child."sourceId"=link."sourceId" AND child."receiptId"=link."receiptId" AND child.ordinal=link.ordinal
        JOIN public."IngestionRowOutcome" parent ON parent."customerId"=link."customerId" AND parent."sourceId"=link."sourceId" AND parent."receiptId"=link."previewReceiptId" AND parent.ordinal=link."previewOrdinal"
        WHERE link."customerId"=r."customerId" AND link."sourceId"=r."sourceId" AND link."receiptId"=r.id
          AND (child.state<>'ACCEPTED' OR child.operation NOT IN ('CREATE','UPDATE','UNCHANGED') OR cardinality(child."errorCodes")<>0
            OR ROW(child."projectId",child."recordKey",child."recordId",child."sourceRevisionId",child."projectionId",child.operation) IS DISTINCT FROM ROW(parent."projectId",parent."recordKey",parent."recordId",parent."sourceRevisionId",parent."projectionId",parent.operation))
      ) THEN RETURN false; END IF;
  ELSIF EXISTS (SELECT 1 FROM public."IngestionReviewedImport" WHERE "receiptId"=r.id)
    OR EXISTS (SELECT 1 FROM public."IngestionReviewedImportRow" WHERE "receiptId"=r.id) THEN RETURN false;
  END IF;
  IF r.kind IN ('XLSX_PREVIEW','XLSX_REVIEWED_IMPORT') AND (r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public."IngestionSource" s WHERE s."customerId"=r."customerId" AND s.id=r."sourceId" AND s."inputFamily"='XLSX')) THEN RETURN false; END IF;
  -- Full immutable-state validation is mandatory in the CSV-specific deferred
  -- constraints and semantic consumers, not multiplied through every outcome.
  IF r.kind='CSV_PREVIEW' THEN
    SELECT * INTO csv_head FROM public."IngestionCsvHead" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId";
    IF FOUND THEN
      IF csv_head.readiness='READY' THEN
        IF NOT EXISTS (SELECT 1 FROM public."IngestionCsvContext" c WHERE c."receiptId"=r.id
          AND c."customerId"=r."customerId" AND c."sourceId"=r."sourceId"
          AND c."configRevision"=r."configRevision" AND c."mappingRevision"=r."mappingRevision"
          AND c."mappingRevision"=csv_head."mappingRevision" AND c.revision BETWEEN 1 AND csv_head.revision) THEN RETURN false; END IF;
      ELSIF csv_head.readiness='LEGACY_UNAVAILABLE' THEN
        IF EXISTS (SELECT 1 FROM public."IngestionCsvContext" WHERE "receiptId"=r.id) THEN RETURN false; END IF;
      ELSE RETURN false; END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" cfg
      ON cfg."customerId"=s."customerId" AND cfg."sourceId"=s.id AND cfg.revision=s."currentConfigRevision" AND cfg.sealed
      WHERE s."customerId"=r."customerId" AND s.id=r."sourceId" AND cfg.mapping->>'kind'='CONNECTOR') THEN RETURN false;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.valid_ingestion_xlsx_genesis(customer uuid, source uuid) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $$
DECLARE h public."IngestionXlsxHead"%ROWTYPE; mapping_value jsonb; expected_dictionary jsonb; encoded text;
BEGIN
    SELECT head.* INTO h FROM public."IngestionXlsxHead" head
    WHERE head."customerId"=customer AND head."sourceId"=source;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT activation.mapping INTO mapping_value FROM public."IngestionSource" s
    JOIN public."IngestionConfigurationRevision" activation ON activation."customerId"=s."customerId"
        AND activation."sourceId"=s.id AND activation.revision=h."activationConfigRevision" AND activation.sealed
        AND activation."mappingRevision"=h."mappingRevision"
    JOIN public."IngestionConfigurationRevision" current_config ON current_config."customerId"=s."customerId"
        AND current_config."sourceId"=s.id AND current_config.revision=s."currentConfigRevision"
        AND current_config."mappingRevision"=s."mappingRevision" AND current_config.sealed
    WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX' AND s."sourceType"='xlsx'
        AND s."mappingRevision"=h."mappingRevision" AND current_config.mapping=activation.mapping
        AND s."cursorRevision"=0 AND s."syncGeneration"=1 AND s."cursorState"='RESET_REQUIRED'
        AND s."cursorEnvelope" IS NULL AND s."lastSuccessReceiptId" IS NULL
        AND s."healthState"='UNKNOWN' AND s."healthCode"='NONE' AND s."healthCheckedAt" IS NULL;
    IF NOT FOUND OR public.valid_ingestion_xlsx_mapping(mapping_value) IS NOT TRUE
        OR EXISTS (SELECT 1 FROM public."IngestionCsvHead" c WHERE c."customerId"=customer AND c."sourceId"=source)
        OR EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e."customerId"=customer AND e."sourceId"=source
          AND e."recordType" COLLATE "C"<>('xlsx:'||(mapping_value->>'sheet')) COLLATE "C")
        OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r."customerId"=customer AND r."sourceId"=source AND r.kind NOT IN ('XLSX_PREVIEW','XLSX_REVIEWED_IMPORT'))
        OR EXISTS (SELECT 1 FROM public."IngestionConfigurationRevision" c WHERE c."customerId"=customer AND c."sourceId"=source
          AND c.sealed AND (c."mappingRevision"<>h."mappingRevision" OR c.mapping IS DISTINCT FROM mapping_value))
        OR EXISTS (SELECT 1 FROM public."ConnectorCredential" c WHERE c."customerId"=customer AND c."sourceId"=source)
        OR EXISTS (SELECT 1 FROM public."ConnectorSyncGrant" g WHERE g."customerId"=customer AND g."sourceId"=source)
        OR EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j."customerId"=customer AND j."sourceId"=source)
        OR EXISTS (SELECT 1 FROM public."ConnectorWebhookReceipt" w WHERE w."customerId"=customer AND w."sourceId"=source)
    THEN RETURN false; END IF;
    SELECT jsonb_agg(jsonb_build_array(value->'factType',value->'type') ORDER BY (value->>'factType') COLLATE "C")
        INTO expected_dictionary FROM jsonb_array_elements(mapping_value->'fields') AS field(value);
    IF h.dictionary IS DISTINCT FROM expected_dictionary THEN RETURN false; END IF;
    encoded := public.ingestion_xlsx_v1_state_text(customer,source,h."mappingRevision",
        mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,'[]'::jsonb);
    RETURN h."genesisSha256"::text IS NOT DISTINCT FROM encode(sha256(convert_to(encoded,'UTF8')),'hex');
END $$;

CREATE OR REPLACE FUNCTION public.guard_ingestion_xlsx_legacy_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF TG_TABLE_NAME='IngestionOperationReceipt' THEN
        -- The receipt guard verifies owner, sealed mapping and exact source kind.
        IF NEW.kind IN ('XLSX_PREVIEW','XLSX_REVIEWED_IMPORT') THEN RETURN NEW; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionSource" WHERE "customerId"=NEW."customerId"
        AND id=NEW."sourceId" AND "inputFamily"='XLSX') THEN
        RAISE EXCEPTION 'Legacy ingestion is unavailable for workbook sources';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_ingestion_reviewed_import() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review public."IngestionOperationReceipt"%ROWTYPE; preview public."IngestionOperationReceipt"%ROWTYPE; source_row public."IngestionSource"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reviewed import header is immutable'; END IF;
  SELECT * INTO review FROM public."IngestionOperationReceipt"
    WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  SELECT * INTO preview FROM public."IngestionOperationReceipt"
    WHERE id=NEW."previewReceiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF review.id IS NULL OR preview.id IS NULL OR review.kind NOT IN ('CSV_REVIEWED_IMPORT','XLSX_REVIEWED_IMPORT') OR review."executionMode"<>'HUMAN' OR review."syncJobId" IS NOT NULL
    OR preview.kind<>(CASE review.kind WHEN 'XLSX_REVIEWED_IMPORT' THEN 'XLSX_PREVIEW' ELSE 'CSV_PREVIEW' END) OR preview."executionMode"<>'HUMAN' OR preview."syncJobId" IS NOT NULL
    OR ROW(review."configRevision",review."mappingRevision") IS DISTINCT FROM ROW(preview."configRevision",preview."mappingRevision") THEN
    RAISE EXCEPTION 'Reviewed import must reference the current same-source preview';
  END IF;
  SELECT * INTO source_row FROM public."IngestionSource"
    WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND OR ROW(source_row."currentConfigRevision",source_row."mappingRevision") IS DISTINCT FROM ROW(review."configRevision",review."mappingRevision") THEN
    RAISE EXCEPTION 'Reviewed import source configuration is stale';
  END IF;
  IF public.valid_ingestion_receipt(NEW."previewReceiptId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Reviewed import parent preview is invalid';
  END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND readiness='READY')
    AND public.valid_ingestion_csv_context(NEW."previewReceiptId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Reviewed import parent comparison is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_ingestion_reviewed_import_row() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review public."IngestionOperationReceipt"%ROWTYPE; child public."IngestionRowOutcome"%ROWTYPE; parent public."IngestionRowOutcome"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reviewed import row linkage is immutable'; END IF;
  SELECT * INTO review FROM public."IngestionOperationReceipt"
    WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  SELECT * INTO child FROM public."IngestionRowOutcome"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "receiptId"=NEW."receiptId" AND ordinal=NEW.ordinal;
  SELECT * INTO parent FROM public."IngestionRowOutcome"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "receiptId"=NEW."previewReceiptId" AND ordinal=NEW."previewOrdinal";
  IF review.id IS NULL OR child."receiptId" IS NULL OR parent."receiptId" IS NULL OR review.kind NOT IN ('CSV_REVIEWED_IMPORT','XLSX_REVIEWED_IMPORT') OR NEW.ordinal>review."outcomeCount"
    OR child.state<>'ACCEPTED' OR child.operation NOT IN ('CREATE','UPDATE','UNCHANGED') OR cardinality(child."errorCodes")<>0
    OR parent.state<>'ACCEPTED' OR parent.operation NOT IN ('CREATE','UPDATE','UNCHANGED') OR cardinality(parent."errorCodes")<>0
    OR ROW(child."projectId",child."recordKey",child."recordId",child."sourceRevisionId",child."projectionId",child.operation)
      IS DISTINCT FROM ROW(parent."projectId",parent."recordKey",parent."recordId",parent."sourceRevisionId",parent."projectionId",parent.operation)
    OR NOT EXISTS (
      SELECT 1
      FROM public."IngestionProposalContent" c
      JOIN public."IngestionProposalProjection" p ON p."customerId"=c."customerId" AND p."sourceId"=c."sourceId" AND p."recordId"=c."recordId" AND p.id=c."projectionId"
      JOIN public."IngestionSourceRevision" v ON v."customerId"=p."customerId" AND v."sourceId"=p."sourceId" AND v."recordId"=p."recordId" AND v.id=p."sourceRevisionId"
      JOIN public."IngestionRetentionPolicy" policy ON policy."customerId"=v."customerId"
      WHERE c."customerId"=NEW."customerId" AND c."sourceId"=NEW."sourceId" AND c."recordId"=parent."recordId" AND c."projectionId"=parent."projectionId"
        AND c.proposals IS NOT NULL AND c."redactedAt" IS NULL
        AND v."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp()
        AND public.valid_ingestion_projection_content(p.id,c.proposals) IS TRUE
    ) THEN
    RAISE EXCEPTION 'Reviewed import rows must link eligible, current, hash-valid preview proposals';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.require_ingestion_reviewed_import_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- The separate native receipt trigger validates the full selection once.
  IF EXISTS (
    SELECT 1 FROM public."IngestionOperationReceipt" r
    WHERE r.id=NEW."receiptId" AND r.kind='XLSX_REVIEWED_IMPORT'
  ) THEN RETURN NULL; END IF;
  IF public.valid_ingestion_receipt(NEW."receiptId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Incomplete reviewed import receipt cannot commit';
  END IF;
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
    IF FOUND AND TG_TABLE_NAME='IngestionRowOutcome' AND receipt.kind IN ('CSV_PREVIEW','XLSX_PREVIEW','XLSX_REVIEWED_IMPORT')
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

CREATE FUNCTION public.verified_ingestion_xlsx_context(target uuid) RETURNS jsonb
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
    proof jsonb;
BEGIN
    SELECT * INTO c FROM public."IngestionXlsxContext" WHERE "receiptId"=target;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO h FROM public."IngestionXlsxHead" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND id=target;
    IF NOT FOUND OR r.kind<>'XLSX_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
        OR r."mappingRevision"<>h."mappingRevision" OR public.valid_ingestion_receipt(target) IS NOT TRUE
    THEN RETURN NULL; END IF;
    SELECT activation.mapping INTO mapping_value FROM public."IngestionConfigurationRevision" activation
    JOIN public."IngestionConfigurationRevision" receipt_config ON receipt_config."customerId"=activation."customerId"
      AND receipt_config."sourceId"=activation."sourceId" AND receipt_config.revision=r."configRevision"
      AND receipt_config."mappingRevision"=activation."mappingRevision" AND receipt_config.sealed
      AND receipt_config.mapping=activation.mapping
    WHERE activation."customerId"=c."customerId" AND activation."sourceId"=c."sourceId"
      AND activation.revision=h."activationConfigRevision" AND activation."mappingRevision"=h."mappingRevision" AND activation.sealed;
    IF NOT FOUND OR mapping_value->>'kind' IS DISTINCT FROM 'XLSX' THEN RETURN NULL; END IF;
    prior_config := h."activationConfigRevision";
    IF c.revision=1 THEN
        IF c."predecessorSha256" IS DISTINCT FROM h."genesisSha256" THEN RETURN NULL; END IF;
    ELSE
        SELECT * INTO parent FROM public."IngestionXlsxContext" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId"
          AND revision=c."predecessorRevision" AND "receiptId"=c."predecessorReceiptId" AND "stateSha256"=c."predecessorSha256";
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT "configRevision" INTO prior_config FROM public."IngestionOperationReceipt"
          WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND id=parent."receiptId" AND kind='XLSX_PREVIEW';
        IF NOT FOUND THEN RETURN NULL; END IF;
        prior_rows := parent.rows;
        baseline := jsonb_build_object('kind','RETAINED','receiptId',parent."receiptId",'revision',parent.revision,'stateSha256',parent."stateSha256"::text);
    END IF;
    encoded := public.ingestion_xlsx_v1_state_text(c."customerId",c."sourceId",h."mappingRevision",
        mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,c.rows);
    IF encoded IS NULL OR octet_length(encoded)<>c."canonicalBytes"
        OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>c."stateSha256"::text THEN RETURN NULL; END IF;
    IF c.revision>1 THEN
        IF prior_rows IS DISTINCT FROM c.rows THEN
            encoded := public.ingestion_xlsx_v1_state_text(c."customerId",c."sourceId",h."mappingRevision",
                mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,prior_rows);
        END IF;
        IF encoded IS NULL OR octet_length(encoded)<>parent."canonicalBytes"
            OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>parent."stateSha256"::text THEN RETURN NULL; END IF;
    END IF;
    SELECT coalesce(jsonb_object_agg(entry->>0,entry),'{}'::jsonb) INTO prior_by_key
      FROM jsonb_array_elements(prior_rows) AS prior(entry);
    IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" old_scope
      WHERE old_scope."customerId"=c."customerId" AND old_scope."sourceId"=c."sourceId" AND old_scope."configRevision"=prior_config
        AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" captured WHERE captured."receiptId"=target
          AND captured."customerId"=old_scope."customerId" AND captured."sourceId"=old_scope."sourceId"
          AND captured."projectId"=old_scope."projectId")) THEN RETURN NULL; END IF;
    -- The immutable reader and exact project grant scope survive revocation.
    -- Restore must not consult today's AccessGrant or project portfolio.
    IF EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" captured WHERE captured."receiptId"=target
      AND (ROW(captured."customerId",captured."sourceId") IS DISTINCT FROM ROW(c."customerId",c."sourceId")
        OR (captured."grantScopeType"='project' AND captured."grantScopeId"<>captured."projectId")
        OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
          WHERE reader."customerId"=c."customerId" AND reader."sourceId"=c."sourceId" AND reader."configRevision"=r."configRevision"
            AND reader."projectId"=captured."projectId" AND reader.subject=r.subject))) THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.rows) AS identities(identity)
      WHERE NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e
        JOIN public."IngestionReceiptProjectScope" scope ON scope."receiptId"=target AND scope."customerId"=e."customerId"
          AND scope."sourceId"=e."sourceId" AND scope."projectId"=e."projectId"
        WHERE e."customerId"=c."customerId" AND e."sourceId"=c."sourceId" AND e.id=(identity->>1)::uuid
          AND e."projectId"=(identity->>2)::uuid AND e."recordKey" COLLATE "C"=(identity->>0) COLLATE "C"
          AND e."recordType" COLLATE "C"=('xlsx:'||(mapping_value->>'sheet')) COLLATE "C")) THEN RETURN NULL; END IF;
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
    ) THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=target AND "recordKey" IS NOT NULL
      GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RETURN NULL; END IF;
    IF c.rows IS DISTINCT FROM public.ingestion_xlsx_overlay(target,h.dictionary,prior_rows) THEN RETURN NULL; END IF;

    request_doc := jsonb_build_object('customerId',r."customerId",'sourceId',r."sourceId",'subject',r.subject,
        'commandKey',r."commandKey",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",
        'sheet',mapping_value->'sheet','parserContract',mapping_value->'parserContract',
        'workbookBytes',c."workbookBytes",'workbookSha256',c."workbookSha256"::text);
    IF public.ingestion_xlsx_v1_request_hash(request_doc) IS DISTINCT FROM r."requestHash"::text THEN RETURN NULL; END IF;
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
    proof := jsonb_build_object('request',request_doc,'previewReceiptId',target,
      'baseline',baseline,'projectIds',projects,'outcomes',outcomes);
    IF public.ingestion_xlsx_v1_context_hash(proof) IS DISTINCT FROM c."contextSha256"::text THEN
        RETURN NULL;
    END IF;
    RETURN proof;
END $$;

CREATE OR REPLACE FUNCTION public.valid_ingestion_xlsx_context(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
  SELECT public.verified_ingestion_xlsx_context(target) IS NOT NULL
$$;

-- Full historical review proof. Proposal contents may have been lawfully
-- redacted since the review. The stored parent context and row links remain.
CREATE FUNCTION public.valid_ingestion_xlsx_reviewed_import(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  receipt public."IngestionOperationReceipt"%ROWTYPE;
  parent uuid;
  context_sha text;
  context_proof jsonb;
  ordinals jsonb;
BEGIN
  SELECT r.* INTO receipt FROM public."IngestionOperationReceipt" r
    WHERE r.id=target AND r.kind='XLSX_REVIEWED_IMPORT';
  IF NOT FOUND OR public.valid_ingestion_receipt(target) IS NOT TRUE THEN RETURN false; END IF;
  SELECT c."receiptId",c."contextSha256"::text INTO parent,context_sha
    FROM public."IngestionReviewedImport" review
    JOIN public."IngestionXlsxContext" c
      ON c."customerId"=review."customerId" AND c."sourceId"=review."sourceId"
      AND c."receiptId"=review."previewReceiptId"
    JOIN public."IngestionXlsxHead" h ON h."customerId"=c."customerId" AND h."sourceId"=c."sourceId"
    WHERE review."receiptId"=target AND (c.revision<h.revision OR
      (c.revision=h.revision AND c."receiptId"=h."currentReceiptId" AND c."stateSha256"=h."stateSha256"));
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" scope
    WHERE scope."receiptId"=target AND
      ((scope."grantScopeType"='project' AND scope."grantScopeId"<>scope."projectId")
        OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
          WHERE reader."customerId"=receipt."customerId" AND reader."sourceId"=receipt."sourceId"
            AND reader."configRevision"=receipt."configRevision"
            AND reader."projectId"=scope."projectId" AND reader.subject=receipt.subject)))
  THEN RETURN false; END IF;
  context_proof := public.verified_ingestion_xlsx_context(parent);
  IF context_proof IS NULL THEN RETURN false; END IF;
  SELECT jsonb_agg(link."previewOrdinal" ORDER BY link.ordinal) INTO ordinals
    FROM public."IngestionReviewedImportRow" link
    WHERE link."customerId"=receipt."customerId" AND link."sourceId"=receipt."sourceId" AND link."receiptId"=target;
  RETURN public.ingestion_xlsx_v1_selection_hash(jsonb_build_object(
    'customerId',receipt."customerId",'sourceId',receipt."sourceId",'subject',receipt.subject,
    'commandKey',receipt."commandKey",'previewReceiptId',parent,'previewContextSha256',context_sha,
    'rowOrdinals',ordinals),context_proof) IS NOT DISTINCT FROM receipt."requestHash"::text;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.require_ingestion_xlsx_reviewed_import_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_RELID<>'public."IngestionOperationReceipt"'::regclass OR TG_OP<>'INSERT'
    OR NEW.kind<>'XLSX_REVIEWED_IMPORT'
    OR public.valid_ingestion_xlsx_reviewed_import(NEW.id) IS NOT TRUE
  THEN RAISE EXCEPTION 'Incomplete workbook review cannot commit'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ingestion_xlsx_reviewed_import_commit AFTER INSERT ON public."IngestionOperationReceipt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='XLSX_REVIEWED_IMPORT')
  EXECUTE FUNCTION public.require_ingestion_xlsx_reviewed_import_complete();

CREATE FUNCTION public.commit_ingestion_xlsx_reviewed_import(
  customer uuid, source uuid, actor_subject text, actor_roles text[], command_key text,
  preview uuid, context_sha text, ordinals integer[], correlation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  denied CONSTANT jsonb := '{"status":"DENIED"}';
  conflict CONSTANT jsonb := '{"status":"CONFLICT"}';
  invalid CONSTANT jsonb := '{"status":"INVALID_PREVIEW"}';
  planned_config integer;
  planned_review uuid;
  original_config integer;
  live_source public."IngestionSource"%ROWTYPE;
  retained public."IngestionOperationReceipt"%ROWTYPE;
  parent public."IngestionOperationReceipt"%ROWTYPE;
  head public."IngestionXlsxHead"%ROWTYPE;
  current_projects uuid[];
  original_projects uuid[] := '{}'::uuid[];
  scope_projects uuid[];
  eligible uuid[];
  locked_count integer;
  policy_hours integer;
  stored_parent uuid;
  context_proof jsonb;
  command_doc jsonb;
  incoming_hash text;
  target uuid := gen_random_uuid();
  audit_id uuid := gen_random_uuid();
  observed_at timestamptz(3);
BEGIN
  IF session_user<>'pdaa_api' OR customer IS NULL OR source IS NULL
    OR public.ingestion_xlsx_v1_text(to_jsonb(actor_subject),256) IS NULL
    OR array_ndims(actor_roles) IS DISTINCT FROM 1 OR cardinality(actor_roles) NOT BETWEEN 1 AND 3
    OR EXISTS (SELECT 1 FROM unnest(actor_roles) a(role)
      WHERE role IS NULL OR role NOT IN ('project_manager','portfolio_manager','pmo_admin'))
  THEN RETURN denied; END IF;
  IF (command_key COLLATE "C" ~ '^[A-Za-z0-9_-]{1,128}$') IS NOT TRUE
    OR preview IS NULL OR public.ingestion_xlsx_v1_digest(to_jsonb(context_sha)) IS NOT TRUE
    OR array_ndims(ordinals) IS DISTINCT FROM 1 OR cardinality(ordinals) NOT BETWEEN 1 AND 1000
    OR EXISTS (SELECT 1 FROM (SELECT v,lag(v,1,0) OVER (ORDER BY position) AS prev
      FROM unnest(ordinals) WITH ORDINALITY a(v,position)) checked
      WHERE v IS NULL OR v NOT BETWEEN 1 AND 1000 OR v<=prev)
    OR (correlation COLLATE "C" ~ '^[A-Za-z0-9_.:-]{1,128}$') IS NOT TRUE
  THEN RETURN '{"status":"INVALID_REQUEST"}'; END IF;

  SELECT s."currentConfigRevision" INTO planned_config FROM public."IngestionSource" s
    WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX';
  IF NOT FOUND OR planned_config IS NULL THEN RETURN denied; END IF;
  SELECT r.id,r."configRevision" INTO planned_review,original_config
    FROM public."IngestionOperationReceipt" r
    WHERE r."customerId"=customer AND r."sourceId"=source AND r.subject=actor_subject
      AND r.kind='XLSX_REVIEWED_IMPORT' AND r."commandKey"=command_key;
  SELECT ARRAY(SELECT p."projectId" FROM public."IngestionConfigurationProject" p
    WHERE p."customerId"=customer AND p."sourceId"=source AND p."configRevision"=planned_config
    ORDER BY p."projectId" LIMIT 101) INTO current_projects;
  IF cardinality(current_projects) NOT BETWEEN 1 AND 100 THEN RETURN denied; END IF;
  IF planned_review IS NOT NULL THEN
    SELECT ARRAY(SELECT p."projectId" FROM public."IngestionConfigurationProject" p
      WHERE p."customerId"=customer AND p."sourceId"=source AND p."configRevision"=original_config
      ORDER BY p."projectId" LIMIT 101) INTO original_projects;
    IF cardinality(original_projects) NOT BETWEEN 1 AND 100 THEN RETURN denied; END IF;
  END IF;
  SELECT ARRAY(SELECT DISTINCT entry FROM unnest(current_projects || original_projects) a(entry)
    ORDER BY entry) INTO scope_projects;

  -- Before any lock attempt, avoid disclosing the existence or contention of
  -- an existing command to an actor without the current and captured scope.
  IF EXISTS (SELECT 1 FROM unnest(scope_projects) scope(project_id)
    WHERE NOT EXISTS (SELECT 1 FROM public."Project" p JOIN public."AccessGrant" g
      ON g."customerId"=p."customerId" AND g.subject=actor_subject AND g.role=ANY(actor_roles)
      AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR
        (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))
      WHERE p."customerId"=customer AND p.id=scope.project_id)
    OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
      AND r."sourceId"=source AND r."configRevision"=planned_config AND r."projectId"=scope.project_id AND r.subject=actor_subject)
    OR (scope.project_id=ANY(original_projects) AND NOT EXISTS (
      SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
        AND r."sourceId"=source AND r."configRevision"=original_config AND r."projectId"=scope.project_id AND r.subject=actor_subject))
  ) THEN RETURN denied; END IF;

  PERFORM p.id FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
    ORDER BY p.id FOR UPDATE OF p;
  GET DIAGNOSTICS locked_count=ROW_COUNT;
  IF locked_count<>cardinality(scope_projects) THEN RETURN denied; END IF;
  SELECT ARRAY(SELECT g.id FROM public."AccessGrant" g
    WHERE g."customerId"=customer AND g.subject=actor_subject
      AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
      AND EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR
          (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
    ORDER BY g.id FOR SHARE OF g) INTO eligible;
  IF EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=customer AND p.id=ANY(scope_projects)
    AND NOT EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g.id=ANY(eligible) AND g.role=ANY(actor_roles)
      AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR
        (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))))
  THEN RETURN denied; END IF;
  IF planned_review IS NULL THEN
    SELECT p."retentionHours" INTO policy_hours FROM public."IngestionRetentionPolicy" p
      WHERE p."customerId"=customer FOR SHARE OF p;
  END IF;
  SELECT s.* INTO live_source FROM public."IngestionSource" s
    WHERE s."customerId"=customer AND s.id=source AND s."inputFamily"='XLSX' FOR UPDATE OF s;
  IF NOT FOUND OR live_source."currentConfigRevision" IS DISTINCT FROM planned_config
  THEN RETURN '{"status":"RETRY"}'; END IF;
  SELECT r.* INTO retained FROM public."IngestionOperationReceipt" r
    WHERE r."customerId"=customer AND r."sourceId"=source AND r.subject=actor_subject
      AND r.kind='XLSX_REVIEWED_IMPORT' AND r."commandKey"=command_key;
  IF retained.id IS DISTINCT FROM planned_review THEN RETURN '{"status":"RETRY"}'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(scope_projects) scope(project_id)
    WHERE NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
      AND r."sourceId"=source AND r."configRevision"=planned_config AND r."projectId"=scope.project_id AND r.subject=actor_subject)
    OR (scope.project_id=ANY(original_projects) AND NOT EXISTS (
      SELECT 1 FROM public."IngestionConfigurationReader" r WHERE r."customerId"=customer
        AND r."sourceId"=source AND r."configRevision"=original_config AND r."projectId"=scope.project_id AND r.subject=actor_subject))
  ) THEN RETURN denied; END IF;

  SELECT h.* INTO head FROM public."IngestionXlsxHead" h
    WHERE h."customerId"=customer AND h."sourceId"=source FOR SHARE OF h;
  IF NOT FOUND THEN RETURN '{"status":"INTEGRITY_CONFLICT"}'; END IF;
  command_doc := jsonb_build_object('customerId',customer,'sourceId',source,'subject',actor_subject,
    'commandKey',command_key,'previewReceiptId',preview,'previewContextSha256',context_sha,
    'rowOrdinals',to_jsonb(ordinals));
  IF retained.id IS NOT NULL THEN
    IF public.valid_ingestion_xlsx_reviewed_import(retained.id) IS NOT TRUE
    THEN RETURN '{"status":"INTEGRITY_CONFLICT"}'; END IF;
    SELECT r."previewReceiptId" INTO stored_parent FROM public."IngestionReviewedImport" r
      WHERE r."receiptId"=retained.id;
    IF stored_parent IS DISTINCT FROM preview THEN RETURN conflict; END IF;
    incoming_hash := public.ingestion_xlsx_v1_selection_hash(command_doc,public.verified_ingestion_xlsx_context(stored_parent));
    IF incoming_hash IS DISTINCT FROM retained."requestHash"::text THEN RETURN conflict; END IF;
    RETURN jsonb_build_object('status','REPLAYED','receiptId',retained.id,'rowCount',retained."outcomeCount");
  END IF;

  SELECT r.* INTO parent FROM public."IngestionOperationReceipt" r
    JOIN public."IngestionXlsxContext" c ON c."receiptId"=r.id AND c."customerId"=r."customerId" AND c."sourceId"=r."sourceId"
    WHERE r."customerId"=customer AND r."sourceId"=source AND r.id=preview AND r.kind='XLSX_PREVIEW'
      AND (c.revision<head.revision OR (c.revision=head.revision AND c."receiptId"=head."currentReceiptId"
        AND c."stateSha256"=head."stateSha256"));
  IF NOT FOUND THEN RETURN invalid; END IF;
  IF ROW(parent."configRevision",parent."mappingRevision") IS DISTINCT FROM ROW(planned_config,live_source."mappingRevision")
  THEN RETURN '{"status":"STALE_CONFIGURATION"}'; END IF;
  IF policy_hours IS NULL THEN RETURN '{"status":"RETENTION_REQUIRED"}'; END IF;
  context_proof := public.verified_ingestion_xlsx_context(preview);
  IF context_proof IS NULL THEN RETURN invalid; END IF;
  incoming_hash := public.ingestion_xlsx_v1_selection_hash(command_doc,context_proof);
  IF incoming_hash IS NULL THEN RETURN invalid; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionReviewedImport" r WHERE r."customerId"=customer AND r."sourceId"=source
    AND r."previewReceiptId"=preview) THEN RETURN conflict; END IF;

  -- Selected immutable references are enough. A review does not consult the
  -- current retained baseline or require any unused proposal value to be live.
  PERFORM c."projectionId" FROM public."IngestionRowOutcome" o
    JOIN public."IngestionProposalContent" c ON c."customerId"=o."customerId" AND c."sourceId"=o."sourceId"
      AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId"
    WHERE o."customerId"=customer AND o."sourceId"=source AND o."receiptId"=preview AND o.ordinal=ANY(ordinals)
    ORDER BY c."projectionId" FOR SHARE OF c;
  GET DIAGNOSTICS locked_count=ROW_COUNT;
  IF locked_count<>cardinality(ordinals) THEN RETURN invalid; END IF;

  observed_at := clock_timestamp();
  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId","occurredAt",detail)
    VALUES (audit_id,customer,actor_subject,'ingestion.xlsx_reviewed_import.persisted',correlation,observed_at,
      jsonb_build_object('receiptId',target,'kind','XLSX_REVIEWED_IMPORT','sourceId',source,'configRevision',planned_config,
        'mappingRevision',parent."mappingRevision",'scopeProjectIds',current_projects,'requestHash',incoming_hash,
        'outcomeCount',cardinality(ordinals)));
  INSERT INTO public."IngestionOperationReceipt" (id,"customerId","sourceId",subject,kind,"commandKey","requestHash",
    "configRevision","mappingRevision","outcomeCount","auditEventId","createdAt")
    VALUES (target,customer,source,actor_subject,'XLSX_REVIEWED_IMPORT',command_key,incoming_hash,
      planned_config,parent."mappingRevision",cardinality(ordinals),audit_id,observed_at);
  INSERT INTO public."IngestionReceiptProjectScope" ("customerId","sourceId","receiptId","projectId",
    "grantId","grantRole","grantScopeType","grantScopeId")
    SELECT customer,source,target,p.id,g.id,g.role,g."scopeType",g."scopeId"
    FROM public."Project" p CROSS JOIN LATERAL (
      SELECT a.id,a.role,a."scopeType",a."scopeId" FROM public."AccessGrant" a
      WHERE a.id=ANY(eligible) AND a.role=ANY(actor_roles) AND ((a."scopeType"='project' AND a."scopeId"=p.id)
        OR (a."scopeType"='portfolio' AND a."scopeId"=p."portfolioId")) ORDER BY a.id LIMIT 1
    ) g WHERE p."customerId"=customer AND p.id=ANY(current_projects) ORDER BY p.id;
  INSERT INTO public."IngestionRowOutcome" ("customerId","sourceId","receiptId",ordinal,state,operation,"errorCodes",
    "projectId","recordKey","recordId","sourceRevisionId","projectionId")
    SELECT customer,source,target,selected.position::integer,o.state,o.operation,o."errorCodes",
      o."projectId",o."recordKey",o."recordId",o."sourceRevisionId",o."projectionId"
    FROM unnest(ordinals) WITH ORDINALITY selected(parent_ordinal,position)
    JOIN public."IngestionRowOutcome" o ON o."customerId"=customer AND o."sourceId"=source
      AND o."receiptId"=preview AND o.ordinal=selected.parent_ordinal ORDER BY selected.position;
  INSERT INTO public."IngestionReviewedImport" ("customerId","sourceId","receiptId","previewReceiptId","createdAt")
    VALUES (customer,source,target,preview,observed_at);
  -- The existing link guard checks each locked projection hash and the current
  -- retention policy. A late failure rolls back the entire function statement.
  INSERT INTO public."IngestionReviewedImportRow" ("customerId","sourceId","receiptId",ordinal,"previewReceiptId","previewOrdinal")
    SELECT customer,source,target,position::integer,preview,parent_ordinal
    FROM unnest(ordinals) WITH ORDINALITY selected(parent_ordinal,position) ORDER BY position;
  RETURN jsonb_build_object('status','STORED','receiptId',target,'rowCount',cardinality(ordinals));
EXCEPTION
  WHEN lock_not_available OR deadlock_detected THEN RETURN '{"status":"RETRY"}';
  WHEN unique_violation THEN RETURN conflict;
  WHEN raise_exception OR check_violation OR foreign_key_violation THEN RETURN invalid;
END $$;

DO $roles$
DECLARE signature text; repository_role text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.verified_ingestion_xlsx_context(uuid)',
    'public.valid_ingestion_xlsx_reviewed_import(uuid)',
    'public.require_ingestion_xlsx_reviewed_import_complete()',
    'public.commit_ingestion_xlsx_reviewed_import(uuid,uuid,text,text[],text,uuid,text,integer[],text)'
  ] LOOP
    EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC';
    FOREACH repository_role IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
      IF to_regrole(repository_role) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,repository_role);
      END IF;
    END LOOP;
    IF to_regrole('pdaa_migrate') IS NOT NULL THEN
      EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO pdaa_migrate';
    END IF;
  END LOOP;
  IF to_regrole('pdaa_migrate') IS NOT NULL AND to_regrole('pdaa_api') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.commit_ingestion_xlsx_reviewed_import(uuid,uuid,text,text[],text,uuid,text,integer[],text) TO pdaa_api;
  END IF;
END $roles$;
