-- EXEC-047: retain the signed dispatch lineage of a committed Jira page.
-- Task replay rows retain their original expiry. Only a successful page
-- retains an immutable digest of its dispatch, never the nonce or signature.
ALTER TABLE public."ConnectorTaskReceipt"
  ADD COLUMN "dispatchCustomerId" uuid,
  ADD COLUMN "dispatchJobId" uuid,
  ADD COLUMN "dispatchGeneration" integer,
  ADD CONSTRAINT "ConnectorTaskReceipt_dispatch_shape" CHECK (
    ("dispatchJobId" IS NULL AND "dispatchGeneration" IS NULL)
    OR ("dispatchCustomerId" IS NOT NULL AND "dispatchJobId" IS NOT NULL
        AND "dispatchGeneration" IS NOT NULL AND "dispatchGeneration" BETWEEN 1 AND 100)
  ),
  ADD CONSTRAINT "ConnectorTaskReceipt_dispatch_claim_key" UNIQUE ("dispatchJobId","dispatchGeneration");

CREATE TABLE public."ConnectorPageDispatch" (
  "receiptId" uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "jobId" uuid NOT NULL UNIQUE,
  "claimGeneration" integer NOT NULL CHECK ("claimGeneration" BETWEEN 1 AND 100),
  "taskDigest" char(64) NOT NULL UNIQUE CHECK ("taskDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "ConnectorPageDispatch_receipt_fk"
    FOREIGN KEY ("customerId","sourceId","receiptId")
    REFERENCES public."IngestionOperationReceipt" ("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ConnectorPageDispatch_job_fk"
    FOREIGN KEY ("customerId","sourceId","jobId")
    REFERENCES public."ConnectorSyncJob" ("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TRIGGER connector_page_dispatch_immutable BEFORE UPDATE OR DELETE ON public."ConnectorPageDispatch"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER connector_page_dispatch_no_truncate BEFORE TRUNCATE ON public."ConnectorPageDispatch"
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE OR REPLACE FUNCTION public.guard_connector_task_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW."dispatchJobId" IS NULL AND NEW."dispatchGeneration" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' AND OLD."createdAt"<CURRENT_TIMESTAMP-interval '10 minutes' THEN
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD."dispatchJobId" IS NULL AND NEW."dispatchJobId" IS NOT NULL
    AND (to_jsonb(NEW)-ARRAY['dispatchJobId','dispatchGeneration']) =
        (to_jsonb(OLD)-ARRAY['dispatchJobId','dispatchGeneration']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Connector task receipts are immutable while replayable';
END $$;

CREATE FUNCTION public.bind_connector_task_claim(
  customer uuid, job_id uuid, generation integer, task_nonce uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  -- A claim must have been written by this transaction. A prior running
  -- attempt cannot acquire a dispatch after its lease was issued.
  IF NOT EXISTS (
    SELECT 1 FROM public."ConnectorSyncJob" j
    WHERE j.id=job_id AND j."customerId"=customer AND j.state='RUNNING'
      AND j.attempts=generation AND j."leaseUntil">clock_timestamp()
      AND j.xmin=pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'Connector task claim unavailable';
  END IF;
  UPDATE public."ConnectorTaskReceipt"
  SET "dispatchJobId"=job_id,"dispatchGeneration"=generation
  WHERE nonce=task_nonce AND "dispatchCustomerId"=customer AND "dispatchJobId" IS NULL
    AND "createdAt">clock_timestamp()-interval '10 minutes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connector task claim unavailable';
  END IF;
END $$;

CREATE FUNCTION public.record_connector_page_dispatch(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public."ConnectorPageDispatch" ("receiptId","customerId","sourceId","jobId","claimGeneration","taskDigest")
  SELECT r.id,r."customerId",r."sourceId",j.id,j.attempts,
    encode(sha256(convert_to(jsonb_build_array(
      'jira-task-v1',t.nonce,t."keyId",extract(epoch FROM t."requestTime"),t."bodyHash"
    )::text,'UTF8')),'hex')
  FROM public."IngestionOperationReceipt" r
  JOIN public."ConnectorSyncJob" j ON (j."customerId",j."sourceId",j.id)=(r."customerId",r."sourceId",r."syncJobId")
  JOIN public."ConnectorTaskReceipt" t ON (t."dispatchCustomerId",t."dispatchJobId",t."dispatchGeneration")=(j."customerId",j.id,j.attempts)
  WHERE r.id=target AND r.kind='CONNECTOR_PAGE' AND r."executionMode"='CONNECTOR_SYNC'
    AND r.subject='connector:jira-runtime' AND j.state='COMPLETED'
    AND j.kind='SCHEDULED' AND j."eventId" IS NULL
    AND r."commandKey"='sync_page_'||replace(j.id::text,'-','')
    AND r."configRevision"=j."configRevision" AND r."mappingRevision"=j."mappingRevision"
    AND r.xmin=pg_current_xact_id()::xid AND j.xmin=pg_current_xact_id()::xid;
END $$;

CREATE FUNCTION public.valid_connector_page_dispatch(target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."ConnectorPageDispatch" d
    JOIN public."IngestionOperationReceipt" r ON (r."customerId",r."sourceId",r.id)=(d."customerId",d."sourceId",d."receiptId")
    JOIN public."ConnectorSyncJob" j ON (j."customerId",j."sourceId",j.id)=(d."customerId",d."sourceId",d."jobId")
    WHERE d."receiptId"=target AND r.kind='CONNECTOR_PAGE' AND r."executionMode"='CONNECTOR_SYNC'
      AND r.subject='connector:jira-runtime' AND r."syncJobId"=j.id
      AND r."configRevision"=j."configRevision" AND r."mappingRevision"=j."mappingRevision"
      AND r."commandKey"='sync_page_'||replace(j.id::text,'-','')
      AND j.state='COMPLETED' AND j.kind='SCHEDULED' AND j."eventId" IS NULL
      AND j.attempts=d."claimGeneration"
  );
$$;

REVOKE ALL ON TABLE public."ConnectorPageDispatch" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
  public.record_connector_page_dispatch(uuid),public.valid_connector_page_dispatch(uuid) FROM PUBLIC;
DO $roles$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.record_connector_page_dispatch(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_connector_page_dispatch(uuid) OWNER TO pdaa_migrate;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
        public.record_connector_page_dispatch(uuid) TO pdaa_api;
    END IF;
  END IF;
END $roles$;
