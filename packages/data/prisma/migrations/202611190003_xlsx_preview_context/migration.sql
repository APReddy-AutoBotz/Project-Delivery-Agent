-- FR-CON-006/007: owner-only native workbook previews and comparison history.
ALTER TABLE public."IngestionOperationReceipt"
  DROP CONSTRAINT "IngestionOperationReceipt_kind_check",
  ADD CONSTRAINT "IngestionOperationReceipt_kind_check" CHECK (
    kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT','CSV_PREVIEW','CSV_REVIEWED_IMPORT','SYNC_RESET','XLSX_PREVIEW')
    AND (kind<>'CONNECTOR_PAGE' OR "outcomeCount"<=100)
    AND (kind<>'CONNECTOR_EVENT' OR "outcomeCount"=1)
    AND (kind<>'CSV_REVIEWED_IMPORT' OR "outcomeCount" BETWEEN 1 AND 1000)
    AND (kind<>'XLSX_PREVIEW' OR ("executionMode"='HUMAN' AND "syncJobId" IS NULL))
  ),
  DROP CONSTRAINT "IngestionOperationReceipt_cursor_check",
  ADD CONSTRAINT "IngestionOperationReceipt_cursor_check" CHECK (
    (kind='CONNECTOR_PAGE' AND "generationBefore" IS NOT NULL AND "generationAfter"="generationBefore" AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0)
    OR (kind='SYNC_RESET' AND "generationBefore">0 AND "generationAfter"="generationBefore"+1 AND "cursorRevisionAfter"="cursorRevisionBefore"+1 AND "cursorRevisionBefore">=0 AND "outcomeCount"=0)
    OR (kind IN ('CONNECTOR_EVENT','CSV_PREVIEW','CSV_REVIEWED_IMPORT','XLSX_PREVIEW') AND "generationBefore" IS NULL AND "generationAfter" IS NULL AND "cursorRevisionBefore" IS NULL AND "cursorRevisionAfter" IS NULL)
  );

ALTER TABLE public."IngestionXlsxHead"
  ADD COLUMN revision integer NOT NULL DEFAULT 0,
  ADD COLUMN "currentReceiptId" uuid,
  ADD COLUMN "stateSha256" char(64),
  ADD COLUMN "canonicalHistoryBytes" bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT "IngestionXlsxHead_current_shape_check" CHECK (
    (revision=0 AND "currentReceiptId" IS NULL AND "stateSha256" IS NULL AND "canonicalHistoryBytes"=0)
    OR (revision BETWEEN 1 AND 4096 AND "currentReceiptId" IS NOT NULL AND "stateSha256" IS NOT NULL
      AND "stateSha256" COLLATE "C" ~ '^[a-f0-9]{64}$' AND "canonicalHistoryBytes" BETWEEN 1 AND 268435456)
  );

CREATE TABLE public."IngestionXlsxContext" (
  "customerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "receiptId" uuid PRIMARY KEY,
  revision integer NOT NULL,
  "predecessorReceiptId" uuid,
  "predecessorRevision" integer NOT NULL,
  "predecessorSha256" char(64) NOT NULL,
  "workbookBytes" integer NOT NULL,
  "workbookSha256" char(64) NOT NULL,
  "contextSha256" char(64) NOT NULL,
  rows jsonb NOT NULL,
  "canonicalBytes" integer NOT NULL,
  "stateSha256" char(64) NOT NULL,
  CONSTRAINT "IngestionXlsxContext_receipt_fkey" FOREIGN KEY ("customerId","sourceId","receiptId")
    REFERENCES public."IngestionOperationReceipt"("customerId","sourceId",id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionXlsxContext_head_fkey" FOREIGN KEY ("customerId","sourceId")
    REFERENCES public."IngestionXlsxHead"("customerId","sourceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionXlsxContext_revision_key" UNIQUE ("customerId","sourceId",revision),
  CONSTRAINT "IngestionXlsxContext_exact_key" UNIQUE ("customerId","sourceId",revision,"receiptId","stateSha256"),
  CONSTRAINT "IngestionXlsxContext_parent_fkey" FOREIGN KEY ("customerId","sourceId","predecessorRevision","predecessorReceiptId","predecessorSha256")
    REFERENCES public."IngestionXlsxContext"("customerId","sourceId",revision,"receiptId","stateSha256") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "IngestionXlsxContext_parent_shape_check" CHECK (revision BETWEEN 1 AND 4096
    AND "predecessorRevision"=revision-1 AND ((revision=1)=("predecessorReceiptId" IS NULL))),
  CONSTRAINT "IngestionXlsxContext_bytes_check" CHECK ("workbookBytes" BETWEEN 1 AND 1048576
    AND "canonicalBytes" BETWEEN 1 AND 2097152),
  CONSTRAINT "IngestionXlsxContext_hashes_check" CHECK ("predecessorSha256" COLLATE "C" ~ '^[a-f0-9]{64}$'
    AND "workbookSha256" COLLATE "C" ~ '^[a-f0-9]{64}$' AND "contextSha256" COLLATE "C" ~ '^[a-f0-9]{64}$'
    AND "stateSha256" COLLATE "C" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "IngestionXlsxContext_rows_check" CHECK (CASE WHEN jsonb_typeof(rows)='array'
    THEN jsonb_array_length(rows)<=1000 ELSE false END)
);

ALTER TABLE public."IngestionXlsxHead" ADD CONSTRAINT "IngestionXlsxHead_current_fkey"
  FOREIGN KEY ("customerId","sourceId",revision,"currentReceiptId","stateSha256")
  REFERENCES public."IngestionXlsxContext"("customerId","sourceId",revision,"receiptId","stateSha256")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Derive the cumulative comparison rows from the actual accepted projections.
-- The callers validate predecessor shape and exact projection bindings first.
CREATE FUNCTION public.ingestion_xlsx_overlay(target uuid, dictionary jsonb, prior_rows jsonb) RETURNS jsonb
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
  WITH fields AS (
    SELECT (ordinal-1)::integer AS field_index,(entry->>0) COLLATE "C" AS fact_type
    FROM jsonb_array_elements(dictionary) WITH ORDINALITY AS d(entry,ordinal)
  ), prior AS (
    SELECT (entry->>0) COLLATE "C" AS key,(entry->>1)::uuid AS record_id,(entry->>2)::uuid AS project_id,entry->3 AS refs
    FROM jsonb_array_elements(prior_rows) AS entries(entry)
  ), observed AS (
    SELECT o."recordKey" COLLATE "C" AS key,o."recordId" AS record_id,o."projectId" AS project_id,p.id AS projection_id,p."factTypes" AS fact_types
    FROM public."IngestionRowOutcome" o JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId"
    WHERE o."receiptId"=target AND o.state='ACCEPTED'
  ), identities AS (
    SELECT key,record_id,project_id FROM prior UNION SELECT key,record_id,project_id FROM observed
  ), supplied AS (
    SELECT o.key,d.field_index,o.projection_id FROM observed o CROSS JOIN LATERAL unnest(o.fact_types) AS ft(value)
    JOIN fields d ON d.fact_type=ft.value COLLATE "C"
  ), carried AS (
    SELECT p.key,(ref->>0)::integer AS field_index,(ref->>1)::uuid AS projection_id
    FROM prior p CROSS JOIN LATERAL jsonb_array_elements(p.refs) AS refs(ref)
    WHERE NOT EXISTS (SELECT 1 FROM supplied s WHERE s.key=p.key AND s.field_index=(ref->>0)::integer)
  ), refs AS (
    SELECT * FROM supplied UNION ALL SELECT * FROM carried
  ), grouped_refs AS (
    SELECT key,jsonb_agg(jsonb_build_array(field_index::text,projection_id::text) ORDER BY field_index) AS refs
    FROM refs GROUP BY key
  )
  SELECT coalesce(jsonb_agg(jsonb_build_array(i.key,i.record_id::text,i.project_id::text,coalesce(g.refs,'[]'::jsonb))
    ORDER BY i.key),'[]'::jsonb) FROM identities i LEFT JOIN grouped_refs g ON g.key=i.key;
$$;

-- Historical validation uses exact scalar digests and immutable references.
-- Content may be lawfully redacted after a preview is finalized.
CREATE FUNCTION public.valid_ingestion_xlsx_context(target uuid) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $$
DECLARE
    c public."IngestionXlsxContext"%ROWTYPE;
    h public."IngestionXlsxHead"%ROWTYPE;
    r public."IngestionOperationReceipt"%ROWTYPE;
    parent public."IngestionXlsxContext"%ROWTYPE;
    mapping_value jsonb;
    prior_config integer;
    prior_rows jsonb := '[]'::jsonb;
    baseline jsonb := '{"kind":"GENESIS"}'::jsonb;
    request_doc jsonb;
    projects jsonb;
    outcomes jsonb;
    encoded text;
BEGIN
    SELECT * INTO c FROM public."IngestionXlsxContext" WHERE "receiptId"=target;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO h FROM public."IngestionXlsxHead" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId";
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND id=target;
    IF NOT FOUND OR r.kind<>'XLSX_PREVIEW' OR r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
        OR r."mappingRevision"<>h."mappingRevision" OR public.valid_ingestion_receipt(target) IS NOT TRUE
    THEN RETURN false; END IF;
    SELECT activation.mapping INTO mapping_value FROM public."IngestionConfigurationRevision" activation
    JOIN public."IngestionConfigurationRevision" receipt_config ON receipt_config."customerId"=activation."customerId"
      AND receipt_config."sourceId"=activation."sourceId" AND receipt_config.revision=r."configRevision"
      AND receipt_config."mappingRevision"=activation."mappingRevision" AND receipt_config.sealed
      AND receipt_config.mapping=activation.mapping
    WHERE activation."customerId"=c."customerId" AND activation."sourceId"=c."sourceId"
      AND activation.revision=h."activationConfigRevision" AND activation."mappingRevision"=h."mappingRevision" AND activation.sealed;
    IF NOT FOUND OR mapping_value->>'kind' IS DISTINCT FROM 'XLSX' THEN RETURN false; END IF;
    prior_config := h."activationConfigRevision";
    IF c.revision=1 THEN
        IF c."predecessorSha256" IS DISTINCT FROM h."genesisSha256" THEN RETURN false; END IF;
    ELSE
        SELECT * INTO parent FROM public."IngestionXlsxContext" WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId"
          AND revision=c."predecessorRevision" AND "receiptId"=c."predecessorReceiptId" AND "stateSha256"=c."predecessorSha256";
        IF NOT FOUND THEN RETURN false; END IF;
        SELECT "configRevision" INTO prior_config FROM public."IngestionOperationReceipt"
          WHERE "customerId"=c."customerId" AND "sourceId"=c."sourceId" AND id=parent."receiptId" AND kind='XLSX_PREVIEW';
        IF NOT FOUND THEN RETURN false; END IF;
        prior_rows := parent.rows;
        baseline := jsonb_build_object('kind','RETAINED','receiptId',parent."receiptId",'revision',parent.revision,'stateSha256',parent."stateSha256"::text);
    END IF;
    encoded := public.ingestion_xlsx_v1_state_text(c."customerId",c."sourceId",h."mappingRevision",
        mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,c.rows);
    IF encoded IS NULL OR octet_length(encoded)<>c."canonicalBytes"
        OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>c."stateSha256"::text THEN RETURN false; END IF;
    IF c.revision>1 THEN
        IF prior_rows IS DISTINCT FROM c.rows THEN
            encoded := public.ingestion_xlsx_v1_state_text(c."customerId",c."sourceId",h."mappingRevision",
                mapping_value->'sheet',mapping_value->'parserContract',h.dictionary,prior_rows);
        END IF;
        IF encoded IS NULL OR octet_length(encoded)<>parent."canonicalBytes"
            OR encode(sha256(convert_to(encoded,'UTF8')),'hex')<>parent."stateSha256"::text THEN RETURN false; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionConfigurationProject" old_scope
      WHERE old_scope."customerId"=c."customerId" AND old_scope."sourceId"=c."sourceId" AND old_scope."configRevision"=prior_config
        AND NOT EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" captured WHERE captured."receiptId"=target
          AND captured."customerId"=old_scope."customerId" AND captured."sourceId"=old_scope."sourceId"
          AND captured."projectId"=old_scope."projectId")) THEN RETURN false; END IF;
    -- The immutable reader and exact project grant scope survive revocation.
    -- Restore must not consult today's AccessGrant or project portfolio.
    IF EXISTS (SELECT 1 FROM public."IngestionReceiptProjectScope" captured WHERE captured."receiptId"=target
      AND (ROW(captured."customerId",captured."sourceId") IS DISTINCT FROM ROW(c."customerId",c."sourceId")
        OR (captured."grantScopeType"='project' AND captured."grantScopeId"<>captured."projectId")
        OR NOT EXISTS (SELECT 1 FROM public."IngestionConfigurationReader" reader
          WHERE reader."customerId"=c."customerId" AND reader."sourceId"=c."sourceId" AND reader."configRevision"=r."configRevision"
            AND reader."projectId"=captured."projectId" AND reader.subject=r.subject))) THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(c.rows) AS identities(identity)
      WHERE NOT EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e
        JOIN public."IngestionReceiptProjectScope" scope ON scope."receiptId"=target AND scope."customerId"=e."customerId"
          AND scope."sourceId"=e."sourceId" AND scope."projectId"=e."projectId"
        WHERE e."customerId"=c."customerId" AND e."sourceId"=c."sourceId" AND e.id=(identity->>1)::uuid
          AND e."projectId"=(identity->>2)::uuid AND e."recordKey" COLLATE "C"=(identity->>0) COLLATE "C"
          AND e."recordType" COLLATE "C"=('xlsx:'||(mapping_value->>'sheet')) COLLATE "C")) THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1 FROM public."IngestionRowOutcome" o LEFT JOIN public."IngestionProposalProjection" p
        ON p.id=o."projectionId" AND p."customerId"=c."customerId" AND p."sourceId"=c."sourceId"
          AND p."recordId"=o."recordId" AND p."sourceRevisionId"=o."sourceRevisionId" AND p."mappingRevision"=r."mappingRevision"
      LEFT JOIN public."IngestionExternalRecord" e ON e.id=o."recordId" AND e."customerId"=c."customerId" AND e."sourceId"=c."sourceId"
      WHERE o."receiptId"=target AND o.state='ACCEPTED' AND (
        p.id IS NULL OR (e."recordType" COLLATE "C"=('xlsx:'||(mapping_value->>'sheet')) COLLATE "C") IS NOT TRUE
        OR EXISTS (SELECT 1 FROM unnest(p."factTypes") AS fact(value) WHERE NOT EXISTS
          (SELECT 1 FROM jsonb_array_elements(h.dictionary) AS field(entry) WHERE entry->>0=fact.value))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(mapping_value->'fields') AS field(entry)
          WHERE entry->>'required'='true' AND NOT ((entry->>'factType')=ANY(p."factTypes")))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) AS prior(entry) WHERE entry->>0=o."recordKey"
          AND ROW((entry->>1)::uuid,(entry->>2)::uuid) IS DISTINCT FROM ROW(o."recordId",o."projectId"))
        OR CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) AS prior(entry) WHERE entry->>0=o."recordKey")
          THEN CASE WHEN cardinality(p."factTypes")=0 THEN o.operation<>'UNCHANGED' ELSE o.operation NOT IN ('UPDATE','UNCHANGED') END
          ELSE CASE WHEN cardinality(p."factTypes")=0 THEN o.operation<>'NONE' ELSE o.operation<>'CREATE' END END
      )
    ) THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=target AND "recordKey" IS NOT NULL
      GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1 AND bool_or(state='ACCEPTED')) THEN RETURN false; END IF;
    IF c.rows IS DISTINCT FROM public.ingestion_xlsx_overlay(target,h.dictionary,prior_rows) THEN RETURN false; END IF;

    request_doc := jsonb_build_object('customerId',r."customerId",'sourceId',r."sourceId",'subject',r.subject,
        'commandKey',r."commandKey",'configRevision',r."configRevision",'mappingRevision',r."mappingRevision",
        'sheet',mapping_value->'sheet','parserContract',mapping_value->'parserContract',
        'workbookBytes',c."workbookBytes",'workbookSha256',c."workbookSha256"::text);
    IF public.ingestion_xlsx_v1_request_hash(request_doc) IS DISTINCT FROM r."requestHash"::text THEN RETURN false; END IF;
    SELECT coalesce(jsonb_agg("projectId" ORDER BY "projectId"),'[]'::jsonb) INTO projects
      FROM public."IngestionReceiptProjectScope" WHERE "receiptId"=target AND "customerId"=c."customerId" AND "sourceId"=c."sourceId";
    SELECT coalesce(jsonb_agg(jsonb_build_object('ordinal',o.ordinal,'state',o.state,'operation',o.operation,
        'errorCodes',o."errorCodes",'projectId',o."projectId",'keySha256',o."recordKey",
        'record',CASE WHEN o.state='ACCEPTED' THEN jsonb_build_object('id',o."recordId",'revisionId',v.id,
          'sourceContentSha256',v."sourceContentHash"::text,'projectionId',p.id,'proposalSha256',p."proposalHash"::text) END)
        ORDER BY o.ordinal),'[]'::jsonb) INTO outcomes
    FROM public."IngestionRowOutcome" o
    LEFT JOIN public."IngestionSourceRevision" v ON v.id=o."sourceRevisionId" AND v."customerId"=o."customerId"
      AND v."sourceId"=o."sourceId" AND v."recordId"=o."recordId"
    LEFT JOIN public."IngestionProposalProjection" p ON p.id=o."projectionId" AND p."customerId"=o."customerId"
      AND p."sourceId"=o."sourceId" AND p."recordId"=o."recordId" AND p."sourceRevisionId"=v.id
    WHERE o."receiptId"=target AND o."customerId"=c."customerId" AND o."sourceId"=c."sourceId";
    RETURN public.ingestion_xlsx_v1_context_hash(jsonb_build_object('request',request_doc,'previewReceiptId',target,
      'baseline',baseline,'projectIds',projects,'outcomes',outcomes)) IS NOT DISTINCT FROM c."contextSha256"::text;
END $$;

CREATE FUNCTION public.guard_ingestion_xlsx_head_advance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE next_context public."IngestionXlsxContext"%ROWTYPE;
BEGIN
    IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Workbook comparison head is retained'; END IF;
    IF (to_jsonb(OLD)-ARRAY['revision','currentReceiptId','stateSha256','canonicalHistoryBytes'])
        IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['revision','currentReceiptId','stateSha256','canonicalHistoryBytes'])
        OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid workbook head advance'; END IF;
    SELECT * INTO next_context FROM public."IngestionXlsxContext" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId"
        AND revision=NEW.revision AND "receiptId"=NEW."currentReceiptId" AND "stateSha256"=NEW."stateSha256";
    IF NOT FOUND OR next_context."predecessorRevision"<>OLD.revision
        OR next_context."predecessorReceiptId" IS DISTINCT FROM OLD."currentReceiptId"
        OR next_context."predecessorSha256" IS DISTINCT FROM coalesce(OLD."stateSha256",OLD."genesisSha256")
        OR NEW."canonicalHistoryBytes" IS DISTINCT FROM OLD."canonicalHistoryBytes"+next_context."canonicalBytes"
    THEN RAISE EXCEPTION 'Invalid workbook head advance'; END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.append_ingestion_xlsx_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE
    h public."IngestionXlsxHead"%ROWTYPE;
    s public."IngestionSource"%ROWTYPE;
    r public."IngestionOperationReceipt"%ROWTYPE;
    policy_hours integer;
    prior_rows jsonb := '[]'::jsonb;
    projection_ids uuid[];
    actual_count integer;
    content_bytes bigint;
    available boolean;
    uncertain_identity boolean;
    prior_identity jsonb;
    observed record;
    expected_operation text;
BEGIN
    SELECT * INTO r FROM public."IngestionOperationReceipt" WHERE id=NEW."receiptId" AND "customerId"=NEW."customerId"
        AND "sourceId"=NEW."sourceId" AND kind='XLSX_PREVIEW';
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook context requires a native receipt'; END IF;
    -- The existing receipt scope guard acquires the project, reader and grant
    -- fences. A missing predecessor scope fails the historical proof below.
    SELECT "retentionHours" INTO policy_hours FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    SELECT * INTO s FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR s."inputFamily"<>'XLSX' OR ROW(s."currentConfigRevision",s."mappingRevision")
        IS DISTINCT FROM ROW(r."configRevision",r."mappingRevision") THEN RAISE EXCEPTION 'Workbook source configuration changed'; END IF;
    SELECT * INTO h FROM public."IngestionXlsxHead" WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR NEW."predecessorRevision"<>h.revision OR NEW."predecessorReceiptId" IS DISTINCT FROM h."currentReceiptId"
        OR NEW."predecessorSha256" IS DISTINCT FROM coalesce(h."stateSha256",h."genesisSha256")
        OR h."canonicalHistoryBytes"+NEW."canonicalBytes">268435456
    THEN RAISE EXCEPTION 'Workbook comparison predecessor or capacity changed'; END IF;
    IF public.valid_ingestion_xlsx_context(NEW."receiptId") IS NOT TRUE THEN RAISE EXCEPTION 'Invalid workbook preview context'; END IF;
    IF h.revision>0 THEN
        SELECT rows INTO prior_rows FROM public."IngestionXlsxContext" WHERE "customerId"=h."customerId" AND "sourceId"=h."sourceId"
            AND "receiptId"=h."currentReceiptId" AND revision=h.revision AND "stateSha256"=h."stateSha256";
        IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison predecessor is unavailable'; END IF;
    END IF;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO projection_ids FROM (
        SELECT (ref->>1)::uuid AS id FROM jsonb_array_elements(prior_rows) AS identities(entry)
          CROSS JOIN LATERAL jsonb_array_elements(entry->3) AS refs(ref)
        UNION SELECT "projectionId" FROM public."IngestionRowOutcome" WHERE "receiptId"=NEW."receiptId" AND state='ACCEPTED'
    ) required;
    IF cardinality(projection_ids)>33000 THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    PERFORM content."projectionId" FROM public."IngestionProposalContent" content
      WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids)
      ORDER BY content."projectionId" FOR SHARE;
    SELECT count(*)::integer,coalesce(sum(octet_length(content.proposals::text)),0),
      coalesce(bool_and(content.proposals IS NOT NULL AND content."redactedAt" IS NULL
        AND revision."receivedAt"+make_interval(hours=>policy_hours)>clock_timestamp()),true)
      INTO actual_count,content_bytes,available
    FROM public."IngestionProposalContent" content
    JOIN public."IngestionProposalProjection" p ON p.id=content."projectionId" AND p."customerId"=content."customerId"
      AND p."sourceId"=content."sourceId" AND p."recordId"=content."recordId" AND p."mappingRevision"=r."mappingRevision"
    JOIN public."IngestionSourceRevision" revision ON revision.id=p."sourceRevisionId" AND revision."customerId"=p."customerId"
      AND revision."sourceId"=p."sourceId" AND revision."recordId"=p."recordId"
    WHERE content."customerId"=NEW."customerId" AND content."sourceId"=NEW."sourceId" AND content."projectionId"=ANY(projection_ids);
    IF actual_count<>cardinality(projection_ids) OR available IS NOT TRUE OR content_bytes>4194304
    THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionProposalContent" content WHERE content."projectionId"=ANY(projection_ids)
      AND (public.valid_ingestion_projection_content(content."projectionId",content.proposals) IS NOT TRUE
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(content.proposals) AS proposals(item) WHERE NOT EXISTS
          (SELECT 1 FROM jsonb_array_elements(h.dictionary) AS fields(entry)
            WHERE entry->>0=item->>'factType' AND entry->>1=item->'value'->>'type')
          OR CASE item->'value'->>'type'
            WHEN 'number' THEN abs((item->'value'->>'value')::numeric)>9007199254740991
            WHEN 'text' THEN (item->'value'->>'value'='' OR left(ltrim(item->'value'->>'value',
              U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),1) IN ('=','+','-','@'))
            ELSE false END)))
    THEN RAISE EXCEPTION 'Workbook comparison projection is invalid'; END IF;
    SELECT EXISTS (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=NEW."receiptId"
        AND (o."recordKey" IS NULL OR o."errorCodes" && ARRAY['INVALID_KEY','DUPLICATE_KEY','INVALID_PROJECT','PROJECT_CHANGED','ROW_IDENTITY_REVIEW']::text[]))
      OR EXISTS (SELECT 1 FROM public."IngestionRowOutcome" WHERE "receiptId"=NEW."receiptId" AND "recordKey" IS NOT NULL
        GROUP BY "recordKey" COLLATE "C" HAVING count(*)>1)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(prior_rows) AS identities(entry) WHERE NOT EXISTS
        (SELECT 1 FROM public."IngestionRowOutcome" o WHERE o."receiptId"=NEW."receiptId" AND o."recordKey" COLLATE "C"=(entry->>0) COLLATE "C"))
      INTO uncertain_identity;
    FOR observed IN SELECT o."recordKey",o."recordId",o.operation,content.proposals FROM public."IngestionRowOutcome" o
      JOIN public."IngestionProposalContent" content ON content."projectionId"=o."projectionId"
        AND content."customerId"=o."customerId" AND content."sourceId"=o."sourceId" AND content."recordId"=o."recordId"
      WHERE o."receiptId"=NEW."receiptId" AND o.state='ACCEPTED' ORDER BY o.ordinal
    LOOP
        SELECT entry INTO prior_identity FROM jsonb_array_elements(prior_rows) AS identities(entry)
          WHERE (entry->>0) COLLATE "C"=observed."recordKey" COLLATE "C";
        IF prior_identity IS NULL AND uncertain_identity THEN RAISE EXCEPTION 'Workbook comparison identity requires review'; END IF;
        IF jsonb_array_length(observed.proposals)=0 THEN
            expected_operation := CASE WHEN prior_identity IS NULL THEN 'NONE' ELSE 'UNCHANGED' END;
        ELSIF prior_identity IS NULL THEN expected_operation := 'CREATE';
        ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(observed.proposals) AS supplied(item) WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(prior_identity->3) AS field_refs(ref)
          JOIN public."IngestionProposalContent" previous ON previous."projectionId"=(ref->>1)::uuid
            AND previous."customerId"=NEW."customerId" AND previous."sourceId"=NEW."sourceId" AND previous."recordId"=observed."recordId"
          CROSS JOIN LATERAL jsonb_array_elements(previous.proposals) AS prior_values(prior_item)
          WHERE h.dictionary->((ref->>0)::integer)->>0=supplied.item->>'factType'
            AND prior_item->>'factType'=supplied.item->>'factType' AND prior_item->'value'=supplied.item->'value'
        )) THEN expected_operation := 'UPDATE';
        ELSE expected_operation := 'UNCHANGED'; END IF;
        IF observed.operation IS DISTINCT FROM expected_operation THEN RAISE EXCEPTION 'Workbook comparison operation is invalid'; END IF;
    END LOOP;
    UPDATE public."IngestionXlsxHead" SET revision=NEW.revision,"currentReceiptId"=NEW."receiptId",
      "stateSha256"=NEW."stateSha256","canonicalHistoryBytes"=h."canonicalHistoryBytes"+NEW."canonicalBytes"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND revision=h.revision;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison predecessor changed'; END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION public.guard_ingestion_xlsx_graph_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" AND "inputFamily"='XLSX')
       AND current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    THEN RAISE EXCEPTION 'Workbook ingestion owner required'; END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION public.valid_ingestion_xlsx_head(customer uuid, source uuid) RETURNS boolean
LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog AS $$
DECLARE h public."IngestionXlsxHead"%ROWTYPE; history_count integer; latest integer; history_bytes bigint;
BEGIN
    SELECT * INTO h FROM public."IngestionXlsxHead" WHERE "customerId"=customer AND "sourceId"=source;
    IF NOT FOUND OR public.valid_ingestion_xlsx_genesis(customer,source) IS NOT TRUE THEN RETURN false; END IF;
    SELECT count(*)::integer,coalesce(max(revision),0),coalesce(sum("canonicalBytes"),0)
      INTO history_count,latest,history_bytes FROM public."IngestionXlsxContext" WHERE "customerId"=customer AND "sourceId"=source;
    RETURN ROW(history_count,latest,history_bytes) IS NOT DISTINCT FROM ROW(h.revision,h.revision,h."canonicalHistoryBytes")
      AND (h.revision=0 OR EXISTS (SELECT 1 FROM public."IngestionXlsxContext" WHERE "customerId"=customer AND "sourceId"=source
        AND revision=h.revision AND "receiptId"=h."currentReceiptId" AND "stateSha256"=h."stateSha256"));
END $$;

DROP TRIGGER ingestion_xlsx_head_immutable ON public."IngestionXlsxHead";
CREATE TRIGGER ingestion_xlsx_head_advance BEFORE UPDATE OR DELETE ON public."IngestionXlsxHead"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_head_advance();
CREATE TRIGGER ingestion_xlsx_context_immutable BEFORE UPDATE OR DELETE ON public."IngestionXlsxContext"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_xlsx_context_no_truncate BEFORE TRUNCATE ON public."IngestionXlsxContext"
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_ingestion_immutable();
CREATE TRIGGER ingestion_xlsx_context_append AFTER INSERT ON public."IngestionXlsxContext"
  FOR EACH ROW EXECUTE FUNCTION public.append_ingestion_xlsx_context();
CREATE TRIGGER ingestion_xlsx_record_owner BEFORE INSERT ON public."IngestionExternalRecord"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_graph_owner();
CREATE TRIGGER ingestion_xlsx_revision_owner BEFORE INSERT ON public."IngestionSourceRevision"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_graph_owner();
CREATE TRIGGER ingestion_xlsx_stream_owner BEFORE INSERT ON public."IngestionFactStream"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_graph_owner();
CREATE TRIGGER ingestion_xlsx_projection_owner BEFORE INSERT ON public."IngestionProposalProjection"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_graph_owner();
CREATE TRIGGER ingestion_xlsx_content_owner BEFORE INSERT ON public."IngestionProposalContent"
  FOR EACH ROW EXECUTE FUNCTION public.guard_ingestion_xlsx_graph_owner();

-- Existing dispatch and graph guards retain their OIDs. Released kinds keep their checks.
CREATE OR REPLACE FUNCTION public.guard_ingestion_record() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'External record identity is immutable'; END IF;
  SELECT c.* INTO cfg FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c
    ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision"
    WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId" AND c.sealed AND c."mappingRevision"=s."mappingRevision";
  IF NOT FOUND THEN RAISE EXCEPTION 'External record requires a current sealed configuration'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."IngestionSource" s JOIN public."IngestionConfigurationProject" p ON p."customerId"=s."customerId" AND p."sourceId"=s.id AND p."configRevision"=s."currentConfigRevision" AND p."projectId"=NEW."projectId"
    WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId") THEN RAISE EXCEPTION 'External record outside configured scope'; END IF;
  IF cfg.mapping->>'kind'='CSV' AND (NEW."recordType"<>'spreadsheet:'||(cfg.mapping->>'sheet') OR NEW."recordKey" !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'Spreadsheet identity must use the configured sheet and a hashed row key';
  ELSIF cfg.mapping->>'kind'='XLSX' AND (NEW."recordType" COLLATE "C"<>('xlsx:'||(cfg.mapping->>'sheet')) COLLATE "C"
      OR NEW."recordKey" COLLATE "C" !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'Workbook identity must use the configured sheet and a hashed row key';
  ELSIF cfg.mapping->>'kind' NOT IN ('CSV','CONNECTOR','XLSX') THEN
    RAISE EXCEPTION 'External record requires a supported source mapping';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_ingestion_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg public."IngestionConfigurationRevision"%ROWTYPE; policy public."IngestionRetentionPolicy"%ROWTYPE; mapping_types text[];
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion proposal projection is immutable'; END IF;
  SELECT c.* INTO cfg FROM public."IngestionSource" s JOIN public."IngestionConfigurationRevision" c ON c."customerId"=s."customerId" AND c."sourceId"=s.id AND c.revision=s."currentConfigRevision"
    WHERE s."customerId"=NEW."customerId" AND s.id=NEW."sourceId";
  IF NOT FOUND OR NEW."mappingRevision"<>cfg."mappingRevision" THEN RAISE EXCEPTION 'Ingestion projection uses stale mapping'; END IF;
  IF cfg.mapping->>'kind'='CONNECTOR' THEN
    SELECT COALESCE(array_agg(value ORDER BY value),'{}'::text[]) INTO mapping_types FROM jsonb_array_elements_text(cfg.mapping->'factTypes');
  ELSIF cfg.mapping->>'kind' IN ('CSV','XLSX') THEN
    SELECT COALESCE(array_agg(value->>'factType' ORDER BY value->>'factType'),'{}'::text[]) INTO mapping_types FROM jsonb_array_elements(cfg.mapping->'fields') AS field(value);
  ELSE
    RAISE EXCEPTION 'Invalid ingestion mapping kind';
  END IF;
  IF cardinality(NEW."factTypes")>32 OR NEW."factTypes" IS DISTINCT FROM ARRAY(SELECT DISTINCT facts.value FROM unnest(NEW."factTypes") AS facts(value) ORDER BY facts.value)
    OR EXISTS (SELECT 1 FROM unnest(NEW."factTypes") AS facts(value) WHERE facts.value !~ '^[a-z][a-z0-9_.-]{0,95}$' OR NOT facts.value=ANY(mapping_types)) THEN RAISE EXCEPTION 'Ingestion projection fact types are invalid'; END IF;
  SELECT * INTO policy FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingestion content retention is not configured'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."factTypes") AS facts(value) WHERE NOT EXISTS (SELECT 1 FROM public."IngestionFactStream" s WHERE s."customerId"=NEW."customerId" AND s."sourceId"=NEW."sourceId" AND s."recordId"=NEW."recordId" AND s."factType"=facts.value)) THEN RAISE EXCEPTION 'Projection is missing its stable fact stream'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_ingestion_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source_row public."IngestionSource"%ROWTYPE; mapping_value jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Ingestion operation receipt is immutable'; END IF;
  IF NEW.kind='XLSX_PREVIEW' THEN
    IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN
      RAISE EXCEPTION 'Workbook ingestion owner required';
    END IF;
    -- Take the project and grant fences before the source/head write locks.
    -- Acquiring only a source SHARE lock here creates an upgrade deadlock at append.
    PERFORM p.id FROM public."IngestionConfigurationProject" scope
      JOIN public."Project" p ON p."customerId"=scope."customerId" AND p.id=scope."projectId"
      WHERE scope."customerId"=NEW."customerId" AND scope."sourceId"=NEW."sourceId"
        AND scope."configRevision"=NEW."configRevision" ORDER BY p.id FOR UPDATE OF p;
    PERFORM g.id FROM public."AccessGrant" g WHERE g."customerId"=NEW."customerId" AND g.subject=NEW.subject
      AND g.role IN ('project_manager','portfolio_manager','pmo_admin') AND EXISTS (
        SELECT 1 FROM public."IngestionConfigurationProject" scope
        JOIN public."Project" p ON p."customerId"=scope."customerId" AND p.id=scope."projectId"
        WHERE scope."customerId"=NEW."customerId" AND scope."sourceId"=NEW."sourceId"
          AND scope."configRevision"=NEW."configRevision" AND ((g."scopeType"='project' AND g."scopeId"=p.id)
            OR (g."scopeType"='portfolio' AND g."scopeId"=p."portfolioId"))) ORDER BY g.id FOR SHARE OF g;
    PERFORM "customerId" FROM public."IngestionRetentionPolicy" WHERE "customerId"=NEW."customerId" FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workbook comparison content is unavailable'; END IF;
    SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR UPDATE;
    IF NOT FOUND OR source_row."inputFamily" IS DISTINCT FROM 'XLSX' THEN
      RAISE EXCEPTION 'Workbook preview requires a workbook source';
    END IF;
    PERFORM "sourceId" FROM public."IngestionXlsxHead"
      WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" FOR UPDATE;
  ELSE
    SELECT * INTO source_row FROM public."IngestionSource" WHERE "customerId"=NEW."customerId" AND id=NEW."sourceId" FOR SHARE;
  END IF;
  IF source_row.id IS NULL OR ROW(source_row."currentConfigRevision",source_row."mappingRevision")
    IS DISTINCT FROM ROW(NEW."configRevision",NEW."mappingRevision") THEN RAISE EXCEPTION 'Ingestion receipt uses stale configuration'; END IF;
  SELECT mapping INTO mapping_value FROM public."IngestionConfigurationRevision"
    WHERE "customerId"=NEW."customerId" AND "sourceId"=NEW."sourceId" AND revision=NEW."configRevision" AND "mappingRevision"=NEW."mappingRevision" AND sealed;
  IF mapping_value IS NULL OR (NEW.kind IN ('CONNECTOR_PAGE','CONNECTOR_EVENT') AND mapping_value->>'kind' IS DISTINCT FROM 'CONNECTOR')
    OR (NEW.kind IN ('CSV_PREVIEW','CSV_REVIEWED_IMPORT') AND mapping_value->>'kind' IS DISTINCT FROM 'CSV')
    OR (NEW.kind='XLSX_PREVIEW' AND mapping_value->>'kind' IS DISTINCT FROM 'XLSX') THEN
    RAISE EXCEPTION 'Ingestion receipt mapping family is invalid';
  END IF;
  RETURN NEW;
END $$;

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
  expected_event:=CASE r.kind WHEN 'CONNECTOR_PAGE' THEN 'ingestion.connector_page.persisted' WHEN 'CONNECTOR_EVENT' THEN 'ingestion.connector_event.persisted' WHEN 'CSV_PREVIEW' THEN 'ingestion.csv_preview.persisted' WHEN 'XLSX_PREVIEW' THEN 'ingestion.xlsx_preview.persisted' WHEN 'CSV_REVIEWED_IMPORT' THEN 'ingestion.csv_reviewed_import.persisted' WHEN 'SYNC_RESET' THEN 'ingestion.sync_reset' END;
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
  IF r.kind='XLSX_PREVIEW' AND (r."executionMode"<>'HUMAN' OR r."syncJobId" IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM public."IngestionSource" s WHERE s."customerId"=r."customerId" AND s.id=r."sourceId" AND s."inputFamily"='XLSX')) THEN RETURN false; END IF;
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

CREATE OR REPLACE FUNCTION public.require_ingestion_receipt_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  target uuid;
  receipt public."IngestionOperationReceipt"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='IngestionOperationReceipt' THEN
    target:=NEW.id;
    IF NEW.kind='XLSX_PREVIEW' AND NOT EXISTS (
      SELECT 1 FROM public."IngestionXlsxContext" c JOIN public."IngestionXlsxHead" h
        ON h."customerId"=c."customerId" AND h."sourceId"=c."sourceId" AND h.revision>=c.revision
      WHERE c."customerId"=NEW."customerId" AND c."sourceId"=NEW."sourceId" AND c."receiptId"=target
    ) THEN RAISE EXCEPTION 'Incomplete workbook preview cannot commit'; END IF;
  ELSE
    target:=NEW."receiptId";
    SELECT * INTO receipt FROM public."IngestionOperationReceipt" WHERE id=target;
    IF FOUND AND TG_TABLE_NAME='IngestionRowOutcome' AND receipt.kind IN ('CSV_PREVIEW','XLSX_PREVIEW')
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

CREATE OR REPLACE FUNCTION public.guard_ingestion_xlsx_legacy_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
    IF TG_TABLE_NAME='IngestionOperationReceipt' THEN
        -- The receipt guard verifies owner, sealed mapping and exact source kind.
        IF NEW.kind='XLSX_PREVIEW' THEN RETURN NEW; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM public."IngestionSource" WHERE "customerId"=NEW."customerId"
        AND id=NEW."sourceId" AND "inputFamily"='XLSX') THEN
        RAISE EXCEPTION 'Legacy ingestion is unavailable for workbook sources';
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.valid_ingestion_xlsx_genesis(customer uuid, source uuid) RETURNS boolean
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
        OR EXISTS (SELECT 1 FROM public."IngestionExternalRecord" e WHERE e."customerId"=customer AND e."sourceId"=source
          AND e."recordType" COLLATE "C"<>('xlsx:'||(mapping_value->>'sheet')) COLLATE "C")
        OR EXISTS (SELECT 1 FROM public."IngestionOperationReceipt" r WHERE r."customerId"=customer AND r."sourceId"=source AND r.kind<>'XLSX_PREVIEW')
        OR EXISTS (SELECT 1 FROM public."IngestionConfigurationRevision" c WHERE c."customerId"=customer AND c."sourceId"=source
          AND c.sealed AND (c."mappingRevision"<>h."mappingRevision" OR c.mapping IS DISTINCT FROM mapping_value))
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

DO $xlsx_context_acl$
DECLARE recipients text;
BEGIN
    SELECT concat_ws(',', 'PUBLIC', string_agg(quote_ident(rolname), ',')) INTO recipients
      FROM pg_catalog.pg_roles WHERE rolname IN ('pdaa_api','pdaa_worker','pdaa_backup');
    EXECUTE 'REVOKE ALL ON FUNCTION public.ingestion_xlsx_overlay(uuid,jsonb,jsonb),
      public.valid_ingestion_xlsx_context(uuid), public.guard_ingestion_xlsx_head_advance(),public.append_ingestion_xlsx_context(),
      public.guard_ingestion_xlsx_graph_owner(),public.valid_ingestion_xlsx_head(uuid,uuid) FROM ' || recipients;
    EXECUTE 'REVOKE ALL ON TABLE public."IngestionXlsxContext" FROM ' || recipients;
END $xlsx_context_acl$;
