-- Keep the authority database validator aligned with the strict application schema.
-- UNTIL_SUPERSEDED is an event-date rule only for human RAID opened_at facts.
CREATE OR REPLACE FUNCTION public.valid_authority_definition(d jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE tier jsonb; selector jsonb; previous jsonb := '[]'::jsonb; v jsonb; duration numeric;
BEGIN
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d - 'tiers' - 'conflictBehavior' <> '{}'::jsonb
    OR NOT (d ?& ARRAY['tiers','conflictBehavior']) OR d->>'conflictBehavior' NOT IN ('RETAIN_CONFLICT','REQUEST_RECONCILIATION')
    OR jsonb_typeof(d->'conflictBehavior') IS DISTINCT FROM 'string'
    OR jsonb_typeof(d->'tiers') IS DISTINCT FROM 'array' OR octet_length(d::text)>262144
    THEN RETURN false; END IF;
  IF jsonb_array_length(d->'tiers') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
  FOR tier IN SELECT value FROM jsonb_array_elements(d->'tiers') LOOP
    IF jsonb_typeof(tier) IS DISTINCT FROM 'object' OR tier - 'selectors' <> '{}'::jsonb
      OR jsonb_typeof(tier->'selectors') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(tier->'selectors') NOT BETWEEN 1 AND 32 THEN RETURN false; END IF;
    FOR selector IN SELECT value FROM jsonb_array_elements(tier->'selectors') LOOP
      IF jsonb_typeof(selector) IS DISTINCT FROM 'object'
        OR NOT (selector ?& ARRAY['sourceType','instanceId','requiredApproval','validity'])
        OR selector - 'sourceType' - 'instanceId' - 'requiredApproval' - 'validity' <> '{}'::jsonb
        OR jsonb_typeof(selector->'sourceType') IS DISTINCT FROM 'string'
        OR selector->>'sourceType' !~ '^[a-z][a-z0-9_.-]{0,95}$'
        OR selector->>'requiredApproval' NOT IN ('APPROVED','NOT_REQUIRED')
        OR jsonb_typeof(selector->'requiredApproval') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF selector->'instanceId' <> 'null'::jsonb AND (jsonb_typeof(selector->'instanceId') IS DISTINCT FROM 'string'
        OR selector->>'instanceId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(previous) p WHERE p->>'sourceType'=selector->>'sourceType'
        AND (p->'instanceId'='null'::jsonb OR selector->'instanceId'='null'::jsonb OR p->'instanceId'=selector->'instanceId')) THEN RETURN false; END IF;
      previous := previous || jsonb_build_array(selector);
      v := selector->'validity';
      IF v <> 'null'::jsonb THEN
        IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
        IF v ? 'mode' THEN
          IF v - 'mode' <> '{}'::jsonb
            OR jsonb_typeof(v->'mode') IS DISTINCT FROM 'string'
            OR v->>'mode' <> 'UNTIL_SUPERSEDED' THEN RETURN false; END IF;
        ELSE
          IF NOT (v ?& ARRAY['basis','durationMs'])
            OR v - 'basis' - 'durationMs' <> '{}'::jsonb OR v->>'basis' NOT IN ('effectiveAt','observedAt')
            OR jsonb_typeof(v->'basis') IS DISTINCT FROM 'string'
            OR jsonb_typeof(v->'durationMs') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
          duration := (v->>'durationMs')::numeric;
          IF duration<1 OR duration>9007199254740991 OR trunc(duration)<>duration THEN RETURN false; END IF;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_authority_sources(c uuid,p uuid,f varchar,d jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE selector jsonb;
BEGIN
  IF d IS NULL THEN RETURN true; END IF;
  IF NOT public.valid_authority_definition(d) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(d->'tiers') t
      CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s
    WHERE (s.value->'validity') ? 'mode'
  ) AND (
    f !~ '^raid_item\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.opened_at$'
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(d->'tiers') t
        CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s
      WHERE s.value->>'sourceType' <> 'human_statement'
        OR s.value->'validity' IS DISTINCT FROM '{"mode":"UNTIL_SUPERSEDED"}'::jsonb
    )
  ) THEN RETURN false; END IF;
  FOR selector IN SELECT s.value FROM jsonb_array_elements(d->'tiers') t CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s LOOP
    IF selector->'instanceId' <> 'null'::jsonb AND (selector->>'sourceType'<>'human_statement' OR NOT EXISTS (
      SELECT 1 FROM public."FactSource" s JOIN public."ProjectFact" fct ON fct.id=s."factId"
      WHERE s.id=(selector->>'instanceId')::uuid AND s."customerId"=c AND s."projectId"=p AND fct."factType"=f
    )) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

ALTER TABLE public."HealthAssessment"
  DROP CONSTRAINT "HealthAssessment_ruleRevision_check";

ALTER TABLE public."HealthAssessment"
  ADD CONSTRAINT "HealthAssessment_ruleRevision_check"
  CHECK ("ruleRevision" IN (
    'schedule-health@1',
    'schedule-health@1+blocker-age@1'
  ));

ALTER TABLE public."HealthAssessment"
  ADD COLUMN "blockerAgeCoverage" varchar(16);

ALTER TABLE public."HealthAssessment"
  ADD CONSTRAINT "HealthAssessment_blocker_age_coverage_check"
  CHECK (
    ("ruleRevision" = 'schedule-health@1' AND "blockerAgeCoverage" IS NULL)
    OR (
      "ruleRevision" = 'schedule-health@1+blocker-age@1'
      AND "blockerAgeCoverage" IN ('COMPLETE','PARTIAL','UNASSESSABLE')
    )
  );
