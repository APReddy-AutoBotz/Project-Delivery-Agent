-- FR-ADM-008 / NFR-PRV-004: preserve a fresh immutable audit for each policy revision.
-- Released migrations remain unchanged; ownership and invoker behavior are retained.
CREATE OR REPLACE FUNCTION public.guard_ingestion_retention() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE admin_grant uuid;
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (to_jsonb(NEW)-'retentionHours'-'revision'-'changedBy'-'changedAt'-'auditEventId') IS DISTINCT FROM (to_jsonb(OLD)-'retentionHours'-'revision'-'changedBy'-'changedAt'-'auditEventId'))
    THEN RAISE EXCEPTION 'Invalid ingestion retention update'; END IF;
  IF TG_OP='UPDATE' AND NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Ingestion retention revision must advance'; END IF;
  SELECT id INTO admin_grant FROM public."AccessGrant" WHERE "customerId"=NEW."customerId" AND subject=NEW."changedBy" AND role='system_admin' ORDER BY id LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion retention requires a current system administrator grant'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."AuditEvent" a WHERE a.id=NEW."auditEventId" AND a."customerId"=NEW."customerId" AND a.actor=NEW."changedBy" AND a.event='ingestion.retention.changed' AND a."occurredAt"=NEW."changedAt" AND a.detail=jsonb_build_object('retentionHours',NEW."retentionHours",'revision',NEW.revision)) THEN RAISE EXCEPTION 'Ingestion retention update lacks its audit'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_ingestion_retention() FROM PUBLIC;
