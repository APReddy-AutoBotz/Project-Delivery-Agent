-- FR-CON-006/007: owner-only parity with ingestion-xlsx-binding.ts.
-- Inputs are bounded, trusted receipt projections. JSONB accepts already parsed
-- data. Admission, current access, and persisted content checks belong to callers.
CREATE FUNCTION public.ingestion_xlsx_v1_uuid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
    SELECT jsonb_typeof(value) = 'string' AND (value #>> '{}') COLLATE "C" ~
        '^(00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_digest(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
    SELECT jsonb_typeof(value) = 'string' AND (value #>> '{}') COLLATE "C" ~ '^[0-9a-f]{64}$'
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_uint(value jsonb, maximum integer) RETURNS integer
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE n numeric;
BEGIN
    IF jsonb_typeof(value) <> 'number' THEN RETURN NULL; END IF;
    n := value::numeric;
    IF n < 1 OR n > maximum OR n <> trunc(n) THEN RETURN NULL; END IF;
    RETURN n::integer;
END;
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_text(value jsonb, max_units integer) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE scalar text;
BEGIN
    IF jsonb_typeof(value) <> 'string' THEN RETURN NULL; END IF;
    scalar := value #>> '{}';
    -- In UTF-8, astral code points are four bytes and two ECMAScript code units.
    IF octet_length(scalar) > 3 * max_units THEN RETURN NULL; END IF;
    IF length(scalar) + length(regexp_replace(scalar COLLATE "C", U&'[^\+010000-\+10FFFF]', '', 'g')) > max_units
        OR btrim(scalar, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = ''
    THEN RETURN NULL; END IF;
    RETURN scalar;
END;
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_scope(doc jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
    SELECT public.ingestion_xlsx_v1_uuid(doc->'customerId') IS TRUE
        AND public.ingestion_xlsx_v1_uuid(doc->'sourceId') IS TRUE
        AND public.ingestion_xlsx_v1_text(doc->'subject', 256) IS NOT NULL
        AND jsonb_typeof(doc->'commandKey') = 'string'
        AND (doc->>'commandKey') COLLATE "C" ~ '^[A-Za-z0-9_-]{1,128}$'
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_request_hash(doc jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
    sheet text;
    config_revision integer;
    mapping_revision integer;
    workbook_bytes integer;
BEGIN
    IF current_setting('server_encoding') <> 'UTF8' OR jsonb_typeof(doc) <> 'object' THEN RETURN NULL; END IF;
    IF doc - ARRAY['customerId','sourceId','subject','commandKey','sheet','parserContract',
        'configRevision','mappingRevision','workbookBytes','workbookSha256'] <> '{}'::jsonb
        OR public.ingestion_xlsx_v1_scope(doc) IS NOT TRUE
        OR public.ingestion_xlsx_v1_digest(doc->'workbookSha256') IS NOT TRUE
        OR ((doc->'parserContract') IN ('"portable-v1"'::jsonb,'"excel-text-v1"'::jsonb)) IS NOT TRUE
    THEN RETURN NULL; END IF;
    sheet := public.ingestion_xlsx_v1_text(doc->'sheet', 31);
    config_revision := public.ingestion_xlsx_v1_uint(doc->'configRevision', 2147483647);
    mapping_revision := public.ingestion_xlsx_v1_uint(doc->'mappingRevision', 2147483647);
    workbook_bytes := public.ingestion_xlsx_v1_uint(doc->'workbookBytes', 1048576);
    IF sheet IS NULL OR translate(sheet, E'\\/*?:[]', '') <> sheet
        OR sheet COLLATE "C" ~* '_x[0-9a-f]{4}_'
        OR config_revision IS NULL OR mapping_revision IS NULL OR workbook_bytes IS NULL
    THEN RETURN NULL; END IF;
    -- Encode scalar strings individually so that spaces in a subject or sheet survive.
    RETURN encode(sha256(convert_to('["pdaa.xlsx.preview-request.v1",' || concat_ws(',',
        doc->'customerId', doc->'sourceId', doc->'subject', doc->'commandKey',
        config_revision, mapping_revision, doc->'sheet', doc->'parserContract',
        workbook_bytes, doc->'workbookSha256') || ']', 'UTF8')), 'hex');
END;
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_outcome(row_doc jsonb, expected_ordinal integer, projects jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
    codes jsonb := row_doc->'errorCodes';
    project jsonb := row_doc->'projectId';
    key_hash jsonb := row_doc->'keySha256';
    record_doc jsonb := row_doc->'record';
    record_tuple jsonb := 'null'::jsonb;
BEGIN
    IF jsonb_typeof(row_doc) <> 'object' THEN RETURN NULL; END IF;
    IF row_doc - ARRAY['ordinal','state','operation','errorCodes','projectId','keySha256','record'] <> '{}'::jsonb
        OR public.ingestion_xlsx_v1_uint(row_doc->'ordinal', 1000) IS DISTINCT FROM expected_ordinal
        OR ((row_doc->'state') IN ('"ACCEPTED"'::jsonb,'"INVALID"'::jsonb,'"REVIEW_REQUIRED"'::jsonb)) IS NOT TRUE
        OR (jsonb_typeof(codes) = 'array') IS NOT TRUE
        OR (project = 'null'::jsonb OR (public.ingestion_xlsx_v1_uuid(project) AND projects @> jsonb_build_array(project))) IS NOT TRUE
        OR (key_hash = 'null'::jsonb OR (public.ingestion_xlsx_v1_digest(key_hash) AND project <> 'null'::jsonb)) IS NOT TRUE
    THEN RETURN NULL; END IF;
    IF jsonb_array_length(codes) > 16 THEN RETURN NULL; END IF;
    IF row_doc->'state' = '"ACCEPTED"'::jsonb THEN
        IF codes <> '[]'::jsonb OR key_hash = 'null'::jsonb
            OR (jsonb_typeof(record_doc) = 'object') IS NOT TRUE
            OR ((row_doc->'operation') IN ('"CREATE"'::jsonb,'"UPDATE"'::jsonb,'"UNCHANGED"'::jsonb,'"NONE"'::jsonb)) IS NOT TRUE
        THEN RETURN NULL; END IF;
        IF record_doc - ARRAY['id','revisionId','sourceContentSha256','projectionId','proposalSha256'] <> '{}'::jsonb
            OR public.ingestion_xlsx_v1_uuid(record_doc->'id') IS NOT TRUE
            OR public.ingestion_xlsx_v1_uuid(record_doc->'revisionId') IS NOT TRUE
            OR public.ingestion_xlsx_v1_digest(record_doc->'sourceContentSha256') IS NOT TRUE
            OR public.ingestion_xlsx_v1_uuid(record_doc->'projectionId') IS NOT TRUE
            OR public.ingestion_xlsx_v1_digest(record_doc->'proposalSha256') IS NOT TRUE
            OR (row_doc->'operation' = '"NONE"'::jsonb AND record_doc->>'proposalSha256' <> encode(sha256(convert_to('[]', 'UTF8')), 'hex'))
        THEN RETURN NULL; END IF;
        record_tuple := jsonb_build_array(record_doc->'id', record_doc->'revisionId', record_doc->'sourceContentSha256',
            record_doc->'projectionId', record_doc->'proposalSha256');
    ELSE
        IF (row_doc->'operation' = '"NONE"'::jsonb AND record_doc = 'null'::jsonb) IS NOT TRUE OR codes = '[]'::jsonb
        THEN RETURN NULL; END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(codes) AS code(value)
            GROUP BY value
            HAVING count(*) > 1 OR value NOT IN ('"INVALID_INPUT"','"INVALID_KEY"','"DUPLICATE_KEY"','"INVALID_PROJECT"',
                '"PROJECT_CHANGED"','"INVALID_FIELDS"','"ROW_IDENTITY_REVIEW"','"REQUIRED_VALUE"','"INVALID_FORMULA"','"INVALID_NUMBER"','"INVALID_VALUE"')
        ) THEN RETURN NULL; END IF;
    END IF;
    RETURN jsonb_build_array(expected_ordinal, row_doc->'state', row_doc->'operation', codes, project, key_hash, record_tuple);
END;
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_context_hash(doc jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
    request_hash text := public.ingestion_xlsx_v1_request_hash(doc->'request');
    receipt jsonb := doc->'previewReceiptId';
    prior jsonb := doc->'baseline';
    projects jsonb := doc->'projectIds';
    outcomes jsonb := doc->'outcomes';
    prior_tuple jsonb := '["GENESIS"]'::jsonb;
    prior_revision integer;
    rows_tuple jsonb;
    valid_rows boolean;
BEGIN
    IF jsonb_typeof(doc) <> 'object' THEN RETURN NULL; END IF;
    IF doc - ARRAY['request','previewReceiptId','baseline','projectIds','outcomes'] <> '{}'::jsonb
        OR request_hash IS NULL OR public.ingestion_xlsx_v1_uuid(receipt) IS NOT TRUE
        OR (jsonb_typeof(projects) = 'array' AND jsonb_typeof(outcomes) = 'array') IS NOT TRUE
    THEN RETURN NULL; END IF;
    IF jsonb_array_length(projects) NOT BETWEEN 1 AND 100 OR jsonb_array_length(outcomes) > 1000
    THEN RETURN NULL; END IF;
    IF prior IS DISTINCT FROM '{"kind":"GENESIS"}'::jsonb THEN
        IF (jsonb_typeof(prior) = 'object' AND prior->'kind' = '"RETAINED"'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
        prior_revision := public.ingestion_xlsx_v1_uint(prior->'revision', 2147483647);
        IF prior - ARRAY['kind','receiptId','revision','stateSha256'] <> '{}'::jsonb
            OR public.ingestion_xlsx_v1_uuid(prior->'receiptId') IS NOT TRUE
            OR prior->'receiptId' = receipt OR prior_revision IS NULL
            OR public.ingestion_xlsx_v1_digest(prior->'stateSha256') IS NOT TRUE
        THEN RETURN NULL; END IF;
        prior_tuple := jsonb_build_array('RETAINED'::text, prior->'receiptId', prior_revision, prior->'stateSha256');
    END IF;
    IF EXISTS (
        SELECT 1 FROM (
            SELECT value, lag(value) OVER (ORDER BY ordinal) AS previous
            FROM jsonb_array_elements(projects) WITH ORDINALITY AS item(value, ordinal)
        ) ordered
        WHERE public.ingestion_xlsx_v1_uuid(value) IS NOT TRUE
            OR (previous #>> '{}') COLLATE "C" >= (value #>> '{}') COLLATE "C"
    ) THEN RETURN NULL; END IF;
    WITH checked AS MATERIALIZED (
        SELECT ordinal, public.ingestion_xlsx_v1_outcome(value, ordinal::integer, projects) AS tuple
        FROM jsonb_array_elements(outcomes) WITH ORDINALITY AS item(value, ordinal)
    )
    SELECT coalesce(jsonb_agg(tuple ORDER BY ordinal), '[]'::jsonb),
        count(*) = count(tuple) AND count(tuple->5) FILTER (WHERE tuple->>1 = 'ACCEPTED') =
            count(DISTINCT tuple->5) FILTER (WHERE tuple->>1 = 'ACCEPTED')
    INTO rows_tuple, valid_rows FROM checked;
    IF NOT valid_rows THEN RETURN NULL; END IF;
    -- The validated context tuple contains only spaceless ASCII tokens, integers and nulls.
    RETURN encode(sha256(convert_to(replace(jsonb_build_array('pdaa.xlsx.preview-context.v1'::text,
        receipt, request_hash, prior_tuple, projects, rows_tuple)::text, ' ', ''), 'UTF8')), 'hex');
END;
$$;

CREATE FUNCTION public.ingestion_xlsx_v1_selection_hash(command jsonb, preview jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog AS $$
DECLARE
    ordinals jsonb := command->'rowOrdinals';
    context_hash text;
    selection_tuple jsonb;
    eligible boolean;
BEGIN
    IF jsonb_typeof(command) <> 'object' THEN RETURN NULL; END IF;
    IF command - ARRAY['customerId','sourceId','subject','commandKey','previewReceiptId','previewContextSha256','rowOrdinals'] <> '{}'::jsonb
        OR public.ingestion_xlsx_v1_scope(command) IS NOT TRUE
        OR public.ingestion_xlsx_v1_uuid(command->'previewReceiptId') IS NOT TRUE
        OR public.ingestion_xlsx_v1_digest(command->'previewContextSha256') IS NOT TRUE
        OR (jsonb_typeof(ordinals) = 'array') IS NOT TRUE
    THEN RETURN NULL; END IF;
    IF jsonb_array_length(ordinals) NOT BETWEEN 1 AND 1000 THEN RETURN NULL; END IF;
    context_hash := public.ingestion_xlsx_v1_context_hash(preview);
    IF context_hash IS DISTINCT FROM command->>'previewContextSha256'
        OR preview->'previewReceiptId' IS DISTINCT FROM command->'previewReceiptId'
        OR preview->'request'->'customerId' IS DISTINCT FROM command->'customerId'
        OR preview->'request'->'sourceId' IS DISTINCT FROM command->'sourceId'
    THEN RETURN NULL; END IF;
    WITH checked AS (
        SELECT position, public.ingestion_xlsx_v1_uint(value, 1000) AS ordinal
        FROM jsonb_array_elements(ordinals) WITH ORDINALITY AS item(value, position)
    ), ordered AS (
        SELECT position, ordinal, lag(ordinal, 1, 0) OVER (ORDER BY position) AS previous,
            preview->'outcomes'->(ordinal - 1) AS outcome
        FROM checked
    )
    SELECT jsonb_agg(ordinal ORDER BY position), bool_and((ordinal > previous
        AND outcome->>'state' = 'ACCEPTED' AND outcome->>'operation' <> 'NONE') IS TRUE)
    INTO selection_tuple, eligible FROM ordered;
    IF eligible IS NOT TRUE THEN RETURN NULL; END IF;
    RETURN encode(sha256(convert_to('["pdaa.xlsx.reviewed-selection.v1",' || concat_ws(',',
        command->'customerId', command->'sourceId', command->'subject', command->'commandKey',
        command->'previewReceiptId', command->'previewContextSha256', replace(selection_tuple::text, ' ', '')) || ']', 'UTF8')), 'hex');
END;
$$;

DO $xlsx_acl$
DECLARE recipients text;
BEGIN
    SELECT concat_ws(',', 'PUBLIC', string_agg(quote_ident(rolname), ',')) INTO recipients
        FROM pg_catalog.pg_roles WHERE rolname IN ('pdaa_api','pdaa_worker','pdaa_backup');
    EXECUTE 'REVOKE ALL ON FUNCTION public.ingestion_xlsx_v1_uuid(jsonb), public.ingestion_xlsx_v1_digest(jsonb),
        public.ingestion_xlsx_v1_uint(jsonb,integer), public.ingestion_xlsx_v1_text(jsonb,integer),
        public.ingestion_xlsx_v1_scope(jsonb), public.ingestion_xlsx_v1_request_hash(jsonb),
        public.ingestion_xlsx_v1_outcome(jsonb,integer,jsonb), public.ingestion_xlsx_v1_context_hash(jsonb),
        public.ingestion_xlsx_v1_selection_hash(jsonb,jsonb) FROM ' || recipients;
END $xlsx_acl$;
