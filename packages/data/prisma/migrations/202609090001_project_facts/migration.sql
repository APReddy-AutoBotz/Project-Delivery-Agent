-- FR-EVD-001/002/003/004/005/009, FR-MOD-007, NFR-SEC-001, TR-STACK-005.
-- Additive, project-only human statement ledger. No source authority claim.
-- Match ECMAScript trim whitespace without changing retained original bytes.
CREATE FUNCTION public.nonblank_fact_text(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(btrim(v, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0
$$;
CREATE TABLE "ProjectFact" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factType" varchar(96) NOT NULL, revision integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("customerId","projectId",id),
  UNIQUE ("customerId","projectId","factType"),
  CHECK ("factType" ~ '^[a-z][a-z0-9_.-]{0,95}$'), CHECK (revision >= 0),
  FOREIGN KEY ("customerId","projectId") REFERENCES "Project"("customerId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactSource" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL, "providedBy" varchar(256) NOT NULL,
  UNIQUE ("customerId","projectId","factId",id),
  CONSTRAINT "FactSource_author_key" UNIQUE ("customerId","projectId","factId",id,"providedBy"),
  UNIQUE ("customerId","projectId","factId","providedBy"),
  CHECK (public.nonblank_fact_text("providedBy")),
  FOREIGN KEY ("customerId","projectId","factId") REFERENCES "ProjectFact"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactSourceAccess" (
  "sourceId" uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL, state varchar(16) NOT NULL, revision integer NOT NULL DEFAULT 1,
  UNIQUE ("customerId","projectId","factId","sourceId"),
  CHECK (state IN ('AVAILABLE','REVOKED','DELETED','UNVERIFIABLE')), CHECK (revision > 0),
  FOREIGN KEY ("customerId","projectId","factId","sourceId") REFERENCES "FactSource"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactSourceReader" (
  "customerId" uuid NOT NULL, "projectId" uuid NOT NULL, "factId" uuid NOT NULL,
  "sourceId" uuid NOT NULL, subject varchar(256) NOT NULL,
  CONSTRAINT "FactSourceReader_pkey" PRIMARY KEY ("customerId","projectId","factId","sourceId",subject),
  CHECK (public.nonblank_fact_text(subject)),
  FOREIGN KEY ("customerId","projectId","factId","sourceId") REFERENCES "FactSourceAccess"("customerId","projectId","factId","sourceId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactEvidence" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL, "sourceId" uuid NOT NULL, "providedBy" varchar(256) NOT NULL,
  "observedAt" timestamptz(3) NOT NULL, "originalStatement" varchar(8192) NOT NULL,
  CONSTRAINT "FactEvidence_scope_key" UNIQUE ("customerId","projectId","factId","sourceId",id),
  CHECK (public.nonblank_fact_text("originalStatement")),
  CHECK ("observedAt" >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "observedAt" < TIMESTAMPTZ '10000-01-01 00:00:00+00'),
  CONSTRAINT "FactEvidence_source_author_fkey" FOREIGN KEY ("customerId","projectId","factId","sourceId","providedBy") REFERENCES "FactSource"("customerId","projectId","factId",id,"providedBy") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "ProjectFactVersion" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  "factId" uuid NOT NULL, "sourceId" uuid NOT NULL, "evidenceId" uuid NOT NULL UNIQUE,
  revision integer NOT NULL, value jsonb NOT NULL,
  provenance varchar(24) NOT NULL DEFAULT 'HUMAN_CONFIRMED',
  "effectiveAt" timestamptz(3) NOT NULL, "validUntil" timestamptz(3),
  CONSTRAINT "ProjectFactVersion_scope_key" UNIQUE ("customerId","projectId","factId",id),
  CONSTRAINT "ProjectFactVersion_revision_key" UNIQUE ("customerId","projectId","factId",revision),
  CONSTRAINT "ProjectFactVersion_scoped_evidence_key" UNIQUE ("customerId","projectId","factId","sourceId","evidenceId"),
  CHECK (revision > 0), CHECK (provenance = 'HUMAN_CONFIRMED'),
  CHECK ("effectiveAt" >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND "effectiveAt" < TIMESTAMPTZ '10000-01-01 00:00:00+00'),
  CHECK ("validUntil" IS NULL OR ("validUntil" >= "effectiveAt" AND "validUntil" < TIMESTAMPTZ '10000-01-01 00:00:00+00')),
  FOREIGN KEY ("customerId","projectId","factId") REFERENCES "ProjectFact"("customerId","projectId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "ProjectFactVersion_evidence_fkey" FOREIGN KEY ("customerId","projectId","factId","sourceId","evidenceId") REFERENCES "FactEvidence"("customerId","projectId","factId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE "FactAppendReceipt" (
  id uuid PRIMARY KEY, "customerId" uuid NOT NULL, "projectId" uuid NOT NULL,
  subject varchar(256) NOT NULL, "idempotencyKey" varchar(128) NOT NULL,
  "requestHash" char(64) NOT NULL, "factId" uuid NOT NULL, "versionId" uuid NOT NULL,
  CONSTRAINT "FactAppendReceipt_request_key" UNIQUE ("customerId","projectId",subject,"idempotencyKey"),
  CHECK (public.nonblank_fact_text(subject)),
  CHECK ("idempotencyKey" ~ '^[A-Za-z0-9_-]{1,128}$'),
  CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "FactAppendReceipt_version_fkey" FOREIGN KEY ("customerId","projectId","factId","versionId") REFERENCES "ProjectFactVersion"("customerId","projectId","factId",id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.valid_project_fact_value(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET extra_float_digits = 3 AS $$
BEGIN
  IF jsonb_typeof(v) <> 'object' OR NOT (v ?& ARRAY['type','value'])
    OR v - 'type' - 'value' <> '{}'::jsonb OR octet_length(v::text) > 32768
    THEN RETURN false; END IF;
  CASE v->>'type'
    WHEN 'text' THEN RETURN jsonb_typeof(v->'value') = 'string' AND length(v->>'value') <= 4096;
    WHEN 'number' THEN RETURN jsonb_typeof(v->'value') = 'number'
      AND abs((v->>'value')::numeric) <= 1.7976931348623157e308::numeric
      AND ((v->>'value')::double precision)::text::numeric = (v->>'value')::numeric;
    WHEN 'boolean' THEN RETURN jsonb_typeof(v->'value') = 'boolean';
    WHEN 'empty' THEN RETURN v->'value' = 'null'::jsonb;
    WHEN 'date' THEN
      IF jsonb_typeof(v->'value') <> 'string' OR v->>'value' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN false; END IF;
      PERFORM make_date(substring(v->>'value',1,4)::integer,substring(v->>'value',6,2)::integer,substring(v->>'value',9,2)::integer);
      RETURN true;
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
ALTER TABLE "ProjectFactVersion" ADD CONSTRAINT "ProjectFactVersion_value_check" CHECK (public.valid_project_fact_value(value));

CREATE FUNCTION public.reject_fact_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Fact history is immutable'; END;
$$;
CREATE TRIGGER fact_source_immutable BEFORE UPDATE OR DELETE ON "FactSource" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_source_no_truncate BEFORE TRUNCATE ON "FactSource" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_evidence_immutable BEFORE UPDATE OR DELETE ON "FactEvidence" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_evidence_no_truncate BEFORE TRUNCATE ON "FactEvidence" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_version_immutable BEFORE UPDATE OR DELETE ON "ProjectFactVersion" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_version_no_truncate BEFORE TRUNCATE ON "ProjectFactVersion" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_receipt_immutable BEFORE UPDATE OR DELETE ON "FactAppendReceipt" FOR EACH ROW EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_receipt_no_truncate BEFORE TRUNCATE ON "FactAppendReceipt" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER project_fact_no_truncate BEFORE TRUNCATE ON "ProjectFact" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_access_no_truncate BEFORE TRUNCATE ON "FactSourceAccess" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();
CREATE TRIGGER fact_reader_no_truncate BEFORE TRUNCATE ON "FactSourceReader" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_fact_history_mutation();

CREATE FUNCTION public.preserve_project_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW."customerId",NEW."portfolioId") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."portfolioId")
    THEN RAISE EXCEPTION 'Project scope is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_scope_immutable BEFORE UPDATE ON "Project" FOR EACH ROW EXECUTE FUNCTION public.preserve_project_scope();

CREATE FUNCTION public.guard_project_fact_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Fact identity is immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 0 THEN RAISE EXCEPTION 'Initial fact revision must be zero'; END IF;
  ELSE
    IF ROW(NEW.id,NEW."customerId",NEW."projectId",NEW."factType",NEW."createdAt") IS DISTINCT FROM ROW(OLD.id,OLD."customerId",OLD."projectId",OLD."factType",OLD."createdAt")
      OR NEW.revision <> OLD.revision + 1
      OR NOT EXISTS (SELECT 1 FROM public."ProjectFactVersion" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW.id AND revision=NEW.revision)
      THEN RAISE EXCEPTION 'Invalid fact revision transition'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_fact_revision BEFORE INSERT OR UPDATE OR DELETE ON "ProjectFact" FOR EACH ROW EXECUTE FUNCTION public.guard_project_fact_revision();

CREATE FUNCTION public.guard_fact_version_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_revision integer;
BEGIN
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  SELECT revision INTO current_revision FROM public."ProjectFact" WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."factId" FOR UPDATE;
  IF current_revision IS NULL OR NEW.revision <> current_revision + 1 THEN RAISE EXCEPTION 'Invalid fact append revision'; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.advance_project_fact_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public."ProjectFact" SET revision=NEW.revision WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND id=NEW."factId";
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_version_append BEFORE INSERT ON "ProjectFactVersion" FOR EACH ROW EXECUTE FUNCTION public.guard_fact_version_append();
CREATE TRIGGER fact_version_advance AFTER INSERT ON "ProjectFactVersion" FOR EACH ROW EXECUTE FUNCTION public.advance_project_fact_revision();

CREATE FUNCTION public.guard_fact_source_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Source access identity is immutable'; END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'Initial source access revision must be one'; END IF;
  ELSE
    IF ROW(NEW."customerId",NEW."projectId",NEW."factId",NEW."sourceId") IS DISTINCT FROM ROW(OLD."customerId",OLD."projectId",OLD."factId",OLD."sourceId")
      OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Invalid source access transition'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_source_access_guard BEFORE INSERT OR UPDATE OR DELETE ON "FactSourceAccess" FOR EACH ROW EXECUTE FUNCTION public.guard_fact_source_access();
CREATE FUNCTION public.guard_fact_source_reader() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Replace source reader explicitly'; END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public."Project" WHERE "customerId"=OLD."customerId" AND id=OLD."projectId" FOR UPDATE;
    RETURN OLD;
  END IF;
  PERFORM 1 FROM public."Project" WHERE "customerId"=NEW."customerId" AND id=NEW."projectId" FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_source_reader_guard BEFORE INSERT OR UPDATE OR DELETE ON "FactSourceReader" FOR EACH ROW EXECUTE FUNCTION public.guard_fact_source_reader();

-- Every reader mutation invalidates stale access revisions, including direct
-- maintenance DML. A revision is an opaque optimistic counter, not an event count.
CREATE FUNCTION public.advance_fact_reader_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public."FactSourceAccess" SET revision=revision+1
      WHERE "customerId"=OLD."customerId" AND "projectId"=OLD."projectId" AND "factId"=OLD."factId" AND "sourceId"=OLD."sourceId";
    RETURN OLD;
  END IF;
  UPDATE public."FactSourceAccess" SET revision=revision+1
    WHERE "customerId"=NEW."customerId" AND "projectId"=NEW."projectId" AND "factId"=NEW."factId" AND "sourceId"=NEW."sourceId";
  RETURN NEW;
END;
$$;
CREATE TRIGGER fact_reader_revision AFTER INSERT OR DELETE ON "FactSourceReader" FOR EACH ROW EXECUTE FUNCTION public.advance_fact_reader_revision();
