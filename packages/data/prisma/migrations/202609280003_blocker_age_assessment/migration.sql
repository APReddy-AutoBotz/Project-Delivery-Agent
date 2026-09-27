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
