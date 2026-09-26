CREATE OR REPLACE FUNCTION public.guard_ingestion_outcome() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion row outcome is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt"
  WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR NEW.ordinal<1 OR NEW.ordinal>r."outcomeCount" THEN
    RAISE EXCEPTION 'Ingestion row outcome outside receipt';
  END IF;
  IF NEW.state='ACCEPTED' AND (
    NEW."recordKey" IS NULL OR NOT EXISTS (
      SELECT 1 FROM public."IngestionExternalRecord" e
      WHERE e."customerId"=NEW."customerId" AND e."sourceId"=NEW."sourceId"
        AND e.id=NEW."recordId" AND e."recordKey"=NEW."recordKey"
    )
  ) THEN
    RAISE EXCEPTION 'Accepted outcome identity must match its external record';
  END IF;
  IF NEW."projectId" IS NOT NULL AND NOT (
    (
      r."executionMode"='HUMAN' AND EXISTS (
        SELECT 1 FROM public."IngestionReceiptProjectScope" s
        WHERE s."customerId"=NEW."customerId" AND s."sourceId"=NEW."sourceId"
          AND s."receiptId"=r.id AND s."projectId"=NEW."projectId"
      )
    ) OR (
      r."executionMode"='CONNECTOR_SYNC' AND EXISTS (
        SELECT 1 FROM public."IngestionSyncReceiptProjectScope" s
        WHERE s."customerId"=NEW."customerId" AND s."sourceId"=NEW."sourceId"
          AND s."receiptId"=r.id AND s."projectId"=NEW."projectId"
      )
    )
  ) THEN
    RAISE EXCEPTION 'Ingestion row outside authorized receipt scope';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_ingestion_outcome() FROM PUBLIC;
