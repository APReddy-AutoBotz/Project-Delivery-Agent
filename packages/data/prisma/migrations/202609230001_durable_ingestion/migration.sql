-- EXEC-009 Stage 2: bounded, permission-checked proposal persistence.
-- This additive migration preserves the nine released migration files.
CREATE TABLE public."IngestionSource" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceType" varchar(96) NOT NULL,
  origin varchar(2048) NOT NULL,
  "currentConfigRevision" integer,
  "mappingRevision" integer NOT NULL DEFAULT 0,
  "cursorRevision" bigint NOT NULL DEFAULT 0,
  "syncGeneration" bigint NOT NULL DEFAULT 1,
  "cursorEnvelope" text,
  "cursorState" varchar(16) NOT NULL DEFAULT 'READY',
  "healthState" varchar(16) NOT NULL DEFAULT 'UNKNOWN',
  "healthCode" varchar(32) NOT NULL DEFAULT 'NONE',
  "healthCheckedAt" timestamptz(3),
  "lastSuccessReceiptId" uuid,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionSource_pkey" PRIMARY KEY (id),
  CONSTRAINT "IngestionSource_scope_key" UNIQUE ("customerId",id),
  CONSTRAINT "IngestionSource_customer_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionSource_cursor_revision_check" CHECK ("cursorRevision">=0 AND "syncGeneration">0),
  CONSTRAINT "IngestionSource_cursor_state_check" CHECK ("cursorState" IN ('READY','TERMINAL','RESET_REQUIRED')),
  CONSTRAINT "IngestionSource_cursor_payload_check" CHECK (("cursorEnvelope" IS NULL OR "cursorEnvelope" LIKE 'v1.%') AND ("cursorState" NOT IN ('TERMINAL','RESET_REQUIRED') OR "cursorEnvelope" IS NULL)),
  CONSTRAINT "IngestionSource_health_check" CHECK ("healthState" IN ('UNKNOWN','HEALTHY','DEGRADED','FAILED') AND "healthCode" IN ('NONE','INVALID_CREDENTIALS','EXPIRED_CREDENTIALS','PERMISSION_DENIED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE','INVALID_RESPONSE','NOT_FOUND','UNKNOWN_OUTCOME','INTEGRITY_CONFLICT','CURSOR_CONFLICT')),
  CONSTRAINT "IngestionSource_health_shape_check" CHECK (("healthState"='UNKNOWN' AND "healthCode"='NONE' AND "healthCheckedAt" IS NULL) OR ("healthState"='HEALTHY' AND "healthCode"='NONE' AND "healthCheckedAt" IS NOT NULL) OR ("healthState" IN ('DEGRADED','FAILED') AND "healthCode"<>'NONE' AND "healthCheckedAt" IS NOT NULL)),
  CONSTRAINT "IngestionSource_origin_check" CHECK (origin ~ '^https://[^/?#]+$' AND "sourceType" ~ '^[A-Za-z0-9_.-]{1,96}$')
);
CREATE TABLE public."IngestionConfigurationRevision" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  revision integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  mapping jsonb NOT NULL,
  "changedBy" varchar(256) NOT NULL,
  "auditEventId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed boolean NOT NULL DEFAULT false,
  CONSTRAINT "IngestionConfigurationRevision_pkey" PRIMARY KEY ("customerId","sourceId",revision),
  CONSTRAINT "IngestionConfigurationRevision_map_key" UNIQUE ("customerId","sourceId",revision,"mappingRevision"),
  CONSTRAINT "IngestionConfigurationRevision_source_fkey" FOREIGN KEY ("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionConfigurationRevision_audit_fkey" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionConfigurationRevision_revision_check" CHECK (revision>0 AND "mappingRevision">0 AND public.nonblank_fact_text("changedBy")),
  CONSTRAINT "IngestionConfigurationRevision_mapping_check" CHECK (jsonb_typeof(mapping)='object' AND octet_length(mapping::text)<=32768)
);
ALTER TABLE public."IngestionSource" ADD CONSTRAINT "IngestionSource_current_config_fkey"
  FOREIGN KEY ("customerId",id,"currentConfigRevision") REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TABLE public."IngestionConfigurationProject" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "configRevision" integer NOT NULL,
  "projectId" uuid NOT NULL,
  CONSTRAINT "IngestionConfigurationProject_pkey" PRIMARY KEY ("customerId","sourceId","configRevision","projectId"),
  CONSTRAINT "IngestionConfigurationProject_config_fkey" FOREIGN KEY ("customerId","sourceId","configRevision") REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionConfigurationProject_project_fkey" FOREIGN KEY ("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE public."IngestionConfigurationReader" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "configRevision" integer NOT NULL,
  "projectId" uuid NOT NULL,
  subject varchar(256) NOT NULL,
  CONSTRAINT "IngestionConfigurationReader_pkey" PRIMARY KEY ("customerId","sourceId","configRevision","projectId",subject),
  CONSTRAINT "IngestionConfigurationReader_project_fkey" FOREIGN KEY ("customerId","sourceId","configRevision","projectId") REFERENCES public."IngestionConfigurationProject"("customerId","sourceId","configRevision","projectId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionConfigurationReader_subject_check" CHECK (public.nonblank_fact_text(subject))
);
CREATE TABLE public."IngestionRetentionPolicy" (
  "customerId" uuid NOT NULL,
  "retentionHours" integer NOT NULL,
  revision integer NOT NULL,
  "changedBy" varchar(256) NOT NULL,
  "auditEventId" uuid NOT NULL,
  "changedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionRetentionPolicy_pkey" PRIMARY KEY ("customerId"),
  CONSTRAINT "IngestionRetentionPolicy_customer_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRetentionPolicy_audit_fkey" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRetentionPolicy_hours_check" CHECK ("retentionHours">0 AND revision>0 AND public.nonblank_fact_text("changedBy"))
);
CREATE TABLE public."IngestionExternalRecord" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "recordType" varchar(267) NOT NULL,
  "recordKey" varchar(256) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionExternalRecord_pkey" PRIMARY KEY (id),
  CONSTRAINT "IngestionExternalRecord_scope_key" UNIQUE ("customerId","sourceId",id),
  CONSTRAINT "IngestionExternalRecord_identity_key" UNIQUE ("customerId","sourceId","recordType","recordKey"),
  CONSTRAINT "IngestionExternalRecord_typed_scope_key" UNIQUE ("customerId","sourceId","projectId",id),
  CONSTRAINT "IngestionExternalRecord_source_fkey" FOREIGN KEY ("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionExternalRecord_project_fkey" FOREIGN KEY ("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionExternalRecord_identity_check" CHECK (public.nonblank_fact_text("recordType") AND public.nonblank_fact_text("recordKey"))
);
CREATE TABLE public."IngestionFactStream" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "recordId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionFactStream_pkey" PRIMARY KEY (id),
  CONSTRAINT "IngestionFactStream_identity_key" UNIQUE ("customerId","sourceId","recordId","factType"),
  CONSTRAINT "IngestionFactStream_scope_key" UNIQUE ("customerId","sourceId","recordId",id),
  CONSTRAINT "IngestionFactStream_record_fkey" FOREIGN KEY ("customerId","sourceId","recordId") REFERENCES public."IngestionExternalRecord"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionFactStream_type_check" CHECK ("factType" ~ '^[a-z][a-z0-9_.-]{0,95}$')
);
CREATE TABLE public."IngestionSourceRevision" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "recordId" uuid NOT NULL,
  revision varchar(128) NOT NULL,
  "sourceContentHash" char(64) NOT NULL,
  "remoteObservedAt" timestamptz(3),
  "remoteEffectiveAt" timestamptz(3),
  "receivedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionSourceRevision_pkey" PRIMARY KEY (id),
  CONSTRAINT "IngestionSourceRevision_identity_key" UNIQUE ("customerId","sourceId","recordId",revision),
  CONSTRAINT "IngestionSourceRevision_scope_key" UNIQUE ("customerId","sourceId","recordId",id),
  CONSTRAINT "IngestionSourceRevision_record_fkey" FOREIGN KEY ("customerId","sourceId","recordId") REFERENCES public."IngestionExternalRecord"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionSourceRevision_digest_check" CHECK (revision<>'' AND "sourceContentHash" ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public."IngestionProposalProjection" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "recordId" uuid NOT NULL,
  "sourceRevisionId" uuid NOT NULL,
  "mappingRevision" integer NOT NULL,
  "proposalHash" char(64) NOT NULL,
  "factTypes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionProposalProjection_pkey" PRIMARY KEY (id),
  CONSTRAINT "IngestionProposalProjection_identity_key" UNIQUE ("customerId","sourceId","recordId","sourceRevisionId","mappingRevision"),
  CONSTRAINT "IngestionProposalProjection_scope_key" UNIQUE ("customerId","sourceId","recordId",id),
  CONSTRAINT "IngestionProposalProjection_revision_scope_key" UNIQUE ("customerId","sourceId","recordId","sourceRevisionId",id),
  CONSTRAINT "IngestionProposalProjection_exact_key" UNIQUE ("customerId","sourceId","recordId","sourceRevisionId","mappingRevision",id),
  CONSTRAINT "IngestionProposalProjection_revision_fkey" FOREIGN KEY ("customerId","sourceId","recordId","sourceRevisionId") REFERENCES public."IngestionSourceRevision"("customerId","sourceId","recordId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionProposalProjection_mapping_check" CHECK ("mappingRevision">0 AND "proposalHash" ~ '^[a-f0-9]{64}$' AND cardinality("factTypes")<=32)
);
CREATE TABLE public."IngestionProposalContent" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "recordId" uuid NOT NULL,
  "projectionId" uuid NOT NULL,
  proposals jsonb,
  "policyRevision" integer NOT NULL,
  "redactedAt" timestamptz(3),
  "redactionAuditEventId" uuid,
  CONSTRAINT "IngestionProposalContent_pkey" PRIMARY KEY ("projectionId"),
  CONSTRAINT "IngestionProposalContent_projection_fkey" FOREIGN KEY ("customerId","sourceId","recordId","projectionId") REFERENCES public."IngestionProposalProjection"("customerId","sourceId","recordId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionProposalContent_json_check" CHECK (proposals IS NULL OR (jsonb_typeof(proposals)='array' AND octet_length(proposals::text)<=1048576)),
  CONSTRAINT "IngestionProposalContent_audit_fkey" FOREIGN KEY ("customerId","redactionAuditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionProposalContent_tombstone_check" CHECK ((proposals IS NULL)=("redactedAt" IS NOT NULL) AND (proposals IS NULL)=("redactionAuditEventId" IS NOT NULL) AND "policyRevision">0)
);
CREATE TABLE public."IngestionOperationReceipt" (
  id uuid NOT NULL,
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  subject varchar(256) NOT NULL,
  kind varchar(24) NOT NULL,
  "commandKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL,
  "eventId" varchar(256),
  "configRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  "generationBefore" bigint,
  "generationAfter" bigint,
  "cursorRevisionBefore" bigint,
  "cursorRevisionAfter" bigint,
  "outcomeCount" integer NOT NULL,
  "auditEventId" uuid NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IngestionOperationReceipt_pkey" PRIMARY KEY (id),
  CONSTRAINT "IngestionOperationReceipt_scope_key" UNIQUE ("customerId","sourceId",id),
  CONSTRAINT "IngestionOperationReceipt_command_key" UNIQUE ("customerId","sourceId",subject,kind,"commandKey"),
  CONSTRAINT "IngestionOperationReceipt_config_fkey" FOREIGN KEY ("customerId","sourceId","configRevision","mappingRevision") REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision,"mappingRevision") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionOperationReceipt_audit_fkey" FOREIGN KEY ("customerId","auditEventId") REFERENCES public."AuditEvent"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionOperationReceipt_input_check" CHECK (public.nonblank_fact_text(subject) AND "commandKey" ~ '^[A-Za-z0-9_-]{1,128}$' AND "requestHash" ~ '^[a-f0-9]{64}$' AND "outcomeCount" BETWEEN 0 AND 1000),
  CONSTRAINT "IngestionOperationReceipt_kind_check" CHECK (kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT','CSV_PREVIEW','SYNC_RESET') AND (kind<>'CONNECTOR_PAGE' OR "outcomeCount"<=100) AND (kind<>'CONNECTOR_EVENT' OR "outcomeCount"=1)),
  CONSTRAINT "IngestionOperationReceipt_cursor_check" CHECK (
    (kind='CONNECTOR_PAGE' AND "generationBefore" IS NOT NULL AND "generationAfter"="generationBefore" AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0)
    OR (kind='SYNC_RESET' AND "generationBefore">0 AND "generationAfter"="generationBefore"+1 AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0 AND "outcomeCount"=0)
    OR (kind IN ('CONNECTOR_EVENT','CSV_PREVIEW') AND "generationBefore" IS NULL AND "generationAfter" IS NULL AND "cursorRevisionBefore" IS NULL AND "cursorRevisionAfter" IS NULL)
  ),
  CONSTRAINT "IngestionOperationReceipt_event_check" CHECK ((kind='CONNECTOR_EVENT')=("eventId" IS NOT NULL) AND ("eventId" IS NULL OR (length("eventId") BETWEEN 1 AND 256 AND "eventId" !~ '[[:cntrl:]]')))
);
CREATE UNIQUE INDEX "IngestionOperationReceipt_event_key" ON public."IngestionOperationReceipt"("customerId","sourceId","eventId") WHERE "eventId" IS NOT NULL;
ALTER TABLE public."IngestionSource" ADD CONSTRAINT "IngestionSource_last_receipt_fkey"
  FOREIGN KEY ("customerId",id,"lastSuccessReceiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE TABLE public."IngestionReceiptProjectScope" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "grantId" uuid NOT NULL,
  "grantRole" varchar(32) NOT NULL,
  "grantScopeType" varchar(16) NOT NULL,
  "grantScopeId" uuid NOT NULL,
  CONSTRAINT "IngestionReceiptProjectScope_pkey" PRIMARY KEY ("receiptId","projectId"),
  CONSTRAINT "IngestionReceiptProjectScope_receipt_fkey" FOREIGN KEY ("customerId","sourceId","receiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReceiptProjectScope_project_fkey" FOREIGN KEY ("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionReceiptProjectScope_shape_check" CHECK ("grantRole" IN ('project_manager','portfolio_manager','pmo_admin') AND "grantScopeType" IN ('project','portfolio'))
);
CREATE TABLE public."IngestionCursorTransition" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "generationBefore" bigint NOT NULL,
  "generationAfter" bigint NOT NULL,
  "cursorRevisionBefore" bigint NOT NULL,
  "cursorRevisionAfter" bigint NOT NULL,
  "stateAfter" varchar(16) NOT NULL,
  "cursorEnvelopeHash" char(64),
  CONSTRAINT "IngestionCursorTransition_pkey" PRIMARY KEY ("receiptId"),
  CONSTRAINT "IngestionCursorTransition_receipt_fkey" FOREIGN KEY ("customerId","sourceId","receiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCursorTransition_source_fkey" FOREIGN KEY ("customerId","sourceId") REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCursorTransition_revision_key" UNIQUE ("customerId","sourceId","cursorRevisionAfter"),
  CONSTRAINT "IngestionCursorTransition_shape_check" CHECK ("generationBefore">0 AND "generationAfter">0 AND "cursorRevisionBefore">=0 AND "cursorRevisionAfter">"cursorRevisionBefore" AND "stateAfter" IN ('READY','TERMINAL') AND ("cursorEnvelopeHash" IS NULL OR "cursorEnvelopeHash" ~ '^[a-f0-9]{64}$'))
);
CREATE TABLE public."IngestionRowOutcome" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  ordinal integer NOT NULL,
  state varchar(16) NOT NULL,
  operation varchar(16) NOT NULL,
  "errorCodes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "projectId" uuid,
  "recordKey" varchar(256),
  "recordId" uuid,
  "sourceRevisionId" uuid,
  "projectionId" uuid,
  CONSTRAINT "IngestionRowOutcome_pkey" PRIMARY KEY ("receiptId",ordinal),
  CONSTRAINT "IngestionRowOutcome_receipt_fkey" FOREIGN KEY ("customerId","sourceId","receiptId") REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRowOutcome_project_fkey" FOREIGN KEY ("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRowOutcome_record_fkey" FOREIGN KEY ("customerId","sourceId","projectId","recordId") REFERENCES public."IngestionExternalRecord"("customerId","sourceId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRowOutcome_revision_fkey" FOREIGN KEY ("customerId","sourceId","recordId","sourceRevisionId") REFERENCES public."IngestionSourceRevision"("customerId","sourceId","recordId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRowOutcome_projection_fkey" FOREIGN KEY ("customerId","sourceId","recordId","sourceRevisionId","projectionId") REFERENCES public."IngestionProposalProjection"("customerId","sourceId","recordId","sourceRevisionId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionRowOutcome_index_check" CHECK (ordinal BETWEEN 1 AND 1000),
  CONSTRAINT "IngestionRowOutcome_record_key_check" CHECK ("recordKey" IS NULL OR public.nonblank_fact_text("recordKey")),
  CONSTRAINT "IngestionRowOutcome_state_check" CHECK (state IN ('ACCEPTED','INVALID','REVIEW_REQUIRED') AND operation IN ('CREATE','UPDATE','UNCHANGED','NONE')),
  CONSTRAINT "IngestionRowOutcome_error_check" CHECK (cardinality("errorCodes")<=16 AND "errorCodes" <@ ARRAY['INVALID_INPUT','INVALID_KEY','DUPLICATE_KEY','INVALID_PROJECT','PROJECT_CHANGED','INVALID_FIELDS','ROW_IDENTITY_REVIEW','REQUIRED_VALUE','INVALID_FORMULA','INVALID_NUMBER','INVALID_VALUE']::text[]),
  CONSTRAINT "IngestionRowOutcome_projection_shape_check" CHECK (
    (state='ACCEPTED' AND "recordKey" IS NOT NULL AND "recordId" IS NOT NULL AND "sourceRevisionId" IS NOT NULL AND "projectionId" IS NOT NULL)
    OR (state IN ('INVALID','REVIEW_REQUIRED') AND "recordId" IS NULL AND "sourceRevisionId" IS NULL AND "projectionId" IS NULL AND operation='NONE')
  )
);

CREATE FUNCTION public.guard_ingestion_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Ingestion history is immutable';
END $$;
CREATE FUNCTION public.valid_ingestion_mapping(mapping_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; seen_columns text[]:=ARRAY[]::text[]; seen_types text[]:=ARRAY[]::text[]; name_value text; type_value text;
BEGIN
  IF jsonb_typeof(mapping_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF mapping_value->>'kind'='CONNECTOR' THEN
    IF mapping_value-'kind'-'factTypes'<>'{}'::jsonb OR jsonb_typeof(mapping_value->'factTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(mapping_value->'factTypes') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(mapping_value->'factTypes') LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      type_value:=item#>>'{}';
      IF type_value !~ '^[a-z][a-z0-9_.-]{0,95}$' OR type_value=ANY(seen_types) THEN RETURN false; END IF;
      seen_types:=array_append(seen_types,type_value);
    END LOOP;
    RETURN true;
  ELSIF mapping_value->>'kind'='CSV' THEN
    IF mapping_value-'kind'-'sheet'-'identityColumn'-'projectColumn'-'fields'<>'{}'::jsonb OR jsonb_typeof(mapping_value->'sheet') IS DISTINCT FROM 'string' OR jsonb_typeof(mapping_value->'identityColumn') IS DISTINCT FROM 'string' OR jsonb_typeof(mapping_value->'projectColumn') IS DISTINCT FROM 'string' OR jsonb_typeof(mapping_value->'fields') IS DISTINCT FROM 'array' OR jsonb_array_length(mapping_value->'fields') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
    IF length(mapping_value->>'sheet') NOT BETWEEN 1 AND 256 OR btrim(mapping_value->>'sheet')='' OR length(mapping_value->>'identityColumn') NOT BETWEEN 1 AND 256 OR btrim(mapping_value->>'identityColumn')='' OR length(mapping_value->>'projectColumn') NOT BETWEEN 1 AND 256 OR btrim(mapping_value->>'projectColumn')='' OR mapping_value->>'identityColumn'=mapping_value->>'projectColumn' THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(mapping_value->'fields') LOOP
      IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-'column'-'factType'-'type'-'required'<>'{}'::jsonb OR jsonb_typeof(item->'column') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'factType') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'type') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'required') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
      name_value:=item->>'column'; type_value:=item->>'factType';
      IF length(name_value) NOT BETWEEN 1 AND 256 OR btrim(name_value)='' OR type_value !~ '^[a-z][a-z0-9_.-]{0,95}$' OR item->>'type' NOT IN ('text','date','number','boolean') OR name_value=ANY(seen_columns) OR type_value=ANY(seen_types) THEN RETURN false; END IF;
      seen_columns:=array_append(seen_columns,name_value); seen_types:=array_append(seen_types,type_value);
    END LOOP;
    RETURN true;
  END IF;
  RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.guard_ingestion_configuration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE project_row record; grant_row public."AccessGrant"%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.sealed THEN RAISE EXCEPTION 'Ingestion configuration must start unsealed'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed') THEN
    RAISE EXCEPTION 'Invalid ingestion configuration seal';
  END IF;
  IF public.valid_ingestion_mapping(NEW.mapping) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid ingestion mapping configuration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW.revision)
    THEN RAISE EXCEPTION 'Ingestion configuration scope is empty'; END IF;
  IF (SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW.revision)>100 THEN RAISE EXCEPTION 'Ingestion configuration project limit exceeded'; END IF;
  FOR project_row IN
    SELECT p."projectId",pr."portfolioId" FROM public."IngestionConfigurationProject" p
    JOIN public."Project" pr ON pr."customerId"=p."customerId" AND pr.id=p."projectId"
    WHERE p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p."configRevision"=NEW.revision
    ORDER BY p."projectId" FOR UPDATE OF p,pr
  LOOP
    SELECT * INTO grant_row FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=NEW."changedBy" AND g.role='pmo_admin'
      AND ((g."scopeType"='project' AND g."scopeId"=project_row."projectId") OR (g."scopeType"='portfolio' AND g."scopeId"=project_row."portfolioId"))
    ORDER BY (g."scopeType"='project') DESC,g.id LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion configuration requires current PMO project grants'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_configuration_child() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE; existing_count integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion configuration scope is immutable'; END IF;
  SELECT * INTO cfg FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND revision=NEW."configRevision" FOR UPDATE;
  IF NOT FOUND OR cfg.sealed THEN RAISE EXCEPTION 'Ingestion configuration is absent or sealed'; END IF;
  IF TG_TABLE_NAME='IngestionConfigurationProject' THEN
    SELECT count(*) INTO existing_count FROM public."IngestionConfigurationProject"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW."configRevision";
    IF existing_count>=100 THEN RAISE EXCEPTION 'Ingestion configuration project limit exceeded'; END IF;
  ELSE
    SELECT count(*) INTO existing_count FROM public."IngestionConfigurationReader"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW."configRevision" AND "projectId"=NEW."projectId";
    IF existing_count>=100 THEN RAISE EXCEPTION 'Ingestion configuration reader limit exceeded'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ingestion source identity is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."currentConfigRevision" IS NOT NULL OR NEW."mappingRevision"<>0 OR NEW."cursorRevision"<>0 OR NEW."syncGeneration"<>1 THEN RAISE EXCEPTION 'Invalid initial ingestion source'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW."customerId",NEW."sourceType",NEW.origin,NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."sourceType",OLD.origin,OLD."createdAt") THEN RAISE EXCEPTION 'Ingestion source identity is immutable'; END IF;
  IF NEW."currentConfigRevision" IS DISTINCT FROM OLD."currentConfigRevision" OR NEW."mappingRevision" IS DISTINCT FROM OLD."mappingRevision" THEN
    IF (OLD."currentConfigRevision" IS NULL AND (NEW."currentConfigRevision"<>1 OR NEW."mappingRevision"<>1)) OR (OLD."currentConfigRevision" IS NOT NULL AND NEW."currentConfigRevision"<>OLD."currentConfigRevision"+1) THEN RAISE EXCEPTION 'Invalid ingestion configuration revision'; END IF;
    SELECT * INTO cfg FROM public."IngestionConfigurationRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW.id AND revision=NEW."currentConfigRevision" AND sealed;
    IF NOT FOUND OR cfg."mappingRevision"<>NEW."mappingRevision" OR NEW."mappingRevision"<OLD."mappingRevision" OR NEW."mappingRevision">OLD."mappingRevision"+1
      OR NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=cfg."auditEventId" AND a."customerId"=cfg."customerId" AND a.actor=cfg."changedBy" AND a.event='ingestion.configuration.changed' AND a."occurredAt"=cfg."createdAt" AND a.detail=jsonb_build_object('sourceId',NEW.id,'configRevision',cfg.revision,'mappingRevision',cfg."mappingRevision")) THEN RAISE EXCEPTION 'Invalid ingestion mapping revision'; END IF;
    IF OLD."currentConfigRevision" IS NOT NULL AND EXISTS (
      SELECT 1 FROM public."IngestionConfigurationRevision" prev
      WHERE prev."customerId"=OLD."customerId" AND prev."sourceId"=OLD.id AND prev.revision=OLD."currentConfigRevision"
        AND ((prev.mapping IS DISTINCT FROM cfg.mapping AND cfg."mappingRevision"<>prev."mappingRevision"+1)
          OR (prev.mapping IS NOT DISTINCT FROM cfg.mapping AND cfg."mappingRevision"<>prev."mappingRevision"))) THEN RAISE EXCEPTION 'Mapping revision does not match mapping semantics'; END IF;
    IF NEW."cursorRevision"<>OLD."cursorRevision" OR NEW."syncGeneration"<>OLD."syncGeneration" OR NEW."cursorEnvelope" IS NOT NULL OR NEW."cursorState"<>'RESET_REQUIRED' THEN RAISE EXCEPTION 'Configuration change must fence the current cursor'; END IF;
  ELSE
    IF NEW."cursorRevision" NOT IN (OLD."cursorRevision",OLD."cursorRevision"+1) OR NEW."syncGeneration" NOT IN (OLD."syncGeneration",OLD."syncGeneration"+1) THEN RAISE EXCEPTION 'Invalid cursor revision'; END IF;
    IF NEW."syncGeneration"=OLD."syncGeneration"+1 AND (NEW."cursorRevision"<>OLD."cursorRevision"+1 OR NEW."cursorEnvelope" IS NOT NULL OR NEW."cursorState"<>'READY') THEN RAISE EXCEPTION 'Invalid cursor reset'; END IF;
    IF NEW."syncGeneration"=OLD."syncGeneration" AND NEW."cursorRevision"=OLD."cursorRevision" AND ROW(NEW."cursorEnvelope",NEW."cursorState") IS DISTINCT FROM ROW(OLD."cursorEnvelope",OLD."cursorState") THEN RAISE EXCEPTION 'Cursor content requires a revision'; END IF;
    IF NEW."cursorRevision"=OLD."cursorRevision"+1 AND NOT EXISTS (
      SELECT 1 FROM public."IngestionCursorTransition" t
      JOIN public."IngestionOperationReceipt" r ON r.id=t."receiptId" AND r."customerId"=t."customerId" AND r."sourceId"=t."sourceId"
      WHERE t."customerId"=NEW."customerId" AND t."sourceId"=NEW.id AND t."generationBefore"=OLD."syncGeneration" AND t."generationAfter"=NEW."syncGeneration" AND t."cursorRevisionBefore"=OLD."cursorRevision" AND t."cursorRevisionAfter"=NEW."cursorRevision" AND t."stateAfter"=NEW."cursorState" AND t."cursorEnvelopeHash" IS NOT DISTINCT FROM CASE WHEN NEW."cursorEnvelope" IS NULL THEN NULL ELSE encode(sha256(convert_to(NEW."cursorEnvelope",'UTF8')),'hex') END
        AND ((r.kind='SYNC_RESET' AND NEW."lastSuccessReceiptId" IS NOT DISTINCT FROM OLD."lastSuccessReceiptId") OR (r.kind='CONNECTOR_PAGE' AND NEW."lastSuccessReceiptId"=r.id))
    ) THEN RAISE EXCEPTION 'Cursor advance requires an exact operation receipt'; END IF;
  END IF;
  IF NEW."healthState" NOT IN ('UNKNOWN','HEALTHY','DEGRADED','FAILED') OR NEW."healthCode" NOT IN ('NONE','INVALID_CREDENTIALS','EXPIRED_CREDENTIALS','PERMISSION_DENIED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE','INVALID_RESPONSE','NOT_FOUND','UNKNOWN_OUTCOME','INTEGRITY_CONFLICT','CURSOR_CONFLICT') THEN RAISE EXCEPTION 'Invalid ingestion health'; END IF;
  IF ROW(NEW."healthState",NEW."healthCode",NEW."healthCheckedAt") IS DISTINCT FROM ROW(OLD."healthState",OLD."healthCode",OLD."healthCheckedAt") AND NOT EXISTS (
    SELECT 1 FROM public."AuditEvent" a WHERE a."customerId"=NEW."customerId" AND a.actor IS NOT NULL AND a.event='ingestion.health.updated' AND a."occurredAt"=NEW."healthCheckedAt" AND a.detail=jsonb_build_object('sourceId',NEW.id,'state',NEW."healthState",'code',NEW."healthCode")
      AND NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
        WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW.id AND cp."configRevision"=NEW."currentConfigRevision"
          AND (NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" cr WHERE cr."customerId"=cp."customerId" AND cr."sourceId"=cp."sourceId" AND cr."configRevision"=cp."configRevision" AND cr."projectId"=cp."projectId" AND cr.subject=a.actor)
            OR NOT EXISTS (SELECT 1 FROM public."AccessGrant" g WHERE g."customerId"=cp."customerId" AND g.subject=a.actor AND g.role IN ('project_manager','portfolio_manager','pmo_admin') AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))))
  ) THEN RAISE EXCEPTION 'Ingestion health update lacks current source and project authorization'; END IF;
  IF NEW."lastSuccessReceiptId" IS DISTINCT FROM OLD."lastSuccessReceiptId" AND NEW."lastSuccessReceiptId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r.id=NEW."lastSuccessReceiptId" AND r."customerId"=NEW."customerId" AND r."sourceId"=NEW.id AND r.kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT')) THEN RAISE EXCEPTION 'Invalid last successful ingestion receipt'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_retention() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE admin_grant uuid;
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (to_jsonb(NEW)-'retentionHours'-'revision'-'changedBy'-'changedAt') IS DISTINCT FROM (to_jsonb(OLD)-'retentionHours'-'revision'-'changedBy'-'changedAt'))
    THEN RAISE EXCEPTION 'Invalid ingestion retention update'; END IF;
  IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Ingestion retention revision must advance'; END IF;
  SELECT id INTO admin_grant FROM public."AccessGrant" WHERE "customerId"=NEW."customerId" AND subject=NEW."changedBy" AND role='system_admin' ORDER BY id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion retention requires a current system administrator grant'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=NEW."auditEventId" AND a."customerId"=NEW."customerId" AND a.actor=NEW."changedBy" AND a.event='ingestion.retention.changed' AND a."occurredAt"=NEW."changedAt" AND a.detail=jsonb_build_object('retentionHours',NEW."retentionHours",'revision',NEW.revision)) THEN RAISE EXCEPTION 'Ingestion retention update lacks its audit'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'External record identity is immutable'; END IF;
  SELECT c.* INTO cfg FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c
    ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision"
    WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId" AND c.sealed AND c."mappingRevision"=s."mappingRevision";
  IF NOT FOUND THEN RAISE EXCEPTION 'External record requires a current sealed configuration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionSource" s JOIN public."IngestionConfigurationProject" p ON p."customerId"=s."customerId" AND p."sourceId"=s.id AND p."configRevision"=s."currentConfigRevision" AND p."projectId"=NEW."projectId"
    WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId") THEN RAISE EXCEPTION 'External record outside configured scope'; END IF;
  IF cfg.mapping->>'kind'='CSV' AND (NEW."recordType"<>'spreadsheet:'||(cfg.mapping->>'sheet') OR NEW."recordKey" !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'Spreadsheet identity must use the configured sheet and a hashed row key';
  ELSIF cfg.mapping->>'kind' NOT IN ('CSV','CONNECTOR') THEN
    RAISE EXCEPTION 'External record requires a supported source mapping';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE previous public."IngestionSourceRevision"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion source revision is immutable'; END IF;
  SELECT * INTO previous FROM public."IngestionSourceRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "recordId"=NEW."recordId" AND revision=NEW.revision;
  IF FOUND AND previous."sourceContentHash"<>NEW."sourceContentHash" THEN RAISE EXCEPTION 'Source revision digest conflict'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE; policy public."IngestionRetentionPolicy"%ROWTYPE; mapping_types text[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion proposal projection is immutable'; END IF;
  SELECT c.* INTO cfg FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision"
    WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId";
  IF NOT FOUND OR NEW."mappingRevision"<>cfg."mappingRevision" THEN RAISE EXCEPTION 'Ingestion projection uses stale mapping'; END IF;
  IF cfg.mapping->>'kind'='CONNECTOR' THEN
    SELECT COALESCE(array_agg(value ORDER BY value),'{}'::text[]) INTO mapping_types FROM jsonb_array_elements_text(cfg.mapping->'factTypes');
  ELSIF cfg.mapping->>'kind'='CSV' THEN
    SELECT COALESCE(array_agg(value->>'factType' ORDER BY value->>'factType'),'{}'::text[]) INTO mapping_types FROM jsonb_array_elements(cfg.mapping->'fields') AS field(value);
  ELSE
    RAISE EXCEPTION 'Invalid ingestion mapping kind';
  END IF;
  IF cardinality(NEW."factTypes")>32 OR NEW."factTypes" IS DISTINCT FROM ARRAY(SELECT DISTINCT facts.value FROM unnest(NEW."factTypes") AS facts(value) ORDER BY facts.value)
    OR EXISTS (SELECT 1 FROM unnest(NEW."factTypes") AS facts(value) WHERE facts.value !~ '^[a-z][a-z0-9_.-]{0,95}$' OR NOT facts.value=ANY(mapping_types)) THEN RAISE EXCEPTION 'Ingestion projection fact types are invalid'; END IF;
  SELECT * INTO policy FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion content retention is not configured'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."factTypes") AS facts(value) WHERE NOT EXISTS (SELECT 1 FROM public."IngestionFactStream" s WHERE s."customerId"=NEW."customerId" AND s."sourceId"=NEW."sourceId" AND s."recordId"=NEW."recordId" AND s."factType"=facts.value)) THEN RAISE EXCEPTION 'Projection is missing its stable fact stream'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_content() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE admin_grant uuid; purge_actor text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.proposals IS NULL OR NEW."redactedAt" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" AND revision=NEW."policyRevision") THEN RAISE EXCEPTION 'Invalid ingestion content birth'; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionProposalProjection" x
      JOIN public."IngestionSourceRevision" r ON r."customerId"=x."customerId" AND r."sourceId"=x."sourceId" AND r."recordId"=x."recordId" AND r.id=x."sourceRevisionId"
      JOIN public."IngestionRetentionPolicy" p ON p."customerId"=x."customerId"
      WHERE x."customerId"=NEW."customerId" AND x.id=NEW."projectionId"
        AND clock_timestamp()>=r."receivedAt"+make_interval(hours=>p."retentionHours")) THEN RAISE EXCEPTION 'Expired ingestion source revision cannot regain proposal content'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' OR OLD.proposals IS NULL OR NEW.proposals IS NOT NULL OR NEW."redactedAt" IS NULL OR NEW."redactionAuditEventId" IS NULL OR NEW."redactedAt"<clock_timestamp() OR ROW(NEW."customerId",NEW."sourceId",NEW."recordId",NEW."projectionId",NEW."policyRevision") IS DISTINCT FROM ROW(OLD."customerId",OLD."sourceId",OLD."recordId",OLD."projectionId",OLD."policyRevision") THEN RAISE EXCEPTION 'Ingestion content permits one-way expiry redaction only'; END IF;
  SELECT a.actor INTO purge_actor FROM public."AuditEvent" a WHERE a.id=NEW."redactionAuditEventId" AND a."customerId"=NEW."customerId" AND a.event='ingestion.content.purged' AND a.detail ? 'redactedCount' AND (a.detail->>'redactedCount') ~ '^[1-9][0-9]*$';
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion redaction lacks its audit'; END IF;
  IF purge_actor='restore:quarantine' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND pg_catalog.shobj_description(d.oid,'pg_database') LIKE 'pdaa.restore.quarantine.v1:%') THEN RAISE EXCEPTION 'Restore redaction requires quarantine'; END IF;
  ELSE
    SELECT g.id INTO admin_grant FROM public."AccessGrant" g WHERE g."customerId"=NEW."customerId" AND g.subject=purge_actor AND g.role='system_admin' ORDER BY g.id LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion redaction requires a current system administrator grant'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionProposalProjection" x JOIN public."IngestionSourceRevision" r ON r.id=x."sourceRevisionId" JOIN public."IngestionRetentionPolicy" p ON p."customerId"=r."customerId" WHERE x.id=OLD."projectionId" AND clock_timestamp()<r."receivedAt"+make_interval(hours=>p."retentionHours")) THEN RAISE EXCEPTION 'Ingestion content is not expired'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.require_ingestion_redaction_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE expected integer; actual integer;
BEGIN
  SELECT (detail->>'redactedCount')::integer INTO expected FROM public."AuditEvent" WHERE id=NEW."redactionAuditEventId" AND "customerId"=NEW."customerId" AND event='ingestion.content.purged';
  SELECT count(*)::integer INTO actual FROM public."IngestionProposalContent" WHERE "customerId"=NEW."customerId" AND "redactionAuditEventId"=NEW."redactionAuditEventId" AND proposals IS NULL;
  IF expected IS NULL OR expected<>actual THEN RAISE EXCEPTION 'Ingestion redaction audit count mismatch'; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.guard_ingestion_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion operation receipt is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionSource" s WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId" AND s."currentConfigRevision"=NEW."configRevision" AND s."mappingRevision"=NEW."mappingRevision") THEN RAISE EXCEPTION 'Ingestion receipt uses stale configuration'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_receipt_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; project_row public."Project"%ROWTYPE; source_row public."IngestionSource"%ROWTYPE; grant_row public."AccessGrant"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion receipt scope is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion receipt scope requires its receipt'; END IF;
  SELECT * INTO project_row FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=r."configRevision" AND "projectId"=NEW."projectId") THEN RAISE EXCEPTION 'Ingestion receipt scope is outside its configuration'; END IF;
  SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND OR source_row."currentConfigRevision" IS DISTINCT FROM r."configRevision" THEN RAISE EXCEPTION 'Ingestion receipt configuration is no longer current'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=source_row."currentConfigRevision" AND "projectId"=NEW."projectId" AND subject=r.subject) THEN RAISE EXCEPTION 'Ingestion receipt actor lacks current source-reader access'; END IF;
  SELECT * INTO grant_row FROM public."AccessGrant" g
  WHERE g."customerId"=NEW."customerId" AND g.subject=r.subject AND g.role=NEW."grantRole"
    AND NEW."grantRole" IN ('project_manager','portfolio_manager','pmo_admin')
    AND ((g."scopeType"='project' AND g."scopeId"=project_row.id) OR (g."scopeType"='portfolio' AND g."scopeId"=project_row."portfolioId"))
    AND g.id=NEW."grantId" AND g."scopeType"=NEW."grantScopeType" AND g."scopeId"=NEW."grantScopeId"
  ORDER BY g.id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion receipt requires a current project grant'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.guard_ingestion_cursor_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; s public."IngestionSource"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion cursor transition is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR r.kind NOT IN ('CONNECTOR_PAGE','SYNC_RESET') OR r."generationBefore"<>NEW."generationBefore" OR r."generationAfter"<>NEW."generationAfter" OR r."cursorRevisionBefore"<>NEW."cursorRevisionBefore" OR r."cursorRevisionAfter"<>NEW."cursorRevisionAfter" THEN RAISE EXCEPTION 'Cursor transition does not match its receipt'; END IF;
  SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
  IF NOT FOUND OR s."syncGeneration"<>NEW."generationBefore" OR s."cursorRevision"<>NEW."cursorRevisionBefore" THEN RAISE EXCEPTION 'Cursor transition compare-and-swap failed'; END IF;
  IF r.kind='CONNECTOR_PAGE' AND s."cursorState"<>'READY' THEN RAISE EXCEPTION 'Connector page requires a ready cursor'; END IF;
  IF (r.kind='SYNC_RESET' AND (NEW."generationAfter"<>NEW."generationBefore"+1 OR NEW."cursorRevisionAfter"<>NEW."cursorRevisionBefore"+1 OR NEW."stateAfter"<>'READY' OR NEW."cursorEnvelopeHash" IS NOT NULL))
    OR (r.kind='CONNECTOR_PAGE' AND (NEW."generationAfter"<>NEW."generationBefore" OR NEW."cursorRevisionAfter"<>NEW."cursorRevisionBefore"+1 OR (NEW."stateAfter"='TERMINAL' AND NEW."cursorEnvelopeHash" IS NOT NULL) OR (NEW."stateAfter"='READY' AND NEW."cursorEnvelopeHash" IS NULL))) THEN RAISE EXCEPTION 'Invalid cursor transition'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.require_ingestion_cursor_applied() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public."IngestionSource"%ROWTYPE; r public."IngestionOperationReceipt"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Cursor transition source is missing'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Cursor transition receipt is missing'; END IF;
  IF s."syncGeneration"=NEW."generationAfter" AND s."cursorRevision"=NEW."cursorRevisionAfter" THEN
    IF s."cursorState"=NEW."stateAfter" AND ((NEW."cursorEnvelopeHash" IS NULL AND s."cursorEnvelope" IS NULL) OR (NEW."cursorEnvelopeHash" IS NOT NULL AND encode(sha256(convert_to(s."cursorEnvelope",'UTF8')),'hex')=NEW."cursorEnvelopeHash")) THEN RETURN NULL; END IF;
    IF s."cursorState"='RESET_REQUIRED' AND s."cursorEnvelope" IS NULL AND s."currentConfigRevision">r."configRevision" THEN RETURN NULL; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionCursorTransition" next WHERE next."customerId"=NEW."customerId" AND next."sourceId"=NEW."sourceId" AND next."generationBefore"=NEW."generationAfter" AND next."cursorRevisionBefore"=NEW."cursorRevisionAfter") THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Cursor transition was not applied to its source';
END $$;
CREATE FUNCTION public.guard_ingestion_outcome() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion row outcome is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR NEW.ordinal<1 OR NEW.ordinal>r."outcomeCount" THEN RAISE EXCEPTION 'Ingestion row outcome outside receipt'; END IF;
  IF NEW.state='ACCEPTED' AND (NEW."recordKey" IS NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e."customerId"=NEW."customerId" AND e."sourceId"=NEW."sourceId" AND e.id=NEW."recordId" AND e."recordKey"=NEW."recordKey")) THEN
    RAISE EXCEPTION 'Accepted outcome identity must match its external record';
  END IF;
  IF NEW."projectId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "receiptId"=r.id AND "projectId"=NEW."projectId") THEN RAISE EXCEPTION 'Ingestion row outside authorized receipt scope'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.valid_ingestion_receipt(target uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public."IngestionOperationReceipt"%ROWTYPE; actual_count integer; min_ordinal integer; max_ordinal integer; expected_event text;
BEGIN
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_count,min_ordinal,max_ordinal FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_count<>r."outcomeCount" OR (actual_count>0 AND (min_ordinal<>1 OR max_ordinal<>actual_count)) THEN RETURN false; END IF;
  IF (SELECT count(*) FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=r.id)<>(SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=r."customerId" AND "sourceId"=r."sourceId" AND "configRevision"=r."configRevision")
    OR EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" p WHERE p."customerId"=r."customerId" AND p."sourceId"=r."sourceId" AND p."configRevision"=r."configRevision" AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" s WHERE s."receiptId"=r.id AND s."projectId"=p."projectId")) THEN RETURN false; END IF;
  expected_event:=CASE r.kind WHEN 'CONNECTOR_PAGE' THEN 'ingestion.connector_page.persisted' WHEN 'CONNECTOR_EVENT' THEN 'ingestion.connector_event.persisted' WHEN 'CSV_PREVIEW' THEN 'ingestion.csv_preview.persisted' WHEN 'SYNC_RESET' THEN 'ingestion.sync_reset' END;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=r."auditEventId" AND a."customerId"=r."customerId" AND a.actor=r.subject AND a.event=expected_event AND a."occurredAt"=r."createdAt" AND a.detail=jsonb_build_object(
    'receiptId',r.id,'kind',r.kind,'sourceId',r."sourceId",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",
    'scopeProjectIds',(SELECT COALESCE(jsonb_agg(s."projectId"::text ORDER BY s."projectId"),'[]'::jsonb) FROM public."IngestionReceiptProjectScope" s WHERE s."customerId"=r."customerId" AND s."sourceId"=r."sourceId" AND s."receiptId"=r.id),
    'requestHash',r."requestHash",'outcomeCount',r."outcomeCount")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND (
      (o.state='ACCEPTED' AND (o."recordKey" IS NULL OR NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e.id=o."recordId" AND e."customerId"=o."customerId" AND e."sourceId"=o."sourceId" AND e."projectId"=o."projectId" AND e."recordKey"=o."recordKey") OR NOT EXISTS (SELECT 1 FROM public."IngestionSourceRevision" v WHERE v.id=o."sourceRevisionId" AND v."customerId"=o."customerId" AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" p WHERE p.id=o."projectionId" AND p."customerId"=o."customerId" AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision") OR NOT EXISTS (SELECT 1 FROM public."IngestionProposalContent" c WHERE c."customerId"=o."customerId" AND c."sourceId"=o."sourceId" AND c."recordId"=o."recordId" AND c."projectionId"=o."projectionId") OR o."projectId" IS NULL))
      OR (o.state<>'ACCEPTED' AND (o."projectionId" IS NOT NULL OR cardinality(o."errorCodes")=0)))) THEN RETURN false; END IF;
  IF r.kind='SYNC_RESET' AND (r."outcomeCount"<>0 OR r."generationAfter"<>r."generationBefore"+1 OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind='CONNECTOR_PAGE' AND (r."generationAfter"<>r."generationBefore" OR r."cursorRevisionAfter"<>r."cursorRevisionBefore"+1) THEN RETURN false; END IF;
  IF r.kind IN ('CONNECTOR_PAGE','SYNC_RESET') AND NOT EXISTS (SELECT 1 FROM public."IngestionCursorTransition" t WHERE t."customerId"=r."customerId" AND t."sourceId"=r."sourceId" AND t."receiptId"=r.id AND t."generationBefore"=r."generationBefore" AND t."generationAfter"=r."generationAfter" AND t."cursorRevisionBefore"=r."cursorRevisionBefore" AND t."cursorRevisionAfter"=r."cursorRevisionAfter" AND ((r.kind='SYNC_RESET' AND t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NULL) OR (r.kind='CONNECTOR_PAGE' AND ((t."stateAfter"='TERMINAL' AND t."cursorEnvelopeHash" IS NULL) OR (t."stateAfter"='READY' AND t."cursorEnvelopeHash" IS NOT NULL))))) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.valid_ingestion_proposals(projection_target uuid, proposal_values jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE p public."IngestionProposalProjection"%ROWTYPE; item jsonb; seen text[]:=ARRAY[]::text[]; fact_type text;
BEGIN
  IF jsonb_typeof(proposal_values) IS DISTINCT FROM 'array' OR jsonb_array_length(proposal_values)>32 THEN RETURN false; END IF;
  SELECT * INTO p FROM public."IngestionProposalProjection" WHERE id=projection_target;
  IF NOT FOUND THEN RETURN false; END IF;
  IF encode(sha256(convert_to(proposal_values::text,'UTF8')),'hex')<>p."proposalHash" THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(proposal_values) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-'factType'-'value'<>'{}'::jsonb OR jsonb_typeof(item->'factType') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    fact_type:=item->>'factType';
    IF fact_type !~ '^[a-z][a-z0-9_.-]{0,95}$' OR fact_type=ANY(seen) OR NOT public.valid_project_fact_value(item->'value') THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public."IngestionFactStream" s WHERE s."customerId"=p."customerId" AND s."sourceId"=p."sourceId" AND s."recordId"=p."recordId" AND s."factType"=fact_type) THEN RETURN false; END IF;
    seen:=array_append(seen,fact_type);
  END LOOP;
  IF p."factTypes" IS DISTINCT FROM seen THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE public."IngestionProposalContent" ADD CONSTRAINT "IngestionProposalContent_typed_check" CHECK (proposals IS NULL OR public.valid_ingestion_proposals("projectionId",proposals));
CREATE FUNCTION public.require_ingestion_graph_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE valid boolean;
BEGIN
  IF TG_TABLE_NAME='IngestionExternalRecord' THEN
    SELECT EXISTS (SELECT 1 FROM public."IngestionSourceRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "recordId"=NEW.id) INTO valid;
  ELSIF TG_TABLE_NAME='IngestionSourceRevision' THEN
    SELECT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "recordId"=NEW."recordId" AND "sourceRevisionId"=NEW.id) INTO valid;
  ELSIF TG_TABLE_NAME='IngestionProposalProjection' THEN
    SELECT EXISTS (SELECT 1 FROM public."IngestionProposalContent" WHERE "projectionId"=NEW.id AND "customerId"=NEW."customerId")
      AND EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "projectionId"=NEW.id AND "receiptId" IN (SELECT id FROM public."IngestionOperationReceipt" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId")) INTO valid;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public."IngestionProposalProjection" p WHERE p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p."recordId"=NEW."recordId" AND p."factTypes" @> ARRAY[NEW."factType"]::text[]) INTO valid;
  END IF;
  IF valid IS NOT TRUE THEN RAISE EXCEPTION 'Orphan ingestion identity cannot commit'; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.require_ingestion_source_configured() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision" AND c.sealed WHERE s."customerId"=NEW."customerId" AND s.id=NEW.id AND s."currentConfigRevision" IS NOT NULL AND s."mappingRevision"=c."mappingRevision") THEN
    RAISE EXCEPTION 'Ingestion source configuration must be committed atomically';
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.require_ingestion_configuration_sealed() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationRevision" c JOIN public."IngestionSource" s ON s."customerId"=c."customerId" AND s.id=c."sourceId" AND s."currentConfigRevision"=c.revision AND s."mappingRevision"=c."mappingRevision" WHERE c."customerId"=NEW."customerId" AND c."sourceId"=NEW."sourceId" AND c.revision=NEW.revision AND c.sealed) THEN
    RAISE EXCEPTION 'Ingestion configuration must be sealed and current at COMMIT';
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.require_ingestion_receipt_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='IngestionOperationReceipt' THEN target:=NEW.id; ELSE target:=NEW."receiptId"; END IF;
  IF public.valid_ingestion_receipt(target) IS NOT TRUE THEN RAISE EXCEPTION 'Incomplete ingestion receipt cannot commit'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ingestion_source_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionSource" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_source();
CREATE TRIGGER ingestion_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionConfigurationRevision" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_configuration();
CREATE TRIGGER ingestion_config_project_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionConfigurationProject" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_configuration_child();
CREATE TRIGGER ingestion_config_reader_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionConfigurationReader" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_configuration_child();
CREATE TRIGGER ingestion_retention_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionRetentionPolicy" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_retention();
CREATE TRIGGER ingestion_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionExternalRecord" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_record();
CREATE TRIGGER ingestion_stream_guard BEFORE UPDATE OR DELETE ON public."IngestionFactStream" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_stream_no_truncate BEFORE TRUNCATE ON public."IngestionFactStream" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionSourceRevision" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_revision();
CREATE TRIGGER ingestion_projection_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionProposalProjection" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_projection();
CREATE TRIGGER ingestion_content_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionProposalContent" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_content();
CREATE CONSTRAINT TRIGGER ingestion_redaction_commit AFTER UPDATE ON public."IngestionProposalContent" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_redaction_complete();
CREATE TRIGGER ingestion_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionOperationReceipt" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_receipt();
CREATE TRIGGER ingestion_receipt_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionReceiptProjectScope" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_receipt_scope();
CREATE TRIGGER ingestion_cursor_transition_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionCursorTransition" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_cursor_transition();
CREATE TRIGGER ingestion_outcome_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionRowOutcome" FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_outcome();
CREATE CONSTRAINT TRIGGER ingestion_receipt_commit AFTER INSERT ON public."IngestionOperationReceipt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_receipt_complete();
CREATE CONSTRAINT TRIGGER ingestion_outcome_commit AFTER INSERT ON public."IngestionRowOutcome" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_receipt_complete();
CREATE CONSTRAINT TRIGGER ingestion_cursor_applied_commit AFTER INSERT ON public."IngestionCursorTransition" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_cursor_applied();
CREATE CONSTRAINT TRIGGER ingestion_record_commit AFTER INSERT ON public."IngestionExternalRecord" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_graph_complete();
CREATE CONSTRAINT TRIGGER ingestion_revision_commit AFTER INSERT ON public."IngestionSourceRevision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_graph_complete();
CREATE CONSTRAINT TRIGGER ingestion_projection_commit AFTER INSERT ON public."IngestionProposalProjection" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_graph_complete();
CREATE CONSTRAINT TRIGGER ingestion_stream_commit AFTER INSERT ON public."IngestionFactStream" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_graph_complete();
CREATE CONSTRAINT TRIGGER ingestion_source_configured_commit AFTER INSERT OR UPDATE ON public."IngestionSource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_source_configured();
CREATE CONSTRAINT TRIGGER ingestion_configuration_sealed_commit AFTER INSERT OR UPDATE ON public."IngestionConfigurationRevision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_configuration_sealed();
CREATE TRIGGER ingestion_source_no_truncate BEFORE TRUNCATE ON public."IngestionSource" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_config_no_truncate BEFORE TRUNCATE ON public."IngestionConfigurationRevision" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_config_project_no_truncate BEFORE TRUNCATE ON public."IngestionConfigurationProject" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_config_reader_no_truncate BEFORE TRUNCATE ON public."IngestionConfigurationReader" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_receipt_no_truncate BEFORE TRUNCATE ON public."IngestionOperationReceipt" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_outcome_no_truncate BEFORE TRUNCATE ON public."IngestionRowOutcome" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_receipt_scope_no_truncate BEFORE TRUNCATE ON public."IngestionReceiptProjectScope" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_cursor_transition_no_truncate BEFORE TRUNCATE ON public."IngestionCursorTransition" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_record_no_truncate BEFORE TRUNCATE ON public."IngestionExternalRecord" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_revision_no_truncate BEFORE TRUNCATE ON public."IngestionSourceRevision" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_projection_no_truncate BEFORE TRUNCATE ON public."IngestionProposalProjection" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_retention_no_truncate BEFORE TRUNCATE ON public."IngestionRetentionPolicy" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_content_no_truncate BEFORE TRUNCATE ON public."IngestionProposalContent" FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();

CREATE INDEX "IngestionRecord_project_idx" ON public."IngestionExternalRecord"("customerId","projectId","sourceId");
CREATE INDEX "IngestionReceipt_created_idx" ON public."IngestionOperationReceipt"("customerId","sourceId","createdAt" DESC);
CREATE INDEX "IngestionOutcome_scope_idx" ON public."IngestionRowOutcome"("customerId","sourceId","projectId","receiptId");
CREATE INDEX "IngestionRevision_received_idx" ON public."IngestionSourceRevision"("customerId","receivedAt");

REVOKE ALL ON FUNCTION public.guard_ingestion_immutable(),public.valid_ingestion_mapping(jsonb),public.guard_ingestion_configuration(),public.guard_ingestion_configuration_child(),public.guard_ingestion_source(),public.guard_ingestion_retention(),public.guard_ingestion_record(),public.guard_ingestion_revision(),public.guard_ingestion_projection(),public.guard_ingestion_content(),public.guard_ingestion_receipt(),public.guard_ingestion_receipt_scope(),public.guard_ingestion_cursor_transition(),public.require_ingestion_cursor_applied(),public.guard_ingestion_outcome(),public.require_ingestion_receipt_complete(),public.require_ingestion_redaction_complete(),public.require_ingestion_graph_complete(),public.require_ingestion_source_configured(),public.require_ingestion_configuration_sealed() FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
REVOKE ALL ON FUNCTION public.valid_ingestion_receipt(uuid),public.valid_ingestion_proposals(uuid,jsonb) FROM PUBLIC,pdaa_api,pdaa_worker,pdaa_backup;
