-- FR-CON-006/007: dedicated XLSX source activation and comparison genesis.
ALTER TABLE public."IngestionSource"
    ADD COLUMN "inputFamily" text NOT NULL DEFAULT 'LEGACY',
    ADD CONSTRAINT "IngestionSource_input_family_check" CHECK ("inputFamily" IN ('LEGACY','XLSX'));

CREATE FUNCTION public.ingestion_xlsx_v1_state_text(
    customer uuid, source uuid, mapping_revision integer, sheet jsonb,
    profile jsonb, dictionary jsonb, rows jsonb
) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE sheet_text text; encoded text;
BEGIN
    IF current_setting('server_encoding') <> 'UTF8'
        OR public.ingestion_xlsx_v1_uuid(to_jsonb(customer)) IS NOT TRUE
        OR public.ingestion_xlsx_v1_uuid(to_jsonb(source)) IS NOT TRUE
        OR profile NOT IN ('"portable-v1"'::jsonb,'"excel-text-v1"'::jsonb)
    THEN RETURN NULL; END IF;
    sheet_text := public.ingestion_xlsx_v1_text(sheet, 31);
    IF sheet_text IS NULL OR translate(sheet_text, E'\\/*?:[]', '') <> sheet_text
        OR sheet_text COLLATE "C" ~* '_x[0-9a-f]{4}_'
    THEN RETURN NULL; END IF;
    -- Only the validated ASCII dictionary and reference grammar are shared.
    -- The workbook tuple has its own domain, numeric revision, sheet and profile.
    IF public.ingestion_csv_state_text(customer,source,mapping_revision,dictionary,rows) IS NULL THEN RETURN NULL; END IF;
    encoded := '["pdaa.xlsx.comparison-state.v1",' || concat_ws(',',to_jsonb(customer),to_jsonb(source),
        mapping_revision,sheet,profile,replace(dictionary::text,' ',''),replace(rows::text,' ','')) || ']';
    IF octet_length(encoded)>2097152 THEN RETURN NULL; END IF;
    RETURN encoded;
END $$;

CREATE FUNCTION public.valid_ingestion_xlsx_mapping(mapping_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE sheet_text text;
BEGIN
    IF jsonb_typeof(mapping_value) <> 'object'
        OR mapping_value->'kind' IS DISTINCT FROM '"XLSX"'::jsonb
        OR (mapping_value->'parserContract' IN ('"portable-v1"'::jsonb,'"excel-text-v1"'::jsonb)) IS NOT TRUE
    THEN RETURN false; END IF;
    IF public.valid_ingestion_mapping((mapping_value - 'parserContract') || '{"kind":"CSV"}'::jsonb) IS NOT TRUE
        OR public.ingestion_xlsx_v1_text(mapping_value->'identityColumn', 256) IS NULL
        OR public.ingestion_xlsx_v1_text(mapping_value->'projectColumn', 256) IS NULL
    THEN RETURN false; END IF;
    sheet_text := public.ingestion_xlsx_v1_text(mapping_value->'sheet', 31);
    RETURN sheet_text IS NOT NULL AND translate(sheet_text, E'\\/*?:[]', '') = sheet_text
        AND sheet_text COLLATE "C" !~* '_x[0-9a-f]{4}_'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(mapping_value->'fields') AS field(value)
            WHERE public.ingestion_xlsx_v1_text(value->'column', 256) IS NULL);
END $$;

CREATE TABLE public."IngestionXlsxHead" (
    "customerId" uuid NOT NULL,
    "sourceId" uuid NOT NULL,
    "activationConfigRevision" integer NOT NULL,
    "mappingRevision" integer NOT NULL,
    dictionary jsonb NOT NULL,
    "genesisSha256" char(64) NOT NULL,
    CONSTRAINT "IngestionXlsxHead_pkey" PRIMARY KEY ("customerId","sourceId"),
    CONSTRAINT "IngestionXlsxHead_activation_fkey"
        FOREIGN KEY ("customerId","sourceId","activationConfigRevision","mappingRevision")
        REFERENCES public."IngestionConfigurationRevision"("customerId","sourceId",revision,"mappingRevision")
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "IngestionXlsxHead_first_activation_check" CHECK ("activationConfigRevision"=1 AND "mappingRevision"=1),
    CONSTRAINT "IngestionXlsxHead_genesis_hash_check" CHECK ("genesisSha256" COLLATE "C" ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION public.guard_ingestion_xlsx_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE owner_name name; mapping_value jsonb; activated_mapping jsonb;
BEGIN
    IF TG_OP='UPDATE' AND NEW."inputFamily" IS DISTINCT FROM OLD."inputFamily" THEN
        RAISE EXCEPTION 'Ingestion input family is immutable';
    END IF;
    IF NEW."inputFamily" IS DISTINCT FROM 'XLSX' THEN RETURN NEW; END IF;
    SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
    -- The existing table-wide INSERT grant also covers new columns.
    IF current_user IS DISTINCT FROM owner_name THEN RAISE EXCEPTION 'Workbook source owner required'; END IF;
    IF NEW."sourceType"<>'xlsx' OR NEW."cursorRevision"<>0 OR NEW."syncGeneration"<>1 OR NEW."cursorEnvelope" IS NOT NULL
        OR NEW."lastSuccessReceiptId" IS NOT NULL OR NEW."healthState"<>'UNKNOWN'
        OR NEW."healthCode"<>'NONE' OR NEW."healthCheckedAt" IS NOT NULL
        OR (TG_OP='INSERT' AND NEW."cursorState"<>'READY')
    THEN RAISE EXCEPTION 'Invalid workbook source state'; END IF;
    IF TG_OP='UPDATE' THEN
        SELECT c.mapping INTO mapping_value FROM public."IngestionConfigurationRevision" c
        WHERE c."customerId"=NEW."customerId" AND c."sourceId"=NEW.id
            AND c.revision=NEW."currentConfigRevision" AND c."mappingRevision"=NEW."mappingRevision" AND c.sealed;
        IF public.valid_ingestion_xlsx_mapping(mapping_value) IS NOT TRUE OR NEW."cursorState"<>'RESET_REQUIRED' THEN
            RAISE EXCEPTION 'Workbook source requires a sealed workbook mapping';
        END IF;
        IF OLD."currentConfigRevision" IS NOT NULL THEN
            SELECT c.mapping INTO activated_mapping FROM public."IngestionXlsxHead" h
            JOIN public."IngestionConfigurationRevision" c ON c."customerId"=h."customerId" AND c."sourceId"=h."sourceId"
                AND c.revision=h."activationConfigRevision" AND c."mappingRevision"=h."mappingRevision" AND c.sealed
            WHERE h."customerId"=NEW."customerId" AND h."sourceId"=NEW.id;
            IF mapping_value IS DISTINCT FROM activated_mapping OR NEW."mappingRevision"<>OLD."mappingRevision" THEN
                RAISE EXCEPTION 'Workbook mapping differs from the activated mapping';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Preserve the released seal and its project/PMO checks. The earlier
-- reconfiguration scope trigger still owns the union lock order.
CREATE OR REPLACE FUNCTION public.guard_ingestion_configuration() RETURNS trigger
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
  IF NEW.mapping->>'kind'='XLSX' THEN
    IF public.valid_ingestion_xlsx_mapping(NEW.mapping) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid workbook mapping'; END IF;
  ELSIF public.valid_ingestion_mapping(NEW.mapping) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid ingestion mapping configuration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW.revision)
    THEN RAISE EXCEPTION 'Ingestion configuration scope is empty'; END IF;
  IF (SELECT count(*) FROM public."IngestionConfigurationProject" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND "configRevision"=NEW.revision)>100 THEN RAISE EXCEPTION 'Ingestion configuration project limit exceeded'; END IF;
  FOR project_row IN
    SELECT p."projectId",pr."portfolioId" FROM public."IngestionConfigurationProject" p
    JOIN public."Project" pr ON pr."customerId"=p."customerId" AND pr.id=p."projectId"
    WHERE p."customerId"=NEW."customerId" AND p."sourceId"=NEW."sourceId" AND p."configRevision"=NEW.revision
    ORDER BY p."projectId" FOR UPDATE OF pr
  LOOP
    SELECT * INTO grant_row FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=NEW."changedBy" AND g.role='pmo_admin'
      AND ((g."scopeType"='project' AND g."scopeId"=project_row."projectId") OR (g."scopeType"='portfolio' AND g."scopeId"=project_row."portfolioId"))
    ORDER BY (g."scopeType"='project') DESC,g.id LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion configuration requires current PMO project grants'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_ingestion_xlsx_mapping_family() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE family text; owner_name name;
BEGIN
    SELECT "inputFamily" INTO family FROM public."IngestionSource"
        WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId";
    IF coalesce(family='XLSX',false) <> coalesce(NEW.mapping->>'kind'='XLSX',false) THEN
        RAISE EXCEPTION 'Ingestion source mapping family mismatch';
    END IF;
    IF family='XLSX' THEN
        SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
        IF current_user IS DISTINCT FROM owner_name THEN RAISE EXCEPTION 'Workbook configuration owner required'; END IF;
        IF public.valid_ingestion_xlsx_mapping(NEW.mapping) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid workbook mapping'; END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.initialize_ingestion_xlsx_head() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE mapping_value jsonb; dictionary jsonb; genesis text;
BEGIN
    IF NEW."inputFamily"<>'XLSX' OR OLD."currentConfigRevision" IS NOT NULL THEN RETURN NEW; END IF;
    SELECT c.mapping INTO mapping_value FROM public."IngestionConfigurationRevision" c
    WHERE c."customerId"=NEW."customerId" AND c."sourceId"=NEW.id
        AND c.revision=NEW."currentConfigRevision" AND c."mappingRevision"=NEW."mappingRevision" AND c.sealed;
    IF public.valid_ingestion_xlsx_mapping(mapping_value) IS NOT TRUE
        OR EXISTS (SELECT 1 FROM public."IngestionCsvHead" h WHERE h."customerId"=NEW."customerId" AND h."sourceId"=NEW.id)
        OR EXISTS (SELECT 1 FROM public."IngestionExternalRecord" r WHERE r."customerId"=NEW."customerId" AND r."sourceId"=NEW.id)
        OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r."customerId"=NEW."customerId" AND r."sourceId"=NEW.id)
    THEN RAISE EXCEPTION 'Workbook genesis requires a new source'; END IF;
    SELECT jsonb_agg(jsonb_build_array(value->'factType',value->'type') ORDER BY (value->>'factType') COLLATE "C")
        INTO dictionary FROM jsonb_array_elements(mapping_value->'fields') AS field(value);
    genesis := public.ingestion_xlsx_v1_state_text(NEW."customerId",NEW.id,NEW."mappingRevision",
        mapping_value->'sheet',mapping_value->'parserContract',dictionary,'[]'::jsonb);
    IF genesis IS NULL THEN RAISE EXCEPTION 'Invalid workbook genesis'; END IF;
    INSERT INTO public."IngestionXlsxHead" ("customerId","sourceId","activationConfigRevision","mappingRevision",dictionary,"genesisSha256")
    VALUES (NEW."customerId",NEW.id,NEW."currentConfigRevision",
        NEW."mappingRevision",dictionary,encode(sha256(convert_to(genesis,'UTF8')),'hex'));
    RETURN NEW;
END $$;

CREATE FUNCTION public.valid_ingestion_xlsx_genesis(customer uuid, source uuid) RETURNS boolean
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
        OR EXISTS (SELECT 1 FROM public."IngestionExternalRecord" r WHERE r."customerId"=customer AND r."sourceId"=source)
        OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r."customerId"=customer AND r."sourceId"=source)
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

CREATE FUNCTION public.require_ingestion_xlsx_genesis() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF public.valid_ingestion_xlsx_genesis(NEW."customerId",NEW."sourceId") IS NOT TRUE THEN
        RAISE EXCEPTION 'Workbook genesis must commit atomically';
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION public.guard_ingestion_xlsx_legacy_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public."IngestionSource" WHERE "customerId"=NEW."customerId"
        AND id=NEW."sourceId" AND "inputFamily"='XLSX') THEN
        RAISE EXCEPTION 'Legacy ingestion is unavailable for workbook sources';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER ingestion_xlsx_source_guard BEFORE INSERT OR UPDATE ON public."IngestionSource"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_source();
CREATE TRIGGER ingestion_xlsx_mapping_family_guard BEFORE INSERT OR UPDATE ON public."IngestionConfigurationRevision"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_mapping_family();
CREATE TRIGGER ingestion_xlsx_head_initialize AFTER UPDATE OF "currentConfigRevision","mappingRevision" ON public."IngestionSource"
FOR EACH ROW EXECUTE FUNCTION public.initialize_ingestion_xlsx_head();
CREATE TRIGGER ingestion_xlsx_head_immutable BEFORE UPDATE OR DELETE ON public."IngestionXlsxHead"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_xlsx_head_no_truncate BEFORE TRUNCATE ON public."IngestionXlsxHead"
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE CONSTRAINT TRIGGER ingestion_xlsx_head_commit AFTER INSERT ON public."IngestionXlsxHead"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.require_ingestion_xlsx_genesis();
CREATE TRIGGER ingestion_xlsx_legacy_receipt_guard BEFORE INSERT ON public."IngestionOperationReceipt"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_legacy_write();
CREATE TRIGGER connector_00_xlsx_family_guard BEFORE INSERT OR UPDATE ON public."ConnectorCredential"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_legacy_write();
CREATE TRIGGER connector_00_xlsx_family_guard BEFORE INSERT OR UPDATE ON public."ConnectorSyncGrant"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_legacy_write();
CREATE TRIGGER connector_00_xlsx_family_guard BEFORE INSERT OR UPDATE ON public."ConnectorSyncJob"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_legacy_write();
CREATE TRIGGER connector_00_xlsx_family_guard BEFORE INSERT OR UPDATE ON public."ConnectorWebhookReceipt"
FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_legacy_write();

DO $xlsx_genesis_acl$
DECLARE recipients text;
BEGIN
    SELECT concat_ws(',', 'PUBLIC', string_agg(quote_ident(rolname), ',')) INTO recipients
        FROM pg_catalog.pg_roles WHERE rolname IN ('pdaa_api','pdaa_worker','pdaa_backup');
    EXECUTE 'REVOKE ALL ON FUNCTION public.ingestion_xlsx_v1_state_text(uuid,uuid,integer,jsonb,jsonb,jsonb,jsonb),
        public.valid_ingestion_xlsx_mapping(jsonb),public.guard_ingestion_xlsx_source(),
        public.guard_ingestion_xlsx_mapping_family(),public.initialize_ingestion_xlsx_head(),
        public.valid_ingestion_xlsx_genesis(uuid,uuid),public.require_ingestion_xlsx_genesis(),
        public.guard_ingestion_xlsx_legacy_write(),public.guard_ingestion_configuration() FROM ' || recipients;
    EXECUTE 'REVOKE ALL ON TABLE public."IngestionXlsxHead" FROM ' || recipients;
END $xlsx_genesis_acl$;
