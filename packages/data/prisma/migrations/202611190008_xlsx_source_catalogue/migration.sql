-- FR-CON-006/007: show sealed XLSX sources only to an authorized full-scope reader.
CREATE FUNCTION public.list_ingestion_xlsx_sources(
  customer uuid, actor_subject text, actor_roles text[], after_source uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF session_user<>'pdaa_api' OR customer IS NULL
    OR public.ingestion_xlsx_v1_text(to_jsonb(actor_subject),256) IS NULL
    OR array_ndims(actor_roles) IS DISTINCT FROM 1 OR cardinality(actor_roles) NOT BETWEEN 1 AND 3
    OR EXISTS (SELECT 1 FROM unnest(actor_roles) a(role)
      WHERE role IS NULL OR role NOT IN ('project_manager','portfolio_manager','pmo_admin'))
  THEN RETURN '{"status":"DENIED"}'; END IF;

  WITH authorized AS MATERIALIZED (
    SELECT s.id,c.revision,c."mappingRevision",c.mapping->>'sheet' AS sheet
    FROM public."IngestionSource" s
    JOIN public."IngestionXlsxHead" h ON h."customerId"=s."customerId" AND h."sourceId"=s.id
      AND h."mappingRevision"=s."mappingRevision"
    JOIN public."IngestionConfigurationRevision" c ON c."customerId"=s."customerId" AND c."sourceId"=s.id
      AND c.revision=s."currentConfigRevision" AND c."mappingRevision"=s."mappingRevision" AND c.sealed
    JOIN public."IngestionConfigurationRevision" original ON original."customerId"=s."customerId"
      AND original."sourceId"=s.id AND original.revision=h."activationConfigRevision"
      AND original."mappingRevision"=h."mappingRevision" AND original.sealed AND original.mapping=c.mapping
    CROSS JOIN LATERAL (
      SELECT ARRAY(SELECT p."projectId" FROM public."IngestionConfigurationProject" p
        WHERE p."customerId"=s."customerId" AND p."sourceId"=s.id AND p."configRevision"=c.revision
        ORDER BY p."projectId" LIMIT 101) AS projects
    ) scope
    WHERE s."customerId"=customer AND s."inputFamily"='XLSX'
      AND (after_source IS NULL OR s.id>after_source)
      AND cardinality(scope.projects) BETWEEN 1 AND 100
      AND public.valid_ingestion_xlsx_mapping(c.mapping) IS TRUE
      AND public.can_read_ingestion_xlsx_preview(customer,s.id,actor_subject,actor_roles,c.revision,
        c.revision,scope.projects,'{}'::uuid[],NULL) IS TRUE
    ORDER BY s.id LIMIT 51
  ), numbered AS (
    SELECT a.*,row_number() OVER (ORDER BY a.id) AS position FROM authorized a
  )
  SELECT jsonb_build_object('status','READY',
    'sources',coalesce(jsonb_agg(jsonb_build_object('sourceId',id,
      'configRevision',revision,'mappingRevision',"mappingRevision",'sheet',sheet) ORDER BY id)
      FILTER (WHERE position<=50),'[]'::jsonb),
    'nextSourceId',CASE WHEN count(*)>50 THEN
      (array_agg(id ORDER BY id) FILTER (WHERE position=50))[1] END)
  INTO result FROM numbered;
  RETURN result;
END $$;

DO $roles$
DECLARE runtime_role text;
BEGIN
  REVOKE ALL ON FUNCTION public.list_ingestion_xlsx_sources(uuid,text,text[],uuid) FROM PUBLIC;
  FOREACH runtime_role IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
    IF to_regrole(runtime_role) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.list_ingestion_xlsx_sources(uuid,text,text[],uuid) FROM %I',runtime_role);
    END IF;
  END LOOP;
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    ALTER FUNCTION public.list_ingestion_xlsx_sources(uuid,text,text[],uuid) OWNER TO pdaa_migrate;
    IF to_regrole('pdaa_api') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.list_ingestion_xlsx_sources(uuid,text,text[],uuid) TO pdaa_api;
    END IF;
  END IF;
END $roles$;
