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

-- Private admission input. The caller must first authorize the exact project,
-- publication capability, and canonical binding and pass its frozen mapping.
-- Keep these locks through the eventual fact and witness commit.
CREATE FUNCTION public.resolve_source_observation_input(
  customer uuid, project uuid, source uuid, stream uuid, receipt_id uuid,
  row_ordinal integer, snapshot_field text, state_mapping jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' SET DateStyle='ISO, YMD' AS $$
DECLARE
  src public."IngestionSource"%ROWTYPE;
  receipt public."IngestionOperationReceipt"%ROWTYPE;
  policy public."IngestionRetentionPolicy"%ROWTYPE;
  captured record;
  mapping jsonb;
  adapter_mapping jsonb;
  retained jsonb;
  source_kind text;
  source_text text;
  canonical_state text;
  snapshot_text text;
  effective_at timestamptz;
  observed_at timestamptz;
  proof jsonb;
  -- Exact canonical UTC millisecond input. Round-trip below rejects calendar
  -- normalization, including leap seconds and midnight rollovers.
  utc_millis CONSTANT text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
BEGIN
  IF customer IS NULL OR project IS NULL OR source IS NULL OR stream IS NULL
    OR receipt_id IS NULL OR row_ordinal IS NULL OR row_ordinal NOT BETWEEN 1 AND 1000
    OR jsonb_typeof(state_mapping) IS DISTINCT FROM 'object'
    OR octet_length(state_mapping::text)>32768
    OR (snapshot_field IS NOT NULL AND snapshot_field COLLATE "C" !~ '^[a-z][a-z0-9_.-]{0,95}$')
  THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM jsonb_each(state_mapping)) NOT BETWEEN 1 AND 32
    OR EXISTS (SELECT 1 FROM jsonb_each(state_mapping) AS item(key,value)
      WHERE length(item.key) NOT BETWEEN 1 AND 4096
        OR item.value NOT IN ('"OPEN"'::jsonb,'"IN_PROGRESS"'::jsonb,'"COMPLETE"'::jsonb,'"CANCELLED"'::jsonb))
  THEN RETURN NULL; END IF;

  -- Match purge's policy -> source -> content order. Source configurations,
  -- receipts, outcome links, streams, projections and revisions are immutable.
  SELECT p.* INTO policy FROM public."IngestionRetentionPolicy" p WHERE p."customerId"=customer FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT s.* INTO src FROM public."IngestionSource" s WHERE s."customerId"=customer AND s.id=source FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT r.* INTO receipt FROM public."IngestionOperationReceipt" r
    WHERE r.id=receipt_id AND r."customerId"=customer AND r."sourceId"=source
      AND r."configRevision"=src."currentConfigRevision" AND r."mappingRevision"=src."mappingRevision";
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT c.mapping INTO mapping FROM public."IngestionConfigurationRevision" c
    JOIN public."IngestionConfigurationProject" cp
      ON (cp."customerId",cp."sourceId",cp."configRevision")=(c."customerId",c."sourceId",c.revision)
    WHERE c."customerId"=customer AND c."sourceId"=source AND c.revision=receipt."configRevision"
      AND c."mappingRevision"=receipt."mappingRevision" AND c.sealed AND cp."projectId"=project;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT f."factType" AS field_type,e.id AS record_id,e."recordType" AS record_type,
    v.id AS revision_id,v.revision,v."sourceContentHash" AS source_hash,v."receivedAt" AS received_at,
    v."remoteObservedAt" AS remote_observed,v."remoteEffectiveAt" AS remote_effective,
    p.id AS projection_id,p."proposalHash" AS projection_hash
    INTO captured
    FROM public."IngestionRowOutcome" o
    JOIN public."IngestionExternalRecord" e
      ON (e."customerId",e."sourceId",e."projectId",e.id)=(o."customerId",o."sourceId",o."projectId",o."recordId")
    JOIN public."IngestionSourceRevision" v
      ON (v."customerId",v."sourceId",v."recordId",v.id)=(o."customerId",o."sourceId",o."recordId",o."sourceRevisionId")
    JOIN public."IngestionProposalProjection" p
      ON (p."customerId",p."sourceId",p."recordId",p."sourceRevisionId",p.id)=(o."customerId",o."sourceId",o."recordId",v.id,o."projectionId")
    JOIN public."IngestionFactStream" f
      ON (f."customerId",f."sourceId",f."recordId")=(o."customerId",o."sourceId",o."recordId")
    WHERE o."customerId"=customer AND o."sourceId"=source AND o."projectId"=project
      AND o."receiptId"=receipt_id AND o.ordinal=row_ordinal AND o.state='ACCEPTED'
      AND o.operation IN ('CREATE','UPDATE','UNCHANGED') AND cardinality(o."errorCodes")=0
      AND f.id=stream AND p."mappingRevision"=receipt."mappingRevision" AND f."factType"=ANY(p."factTypes");
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF src."sourceType"='jira' AND src."inputFamily"='LEGACY' AND mapping->>'kind'='CONNECTOR'
    AND captured.record_type='jira.issue' AND snapshot_field IS NULL THEN
    IF receipt."generationAfter" IS DISTINCT FROM src."syncGeneration"
      OR public.valid_connector_page_dispatch(receipt_id) IS NOT TRUE
      OR public.valid_ingestion_receipt(receipt_id) IS NOT TRUE
      OR jsonb_typeof(mapping->'factTypes') IS DISTINCT FROM 'array'
      OR NOT (mapping->'factTypes' ? captured.field_type)
      OR jsonb_typeof(mapping->'adapterConfiguration') IS DISTINCT FROM 'string'
      OR pg_input_is_valid(mapping->>'adapterConfiguration','jsonb') IS NOT TRUE
    THEN RETURN NULL; END IF;
    adapter_mapping := (mapping->>'adapterConfiguration')::jsonb;
    IF jsonb_typeof(adapter_mapping->'fields') IS DISTINCT FROM 'array'
      OR jsonb_typeof(adapter_mapping->'projects') IS DISTINCT FROM 'array'
    THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(adapter_mapping->'projects') AS item(value)
      WHERE item.value->>'projectId'=project::text)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(adapter_mapping->'fields') AS item(value)
        WHERE item.value->>'jiraField'='status' AND item.value->>'valueType'='text'
          AND item.value->>'factType'=captured.field_type)
    THEN RETURN NULL; END IF;
    PERFORM g.id FROM public."ConnectorSyncGrant" g
      JOIN public."IngestionSyncReceiptProjectScope" scope
        ON (scope."customerId",scope."sourceId",scope."projectId",scope."syncGrantId")=(g."customerId",g."sourceId",g."projectId",g.id)
      WHERE scope."receiptId"=receipt_id AND g."customerId"=customer AND g."sourceId"=source
        AND g."projectId"=project AND g.active AND g."configRevision"=receipt."configRevision"
      FOR SHARE OF g;
    IF NOT FOUND THEN RETURN NULL; END IF;
    source_kind := 'jira.issue';
    effective_at := captured.remote_effective;
    observed_at := captured.remote_observed;
    IF effective_at IS NULL OR observed_at IS NULL
      OR captured.revision COLLATE "C" !~ utc_millis
      OR public.authority_instant(effective_at) IS DISTINCT FROM captured.revision
    THEN RETURN NULL; END IF;
  ELSIF src."sourceType"='xlsx' AND src."inputFamily"='XLSX' AND mapping->>'kind'='XLSX'
    AND captured.record_type='xlsx:'||(mapping->>'sheet') AND snapshot_field IS NOT NULL THEN
    IF snapshot_field=captured.field_type
      OR public.valid_ingestion_xlsx_reviewed_import(receipt_id) IS NOT TRUE
    THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(mapping->'fields') AS item(value)
      WHERE item.value->>'factType'=captured.field_type AND item.value->>'type'='text')
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(mapping->'fields') AS item(value)
        WHERE item.value->>'factType'=snapshot_field AND item.value->>'type'='text')
    THEN RETURN NULL; END IF;
    source_kind := 'xlsx.row';
    observed_at := captured.received_at;
  ELSE RETURN NULL;
  END IF;

  SELECT c.proposals INTO retained FROM public."IngestionProposalContent" c
    WHERE c."customerId"=customer AND c."sourceId"=source AND c."recordId"=captured.record_id
      AND c."projectionId"=captured.projection_id AND c.proposals IS NOT NULL AND c."redactedAt" IS NULL
    FOR SHARE;
  IF NOT FOUND OR captured.received_at+make_interval(hours=>policy."retentionHours")<=clock_timestamp()
    OR public.valid_ingestion_projection_content(captured.projection_id,retained) IS NOT TRUE
  THEN RETURN NULL; END IF;
  SELECT item.value->'value'->>'value' INTO source_text
    FROM jsonb_array_elements(retained) AS item(value)
    WHERE item.value->>'factType'=captured.field_type AND item.value->'value'->>'type'='text';
  canonical_state := state_mapping->>source_text;
  IF canonical_state IS NULL THEN RETURN NULL; END IF;
  IF source_kind='xlsx.row' THEN
    SELECT item.value->'value'->>'value' INTO snapshot_text
      FROM jsonb_array_elements(retained) AS item(value)
      WHERE item.value->>'factType'=snapshot_field AND item.value->'value'->>'type'='text';
    IF snapshot_text IS NULL OR snapshot_text COLLATE "C" !~ utc_millis
      OR pg_input_is_valid(snapshot_text,'timestamptz') IS NOT TRUE
    THEN RETURN NULL; END IF;
    effective_at := snapshot_text::timestamptz;
    IF public.authority_instant(effective_at) IS DISTINCT FROM snapshot_text THEN RETURN NULL; END IF;
  END IF;
  IF effective_at<TIMESTAMPTZ '0001-01-01 00:00:00+00'
    OR observed_at>=TIMESTAMPTZ '10000-01-01 00:00:00+00'
    OR effective_at>observed_at OR observed_at>clock_timestamp()
  THEN RETURN NULL; END IF;

  proof := jsonb_build_object(
    'customerId',customer,'projectId',project,'sourceId',source,'streamId',stream,
    'receiptId',receipt_id,'rowOrdinal',row_ordinal,'sourceKind',source_kind,
    'configRevision',receipt."configRevision",'mappingRevision',receipt."mappingRevision",
    'retentionRevision',policy.revision,'field',captured.field_type,'snapshotField',snapshot_field,
    'recordId',captured.record_id,'sourceRevisionId',captured.revision_id,'projectionId',captured.projection_id,
    'receiptSha256',receipt."requestHash"::text,'sourceSha256',captured.source_hash::text,
    'projectionSha256',captured.projection_hash::text,
    'value',jsonb_build_object('type','text','value',canonical_state),
    'effectiveAt',public.authority_instant(effective_at),
    'observedAt',public.authority_instant(observed_at)
  );
  RETURN proof || jsonb_build_object('fieldSha256',
    encode(sha256(convert_to(jsonb_build_array('pdaa.source-observation-input.v1',proof)::text,'UTF8')),'hex'));
END $$;

REVOKE ALL ON TABLE public."ConnectorPageDispatch" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
  public.record_connector_page_dispatch(uuid),public.valid_connector_page_dispatch(uuid),
  public.resolve_source_observation_input(uuid,uuid,uuid,uuid,uuid,integer,text,jsonb) FROM PUBLIC;
DO $roles$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.record_connector_page_dispatch(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_connector_page_dispatch(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.resolve_source_observation_input(uuid,uuid,uuid,uuid,uuid,integer,text,jsonb) OWNER TO pdaa_migrate;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
        public.record_connector_page_dispatch(uuid) TO pdaa_api;
    END IF;
  END IF;
END $roles$;
