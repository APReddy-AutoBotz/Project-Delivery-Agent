ALTER TABLE public."HealthAssessment"
  DROP CONSTRAINT "HealthAssessment_ruleRevision_check";
ALTER TABLE public."HealthAssessment"
  ADD CONSTRAINT "HealthAssessment_ruleRevision_check"
  CHECK ("ruleRevision" IN (
    'schedule-health@1',
    'schedule-health@1+blocker-age@1',
    'schedule-health@2+blocker-age@1'
  ));
ALTER TABLE public."HealthAssessment"
  DROP CONSTRAINT "HealthAssessment_blocker_age_coverage_check";
ALTER TABLE public."HealthAssessment"
  ADD CONSTRAINT "HealthAssessment_blocker_age_coverage_check"
  CHECK (
    ("ruleRevision" = 'schedule-health@1' AND "blockerAgeCoverage" IS NULL)
    OR (
      "ruleRevision" IN (
        'schedule-health@1+blocker-age@1',
        'schedule-health@2+blocker-age@1'
      )
      AND "blockerAgeCoverage" IN ('COMPLETE','PARTIAL','UNASSESSABLE')
    )
  );

CREATE TABLE public."ScheduleHealthPolicyRevision" (
  id uuid PRIMARY KEY,
  "customerId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  "timeZone" varchar(64) NOT NULL CHECK (length("timeZone") BETWEEN 1 AND 64),
  "defaultMinimumOverdueDays" integer NOT NULL CHECK ("defaultMinimumOverdueDays" BETWEEN 1 AND 3650),
  "targetOverrides" jsonb NOT NULL
    CHECK (CASE WHEN jsonb_typeof("targetOverrides") = 'array' THEN jsonb_array_length("targetOverrides") <= 100 ELSE false END),
  "changedBy" varchar(256) NOT NULL CHECK (length("changedBy") BETWEEN 1 AND 256),
  "changedAt" timestamptz(3) NOT NULL,
  CONSTRAINT "ScheduleHealthPolicyRevision_scope_revision"
    UNIQUE ("customerId","projectId",revision),
  CONSTRAINT "ScheduleHealthPolicyRevision_project_fk"
    FOREIGN KEY ("customerId","projectId")
    REFERENCES public."Project" ("customerId",id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "ScheduleHealthPolicyRevision_latest_idx"
  ON public."ScheduleHealthPolicyRevision" ("customerId","projectId",revision);

-- Preserve existing health behavior as explicit, reviewable UTC/one-day policy
-- revisions. New projects with no row use the same immutable domain default.
INSERT INTO public."ScheduleHealthPolicyRevision"
  (id,"customerId","projectId",revision,"timeZone","defaultMinimumOverdueDays",
   "targetOverrides","changedBy","changedAt")
SELECT gen_random_uuid(),p."customerId",p.id,1,'UTC',1,'[]'::jsonb,
       'SYSTEM_DEFAULT',date_trunc('milliseconds',clock_timestamp())
FROM public."Project" p;

REVOKE ALL ON TABLE public."ScheduleHealthPolicyRevision" FROM PUBLIC;
DO $schedule_health_policy_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pdaa_api') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."ScheduleHealthPolicyRevision" FROM pdaa_api';
    EXECUTE 'GRANT SELECT,INSERT ON TABLE public."ScheduleHealthPolicyRevision" TO pdaa_api';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pdaa_worker') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."ScheduleHealthPolicyRevision" FROM pdaa_worker';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='pdaa_backup') THEN
    EXECUTE 'REVOKE ALL ON TABLE public."ScheduleHealthPolicyRevision" FROM pdaa_backup';
    EXECUTE 'GRANT SELECT ON TABLE public."ScheduleHealthPolicyRevision" TO pdaa_backup';
  END IF;
END $schedule_health_policy_acl$;
