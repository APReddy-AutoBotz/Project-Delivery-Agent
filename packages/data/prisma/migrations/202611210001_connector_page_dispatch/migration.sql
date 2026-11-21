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

-- The legacy author FK remains meaningful for human statements. The
-- unconditional scoped FK also binds evidence with no human attribution.
ALTER TABLE public."FactSource" ALTER COLUMN "providedBy" DROP NOT NULL,
  ADD COLUMN "ingestionStreamId" uuid REFERENCES public."IngestionFactStream"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FactSource_observation_stream_key" UNIQUE ("factId","ingestionStreamId"),
  ADD CONSTRAINT "FactSource_origin_shape" CHECK (
    ("sourceType"='human_statement' AND "providedBy" IS NOT NULL AND "ingestionStreamId" IS NULL)
    OR ("sourceType" IN ('jira','xlsx') AND "providedBy" IS NULL AND "ingestionStreamId" IS NOT NULL)
  );
ALTER TABLE public."FactEvidence" ALTER COLUMN "providedBy" DROP NOT NULL,
  ALTER COLUMN "originalStatement" DROP NOT NULL,
  ADD CONSTRAINT "FactEvidence_source_scope_fkey" FOREIGN KEY ("customerId","projectId","factId","sourceId")
    REFERENCES public."FactSource" ("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "FactEvidence_origin_shape" CHECK (("providedBy" IS NULL)=("originalStatement" IS NULL));
ALTER TABLE public."ProjectFactVersion" DROP CONSTRAINT "ProjectFactVersion_provenance_check",
  ADD CONSTRAINT "ProjectFactVersion_provenance_check" CHECK (
    provenance='HUMAN_CONFIRMED' OR (provenance='SYSTEM_VERIFIED' AND "effectiveAtValidated" AND "validUntil" IS NOT NULL)
  );

CREATE TABLE public."SourceObservationWitness" (
  "versionId" uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "bindingId" uuid NOT NULL,
  "factId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "evidenceId" uuid NOT NULL UNIQUE,
  "ingestionStreamId" uuid NOT NULL,
  "sourceRevisionId" uuid NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  "admittedAt" timestamptz(3) NOT NULL,
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=8192),
  CONSTRAINT "SourceObservationWitness_revision_key" UNIQUE ("factId","ingestionStreamId","sourceRevisionId"),
  CONSTRAINT "SourceObservationWitness_binding_fkey" FOREIGN KEY ("customerId","projectId","bindingId","factId")
    REFERENCES public."CanonicalStateBinding" ("customerId","projectId",id,"factId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SourceObservationWitness_version_fkey" FOREIGN KEY ("customerId","projectId","factId","versionId","sourceId","evidenceId")
    REFERENCES public."ProjectFactVersion" ("customerId","projectId","factId",id,"sourceId","evidenceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SourceObservationWitness_audit_fkey" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "SourceObservationWitness_source_idx" ON public."SourceObservationWitness" ("sourceId");
CREATE TRIGGER source_observation_witness_immutable BEFORE UPDATE OR DELETE ON public."SourceObservationWitness"
  FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER source_observation_witness_no_truncate BEFORE TRUNCATE ON public."SourceObservationWitness"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();

-- Historical verification deliberately uses immutable metadata and the
-- captured commitment. It needs neither live grants nor retained plaintext.
CREATE FUNCTION public.valid_source_observation_witness(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."SourceObservationWitness" w
    JOIN public."ProjectFactVersion" v ON v.id=w."versionId"
    JOIN public."FactEvidence" e ON e.id=w."evidenceId"
    JOIN public."FactSource" s ON s.id=w."sourceId"
    JOIN public."CanonicalStateBinding" binding ON binding.id=w."bindingId"
    JOIN public."IngestionFactStream" stream ON stream.id=w."ingestionStreamId"
    JOIN public."IngestionExternalRecord" rec
      ON (rec."customerId",rec."sourceId",rec.id)=(stream."customerId",stream."sourceId",stream."recordId")
    JOIN public."IngestionSourceRevision" rev
      ON (rev."customerId",rev."sourceId",rev."recordId",rev.id)=(rec."customerId",rec."sourceId",rec.id,w."sourceRevisionId")
    JOIN public."IngestionProposalProjection" p
      ON (p."customerId",p."sourceId",p."recordId",p."sourceRevisionId")=(rev."customerId",rev."sourceId",rev."recordId",rev.id)
      AND p.id::text=w.input->>'projectionId'
    JOIN public."IngestionRowOutcome" o
      ON (o."customerId",o."sourceId",o."recordId",o."sourceRevisionId",o."projectionId")
        =(p."customerId",p."sourceId",p."recordId",p."sourceRevisionId",p.id)
      AND o."receiptId"::text=w.input->>'receiptId' AND o.ordinal::text=w.input->>'rowOrdinal'
    JOIN public."IngestionOperationReceipt" r ON r.id=o."receiptId"
    JOIN public."AuditEvent" a ON (a."customerId",a.id)=(w."customerId",w."auditEventId")
    WHERE w."versionId"=target AND v.provenance='SYSTEM_VERIFIED' AND v."effectiveAtValidated"
      AND e."providedBy" IS NULL AND e."originalStatement" IS NULL
      AND s."ingestionStreamId"=stream.id AND stream."customerId"=w."customerId"
      AND rec."projectId"=w."projectId" AND o."projectId"=w."projectId"
      AND o.state='ACCEPTED' AND o.operation IN ('CREATE','UPDATE','UNCHANGED') AND cardinality(o."errorCodes")=0
      AND r."mappingRevision"=p."mappingRevision" AND stream."factType"=ANY(p."factTypes")
      AND binding.sealed AND ((s."sourceType"='jira' AND binding."targetKind"='WORK_ITEM' AND rec."recordType"='jira.issue'
        AND v."effectiveAt"=rev."remoteEffectiveAt" AND e."observedAt"=rev."remoteObservedAt"
        AND rev.revision=public.authority_instant(v."effectiveAt")
        AND public.valid_connector_page_dispatch(r.id) AND public.valid_ingestion_receipt(r.id))
        OR (s."sourceType"='xlsx' AND binding."targetKind"='MILESTONE' AND e."observedAt"=rev."receivedAt"
          AND public.valid_ingestion_xlsx_reviewed_import(r.id)))
      AND e."observedAt"<=w."admittedAt" AND v."effectiveAt"<=e."observedAt" AND v."validUntil">w."admittedAt"
      AND w.input @> jsonb_build_object(
        'customerId',w."customerId",'projectId',w."projectId",'sourceId',stream."sourceId",
        'streamId',stream.id,'recordId',rec.id,'sourceRevisionId',rev.id,'field',stream."factType",
        'sourceKind',CASE s."sourceType" WHEN 'jira' THEN 'jira.issue' ELSE 'xlsx.row' END,
        'configRevision',r."configRevision",'mappingRevision',p."mappingRevision",
        'receiptSha256',r."requestHash"::text,'sourceSha256',rev."sourceContentHash"::text,'projectionSha256',p."proposalHash"::text,
        'value',v.value,'effectiveAt',public.authority_instant(v."effectiveAt"),'observedAt',public.authority_instant(e."observedAt"))
      AND w.input->>'fieldSha256'=encode(sha256(convert_to(
        jsonb_build_array('pdaa.source-observation-input.v1',w.input-'fieldSha256')::text,'UTF8')),'hex')
      AND a.event='fact.source_observation.admitted' AND a."occurredAt"=w."admittedAt" AT TIME ZONE 'UTC'
      AND a.detail=jsonb_build_object('bindingId',w."bindingId",'versionId',w."versionId",
        'fieldSha256',w.input->>'fieldSha256','validUntil',public.authority_instant(v."validUntil"))
  );
$$;

-- Before a separate synthetic publication capability is installed, the
-- migration owner is the only principal allowed to write the new origin.
CREATE FUNCTION public.guard_source_observation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'Source observation writer unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fact_source_observation_writer BEFORE INSERT ON public."FactSource"
  FOR EACH ROW WHEN (NEW."ingestionStreamId" IS NOT NULL) EXECUTE FUNCTION public.guard_source_observation_insert();
CREATE TRIGGER fact_evidence_observation_writer BEFORE INSERT ON public."FactEvidence"
  FOR EACH ROW WHEN (NEW."providedBy" IS NULL) EXECUTE FUNCTION public.guard_source_observation_insert();
CREATE TRIGGER fact_version_observation_writer BEFORE INSERT ON public."ProjectFactVersion"
  FOR EACH ROW WHEN (NEW.provenance='SYSTEM_VERIFIED') EXECUTE FUNCTION public.guard_source_observation_insert();
CREATE TRIGGER source_observation_witness_writer BEFORE INSERT ON public."SourceObservationWitness"
  FOR EACH ROW EXECUTE FUNCTION public.guard_source_observation_insert();

CREATE FUNCTION public.require_source_observation_witness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_RELID='public."FactSource"'::regclass THEN
    IF NOT EXISTS (SELECT 1 FROM public."SourceObservationWitness" w WHERE w."sourceId"=NEW.id)
    THEN RAISE EXCEPTION 'Source requires a fact witness'; END IF;
  ELSIF TG_RELID='public."FactEvidence"'::regclass THEN
    IF NOT EXISTS (SELECT 1 FROM public."FactSource" s WHERE s.id=NEW."sourceId"
      AND (s."ingestionStreamId" IS NULL)=(NEW."providedBy" IS NOT NULL))
      OR (NEW."providedBy" IS NULL AND NOT EXISTS (
        SELECT 1 FROM public."SourceObservationWitness" w WHERE w."evidenceId"=NEW.id))
    THEN RAISE EXCEPTION 'Evidence origin or witness does not match'; END IF;
  ELSIF TG_RELID='public."ProjectFactVersion"'::regclass THEN
    IF NOT EXISTS (SELECT 1 FROM public."FactEvidence" e WHERE e.id=NEW."evidenceId"
      AND (e."providedBy" IS NULL)=(NEW.provenance='SYSTEM_VERIFIED'))
      OR (NEW.provenance='SYSTEM_VERIFIED' AND public.valid_source_observation_witness(NEW.id) IS NOT TRUE)
    THEN RAISE EXCEPTION 'Fact version origin or witness does not match'; END IF;
  ELSIF public.valid_source_observation_witness(NEW."versionId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Source observation witness does not match';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fact_source_observation_complete AFTER INSERT ON public."FactSource"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."ingestionStreamId" IS NOT NULL)
  EXECUTE FUNCTION public.require_source_observation_witness();
CREATE CONSTRAINT TRIGGER fact_evidence_origin_complete AFTER INSERT ON public."FactEvidence"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_source_observation_witness();
CREATE CONSTRAINT TRIGGER fact_version_origin_complete AFTER INSERT ON public."ProjectFactVersion"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_source_observation_witness();
CREATE CONSTRAINT TRIGGER source_observation_witness_complete AFTER INSERT ON public."SourceObservationWitness"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_source_observation_witness();

-- Low-level ledger append. Only the migration owner can call this primitive.
-- A scoped admission capability must supply the approved binding, mapping,
-- and policy expiry and perform authorization before using it.
CREATE FUNCTION public.append_source_observation(
  customer uuid, project uuid, binding_id uuid, ingestion_source uuid, stream uuid,
  receipt_id uuid, row_ordinal integer, snapshot_field text, state_mapping jsonb,
  valid_until timestamptz
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  binding public."CanonicalStateBinding"%ROWTYPE;
  existing public."SourceObservationWitness"%ROWTYPE;
  proof jsonb;
  source_kind text;
  source_revision uuid;
  fact_source uuid;
  fact_revision integer;
  version_id uuid := gen_random_uuid();
  evidence_id uuid := gen_random_uuid();
  audit_id uuid := gen_random_uuid();
  admitted_at timestamptz;
BEGIN
  IF valid_until IS NULL THEN RETURN NULL; END IF;
  -- Jira result writers can already hold the source lock when they touch
  -- the project. The conflicting lock request fails without waiting.
  PERFORM 1 FROM public."Project" WHERE "customerId"=customer AND id=project FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public."IngestionRetentionPolicy" WHERE "customerId"=customer FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public."IngestionSource" WHERE "customerId"=customer AND id=ingestion_source FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT b.* INTO binding FROM public."CanonicalStateBinding" b
    WHERE (b."customerId",b."projectId",b.id)=(customer,project,binding_id) AND b.sealed;
  IF NOT FOUND OR public.valid_canonical_state_binding(binding_id) IS NOT TRUE THEN RETURN NULL; END IF;

  proof := public.resolve_source_observation_input(customer,project,ingestion_source,stream,
    receipt_id,row_ordinal,snapshot_field,state_mapping);
  IF proof IS NULL THEN RETURN NULL; END IF;
  IF proof->>'sourceKind'='xlsx.row' AND binding."targetKind"='MILESTONE' THEN
    source_kind := 'xlsx';
  ELSIF proof->>'sourceKind'='jira.issue' AND binding."targetKind"='WORK_ITEM' AND EXISTS (
    SELECT 1 FROM public."RequiredWorkItem" link
      WHERE (link."customerId",link."projectId",link."workItemId")=(customer,project,binding."workItemId")
  ) THEN
    source_kind := 'jira';
  ELSE
    RETURN NULL;
  END IF;

  source_revision := (proof->>'sourceRevisionId')::uuid;
  SELECT w.* INTO existing FROM public."SourceObservationWitness" w
    WHERE (w."factId",w."ingestionStreamId",w."sourceRevisionId")=(binding."factId",stream,source_revision);
  IF FOUND THEN
    IF existing.input IS DISTINCT FROM proof OR NOT EXISTS (
      SELECT 1 FROM public."ProjectFactVersion" v WHERE v.id=existing."versionId" AND v."validUntil"=valid_until
    ) THEN RAISE EXCEPTION 'Source revision is already admitted with different commitments'; END IF;
    RETURN existing."versionId";
  END IF;

  admitted_at := date_trunc('milliseconds',clock_timestamp());
  IF valid_until<=admitted_at OR valid_until<>date_trunc('milliseconds',valid_until)
    OR valid_until>=TIMESTAMPTZ '10000-01-01 00:00:00+00'
  THEN RETURN NULL; END IF;

  SELECT f.revision INTO STRICT fact_revision FROM public."ProjectFact" f
    WHERE (f."customerId",f."projectId",f.id)=(customer,project,binding."factId") FOR UPDATE;
  SELECT s.id INTO fact_source FROM public."FactSource" s
    WHERE (s."factId",s."ingestionStreamId")=(binding."factId",stream);
  IF NOT FOUND THEN
    fact_source := gen_random_uuid();
    INSERT INTO public."FactSource" (id,"customerId","projectId","factId","sourceType","ingestionStreamId")
      VALUES (fact_source,customer,project,binding."factId",source_kind,stream);
  END IF;
  INSERT INTO public."FactEvidence" (id,"customerId","projectId","factId","sourceId","observedAt")
    VALUES (evidence_id,customer,project,binding."factId",fact_source,(proof->>'observedAt')::timestamptz);
  INSERT INTO public."ProjectFactVersion"
    (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,provenance,
      "effectiveAtValidated","effectiveAt","validUntil")
    VALUES (version_id,customer,project,binding."factId",fact_source,evidence_id,fact_revision+1,proof->'value',
      'SYSTEM_VERIFIED',true,(proof->>'effectiveAt')::timestamptz,valid_until);
  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
    VALUES (audit_id,customer,current_user,'fact.source_observation.admitted',version_id::text,
      jsonb_build_object('bindingId',binding_id,'versionId',version_id,
        'fieldSha256',proof->>'fieldSha256','validUntil',public.authority_instant(valid_until)),
      admitted_at AT TIME ZONE 'UTC');
  INSERT INTO public."SourceObservationWitness"
    ("versionId","customerId","projectId","bindingId","factId","sourceId","evidenceId",
      "ingestionStreamId","sourceRevisionId","auditEventId","admittedAt",input)
    VALUES (version_id,customer,project,binding_id,binding."factId",fact_source,evidence_id,stream,
      source_revision,audit_id,admitted_at,proof);
  RETURN version_id;
END $$;

REVOKE ALL ON TABLE public."ConnectorPageDispatch" FROM PUBLIC;
REVOKE ALL ON TABLE public."SourceObservationWitness" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
  public.record_connector_page_dispatch(uuid),public.valid_connector_page_dispatch(uuid),
  public.resolve_source_observation_input(uuid,uuid,uuid,uuid,uuid,integer,text,jsonb),
  public.valid_source_observation_witness(uuid),public.guard_source_observation_insert(),
  public.require_source_observation_witness(),
  public.append_source_observation(uuid,uuid,uuid,uuid,uuid,uuid,integer,text,jsonb,timestamptz) FROM PUBLIC;
DO $roles$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.record_connector_page_dispatch(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_connector_page_dispatch(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.resolve_source_observation_input(uuid,uuid,uuid,uuid,uuid,integer,text,jsonb) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_source_observation_witness(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.guard_source_observation_insert() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_source_observation_witness() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.append_source_observation(uuid,uuid,uuid,uuid,uuid,uuid,integer,text,jsonb,timestamptz) OWNER TO pdaa_migrate;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
        public.record_connector_page_dispatch(uuid) TO pdaa_api;
    END IF;
  END IF;
END $roles$;
