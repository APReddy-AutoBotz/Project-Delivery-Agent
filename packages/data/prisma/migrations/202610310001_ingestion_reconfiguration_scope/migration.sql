-- The API role's actor remains an application assertion. This additional
-- guard checks that assertion against both configuration scopes at sealing
-- and again when the source head is advanced.
CREATE FUNCTION public.guard_ingestion_reconfiguration_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  customer_id uuid;
  source_id uuid;
  old_revision integer;
  new_revision integer;
  actor_subject text;
  scope_count integer;
  grant_id uuid;
  locked_grant_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_TABLE_NAME='IngestionConfigurationRevision' THEN
    IF TG_OP<>'UPDATE' OR OLD.sealed OR NOT NEW.sealed THEN RETURN NEW; END IF;
    customer_id := NEW."customerId";
    source_id := NEW."sourceId";
    new_revision := NEW.revision;
    actor_subject := NEW."changedBy";
    SELECT s."currentConfigRevision" INTO old_revision
      FROM public."IngestionSource" s
      WHERE s."customerId"=customer_id AND s.id=source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion configuration scope unavailable'; END IF;
  ELSE
    IF NEW."currentConfigRevision" IS NOT DISTINCT FROM OLD."currentConfigRevision" THEN RETURN NEW; END IF;
    customer_id := NEW."customerId";
    source_id := NEW.id;
    old_revision := OLD."currentConfigRevision";
    new_revision := NEW."currentConfigRevision";
    SELECT c."changedBy" INTO actor_subject
      FROM public."IngestionConfigurationRevision" c
      WHERE c."customerId"=customer_id AND c."sourceId"=source_id
        AND c.revision=new_revision AND c.sealed;
    IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion configuration scope unavailable'; END IF;
  END IF;

  IF new_revision IS NULL OR
     (old_revision IS NULL AND new_revision<>1) OR
     (old_revision IS NOT NULL AND new_revision<>old_revision+1) THEN
    RAISE EXCEPTION 'Ingestion configuration scope unavailable';
  END IF;
  IF old_revision IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public."IngestionConfigurationRevision" c
    WHERE c."customerId"=customer_id AND c."sourceId"=source_id
      AND c.revision=old_revision AND c.sealed
  ) THEN RAISE EXCEPTION 'Ingestion configuration scope unavailable'; END IF;

  SELECT count(*) INTO scope_count FROM public."IngestionConfigurationProject" cp
    WHERE cp."customerId"=customer_id AND cp."sourceId"=source_id AND cp."configRevision"=new_revision;
  IF scope_count<1 THEN RAISE EXCEPTION 'Ingestion configuration scope is empty'; END IF;
  IF scope_count>100 THEN RAISE EXCEPTION 'Ingestion configuration project limit exceeded'; END IF;
  IF old_revision IS NOT NULL THEN
    SELECT count(*) INTO scope_count FROM public."IngestionConfigurationProject" cp
      WHERE cp."customerId"=customer_id AND cp."sourceId"=source_id AND cp."configRevision"=old_revision;
    IF scope_count<1 OR scope_count>100 THEN RAISE EXCEPTION 'Ingestion configuration scope unavailable'; END IF;
  END IF;

  -- Lock base rows, not the UNION, in stable order. Locks survive both checks.
  PERFORM p.id FROM public."Project" p
    WHERE p."customerId"=customer_id AND EXISTS (
      SELECT 1 FROM public."IngestionConfigurationProject" cp
      WHERE cp."customerId"=customer_id AND cp."sourceId"=source_id
        AND cp."configRevision" IN (old_revision,new_revision) AND cp."projectId"=p.id
    ) ORDER BY p.id FOR UPDATE OF p;
  FOR grant_id IN SELECT g.id FROM public."AccessGrant" g
    WHERE g."customerId"=customer_id AND g.subject=actor_subject AND g.role='pmo_admin'
      AND EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp
        JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
        WHERE cp."customerId"=customer_id AND cp."sourceId"=source_id
          AND cp."configRevision" IN (old_revision,new_revision)
          AND ((g."scopeType"='project' AND g."scopeId"=p.id)
            OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId")))
    ORDER BY g.id FOR SHARE OF g
  LOOP
    locked_grant_ids := array_append(locked_grant_ids, grant_id);
  END LOOP;
  IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" cp
    LEFT JOIN public."Project" p ON p."customerId"=cp."customerId" AND p.id=cp."projectId"
    WHERE cp."customerId"=customer_id AND cp."sourceId"=source_id
      AND cp."configRevision" IN (old_revision,new_revision)
      AND (p.id IS NULL OR NOT EXISTS (SELECT 1 FROM public."AccessGrant" g
        WHERE g.id=ANY(locked_grant_ids) AND g."customerId"=customer_id AND g.subject=actor_subject AND g.role='pmo_admin'
          AND ((g."scopeType"='project' AND g."scopeId"=p.id)
            OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))))) THEN
    RAISE EXCEPTION 'Ingestion configuration requires current PMO project grants';
  END IF;
  RETURN NEW;
END $$;

-- Alphabetical trigger ordering makes the source/union lock precede the
-- existing configuration seal guard's per-project locking.
CREATE TRIGGER ingestion_00_reconfiguration_scope_at_seal
  BEFORE UPDATE ON public."IngestionConfigurationRevision"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_reconfiguration_scope();
CREATE TRIGGER ingestion_reconfiguration_scope_at_head
  BEFORE UPDATE ON public."IngestionSource"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_reconfiguration_scope();
REVOKE ALL ON FUNCTION public.guard_ingestion_reconfiguration_scope() FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['pdaa_api','pdaa_worker','pdaa_backup'] LOOP
    IF to_regrole(role_name) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.guard_ingestion_reconfiguration_scope() FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
