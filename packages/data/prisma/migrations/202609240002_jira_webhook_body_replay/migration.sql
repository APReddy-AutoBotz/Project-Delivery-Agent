CREATE UNIQUE INDEX "ConnectorWebhookReceipt_payload_key"
ON public."ConnectorWebhookReceipt"("customerId","sourceId","payloadHash");

CREATE OR REPLACE FUNCTION public.guard_connector_credential() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE audit_row public."AuditEvent"%ROWTYPE; expected_event text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Connector credential history is retained'; END IF;
  IF NEW."sourceId" IS NULL AND NEW.purpose IS NULL THEN
    IF TG_OP='UPDATE' AND ROW(NEW.id,NEW."customerId",NEW.name,NEW.envelope,NEW."keyId",NEW.revision) IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD.name,OLD.envelope,OLD."keyId",OLD.revision) THEN RAISE EXCEPTION 'Legacy credentials are immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revision<>1 OR NEW.state<>'ACTIVE' OR NEW."rotationOperationId" IS NOT NULL OR NEW."rotationDeadline" IS NOT NULL THEN RAISE EXCEPTION 'Invalid connector credential creation'; END IF;
    expected_event:='ingestion.connector_credential.configured';
  ELSE
    IF ROW(NEW.id,NEW."customerId",NEW."sourceId",NEW.purpose) IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."sourceId",OLD.purpose) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid connector credential revision'; END IF;
    IF OLD.state='ACTIVE' AND NEW.state='ROTATING' AND NEW.purpose='jira_oauth' AND NEW."rotationOperationId" IS NOT NULL AND NEW."rotationDeadline">CURRENT_TIMESTAMP AND NEW."rotationDeadline"<=CURRENT_TIMESTAMP+interval '60 seconds' THEN
      expected_event:='ingestion.connector_credential.rotation_started';
    ELSIF OLD.state='ROTATING' AND NEW.state='ACTIVE' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.rotation_completed';
    ELSIF OLD.state='ROTATING' AND NEW.state='REAUTH_REQUIRED' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.reauth_required';
    ELSIF OLD.purpose='jira_oauth' AND OLD.state='ACTIVE' AND NEW.state='REAUTH_REQUIRED' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.reauth_required';
    ELSIF OLD.purpose='jira_webhook_hmac' AND NEW.purpose=OLD.purpose AND NEW.state='ACTIVE' AND OLD.state='ACTIVE' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_webhook_secret.rotated';
    ELSIF OLD.purpose='jira_oauth' AND OLD.state IN ('ACTIVE','REAUTH_REQUIRED') AND NEW.purpose=OLD.purpose AND NEW.state='ACTIVE' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.configured';
    ELSIF OLD.state='REAUTH_REQUIRED' AND NEW.state='ACTIVE' AND NEW.purpose='jira_oauth' AND NEW."rotationOperationId" IS NULL AND NEW."rotationDeadline" IS NULL THEN
      expected_event:='ingestion.connector_credential.configured';
    ELSE
      RAISE EXCEPTION 'Invalid connector credential state transition';
    END IF;
  END IF;
  SELECT * INTO audit_row FROM public."AuditEvent"
  WHERE id=NEW."auditEventId" AND "customerId"=NEW."customerId" AND actor=NEW."changedBy"
    AND event=expected_event
    AND detail=jsonb_build_object('sourceId',NEW."sourceId",'purpose',NEW.purpose,'state',NEW.state,'revision',NEW.revision,'rotationOperationId',NEW."rotationOperationId");
  IF NOT FOUND AND TG_OP='UPDATE' THEN
    IF expected_event='ingestion.connector_credential.rotation_completed'
      AND ROW(NEW.envelope,NEW."keyId") IS NOT DISTINCT FROM ROW(OLD.envelope,OLD."keyId") THEN
      SELECT * INTO audit_row FROM public."AuditEvent"
      WHERE id=NEW."auditEventId" AND "customerId"=NEW."customerId" AND actor=NEW."changedBy"
        AND event='ingestion.connector_credential.rotation_deferred'
        AND detail=jsonb_build_object('sourceId',NEW."sourceId",'purpose',NEW.purpose,'state',NEW.state,'revision',NEW.revision,'rotationOperationId',NEW."rotationOperationId",'reason','RATE_LIMITED');
    END IF;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Connector credential update lacks matching audit'; END IF;
  RETURN NEW;
END $$;
