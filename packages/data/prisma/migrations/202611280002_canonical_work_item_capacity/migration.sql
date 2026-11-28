-- NFR-SCL-001: admit 100 work items per project for the Release 1 reference workload.
ALTER TABLE "CanonicalProject"
  DROP CONSTRAINT "CanonicalProject_shape",
  ADD CONSTRAINT "CanonicalProject_shape" CHECK (
    ("createdBy" IS NULL OR (length("createdBy")>0 AND "createdBy"=btrim("createdBy")))
    AND ("baselineStart" IS NULL OR "baselineStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("baselineEnd" IS NULL OR "baselineEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("plannedStart" IS NULL OR "plannedStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("plannedEnd" IS NULL OR "plannedEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("forecastStart" IS NULL OR "forecastStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("forecastEnd" IS NULL OR "forecastEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("actualStart" IS NULL OR "actualStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("actualEnd" IS NULL OR "actualEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
    AND ("baselineStart" IS NULL OR "baselineEnd" IS NULL OR "baselineStart"<="baselineEnd")
    AND ("plannedStart" IS NULL OR "plannedEnd" IS NULL OR "plannedStart"<="plannedEnd")
    AND ("forecastStart" IS NULL OR "forecastEnd" IS NULL OR "forecastStart"<="forecastEnd")
    AND ("actualStart" IS NULL OR "actualEnd" IS NULL OR "actualStart"<="actualEnd")
    AND revision=1
    AND "responsibilitiesCount" BETWEEN 0 AND 50
    AND "sprintsCount" BETWEEN 0 AND 50
    AND "milestonesCount" BETWEEN 0 AND 50
    AND "workItemsCount" BETWEEN 0 AND 100
    AND "requiredWorkItemsCount" BETWEEN 0 AND 50
    AND "raidItemsCount" BETWEEN 0 AND 50
    AND "sourceMappingsCount" BETWEEN 0 AND 50
    AND "responsibilitiesCount"+"sprintsCount"+"milestonesCount"+"workItemsCount"+"requiredWorkItemsCount"+"raidItemsCount"+"sourceMappingsCount"<=200
  );
