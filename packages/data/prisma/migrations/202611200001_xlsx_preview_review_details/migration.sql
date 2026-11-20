-- Reuse receipt authorization, lock ordering and integrity checks without loading row content.
CREATE FUNCTION public.read_ingestion_xlsx_preview_review_details(
  customer uuid, source uuid, actor_subject text, actor_roles text[], preview uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET DateStyle='ISO, YMD' SET TimeZone='UTC' AS $$
DECLARE
  receipt_result jsonb;
  receipt_view jsonb;
  captured_mapping jsonb;
  captured_fields jsonb;
  reviewed_summary jsonb;
  details jsonb;
  invalid CONSTANT jsonb := '{"status":"INTEGRITY_CONFLICT"}';
BEGIN
  receipt_result := public.read_ingestion_xlsx_preview_receipt(
    customer, source, actor_subject, actor_roles, preview, 1000);
  IF receipt_result->>'status' IS DISTINCT FROM 'READY' THEN RETURN receipt_result; END IF;
  receipt_view := receipt_result->'view';

  SELECT c.mapping INTO captured_mapping FROM public."IngestionConfigurationRevision" c
  WHERE c."customerId"=customer AND c."sourceId"=source AND c.sealed
    AND c.revision=(receipt_view->>'configRevision')::integer
    AND c."mappingRevision"=(receipt_view->>'mappingRevision')::integer;
  IF public.valid_ingestion_xlsx_mapping(captured_mapping) IS NOT TRUE THEN RETURN invalid; END IF;
  SELECT jsonb_agg(jsonb_build_object('column',f.value->'column',
    'factType',f.value->'factType','type',f.value->'type','required',f.value->'required') ORDER BY f.ordinal)
    INTO captured_fields FROM jsonb_array_elements(captured_mapping->'fields') WITH ORDINALITY AS f(value,ordinal);

  IF receipt_view->>'selectionState'='REVIEWED' THEN
    SELECT jsonb_build_object('receiptId',r.id,
      'createdAt',to_char(r."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'rowCount',r."outcomeCount") INTO reviewed_summary
    FROM public."IngestionReviewedImport" i JOIN public."IngestionOperationReceipt" r
      ON r.id=i."receiptId" AND r."customerId"=i."customerId" AND r."sourceId"=i."sourceId"
    WHERE i."customerId"=customer AND i."sourceId"=source AND i."previewReceiptId"=preview
      AND r.kind='XLSX_REVIEWED_IMPORT';
    IF NOT FOUND THEN RETURN invalid; END IF;
  END IF;

  details := jsonb_build_object('status','READY','view',jsonb_build_object(
    'sourceId',source,'previewReceiptId',preview,
    'configRevision',receipt_view->'configRevision','mappingRevision',receipt_view->'mappingRevision',
    'mapping',jsonb_build_object('sheet',captured_mapping->'sheet',
      'identityColumn',captured_mapping->'identityColumn','projectColumn',captured_mapping->'projectColumn',
      'fields',captured_fields),
    'reviewedImport',reviewed_summary));
  IF octet_length(details::text)>65536 THEN RETURN invalid; END IF;
  RETURN details;
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN '{"status":"RETRY"}';
END $$;

DO $roles$
DECLARE runtime_role text;
BEGIN
  REVOKE ALL ON FUNCTION public.read_ingestion_xlsx_preview_review_details(uuid,uuid,text,text[],uuid) FROM PUBLIC;
  FOREACH runtime_role IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
    IF to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.read_ingestion_xlsx_preview_review_details(uuid,uuid,text,text[],uuid) FROM %I',runtime_role);
    END IF;
  END LOOP;
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.read_ingestion_xlsx_preview_review_details(uuid,uuid,text,text[],uuid) OWNER TO pdaa_migrate;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.read_ingestion_xlsx_preview_review_details(uuid,uuid,text,text[],uuid) TO pdaa_api;
    END IF;
  END IF;
END $roles$;
