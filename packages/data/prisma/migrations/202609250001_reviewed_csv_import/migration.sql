ALTER TABLE public."IngestionOperationReceipt"
  DROP CONSTRAINT "IngestionOperationReceipt_kind_check",
  ADD CONSTRAINT "IngestionOperationReceipt_kind_check" CHECK (
    kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT','CSV_PREVIEW','CSV_REVIEWED_IMPORT','SYNC_RESET')
    AND (kind<>'CONNECTOR_PAGE' OR "outcomeCount"<=100)
    AND (kind<>'CONNECTOR_EVENT' OR "outcomeCount"=1)
    AND (kind<>'CSV_REVIEWED_IMPORT' OR "outcomeCount" BETWEEN 1 AND 1000)
  );

ALTER TABLE public."IngestionOperationReceipt"
  DROP CONSTRAINT "IngestionOperationReceipt_cursor_check",
  ADD CONSTRAINT "IngestionOperationReceipt_cursor_check" CHECK (
    (kind='CONNECTOR_PAGE' AND "generationBefore" IS NOT NULL AND "generationAfter"="generationBefore" AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0)
    OR (kind='SYNC_RESET' AND "generationBefore">0 AND "generationAfter"="generationBefore"+1 AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0 AND "outcomeCount"=0)
    OR (kind IN ('CONNECTOR_EVENT','CSV_PREVIEW','CSV_REVIEWED_IMPORT') AND "generationBefore" IS NULL AND "generationAfter" IS NULL AND "cursorRevisionBefore" IS NULL AND "cursorRevisionAfter" IS NULL)
  );

ALTER TABLE public."IngestionRowOutcome"
  ADD CONSTRAINT "IngestionRowOutcome_scope_ordinal_key"
  UNIQUE ("customerId","sourceId","receiptId",ordinal);

CREATE TABLE public."IngestionReviewedImport" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "previewReceiptId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionReviewedImport_pkey" PRIMARY KEY ("receiptId"),
  CONSTRAINT "IngestionReviewedImport_scope_parent_key" UNIQUE ("customerId","sourceId","previewReceiptId"),
  CONSTRAINT "IngestionReviewedImport_exact_scope_key" UNIQUE ("customerId","sourceId","receiptId","previewReceiptId"),
  CONSTRAINT "IngestionReviewedImport_receipt_fkey" FOREIGN KEY ("customerId","sourceId","receiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReviewedImport_preview_fkey" FOREIGN KEY ("customerId","sourceId","previewReceiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReviewedImport_distinct_receipts_check" CHECK ("receiptId"<>"previewReceiptId")
);

CREATE TABLE public."IngestionReviewedImportRow" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  ordinal integer NOT NULL,
  "previewReceiptId" uuid NOT NULL,
  "previewOrdinal" integer NOT NULL,
  CONSTRAINT "IngestionReviewedImportRow_pkey" PRIMARY KEY ("receiptId",ordinal),
  CONSTRAINT "IngestionReviewedImportRow_preview_row_key" UNIQUE ("customerId","sourceId","previewReceiptId","previewOrdinal"),
  CONSTRAINT "IngestionReviewedImportRow_header_fkey" FOREIGN KEY ("customerId","sourceId","receiptId","previewReceiptId") REFERENCES public."IngestionReviewedImport"("customerId","sourceId","receiptId","previewReceiptId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReviewedImportRow_receipt_outcome_fkey" FOREIGN KEY ("customerId","sourceId","receiptId",ordinal) REFERENCES public."IngestionRowOutcome"("customerId","sourceId","receiptId",ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReviewedImportRow_preview_outcome_fkey" FOREIGN KEY ("customerId","sourceId","previewReceiptId","previewOrdinal") REFERENCES public."IngestionRowOutcome"("customerId","sourceId","receiptId",ordinal) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReviewedImportRow_ordinal_check" CHECK (ordinal BETWEEN 1 AND 1000 AND "previewOrdinal" BETWEEN 1 AND 1000)
);

CREATE FUNCTION public.guard_ingestion_reviewed_import() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE review public."IngestionOperationReceipt"%ROWTYPE; preview public."IngestionOperationReceipt"%ROWTYPE; source_row public."IngestionSource"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Reviewed import header is immutable'; END IF;
  SELECT * INTO review FROM public."IngestionOperationReceipt"
    WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  SELECT * INTO preview FROM public."IngestionOperationReceipt"
    WHERE id=NEW."previewReceiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF review.id IS NULL OR preview.id IS NULL OR review.kind<>'CSV_REVIEWED_IMPORT' OR review."executionMode"<>'HUMAN' OR review."syncJobId" IS NOT NULL
    OR preview.kind<>'CSV_PREVIEW' OR preview."executionMode"<>'HUMAN' OR preview."syncJobId" IS NOT NULL
    OR ROW(review."configRevision",review."mappingRevision") IS DISTINCT FROM ROW(preview."configRevision",preview."mappingRevision") THEN
    RAISE EXCEPTION 'Reviewed import must reference the current same-source CSV preview';
  END IF;
  SELECT * INTO source_row FROM public."IngestionSource"
    WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND OR ROW(source_row."currentConfigRevision",source_row."mappingRevision") IS DISTINCT FROM ROW(review."configRevision",review."mappingRevision") THEN
    RAISE EXCEPTION 'Reviewed import source configuration is stale';
  END IF;
  IF public.valid_ingestion_receipt(NEW."previewReceiptId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Reviewed import parent preview is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_ingestion_reviewed_import_row() RETURNS trigger
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
  IF review.id IS NULL OR child."receiptId" IS NULL OR parent."receiptId" IS NULL OR review.kind<>'CSV_REVIEWED_IMPORT' OR NEW.ordinal>review."outcomeCount"
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

CREATE OR REPLACE FUNCTION public.valid_ingestion_receipt(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; actual_count integer; min_ordinal integer; max_ordinal integer; expected_event text; parent_id uuid;
BEGIN
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_count,min_ordinal,max_ordinal FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_count<>r."outcomeCount" OR (actual_count>0 AND (min_ordinal<>1 OR max_ordinal<>actual_count)) THEN RETURN false; END IF;
  IF r."executionMode"='HUMAN' THEN
    IF r."syncJobId" IS NOT NULL OR (SELECT count(*) FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" s WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) OR EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id) THEN RETURN false; END IF;
  ELSIF r."executionMode"='CONNECTOR_SYNC' THEN
    IF r."syncJobId" IS NULL OR (SELECT count(*) FROM public."IngestionSyncReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision") OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionSyncReceiptProjectScope" s JOIN public."ConnectorSyncGrant" g ON g.id=s."syncGrantId" AND g."customerId"=s."customerId" AND g."sourceId"=s."sourceId" AND g."projectId"=s."projectId" WHERE s."receiptId"=r.id AND s."projectId"=p."projectId" AND g.active AND g."configRevision"=r."configRevision")) OR EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id) OR NOT EXISTS (SELECT 1 FROM public."ConnectorSyncJob" j WHERE j.id=r."syncJobId" AND j."customerId"=r."customerId" AND j."sourceId"=r."sourceId" AND j."configRevision"=r."configRevision" AND j."mappingRevision"=r."mappingRevision" AND j.state IN ('READY','COMPLETED')) THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  expected_event:=CASE r.kind WHEN 'CONNECTOR_PAGE' THEN 'ingestion.connector_page.persisted' WHEN 'CONNECTOR_EVENT' THEN 'ingestion.connector_event.persisted' WHEN 'CSV_PREVIEW' THEN 'ingestion.csv_preview.persisted' WHEN 'CSV_REVIEWED_IMPORT' THEN 'ingestion.csv_reviewed_import.persisted' WHEN 'SYNC_RESET' THEN 'ingestion.sync_reset' END;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=r."customerId" AND a.actor=r.subject AND a.event=expected_event AND a."occurredAt"=r."createdAt" AND a.detail=jsonb_build_object('receiptId',r.id,'kind',r.kind,'sourceId',r."sourceId",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",'scopeProjectIds',(SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id) || (SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionSyncReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id),'requestHash',r."requestHash",'outcomeCount',r."outcomeCount")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND ((o.state='ACCEPTED' AND (o."recordKey" IS NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e.id=o."recordId" AND e."customerId"=o."customerId" AND e."sourceId"=o."sourceId" AND e."projectId"=o."projectId" AND e."recordKey"=o."recordKey") OR NOT EXISTS (SELECT 1 FROM public."IngestionSourceRevision" v WHERE v.id=o."sourceRevisionId" AND v."customerId"=o."customerId" AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" p WHERE p.id=o."projectionId" AND p."customerId"=o."customerId" AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalContent" c WHERE c."customerId"=o."customerId" AND c."sourceId"=o."sourceId" AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId") OR o."projectId" IS NULL)) OR (o.state<>'ACCEPTED' AND (o."projectionId" IS NOT NULL OR cardinality(o."errorCodes")=0)))) THEN RETURN false; END IF;
  IF r.kind='SYNC_RESET' AND (r."outcomeCount"<>0 OR r."generationAfter"<>r."generationBefore"+1 OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind='CONNECTOR_PAGE' AND (r."generationAfter"<>r."generationBefore" OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind IN ('CONNECTOR_PAGE','SYNC_RESET') AND NOT EXISTS (SELECT 1 FROM public."IngestionCursorTransition" t WHERE t."customerId"=r."customerId" AND t."sourceId"=r."sourceId" AND t."receiptId"=r.id AND t."generationBefore"=r."generationBefore" AND t."generationAfter"=r."generationAfter" AND t."cursorRevisionBefore"=r."cursorRevisionBefore" AND t."cursorRevisionAfter"=r."cursorRevisionAfter" AND ((r.kind='SYNC_RESET' AND t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NULL) OR (r.kind='CONNECTOR_PAGE' AND ((t."stateAfter"='TERMINAL' AND t."cursorEnvelopeHash" IS NULL) OR (t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NOT NULL))))) THEN RETURN false; END IF;
  IF r.kind='CSV_REVIEWED_IMPORT' THEN
    SELECT "previewReceiptId" INTO parent_id FROM public."IngestionReviewedImport" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "receiptId"=r.id;
    IF r."outcomeCount" NOT BETWEEN 1 AND 1000 OR parent_id IS NULL
      OR (SELECT count(*) FROM public."IngestionReviewedImportRow" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "receiptId"=r.id)<>r."outcomeCount"
      OR NOT EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" p WHERE p.id=parent_id AND p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p.kind='CSV_PREVIEW' AND p."executionMode"='HUMAN' AND p."syncJobId" IS NULL AND p."configRevision"=r."configRevision" AND p."mappingRevision"=r."mappingRevision" AND public.valid_ingestion_receipt(p.id) IS TRUE)
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
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.require_ingestion_reviewed_import_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.valid_ingestion_receipt(NEW."receiptId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Incomplete reviewed import receipt cannot commit';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER ingestion_reviewed_import_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionReviewedImport"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_reviewed_import();
CREATE TRIGGER ingestion_reviewed_import_no_truncate
  BEFORE TRUNCATE ON public."IngestionReviewedImport"
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_reviewed_import_row_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionReviewedImportRow"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_reviewed_import_row();
CREATE TRIGGER ingestion_reviewed_import_row_no_truncate
  BEFORE TRUNCATE ON public."IngestionReviewedImportRow"
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE CONSTRAINT TRIGGER ingestion_reviewed_import_header_commit
  AFTER INSERT ON public."IngestionReviewedImport"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_reviewed_import_complete();
CREATE CONSTRAINT TRIGGER ingestion_reviewed_import_row_commit
  AFTER INSERT ON public."IngestionReviewedImportRow"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_reviewed_import_complete();

REVOKE ALL ON FUNCTION public.guard_ingestion_reviewed_import(),public.guard_ingestion_reviewed_import_row(),public.require_ingestion_reviewed_import_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_ingestion_receipt(uuid) FROM PUBLIC;
