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
      FOR SHARE OF g NOWAIT;
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
    FOR SHARE NOWAIT;
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

-- A prospective approval reserves the exact fact source and authority revision.
-- Their ledger rows are created only when the first authorized observation commits.
CREATE TABLE public."SourceAdmissionBindingRevision" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "bindingId" uuid NOT NULL,
  "factId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL,
  "ingestionSourceId" uuid NOT NULL,
  "recordId" uuid NOT NULL,
  "streamId" uuid NOT NULL,
  "sourceKind" varchar(16) NOT NULL,
  "configRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  "snapshotField" varchar(96),
  "stateMapping" jsonb NOT NULL,
  "factSourceId" uuid NOT NULL,
  "reservationId" uuid NOT NULL,
  "previousPolicyRevision" integer NOT NULL CHECK ("previousPolicyRevision">=0),
  "policyRevisionId" uuid NOT NULL UNIQUE,
  definition jsonb NOT NULL,
  "approvedBy" varchar(256) NOT NULL,
  "approvedAt" timestamptz(3) NOT NULL,
  "approvalAuditId" uuid NOT NULL UNIQUE,
  "existingBindingId" uuid,
  "targetKind" varchar(16) NOT NULL,
  "targetMilestoneId" uuid,
  "targetWorkItemId" uuid,
  UNIQUE ("streamId",revision),
  CONSTRAINT "SourceAdmissionBindingRevision_exact_key" UNIQUE
    ("customerId","projectId",id,"bindingId","factId","streamId","factSourceId"),
  CONSTRAINT "SourceAdmissionBindingRevision_command_scope_key" UNIQUE ("customerId","projectId",id,"ingestionSourceId"),
  CONSTRAINT "SourceAdmissionBindingRevision_reservation_fkey" FOREIGN KEY
    ("customerId","projectId","reservationId","bindingId","factId","streamId","factSourceId")
    REFERENCES public."SourceAdmissionBindingRevision" ("customerId","projectId",id,"bindingId","factId","streamId","factSourceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","existingBindingId","factId")
    REFERENCES public."CanonicalStateBinding" ("customerId","projectId",id,"factId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","targetMilestoneId")
    REFERENCES public."Milestone" ("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","targetWorkItemId")
    REFERENCES public."WorkItem" ("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","ingestionSourceId","configRevision","projectId")
    REFERENCES public."IngestionConfigurationProject" ("customerId","sourceId","configRevision","projectId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","ingestionSourceId","projectId","recordId")
    REFERENCES public."IngestionExternalRecord" ("customerId","sourceId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","ingestionSourceId","recordId","streamId")
    REFERENCES public."IngestionFactStream" ("customerId","sourceId","recordId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","approvalAuditId") REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("existingBindingId" IS NOT NULL AND "existingBindingId"="bindingId")
    OR ("existingBindingId" IS NULL AND "previousPolicyRevision"=0
      AND "factType"='canonical.state.'||replace("bindingId"::text,'-',''))),
  CHECK (("targetKind"='MILESTONE' AND "targetMilestoneId" IS NOT NULL AND "targetWorkItemId" IS NULL)
    OR ("targetKind"='WORK_ITEM' AND "targetWorkItemId" IS NOT NULL AND "targetMilestoneId" IS NULL)),
  CHECK (("sourceKind"='jira.issue' AND "snapshotField" IS NULL)
    OR ("sourceKind"='xlsx.row' AND "snapshotField" COLLATE "C" ~ '^[a-z][a-z0-9_.-]{0,95}$'
      AND "snapshotField" IS NOT NULL))
);
CREATE UNIQUE INDEX "SourceAdmissionBindingRevision_source_reservation_key"
  ON public."SourceAdmissionBindingRevision" ("factSourceId") WHERE id="reservationId";
CREATE UNIQUE INDEX "SourceAdmissionBindingRevision_fact_stream_reservation_key"
  ON public."SourceAdmissionBindingRevision" ("factId","streamId") WHERE id="reservationId";
CREATE UNIQUE INDEX "SourceAdmissionBindingRevision_birth_binding_key"
  ON public."SourceAdmissionBindingRevision" ("bindingId") WHERE "existingBindingId" IS NULL AND id="reservationId";
CREATE UNIQUE INDEX "SourceAdmissionBindingRevision_birth_fact_key"
  ON public."SourceAdmissionBindingRevision" ("factId") WHERE "existingBindingId" IS NULL AND id="reservationId";
CREATE UNIQUE INDEX "SourceAdmissionBindingRevision_birth_target_stream_key"
  ON public."SourceAdmissionBindingRevision" ("streamId","targetKind",coalesce("targetMilestoneId","targetWorkItemId"))
  WHERE "existingBindingId" IS NULL AND id="reservationId";
CREATE TRIGGER source_admission_binding_immutable BEFORE UPDATE OR DELETE ON public."SourceAdmissionBindingRevision"
  FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER source_admission_binding_no_truncate BEFORE TRUNCATE ON public."SourceAdmissionBindingRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();

CREATE FUNCTION public.source_admission_selector(definition jsonb, kind text, fact_source uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  SELECT s.value FROM jsonb_array_elements(definition->'tiers') t
    CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s
  WHERE s.value->>'sourceType'=split_part(kind,'.',1) AND s.value->>'instanceId'=fact_source::text
    AND s.value->>'requiredApproval'='APPROVED' AND s.value->'validity'->>'basis' IN ('effectiveAt','observedAt')
$$;

CREATE FUNCTION public.valid_source_admission_binding(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."SourceAdmissionBindingRevision" a
    JOIN public."AuditEvent" event ON (event."customerId",event.id)=(a."customerId",a."approvalAuditId")
    LEFT JOIN public."CanonicalStateBinding" b ON b.id=a."existingBindingId"
    JOIN public."IngestionConfigurationRevision" config
      ON (config."customerId",config."sourceId",config.revision)=(a."customerId",a."ingestionSourceId",a."configRevision")
    JOIN public."IngestionFactStream" s ON s.id=a."streamId"
    JOIN public."IngestionExternalRecord" rec ON rec.id=a."recordId"
    JOIN public."SourceAdmissionBindingRevision" reservation ON reservation.id=a."reservationId"
    WHERE a.id=target AND reservation.id=reservation."reservationId"
      AND (a."targetKind",a."targetMilestoneId",a."targetWorkItemId")
        IS NOT DISTINCT FROM (reservation."targetKind",reservation."targetMilestoneId",reservation."targetWorkItemId")
      AND (a."existingBindingId" IS NULL OR (b.sealed AND b."factType"=a."factType" AND b."targetKind"=a."targetKind"
        AND (b."milestoneId",b."workItemId") IS NOT DISTINCT FROM (a."targetMilestoneId",a."targetWorkItemId")))
      AND config.sealed AND config."mappingRevision"=a."mappingRevision"
      AND event.event='fact.source_admission.approved' AND event.actor=a."approvedBy"
      AND event."occurredAt"=a."approvedAt" AT TIME ZONE 'UTC'
      AND event."correlationId"=a.id::text
      AND event.detail=jsonb_build_object('bindingRevisionId',a.id,'sha256',
        encode(sha256(convert_to(jsonb_build_array('pdaa.source-admission-binding.v1',
          to_jsonb(a)-'approvalAuditId'-'approvedAt',public.authority_instant(a."approvedAt"))::text,'UTF8')),'hex'))
      AND public.valid_authority_definition(a.definition)
      AND public.source_admission_selector(a.definition,a."sourceKind",a."factSourceId") IS NOT NULL
      AND ((a."sourceKind"='jira.issue' AND rec."recordType"='jira.issue'
        AND config.mapping->>'kind'='CONNECTOR' AND config.mapping->'factTypes' ? s."factType"
        AND a."targetKind"='WORK_ITEM' AND EXISTS (SELECT 1 FROM public."RequiredWorkItem" link
          WHERE (link."customerId",link."projectId",link."workItemId")=(a."customerId",a."projectId",a."targetWorkItemId")))
       OR (a."sourceKind"='xlsx.row' AND rec."recordType"='xlsx:'||(config.mapping->>'sheet')
        AND config.mapping->>'kind'='XLSX' AND a."targetKind"='MILESTONE' AND a."snapshotField"<>s."factType"
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(config.mapping->'fields') f
          WHERE f->>'factType'=a."snapshotField" AND f->>'type'='text')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(config.mapping->'fields') f
          WHERE f->>'factType'=s."factType" AND f->>'type'='text')))
  )
$$;

CREATE FUNCTION public.guard_source_admission_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE portfolio uuid;
BEGIN
  SELECT p."portfolioId" INTO portfolio FROM public."Project" p
    WHERE (p."customerId",p.id)=(NEW."customerId",NEW."projectId") FOR UPDATE NOWAIT;
  IF NOT FOUND OR NEW.revision<>(
    SELECT coalesce(max(a.revision),0)+1 FROM public."SourceAdmissionBindingRevision" a WHERE a."streamId"=NEW."streamId"
  ) THEN RAISE EXCEPTION 'Invalid source admission approval revision'; END IF;
  PERFORM g.id FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=NEW."approvedBy" AND g.role='pmo_admin'
      AND ((g."scopeType"='project' AND g."scopeId"=NEW."projectId")
        OR (g."scopeType"='portfolio' AND g."scopeId"=portfolio))
    ORDER BY g.id LIMIT 1 FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source admission requires a scoped approval'; END IF;
  PERFORM 1 FROM public."IngestionSource" src
    WHERE (src."customerId",src.id,src."currentConfigRevision",src."mappingRevision")
      =(NEW."customerId",NEW."ingestionSourceId",NEW."configRevision",NEW."mappingRevision")
      AND src."sourceType"=split_part(NEW."sourceKind",'.',1) FOR SHARE NOWAIT;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
    WHERE (reader."customerId",reader."sourceId",reader."configRevision",reader."projectId",reader.subject)
      =(NEW."customerId",NEW."ingestionSourceId",NEW."configRevision",NEW."projectId",NEW."approvedBy"))
  THEN RAISE EXCEPTION 'Source admission requires current source scope'; END IF;
  IF NEW."previousPolicyRevision"<>coalesce((SELECT p.revision FROM public."AuthorityPolicy" p
    WHERE (p."customerId",p."projectId",p."factType")=(NEW."customerId",NEW."projectId",NEW."factType")),0)
    OR EXISTS (SELECT 1 FROM public."FactSource" f WHERE
      (f.id=NEW."factSourceId" OR (f."factId",f."ingestionStreamId")=(NEW."factId",NEW."streamId"))
      AND (f.id,f."factId",f."ingestionStreamId") IS DISTINCT FROM (NEW."factSourceId",NEW."factId",NEW."streamId"))
    OR (NEW."reservationId"<>NEW.id AND NOT EXISTS (SELECT 1 FROM public."SourceAdmissionBindingRevision" a
      WHERE a.id=NEW."reservationId" AND a.id=a."reservationId"))
  THEN RAISE EXCEPTION 'Source admission policy or source identity changed'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_admission_binding_guard BEFORE INSERT ON public."SourceAdmissionBindingRevision"
  FOR EACH ROW EXECUTE FUNCTION public.guard_source_admission_binding();

CREATE FUNCTION public.require_source_admission_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF public.valid_source_admission_binding(NEW.id) IS NOT TRUE
  THEN RAISE EXCEPTION 'Source admission approval is incomplete'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_admission_binding_complete AFTER INSERT ON public."SourceAdmissionBindingRevision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_source_admission_binding();

CREATE FUNCTION public.approve_source_observation(
  customer uuid, project uuid, binding_id uuid, stream_id uuid, fact_source uuid,
  snapshot_field text, state_mapping jsonb, authority_definition jsonb, approver text, expected_policy_revision integer,
  target_kind text DEFAULT NULL, target_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  a public."SourceAdmissionBindingRevision"%ROWTYPE;
  binding public."CanonicalStateBinding"%ROWTYPE;
  reservation public."SourceAdmissionBindingRevision"%ROWTYPE;
  approval_id uuid := gen_random_uuid();
BEGIN
  -- Acquire the project fence before observing the source and next revision.
  PERFORM 1 FROM public."Project" WHERE "customerId"=customer AND id=project FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF binding_id IS NOT NULL THEN
    SELECT b.* INTO binding FROM public."CanonicalStateBinding" b
      WHERE (b."customerId",b."projectId",b.id)=(customer,project,binding_id) AND b.sealed;
    IF NOT FOUND OR target_kind IS NOT NULL OR target_id IS NOT NULL
      OR public.valid_canonical_state_binding(binding_id) IS NOT TRUE
    THEN RETURN NULL; END IF;
  ELSE
    IF target_kind IS NULL OR target_kind NOT IN ('MILESTONE','WORK_ITEM') OR target_id IS NULL
      OR expected_policy_revision IS DISTINCT FROM 0
      OR EXISTS (SELECT 1 FROM public."CanonicalStateBinding" b
        WHERE (b."customerId",b."projectId",b."targetKind")=(customer,project,target_kind)
          AND coalesce(b."milestoneId",b."workItemId")=target_id)
    THEN RETURN NULL; END IF;
    SELECT root.* INTO reservation FROM public."SourceAdmissionBindingRevision" root
      WHERE (root."customerId",root."projectId",root."streamId",root."targetKind")=(customer,project,stream_id,target_kind)
        AND root.id=root."reservationId" AND root."existingBindingId" IS NULL
        AND coalesce(root."targetMilestoneId",root."targetWorkItemId")=target_id;
    binding.id := coalesce(reservation."bindingId",gen_random_uuid());
    binding."factId" := coalesce(reservation."factId",gen_random_uuid());
    binding."factType" := 'canonical.state.'||replace(binding.id::text,'-','');
    binding."targetKind" := target_kind;
    binding."milestoneId" := CASE WHEN target_kind='MILESTONE' THEN target_id END;
    binding."workItemId" := CASE WHEN target_kind='WORK_ITEM' THEN target_id END;
  END IF;
  SELECT approval_id,customer,project,binding.id,binding."factId",binding."factType",
    s."sourceId",s."recordId",s.id,CASE src."sourceType" WHEN 'jira' THEN 'jira.issue' WHEN 'xlsx' THEN 'xlsx.row' END,
    src."currentConfigRevision",src."mappingRevision",
    (SELECT coalesce(max(history.revision),0)+1 FROM public."SourceAdmissionBindingRevision" history WHERE history."streamId"=s.id),
    snapshot_field,state_mapping,fact_source,
    coalesce((SELECT root.id FROM public."SourceAdmissionBindingRevision" root
      WHERE (root."factId",root."streamId")=(binding."factId",s.id) AND root.id=root."reservationId"),approval_id),
    expected_policy_revision,gen_random_uuid(),authority_definition,
    approver,date_trunc('milliseconds',clock_timestamp()),gen_random_uuid(),
    binding_id,binding."targetKind",binding."milestoneId",binding."workItemId"
  INTO a
  FROM public."IngestionFactStream" s
  JOIN public."IngestionExternalRecord" record
    ON (record."customerId",record."sourceId",record."projectId",record.id)
      =(customer,s."sourceId",project,s."recordId")
  JOIN public."IngestionSource" src ON (src."customerId",src.id)=(s."customerId",s."sourceId")
  WHERE s."customerId"=customer AND s.id=stream_id;
  IF NOT FOUND OR a."sourceKind" IS NULL
    OR NOT public.valid_authority_definition(authority_definition)
  THEN RETURN NULL; END IF;
  IF jsonb_typeof(state_mapping) IS DISTINCT FROM 'object' OR octet_length(state_mapping::text)>32768
  THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM jsonb_each(state_mapping)) NOT BETWEEN 1 AND 32 OR EXISTS (
    SELECT 1 FROM jsonb_each(state_mapping) item(key,value)
    WHERE length(item.key) NOT BETWEEN 1 AND 4096
      OR item.value NOT IN ('"OPEN"'::jsonb,'"IN_PROGRESS"'::jsonb,'"COMPLETE"'::jsonb,'"CANCELLED"'::jsonb)
  ) THEN RETURN NULL; END IF;
  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
    VALUES (a."approvalAuditId",customer,approver,'fact.source_admission.approved',a.id::text,
      jsonb_build_object('bindingRevisionId',a.id,'sha256',
        encode(sha256(convert_to(jsonb_build_array('pdaa.source-admission-binding.v1',
          to_jsonb(a)-'approvalAuditId'-'approvedAt',public.authority_instant(a."approvedAt"))::text,'UTF8')),'hex')),
      a."approvedAt" AT TIME ZONE 'UTC');
  INSERT INTO public."SourceAdmissionBindingRevision" SELECT a.*;
  RETURN a.id;
END $$;

CREATE FUNCTION public.source_admission_expiry(selector jsonb, effective_at timestamptz, observed_at timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp SET TimeZone='UTC' AS $$
  WITH validity AS (
    SELECT CASE selector->'validity'->>'basis'
      WHEN 'effectiveAt' THEN effective_at WHEN 'observedAt' THEN observed_at END AS starts_at,
      (selector->'validity'->>'durationMs')::numeric::bigint AS duration_ms
  )
  SELECT CASE WHEN duration_ms<extract(epoch FROM (TIMESTAMPTZ '10000-01-01 00:00:00+00'-starts_at))*1000
    THEN date_trunc('milliseconds',starts_at + (duration_ms/86400000)*INTERVAL '1 day'
      + (duration_ms%86400000)*INTERVAL '1 millisecond') END
  FROM validity
$$;

CREATE OR REPLACE FUNCTION public.valid_authority_sources(c uuid,p uuid,f varchar,d jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE selector jsonb;
BEGIN
  IF d IS NULL THEN RETURN true; END IF;
  IF NOT public.valid_authority_definition(d) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(d->'tiers') t
      CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s
    WHERE (s.value->'validity') ? 'mode'
  ) AND (
    f !~ '^raid_item\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.opened_at$'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(d->'tiers') t
        CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s
      WHERE s.value->>'sourceType' <> 'human_statement'
        OR s.value->'validity' IS DISTINCT FROM '{"mode":"UNTIL_SUPERSEDED"}'::jsonb
    )
  ) THEN RETURN false; END IF;
  FOR selector IN SELECT s.value FROM jsonb_array_elements(d->'tiers') t CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s LOOP
    IF selector->'instanceId' <> 'null'::jsonb AND NOT EXISTS (
      SELECT 1 FROM public."FactSource" s JOIN public."ProjectFact" fct ON fct.id=s."factId"
      WHERE s.id=(selector->>'instanceId')::uuid AND s."customerId"=c AND s."projectId"=p AND fct."factType"=f
        AND s."sourceType"=selector->>'sourceType'
        AND (s."sourceType"='human_statement' OR (
          s."sourceType" IN ('jira','xlsx') AND s."ingestionStreamId" IS NOT NULL AND fct."bindingBirthId" IS NOT NULL
          AND selector->>'requiredApproval'='APPROVED' AND selector->'validity'->>'basis' IN ('effectiveAt','observedAt')
        ))
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- Only the reserved, independently approved revision can introduce an exact
-- Jira or workbook selector into the canonical authority ledger.
CREATE FUNCTION public.guard_source_authority_activation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF public.valid_authority_definition(NEW.definition) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.definition->'tiers') tier
    CROSS JOIN LATERAL jsonb_array_elements(tier->'selectors') selector
    WHERE selector->>'sourceType' IN ('jira','xlsx') AND selector->'instanceId'<>'null'::jsonb
  ) THEN
    IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class
      WHERE oid='public."SourceAdmissionBindingRevision"'::regclass)
    THEN RAISE EXCEPTION 'Source authority activation unavailable'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public."SourceAdmissionBindingRevision" a
      WHERE (a."customerId",a."projectId",a."factType",a."policyRevisionId")
        =(NEW."customerId",NEW."projectId",NEW."factType",NEW.id)
        AND a."previousPolicyRevision"+1=NEW.revision AND a.definition=NEW.definition
        AND a."approvedBy"=NEW."recordedBy" AND a."approvedAt"<=NEW."recordedAt"
        AND NEW."effectiveAt"=NEW."recordedAt"
        AND public.valid_source_admission_binding(a.id)
    ) THEN RAISE EXCEPTION 'Source authority lacks the exact approved activation'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_authority_activation_guard BEFORE INSERT ON public."AuthorityPolicyRevision"
  FOR EACH ROW EXECUTE FUNCTION public.guard_source_authority_activation();

CREATE TABLE public."SourceObservationWitness" (
  "versionId" uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "bindingId" uuid NOT NULL,
  "admissionRevisionId" uuid NOT NULL,
  "factId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "evidenceId" uuid NOT NULL UNIQUE,
  "ingestionStreamId" uuid NOT NULL,
  "sourceRevisionId" uuid NOT NULL,
  "auditEventId" uuid NOT NULL UNIQUE,
  "rootCommandId" uuid NOT NULL UNIQUE,
  "admittedAt" timestamptz(3) NOT NULL,
  "admittedBy" varchar(256) NOT NULL CHECK (public.nonblank_fact_text("admittedBy")),
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=8192),
  CONSTRAINT "SourceObservationWitness_revision_key" UNIQUE ("factId","ingestionStreamId","sourceRevisionId"),
  CONSTRAINT "SourceObservationWitness_command_scope_key" UNIQUE ("customerId","projectId","admissionRevisionId","versionId"),
  CONSTRAINT "SourceObservationWitness_admission_fkey" FOREIGN KEY
    ("customerId","projectId","admissionRevisionId","bindingId","factId","ingestionStreamId","sourceId")
    REFERENCES public."SourceAdmissionBindingRevision" ("customerId","projectId",id,"bindingId","factId","streamId","factSourceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SourceObservationWitness_binding_fkey" FOREIGN KEY ("customerId","projectId","bindingId","factId")
    REFERENCES public."CanonicalStateBinding" ("customerId","projectId",id,"factId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SourceObservationWitness_version_fkey" FOREIGN KEY ("customerId","projectId","factId","versionId","sourceId","evidenceId")
    REFERENCES public."ProjectFactVersion" ("customerId","projectId","factId",id,"sourceId","evidenceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "SourceObservationWitness_audit_fkey" FOREIGN KEY ("customerId","auditEventId")
    REFERENCES public."AuditEvent" ("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "SourceObservationWitness_source_idx" ON public."SourceObservationWitness" ("sourceId");
CREATE INDEX "SourceObservationWitness_admission_idx" ON public."SourceObservationWitness" ("admissionRevisionId");
CREATE TRIGGER source_observation_witness_immutable BEFORE UPDATE OR DELETE ON public."SourceObservationWitness"
  FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER source_observation_witness_no_truncate BEFORE TRUNCATE ON public."SourceObservationWitness"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();

CREATE TABLE public."SourceAdmissionCommand" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "ingestionSourceId" uuid NOT NULL,
  "admissionRevisionId" uuid NOT NULL,
  "versionId" uuid NOT NULL,
  "inputReceiptId" uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  "commandKey" varchar(128) NOT NULL CHECK ("commandKey" COLLATE "C" ~ '^[A-Za-z0-9_-]{1,128}$'),
  "correlationId" uuid NOT NULL,
  CONSTRAINT "SourceAdmissionCommand_source_key" UNIQUE ("customerId","projectId","ingestionSourceId","commandKey"),
  FOREIGN KEY ("customerId","projectId","admissionRevisionId","ingestionSourceId")
    REFERENCES public."SourceAdmissionBindingRevision" ("customerId","projectId",id,"ingestionSourceId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("customerId","projectId","admissionRevisionId","versionId")
    REFERENCES public."SourceObservationWitness" ("customerId","projectId","admissionRevisionId","versionId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("inputReceiptId",ordinal) REFERENCES public."IngestionRowOutcome" ("receiptId",ordinal)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
ALTER TABLE public."SourceObservationWitness" ADD CONSTRAINT "SourceObservationWitness_root_command_fkey"
  FOREIGN KEY ("rootCommandId") REFERENCES public."SourceAdmissionCommand"(id)
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
-- Only the source birth variant points to its admission command. The human
-- binding receipt and all existing human identifiers keep their original shape.
ALTER TABLE public."CanonicalStateBinding" ADD COLUMN "sourceBirthCommandId" uuid;
ALTER TABLE public."CanonicalStateBinding" ADD CONSTRAINT "CanonicalStateBinding_source_birth_key" UNIQUE ("sourceBirthCommandId");
ALTER TABLE public."CanonicalStateBinding" ADD CONSTRAINT "CanonicalStateBinding_source_birth_fkey"
  FOREIGN KEY ("sourceBirthCommandId") REFERENCES public."SourceAdmissionCommand"(id)
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TRIGGER source_admission_command_immutable BEFORE UPDATE OR DELETE ON public."SourceAdmissionCommand"
  FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER source_admission_command_no_truncate BEFORE TRUNCATE ON public."SourceAdmissionCommand"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();

-- The outcome reference and lineage remain verifiable after content redaction.
CREATE FUNCTION public.source_admission_outcome(
  approved public."SourceAdmissionBindingRevision", receipt_id uuid, row_ordinal integer
) RETURNS TABLE ("sourceRevisionId" uuid,"projectionId" uuid)
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT o."sourceRevisionId",o."projectionId"
  FROM public."IngestionOperationReceipt" r
  JOIN public."IngestionRowOutcome" o
    ON (o."customerId",o."sourceId",o."receiptId")=(r."customerId",r."sourceId",r.id)
  JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
  JOIN public."IngestionFactStream" s ON s.id=(approved)."streamId"
  WHERE r.id=receipt_id AND r."customerId"=(approved)."customerId" AND r."sourceId"=(approved)."ingestionSourceId"
    AND (r."configRevision",r."mappingRevision")=((approved)."configRevision",(approved)."mappingRevision")
    AND o."projectId"=(approved)."projectId" AND o."recordId"=(approved)."recordId" AND o.ordinal=row_ordinal
    AND o.state='ACCEPTED' AND o.operation IN ('CREATE','UPDATE','UNCHANGED') AND cardinality(o."errorCodes")=0
    AND p."mappingRevision"=r."mappingRevision" AND s."factType"=ANY(p."factTypes")
    AND CASE (approved)."sourceKind"
      WHEN 'jira.issue' THEN public.valid_ingestion_receipt(r.id) AND public.valid_connector_page_dispatch(r.id)
      WHEN 'xlsx.row' THEN public.valid_ingestion_xlsx_reviewed_import(r.id)
      ELSE false END
$$;

-- Historical verification deliberately uses immutable metadata and the
-- captured commitment. It needs neither live grants nor retained plaintext.
-- Start with the one witness selected by its version key, then follow its
-- indexed references. Limit join reordering here to bound planning work
-- when seal and commit checks revisit this proof.
CREATE FUNCTION public.valid_source_observation_structure(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp SET join_collapse_limit=1 AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."SourceObservationWitness" w
    JOIN public."ProjectFactVersion" v ON v.id=w."versionId"
    JOIN public."FactEvidence" e ON e.id=w."evidenceId"
    JOIN public."FactSource" s ON s.id=w."sourceId"
    JOIN public."CanonicalStateBinding" binding ON binding.id=w."bindingId"
    JOIN public."SourceAdmissionBindingRevision" approved ON approved.id=w."admissionRevisionId"
    JOIN public."SourceAdmissionCommand" command ON command.id=w."rootCommandId"
      AND (command."customerId",command."projectId",command."admissionRevisionId",command."versionId")
        =(w."customerId",w."projectId",w."admissionRevisionId",w."versionId")
      AND command."ingestionSourceId"=approved."ingestionSourceId"
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
      AND public.valid_source_admission_binding(approved.id) AND approved."approvedAt"<=w."admittedAt"
      AND (r."configRevision",r."mappingRevision")=(approved."configRevision",approved."mappingRevision")
      AND (w.input->>'snapshotField') IS NOT DISTINCT FROM approved."snapshotField"
      AND v."validUntil"=public.source_admission_expiry(
        public.source_admission_selector(approved.definition,approved."sourceKind",approved."factSourceId"),
        v."effectiveAt",e."observedAt")
      AND binding."factType"=approved."factType" AND binding."targetKind"=approved."targetKind"
      AND (binding."milestoneId",binding."workItemId")
        IS NOT DISTINCT FROM (approved."targetMilestoneId",approved."targetWorkItemId")
      AND (approved."existingBindingId"=binding.id
        OR (approved."existingBindingId" IS NULL AND binding."sourceBirthCommandId" IS NOT NULL))
      AND (v.revision>1 OR (approved."existingBindingId" IS NULL AND binding."sourceBirthCommandId"=command.id))
      AND ((s."sourceType"='jira' AND binding."targetKind"='WORK_ITEM' AND rec."recordType"='jira.issue'
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
      AND (command."inputReceiptId",command.ordinal)=(r.id,o.ordinal)
      AND a.actor=w."admittedBy" AND w."admittedBy"='synthetic:source-admission'
      AND a."correlationId"=command."correlationId"::text
      AND a.detail=jsonb_build_object('bindingId',w."bindingId",'bindingRevisionId',approved.id,'versionId',w."versionId",
        'admissionReceiptId',command.id,
        'fieldSha256',w.input->>'fieldSha256','validUntil',public.authority_instant(v."validUntil"))
  );
$$;

-- The structural witness can seal a source-born binding before its first
-- authority row exists. The full witness is mandatory at transaction commit.
CREATE FUNCTION public.valid_source_observation_witness(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."SourceObservationWitness" w
    JOIN public."SourceAdmissionBindingRevision" a ON a.id=w."admissionRevisionId"
    JOIN public."CanonicalStateBinding" b ON b.id=w."bindingId"
    JOIN public."AuthorityPolicyRevision" p
      ON (p."customerId",p."projectId",p."factType",p.id)=(a."customerId",a."projectId",a."factType",a."policyRevisionId")
    WHERE w."versionId"=target AND b.sealed
      AND p.definition=a.definition AND p.state='ENABLED'
      AND p.revision=a."previousPolicyRevision"+1 AND p."effectiveAt"=p."recordedAt"
      AND p."recordedBy"=a."approvedBy" AND p."recordedAt"<=w."admittedAt"
      AND (b."sourceBirthCommandId" IS DISTINCT FROM w."rootCommandId" OR p."recordedAt"=w."admittedAt")
      AND public.valid_source_observation_structure(target)
  )
$$;

CREATE FUNCTION public.valid_source_canonical_birth(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."CanonicalStateBinding" b
    JOIN public."ProjectFact" f ON (f."customerId",f."projectId",f.id,f."factType",f."bindingBirthId")
      =(b."customerId",b."projectId",b."factId",b."factType",b.id)
    JOIN public."SourceAdmissionCommand" cmd ON cmd.id=b."sourceBirthCommandId"
    JOIN public."SourceObservationWitness" w ON w."versionId"=cmd."versionId"
    JOIN public."SourceAdmissionBindingRevision" a ON a.id=w."admissionRevisionId"
    JOIN public."ProjectFactVersion" v ON v.id=w."versionId"
    WHERE b.id=target AND a."existingBindingId" IS NULL
      AND (w."customerId",w."projectId",w."bindingId",w."factId",w."rootCommandId")
        =(b."customerId",b."projectId",b.id,b."factId",cmd.id)
      AND b."createdBy"=w."admittedBy" AND b."createdAt"=w."admittedAt" AND f."createdAt"=w."admittedAt"
      AND v.revision=1 AND f.revision>=1
      AND NOT EXISTS (SELECT 1 FROM public."CanonicalStateBindingReceipt" h WHERE h."bindingId"=b.id)
      AND public.valid_source_observation_structure(w."versionId")
  )
$$;

CREATE OR REPLACE FUNCTION public.valid_canonical_state_binding(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b public."CanonicalStateBinding"%ROWTYPE; r public."CanonicalStateBindingReceipt"%ROWTYPE;
BEGIN
  SELECT * INTO b FROM public."CanonicalStateBinding" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  IF b."sourceBirthCommandId" IS NOT NULL THEN RETURN public.valid_source_canonical_birth(b.id); END IF;
  SELECT * INTO r FROM public."CanonicalStateBindingReceipt" WHERE "bindingId"=target;
  IF NOT FOUND OR r."factId"<>b."factId" OR r.subject<>b."createdBy" OR r."initialSourceAccessRevision"<>2 OR r."initialSourceAccessState"<>'AVAILABLE' OR r."initialReaderSubject"<>r.subject THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ProjectFact" f WHERE f.id=b."factId" AND f."customerId"=b."customerId" AND f."projectId"=b."projectId" AND f."factType"=b."factType" AND f."bindingBirthId"=b.id AND f.revision>=1) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."ProjectFactVersion" v WHERE v."factId"=b."factId" AND v.value NOT IN (
    '{"type":"text","value":"OPEN"}'::jsonb,'{"type":"text","value":"IN_PROGRESS"}'::jsonb,
    '{"type":"text","value":"COMPLETE"}'::jsonb,'{"type":"text","value":"CANCELLED"}'::jsonb)) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" v JOIN public."FactEvidence" e ON e.id=v."evidenceId" JOIN public."FactSource" s ON s.id=v."sourceId" WHERE v.id=r."versionId" AND v."factId"=b."factId" AND v.revision=1 AND v.provenance='HUMAN_CONFIRMED' AND v."evidenceId"=r."evidenceId" AND v."sourceId"=r."sourceId" AND e."providedBy"=b."createdBy" AND s."providedBy"=b."createdBy") THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."FactSourceAccess" a WHERE a."sourceId"=r."sourceId" AND a.revision>=2) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=b."customerId" AND a.actor=b."createdBy" AND a.event='fact.binding.created' AND a.detail @> jsonb_build_object('projectId',b."projectId",'bindingId',b.id,'factId',b."factId",'versionId',r."versionId",'evidenceId',r."evidenceId")) THEN RETURN false; END IF;
  RETURN (b."targetKind"='MILESTONE' AND EXISTS (SELECT 1 FROM public."Milestone" m WHERE m.id=b."milestoneId" AND m."customerId"=b."customerId" AND m."projectId"=b."projectId"))
    OR (b."targetKind"='WORK_ITEM' AND EXISTS (SELECT 1 FROM public."WorkItem" w WHERE w.id=b."workItemId" AND w."customerId"=b."customerId" AND w."projectId"=b."projectId"));
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.require_canonical_state_binding_sealed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CanonicalStateBinding" WHERE id=NEW.id AND sealed) OR NOT public.valid_canonical_state_binding(NEW.id) THEN RAISE EXCEPTION 'Unsealed state binding cannot commit'; END IF;
  IF NEW."sourceBirthCommandId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."SourceAdmissionCommand" cmd
    WHERE cmd.id=NEW."sourceBirthCommandId" AND public.valid_source_observation_witness(cmd."versionId")
  ) THEN RAISE EXCEPTION 'Source-born state binding requires its published authority'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION public.valid_source_admission_command(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."SourceAdmissionCommand" c
    JOIN public."SourceObservationWitness" w ON w."versionId"=c."versionId"
    JOIN public."SourceAdmissionBindingRevision" a
      ON (a."customerId",a."projectId",a.id,a."ingestionSourceId")
        =(c."customerId",c."projectId",c."admissionRevisionId",c."ingestionSourceId")
    CROSS JOIN LATERAL public.source_admission_outcome(a,c."inputReceiptId",c.ordinal) outcome
    WHERE c.id=target AND outcome."sourceRevisionId"=w."sourceRevisionId"
      AND outcome."projectionId"::text=w.input->>'projectionId'
      AND public.valid_source_observation_witness(w."versionId")
  )
$$;

CREATE FUNCTION public.require_source_admission_command() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF public.valid_source_admission_command(NEW.id) IS NOT TRUE
  THEN RAISE EXCEPTION 'Source admission command lacks its matching witness'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_admission_command_complete AFTER INSERT ON public."SourceAdmissionCommand"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_source_admission_command();

-- Before a separate synthetic publication capability is installed, the
-- migration owner is the only principal allowed to write the new origin.
CREATE FUNCTION public.guard_source_observation_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF current_user<>(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  THEN RAISE EXCEPTION 'Source observation writer unavailable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER canonical_source_birth_writer BEFORE INSERT ON public."CanonicalStateBinding"
  FOR EACH ROW WHEN (NEW."sourceBirthCommandId" IS NOT NULL) EXECUTE FUNCTION public.guard_source_observation_insert();
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

CREATE FUNCTION public.valid_source_authority_publication(target uuid) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."AuthorityPolicyRevision" p WHERE p.id=target AND (
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.definition->'tiers') tier
        CROSS JOIN LATERAL jsonb_array_elements(tier->'selectors') selector
        WHERE selector->>'sourceType' IN ('jira','xlsx') AND selector->'instanceId'<>'null'::jsonb
      ) OR EXISTS (
        SELECT 1 FROM public."SourceAdmissionBindingRevision" a
        JOIN public."SourceObservationWitness" w ON w."admissionRevisionId"=a.id
        WHERE a."policyRevisionId"=p.id AND public.valid_source_observation_witness(w."versionId")
      )
    )
  )
$$;

CREATE FUNCTION public.require_source_authority_witness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF public.valid_authority_definition(NEW.definition) AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.definition->'tiers') tier
    CROSS JOIN LATERAL jsonb_array_elements(tier->'selectors') selector
    WHERE selector->>'sourceType' IN ('jira','xlsx') AND selector->'instanceId'<>'null'::jsonb
  ) THEN
    IF public.valid_source_authority_publication(NEW.id) IS NOT TRUE
    THEN RAISE EXCEPTION 'Source authority cannot activate without an admitted observation'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_authority_witness_complete AFTER INSERT ON public."AuthorityPolicyRevision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_source_authority_witness();

-- The deferred authority check runs after the admission definer returns.
-- Keep the acceptance principal unable to read the underlying ledger.
ALTER FUNCTION public.require_authority_published() SECURITY DEFINER;
ALTER FUNCTION public.require_authority_published() SET search_path=pg_catalog,pg_temp;
REVOKE ALL ON FUNCTION public.require_authority_published() FROM PUBLIC;

-- This capability is executable only in the isolated acceptance database.
-- Role membership alone cannot change the authenticated database principal.
CREATE FUNCTION public.admit_source_observation(
  customer uuid, project uuid, approval_id uuid, receipt_id uuid, row_ordinal integer,
  command_key text, correlation uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  denied CONSTANT jsonb := '{"status":"DENIED"}';
  conflict CONSTANT jsonb := '{"status":"CONFLICT"}';
  actor CONSTANT text := 'synthetic:source-admission';
  approved public."SourceAdmissionBindingRevision"%ROWTYPE;
  existing public."SourceObservationWitness"%ROWTYPE;
  binding public."CanonicalStateBinding"%ROWTYPE;
  source_birth boolean;
  command public."SourceAdmissionCommand"%ROWTYPE;
  policy public."AuthorityPolicy"%ROWTYPE;
  source_row public."IngestionSource"%ROWTYPE;
  outcome record;
  live_grant uuid;
  proof jsonb;
  fact_revision integer;
  effective_at timestamptz;
  observed_at timestamptz;
  valid_until timestamptz;
  version_id uuid := gen_random_uuid();
  evidence_id uuid := gen_random_uuid();
  audit_id uuid := gen_random_uuid();
  command_id uuid := gen_random_uuid();
  admitted_at timestamptz;
  authorized_subjects integer;
BEGIN
  IF session_user<>'pdaa_source_acceptance' OR customer IS NULL OR project IS NULL OR approval_id IS NULL
    OR receipt_id IS NULL OR row_ordinal IS NULL OR row_ordinal NOT BETWEEN 1 AND 1000 OR correlation IS NULL
    OR command_key IS NULL OR command_key COLLATE "C" !~ '^[A-Za-z0-9_-]{1,128}$'
  THEN RETURN denied; END IF;
  SELECT a.* INTO approved FROM public."SourceAdmissionBindingRevision" a
    WHERE (a."customerId",a."projectId",a.id)=(customer,project,approval_id);
  IF NOT FOUND THEN RETURN denied; END IF;

  -- The project fence serializes approval, authority, commands and versions.
  -- NOWAIT also avoids waiting behind writers whose triggers lock the project.
  PERFORM 1 FROM public."Project" p WHERE (p."customerId",p.id)=(customer,project) FOR UPDATE NOWAIT;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public."SourceAdmissionBindingRevision" a
    WHERE a."streamId"=approved."streamId" AND a.revision>approved.revision)
    OR public.valid_source_admission_binding(approval_id) IS NOT TRUE
  THEN RETURN denied; END IF;
  SELECT count(DISTINCT g.subject)::integer INTO authorized_subjects FROM (
    SELECT g.subject FROM public."AccessGrant" g JOIN public."Project" p ON (p."customerId",p.id)=(customer,project)
    WHERE g."customerId"=customer AND (
      (g.subject=actor AND g.role='project_manager' AND g."scopeType"='project' AND g."scopeId"=project)
      OR (g.subject=approved."approvedBy" AND g.role='pmo_admin'
        AND ((g."scopeType"='project' AND g."scopeId"=project)
          OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))))
    ORDER BY g.id FOR SHARE OF g NOWAIT
  ) g;
  IF authorized_subjects<>2 THEN RETURN denied; END IF;
  PERFORM 1 FROM public."IngestionRetentionPolicy" p WHERE p."customerId"=customer FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN denied; END IF;
  SELECT src.* INTO source_row FROM public."IngestionSource" src WHERE
    (src."customerId",src.id,src."currentConfigRevision",src."mappingRevision")
      =(customer,approved."ingestionSourceId",approved."configRevision",approved."mappingRevision")
    FOR SHARE NOWAIT;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public."IngestionConfigurationReader" reader
    WHERE (reader."customerId",reader."sourceId",reader."configRevision",reader."projectId",reader.subject)
      =(customer,approved."ingestionSourceId",approved."configRevision",project,actor)
  ) THEN RETURN denied; END IF;

  IF approved."sourceKind"='jira.issue' THEN
    SELECT g.id INTO live_grant FROM public."ConnectorSyncGrant" g
      WHERE (g."customerId",g."projectId",g."sourceId",g."configRevision")
        =(customer,project,approved."ingestionSourceId",approved."configRevision") AND g.active
      FOR SHARE NOWAIT;
    IF NOT FOUND THEN RETURN denied; END IF;
  END IF;
  SELECT p.* INTO policy FROM public."AuthorityPolicy" p
    WHERE (p."customerId",p."projectId",p."factType")=(customer,project,approved."factType") FOR UPDATE;
  IF coalesce(policy.revision,0)<>approved."previousPolicyRevision" AND NOT EXISTS (
    SELECT 1 FROM public."AuthorityPolicyRevision" event WHERE event.id=approved."policyRevisionId"
      AND event."policyId"=policy.id AND event.revision=policy.revision AND event.state='ENABLED'
      AND event."effectiveAt"<=clock_timestamp()
  ) THEN RETURN denied; END IF;

  -- A prospective approval reserves identities, but does not occupy the target.
  -- The project lock and the canonical target key arbitrate the actual birth.
  SELECT b.* INTO binding FROM public."CanonicalStateBinding" b
    WHERE (b."customerId",b."projectId",b."targetKind")=(customer,project,approved."targetKind")
      AND (b."milestoneId",b."workItemId")
        IS NOT DISTINCT FROM (approved."targetMilestoneId",approved."targetWorkItemId");
  source_birth := NOT FOUND;
  IF source_birth THEN
    IF approved."existingBindingId" IS NOT NULL OR policy.id IS NOT NULL THEN RETURN denied; END IF;
  ELSIF binding.id<>approved."bindingId" THEN
    RETURN conflict;
  ELSIF NOT binding.sealed OR public.valid_canonical_state_binding(binding.id) IS NOT TRUE THEN
    RETURN denied;
  END IF;

  SELECT c.* INTO command FROM public."SourceAdmissionCommand" c
    WHERE (c."customerId",c."projectId",c."ingestionSourceId",c."commandKey")
      =(customer,project,approved."ingestionSourceId",command_key);
  IF FOUND AND (command."admissionRevisionId",command."inputReceiptId",command.ordinal)
    IS DISTINCT FROM (approval_id,receipt_id,row_ordinal)
  THEN RETURN conflict; END IF;
  SELECT * INTO outcome FROM public.source_admission_outcome(approved,receipt_id,row_ordinal);
  IF NOT FOUND OR (approved."sourceKind"='jira.issue' AND NOT EXISTS (
    SELECT 1 FROM public."IngestionOperationReceipt" r
    JOIN public."IngestionSyncReceiptProjectScope" scope
      ON (scope."customerId",scope."sourceId",scope."receiptId")=(r."customerId",r."sourceId",r.id)
    WHERE r.id=receipt_id AND r."generationAfter"=source_row."syncGeneration"
      AND scope."projectId"=project AND scope."syncGrantId"=live_grant
  )) THEN RETURN denied; END IF;

  -- Replay depends on the immutable outcome and witness. It never retrieves
  -- retained proposal content or computes a new observation or expiry time.
  SELECT w.* INTO existing FROM public."SourceObservationWitness" w
    WHERE (w."factId",w."ingestionStreamId",w."sourceRevisionId")
      =(approved."factId",approved."streamId",outcome."sourceRevisionId");
  IF FOUND THEN
    IF existing."admissionRevisionId"<>approval_id OR outcome."projectionId"::text<>existing.input->>'projectionId'
    THEN RETURN conflict; END IF;
    IF public.valid_source_observation_witness(existing."versionId") IS NOT TRUE THEN RETURN denied; END IF;
    IF command.id IS NULL THEN
      INSERT INTO public."SourceAdmissionCommand"
        (id,"customerId","projectId","ingestionSourceId","admissionRevisionId","versionId","inputReceiptId",ordinal,"commandKey","correlationId")
        VALUES (command_id,customer,project,approved."ingestionSourceId",approval_id,
          existing."versionId",receipt_id,row_ordinal,command_key,correlation);
    ELSIF command."versionId"<>existing."versionId" THEN
      RETURN denied;
    END IF;
    RETURN jsonb_build_object('status','REPLAYED','receiptId',existing."rootCommandId");
  END IF;
  IF command.id IS NOT NULL THEN RETURN denied; END IF;

  proof := public.resolve_source_observation_input(customer,project,
    approved."ingestionSourceId",approved."streamId",receipt_id,row_ordinal,approved."snapshotField",approved."stateMapping");
  IF proof IS NULL OR proof->>'sourceKind'<>approved."sourceKind"
    OR proof->>'projectionId'<>outcome."projectionId"::text OR proof->>'sourceRevisionId'<>outcome."sourceRevisionId"::text
  THEN RETURN denied; END IF;
  effective_at := (proof->>'effectiveAt')::timestamptz;
  observed_at := (proof->>'observedAt')::timestamptz;
  valid_until := public.source_admission_expiry(
    public.source_admission_selector(approved.definition,approved."sourceKind",approved."factSourceId"),
    effective_at,observed_at);
  admitted_at := date_trunc('milliseconds',clock_timestamp());
  IF valid_until IS NULL OR valid_until<=admitted_at THEN RETURN denied; END IF;

  IF source_birth THEN
    INSERT INTO public."ProjectFact" (id,"customerId","projectId","factType","bindingBirthId","createdAt")
      VALUES (approved."factId",customer,project,approved."factType",approved."bindingId",admitted_at);
    INSERT INTO public."CanonicalStateBinding"
      (id,"customerId","projectId","targetKind","milestoneId","workItemId","factId","factType",
        "createdBy","createdAt","sourceBirthCommandId")
      VALUES (approved."bindingId",customer,project,approved."targetKind",approved."targetMilestoneId",
        approved."targetWorkItemId",approved."factId",approved."factType",actor,admitted_at,command_id);
  END IF;

  SELECT f.revision INTO STRICT fact_revision FROM public."ProjectFact" f
    WHERE (f."customerId",f."projectId",f.id)=(approved."customerId",approved."projectId",approved."factId") FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public."FactSource" s WHERE s.id=approved."factSourceId") THEN
    INSERT INTO public."FactSource" (id,"customerId","projectId","factId","sourceType","ingestionStreamId")
      VALUES (approved."factSourceId",approved."customerId",approved."projectId",approved."factId",
        split_part(approved."sourceKind",'.',1),approved."streamId");
    -- Admission conveys no readership. A scoped administrator grants readers
    -- through the independent fact-source access operation.
    INSERT INTO public."FactSourceAccess" ("sourceId","customerId","projectId","factId",state)
      VALUES (approved."factSourceId",customer,project,approved."factId",'AVAILABLE');
  END IF;
  INSERT INTO public."FactEvidence" (id,"customerId","projectId","factId","sourceId","observedAt")
    VALUES (evidence_id,approved."customerId",approved."projectId",approved."factId",approved."factSourceId",observed_at);
  INSERT INTO public."ProjectFactVersion"
    (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,provenance,
      "effectiveAtValidated","effectiveAt","validUntil")
    VALUES (version_id,approved."customerId",approved."projectId",approved."factId",approved."factSourceId",
      evidence_id,fact_revision+1,proof->'value','SYSTEM_VERIFIED',true,effective_at,valid_until);
  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
    VALUES (audit_id,customer,actor,'fact.source_observation.admitted',correlation::text,
      jsonb_build_object('bindingId',approved."bindingId",'bindingRevisionId',approval_id,'versionId',version_id,
        'admissionReceiptId',command_id,'fieldSha256',proof->>'fieldSha256','validUntil',public.authority_instant(valid_until)),
      admitted_at AT TIME ZONE 'UTC');
  INSERT INTO public."SourceObservationWitness"
    ("versionId","customerId","projectId","bindingId","admissionRevisionId","factId","sourceId","evidenceId",
      "ingestionStreamId","sourceRevisionId","auditEventId","rootCommandId","admittedAt","admittedBy",input)
    VALUES (version_id,customer,project,approved."bindingId",approval_id,approved."factId",
      approved."factSourceId",evidence_id,approved."streamId",outcome."sourceRevisionId",audit_id,command_id,admitted_at,actor,proof);
  INSERT INTO public."SourceAdmissionCommand"
    (id,"customerId","projectId","ingestionSourceId","admissionRevisionId","versionId","inputReceiptId",ordinal,"commandKey","correlationId")
    VALUES (command_id,customer,project,approved."ingestionSourceId",approval_id,
      version_id,receipt_id,row_ordinal,command_key,correlation);
  IF source_birth THEN
    UPDATE public."CanonicalStateBinding" SET sealed=true
      WHERE ("customerId","projectId",id)=(customer,project,approved."bindingId");
  END IF;
  IF policy.id IS NULL THEN
    INSERT INTO public."AuthorityPolicy" (id,"customerId","projectId","factType")
      VALUES (gen_random_uuid(),approved."customerId",approved."projectId",approved."factType") RETURNING * INTO policy;
  END IF;
  IF policy.revision=approved."previousPolicyRevision" THEN
    INSERT INTO public."AuthorityPolicyRevision"
      (id,"customerId","projectId","factType","policyId",revision,"recordedAt","recordedBy","effectiveAt",state,definition)
      VALUES (approved."policyRevisionId",approved."customerId",approved."projectId",approved."factType",policy.id,
        policy.revision+1,admitted_at,approved."approvedBy",admitted_at,'ENABLED',approved.definition);
  END IF;

  RETURN jsonb_build_object('status','ADMITTED','receiptId',command_id);
END $$;

-- Historical origin is immutable. Delivery also intersects the independent
-- fact ACL with the currently authorized ingestion binding and source scope.
CREATE FUNCTION public.source_observation_read_allowed(version_id uuid, reader text, access_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."SourceObservationWitness" w
    JOIN public."FactSourceAccess" fa
      ON (fa."customerId",fa."projectId",fa."factId",fa."sourceId")=(w."customerId",w."projectId",w."factId",w."sourceId")
    JOIN public."FactSourceReader" fr
      ON (fr."customerId",fr."projectId",fr."factId",fr."sourceId")=(fa."customerId",fa."projectId",fa."factId",fa."sourceId")
    JOIN LATERAL (
      SELECT a.* FROM public."SourceAdmissionBindingRevision" a
      WHERE a."streamId"=w."ingestionStreamId" ORDER BY a.revision DESC LIMIT 1
    ) current_binding ON (current_binding."customerId",current_binding."projectId",current_binding."bindingId",
      current_binding."factId",current_binding."factSourceId")=(w."customerId",w."projectId",w."bindingId",w."factId",w."sourceId")
    JOIN public."IngestionSource" src ON (src."customerId",src.id,src."currentConfigRevision",src."mappingRevision")
      =(w."customerId",current_binding."ingestionSourceId",current_binding."configRevision",current_binding."mappingRevision")
    JOIN public."IngestionConfigurationReader" ir
      ON (ir."customerId",ir."projectId",ir."sourceId",ir."configRevision",ir.subject)
        =(w."customerId",w."projectId",src.id,src."currentConfigRevision",reader)
    JOIN public."AuthorityPolicy" policy ON (policy."customerId",policy."projectId",policy."factType")
      =(w."customerId",w."projectId",current_binding."factType")
    JOIN LATERAL (
      SELECT e.id,e.state FROM public."AuthorityPolicyRevision" e
      WHERE e."policyId"=policy.id AND e.revision<=policy.revision
        AND e."recordedAt"<=access_at AND e."effectiveAt"<=access_at
      ORDER BY e.revision DESC LIMIT 1
    ) active ON active.id=current_binding."policyRevisionId" AND active.state='ENABLED'
    WHERE w."versionId"=version_id AND fa.state='AVAILABLE' AND fr.subject=reader
      AND public.valid_source_admission_binding(current_binding.id)
      AND (current_binding."sourceKind"='xlsx.row' OR EXISTS (
        SELECT 1 FROM public."ConnectorSyncGrant" g
        WHERE (g."customerId",g."projectId",g."sourceId",g."configRevision")
          =(w."customerId",w."projectId",src.id,src."currentConfigRevision") AND g.active))
  )
$$;

CREATE FUNCTION public.read_source_authority_origins(
  customer uuid, project uuid, reader text, actor_roles text[], version_ids uuid[]
) RETURNS TABLE ("versionId" uuid,"sourceKind" text,"streamId" uuid,"sourceRevisionId" uuid,
  "admittedAt" timestamptz,authorized boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  portfolio uuid;
  access_at timestamptz;
BEGIN
  IF reader IS NULL OR length(reader) NOT BETWEEN 1 AND 256 OR cardinality(actor_roles) IS NULL
    OR cardinality(actor_roles) NOT BETWEEN 1 AND 8 OR cardinality(version_ids) IS NULL
    OR cardinality(version_ids) NOT BETWEEN 1 AND 1000 THEN RETURN; END IF;
  SELECT p."portfolioId" INTO portfolio FROM public."Project" p
    WHERE (p."customerId",p.id)=(customer,project) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM g.id FROM public."AccessGrant" g
    WHERE g."customerId"=customer AND g.subject=reader AND g.role=ANY(actor_roles)
      AND g.role IN ('leadership','project_manager','portfolio_manager','pmo_admin')
      AND ((g."scopeType"='project' AND g."scopeId"=project) OR (g."scopeType"='portfolio' AND g."scopeId"=portfolio))
    ORDER BY g.id FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM src.id FROM public."IngestionSource" src
    WHERE src."customerId"=customer AND EXISTS (
      SELECT 1 FROM public."SourceObservationWitness" w JOIN public."SourceAdmissionBindingRevision" a ON a.id=w."admissionRevisionId"
      WHERE (w."customerId",w."projectId")=(customer,project) AND w."versionId"=ANY(version_ids) AND a."ingestionSourceId"=src.id)
    ORDER BY src.id FOR SHARE NOWAIT;
  PERFORM g.id FROM public."ConnectorSyncGrant" g
    WHERE (g."customerId",g."projectId")=(customer,project) AND EXISTS (
      SELECT 1 FROM public."SourceObservationWitness" w JOIN public."SourceAdmissionBindingRevision" a ON a.id=w."admissionRevisionId"
      WHERE (w."customerId",w."projectId")=(customer,project) AND w."versionId"=ANY(version_ids)
        AND a."sourceKind"='jira.issue' AND a."ingestionSourceId"=g."sourceId")
    ORDER BY g.id FOR SHARE NOWAIT;
  access_at := clock_timestamp();
  RETURN QUERY SELECT w."versionId",a."sourceKind"::text,w."ingestionStreamId",w."sourceRevisionId",w."admittedAt",
    public.source_observation_read_allowed(w."versionId",reader,access_at)
    FROM public."SourceObservationWitness" w JOIN public."SourceAdmissionBindingRevision" a ON a.id=w."admissionRevisionId"
    WHERE (w."customerId",w."projectId")=(customer,project) AND w."versionId"=ANY(version_ids)
      AND public.valid_source_observation_witness(w."versionId");
EXCEPTION WHEN lock_not_available THEN RETURN;
END $$;

ALTER TABLE public."FactAssessment" DROP CONSTRAINT "FactAssessment_evaluatorVersion_check";
ALTER TABLE public."FactAssessment" ADD CONSTRAINT "FactAssessment_evaluatorVersion_check"
  CHECK ("evaluatorVersion"=1 OR ("evaluatorVersion"=2 AND "captureKind" IN ('SCALAR','MILESTONE')));

CREATE OR REPLACE FUNCTION public.valid_authority_conflict(cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public."FactAuthorityConflict" c
    JOIN public."ProjectFactVersion" l ON l.id=c."leftVersionId"
    JOIN public."ProjectFactVersion" r ON r.id=c."rightVersionId"
    JOIN public."FactEvidence" le ON le.id=l."evidenceId"
    JOIN public."FactEvidence" re ON re.id=r."evidenceId"
    JOIN public."AuthorityPolicyRevision" p ON p.id=c."policyRevisionId"
    WHERE c.id=cid AND l.value IS DISTINCT FROM r.value
      AND le."observedAt"<=c."detectedAt" AND re."observedAt"<=c."detectedAt"
      AND l."effectiveAt"<=c."detectedAt" AND r."effectiveAt"<=c."detectedAt"
      AND p.state='ENABLED' AND p."recordedAt"<=c."detectedAt" AND p."effectiveAt"<=c."detectedAt"
      AND NOT EXISTS (
        SELECT 1 FROM (VALUES (l.id,l.provenance),(r.id,r.provenance)) participant(id,provenance)
        LEFT JOIN public."SourceObservationWitness" w ON w."versionId"=participant.id
        WHERE participant.provenance='SYSTEM_VERIFIED'
          AND (w."versionId" IS NULL OR w."admittedAt">c."detectedAt"
            OR NOT public.valid_source_observation_witness(participant.id))
      ));
$$;

CREATE OR REPLACE FUNCTION public.valid_fact_assessment(aid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE mixed boolean; origin_type text; origin_ref jsonb; approval jsonb; approval_state text;
  temporal_by_version jsonb; recorded_by_version jsonb; result_versions jsonb; result_conflicts jsonb; a public."FactAssessment"%ROWTYPE; pol public."AuthorityPolicyRevision"%ROWTYPE;
  expected_policy jsonb := 'null'::jsonb; expected_scope jsonb; item jsonb; v record;
  actual_ids jsonb; output_ids jsonb; conflict_item jsonb; linked_count integer;
  freshness text; conflict_state text; selector jsonb; tier integer; expiry timestamptz; deadline timestamptz;
  applicability text; reasons jsonb; selected_tier integer; selected_ids jsonb;
  expected_status text; needs_revalidation boolean; has_ambiguity boolean; disagreement_ids jsonb; higher_ids jsonb;
BEGIN
  SELECT * INTO a FROM public."FactAssessment" WHERE id=aid;
  IF NOT FOUND OR a."evaluatorVersion" NOT IN (1,2) OR octet_length(a.result::text)>33554432
    OR a."factRevision">(SELECT revision FROM public."ProjectFact" WHERE id=a."factId") THEN RETURN false; END IF;
  mixed := a."evaluatorVersion"=2;
  IF mixed AND (NOT a.complete OR a."captureKind" NOT IN ('SCALAR','MILESTONE')) THEN RETURN false; END IF;
  IF a."captureKind"='MILESTONE' AND NOT EXISTS (
    SELECT 1 FROM public."MilestoneConsistencyAssessment" parent
    WHERE (parent."customerId",parent."projectId",parent.id,parent.subject,parent."asOf")
      =(a."customerId",a."projectId",a."milestoneAssessmentId",a.subject,a."asOf")
  ) THEN RETURN false; END IF;
  IF a.complete AND mixed IS DISTINCT FROM EXISTS (
    SELECT 1 FROM public."ProjectFactVersion" fv WHERE fv."factId"=a."factId" AND fv.revision<=a."factRevision"
      AND fv.provenance='SYSTEM_VERIFIED'
  ) THEN RETURN false; END IF;
  IF mixed AND EXISTS (
    SELECT 1 FROM public."ProjectFactVersion" fv LEFT JOIN public."SourceObservationWitness" w ON w."versionId"=fv.id
    WHERE fv."factId"=a."factId" AND fv.revision<=a."factRevision" AND fv.provenance='SYSTEM_VERIFIED'
      AND (w."versionId" IS NULL OR w."admittedAt">a."asOf" OR NOT public.valid_source_observation_witness(fv.id))
  ) THEN RETURN false; END IF;
  result_versions := a.result->'versions';
  result_conflicts := a.result->'conflicts';
  IF NOT (a.result ?& ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'])
    OR a.result - ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'] <> '{}'::jsonb THEN RETURN false; END IF;
  expected_scope := jsonb_build_object('customerId',a."customerId",'projectId',a."projectId",'factId',a."factId",'factType',a."factType");
  IF a.result->'scope' IS DISTINCT FROM expected_scope OR a.result->>'asOf' IS DISTINCT FROM public.authority_instant(a."asOf")
    OR a.result->>'mode' IS DISTINCT FROM 'HISTORICAL' OR a.result->'complete' IS DISTINCT FROM to_jsonb(a.complete)
    OR jsonb_typeof(result_versions) IS DISTINCT FROM 'array'
    OR jsonb_typeof(result_conflicts) IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'candidateVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingEvidenceIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  SELECT * INTO pol FROM public."AuthorityPolicyRevision" WHERE "policyId"=a."policyId"
    AND revision<=a."policyThroughRevision" AND "recordedAt"<=a."asOf" AND "effectiveAt"<=a."asOf" ORDER BY revision DESC LIMIT 1;
  IF pol.id IS DISTINCT FROM a."policyRevisionId" THEN RETURN false; END IF;
  IF pol.state='ENABLED' THEN expected_policy := pol.definition || jsonb_build_object('revisionId',pol.id,'customerId',pol."customerId",'projectId',pol."projectId",'factType',pol."factType",'recordedAt',public.authority_instant(pol."recordedAt"),'effectiveAt',public.authority_instant(pol."effectiveAt")); END IF;
  IF a.result->'policy' IS DISTINCT FROM expected_policy THEN RETURN false; END IF;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  IF linked_count<>a."versionCount" OR jsonb_array_length(result_versions)<>a."versionCount" THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("versionId"::text ORDER BY "versionId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(result_versions);
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  IF a.complete THEN
    IF (SELECT count(*) FROM public."ProjectFactVersion" WHERE "factId"=a."factId" AND revision<=a."factRevision")<>a."versionCount" THEN RETURN false; END IF;
  ELSIF a."versionCount"<>0 OR a."conflictCount"<>0 OR a.result->>'status' IS DISTINCT FROM 'INCOMPLETE'
    OR a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  -- Derive applicability once from the same immutable, historical prefix.
  -- Future evidence must not supersede a currently applicable version.
  IF a."versionCount">0 THEN
    WITH prefix AS MATERIALIZED (
      SELECT fv.id,fv."sourceId",fv."effectiveAt",e."observedAt",
        CASE WHEN NOT mixed OR fv.provenance='HUMAN_CONFIRMED' THEN e."observedAt" END AS ordered_observation
      FROM public."ProjectFactVersion" fv JOIN public."FactEvidence" e ON e.id=fv."evidenceId"
      WHERE fv."factId"=a."factId" AND fv.revision<=a."factRevision"
    ), visible AS (
      SELECT id,
        dense_rank() OVER (PARTITION BY "sourceId" ORDER BY "effectiveAt" DESC,ordered_observation DESC) AS position,
        count(*) OVER (PARTITION BY "sourceId","effectiveAt",ordered_observation) AS ties
      FROM prefix WHERE "observedAt"<=a."asOf" AND "effectiveAt"<=a."asOf"
    )
    -- Partition visible/future rows without a self-join: sparse statistics must
    -- not cause PostgreSQL to re-run both windows for every prefix row.
    SELECT jsonb_object_agg(classified.id::text,classified.applicability) INTO temporal_by_version
      FROM (
        SELECT id,CASE WHEN position>1 THEN 'SUPERSEDED'
          WHEN ties>1 THEN 'AMBIGUOUS' ELSE 'APPLICABLE' END AS applicability
        FROM visible
        UNION ALL
        SELECT id,CASE WHEN "observedAt">a."asOf" THEN 'NOT_YET_OBSERVED'
          ELSE 'NOT_YET_EFFECTIVE' END AS applicability
        FROM prefix WHERE "observedAt">a."asOf" OR "effectiveAt">a."asOf"
      ) classified;
  END IF;
  -- Materialize the scoped dependency set once, rather than repeatedly joining
  -- the growing global conflict history for every version.
  SELECT COALESCE(jsonb_object_agg(participant::text,ids),'{}'::jsonb) INTO recorded_by_version
    FROM (
      SELECT participant,jsonb_agg(c.id::text ORDER BY c.id) AS ids
      FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
      CROSS JOIN LATERAL (VALUES (c."leftVersionId"),(c."rightVersionId")) sides(participant)
      WHERE ac."assessmentId"=aid GROUP BY participant
    ) grouped;
  -- LEFT joins preserve malformed/missing rows for explicit rejection.
  FOR v IN SELECT fv.*,e."observedAt",output.value AS output_item,
    w."admittedAt",w."ingestionStreamId",w."sourceRevisionId",src."sourceType"
    FROM jsonb_array_elements(result_versions) output(value)
    LEFT JOIN public."ProjectFactVersion" fv ON fv.id=(output.value->>'id')::uuid
    LEFT JOIN public."FactEvidence" e ON e.id=fv."evidenceId"
    LEFT JOIN public."FactSource" src ON src.id=fv."sourceId"
    LEFT JOIN public."SourceObservationWitness" w ON w."versionId"=fv.id AND mixed
  LOOP
    item := v.output_item;
    IF v.id IS NULL OR v."observedAt" IS NULL OR v."factId"<>a."factId" OR v.revision>a."factRevision"
      OR item->'evidenceIds' IS DISTINCT FROM jsonb_build_array(v."evidenceId") THEN RETURN false; END IF;
    IF item->>'visibility'='restricted' THEN
      IF item IS DISTINCT FROM jsonb_build_object('id',v.id,'evidenceIds',jsonb_build_array(v."evidenceId"),'visibility','restricted','revalidationRequired',true) THEN RETURN false; END IF;
    ELSIF item->>'visibility'='available' THEN
      IF mixed AND v.provenance='SYSTEM_VERIFIED' THEN
        origin_type := v."sourceType";
        origin_ref := jsonb_build_object('instanceId',v."sourceId",
          'recordType',CASE origin_type WHEN 'jira' THEN 'jira.issue' WHEN 'xlsx' THEN 'xlsx.row' END,
          'recordId',v."ingestionStreamId",'revision',v."sourceRevisionId");
        approval_state := 'APPROVED';
        approval := jsonb_build_object('state',approval_state,'decisionAt',public.authority_instant(v."admittedAt"),'decisionId',v.id);
      ELSE
        origin_type := 'human_statement';
        origin_ref := jsonb_build_object('instanceId',v."sourceId",'recordType',origin_type,'recordId',v."sourceId",'revision',v."evidenceId");
        approval_state := 'NOT_REQUIRED';
        approval := jsonb_build_object('state',approval_state,'decisionAt',NULL,'decisionId',NULL);
      END IF;
      IF NOT(item ?& ARRAY['id','scope','source','value','provenance','effectiveAt','observedAt','validUntil','evidenceIds','temporalApplicability','assessedValidUntil','unresolvedConflictIds','assessment','visibility','revalidationRequired','sourceType','approval','approvalStateAsOf','authorityTier','eligibilityReasons'])
        OR item - ARRAY['id','scope','source','value','provenance','effectiveAt','observedAt','validUntil','evidenceIds','temporalApplicability','assessedValidUntil','unresolvedConflictIds','assessment','visibility','revalidationRequired','sourceType','approval','approvalStateAsOf','authorityTier','eligibilityReasons'] <> '{}'::jsonb
        OR item->'revalidationRequired' IS DISTINCT FROM 'false'::jsonb
        OR item->>'approvalStateAsOf' IS DISTINCT FROM approval_state
        OR item->>'temporalApplicability' NOT IN ('NOT_YET_OBSERVED','NOT_YET_EFFECTIVE','SUPERSEDED','AMBIGUOUS','APPLICABLE')
        OR jsonb_typeof(item->'temporalApplicability') IS DISTINCT FROM 'string'
        OR jsonb_typeof(item->'eligibilityReasons') IS DISTINCT FROM 'array'
        OR jsonb_typeof(item->'unresolvedConflictIds') IS DISTINCT FROM 'array'
        THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(item->'eligibilityReasons') reason WHERE jsonb_typeof(reason) IS DISTINCT FROM 'string'
        OR reason #>> '{}' NOT IN ('NO_AUTHORITY_RULE','NOT_APPLICABLE','AMBIGUOUS_STREAM','APPROVAL_REQUIRED','REJECTED','STALE','UNKNOWN_VALIDITY','UNVERIFIED_ORIGIN')) THEN RETURN false; END IF;
      actual_ids := COALESCE(recorded_by_version->v.id::text,'[]'::jsonb);
      IF item->'unresolvedConflictIds' IS DISTINCT FROM actual_ids THEN RETURN false; END IF;
      SELECT s.value,(t.ordinality-1)::integer INTO selector,tier
        FROM jsonb_array_elements(expected_policy->'tiers') WITH ORDINALITY t(value,ordinality)
        CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s(value)
        WHERE s.value->>'sourceType'=origin_type
          AND (s.value->>'instanceId'=v."sourceId"::text OR (origin_type='human_statement' AND s.value->'instanceId'='null'::jsonb));
      expiry := v."validUntil";
      IF selector->'validity' <> 'null'::jsonb THEN
        IF mixed THEN
          deadline := public.source_admission_expiry(selector,v."effectiveAt",v."observedAt");
          IF deadline IS NULL THEN RETURN false; END IF;
        ELSE
          deadline := ((CASE WHEN selector->'validity'->>'basis'='observedAt' THEN v."observedAt" ELSE v."effectiveAt" END AT TIME ZONE 'UTC')
          + ((selector->'validity'->>'durationMs')::bigint / 86400000) * interval '1 day'
          + ((selector->'validity'->>'durationMs')::bigint % 86400000) * interval '1 millisecond') AT TIME ZONE 'UTC';
          IF NOT isfinite(deadline) OR deadline>='10000-01-01 00:00:00+00'::timestamptz THEN RETURN false; END IF;
        END IF;
        expiry := LEAST(expiry,deadline);
      END IF;
      applicability := temporal_by_version->>v.id::text;
      IF applicability IS NULL THEN RETURN false; END IF;
      freshness := CASE WHEN applicability IN ('NOT_YET_OBSERVED','NOT_YET_EFFECTIVE') OR expiry IS NULL THEN 'UNKNOWN'
        WHEN expiry<=a."asOf" THEN 'STALE' ELSE 'CURRENT' END;
      reasons := '[]'::jsonb;
      IF selector IS NULL THEN reasons := reasons || '"NO_AUTHORITY_RULE"'::jsonb; END IF;
      IF applicability NOT IN ('APPLICABLE','AMBIGUOUS') THEN reasons := reasons || '"NOT_APPLICABLE"'::jsonb; END IF;
      IF applicability='AMBIGUOUS' THEN reasons := reasons || '"AMBIGUOUS_STREAM"'::jsonb; END IF;
      IF selector->>'requiredApproval'='APPROVED' AND approval_state<>'APPROVED' THEN reasons := reasons || '"APPROVAL_REQUIRED"'::jsonb; END IF;
      IF freshness='STALE' THEN reasons := reasons || '"STALE"'::jsonb; END IF;
      IF freshness='UNKNOWN' THEN reasons := reasons || '"UNKNOWN_VALIDITY"'::jsonb; END IF;
      IF item->'authorityTier' IS DISTINCT FROM COALESCE(to_jsonb(tier),'null'::jsonb)
        OR item->'assessedValidUntil' IS DISTINCT FROM COALESCE(to_jsonb(public.authority_instant(expiry)),'null'::jsonb)
        OR item->>'temporalApplicability' IS DISTINCT FROM applicability OR item->'eligibilityReasons' IS DISTINCT FROM reasons THEN RETURN false; END IF;
      conflict_state := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(result_conflicts) c WHERE c->'versionIds' @> jsonb_build_array(v.id)) THEN 'CONFLICTING' ELSE 'NONE' END;
      IF item->'assessment' IS DISTINCT FROM jsonb_build_object('provenance',v.provenance,'freshness',freshness,'conflict',conflict_state,'classification',CASE WHEN conflict_state='CONFLICTING' THEN 'CONFLICTING' WHEN freshness<>'CURRENT' THEN freshness ELSE v.provenance END,'assessedAt',public.authority_instant(a."asOf")) THEN RETURN false; END IF;
      IF item->'scope' IS DISTINCT FROM expected_scope OR item->'value' IS DISTINCT FROM v.value
        OR item->>'provenance' IS DISTINCT FROM v.provenance OR item->>'sourceType' IS DISTINCT FROM origin_type
        OR item->>'effectiveAt' IS DISTINCT FROM public.authority_instant(v."effectiveAt")
        OR item->>'observedAt' IS DISTINCT FROM public.authority_instant(v."observedAt")
        OR item->'validUntil' IS DISTINCT FROM COALESCE(to_jsonb(public.authority_instant(v."validUntil")),'null'::jsonb)
        OR item->'source' IS DISTINCT FROM origin_ref
        OR item->'approval' IS DISTINCT FROM approval
        THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
  END LOOP;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentConflict" WHERE "assessmentId"=aid;
  IF linked_count<>a."conflictCount" THEN RETURN false; END IF;
  IF a.complete AND (SELECT count(*) FROM public."FactAuthorityConflict" WHERE "factId"=a."factId" AND revision<=a."conflictThroughRevision")<>a."conflictCount" THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
    WHERE ac."assessmentId"=aid AND (a."conflictThroughRevision" IS NULL OR c.revision>a."conflictThroughRevision")) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("conflictId"::text ORDER BY "conflictId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentConflict" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'recordedConflictId' ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  -- Compare the complete recorded set in one query. A per-pair query loop
  -- repeatedly expanded the large capture JSON and exhausted transaction time.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','RECORDED','recordedConflictId',c.id,
      'versionIds',jsonb_build_array(c."leftVersionId",c."rightVersionId"),
      'evidenceIds',jsonb_build_array(LEAST(l."evidenceId",r."evidenceId"),GREATEST(l."evidenceId",r."evidenceId"))) ORDER BY c.id),'[]'::jsonb)
    INTO actual_ids FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
    JOIN public."ProjectFactVersion" l ON l.id=c."leftVersionId" JOIN public."ProjectFactVersion" r ON r.id=c."rightVersionId"
    JOIN public."FactAssessmentVersion" al ON al."assessmentId"=aid AND al."versionId"=l.id
    JOIN public."FactAssessmentVersion" ar ON ar."assessmentId"=aid AND ar."versionId"=r.id
    WHERE ac."assessmentId"=aid AND c."detectedAt"<=a."asOf" AND public.valid_authority_conflict(c.id);
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids
    FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids OR EXISTS (SELECT 1 FROM jsonb_array_elements(result_conflicts) WHERE jsonb_typeof(value->'kind') IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'<>'RECORDED' LOOP
    IF NOT(conflict_item ?& ARRAY['kind','recordedConflictId','versionIds','evidenceIds'])
      OR conflict_item - ARRAY['kind','recordedConflictId','versionIds','evidenceIds'] <> '{}'::jsonb
      OR jsonb_typeof(conflict_item->'kind') IS DISTINCT FROM 'string'
      OR conflict_item->>'kind' NOT IN ('RECORDED','AUTHORITY_DISAGREEMENT','HIGHER_AUTHORITY_CONTRADICTION')
      OR (conflict_item->>'kind'<>'RECORDED' AND conflict_item->'recordedConflictId' IS DISTINCT FROM 'null'::jsonb)
      OR jsonb_typeof(conflict_item->'versionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(conflict_item->'versionIds')<2 THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(conflict_item->'versionIds') x WHERE NOT EXISTS
      (SELECT 1 FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid AND "versionId"=x::uuid)) THEN RETURN false; END IF;
    SELECT COALESCE(jsonb_agg("evidenceId"::text ORDER BY "evidenceId"),'[]'::jsonb) INTO actual_ids FROM public."ProjectFactVersion" WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(conflict_item->'versionIds'));
    IF actual_ids IS DISTINCT FROM conflict_item->'evidenceIds' THEN RETURN false; END IF;
  END LOOP;
  -- Validate selection and claims against the already bound immutable version
  -- assessments. Human attribution cannot satisfy an APPROVED selector.
  SELECT min((value->>'authorityTier')::integer) INTO selected_tier FROM jsonb_array_elements(result_versions)
    WHERE value->>'visibility'='available' AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb),COALESCE(bool_or(value->>'temporalApplicability'='AMBIGUOUS'),false)
    INTO selected_ids,has_ambiguity FROM jsonb_array_elements(result_versions)
    WHERE value->>'visibility'='available' AND (value->>'authorityTier')::integer=selected_tier AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT CASE WHEN count(DISTINCT value->'value')>1 THEN selected_ids ELSE '[]'::jsonb END INTO disagreement_ids
    FROM jsonb_array_elements(result_versions) WHERE selected_ids @> jsonb_build_array(value->>'id');
  SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO higher_ids FROM (
    SELECT DISTINCT id FROM jsonb_array_elements(result_versions) human(value)
    CROSS JOIN jsonb_array_elements(result_versions) higher(value)
    CROSS JOIN LATERAL (VALUES (human.value->>'id'),(higher.value->>'id')) participants(id)
    WHERE selected_ids @> jsonb_build_array(human.value->>'id') AND human.value->>'provenance'='HUMAN_CONFIRMED'
      AND higher.value->>'visibility'='available' AND (higher.value->>'authorityTier')::integer<selected_tier
      AND higher.value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM","STALE","UNKNOWN_VALIDITY"]'::jsonb
      AND higher.value->'value' IS DISTINCT FROM human.value->'value'
  ) participants;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'<>'RECORDED' LOOP
    IF conflict_item->'versionIds' IS DISTINCT FROM (CASE WHEN conflict_item->>'kind'='AUTHORITY_DISAGREEMENT' THEN disagreement_ids ELSE higher_ids END) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='AUTHORITY_DISAGREEMENT')<>(CASE WHEN jsonb_array_length(disagreement_ids)>0 THEN 1 ELSE 0 END)
    OR (SELECT count(*) FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='HIGHER_AUTHORITY_CONTRADICTION')<>(CASE WHEN jsonb_array_length(higher_ids)>0 THEN 1 ELSE 0 END) THEN RETURN false; END IF;
  needs_revalidation := EXISTS (SELECT 1 FROM jsonb_array_elements(result_versions) WHERE value->>'visibility'='restricted');
  expected_status := CASE WHEN NOT a.complete THEN 'INCOMPLETE' WHEN needs_revalidation THEN 'REVALIDATION_REQUIRED'
    WHEN expected_policy='null'::jsonb THEN 'NO_POLICY' WHEN jsonb_array_length(result_conflicts)>0 THEN 'CONFLICTING'
    WHEN has_ambiguity THEN 'AMBIGUOUS' WHEN jsonb_array_length(selected_ids)>0 THEN 'RESOLVED' ELSE 'UNKNOWN' END;
  IF a.result->'selectedTier' IS DISTINCT FROM COALESCE(to_jsonb(selected_tier),'null'::jsonb)
    OR a.result->'candidateVersionIds' IS DISTINCT FROM selected_ids OR a.result->>'status' IS DISTINCT FROM expected_status
    OR a.result->'revalidationRequired' IS DISTINCT FROM to_jsonb(needs_revalidation)
    OR a.result->>'conflict' IS DISTINCT FROM (CASE WHEN jsonb_array_length(result_conflicts)>0 THEN 'CONFLICTING' ELSE 'NONE' END)
    OR a.result->'reconciliationRequired' IS DISTINCT FROM to_jsonb(jsonb_array_length(result_conflicts)>0 AND COALESCE(pol.state='ENABLED' AND pol.definition->>'conflictBehavior'='REQUEST_RECONCILIATION',false))
    THEN RETURN false; END IF;
  IF a.result->>'status'='RESOLVED' THEN
    IF a.result->'supportingVersionIds' IS DISTINCT FROM selected_ids THEN RETURN false; END IF;
    IF NOT a.complete OR jsonb_array_length(a.result->'supportingVersionIds')<1 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(a.result->'supportingVersionIds') LOOP
      IF NOT EXISTS (SELECT 1 FROM public."FactAssessmentVersion" av JOIN public."ProjectFactVersion" fv ON fv.id=av."versionId"
        WHERE av."assessmentId"=aid AND to_jsonb(fv.id)=item AND fv.value=a.result->'resolvedValue') THEN RETURN false; END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg("evidenceId"::text ORDER BY "evidenceId"),'[]'::jsonb) INTO actual_ids
      FROM public."ProjectFactVersion" WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(a.result->'supportingVersionIds'));
    IF a.result->'supportingEvidenceIds' IS DISTINCT FROM actual_ids THEN RETURN false; END IF;
  ELSIF a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb OR a.result->'supportingVersionIds' IS DISTINCT FROM '[]'::jsonb
    OR a.result->'supportingEvidenceIds' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.result->'candidateVersionIds') x WHERE NOT EXISTS
    (SELECT 1 FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid AND "versionId"=x::uuid)) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

-- Bind newly sealed mixed proofs to the actual capture-time access projection.
-- Historical verification above deliberately uses only the retained proof.
CREATE FUNCTION public.guard_mixed_assessment_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  source_versions uuid[];
  source_access jsonb;
BEGIN
  SELECT array_agg(v.id ORDER BY v.id) INTO source_versions
  FROM public."FactAssessmentVersion" av JOIN public."ProjectFactVersion" v ON v.id=av."versionId"
  WHERE av."assessmentId"=NEW.id AND v.provenance='SYSTEM_VERIFIED';

  SELECT jsonb_object_agg(o."versionId"::text,o.authorized) INTO source_access
  FROM public.read_source_authority_origins(NEW."customerId",NEW."projectId",NEW.subject,
    ARRAY['leadership','project_manager','portfolio_manager','pmo_admin'],source_versions) o;
  IF source_access IS NULL OR EXISTS (
    SELECT 1 FROM unnest(source_versions) s(id) WHERE NOT source_access ? s.id::text
  ) THEN RAISE EXCEPTION 'Mixed assessment origin unavailable'; END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.result->'versions') item(value)
    JOIN public."FactAssessmentVersion" av ON av."assessmentId"=NEW.id AND av."versionId"=(item.value->>'id')::uuid
    JOIN public."ProjectFactVersion" v ON v.id=av."versionId"
    WHERE (item.value->>'visibility'='available') IS DISTINCT FROM CASE
      WHEN v.provenance='SYSTEM_VERIFIED' THEN source_access->v.id::text='true'::jsonb
      ELSE EXISTS (
        SELECT 1 FROM public."FactSourceAccess" fa JOIN public."FactSourceReader" fr
          ON (fr."customerId",fr."projectId",fr."factId",fr."sourceId")
            =(fa."customerId",fa."projectId",fa."factId",fa."sourceId")
        WHERE (fa."customerId",fa."projectId",fa."factId",fa."sourceId")
          =(v."customerId",v."projectId",v."factId",v."sourceId")
          AND fa.state='AVAILABLE' AND fr.subject=NEW.subject
      ) END
  ) THEN RAISE EXCEPTION 'Mixed assessment access changed'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mixed_assessment_access BEFORE UPDATE ON public."FactAssessment"
FOR EACH ROW WHEN (NEW."evaluatorVersion"=2 AND NEW.sealed AND NOT OLD.sealed)
EXECUTE FUNCTION public.guard_mixed_assessment_access();

REVOKE ALL ON TABLE public."ConnectorPageDispatch" FROM PUBLIC;
REVOKE ALL ON TABLE public."SourceObservationWitness",public."SourceAdmissionBindingRevision",public."SourceAdmissionCommand" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
  public.record_connector_page_dispatch(uuid),public.valid_connector_page_dispatch(uuid),
  public.resolve_source_observation_input(uuid,uuid,uuid,uuid,uuid,integer,text,jsonb),
  public.valid_source_observation_witness(uuid),public.valid_source_observation_structure(uuid),
  public.valid_source_canonical_birth(uuid),public.valid_canonical_state_binding(uuid),
  public.require_canonical_state_binding_sealed(),public.guard_source_observation_insert(),
  public.require_source_observation_witness(),
  public.admit_source_observation(uuid,uuid,uuid,uuid,integer,text,uuid),
  public.source_admission_outcome(public."SourceAdmissionBindingRevision",uuid,integer),
  public.valid_source_admission_command(uuid),public.require_source_admission_command(),
  public.approve_source_observation(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,integer,text,uuid),
  public.valid_source_admission_binding(uuid),public.source_admission_selector(jsonb,text,uuid),
  public.source_admission_expiry(jsonb,timestamptz,timestamptz),public.guard_source_admission_binding(),
  public.require_source_admission_binding(),public.guard_source_authority_activation(),
  public.require_source_authority_witness(),public.valid_source_authority_publication(uuid),
  public.source_observation_read_allowed(uuid,text,timestamptz),
  public.read_source_authority_origins(uuid,uuid,text,text[],uuid[]),
  public.guard_mixed_assessment_access(),public.valid_fact_assessment(uuid),
  public.valid_authority_conflict(uuid) FROM PUBLIC;
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
    ALTER FUNCTION public.admit_source_observation(uuid,uuid,uuid,uuid,integer,text,uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.source_admission_outcome(public."SourceAdmissionBindingRevision",uuid,integer) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_source_admission_command(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_source_admission_command() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.approve_source_observation(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,integer,text,uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_source_admission_binding(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.source_admission_selector(jsonb,text,uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.source_admission_expiry(jsonb,timestamptz,timestamptz) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.guard_source_admission_binding() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_source_admission_binding() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.guard_source_authority_activation() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_source_authority_witness() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_source_authority_publication(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_authority_published() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_source_observation_structure(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_source_canonical_birth(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_canonical_state_binding(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.require_canonical_state_binding_sealed() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.source_observation_read_allowed(uuid,text,timestamptz) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.read_source_authority_origins(uuid,uuid,text,text[],uuid[]) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.guard_mixed_assessment_access() OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_fact_assessment(uuid) OWNER TO pdaa_migrate;
    ALTER FUNCTION public.valid_authority_conflict(uuid) OWNER TO pdaa_migrate;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.valid_canonical_state_binding(uuid) TO pdaa_api;
      GRANT EXECUTE ON FUNCTION public.bind_connector_task_claim(uuid,uuid,integer,uuid),
        public.record_connector_page_dispatch(uuid),public.valid_fact_assessment(uuid),public.valid_authority_conflict(uuid),
        public.read_source_authority_origins(uuid,uuid,text,text[],uuid[]) TO pdaa_api;
    END IF;
  END IF;
END $roles$;
