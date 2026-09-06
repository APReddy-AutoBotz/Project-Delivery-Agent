-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "portfolioId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reportedStatus" TEXT NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" UUID NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorCredential" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ConnectorCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceHeartbeat" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Portfolio_customerId_id_key" ON "Portfolio"("customerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Project_customerId_code_key" ON "Project"("customerId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Project_customerId_id_key" ON "Project"("customerId", "id");

-- CreateIndex
CREATE INDEX "AccessGrant_customerId_subject_idx" ON "AccessGrant"("customerId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "AccessGrant_customerId_subject_scopeType_scopeId_key" ON "AccessGrant"("customerId", "subject", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "AuditEvent_customerId_occurredAt_idx" ON "AuditEvent"("customerId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Portfolio" ADD CONSTRAINT "Portfolio_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_customerId_portfolioId_fkey" FOREIGN KEY ("customerId", "portfolioId") REFERENCES "Portfolio"("customerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- NFR-SEC-004: application audit rows are append-only, including after restore.
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are immutable';
END;
$$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON "AuditEvent"
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_scopeType_check" CHECK ("scopeType" IN ('project', 'portfolio'));
ALTER TABLE "AccessGrant" ADD CONSTRAINT "AccessGrant_role_check" CHECK ("role" IN ('leadership', 'project_manager', 'contributor', 'pmo_admin', 'system_admin'));
ALTER TABLE "ConnectorCredential" ADD CONSTRAINT "ConnectorCredential_envelope_check" CHECK ("envelope" LIKE 'v1.%' AND "revision" > 0);
