CREATE TABLE public."BlockerAgeThresholdPolicy" (
  "customerId" uuid PRIMARY KEY REFERENCES public."Customer"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "minimumBlockerAgeDays" integer NOT NULL CHECK ("minimumBlockerAgeDays" BETWEEN 1 AND 3650),
  "auditRetentionHours" integer NOT NULL CHECK ("auditRetentionHours" BETWEEN 1 AND 87600),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  "changedBy" varchar(256) NOT NULL CHECK (length("changedBy") BETWEEN 1 AND 256),
  "changedAt" timestamptz(3) NOT NULL
);
CREATE INDEX "AuditEvent_blocker_age_threshold_expiry_idx"
  ON public."AuditEvent" ("occurredAt",id)
  WHERE event='health.blocker_age.threshold.changed';

CREATE OR REPLACE FUNCTION public.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND session_user = 'pdaa_worker'
    AND current_user <> session_user
    AND (
      (OLD.event IN ('health.assessment.created','health.assessment.redacted')
        AND OLD.detail ? 'healthAssessmentId')
      OR (
        OLD.event = 'health.assessment.retention.changed'
        AND CASE
          WHEN jsonb_typeof(OLD.detail->'auditRetentionHours') = 'number'
            AND OLD.detail->>'auditRetentionHours' ~ '^[0-9]{1,5}$'
          THEN (OLD.detail->>'auditRetentionHours')::integer BETWEEN 1 AND 87600
            AND OLD."occurredAt"
              + make_interval(hours => (OLD.detail->>'auditRetentionHours')::integer)
              <= clock_timestamp()
          ELSE false
        END
      )
      OR (
        OLD.event = 'health.blocker_age.threshold.changed'
        AND OLD.detail->>'objectType' = 'BlockerAgeThresholdPolicy'
        AND OLD.detail->>'objectId' = OLD."customerId"::text
        AND CASE
          WHEN jsonb_typeof(OLD.detail->'revision') = 'number'
            AND OLD.detail->>'revision' ~ '^[1-9][0-9]{0,9}$'
            AND jsonb_typeof(OLD.detail->'minimumBlockerAgeDays') = 'number'
            AND OLD.detail->>'minimumBlockerAgeDays' ~ '^[0-9]{1,4}$'
            AND jsonb_typeof(OLD.detail->'auditRetentionHours') = 'number'
            AND OLD.detail->>'auditRetentionHours' ~ '^[0-9]{1,5}$'
          THEN (OLD.detail->>'revision')::numeric BETWEEN 1 AND 2147483647
            AND (OLD.detail->>'minimumBlockerAgeDays')::integer BETWEEN 1 AND 3650
            AND (OLD.detail->>'auditRetentionHours')::integer BETWEEN 1 AND 87600
            AND OLD."occurredAt"
              + make_interval(hours => (OLD.detail->>'auditRetentionHours')::integer)
              <= clock_timestamp()
          ELSE false
        END
      )
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Audit records are immutable';
END $$;

CREATE FUNCTION public.purge_expired_blocker_age_threshold_audit_events()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  cutoff timestamptz := clock_timestamp();
  purged integer := 0;
BEGIN
  IF session_user <> 'pdaa_worker' THEN
    RAISE EXCEPTION 'Blocker threshold retention worker role required';
  END IF;

  WITH expired AS (
    SELECT e."customerId",e.id
    FROM public."AuditEvent" e
    WHERE e.event = 'health.blocker_age.threshold.changed'
      AND e.detail->>'objectType' = 'BlockerAgeThresholdPolicy'
      AND e.detail->>'objectId' = e."customerId"::text
      AND CASE
        WHEN jsonb_typeof(e.detail->'revision') = 'number'
          AND e.detail->>'revision' ~ '^[1-9][0-9]{0,9}$'
          AND jsonb_typeof(e.detail->'minimumBlockerAgeDays') = 'number'
          AND e.detail->>'minimumBlockerAgeDays' ~ '^[0-9]{1,4}$'
          AND jsonb_typeof(e.detail->'auditRetentionHours') = 'number'
          AND e.detail->>'auditRetentionHours' ~ '^[0-9]{1,5}$'
        THEN (e.detail->>'revision')::numeric BETWEEN 1 AND 2147483647
          AND (e.detail->>'minimumBlockerAgeDays')::integer BETWEEN 1 AND 3650
          AND (e.detail->>'auditRetentionHours')::integer BETWEEN 1 AND 87600
          AND e."occurredAt"
            + make_interval(hours => (e.detail->>'auditRetentionHours')::integer)
            <= cutoff
        ELSE false
      END
    ORDER BY e."occurredAt",e.id
    LIMIT 500
    FOR UPDATE OF e SKIP LOCKED
  )
  DELETE FROM public."AuditEvent" e USING expired x
    WHERE e."customerId"=x."customerId" AND e.id=x.id;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END $$;
REVOKE ALL ON FUNCTION public.purge_expired_blocker_age_threshold_audit_events() FROM PUBLIC;
REVOKE ALL ON TABLE public."BlockerAgeThresholdPolicy" FROM PUBLIC;

DO $blocker_threshold_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pdaa_api') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.purge_expired_blocker_age_threshold_audit_events() FROM pdaa_api';
    EXECUTE 'REVOKE ALL ON TABLE public."BlockerAgeThresholdPolicy" FROM pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT,UPDATE ON TABLE public."BlockerAgeThresholdPolicy" TO pdaa_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pdaa_worker') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.purge_expired_blocker_age_threshold_audit_events() FROM pdaa_worker';
    EXECUTE 'REVOKE ALL ON TABLE public."BlockerAgeThresholdPolicy" FROM pdaa_worker';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.purge_expired_blocker_age_threshold_audit_events() TO pdaa_worker';
  END IF;
END $blocker_threshold_acl$;
