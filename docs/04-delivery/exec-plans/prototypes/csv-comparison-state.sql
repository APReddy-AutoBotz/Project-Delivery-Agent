-- FR-CON-006/007/012 / NFR-SEC-001: pure migration-28 serializer prototype.
-- Not an applied migration or an application startup script. Execute only in an
-- explicitly isolated synthetic test database. No tables or content are read.
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
