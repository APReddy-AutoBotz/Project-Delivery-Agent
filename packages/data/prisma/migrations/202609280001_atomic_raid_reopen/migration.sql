-- Atomic, source-backed transition from a closed RAID item to a reopened period.
CREATE TABLE public."RaidReopenReceipt" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "raidItemId" uuid NOT NULL,
  subject varchar(256) NOT NULL,
  "idempotencyKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL,
  "factRequestHash" char(64) NOT NULL,
  "expectedState" varchar(16) NOT NULL,
  "newState" varchar(16) NOT NULL,
  "factId" uuid NOT NULL,
  "versionId" uuid NOT NULL,
  "transactionId" bigint NOT NULL,
  "createdAt" timestamptz(3) NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "RaidReopenReceipt_scope_key" UNIQUE ("customerId","projectId",id),
  CONSTRAINT "RaidReopenReceipt_request_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  CONSTRAINT "RaidReopenReceipt_version_key" UNIQUE ("customerId","projectId","factId","versionId"),
  CONSTRAINT "RaidReopenReceipt_subject_check" CHECK (length(subject) BETWEEN 1 AND 256 AND subject=btrim(subject)),
  CONSTRAINT "RaidReopenReceipt_idempotency_check" CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT "RaidReopenReceipt_request_hash_check" CHECK ("requestHash" ~ '^[0-9a-f]{64}$' AND "factRequestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "RaidReopenReceipt_state_check" CHECK ("expectedState" IN ('COMPLETE','CANCELLED') AND "newState" IN ('OPEN','IN_PROGRESS')),
  CONSTRAINT "RaidReopenReceipt_transaction_check" CHECK ("transactionId">0),
  CONSTRAINT "RaidReopenReceipt_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES public."Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "RaidReopenReceipt_raid_fk" FOREIGN KEY ("customerId","projectId","raidItemId") REFERENCES public."RaidItem"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "RaidReopenReceipt_version_fk" FOREIGN KEY ("customerId","projectId","factId","versionId") REFERENCES public."ProjectFactVersion"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.guard_raid_reopen_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  v_portfolio uuid;
  v_state text;
  v_fact_type text;
  v_fact_revision integer;
  v_version_revision integer;
  v_value jsonb;
  v_effective_at timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'RAID reopen receipt is immutable'; END IF;
  IF NEW."transactionId" IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'RAID reopen receipt transaction mismatch';
  END IF;
  SELECT p."portfolioId" INTO v_portfolio
    FROM public."Project" p
    WHERE p."customerId"=NEW."customerId" AND p.id=NEW."projectId";
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public."CanonicalProject" c
    WHERE c."customerId"=NEW."customerId" AND c.id=NEW."projectId"
      AND c.sealed AND public.valid_canonical_project(c.id)
  ) THEN RAISE EXCEPTION 'Canonical RAID project unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."AccessGrant" g
    WHERE g."customerId"=NEW."customerId" AND g.subject=NEW.subject
      AND g.role IN ('project_manager','portfolio_manager','pmo_admin')
      AND ((g."scopeType"='project' AND g."scopeId"=NEW."projectId")
        OR (g."scopeType"='portfolio' AND g."scopeId"=v_portfolio))
  ) THEN RAISE EXCEPTION 'RAID reopen authorization unavailable'; END IF;
  SELECT r.state INTO v_state FROM public."RaidItem" r
    WHERE r."customerId"=NEW."customerId" AND r."projectId"=NEW."projectId"
      AND r.id=NEW."raidItemId" FOR UPDATE;
  IF NOT FOUND OR v_state IS DISTINCT FROM NEW."expectedState" THEN
    RAISE EXCEPTION 'RAID reopen source state mismatch';
  END IF;
  SELECT f."factType",f.revision,v.revision,v.value,v."effectiveAt"
    INTO v_fact_type,v_fact_revision,v_version_revision,v_value,v_effective_at
    FROM public."ProjectFact" f
    JOIN public."ProjectFactVersion" v
      ON v."customerId"=f."customerId" AND v."projectId"=f."projectId"
      AND v."factId"=f.id
    WHERE f."customerId"=NEW."customerId" AND f."projectId"=NEW."projectId"
      AND f.id=NEW."factId" AND v.id=NEW."versionId";
  IF NOT FOUND
    OR v_fact_type IS DISTINCT FROM ('raid_item.'||NEW."raidItemId"::text||'.opened_at')
    OR v_fact_revision IS DISTINCT FROM v_version_revision
    OR NOT public.valid_project_fact_value(v_value)
    OR v_value->>'type' IS DISTINCT FROM 'date'
    OR v_value->>'value' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    OR v_effective_at IS DISTINCT FROM ((v_value->>'value')::date::timestamp AT TIME ZONE 'UTC')
  THEN RAISE EXCEPTION 'RAID reopen requires a current explicit date fact'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."FactAppendReceipt" ar
    WHERE ar."customerId"=NEW."customerId" AND ar."projectId"=NEW."projectId"
      AND ar.subject=NEW.subject AND ar."idempotencyKey"=NEW."idempotencyKey"
      AND ar."factId"=NEW."factId" AND ar."versionId"=NEW."versionId"
      AND ar."requestHash"=NEW."factRequestHash"
  ) THEN RAISE EXCEPTION 'RAID reopen fact receipt unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."ProjectFactVersion" v
    JOIN public."FactSourceAccess" a
      ON a."customerId"=v."customerId" AND a."projectId"=v."projectId"
      AND a."factId"=v."factId" AND a."sourceId"=v."sourceId"
    JOIN public."FactSourceReader" r
      ON r."customerId"=v."customerId" AND r."projectId"=v."projectId"
      AND r."factId"=v."factId" AND r."sourceId"=v."sourceId"
    WHERE v."customerId"=NEW."customerId" AND v."projectId"=NEW."projectId"
      AND v."factId"=NEW."factId" AND v.id=NEW."versionId"
      AND v.provenance='HUMAN_CONFIRMED' AND a.state='AVAILABLE'
      AND r.subject=NEW.subject
  ) THEN RAISE EXCEPTION 'RAID reopen date source unavailable'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."AuditEvent" e
    WHERE e."customerId"=NEW."customerId" AND e.actor=NEW.subject
      AND e.event='raid_item.reopened'
      AND e.detail @> jsonb_build_object(
        'projectId',NEW."projectId"::text,
        'raidItemId',NEW."raidItemId"::text,
        'state',NEW."newState",
        'factId',NEW."factId"::text,
        'versionId',NEW."versionId"::text
      )
  ) THEN RAISE EXCEPTION 'RAID reopen audit event unavailable'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.guard_canonical_raid_reopen() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Canonical RAID state is immutable outside guarded reopen';
  END IF;
  IF TG_OP<>'UPDATE'
    OR OLD.state NOT IN ('COMPLETE','CANCELLED')
    OR NEW.state NOT IN ('OPEN','IN_PROGRESS')
    OR (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
    OR NOT EXISTS (
      SELECT 1 FROM public."RaidReopenReceipt" r
      WHERE r."customerId"=OLD."customerId" AND r."projectId"=OLD."projectId"
        AND r."raidItemId"=OLD.id AND r."expectedState"=OLD.state
        AND r."newState"=NEW.state AND r."transactionId"=txid_current()
    )
  THEN RAISE EXCEPTION 'Canonical RAID state is immutable outside guarded reopen'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.reopen_canonical_raid_item(
  p_customer_id uuid,
  p_project_id uuid,
  p_raid_item_id uuid,
  p_subject text,
  p_actor_roles jsonb,
  p_expected_state text,
  p_new_state text,
  p_expected_fact_revision integer,
  p_opened_at date,
  p_valid_until timestamptz,
  p_original_statement text,
  p_idempotency_key text,
  p_request_hash text,
  p_fact_request_hash text,
  p_correlation_id text
)
RETURNS TABLE(
  outcome text,
  project_id uuid,
  raid_item_id uuid,
  state text,
  fact_id uuid,
  version_id uuid,
  fact_revision integer,
  replayed boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  v_portfolio uuid;
  v_grant record;
  v_allowed boolean := false;
  v_sealed boolean;
  v_prior public."RaidReopenReceipt"%ROWTYPE;
  v_current_state text;
  v_fact_type text;
  v_fact_id uuid;
  v_fact_revision integer;
  v_source_id uuid;
  v_source_found boolean;
  v_access_state text;
  v_reader_found boolean;
  v_evidence_id uuid;
  v_version_id uuid;
  v_new_revision integer;
  v_effective_at timestamptz;
  v_now timestamptz;
BEGIN
  IF p_customer_id IS NULL OR p_project_id IS NULL OR p_raid_item_id IS NULL
    OR p_subject IS NULL OR length(p_subject)<1 OR length(p_subject)>256 OR p_subject<>btrim(p_subject)
    OR p_actor_roles IS NULL OR jsonb_typeof(p_actor_roles)<>'array'
    OR p_expected_state IS NULL OR p_expected_state NOT IN ('COMPLETE','CANCELLED')
    OR p_new_state IS NULL OR p_new_state NOT IN ('OPEN','IN_PROGRESS')
    OR p_expected_fact_revision IS NULL OR p_expected_fact_revision NOT BETWEEN 0 AND 2147483646
    OR p_opened_at IS NULL
    OR (p_valid_until IS NOT NULL AND NOT isfinite(p_valid_until))
    OR p_original_statement IS NULL OR length(p_original_statement)<1
    OR length(p_original_statement)>8192 OR p_original_statement<>btrim(p_original_statement)
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{8,128}$'
    OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_fact_request_hash IS NULL OR p_fact_request_hash !~ '^[0-9a-f]{64}$'
    OR p_correlation_id IS NULL OR p_correlation_id !~ '^[A-Za-z0-9_.:-]{1,128}$'
  THEN
    outcome:='INVALID'; RETURN NEXT; RETURN;
  END IF;
  v_effective_at := p_opened_at::timestamp AT TIME ZONE 'UTC';
  IF p_valid_until IS NOT NULL AND p_valid_until<v_effective_at THEN
    outcome:='INVALID'; RETURN NEXT; RETURN;
  END IF;

  SELECT p."portfolioId" INTO v_portfolio FROM public."Project" p
    WHERE p."customerId"=p_customer_id AND p.id=p_project_id FOR UPDATE;
  IF NOT FOUND THEN outcome:='DENIED'; RETURN NEXT; RETURN; END IF;
  FOR v_grant IN
    SELECT g.role FROM public."AccessGrant" g
    WHERE g."customerId"=p_customer_id AND g.subject=p_subject
      AND ((g."scopeType"='project' AND g."scopeId"=p_project_id)
        OR (g."scopeType"='portfolio' AND g."scopeId"=v_portfolio))
    ORDER BY g.id FOR SHARE OF g
  LOOP
    IF v_grant.role IN ('project_manager','portfolio_manager','pmo_admin')
      AND p_actor_roles ? v_grant.role THEN v_allowed:=true; END IF;
  END LOOP;
  IF NOT v_allowed THEN outcome:='DENIED'; RETURN NEXT; RETURN; END IF;

  SELECT c.sealed INTO v_sealed FROM public."CanonicalProject" c
    WHERE c."customerId"=p_customer_id AND c.id=p_project_id FOR SHARE;
  IF NOT FOUND OR v_sealed IS DISTINCT FROM true
    OR NOT public.valid_canonical_project(p_project_id)
  THEN outcome:='DENIED'; RETURN NEXT; RETURN; END IF;

  SELECT r.* INTO v_prior FROM public."RaidReopenReceipt" r
    WHERE r."customerId"=p_customer_id AND r."projectId"=p_project_id
      AND r.subject=p_subject AND r."idempotencyKey"=p_idempotency_key;
  IF FOUND THEN
    IF v_prior."requestHash"<>p_request_hash THEN
      outcome:='CONFLICT'; RETURN NEXT; RETURN;
    END IF;
    SELECT v.revision INTO v_new_revision FROM public."ProjectFactVersion" v
      WHERE v."customerId"=p_customer_id AND v."projectId"=p_project_id
        AND v."factId"=v_prior."factId" AND v.id=v_prior."versionId";
    outcome:='SUCCESS';
    project_id:=p_project_id; raid_item_id:=v_prior."raidItemId";
    state:=v_prior."newState"; fact_id:=v_prior."factId";
    version_id:=v_prior."versionId"; fact_revision:=v_new_revision;
    replayed:=true; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."FactAppendReceipt" r
    WHERE r."customerId"=p_customer_id AND r."projectId"=p_project_id
      AND r.subject=p_subject AND r."idempotencyKey"=p_idempotency_key
  ) THEN outcome:='CONFLICT'; RETURN NEXT; RETURN; END IF;

  SELECT r.state INTO v_current_state FROM public."RaidItem" r
    WHERE r."customerId"=p_customer_id AND r."projectId"=p_project_id
      AND r.id=p_raid_item_id FOR UPDATE;
  IF NOT FOUND THEN outcome:='DENIED'; RETURN NEXT; RETURN; END IF;
  IF v_current_state IS DISTINCT FROM p_expected_state THEN
    outcome:='CONFLICT'; RETURN NEXT; RETURN;
  END IF;

  v_fact_type:='raid_item.'||p_raid_item_id::text||'.opened_at';
  SELECT f.id,f.revision INTO v_fact_id,v_fact_revision
    FROM public."ProjectFact" f
    WHERE f."customerId"=p_customer_id AND f."projectId"=p_project_id
      AND f."factType"=v_fact_type FOR UPDATE;
  IF FOUND THEN
    IF v_fact_revision<>p_expected_fact_revision THEN
      outcome:='CONFLICT'; RETURN NEXT; RETURN;
    END IF;
  ELSIF p_expected_fact_revision<>0 THEN
    outcome:='CONFLICT'; RETURN NEXT; RETURN;
  ELSE
    v_fact_id:=gen_random_uuid(); v_fact_revision:=0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public."FactAppendReceipt" r
    WHERE r."customerId"=p_customer_id AND r."projectId"=p_project_id
      AND r.subject=p_subject AND r."idempotencyKey"=p_idempotency_key
  ) THEN outcome:='CONFLICT'; RETURN NEXT; RETURN; END IF;

  SELECT s.id INTO v_source_id FROM public."FactSource" s
    WHERE s."customerId"=p_customer_id AND s."projectId"=p_project_id
      AND s."factId"=v_fact_id AND s."providedBy"=p_subject FOR UPDATE;
  v_source_found:=FOUND;
  -- A different human provider has a separate immutable source stream. Do not
  -- report a successful reopen if this date could conflict with or bypass it.
  IF EXISTS (
    SELECT 1 FROM public."FactSource" other_source
    WHERE other_source."customerId"=p_customer_id
      AND other_source."projectId"=p_project_id
      AND other_source."factId"=v_fact_id
      AND other_source."providedBy"<>p_subject
  ) THEN
    outcome:='CONFLICT'; RETURN NEXT; RETURN;
  END IF;
  IF v_source_found THEN
    SELECT a.state INTO v_access_state FROM public."FactSourceAccess" a
      WHERE a."customerId"=p_customer_id AND a."projectId"=p_project_id
        AND a."factId"=v_fact_id AND a."sourceId"=v_source_id FOR SHARE;
    IF NOT FOUND OR v_access_state<>'AVAILABLE' THEN
      outcome:='CONFLICT'; RETURN NEXT; RETURN;
    END IF;
    PERFORM 1 FROM public."FactSourceReader" r
      WHERE r."customerId"=p_customer_id AND r."projectId"=p_project_id
        AND r."factId"=v_fact_id AND r."sourceId"=v_source_id
        AND r.subject=p_subject FOR SHARE;
    IF NOT FOUND THEN outcome:='CONFLICT'; RETURN NEXT; RETURN; END IF;
  ELSE
    v_source_id:=gen_random_uuid();
  END IF;

  IF v_fact_revision=0 AND NOT EXISTS (
    SELECT 1 FROM public."ProjectFact" f
    WHERE f."customerId"=p_customer_id AND f."projectId"=p_project_id
      AND f.id=v_fact_id
  ) THEN
    INSERT INTO public."ProjectFact" (id,"customerId","projectId","factType")
    VALUES (v_fact_id,p_customer_id,p_project_id,v_fact_type);
  END IF;
  IF NOT v_source_found THEN
    INSERT INTO public."FactSource" (id,"customerId","projectId","factId","providedBy")
    VALUES (v_source_id,p_customer_id,p_project_id,v_fact_id,p_subject);
    INSERT INTO public."FactSourceAccess" ("customerId","projectId","factId","sourceId",state)
    VALUES (p_customer_id,p_project_id,v_fact_id,v_source_id,'AVAILABLE');
    INSERT INTO public."FactSourceReader" ("customerId","projectId","factId","sourceId",subject)
    VALUES (p_customer_id,p_project_id,v_fact_id,v_source_id,p_subject);
  END IF;
  v_evidence_id:=gen_random_uuid(); v_version_id:=gen_random_uuid();
  v_new_revision:=p_expected_fact_revision+1; v_now:=clock_timestamp();
  INSERT INTO public."FactEvidence" (id,"customerId","projectId","factId","sourceId","providedBy","observedAt","originalStatement")
  VALUES (v_evidence_id,p_customer_id,p_project_id,v_fact_id,v_source_id,p_subject,v_now,p_original_statement);
  INSERT INTO public."ProjectFactVersion"
    (id,"customerId","projectId","factId","sourceId","evidenceId",revision,value,provenance,"effectiveAt","validUntil")
  VALUES
    (v_version_id,p_customer_id,p_project_id,v_fact_id,v_source_id,v_evidence_id,v_new_revision,
      jsonb_build_object('type','date','value',p_opened_at::text),'HUMAN_CONFIRMED',v_effective_at,p_valid_until);
  INSERT INTO public."FactAppendReceipt"
    (id,"customerId","projectId",subject,"idempotencyKey","requestHash","factId","versionId")
  VALUES (gen_random_uuid(),p_customer_id,p_project_id,p_subject,p_idempotency_key,p_fact_request_hash,v_fact_id,v_version_id);

  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
  VALUES (gen_random_uuid(),p_customer_id,p_subject,'fact.appended',p_correlation_id,
    jsonb_build_object('factId',v_fact_id::text,'versionId',v_version_id::text,
      'evidenceId',v_evidence_id::text,'revision',v_new_revision),v_now);
  INSERT INTO public."AuditEvent" (id,"customerId",actor,event,"correlationId",detail,"occurredAt")
  VALUES (gen_random_uuid(),p_customer_id,p_subject,'raid_item.reopened',p_correlation_id,
    jsonb_build_object('projectId',p_project_id::text,'raidItemId',p_raid_item_id::text,
      'state',p_new_state,'factId',v_fact_id::text,'versionId',v_version_id::text),v_now);
  INSERT INTO public."RaidReopenReceipt"
    (id,"customerId","projectId","raidItemId",subject,"idempotencyKey","requestHash","factRequestHash",
      "expectedState","newState","factId","versionId","transactionId","createdAt")
  VALUES (gen_random_uuid(),p_customer_id,p_project_id,p_raid_item_id,p_subject,p_idempotency_key,
    p_request_hash,p_fact_request_hash,p_expected_state,p_new_state,v_fact_id,v_version_id,txid_current(),v_now);
  UPDATE public."RaidItem" SET state=p_new_state
    WHERE "customerId"=p_customer_id AND "projectId"=p_project_id AND id=p_raid_item_id;
  IF NOT FOUND THEN outcome:='CONFLICT'; RETURN NEXT; RETURN; END IF;
  outcome:='SUCCESS';
  project_id:=p_project_id; raid_item_id:=p_raid_item_id;
  state:=p_new_state; fact_id:=v_fact_id; version_id:=v_version_id;
  fact_revision:=v_new_revision; replayed:=false;
  RETURN NEXT; RETURN;
END $$;

CREATE TRIGGER "RaidReopenReceipt_insert_guard"
  BEFORE INSERT ON public."RaidReopenReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.guard_raid_reopen_receipt();
CREATE TRIGGER "RaidReopenReceipt_immutable"
  BEFORE UPDATE OR DELETE ON public."RaidReopenReceipt"
  FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER "RaidReopenReceipt_no_truncate"
  BEFORE TRUNCATE ON public."RaidReopenReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();

DROP TRIGGER canonical_no_mutation ON public."RaidItem";
CREATE TRIGGER canonical_raid_reopen_guard
  BEFORE UPDATE OR DELETE ON public."RaidItem"
  FOR EACH ROW EXECUTE FUNCTION public.guard_canonical_raid_reopen();

REVOKE ALL ON FUNCTION public.guard_raid_reopen_receipt(),public.guard_canonical_raid_reopen() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_canonical_raid_item(uuid,uuid,uuid,text,jsonb,text,text,integer,date,timestamptz,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON TABLE public."RaidReopenReceipt" FROM PUBLIC;

DO $raid_reopen_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pdaa_api') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."RaidReopenReceipt" FROM pdaa_api';
    EXECUTE 'REVOKE ALL ON FUNCTION public.reopen_canonical_raid_item(uuid,uuid,uuid,text,jsonb,text,text,integer,date,timestamptz,text,text,text,text,text) FROM pdaa_api';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.reopen_canonical_raid_item(uuid,uuid,uuid,text,jsonb,text,text,integer,date,timestamptz,text,text,text,text,text) TO pdaa_api';
  END IF;
END $raid_reopen_acl$;
