-- FR-CON-006/007/012 / NFR-SEC-001: additive trusted CSV comparison state.
-- Unreleased candidate: native, upgrade, customer and recovery gates are required before merge.
-- A 256-character sheet plus the spreadsheet: prefix requires 268 characters.
ALTER TABLE public."IngestionExternalRecord" ALTER COLUMN "recordType" TYPE varchar(268);
CREATE FUNCTION public.valid_ingestion_csv_state(
  state_customer uuid, state_source uuid, state_mapping integer,
  state_dictionary jsonb, state_rows jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE
  entry jsonb;
  identity_row jsonb;
  field_reference jsonb;
  field_name text;
  previous_field text := '';
  identity_key text;
  previous_key text := '';
  record_id text;
  project_id text;
  projection_id text;
  index_text text;
  field_index integer;
  previous_index integer;
  dictionary_length integer;
  identity_count integer;
  distinct_records integer;
  distinct_projects integer;
  canonical_text text;
BEGIN
  IF state_customer IS NULL OR state_source IS NULL OR state_mapping IS NULL OR state_mapping<=0 THEN RETURN false; END IF;
  IF jsonb_typeof(state_dictionary) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_typeof(state_rows) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  dictionary_length := jsonb_array_length(state_dictionary);
  identity_count := jsonb_array_length(state_rows);
  IF dictionary_length NOT BETWEEN 1 AND 32 OR identity_count>1000 THEN RETURN false; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(state_dictionary) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(entry)<>2 THEN RETURN false; END IF;
    IF jsonb_typeof(entry->0) IS DISTINCT FROM 'string' OR jsonb_typeof(entry->1) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    field_name := entry->>0;
    IF octet_length(field_name) NOT BETWEEN 1 AND 96 THEN RETURN false; END IF;
    IF field_name COLLATE "C" !~ '^[a-z][a-z0-9_.-]{0,95}$'
      OR field_name COLLATE "C" ~ '[^a-z0-9_.-]'
      OR field_name COLLATE "C" <= previous_field COLLATE "C"
      OR entry->>1 NOT IN ('text','date','number','boolean') THEN RETURN false; END IF;
    previous_field := field_name;
  END LOOP;
  FOR identity_row IN SELECT value FROM jsonb_array_elements(state_rows) LOOP
    IF jsonb_typeof(identity_row) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(identity_row)<>4 THEN RETURN false; END IF;
    IF jsonb_typeof(identity_row->0) IS DISTINCT FROM 'string'
      OR jsonb_typeof(identity_row->1) IS DISTINCT FROM 'string'
      OR jsonb_typeof(identity_row->2) IS DISTINCT FROM 'string'
      OR jsonb_typeof(identity_row->3) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    identity_key := identity_row->>0;
    record_id := identity_row->>1;
    project_id := identity_row->>2;
    IF octet_length(identity_key)<>64 OR octet_length(record_id)<>36 OR octet_length(project_id)<>36 THEN RETURN false; END IF;
    IF identity_key COLLATE "C" !~ '^[a-f0-9]{64}$'
      OR identity_key COLLATE "C" <= previous_key COLLATE "C"
      OR record_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      OR project_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
    IF jsonb_array_length(identity_row->3)>32 THEN RETURN false; END IF;
    previous_index := -1;
    FOR field_reference IN SELECT value FROM jsonb_array_elements(identity_row->3) LOOP
      IF jsonb_typeof(field_reference) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(field_reference)<>2 THEN RETURN false; END IF;
      IF jsonb_typeof(field_reference->0) IS DISTINCT FROM 'string'
        OR jsonb_typeof(field_reference->1) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      index_text := field_reference->>0;
      projection_id := field_reference->>1;
      IF octet_length(index_text) NOT BETWEEN 1 AND 2 OR octet_length(projection_id)<>36 THEN RETURN false; END IF;
      IF index_text COLLATE "C" !~ '^(0|[1-9][0-9]?)$' OR index_text COLLATE "C" ~ '[^0-9]'
        OR projection_id COLLATE "C" !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
      field_index := index_text::integer;
      IF field_index<=previous_index OR field_index>=dictionary_length THEN RETURN false; END IF;
      previous_index := field_index;
    END LOOP;
    previous_key := identity_key;
  END LOOP;
  -- Set-based bounded counts avoid a growing per-row linear membership scan.
  SELECT count(DISTINCT (value->>1) COLLATE "C"),count(DISTINCT (value->>2) COLLATE "C")
    INTO distinct_records,distinct_projects FROM jsonb_array_elements(state_rows);
  IF distinct_records<>identity_count OR distinct_projects>100 THEN RETURN false; END IF;
  -- Permitted tokens are all ASCII and contain neither spaces nor escapes.
  canonical_text := replace(jsonb_build_array('pdaa.csv.state.v1',state_customer::text,
    state_source::text,state_mapping::text,state_dictionary,state_rows)::text,' ','');
  RETURN octet_length(convert_to(canonical_text,'UTF8'))<=2097152;
END $$;

CREATE FUNCTION public.ingestion_csv_state_text(
  state_customer uuid, state_source uuid, state_mapping integer,
  state_dictionary jsonb, state_rows jsonb
) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.valid_ingestion_csv_state(state_customer,state_source,state_mapping,state_dictionary,state_rows) IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN replace(jsonb_build_array('pdaa.csv.state.v1',state_customer::text,
    state_source::text,state_mapping::text,state_dictionary,state_rows)::text,' ','');
END $$;

REVOKE ALL ON FUNCTION public.valid_ingestion_csv_state(uuid,uuid,integer,jsonb,jsonb),
  public.ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb) FROM PUBLIC;

CREATE TABLE public."IngestionCsvHead" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "activationConfigRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  dictionary jsonb NOT NULL,
  readiness varchar(24) NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  "currentReceiptId" uuid,
  "stateHash" char(64),
  "canonicalHistoryBytes" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "IngestionCsvHead_pkey" PRIMARY KEY ("customerId","sourceId"),
  CONSTRAINT "IngestionCsvHead_mapping_key" UNIQUE ("customerId","sourceId","mappingRevision"),
  CONSTRAINT "IngestionCsvHead_source_fkey" FOREIGN KEY ("customerId","sourceId")
    REFERENCES public."IngestionSource"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCsvHead_configuration_fkey" FOREIGN KEY ("customerId","sourceId","activationConfigRevision","mappingRevision")
    REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision,"mappingRevision")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCsvHead_revisions_check" CHECK ("activationConfigRevision">0 AND "mappingRevision">0),
  CONSTRAINT "IngestionCsvHead_capacity_check" CHECK (revision BETWEEN 0 AND 4096 AND "canonicalHistoryBytes" BETWEEN 0 AND 268435456),
  CONSTRAINT "IngestionCsvHead_readiness_check" CHECK (readiness IN ('READY','LEGACY_UNAVAILABLE')),
  CONSTRAINT "IngestionCsvHead_shape_check" CHECK (
    (readiness='LEGACY_UNAVAILABLE' AND revision=0 AND "currentReceiptId" IS NULL AND "stateHash" IS NULL AND "canonicalHistoryBytes"=0)
    OR (readiness='READY' AND "stateHash" IS NOT NULL AND "stateHash" ~ '^[a-f0-9]{64}$'
      AND ((revision=0 AND "currentReceiptId" IS NULL AND "canonicalHistoryBytes"=0)
        OR (revision>0 AND "currentReceiptId" IS NOT NULL AND "canonicalHistoryBytes">0)))
  )
);
CREATE TABLE public."IngestionCsvContext" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL,
  "configRevision" integer NOT NULL,
  "mappingRevision" integer NOT NULL,
  revision bigint NOT NULL,
  "predecessorReceiptId" uuid,
  "predecessorRevision" bigint NOT NULL,
  "predecessorHash" char(64) NOT NULL,
  rows jsonb NOT NULL,
  "canonicalBytes" integer NOT NULL,
  "stateHash" char(64) NOT NULL,
  CONSTRAINT "IngestionCsvContext_pkey" PRIMARY KEY ("receiptId"),
  CONSTRAINT "IngestionCsvContext_revision_key" UNIQUE ("customerId","sourceId",revision),
  CONSTRAINT "IngestionCsvContext_predecessor_key" UNIQUE ("customerId","sourceId",revision,"receiptId","stateHash"),
  CONSTRAINT "IngestionCsvContext_receipt_fkey" FOREIGN KEY ("customerId","sourceId","receiptId")
    REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCsvContext_configuration_fkey" FOREIGN KEY ("customerId","sourceId","configRevision","mappingRevision")
    REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision,"mappingRevision")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCsvContext_head_fkey" FOREIGN KEY ("customerId","sourceId","mappingRevision")
    REFERENCES public."IngestionCsvHead"("customerId","sourceId","mappingRevision") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionCsvContext_predecessor_fkey" FOREIGN KEY ("customerId","sourceId","predecessorRevision","predecessorReceiptId","predecessorHash")
    REFERENCES public."IngestionCsvContext"("customerId","sourceId",revision,"receiptId","stateHash")
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "IngestionCsvContext_revision_check" CHECK (revision BETWEEN 1 AND 4096 AND "predecessorRevision"=revision-1),
  CONSTRAINT "IngestionCsvContext_parent_check" CHECK ((revision=1)=("predecessorReceiptId" IS NULL)),
  CONSTRAINT "IngestionCsvContext_hash_check" CHECK ("predecessorHash" ~ '^[a-f0-9]{64}$' AND "stateHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "IngestionCsvContext_bytes_check" CHECK ("canonicalBytes" BETWEEN 1 AND 2097152),
  CONSTRAINT "IngestionCsvContext_rows_check" CHECK (jsonb_typeof(rows)='array' AND jsonb_array_length(rows)<=1000)
);
REVOKE ALL ON TABLE public."IngestionCsvHead",public."IngestionCsvContext" FROM PUBLIC;
ALTER TABLE public."IngestionCsvHead" ADD CONSTRAINT "IngestionCsvHead_current_context_fkey"
  FOREIGN KEY ("customerId","sourceId",revision,"currentReceiptId","stateHash")
  REFERENCES public."IngestionCsvContext"("customerId","sourceId",revision,"receiptId","stateHash")
  ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "IngestionCsvContext_configuration_idx" ON public."IngestionCsvContext"("customerId","sourceId","configRevision","mappingRevision");
CREATE INDEX "IngestionCsvContext_parent_idx" ON public."IngestionCsvContext"("customerId","sourceId","predecessorRevision");

ALTER TABLE public."IngestionCsvHead" ADD CONSTRAINT "IngestionCsvHead_dictionary_check"
  CHECK (public.valid_ingestion_csv_state("customerId","sourceId","mappingRevision",dictionary,'[]'::jsonb) IS TRUE);

-- Historical validation never reads proposal plaintext, current grants or time.
-- It does not call valid_ingestion_receipt or valid_ingestion_csv_head.
CREATE FUNCTION public.valid_ingestion_csv_context(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE
  c public."IngestionCsvContext"%ROWTYPE;
  h public."IngestionCsvHead"%ROWTYPE;
  r public."IngestionOperationReceipt"%ROWTYPE;
  parent public."IngestionCsvContext"%ROWTYPE;
  mapping_value jsonb;
  activation_mapping jsonb;
  expected_dictionary jsonb;
  prior_rows jsonb := '[]'::jsonb;
  encoded text;
  prior_encoded text;
  expected_rows jsonb;
BEGIN
  SELECT * INTO c FROM public."IngestionCsvContext" WHERE "receiptId"=target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO h FROM public."IngestionCsvHead" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId";
  IF NOT FOUND OR h.readiness<>'READY' OR c."mappingRevision"<>h."mappingRevision"
    OR c.revision NOT BETWEEN 1 AND h.revision OR c."predecessorRevision"<>c.revision-1 THEN RETURN false; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=c."receiptId" AND "customerId"=c."customerId" AND "sourceId"=c."sourceId";
  IF NOT FOUND OR r.kind<>'CSV_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
    OR ROW(r."configRevision",r."mappingRevision") IS DISTINCT FROM ROW(c."configRevision",c."mappingRevision") THEN RETURN false; END IF;
  SELECT mapping INTO mapping_value FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND revision=c."configRevision" AND "mappingRevision"=c."mappingRevision" AND sealed;
  SELECT mapping INTO activation_mapping FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId" AND revision=h."activationConfigRevision" AND "mappingRevision"=h."mappingRevision" AND sealed;
  IF mapping_value IS NULL OR activation_mapping IS NULL OR mapping_value->>'kind' IS DISTINCT FROM 'CSV'
    OR mapping_value IS DISTINCT FROM activation_mapping OR public.valid_ingestion_mapping(mapping_value) IS NOT TRUE THEN RETURN false; END IF;
  SELECT jsonb_agg(jsonb_build_array(value->>'factType',value->>'type') ORDER BY (value->>'factType') COLLATE "C")
    INTO expected_dictionary FROM jsonb_array_elements(mapping_value->'fields');
  IF h.dictionary IS DISTINCT FROM expected_dictionary THEN RETURN false; END IF;
  encoded := public.ingestion_csv_state_text(c."customerId",c."sourceId",c."mappingRevision",h.dictionary,c.rows);
  IF encoded IS NULL OR octet_length(convert_to(encoded,'UTF8'))<>c."canonicalBytes"
    OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>c."stateHash" THEN RETURN false; END IF;
  IF c.revision=1 THEN
    IF c."predecessorReceiptId" IS NOT NULL THEN RETURN false; END IF;
    prior_encoded := public.ingestion_csv_state_text(c."customerId",c."sourceId",c."mappingRevision",h.dictionary,prior_rows);
    IF prior_encoded IS NULL OR encode(sha256(convert_to(prior_encoded,'UTF8')),'hex')<>c."predecessorHash" THEN RETURN false; END IF;
  ELSE
    SELECT * INTO parent FROM public."IngestionCsvContext"
      WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND "receiptId"=c."predecessorReceiptId"
        AND revision=c."predecessorRevision" AND "stateHash"=c."predecessorHash" AND "mappingRevision"=c."mappingRevision";
    IF NOT FOUND THEN RETURN false; END IF;
    prior_rows := parent.rows;
    prior_encoded := public.ingestion_csv_state_text(c."customerId",c."sourceId",c."mappingRevision",h.dictionary,prior_rows);
    IF prior_encoded IS NULL OR octet_length(convert_to(prior_encoded,'UTF8'))<>parent."canonicalBytes"
      OR encode(sha256(convert_to(prior_encoded,'UTF8')),'hex')<>parent."stateHash" THEN RETURN false; END IF;
  END IF;

  -- A comparison can widen the complete prior configuration scope, never narrow
  -- it merely because one configured project had no accepted observation yet.
  IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" previous_scope
    WHERE previous_scope."customerId"=c."customerId" AND previous_scope."sourceId"=c."sourceId"
      AND previous_scope."configRevision"=CASE WHEN c.revision=1 THEN h."activationConfigRevision" ELSE parent."configRevision" END
      AND NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" current_scope
        WHERE current_scope."customerId"=c."customerId" AND current_scope."sourceId"=c."sourceId"
          AND current_scope."configRevision"=c."configRevision" AND current_scope."projectId"=previous_scope."projectId")) THEN RETURN false; END IF;
  -- Every retained identity belongs to the receipt's immutable mapping and scope.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(c.rows) identity_row
    WHERE NOT EXISTS (
      SELECT 1 FROM public."IngestionExternalRecord" e
      JOIN public."IngestionConfigurationProject" cp ON cp."customerId"=e."customerId" AND cp."sourceId"=e."sourceId"
        AND cp."projectId"=e."projectId" AND cp."configRevision"=c."configRevision"
      WHERE e."customerId"=c."customerId" AND e."sourceId"=c."sourceId" AND e.id=(identity_row->>1)::uuid
        AND e."projectId"=(identity_row->>2)::uuid AND e."recordKey" COLLATE "C"=(identity_row->>0) COLLATE "C"
        AND e."recordType" COLLATE "C"=('spreadsheet:'||(mapping_value->>'sheet')) COLLATE "C"
    )
  ) THEN RETURN false; END IF;
  IF EXISTS (
    WITH refs AS MATERIALIZED (
      SELECT (identity_row->>1)::uuid AS record_id,(field_ref->>1)::uuid AS projection_id,
        (h.dictionary->((field_ref->>0)::integer)->>0) COLLATE "C" AS field_name
      FROM jsonb_array_elements(c.rows) identity_row
      CROSS JOIN LATERAL jsonb_array_elements(identity_row->3) field_ref
    ), required_pairs AS MATERIALIZED (
      SELECT DISTINCT record_id,projection_id FROM refs
    ), bindings AS MATERIALIZED (
      SELECT required.record_id,required.projection_id,p."factTypes" AS fact_types,
        (p.id IS NOT NULL AND content."projectionId" IS NOT NULL) AS valid
      FROM required_pairs required
      LEFT JOIN public."IngestionProposalProjection" p ON p.id=required.projection_id
        AND p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
        AND p."recordId"=required.record_id AND p."mappingRevision"=c."mappingRevision"
      LEFT JOIN public."IngestionProposalContent" content ON content."customerId"=p."customerId" AND content."sourceId"=p."sourceId"
        AND content."recordId"=p."recordId" AND content."projectionId"=p.id
    )
    SELECT 1 FROM refs ref LEFT JOIN bindings binding
      ON binding.record_id=ref.record_id AND binding.projection_id=ref.projection_id
    WHERE binding.valid IS NOT TRUE OR (ref.field_name COLLATE "C"=ANY(binding.fact_types)) IS NOT TRUE
  ) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id
    AND ROW(o."customerId",o."sourceId") IS DISTINCT FROM ROW(c."customerId",c."sourceId")) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND o.state='ACCEPTED'
    AND (cardinality(o."errorCodes")<>0 OR NOT EXISTS (
      SELECT 1 FROM public."IngestionProposalProjection" p
      JOIN public."IngestionExternalRecord" e ON e."customerId"=p."customerId" AND e."sourceId"=p."sourceId" AND e.id=p."recordId"
      JOIN public."IngestionProposalContent" content ON content."customerId"=p."customerId" AND content."sourceId"=p."sourceId"
        AND content."recordId"=p."recordId" AND content."projectionId"=p.id
      WHERE p.id=o."projectionId" AND p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
        AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=c."mappingRevision"
        AND e."recordKey" COLLATE "C"=o."recordKey" COLLATE "C" AND e."projectId"=o."projectId"
        AND e."recordType" COLLATE "C"=('spreadsheet:'||(mapping_value->>'sheet')) COLLATE "C"
    ))) THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id
    GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED' AND (
      (cardinality(p."factTypes")=0 AND o.operation IS DISTINCT FROM
        CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior
          WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C") THEN 'UNCHANGED' ELSE 'NONE' END)
      OR EXISTS (SELECT 1 FROM unnest(p."factTypes") ft(value) WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(h.dictionary) entry WHERE (entry->>0) COLLATE "C"=ft.value COLLATE "C"))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(mapping_value->'fields') field
        WHERE field->>'required'='true' AND NOT ((field->>'factType') COLLATE "C"=ANY(p."factTypes")))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C"
        AND ROW((prior->>1)::uuid,(prior->>2)::uuid) IS DISTINCT FROM ROW(o."recordId",o."projectId"))
      OR (cardinality(p."factTypes")>0 AND (
        (NOT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C") AND o.operation<>'CREATE')
        OR (EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C") AND o.operation NOT IN ('UPDATE','UNCHANGED'))
      ))
    )
  ) THEN RETURN false; END IF;

  WITH dictionary AS (
    SELECT (ordinal-1)::integer AS field_index,entry->>0 AS fact_type
    FROM jsonb_array_elements(h.dictionary) WITH ORDINALITY d(entry,ordinal)
  ), prior AS (
    SELECT (entry->>0) COLLATE "C" AS key,(entry->>1)::uuid AS record_id,(entry->>2)::uuid AS project_id,entry->3 AS refs
    FROM jsonb_array_elements(prior_rows) entry
  ), observed AS (
    SELECT o."recordKey" COLLATE "C" AS key,o."recordId" AS record_id,o."projectId" AS project_id,p.id AS projection_id,p."factTypes" AS fact_types
    FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED'
  ), identities AS (
    SELECT key,record_id,project_id FROM prior UNION SELECT key,record_id,project_id FROM observed
  ), supplied AS (
    SELECT o.key,d.field_index,o.projection_id FROM observed o CROSS JOIN LATERAL unnest(o.fact_types) ft(value)
    JOIN dictionary d ON d.fact_type COLLATE "C"=ft.value COLLATE "C"
  ), carried AS (
    SELECT p.key,(ref->>0)::integer AS field_index,(ref->>1)::uuid AS projection_id
    FROM prior p CROSS JOIN LATERAL jsonb_array_elements(p.refs) ref
    WHERE NOT EXISTS (SELECT 1 FROM supplied s WHERE s.key=p.key AND s.field_index=(ref->>0)::integer)
  ), refs AS (
    SELECT * FROM supplied UNION ALL SELECT * FROM carried
  ), grouped_refs AS (
    SELECT key,jsonb_agg(jsonb_build_array(field_index::text,projection_id::text) ORDER BY field_index) AS refs
    FROM refs GROUP BY key
  ), merged AS (
    SELECT i.key,jsonb_build_array(i.key,i.record_id::text,i.project_id::text,COALESCE(g.refs,'[]'::jsonb)) AS entry
    FROM identities i LEFT JOIN grouped_refs g ON g.key=i.key
  ) SELECT COALESCE(jsonb_agg(entry ORDER BY key COLLATE "C"),'[]'::jsonb) INTO expected_rows FROM merged;
  RETURN c.rows=expected_rows;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION public.valid_ingestion_csv_head(customer_target uuid,source_target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE h public."IngestionCsvHead"%ROWTYPE; activation_mapping jsonb; expected_dictionary jsonb;
  context_count bigint; history_bytes bigint; last_revision bigint; empty_text text;
BEGIN
  SELECT * INTO h FROM public."IngestionCsvHead" WHERE "customerId"=customer_target AND "sourceId"=source_target;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT mapping INTO activation_mapping FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId" AND revision=h."activationConfigRevision" AND "mappingRevision"=h."mappingRevision" AND sealed;
  IF activation_mapping IS NULL OR activation_mapping->>'kind' IS DISTINCT FROM 'CSV'
    OR public.valid_ingestion_mapping(activation_mapping) IS NOT TRUE THEN RETURN false; END IF;
  SELECT jsonb_agg(jsonb_build_array(value->>'factType',value->>'type') ORDER BY (value->>'factType') COLLATE "C")
    INTO expected_dictionary FROM jsonb_array_elements(activation_mapping->'fields');
  IF h.dictionary IS DISTINCT FROM expected_dictionary THEN RETURN false; END IF;
  SELECT count(*),COALESCE(sum("canonicalBytes"),0),COALESCE(max(revision),0) INTO context_count,history_bytes,last_revision
    FROM public."IngestionCsvContext" WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId";
  IF h.revision NOT BETWEEN 0 AND 4096 OR h."canonicalHistoryBytes" NOT BETWEEN 0 AND 268435456
    OR context_count<>h.revision OR history_bytes<>h."canonicalHistoryBytes" OR last_revision<>h.revision THEN RETURN false; END IF;
  IF h.readiness='LEGACY_UNAVAILABLE' THEN
    RETURN h.revision=0 AND h."currentReceiptId" IS NULL AND h."stateHash" IS NULL AND h."canonicalHistoryBytes"=0
      AND (EXISTS (SELECT 1 FROM public."IngestionExternalRecord" WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId")
        OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId" AND kind='CSV_PREVIEW'));
  END IF;
  IF h.readiness<>'READY' OR h."stateHash" IS NULL THEN RETURN false; END IF;
  IF h.revision=0 THEN
    empty_text:=public.ingestion_csv_state_text(h."customerId",h."sourceId",h."mappingRevision",h.dictionary,'[]'::jsonb);
    RETURN empty_text IS NOT NULL AND h."currentReceiptId" IS NULL AND h."canonicalHistoryBytes"=0
      AND encode(sha256(convert_to(empty_text,'UTF8')),'hex')=h."stateHash";
  END IF;
  RETURN EXISTS (SELECT 1 FROM public."IngestionCsvContext" c
    WHERE c."customerId"=h."customerId" AND c."sourceId"=h."sourceId" AND c."receiptId"=h."currentReceiptId"
      AND c.revision=h.revision AND c."stateHash"=h."stateHash")
    AND public.valid_ingestion_csv_context(h."currentReceiptId") IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

REVOKE ALL ON FUNCTION public.valid_ingestion_csv_context(uuid),public.valid_ingestion_csv_head(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION public.guard_ingestion_csv_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public."IngestionSource"%ROWTYPE; cfg public."IngestionConfigurationRevision"%ROWTYPE;
  successor public."IngestionCsvContext"%ROWTYPE; receipt public."IngestionOperationReceipt"%ROWTYPE;
  expected_dictionary jsonb; expected_readiness text; expected_hash text; empty_text text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CSV comparison history is immutable'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR ROW(s."currentConfigRevision",s."mappingRevision") IS DISTINCT FROM ROW(NEW."activationConfigRevision",NEW."mappingRevision") THEN
      RAISE EXCEPTION 'Invalid CSV comparison initialization';
    END IF;
    SELECT * INTO cfg FROM public."IngestionConfigurationRevision" WHERE "customerId"=s."customerId" AND "sourceId"=s.id
      AND revision=s."currentConfigRevision" AND "mappingRevision"=s."mappingRevision" AND sealed;
    IF NOT FOUND OR cfg.mapping->>'kind' IS DISTINCT FROM 'CSV' OR public.valid_ingestion_mapping(cfg.mapping) IS NOT TRUE THEN
      RAISE EXCEPTION 'Invalid CSV comparison initialization';
    END IF;
    SELECT jsonb_agg(jsonb_build_array(value->>'factType',value->>'type') ORDER BY (value->>'factType') COLLATE "C")
      INTO expected_dictionary FROM jsonb_array_elements(cfg.mapping->'fields');
    expected_readiness:=CASE WHEN EXISTS (SELECT 1 FROM public."IngestionExternalRecord" WHERE "customerId"=s."customerId" AND "sourceId"=s.id)
      OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" WHERE "customerId"=s."customerId" AND "sourceId"=s.id AND kind='CSV_PREVIEW')
      THEN 'LEGACY_UNAVAILABLE' ELSE 'READY' END;
    IF expected_readiness='READY' THEN
      empty_text:=public.ingestion_csv_state_text(s."customerId",s.id,s."mappingRevision",expected_dictionary,'[]'::jsonb);
      IF empty_text IS NULL THEN RAISE EXCEPTION 'Invalid CSV comparison initialization'; END IF;
      expected_hash:=encode(sha256(convert_to(empty_text,'UTF8')),'hex');
    END IF;
    IF NEW.dictionary IS DISTINCT FROM expected_dictionary OR
      ROW(NEW.readiness,NEW.revision,NEW."currentReceiptId",NEW."stateHash"::text,NEW."canonicalHistoryBytes")
      IS DISTINCT FROM ROW(expected_readiness,0::bigint,NULL::uuid,expected_hash,0::bigint) THEN
      RAISE EXCEPTION 'Invalid CSV comparison initialization';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.readiness<>'READY' OR
    (to_jsonb(NEW)-'revision'-'currentReceiptId'-'stateHash'-'canonicalHistoryBytes')
      IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'currentReceiptId'-'stateHash'-'canonicalHistoryBytes')
    OR NEW.revision<>OLD.revision+1 OR NEW.revision>4096 THEN
    RAISE EXCEPTION 'Invalid CSV comparison advancement';
  END IF;
  -- Require a born, independently guarded successor before consulting any other
  -- mutable anchor. No arbitrary pointer update acquires locks to legitimize it.
  SELECT * INTO successor FROM public."IngestionCsvContext" WHERE "customerId"=OLD."customerId" AND "sourceId"=OLD."sourceId"
    AND "receiptId"=NEW."currentReceiptId" AND revision=NEW.revision AND "stateHash"=NEW."stateHash"
    AND "predecessorRevision"=OLD.revision AND "predecessorReceiptId" IS NOT DISTINCT FROM OLD."currentReceiptId"
    AND "predecessorHash"=OLD."stateHash" AND "mappingRevision"=OLD."mappingRevision";
  IF NOT FOUND OR NEW."canonicalHistoryBytes"<>OLD."canonicalHistoryBytes"+successor."canonicalBytes"
    OR NEW."canonicalHistoryBytes">268435456 THEN RAISE EXCEPTION 'Invalid CSV comparison advancement'; END IF;
  SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=OLD."customerId" AND id=OLD."sourceId";
  SELECT * INTO receipt FROM public."IngestionOperationReceipt" WHERE id=successor."receiptId" AND "customerId"=OLD."customerId" AND "sourceId"=OLD."sourceId";
  IF s.id IS NULL OR receipt.id IS NULL OR ROW(s."currentConfigRevision",s."mappingRevision")
      IS DISTINCT FROM ROW(successor."configRevision",successor."mappingRevision") THEN RAISE EXCEPTION 'Invalid CSV comparison advancement'; END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionReceiptProjectScope" scope
    JOIN public."Project" project ON project."customerId"=scope."customerId" AND project.id=scope."projectId"
    WHERE scope."receiptId"=receipt.id AND (
      NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader WHERE reader."customerId"=scope."customerId"
        AND reader."sourceId"=scope."sourceId" AND reader."configRevision"=s."currentConfigRevision"
        AND reader."projectId"=scope."projectId" AND reader.subject=receipt.subject)
      OR NOT EXISTS (SELECT 1 FROM public."AccessGrant" grant_row WHERE grant_row.id=scope."grantId"
        AND grant_row."customerId"=scope."customerId" AND grant_row.subject=receipt.subject AND grant_row.role=scope."grantRole"
        AND grant_row."scopeType"=scope."grantScopeType" AND grant_row."scopeId"=scope."grantScopeId"
        AND ((grant_row."scopeType"='project' AND grant_row."scopeId"=project.id)
          OR (grant_row."scopeType"='portfolio' AND grant_row."scopeId"=project."portfolioId")))
    )
  ) THEN RAISE EXCEPTION 'Invalid CSV comparison advancement'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.initialize_ingestion_csv_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE; dictionary_value jsonb; readiness_value text; hash_value text; empty_text text;
BEGIN
  IF NEW."currentConfigRevision" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO cfg FROM public."IngestionConfigurationRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW.id
    AND revision=NEW."currentConfigRevision" AND "mappingRevision"=NEW."mappingRevision";
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid CSV comparison initialization'; END IF;
  IF cfg.mapping->>'kind' IS DISTINCT FROM 'CSV' THEN RETURN NEW; END IF;
  IF NOT cfg.sealed THEN RAISE EXCEPTION 'Invalid CSV comparison initialization'; END IF;
  IF EXISTS (SELECT 1 FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW.id) THEN RETURN NEW; END IF;
  SELECT jsonb_agg(jsonb_build_array(value->>'factType',value->>'type') ORDER BY (value->>'factType') COLLATE "C")
    INTO dictionary_value FROM jsonb_array_elements(cfg.mapping->'fields');
  readiness_value:=CASE WHEN EXISTS (SELECT 1 FROM public."IngestionExternalRecord" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW.id)
    OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW.id AND kind='CSV_PREVIEW')
    THEN 'LEGACY_UNAVAILABLE' ELSE 'READY' END;
  IF readiness_value='READY' THEN
    empty_text:=public.ingestion_csv_state_text(NEW."customerId",NEW.id,NEW."mappingRevision",dictionary_value,'[]'::jsonb);
    IF empty_text IS NULL THEN RAISE EXCEPTION 'Invalid CSV comparison initialization'; END IF;
    hash_value:=encode(sha256(convert_to(empty_text,'UTF8')),'hex');
  END IF;
  INSERT INTO public."IngestionCsvHead" ("customerId","sourceId","activationConfigRevision","mappingRevision",dictionary,readiness,"stateHash")
    VALUES (NEW."customerId",NEW.id,NEW."currentConfigRevision",NEW."mappingRevision",dictionary_value,readiness_value,hash_value);
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_ingestion_csv_head(),public.initialize_ingestion_csv_head() FROM PUBLIC;

CREATE FUNCTION public.guard_ingestion_csv_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  r public."IngestionOperationReceipt"%ROWTYPE;
  h public."IngestionCsvHead"%ROWTYPE;
  planned_head public."IngestionCsvHead"%ROWTYPE;
  s public."IngestionSource"%ROWTYPE;
  policy public."IngestionRetentionPolicy"%ROWTYPE;
  cfg public."IngestionConfigurationRevision"%ROWTYPE;
  activation_mapping jsonb;
  parent public."IngestionCsvContext"%ROWTYPE;
  prior_rows jsonb := '[]'::jsonb;
  project_ids uuid[];
  projection_ids uuid[];
  item record;
  projection_row record;
  outcome_row record;
  locked_projects integer := 0;
  locked_content integer := 0;
  actual_outcomes integer;
  first_ordinal integer;
  last_ordinal integer;
  content_bytes bigint;
  content_valid boolean;
  encoded text;
  prior_encoded text;
  expected_rows jsonb;
  proposal jsonb;
  field_type text;
  identity_uncertain boolean;
  missing_previous boolean;
  prior_identity jsonb;
  expected_operation text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'CSV comparison history is immutable'; END IF;
  SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR r.kind<>'CSV_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
    OR ROW(r."configRevision",r."mappingRevision") IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN
    RAISE EXCEPTION 'Invalid CSV comparison context';
  END IF;
  SELECT * INTO planned_head FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId";
  IF NOT FOUND OR planned_head.readiness<>'READY' OR planned_head."mappingRevision"<>NEW."mappingRevision"
    OR NEW.revision<>planned_head.revision+1 OR NEW."predecessorRevision"<>planned_head.revision
    OR NEW."predecessorReceiptId" IS DISTINCT FROM planned_head."currentReceiptId"
    OR NEW."predecessorHash" IS DISTINCT FROM planned_head."stateHash" THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  encoded:=public.ingestion_csv_state_text(NEW."customerId",NEW."sourceId",NEW."mappingRevision",planned_head.dictionary,NEW.rows);
  IF encoded IS NULL OR NEW."canonicalBytes" IS DISTINCT FROM octet_length(convert_to(encoded,'UTF8'))
    OR NEW."stateHash"::text IS DISTINCT FROM encode(sha256(convert_to(encoded,'UTF8')),'hex') THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  IF planned_head.revision>0 THEN
    SELECT * INTO parent FROM public."IngestionCsvContext" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
      AND "receiptId"=planned_head."currentReceiptId" AND revision=planned_head.revision AND "stateHash"=planned_head."stateHash";
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
    prior_rows:=parent.rows;
  END IF;
  prior_encoded:=public.ingestion_csv_state_text(NEW."customerId",NEW."sourceId",NEW."mappingRevision",planned_head.dictionary,prior_rows);
  IF prior_encoded IS NULL OR encode(sha256(convert_to(prior_encoded,'UTF8')),'hex')<>planned_head."stateHash" THEN
    RAISE EXCEPTION 'Invalid CSV comparison context';
  END IF;
  SELECT COALESCE(array_agg(project_id ORDER BY project_id),'{}'::uuid[]) INTO project_ids FROM (
    SELECT "projectId" AS project_id FROM public."IngestionConfigurationProject"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW."configRevision"
    UNION SELECT "projectId" FROM public."IngestionConfigurationProject"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
        AND "configRevision"=CASE WHEN planned_head.revision=0 THEN planned_head."activationConfigRevision" ELSE parent."configRevision" END
    UNION SELECT (value->>2)::uuid FROM jsonb_array_elements(prior_rows)
  ) planned;
  IF cardinality(project_ids) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  -- All projects, then all applicable grants, then policy/source/head/content.
  -- Direct callers cannot assert that the repository already owns these fences.
  FOR item IN SELECT p.id FROM public."Project" p WHERE p."customerId"=NEW."customerId" AND p.id=ANY(project_ids) ORDER BY p.id FOR UPDATE LOOP
    locked_projects:=locked_projects+1;
  END LOOP;
  IF locked_projects<>cardinality(project_ids) THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  FOR item IN SELECT g.id FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=r.subject AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
      AND EXISTS (SELECT 1 FROM public."Project" p WHERE p."customerId"=NEW."customerId" AND p.id=ANY(project_ids)
        AND ((g."scopeType"='project' AND g."scopeId"=p.id) OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
    ORDER BY g.id FOR SHARE LOOP
    NULL;
  END LOOP;
  SELECT * INTO policy FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
  IF NOT FOUND OR ROW(s."currentConfigRevision",s."mappingRevision") IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN
    RAISE EXCEPTION USING ERRCODE='PDC02',MESSAGE='CSV comparison conflict';
  END IF;
  SELECT * INTO h FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" FOR UPDATE;
  IF NOT FOUND OR to_jsonb(h) IS DISTINCT FROM to_jsonb(planned_head) OR public.valid_ingestion_csv_head(h."customerId",h."sourceId") IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='PDC02',MESSAGE='CSV comparison conflict';
  END IF;
  IF h.revision>=4096 OR h."canonicalHistoryBytes"+NEW."canonicalBytes">268435456 THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  SELECT * INTO cfg FROM public."IngestionConfigurationRevision" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
    AND revision=NEW."configRevision" AND "mappingRevision"=NEW."mappingRevision" AND sealed;
  SELECT mapping INTO activation_mapping FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId" AND revision=h."activationConfigRevision" AND "mappingRevision"=h."mappingRevision" AND sealed;
  IF cfg.revision IS NULL OR cfg.mapping->>'kind' IS DISTINCT FROM 'CSV' OR cfg.mapping IS DISTINCT FROM activation_mapping THEN
    RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(project_ids) scope(project_id) JOIN public."Project" project ON project."customerId"=NEW."customerId" AND project.id=scope.project_id
    WHERE NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp WHERE cp."customerId"=NEW."customerId" AND cp."sourceId"=NEW."sourceId"
        AND cp."configRevision"=NEW."configRevision" AND cp."projectId"=scope.project_id)
      OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader WHERE reader."customerId"=NEW."customerId" AND reader."sourceId"=NEW."sourceId"
        AND reader."configRevision"=NEW."configRevision" AND reader."projectId"=scope.project_id AND reader.subject=r.subject)
      OR NOT EXISTS (
        SELECT 1 FROM public."IngestionReceiptProjectScope" snap JOIN public."AccessGrant" g ON g.id=snap."grantId"
        WHERE snap."receiptId"=r.id AND snap."customerId"=NEW."customerId" AND snap."sourceId"=NEW."sourceId" AND snap."projectId"=scope.project_id
          AND g."customerId"=NEW."customerId" AND g.subject=r.subject AND g.role=snap."grantRole" AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
          AND g."scopeType"=snap."grantScopeType" AND g."scopeId"=snap."grantScopeId"
          AND ((g."scopeType"='project' AND g."scopeId"=project.id) OR (g."scopeType"='portfolio' AND g."scopeId"=project."portfolioId"))
      )
  ) THEN RAISE EXCEPTION USING ERRCODE='PDC03',MESSAGE='CSV comparison denied'; END IF;
  SELECT count(*)::integer,min(ordinal),max(ordinal) INTO actual_outcomes,first_ordinal,last_ordinal
    FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id;
  IF actual_outcomes<>r."outcomeCount" OR (actual_outcomes>0 AND (first_ordinal<>1 OR last_ordinal<>actual_outcomes))
    OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND ROW(o."customerId",o."sourceId") IS DISTINCT FROM ROW(NEW."customerId",NEW."sourceId")) THEN
    RAISE EXCEPTION 'Invalid CSV comparison context';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND o.state='ACCEPTED' AND (
      cardinality(o."errorCodes")<>0 OR NOT EXISTS (
        SELECT 1 FROM public."IngestionProposalProjection" p JOIN public."IngestionExternalRecord" e
          ON e."customerId"=p."customerId" AND e."sourceId"=p."sourceId" AND e.id=p."recordId"
        WHERE p.id=o."projectionId" AND p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p."recordId"=o."recordId"
          AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=NEW."mappingRevision" AND e."projectId"=o."projectId"
          AND e."projectId"=ANY(project_ids) AND e."recordKey" COLLATE "C"=o."recordKey" COLLATE "C"
          AND e."recordType" COLLATE "C"=('spreadsheet:'||(cfg.mapping->>'sheet')) COLLATE "C"
      )
    )
  ) OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id
    GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  IF EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED' AND (
      EXISTS (SELECT 1 FROM unnest(p."factTypes") ft(value) WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(h.dictionary) entry WHERE (entry->>0) COLLATE "C"=ft.value COLLATE "C"))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(cfg.mapping->'fields') field WHERE field->>'required'='true'
        AND NOT ((field->>'factType') COLLATE "C"=ANY(p."factTypes")))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE (prior->>0) COLLATE "C"=o."recordKey" COLLATE "C"
        AND ROW((prior->>1)::uuid,(prior->>2)::uuid) IS DISTINCT FROM ROW(o."recordId",o."projectId"))
    )
  ) THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;

  -- Exact metadata overlay, before dereferencing any supplied state references.
  WITH dictionary AS (
    SELECT (ordinal-1)::integer AS field_index,entry->>0 AS fact_type FROM jsonb_array_elements(h.dictionary) WITH ORDINALITY d(entry,ordinal)
  ), prior AS (
    SELECT (entry->>0) COLLATE "C" AS key,(entry->>1)::uuid AS record_id,(entry->>2)::uuid AS project_id,entry->3 AS refs FROM jsonb_array_elements(prior_rows) entry
  ), observed AS (
    SELECT o."recordKey" COLLATE "C" AS key,o."recordId" AS record_id,o."projectId" AS project_id,p.id AS projection_id,p."factTypes" AS fact_types
    FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId" WHERE o."receiptId"=r.id AND o.state='ACCEPTED'
  ), identities AS (
    SELECT key,record_id,project_id FROM prior UNION SELECT key,record_id,project_id FROM observed
  ), supplied AS (
    SELECT o.key,d.field_index,o.projection_id FROM observed o CROSS JOIN LATERAL unnest(o.fact_types) ft(value)
    JOIN dictionary d ON d.fact_type COLLATE "C"=ft.value COLLATE "C"
  ), carried AS (
    SELECT p.key,(ref->>0)::integer AS field_index,(ref->>1)::uuid AS projection_id FROM prior p CROSS JOIN LATERAL jsonb_array_elements(p.refs) ref
    WHERE NOT EXISTS (SELECT 1 FROM supplied v WHERE v.key=p.key AND v.field_index=(ref->>0)::integer)
  ), refs AS (
    SELECT * FROM supplied UNION ALL SELECT * FROM carried
  ), grouped_refs AS (
    SELECT key,jsonb_agg(jsonb_build_array(field_index::text,projection_id::text) ORDER BY field_index) AS refs
    FROM refs GROUP BY key
  ), merged AS (
    SELECT i.key,jsonb_build_array(i.key,i.record_id::text,i.project_id::text,COALESCE(g.refs,'[]'::jsonb)) AS entry
    FROM identities i LEFT JOIN grouped_refs g ON g.key=i.key
  ) SELECT COALESCE(jsonb_agg(entry ORDER BY key COLLATE "C"),'[]'::jsonb) INTO expected_rows FROM merged;
  IF NEW.rows IS DISTINCT FROM expected_rows THEN RAISE EXCEPTION 'Invalid CSV comparison context'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO projection_ids FROM (
    SELECT (ref->>1)::uuid AS id FROM jsonb_array_elements(prior_rows) identity_row CROSS JOIN LATERAL jsonb_array_elements(identity_row->3) ref
    UNION SELECT "projectionId" FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id AND state='ACCEPTED'
  ) required;
  IF cardinality(projection_ids)>33000 THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  FOR item IN SELECT content."projectionId" FROM public."IngestionProposalContent" content
    WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids)
    ORDER BY content."projectionId" FOR SHARE LOOP
    locked_content:=locked_content+1;
  END LOOP;
  IF locked_content<>cardinality(projection_ids) THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  -- Only count/byte/availability metadata is returned until the entire bound passes.
  SELECT count(*)::integer,COALESCE(sum(octet_length(content.proposals::text)),0),
    COALESCE(bool_and(content.proposals IS NOT NULL AND content."redactedAt" IS NULL
      AND revision."receivedAt"+make_interval(hours=>policy."retentionHours")>clock_timestamp()),true)
    INTO locked_content,content_bytes,content_valid
    FROM public."IngestionProposalContent" content
    JOIN public."IngestionProposalProjection" p ON p.id=content."projectionId" AND p."customerId"=content."customerId"
      AND p."sourceId"=content."sourceId" AND p."recordId"=content."recordId" AND p."mappingRevision"=NEW."mappingRevision"
    JOIN public."IngestionSourceRevision" revision ON revision.id=p."sourceRevisionId" AND revision."customerId"=p."customerId"
      AND revision."sourceId"=p."sourceId" AND revision."recordId"=p."recordId"
    WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids);
  IF locked_content<>cardinality(projection_ids) OR content_valid IS NOT TRUE OR content_bytes>4194304 THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
  FOR projection_row IN SELECT p.id,content.proposals FROM public."IngestionProposalProjection" p
    JOIN public."IngestionProposalContent" content ON content."projectionId"=p.id AND content."customerId"=p."customerId"
      AND content."sourceId"=p."sourceId" AND content."recordId"=p."recordId"
    WHERE p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p.id=ANY(projection_ids) ORDER BY p.id
  LOOP
    IF public.valid_ingestion_projection_content(projection_row.id,projection_row.proposals) IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='PDC01',MESSAGE='CSV comparison unavailable'; END IF;
    FOR proposal IN SELECT value FROM jsonb_array_elements(projection_row.proposals) LOOP
      SELECT entry->>1 INTO field_type FROM jsonb_array_elements(h.dictionary) entry WHERE (entry->>0) COLLATE "C"=(proposal->>'factType') COLLATE "C";
      IF field_type IS NULL OR (proposal->'value'->>'type') IS DISTINCT FROM field_type THEN RAISE EXCEPTION 'Invalid CSV comparison value'; END IF;
      IF field_type='number' AND abs((proposal->'value'->>'value')::numeric)>9007199254740991 THEN RAISE EXCEPTION 'Invalid CSV comparison value'; END IF;
      IF field_type='text' AND proposal->'value'->>'value'='' THEN RAISE EXCEPTION 'Invalid CSV comparison value'; END IF;
      IF field_type='text' AND left(ltrim(proposal->'value'->>'value',E'\t\n\f\r '||U&'\000b\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff'),1) IN ('=','+','-','@') THEN
        RAISE EXCEPTION 'Invalid CSV comparison value';
      END IF;
    END LOOP;
  END LOOP;
  SELECT EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id
    AND (o."recordKey" IS NULL OR o."errorCodes" && ARRAY['INVALID_KEY','DUPLICATE_KEY','INVALID_PROJECT','PROJECT_CHANGED','ROW_IDENTITY_REVIEW']::text[]))
    OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=r.id AND "recordKey" IS NOT NULL GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1)
    INTO identity_uncertain;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) prior WHERE NOT EXISTS (
    SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=r.id AND o."recordKey" COLLATE "C"=(prior->>0) COLLATE "C")) INTO missing_previous;
  FOR outcome_row IN SELECT o.*,content.proposals FROM public."IngestionRowOutcome" o
    JOIN public."IngestionProposalContent" content ON content."projectionId"=o."projectionId" AND content."customerId"=o."customerId"
      AND content."sourceId"=o."sourceId" AND content."recordId"=o."recordId"
    WHERE o."receiptId"=r.id AND o.state='ACCEPTED' ORDER BY o.ordinal
  LOOP
    SELECT value INTO prior_identity FROM jsonb_array_elements(prior_rows) WHERE (value->>0) COLLATE "C"=outcome_row."recordKey" COLLATE "C";
    IF prior_identity IS NULL AND (identity_uncertain OR missing_previous) THEN RAISE EXCEPTION 'Invalid CSV comparison identity'; END IF;
    IF jsonb_array_length(outcome_row.proposals)=0 THEN
      expected_operation:=CASE WHEN prior_identity IS NULL THEN 'NONE' ELSE 'UNCHANGED' END;
    ELSIF prior_identity IS NULL THEN expected_operation:='CREATE';
    ELSIF EXISTS (
      SELECT 1 FROM jsonb_array_elements(outcome_row.proposals) supplied WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(prior_identity->3) ref
        JOIN public."IngestionProposalContent" previous ON previous."projectionId"=(ref->>1)::uuid
          AND previous."customerId"=NEW."customerId" AND previous."sourceId"=NEW."sourceId" AND previous."recordId"=outcome_row."recordId"
        CROSS JOIN LATERAL jsonb_array_elements(previous.proposals) prior_value
        WHERE (h.dictionary->((ref->>0)::integer)->>0) COLLATE "C"=(supplied->>'factType') COLLATE "C"
          AND (prior_value->>'factType') COLLATE "C"=(supplied->>'factType') COLLATE "C" AND prior_value->'value'=supplied->'value'
      )
    ) THEN expected_operation:='UPDATE';
    ELSE expected_operation:='UNCHANGED'; END IF;
    IF outcome_row.operation IS DISTINCT FROM expected_operation THEN RAISE EXCEPTION 'Invalid CSV comparison operation'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_ingestion_csv_context() FROM PUBLIC;

-- Exact released receipt rules with additive CSV binding.
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

-- A CSV preview header owns receipt-wide completion. Its immutable count and
-- the unique, range-checked ordinals leave no free slot after that check passes.
-- Outcome events still verify their own bindings, including when their
-- constraint is made immediate separately from the header constraint.
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
    IF FOUND AND TG_TABLE_NAME='IngestionRowOutcome' AND receipt.kind='CSV_PREVIEW'
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
REVOKE ALL ON FUNCTION public.require_ingestion_receipt_complete() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_ingestion_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_row public."IngestionSource"%ROWTYPE; mapping_value jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion operation receipt is immutable'; END IF;
  SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  IF NOT FOUND OR ROW(source_row."currentConfigRevision",source_row."mappingRevision")
    IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN RAISE EXCEPTION 'Ingestion receipt uses stale configuration'; END IF;
  SELECT mapping INTO mapping_value FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND revision=NEW."configRevision" AND "mappingRevision"=NEW."mappingRevision" AND sealed;
  IF mapping_value IS NULL OR (NEW.kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT') AND mapping_value->>'kind' IS DISTINCT FROM 'CONNECTOR')
    OR (NEW.kind IN ('CSV_PREVIEW','CSV_REVIEWED_IMPORT') AND mapping_value->>'kind' IS DISTINCT FROM 'CSV') THEN
    RAISE EXCEPTION 'Ingestion receipt mapping family is invalid';
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
  IF EXISTS (SELECT 1 FROM public."IngestionCsvHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND readiness='READY')
    AND public.valid_ingestion_csv_context(NEW."previewReceiptId") IS NOT TRUE THEN
    RAISE EXCEPTION 'Reviewed import parent comparison is invalid';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.guard_ingestion_receipt(),public.guard_ingestion_reviewed_import() FROM PUBLIC;

CREATE FUNCTION public.require_ingestion_csv_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE customer_target uuid; source_target uuid; receipt_target uuid; head_row public."IngestionCsvHead"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='IngestionCsvHead' THEN
    -- Each advance queues a head event. Its validator checks the final stored
    -- pointer, accounting and current context, including on initial activation.
    IF public.valid_ingestion_csv_head(NEW."customerId",NEW."sourceId") IS NOT TRUE THEN
      RAISE EXCEPTION 'Incomplete CSV comparison cannot commit';
    END IF;
    RETURN NULL;
  ELSIF TG_TABLE_NAME='IngestionOperationReceipt' THEN
    customer_target:=NEW."customerId"; source_target:=NEW."sourceId"; receipt_target:=NEW.id;
  ELSE
    customer_target:=NEW."customerId"; source_target:=NEW."sourceId"; receipt_target:=NEW."receiptId";
    -- Validate every inserted context, even one superseded in this transaction.
    IF public.valid_ingestion_csv_context(receipt_target) IS NOT TRUE THEN
      RAISE EXCEPTION 'Incomplete CSV comparison cannot commit';
    END IF;
  END IF;
  -- The generic receipt check proves the exact context/receipt link on a ready
  -- head. The independently queued context and head events check their graphs.
  SELECT * INTO head_row FROM public."IngestionCsvHead" WHERE "customerId"=customer_target AND "sourceId"=source_target;
  IF NOT FOUND OR head_row.readiness<>'READY' OR public.valid_ingestion_receipt(receipt_target) IS NOT TRUE
    OR NOT EXISTS (SELECT 1 FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" cfg
      ON cfg."customerId"=s."customerId" AND cfg."sourceId"=s.id AND cfg.revision=s."currentConfigRevision" AND cfg.sealed
      WHERE s."customerId"=customer_target AND s.id=source_target AND cfg.mapping->>'kind'='CSV') THEN
    RAISE EXCEPTION 'Incomplete CSV comparison cannot commit';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.require_ingestion_csv_complete() FROM PUBLIC;

CREATE TRIGGER ingestion_csv_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionCsvHead"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_csv_head();
CREATE TRIGGER ingestion_csv_context_guard BEFORE INSERT OR UPDATE OR DELETE ON public."IngestionCsvContext"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_csv_context();
CREATE TRIGGER ingestion_csv_head_no_truncate BEFORE TRUNCATE ON public."IngestionCsvHead"
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_csv_context_no_truncate BEFORE TRUNCATE ON public."IngestionCsvContext"
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_csv_initialize AFTER INSERT OR UPDATE OF "currentConfigRevision","mappingRevision" ON public."IngestionSource"
  FOR EACH ROW EXECUTE FUNCTION public.initialize_ingestion_csv_head();
CREATE CONSTRAINT TRIGGER ingestion_csv_receipt_complete AFTER INSERT ON public."IngestionOperationReceipt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='CSV_PREVIEW') EXECUTE FUNCTION public.require_ingestion_csv_complete();
CREATE CONSTRAINT TRIGGER ingestion_csv_context_complete AFTER INSERT ON public."IngestionCsvContext"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_csv_complete();
CREATE CONSTRAINT TRIGGER ingestion_csv_head_complete AFTER INSERT OR UPDATE ON public."IngestionCsvHead"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_csv_complete();

-- No chronological backfill: any pre-existing record or CSV preview (including
-- invalid-only history) is classified unavailable by the same native birth guard.
WITH candidates AS (
  SELECT s."customerId",s.id AS "sourceId",s."currentConfigRevision",s."mappingRevision",
    (SELECT jsonb_agg(jsonb_build_array(value->>'factType',value->>'type') ORDER BY (value->>'factType') COLLATE "C")
      FROM jsonb_array_elements(cfg.mapping->'fields')) AS dictionary,
    CASE WHEN EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e."customerId"=s."customerId" AND e."sourceId"=s.id)
      OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r."customerId"=s."customerId" AND r."sourceId"=s.id AND r.kind='CSV_PREVIEW')
      THEN 'LEGACY_UNAVAILABLE' ELSE 'READY' END AS readiness
  FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" cfg
    ON cfg."customerId"=s."customerId" AND cfg."sourceId"=s.id AND cfg.revision=s."currentConfigRevision" AND cfg."mappingRevision"=s."mappingRevision" AND cfg.sealed
  WHERE cfg.mapping->>'kind'='CSV'
)
INSERT INTO public."IngestionCsvHead" ("customerId","sourceId","activationConfigRevision","mappingRevision",dictionary,readiness,"stateHash")
  SELECT "customerId","sourceId","currentConfigRevision","mappingRevision",dictionary,readiness,
    CASE WHEN readiness='READY' THEN encode(sha256(convert_to(public.ingestion_csv_state_text("customerId","sourceId","mappingRevision",dictionary,'[]'::jsonb),'UTF8')),'hex') ELSE NULL END
  FROM candidates ORDER BY "customerId","sourceId";

DO $csv_privileges$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public."IngestionCsvHead",public."IngestionCsvContext" FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.valid_ingestion_csv_state(uuid,uuid,integer,jsonb,jsonb),public.ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb),public.valid_ingestion_csv_context(uuid),public.valid_ingestion_csv_head(uuid,uuid),public.guard_ingestion_csv_head(),public.initialize_ingestion_csv_head(),public.guard_ingestion_csv_context(),public.require_ingestion_csv_complete(),public.guard_ingestion_receipt(),public.guard_ingestion_reviewed_import(),public.require_ingestion_receipt_complete() FROM %I',role_name);
    END IF;
  END LOOP;
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    GRANT SELECT,INSERT ON TABLE public."IngestionCsvHead",public."IngestionCsvContext" TO pdaa_api;
    GRANT UPDATE (revision,"currentReceiptId","stateHash","canonicalHistoryBytes") ON TABLE public."IngestionCsvHead" TO pdaa_api;
    GRANT EXECUTE ON FUNCTION public.valid_ingestion_csv_state(uuid,uuid,integer,jsonb,jsonb),public.ingestion_csv_state_text(uuid,uuid,integer,jsonb,jsonb),public.valid_ingestion_csv_context(uuid),public.valid_ingestion_csv_head(uuid,uuid) TO pdaa_api;
  END IF;
  IF to_regrole('pdaa_backup') IS NOT NULL THEN
    GRANT SELECT ON TABLE public."IngestionCsvHead",public."IngestionCsvContext" TO pdaa_backup;
  END IF;
END $csv_privileges$;
