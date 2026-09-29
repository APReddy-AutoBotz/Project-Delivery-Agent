-- EXEC-014: additive cadence settings with safe no-notification defaults.
CREATE OR REPLACE FUNCTION public.valid_project_update_cadence_offsets(schedule_days smallint[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE day_offset smallint; previous_offset smallint := 0;
BEGIN
  IF schedule_days IS NULL OR cardinality(schedule_days) > 8 THEN RETURN false; END IF;
  IF cardinality(schedule_days) > 0 AND (
    array_ndims(schedule_days) <> 1 OR array_lower(schedule_days,1) <> 1
  ) THEN
    RETURN false;
  END IF;
  FOREACH day_offset IN ARRAY schedule_days LOOP
    IF day_offset IS NULL OR day_offset NOT BETWEEN 1 AND 90 OR day_offset <= previous_offset THEN
      RETURN false;
    END IF;
    previous_offset := day_offset;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE public."ProjectUpdatePolicyRevision"
  ADD COLUMN "reminderBusinessDayOffsets" smallint[] NOT NULL DEFAULT ARRAY[]::smallint[],
  ADD COLUMN "escalationAfterBusinessDays" smallint NOT NULL DEFAULT 0,
  ADD COLUMN "escalationRecipientSubject" varchar(256),
  ADD COLUMN "quietHoursStartLocal" varchar(5),
  ADD COLUMN "quietHoursEndLocal" varchar(5),
  ADD CONSTRAINT "ProjectUpdatePolicyRevision_reminder_offsets_check"
    CHECK (public.valid_project_update_cadence_offsets("reminderBusinessDayOffsets")),
  ADD CONSTRAINT "ProjectUpdatePolicyRevision_escalation_check"
    CHECK (
      ("escalationAfterBusinessDays" = 0 AND "escalationRecipientSubject" IS NULL)
      OR (
        "escalationAfterBusinessDays" BETWEEN 1 AND 90
        AND "escalationRecipientSubject" IS NOT NULL
        AND btrim("escalationRecipientSubject") <> ''
        AND char_length("escalationRecipientSubject") BETWEEN 1 AND 200
        AND "escalationRecipientSubject" !~ '[[:cntrl:]]'
        AND "escalationRecipientSubject" !~ '^[[:space:]]|[[:space:]]
          COALESCE("reminderBusinessDayOffsets"[cardinality("reminderBusinessDayOffsets")], 0)
      )
    ),
  ADD CONSTRAINT "ProjectUpdatePolicyRevision_quiet_hours_check"
    CHECK (
      ("quietHoursStartLocal" IS NULL AND "quietHoursEndLocal" IS NULL)
      OR (
        "quietHoursStartLocal" IS NOT NULL
        AND "quietHoursEndLocal" IS NOT NULL
        AND "quietHoursStartLocal" <> "quietHoursEndLocal"
        AND "quietHoursStartLocal" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND "quietHoursEndLocal" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      )
    );

DO $$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.valid_project_update_cadence_offsets(smallint[]) OWNER TO pdaa_migrate';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.valid_project_update_cadence_offsets(smallint[]) FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.valid_project_update_cadence_offsets(smallint[]) TO pdaa_api';
  END IF;
END $$;

        AND "escalationAfterBusinessDays" >
          COALESCE("reminderBusinessDayOffsets"[cardinality("reminderBusinessDayOffsets")], 0)
      )
    ),
  ADD CONSTRAINT "ProjectUpdatePolicyRevision_quiet_hours_check"
    CHECK (
      ("quietHoursStartLocal" IS NULL AND "quietHoursEndLocal" IS NULL)
      OR (
        "quietHoursStartLocal" IS NOT NULL
        AND "quietHoursEndLocal" IS NOT NULL
        AND "quietHoursStartLocal" <> "quietHoursEndLocal"
        AND "quietHoursStartLocal" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        AND "quietHoursEndLocal" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      )
    );

DO $$
BEGIN
  IF to_regrole('pdaa_migrate') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.valid_project_update_cadence_offsets(smallint[]) OWNER TO pdaa_migrate';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.valid_project_update_cadence_offsets(smallint[]) FROM PUBLIC;
DO $$
BEGIN
  IF to_regrole('pdaa_api') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.valid_project_update_cadence_offsets(smallint[]) TO pdaa_api';
  END IF;
END $$;
