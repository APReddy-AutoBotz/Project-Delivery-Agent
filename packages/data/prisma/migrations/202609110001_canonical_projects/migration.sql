-- FR-MOD-001/002/003/004/005/006/007. Additive canonical creation; prior history is retained.

ALTER TABLE "AccessGrant" DROP CONSTRAINT "AccessGrant_role_check";

ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_role_check" CHECK (role IN ('leadership','project_manager','portfolio_manager','contributor','pmo_admin','system_admin'));

CREATE UNIQUE INDEX "Project_canonical_parent_key" ON "Project"("customerId","portfolioId",id);

CREATE TABLE "Programme" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "portfolioId" UUID NOT NULL,
  "code" VARCHAR(48) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "createdBy" VARCHAR(200) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "Programme_u0" ON "Programme"("customerId","portfolioId","id");

CREATE UNIQUE INDEX "Programme_u1" ON "Programme"("customerId","portfolioId","code");

ALTER TABLE "Programme" ADD CONSTRAINT "Programme_portfolio_fk" FOREIGN KEY ("customerId","portfolioId") REFERENCES "Portfolio" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Programme" ADD CONSTRAINT "Programme_shape" CHECK (("code" IS NULL OR (length("code")>0 AND "code"=btrim("code"))) AND "code" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND ("name" IS NULL OR (length("name")>0 AND "name"=btrim("name"))) AND ("createdBy" IS NULL OR (length("createdBy")>0 AND "createdBy"=btrim("createdBy"))));

CREATE TABLE "CanonicalProject" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "portfolioId" UUID NOT NULL,
  "programmeId" UUID,
  "baselineStart" DATE,
  "baselineEnd" DATE,
  "plannedStart" DATE,
  "plannedEnd" DATE,
  "forecastStart" DATE,
  "forecastEnd" DATE,
  "actualStart" DATE,
  "actualEnd" DATE,
  "createdBy" VARCHAR(200) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "sealed" BOOLEAN NOT NULL DEFAULT false,
  "responsibilitiesCount" INTEGER NOT NULL,
  "sprintsCount" INTEGER NOT NULL,
  "milestonesCount" INTEGER NOT NULL,
  "workItemsCount" INTEGER NOT NULL,
  "requiredWorkItemsCount" INTEGER NOT NULL,
  "raidItemsCount" INTEGER NOT NULL,
  "sourceMappingsCount" INTEGER NOT NULL
);

CREATE UNIQUE INDEX "CanonicalProject_u0" ON "CanonicalProject"("customerId","id");

CREATE UNIQUE INDEX "CanonicalProject_u1" ON "CanonicalProject"("customerId","portfolioId","id");

ALTER TABLE "CanonicalProject" ADD CONSTRAINT "CanonicalProject_project_fk" FOREIGN KEY ("customerId","portfolioId","id") REFERENCES "Project" ("customerId","portfolioId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalProject" ADD CONSTRAINT "CanonicalProject_programme_fk" FOREIGN KEY ("customerId","portfolioId","programmeId") REFERENCES "Programme" ("customerId","portfolioId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalProject" ADD CONSTRAINT "CanonicalProject_shape" CHECK (("createdBy" IS NULL OR (length("createdBy")>0 AND "createdBy"=btrim("createdBy"))) AND ("baselineStart" IS NULL OR "baselineStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineEnd" IS NULL OR "baselineEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedStart" IS NULL OR "plannedStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedEnd" IS NULL OR "plannedEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastStart" IS NULL OR "forecastStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastEnd" IS NULL OR "forecastEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualStart" IS NULL OR "actualStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualEnd" IS NULL OR "actualEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineStart" IS NULL OR "baselineEnd" IS NULL OR "baselineStart"<="baselineEnd") AND ("plannedStart" IS NULL OR "plannedEnd" IS NULL OR "plannedStart"<="plannedEnd") AND ("forecastStart" IS NULL OR "forecastEnd" IS NULL OR "forecastStart"<="forecastEnd") AND ("actualStart" IS NULL OR "actualEnd" IS NULL OR "actualStart"<="actualEnd") AND revision=1 AND "responsibilitiesCount" BETWEEN 0 AND 50 AND "sprintsCount" BETWEEN 0 AND 50 AND "milestonesCount" BETWEEN 0 AND 50 AND "workItemsCount" BETWEEN 0 AND 50 AND "requiredWorkItemsCount" BETWEEN 0 AND 50 AND "raidItemsCount" BETWEEN 0 AND 50 AND "sourceMappingsCount" BETWEEN 0 AND 50 AND "responsibilitiesCount"+"sprintsCount"+"milestonesCount"+"workItemsCount"+"requiredWorkItemsCount"+"raidItemsCount"+"sourceMappingsCount"<=200);

CREATE TABLE "ProjectResponsibility" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "subject" VARCHAR(200) NOT NULL,
  "displayName" VARCHAR(160) NOT NULL
);

CREATE UNIQUE INDEX "ProjectResponsibility_u0" ON "ProjectResponsibility"("customerId","projectId","role","subject");

ALTER TABLE "ProjectResponsibility" ADD CONSTRAINT "ProjectResponsibility_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ProjectResponsibility" ADD CONSTRAINT "ProjectResponsibility_shape" CHECK (("role" IS NULL OR (length("role")>0 AND "role"=btrim("role"))) AND ("subject" IS NULL OR (length("subject")>0 AND "subject"=btrim("subject"))) AND ("displayName" IS NULL OR (length("displayName")>0 AND "displayName"=btrim("displayName"))) AND role IN ('SPONSOR','PROJECT_MANAGER','SCRUM_MASTER','TEAM_LEAD','RESPONSIBLE_OWNER'));

CREATE TABLE "Sprint" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "key" VARCHAR(48) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "baselineStart" DATE,
  "baselineEnd" DATE,
  "plannedStart" DATE,
  "plannedEnd" DATE,
  "forecastStart" DATE,
  "forecastEnd" DATE,
  "actualStart" DATE,
  "actualEnd" DATE
);

CREATE UNIQUE INDEX "Sprint_u0" ON "Sprint"("customerId","projectId","id");

CREATE UNIQUE INDEX "Sprint_u1" ON "Sprint"("customerId","projectId","key");

ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_shape" CHECK (("key" IS NULL OR (length("key")>0 AND "key"=btrim("key"))) AND "key" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND ("name" IS NULL OR (length("name")>0 AND "name"=btrim("name"))) AND ("baselineStart" IS NULL OR "baselineStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineEnd" IS NULL OR "baselineEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedStart" IS NULL OR "plannedStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedEnd" IS NULL OR "plannedEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastStart" IS NULL OR "forecastStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastEnd" IS NULL OR "forecastEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualStart" IS NULL OR "actualStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualEnd" IS NULL OR "actualEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineStart" IS NULL OR "baselineEnd" IS NULL OR "baselineStart"<="baselineEnd") AND ("plannedStart" IS NULL OR "plannedEnd" IS NULL OR "plannedStart"<="plannedEnd") AND ("forecastStart" IS NULL OR "forecastEnd" IS NULL OR "forecastStart"<="forecastEnd") AND ("actualStart" IS NULL OR "actualEnd" IS NULL OR "actualStart"<="actualEnd"));

CREATE TABLE "Milestone" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "key" VARCHAR(48) NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "baselineStart" DATE,
  "baselineEnd" DATE,
  "plannedStart" DATE,
  "plannedEnd" DATE,
  "forecastStart" DATE,
  "forecastEnd" DATE,
  "actualStart" DATE,
  "actualEnd" DATE
);

CREATE UNIQUE INDEX "Milestone_u0" ON "Milestone"("customerId","projectId","id");

CREATE UNIQUE INDEX "Milestone_u1" ON "Milestone"("customerId","projectId","key");

ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_shape" CHECK (("key" IS NULL OR (length("key")>0 AND "key"=btrim("key"))) AND "key" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND ("name" IS NULL OR (length("name")>0 AND "name"=btrim("name"))) AND ("state" IS NULL OR (length("state")>0 AND "state"=btrim("state"))) AND ("baselineStart" IS NULL OR "baselineStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineEnd" IS NULL OR "baselineEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedStart" IS NULL OR "plannedStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedEnd" IS NULL OR "plannedEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastStart" IS NULL OR "forecastStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastEnd" IS NULL OR "forecastEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualStart" IS NULL OR "actualStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualEnd" IS NULL OR "actualEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineStart" IS NULL OR "baselineEnd" IS NULL OR "baselineStart"<="baselineEnd") AND ("plannedStart" IS NULL OR "plannedEnd" IS NULL OR "plannedStart"<="plannedEnd") AND ("forecastStart" IS NULL OR "forecastEnd" IS NULL OR "forecastStart"<="forecastEnd") AND ("actualStart" IS NULL OR "actualEnd" IS NULL OR "actualStart"<="actualEnd") AND state IN ('OPEN','IN_PROGRESS','COMPLETE','CANCELLED'));

CREATE TABLE "WorkItem" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "key" VARCHAR(48) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "sprintId" UUID,
  "baselineStart" DATE,
  "baselineEnd" DATE,
  "plannedStart" DATE,
  "plannedEnd" DATE,
  "forecastStart" DATE,
  "forecastEnd" DATE,
  "actualStart" DATE,
  "actualEnd" DATE
);

CREATE UNIQUE INDEX "WorkItem_u0" ON "WorkItem"("customerId","projectId","id");

CREATE UNIQUE INDEX "WorkItem_u1" ON "WorkItem"("customerId","projectId","key");

ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_sprint_fk" FOREIGN KEY ("customerId","projectId","sprintId") REFERENCES "Sprint" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_shape" CHECK (("key" IS NULL OR (length("key")>0 AND "key"=btrim("key"))) AND "key" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND ("title" IS NULL OR (length("title")>0 AND "title"=btrim("title"))) AND ("state" IS NULL OR (length("state")>0 AND "state"=btrim("state"))) AND ("baselineStart" IS NULL OR "baselineStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineEnd" IS NULL OR "baselineEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedStart" IS NULL OR "plannedStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("plannedEnd" IS NULL OR "plannedEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastStart" IS NULL OR "forecastStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("forecastEnd" IS NULL OR "forecastEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualStart" IS NULL OR "actualStart" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("actualEnd" IS NULL OR "actualEnd" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31') AND ("baselineStart" IS NULL OR "baselineEnd" IS NULL OR "baselineStart"<="baselineEnd") AND ("plannedStart" IS NULL OR "plannedEnd" IS NULL OR "plannedStart"<="plannedEnd") AND ("forecastStart" IS NULL OR "forecastEnd" IS NULL OR "forecastStart"<="forecastEnd") AND ("actualStart" IS NULL OR "actualEnd" IS NULL OR "actualStart"<="actualEnd") AND state IN ('OPEN','IN_PROGRESS','COMPLETE','CANCELLED'));

CREATE TABLE "RequiredWorkItem" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "milestoneId" UUID NOT NULL,
  "workItemId" UUID NOT NULL
);

CREATE UNIQUE INDEX "RequiredWorkItem_u0" ON "RequiredWorkItem"("customerId","projectId","milestoneId","workItemId");

ALTER TABLE "RequiredWorkItem" ADD CONSTRAINT "RequiredWorkItem_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RequiredWorkItem" ADD CONSTRAINT "RequiredWorkItem_milestone_fk" FOREIGN KEY ("customerId","projectId","milestoneId") REFERENCES "Milestone" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RequiredWorkItem" ADD CONSTRAINT "RequiredWorkItem_workItem_fk" FOREIGN KEY ("customerId","projectId","workItemId") REFERENCES "WorkItem" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "RaidItem" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "key" VARCHAR(48) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "description" VARCHAR(4096) NOT NULL,
  "state" VARCHAR(16) NOT NULL,
  "ownerSubject" VARCHAR(200)
);

CREATE UNIQUE INDEX "RaidItem_u0" ON "RaidItem"("customerId","projectId","id");

CREATE UNIQUE INDEX "RaidItem_u1" ON "RaidItem"("customerId","projectId","key");

ALTER TABLE "RaidItem" ADD CONSTRAINT "RaidItem_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RaidItem" ADD CONSTRAINT "RaidItem_shape" CHECK (("key" IS NULL OR (length("key")>0 AND "key"=btrim("key"))) AND "key" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND ("kind" IS NULL OR (length("kind")>0 AND "kind"=btrim("kind"))) AND ("title" IS NULL OR (length("title")>0 AND "title"=btrim("title"))) AND ("state" IS NULL OR (length("state")>0 AND "state"=btrim("state"))) AND ("ownerSubject" IS NULL OR (length("ownerSubject")>0 AND "ownerSubject"=btrim("ownerSubject"))) AND state IN ('OPEN','IN_PROGRESS','COMPLETE','CANCELLED') AND kind IN ('RISK','ASSUMPTION','ISSUE','DEPENDENCY','DECISION','ACTION'));

CREATE TABLE "CanonicalSourceMapping" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "sourceSystem" VARCHAR(64) NOT NULL,
  "instanceKey" VARCHAR(48) NOT NULL,
  "externalType" VARCHAR(64) NOT NULL,
  "externalId" VARCHAR(200) NOT NULL,
  "externalRevision" VARCHAR(128),
  "url" VARCHAR(2048),
  "targetType" VARCHAR(16) NOT NULL,
  "sprintId" UUID,
  "milestoneId" UUID,
  "workItemId" UUID,
  "raidItemId" UUID
);

CREATE UNIQUE INDEX "CanonicalSourceMapping_u0" ON "CanonicalSourceMapping"("customerId","sourceSystem","instanceKey","externalType","externalId");

ALTER TABLE "CanonicalSourceMapping" ADD CONSTRAINT "CanonicalSourceMapping_project_fk" FOREIGN KEY ("customerId","projectId") REFERENCES "CanonicalProject" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalSourceMapping" ADD CONSTRAINT "CanonicalSourceMapping_sprint_fk" FOREIGN KEY ("customerId","projectId","sprintId") REFERENCES "Sprint" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalSourceMapping" ADD CONSTRAINT "CanonicalSourceMapping_milestone_fk" FOREIGN KEY ("customerId","projectId","milestoneId") REFERENCES "Milestone" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalSourceMapping" ADD CONSTRAINT "CanonicalSourceMapping_workItem_fk" FOREIGN KEY ("customerId","projectId","workItemId") REFERENCES "WorkItem" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalSourceMapping" ADD CONSTRAINT "CanonicalSourceMapping_raidItem_fk" FOREIGN KEY ("customerId","projectId","raidItemId") REFERENCES "RaidItem" ("customerId","projectId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalSourceMapping" ADD CONSTRAINT "CanonicalSourceMapping_shape" CHECK (("sourceSystem" IS NULL OR (length("sourceSystem")>0 AND "sourceSystem"=btrim("sourceSystem"))) AND ("instanceKey" IS NULL OR (length("instanceKey")>0 AND "instanceKey"=btrim("instanceKey"))) AND "instanceKey" ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$' AND ("externalType" IS NULL OR (length("externalType")>0 AND "externalType"=btrim("externalType"))) AND ("externalId" IS NULL OR (length("externalId")>0 AND "externalId"=btrim("externalId"))) AND ("url" IS NULL OR (length("url")>0 AND "url"=btrim("url"))) AND ("targetType" IS NULL OR (length("targetType")>0 AND "targetType"=btrim("targetType"))) AND (("targetType"='PROJECT' AND "sprintId" IS NULL AND "milestoneId" IS NULL AND "workItemId" IS NULL AND "raidItemId" IS NULL) OR ("targetType"='SPRINT' AND "sprintId" IS NOT NULL AND "milestoneId" IS NULL AND "workItemId" IS NULL AND "raidItemId" IS NULL) OR ("targetType"='MILESTONE' AND "sprintId" IS NULL AND "milestoneId" IS NOT NULL AND "workItemId" IS NULL AND "raidItemId" IS NULL) OR ("targetType"='WORK_ITEM' AND "sprintId" IS NULL AND "milestoneId" IS NULL AND "workItemId" IS NOT NULL AND "raidItemId" IS NULL) OR ("targetType"='RAID_ITEM' AND "sprintId" IS NULL AND "milestoneId" IS NULL AND "workItemId" IS NULL AND "raidItemId" IS NOT NULL)) AND (url IS NULL OR (url ~ '^https://[^/@[:space:]?#]+([/:?#]|$)' AND url !~ '[[:cntrl:][:space:]]' AND position(chr(92) in url)=0 AND substring(url from '^https://([^/?#]+)') !~ '@')));

CREATE TABLE "CanonicalCreationReceipt" (
  "id" UUID PRIMARY KEY,
  "customerId" UUID NOT NULL,
  "portfolioId" UUID NOT NULL,
  "subject" VARCHAR(200) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "operation" VARCHAR(16) NOT NULL,
  "requestHash" VARCHAR(64) NOT NULL,
  "programmeId" UUID,
  "projectId" UUID
);

CREATE UNIQUE INDEX "CanonicalCreationReceipt_u0" ON "CanonicalCreationReceipt"("customerId","portfolioId","subject","idempotencyKey");

CREATE UNIQUE INDEX "CanonicalCreationReceipt_u1" ON "CanonicalCreationReceipt"("programmeId");

CREATE UNIQUE INDEX "CanonicalCreationReceipt_u2" ON "CanonicalCreationReceipt"("projectId");
CREATE UNIQUE INDEX "CanonicalCreationReceipt_programme_scope_key" ON "CanonicalCreationReceipt"("customerId","portfolioId","programmeId");
CREATE UNIQUE INDEX "CanonicalCreationReceipt_project_scope_key" ON "CanonicalCreationReceipt"("customerId","portfolioId","projectId");

ALTER TABLE "CanonicalCreationReceipt" ADD CONSTRAINT "CanonicalCreationReceipt_portfolio_fk" FOREIGN KEY ("customerId","portfolioId") REFERENCES "Portfolio" ("customerId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalCreationReceipt" ADD CONSTRAINT "CanonicalCreationReceipt_programme_fk" FOREIGN KEY ("customerId","portfolioId","programmeId") REFERENCES "Programme" ("customerId","portfolioId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CanonicalCreationReceipt" ADD CONSTRAINT "CanonicalCreationReceipt_project_fk" FOREIGN KEY ("customerId","portfolioId","projectId") REFERENCES "CanonicalProject" ("customerId","portfolioId","id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A creation aggregate becomes permanently closed only after its full receipt and
-- declared children exist. These invoker functions are also checked after restore.
CREATE FUNCTION valid_canonical_programme(target UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "Programme" p JOIN "CanonicalCreationReceipt" r
    ON r."programmeId"=p.id AND r."customerId"=p."customerId" AND r."portfolioId"=p."portfolioId"
    WHERE p.id=target AND r.operation='PROGRAMME' AND r.subject=p."createdBy")
$$;
CREATE FUNCTION valid_canonical_project(target UUID) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "CanonicalProject" p JOIN "Project" b
    ON b.id=p.id AND b."customerId"=p."customerId" AND b."portfolioId"=p."portfolioId"
    JOIN "CanonicalCreationReceipt" r ON r."projectId"=p.id AND r."customerId"=p."customerId"
      AND r."portfolioId"=p."portfolioId" AND r.subject=p."createdBy" AND r.operation='PROJECT'
    WHERE p.id=target AND b.code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$'
    AND length(b.name) BETWEEN 1 AND 160 AND b.name=btrim(b.name) AND length(b.description)<=4096
    AND b."reportedStatus" IN ('GREEN','AMBER','RED','UNKNOWN')
    AND (p."programmeId" IS NULL OR valid_canonical_programme(p."programmeId"))
    AND p."responsibilitiesCount"=(SELECT count(*) FROM "ProjectResponsibility" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id)
    AND p."sprintsCount"=(SELECT count(*) FROM "Sprint" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id)
    AND p."milestonesCount"=(SELECT count(*) FROM "Milestone" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id)
    AND p."workItemsCount"=(SELECT count(*) FROM "WorkItem" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id)
    AND p."requiredWorkItemsCount"=(SELECT count(*) FROM "RequiredWorkItem" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id)
    AND p."raidItemsCount"=(SELECT count(*) FROM "RaidItem" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id)
    AND p."sourceMappingsCount"=(SELECT count(*) FROM "CanonicalSourceMapping" c WHERE c."customerId"=p."customerId" AND c."projectId"=p.id))
$$;
CREATE FUNCTION reject_canonical_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Canonical creation history is immutable'; END
$$;
CREATE FUNCTION guard_canonical_child_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent "CanonicalProject"%ROWTYPE;
BEGIN
  SELECT * INTO parent FROM "CanonicalProject" WHERE id=NEW."projectId" FOR UPDATE;
  IF NOT FOUND OR parent.sealed OR parent."customerId"<>NEW."customerId" THEN
    RAISE EXCEPTION 'Canonical parent unavailable';
  END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION guard_canonical_receipt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT;
BEGIN
  IF NEW.operation='PROJECT' THEN
    SELECT "createdBy" INTO actor FROM "CanonicalProject" WHERE id=NEW."projectId" AND NOT sealed FOR UPDATE;
  ELSE
    SELECT "createdBy" INTO actor FROM "Programme" WHERE id=NEW."programmeId";
  END IF;
  IF actor IS NULL OR actor<>NEW.subject THEN RAISE EXCEPTION 'Canonical receipt unavailable'; END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION guard_canonical_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM 1 FROM "Project" WHERE id=NEW.id AND "customerId"=NEW."customerId" AND "portfolioId"=NEW."portfolioId" FOR UPDATE;
    IF NOT FOUND OR NEW.sealed THEN RAISE EXCEPTION 'Canonical project must start unsealed'; END IF;
  ELSIF OLD.sealed OR NOT NEW.sealed OR (to_jsonb(NEW)-'sealed') IS DISTINCT FROM (to_jsonb(OLD)-'sealed')
    OR NOT valid_canonical_project(OLD.id) THEN
    RAISE EXCEPTION 'Canonical seal unavailable';
  END IF;
  RETURN NEW;
END
$$;
CREATE FUNCTION check_canonical_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='Programme' THEN
    IF NOT valid_canonical_programme(NEW.id) THEN RAISE EXCEPTION 'Incomplete programme creation'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM "CanonicalProject" WHERE id=NEW.id AND sealed)
      OR NOT valid_canonical_project(NEW.id) THEN RAISE EXCEPTION 'Incomplete canonical creation'; END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE FUNCTION guard_canonical_base_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM "CanonicalProject") THEN RAISE EXCEPTION 'Canonical project history is immutable'; END IF;
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM "CanonicalProject" WHERE id=OLD.id)
    AND (TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION 'Canonical project history is immutable';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER canonical_base_no_mutation BEFORE UPDATE OR DELETE ON "Project" FOR EACH ROW EXECUTE FUNCTION guard_canonical_base_project();
CREATE TRIGGER canonical_base_no_truncate BEFORE TRUNCATE ON "Project" FOR EACH STATEMENT EXECUTE FUNCTION guard_canonical_base_project();
CREATE TRIGGER canonical_project_guard BEFORE INSERT OR UPDATE ON "CanonicalProject" FOR EACH ROW EXECUTE FUNCTION guard_canonical_project();
CREATE TRIGGER canonical_receipt_guard BEFORE INSERT ON "CanonicalCreationReceipt" FOR EACH ROW EXECUTE FUNCTION guard_canonical_receipt_insert();
CREATE CONSTRAINT TRIGGER canonical_project_commit AFTER INSERT OR UPDATE ON "CanonicalProject" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_canonical_commit();
CREATE CONSTRAINT TRIGGER canonical_programme_commit AFTER INSERT ON "Programme" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_canonical_commit();
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['Programme','CanonicalProject','ProjectResponsibility','Sprint','Milestone','WorkItem','RequiredWorkItem','RaidItem','CanonicalSourceMapping','CanonicalCreationReceipt'] LOOP
    IF t='CanonicalProject' THEN
      EXECUTE format('CREATE TRIGGER canonical_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_canonical_mutation()',t);
    ELSE
      EXECUTE format('CREATE TRIGGER canonical_no_mutation BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_canonical_mutation()',t);
    END IF;
    EXECUTE format('CREATE TRIGGER canonical_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_canonical_mutation()',t);
    IF t NOT IN ('Programme','CanonicalProject','CanonicalCreationReceipt') THEN
      EXECUTE format('CREATE TRIGGER canonical_parent_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_canonical_child_insert()',t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE "CanonicalCreationReceipt" ADD CONSTRAINT "CanonicalCreationReceipt_shape" CHECK (("subject" IS NULL OR (length("subject")>0 AND "subject"=btrim("subject"))) AND ("idempotencyKey" IS NULL OR (length("idempotencyKey")>0 AND "idempotencyKey"=btrim("idempotencyKey"))) AND ("operation" IS NULL OR (length("operation")>0 AND "operation"=btrim("operation"))) AND ("requestHash" IS NULL OR (length("requestHash")>0 AND "requestHash"=btrim("requestHash"))) AND ((operation='PROJECT' AND "projectId" IS NOT NULL AND "programmeId" IS NULL) OR (operation='PROGRAMME' AND "programmeId" IS NOT NULL AND "projectId" IS NULL)) AND "requestHash" ~ '^[a-f0-9]{64}$'  AND "idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$' );

-- FR-EVD-003/010, NFR-SEC-001: preserve every assessment integrity check while
-- reading the immutable result arrays once. Repeated large-JSON extraction
-- exhausted the existing 10-second transaction limit at 1,000 versions.
-- The released migration remains unchanged; both seal and delivery checks remain.
CREATE OR REPLACE FUNCTION public.valid_fact_assessment(aid uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE result_versions jsonb; result_conflicts jsonb; a public."FactAssessment"%ROWTYPE; pol public."AuthorityPolicyRevision"%ROWTYPE;
  expected_policy jsonb := 'null'::jsonb; expected_scope jsonb; item jsonb; v record;
  actual_ids jsonb; output_ids jsonb; conflict_item jsonb; linked_count integer;
  freshness text; conflict_state text; selector jsonb; tier integer; expiry timestamptz; deadline timestamptz;
  applicability text; reasons jsonb; selected_tier integer; selected_ids jsonb;
  expected_status text; needs_revalidation boolean; has_ambiguity boolean; disagreement_ids jsonb; higher_ids jsonb;
BEGIN
  SELECT * INTO a FROM public."FactAssessment" WHERE id=aid;
  IF NOT FOUND OR a."evaluatorVersion"<>1 OR octet_length(a.result::text)>33554432
    OR a."factRevision">(SELECT revision FROM public."ProjectFact" WHERE id=a."factId") THEN RETURN false; END IF;
  result_versions := a.result->'versions';
  result_conflicts := a.result->'conflicts';
  IF NOT (a.result ?& ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'])
    OR a.result - ARRAY['scope','asOf','mode','policy','complete','status','revalidationRequired','selectedTier','resolvedValue','candidateVersionIds','supportingVersionIds','supportingEvidenceIds','conflict','conflicts','reconciliationRequired','versions'] <> '{}'::jsonb THEN RETURN false; END IF;
  expected_scope := jsonb_build_object('customerId',a."customerId",'projectId',a."projectId",'factId',a."factId",'factType',a."factType");
  IF a.result->'scope' IS DISTINCT FROM expected_scope OR a.result->>'asOf' IS DISTINCT FROM public.authority_instant(a."asOf")
    OR a.result->>'mode' IS DISTINCT FROM 'HISTORICAL' OR a.result->'complete' IS DISTINCT FROM to_jsonb(a.complete)
    OR jsonb_typeof(result_versions) IS DISTINCT FROM 'array'
    OR jsonb_typeof(result_conflicts) IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'candidateVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingVersionIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(a.result->'supportingEvidenceIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  SELECT * INTO pol FROM public."AuthorityPolicyRevision" WHERE "policyId"=a."policyId"
    AND revision<=a."policyThroughRevision" AND "recordedAt"<=a."asOf" AND "effectiveAt"<=a."asOf" ORDER BY revision DESC LIMIT 1;
  IF pol.id IS DISTINCT FROM a."policyRevisionId" THEN RETURN false; END IF;
  IF pol.state='ENABLED' THEN expected_policy := pol.definition || jsonb_build_object('revisionId',pol.id,'customerId',pol."customerId",'projectId',pol."projectId",'factType',pol."factType",'recordedAt',public.authority_instant(pol."recordedAt"),'effectiveAt',public.authority_instant(pol."effectiveAt")); END IF;
  IF a.result->'policy' IS DISTINCT FROM expected_policy THEN RETURN false; END IF;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  IF linked_count<>a."versionCount" OR jsonb_array_length(result_versions)<>a."versionCount" THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("versionId"::text ORDER BY "versionId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(result_versions);
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  IF a.complete THEN
    IF (SELECT count(*) FROM public."ProjectFactVersion" WHERE "factId"=a."factId" AND revision<=a."factRevision")<>a."versionCount" THEN RETURN false; END IF;
  ELSIF a."versionCount"<>0 OR a."conflictCount"<>0 OR a.result->>'status' IS DISTINCT FROM 'INCOMPLETE'
    OR a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(result_versions) LOOP
    SELECT fv.*,e."observedAt" INTO v FROM public."ProjectFactVersion" fv JOIN public."FactEvidence" e ON e.id=fv."evidenceId" WHERE fv.id=(item->>'id')::uuid;
    IF NOT FOUND OR v."factId"<>a."factId" OR v.revision>a."factRevision"
      OR item->'evidenceIds' IS DISTINCT FROM jsonb_build_array(v."evidenceId") THEN RETURN false; END IF;
    IF item->>'visibility'='restricted' THEN
      IF item IS DISTINCT FROM jsonb_build_object('id',v.id,'evidenceIds',jsonb_build_array(v."evidenceId"),'visibility','restricted','revalidationRequired',true) THEN RETURN false; END IF;
    ELSIF item->>'visibility'='available' THEN
      IF NOT(item ?& ARRAY['id','scope','source','value','provenance','effectiveAt','observedAt','validUntil','evidenceIds','temporalApplicability','assessedValidUntil','unresolvedConflictIds','assessment','visibility','revalidationRequired','sourceType','approval','approvalStateAsOf','authorityTier','eligibilityReasons'])
        OR item - ARRAY['id','scope','source','value','provenance','effectiveAt','observedAt','validUntil','evidenceIds','temporalApplicability','assessedValidUntil','unresolvedConflictIds','assessment','visibility','revalidationRequired','sourceType','approval','approvalStateAsOf','authorityTier','eligibilityReasons'] <> '{}'::jsonb
        OR item->'revalidationRequired' IS DISTINCT FROM 'false'::jsonb
        OR item->>'approvalStateAsOf' IS DISTINCT FROM 'NOT_REQUIRED'
        OR item->>'temporalApplicability' NOT IN ('NOT_YET_OBSERVED','NOT_YET_EFFECTIVE','SUPERSEDED','AMBIGUOUS','APPLICABLE')
        OR jsonb_typeof(item->'temporalApplicability') IS DISTINCT FROM 'string'
        OR jsonb_typeof(item->'eligibilityReasons') IS DISTINCT FROM 'array'
        OR jsonb_typeof(item->'unresolvedConflictIds') IS DISTINCT FROM 'array'
        THEN RETURN false; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(item->'eligibilityReasons') reason WHERE jsonb_typeof(reason) IS DISTINCT FROM 'string'
        OR reason #>> '{}' NOT IN ('NO_AUTHORITY_RULE','NOT_APPLICABLE','AMBIGUOUS_STREAM','APPROVAL_REQUIRED','REJECTED','STALE','UNKNOWN_VALIDITY','UNVERIFIED_ORIGIN')) THEN RETURN false; END IF;
      SELECT COALESCE(jsonb_agg(c.id::text ORDER BY c.id),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
        WHERE ac."assessmentId"=aid AND (c."leftVersionId"=v.id OR c."rightVersionId"=v.id);
      IF item->'unresolvedConflictIds' IS DISTINCT FROM actual_ids THEN RETURN false; END IF;
      SELECT s.value,(t.ordinality-1)::integer INTO selector,tier
        FROM jsonb_array_elements(expected_policy->'tiers') WITH ORDINALITY t(value,ordinality)
        CROSS JOIN LATERAL jsonb_array_elements(t.value->'selectors') s(value)
        WHERE s.value->>'sourceType'='human_statement' AND (s.value->'instanceId'='null'::jsonb OR s.value->>'instanceId'=v."sourceId"::text);
      expiry := v."validUntil";
      IF selector->'validity' <> 'null'::jsonb THEN
        deadline := ((CASE WHEN selector->'validity'->>'basis'='observedAt' THEN v."observedAt" ELSE v."effectiveAt" END AT TIME ZONE 'UTC')
          + ((selector->'validity'->>'durationMs')::bigint / 86400000) * interval '1 day'
          + ((selector->'validity'->>'durationMs')::bigint % 86400000) * interval '1 millisecond') AT TIME ZONE 'UTC';
        IF NOT isfinite(deadline) OR deadline>='10000-01-01 00:00:00+00'::timestamptz THEN RETURN false; END IF;
        expiry := LEAST(expiry,deadline);
      END IF;
      applicability := CASE WHEN v."observedAt">a."asOf" THEN 'NOT_YET_OBSERVED' WHEN v."effectiveAt">a."asOf" THEN 'NOT_YET_EFFECTIVE'
        WHEN EXISTS (SELECT 1 FROM public."ProjectFactVersion" newer JOIN public."FactEvidence" ne ON ne.id=newer."evidenceId"
          WHERE newer."sourceId"=v."sourceId" AND newer.revision<=a."factRevision" AND ne."observedAt"<=a."asOf" AND newer."effectiveAt"<=a."asOf"
          AND (newer."effectiveAt",ne."observedAt")>(v."effectiveAt",v."observedAt")) THEN 'SUPERSEDED'
        WHEN (SELECT count(*) FROM public."ProjectFactVersion" tied JOIN public."FactEvidence" te ON te.id=tied."evidenceId"
          WHERE tied."sourceId"=v."sourceId" AND tied.revision<=a."factRevision" AND tied."effectiveAt"=v."effectiveAt" AND te."observedAt"=v."observedAt")>1 THEN 'AMBIGUOUS' ELSE 'APPLICABLE' END;
      freshness := CASE WHEN applicability IN ('NOT_YET_OBSERVED','NOT_YET_EFFECTIVE') OR expiry IS NULL THEN 'UNKNOWN'
        WHEN expiry<=a."asOf" THEN 'STALE' ELSE 'CURRENT' END;
      reasons := '[]'::jsonb;
      IF selector IS NULL THEN reasons := reasons || '"NO_AUTHORITY_RULE"'::jsonb; END IF;
      IF applicability NOT IN ('APPLICABLE','AMBIGUOUS') THEN reasons := reasons || '"NOT_APPLICABLE"'::jsonb; END IF;
      IF applicability='AMBIGUOUS' THEN reasons := reasons || '"AMBIGUOUS_STREAM"'::jsonb; END IF;
      IF selector->>'requiredApproval'='APPROVED' THEN reasons := reasons || '"APPROVAL_REQUIRED"'::jsonb; END IF;
      IF freshness='STALE' THEN reasons := reasons || '"STALE"'::jsonb; END IF;
      IF freshness='UNKNOWN' THEN reasons := reasons || '"UNKNOWN_VALIDITY"'::jsonb; END IF;
      IF item->'authorityTier' IS DISTINCT FROM COALESCE(to_jsonb(tier),'null'::jsonb)
        OR item->'assessedValidUntil' IS DISTINCT FROM COALESCE(to_jsonb(public.authority_instant(expiry)),'null'::jsonb)
        OR item->>'temporalApplicability' IS DISTINCT FROM applicability OR item->'eligibilityReasons' IS DISTINCT FROM reasons THEN RETURN false; END IF;
      conflict_state := CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(result_conflicts) c WHERE c->'versionIds' @> jsonb_build_array(v.id)) THEN 'CONFLICTING' ELSE 'NONE' END;
      IF item->'assessment' IS DISTINCT FROM jsonb_build_object('provenance',v.provenance,'freshness',freshness,'conflict',conflict_state,'classification',CASE WHEN conflict_state='CONFLICTING' THEN 'CONFLICTING' WHEN freshness<>'CURRENT' THEN freshness ELSE v.provenance END,'assessedAt',public.authority_instant(a."asOf")) THEN RETURN false; END IF;
      IF item->'scope' IS DISTINCT FROM expected_scope OR item->'value' IS DISTINCT FROM v.value
        OR item->>'provenance' IS DISTINCT FROM v.provenance OR item->>'sourceType' IS DISTINCT FROM 'human_statement'
        OR item->>'effectiveAt' IS DISTINCT FROM public.authority_instant(v."effectiveAt")
        OR item->>'observedAt' IS DISTINCT FROM public.authority_instant(v."observedAt")
        OR item->'validUntil' IS DISTINCT FROM COALESCE(to_jsonb(public.authority_instant(v."validUntil")),'null'::jsonb)
        OR item->'source' IS DISTINCT FROM jsonb_build_object('instanceId',v."sourceId",'recordType','human_statement','recordId',v."sourceId",'revision',v."evidenceId")
        OR item->'approval' IS DISTINCT FROM jsonb_build_object('state','NOT_REQUIRED','decisionAt',NULL,'decisionId',NULL)
        THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
  END LOOP;
  SELECT count(*) INTO linked_count FROM public."FactAssessmentConflict" WHERE "assessmentId"=aid;
  IF linked_count<>a."conflictCount" THEN RETURN false; END IF;
  IF a.complete AND (SELECT count(*) FROM public."FactAuthorityConflict" WHERE "factId"=a."factId" AND revision<=a."conflictThroughRevision")<>a."conflictCount" THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
    WHERE ac."assessmentId"=aid AND (a."conflictThroughRevision" IS NULL OR c.revision>a."conflictThroughRevision")) THEN RETURN false; END IF;
  SELECT COALESCE(jsonb_agg("conflictId"::text ORDER BY "conflictId"),'[]'::jsonb) INTO actual_ids FROM public."FactAssessmentConflict" WHERE "assessmentId"=aid;
  SELECT COALESCE(jsonb_agg(value->>'recordedConflictId' ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids THEN RETURN false; END IF;
  -- Compare the complete recorded set in one query. A per-pair query loop
  -- repeatedly expanded the large capture JSON and exhausted transaction time.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind','RECORDED','recordedConflictId',c.id,
      'versionIds',jsonb_build_array(c."leftVersionId",c."rightVersionId"),
      'evidenceIds',jsonb_build_array(LEAST(l."evidenceId",r."evidenceId"),GREATEST(l."evidenceId",r."evidenceId"))) ORDER BY c.id),'[]'::jsonb)
    INTO actual_ids FROM public."FactAssessmentConflict" ac JOIN public."FactAuthorityConflict" c ON c.id=ac."conflictId"
    JOIN public."ProjectFactVersion" l ON l.id=c."leftVersionId" JOIN public."ProjectFactVersion" r ON r.id=c."rightVersionId"
    JOIN public."FactAssessmentVersion" al ON al."assessmentId"=aid AND al."versionId"=l.id
    JOIN public."FactAssessmentVersion" ar ON ar."assessmentId"=aid AND ar."versionId"=r.id
    WHERE ac."assessmentId"=aid AND c."detectedAt"<=a."asOf" AND public.valid_authority_conflict(c.id);
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'recordedConflictId'),'[]'::jsonb) INTO output_ids
    FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='RECORDED';
  IF actual_ids IS DISTINCT FROM output_ids OR EXISTS (SELECT 1 FROM jsonb_array_elements(result_conflicts) WHERE jsonb_typeof(value->'kind') IS DISTINCT FROM 'string') THEN RETURN false; END IF;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'<>'RECORDED' LOOP
    IF NOT(conflict_item ?& ARRAY['kind','recordedConflictId','versionIds','evidenceIds'])
      OR conflict_item - ARRAY['kind','recordedConflictId','versionIds','evidenceIds'] <> '{}'::jsonb
      OR jsonb_typeof(conflict_item->'kind') IS DISTINCT FROM 'string'
      OR conflict_item->>'kind' NOT IN ('RECORDED','AUTHORITY_DISAGREEMENT','HIGHER_AUTHORITY_CONTRADICTION')
      OR (conflict_item->>'kind'<>'RECORDED' AND conflict_item->'recordedConflictId' IS DISTINCT FROM 'null'::jsonb)
      OR jsonb_typeof(conflict_item->'versionIds') IS DISTINCT FROM 'array' OR jsonb_array_length(conflict_item->'versionIds')<2 THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(conflict_item->'versionIds') x WHERE NOT EXISTS
      (SELECT 1 FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid AND "versionId"=x::uuid)) THEN RETURN false; END IF;
    SELECT COALESCE(jsonb_agg("evidenceId"::text ORDER BY "evidenceId"),'[]'::jsonb) INTO actual_ids FROM public."ProjectFactVersion" WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(conflict_item->'versionIds'));
    IF actual_ids IS DISTINCT FROM conflict_item->'evidenceIds' THEN RETURN false; END IF;
  END LOOP;
  -- Validate selection and claims against the already bound immutable version
  -- assessments. Human attribution cannot satisfy an APPROVED selector.
  SELECT min((value->>'authorityTier')::integer) INTO selected_tier FROM jsonb_array_elements(result_versions)
    WHERE value->>'visibility'='available' AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb),COALESCE(bool_or(value->>'temporalApplicability'='AMBIGUOUS'),false)
    INTO selected_ids,has_ambiguity FROM jsonb_array_elements(result_versions)
    WHERE value->>'visibility'='available' AND (value->>'authorityTier')::integer=selected_tier AND value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM"]'::jsonb;
  SELECT CASE WHEN count(DISTINCT value->'value')>1 THEN selected_ids ELSE '[]'::jsonb END INTO disagreement_ids
    FROM jsonb_array_elements(result_versions) WHERE selected_ids @> jsonb_build_array(value->>'id');
  SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO higher_ids FROM (
    SELECT DISTINCT id FROM jsonb_array_elements(result_versions) human(value)
    CROSS JOIN jsonb_array_elements(result_versions) higher(value)
    CROSS JOIN LATERAL (VALUES (human.value->>'id'),(higher.value->>'id')) participants(id)
    WHERE selected_ids @> jsonb_build_array(human.value->>'id') AND human.value->>'provenance'='HUMAN_CONFIRMED'
      AND higher.value->>'visibility'='available' AND (higher.value->>'authorityTier')::integer<selected_tier
      AND higher.value->'eligibilityReasons' <@ '["AMBIGUOUS_STREAM","STALE","UNKNOWN_VALIDITY"]'::jsonb
      AND higher.value->'value' IS DISTINCT FROM human.value->'value'
  ) participants;
  FOR conflict_item IN SELECT value FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'<>'RECORDED' LOOP
    IF conflict_item->'versionIds' IS DISTINCT FROM (CASE WHEN conflict_item->>'kind'='AUTHORITY_DISAGREEMENT' THEN disagreement_ids ELSE higher_ids END) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(*) FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='AUTHORITY_DISAGREEMENT')<>(CASE WHEN jsonb_array_length(disagreement_ids)>0 THEN 1 ELSE 0 END)
    OR (SELECT count(*) FROM jsonb_array_elements(result_conflicts) WHERE value->>'kind'='HIGHER_AUTHORITY_CONTRADICTION')<>(CASE WHEN jsonb_array_length(higher_ids)>0 THEN 1 ELSE 0 END) THEN RETURN false; END IF;
  needs_revalidation := EXISTS (SELECT 1 FROM jsonb_array_elements(result_versions) WHERE value->>'visibility'='restricted');
  expected_status := CASE WHEN NOT a.complete THEN 'INCOMPLETE' WHEN needs_revalidation THEN 'REVALIDATION_REQUIRED'
    WHEN expected_policy='null'::jsonb THEN 'NO_POLICY' WHEN jsonb_array_length(result_conflicts)>0 THEN 'CONFLICTING'
    WHEN has_ambiguity THEN 'AMBIGUOUS' WHEN jsonb_array_length(selected_ids)>0 THEN 'RESOLVED' ELSE 'UNKNOWN' END;
  IF a.result->'selectedTier' IS DISTINCT FROM COALESCE(to_jsonb(selected_tier),'null'::jsonb)
    OR a.result->'candidateVersionIds' IS DISTINCT FROM selected_ids OR a.result->>'status' IS DISTINCT FROM expected_status
    OR a.result->'revalidationRequired' IS DISTINCT FROM to_jsonb(needs_revalidation)
    OR a.result->>'conflict' IS DISTINCT FROM (CASE WHEN jsonb_array_length(result_conflicts)>0 THEN 'CONFLICTING' ELSE 'NONE' END)
    OR a.result->'reconciliationRequired' IS DISTINCT FROM to_jsonb(jsonb_array_length(result_conflicts)>0 AND COALESCE(pol.state='ENABLED' AND pol.definition->>'conflictBehavior'='REQUEST_RECONCILIATION',false))
    THEN RETURN false; END IF;
  IF a.result->>'status'='RESOLVED' THEN
    IF a.result->'supportingVersionIds' IS DISTINCT FROM selected_ids THEN RETURN false; END IF;
    IF NOT a.complete OR jsonb_array_length(a.result->'supportingVersionIds')<1 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(a.result->'supportingVersionIds') LOOP
      IF NOT EXISTS (SELECT 1 FROM public."FactAssessmentVersion" av JOIN public."ProjectFactVersion" fv ON fv.id=av."versionId"
        WHERE av."assessmentId"=aid AND to_jsonb(fv.id)=item AND fv.value=a.result->'resolvedValue') THEN RETURN false; END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg("evidenceId"::text ORDER BY "evidenceId"),'[]'::jsonb) INTO actual_ids
      FROM public."ProjectFactVersion" WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(a.result->'supportingVersionIds'));
    IF a.result->'supportingEvidenceIds' IS DISTINCT FROM actual_ids THEN RETURN false; END IF;
  ELSIF a.result->'resolvedValue' IS DISTINCT FROM 'null'::jsonb OR a.result->'supportingVersionIds' IS DISTINCT FROM '[]'::jsonb
    OR a.result->'supportingEvidenceIds' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.result->'candidateVersionIds') x WHERE NOT EXISTS
    (SELECT 1 FROM public."FactAssessmentVersion" WHERE "assessmentId"=aid AND "versionId"=x::uuid)) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;
