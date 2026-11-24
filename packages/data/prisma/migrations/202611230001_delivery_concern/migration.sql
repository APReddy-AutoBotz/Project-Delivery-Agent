ALTER TABLE public."ScheduleHealthPolicyRevision"
  ADD COLUMN "criticalTargets" jsonb,
  ADD CONSTRAINT "ScheduleHealthPolicyRevision_critical_targets_check"
  CHECK (
    "criticalTargets" IS NULL OR CASE
      WHEN jsonb_typeof("criticalTargets") = 'object'
        AND "criticalTargets" ?& ARRAY['milestoneIds','raidItemIds']
        AND jsonb_typeof("criticalTargets"->'milestoneIds') = 'array'
        AND jsonb_typeof("criticalTargets"->'raidItemIds') = 'array'
      THEN
        "criticalTargets" - ARRAY['milestoneIds','raidItemIds'] = '{}'::jsonb
        AND jsonb_array_length("criticalTargets"->'milestoneIds') <= 50
        AND jsonb_array_length("criticalTargets"->'raidItemIds') <= 50
      ELSE false END
  );

ALTER TABLE public."HealthAssessment"
  DROP CONSTRAINT "HealthAssessment_ruleRevision_check",
  DROP CONSTRAINT "HealthAssessment_blocker_age_coverage_check",
  ADD CONSTRAINT "HealthAssessment_ruleRevision_check"
  CHECK ("ruleRevision" IN (
    'schedule-health@1',
    'schedule-health@1+blocker-age@1',
    'schedule-health@2+blocker-age@1',
    'schedule-health@2+blocker-age@1+delivery-concern@1'
  )),
  ADD CONSTRAINT "HealthAssessment_blocker_age_coverage_check"
  CHECK (
    ("ruleRevision" = 'schedule-health@1' AND "blockerAgeCoverage" IS NULL)
    OR (
      "ruleRevision" IN (
        'schedule-health@1+blocker-age@1',
        'schedule-health@2+blocker-age@1',
        'schedule-health@2+blocker-age@1+delivery-concern@1'
      )
      AND "blockerAgeCoverage" IN ('COMPLETE','PARTIAL','UNASSESSABLE')
    )
  ),
  ADD CONSTRAINT "HealthAssessment_delivery_concern_requires_blocker_coverage"
  CHECK (
    "ruleRevision" <> 'schedule-health@2+blocker-age@1+delivery-concern@1'
    OR "blockerAgeCoverage" IS NOT NULL
  );
