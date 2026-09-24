import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  DatabaseConnectorRuntimeRepository,
  DatabaseIngestionRepository,
} from "../packages/data/src/index.js";
import { CredentialKeyRingVault, CredentialVault } from "../packages/platform/src/index.js";
import type { Actor } from "../packages/domain/src/index.js";

const url = process.env.PDAA_DATABASE_URL!;
if (!url || !/^\/pdaa_test_[0-9]+$/.test(new URL(url).pathname))
  throw new Error("Connector runtime tests require an isolated synthetic database");
const db = createDatabase(url);
const customerId = process.env.CUSTOMER_ID!;
const encryptionKey = Buffer.alloc(32, 29).toString("base64");
const ingestion = new DatabaseIngestionRepository(
  db,
  new CredentialVault(encryptionKey),
);
const keyRing = {
  currentKeyId: "integration-2026",
  keys: { "integration-2026": encryptionKey },
};
const runtime = new DatabaseConnectorRuntimeRepository(
  db,
  new CredentialKeyRingVault(keyRing),
);
afterAll(() => db.$disconnect());

function actor(role: Actor["roles"][number], subject: string): Actor {
  return { customerId, subject: `${subject}-${randomUUID()}`, roles: [role] };
}

describe("durable Jira connector runtime", () => {
  it("rotates credentials, prevents task replay and reconciles verified webhooks", async () => {
    const portfolioId = randomUUID();
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const pmo = actor("pmo_admin", "runtime-pmo");
    const manager = actor("project_manager", "runtime-pm");
    await db.portfolio.create({
      data: { id: portfolioId, customerId, name: "Connector runtime fixture" },
    });
    await db.project.create({
      data: {
        id: projectId,
        customerId,
        portfolioId,
        code: `JRT-${projectId.slice(0, 8).toUpperCase()}`,
        name: "Connector runtime fixture",
        description: "Synthetic Jira runtime record",
        reportedStatus: "UNKNOWN",
      },
    });
    for (const grant of [
      { subject: pmo.subject, role: "pmo_admin" },
      { subject: manager.subject, role: "project_manager" },
    ] as const)
      await db.accessGrant.create({
        data: {
          customerId,
          subject: grant.subject,
          scopeType: "project",
          scopeId: projectId,
          role: grant.role,
        },
      });

    const binding = {
      customerId,
      sourceId,
      sourceType: "jira",
      origin: "https://tenant.atlassian.net",
    };
    await ingestion.configure(
      pmo,
      {
        binding,
        projects: [{ projectId, readers: [manager.subject] }],
        mapping: {
          kind: "CONNECTOR",
          factTypes: ["jira.status"],
          adapterConfiguration: JSON.stringify({
            projects: [{ projectId, projectKey: "SAFE" }],
            fields: [
              { jiraField: "status", factType: "jira.status", valueType: "text" },
            ],
          }),
        },
      },
      "connector-runtime-configure",
    );

    const now = new Date();
    const shortExpiry = new Date(now.getTime() + 30_000).toISOString();
    const credential = {
      cloudId: "cloud-1",
      selectedUrl: binding.origin,
      accessToken: "initial-access-token",
      refreshToken: "initial-refresh-token",
      expiresAt: shortExpiry,
      scopes: ["read:jira-work", "offline_access"],
    };
    await runtime.setOAuthCredential({ customerId, sourceId, actorSubject: pmo.subject, credential });
    const webhookSecret = Buffer.alloc(32, 61).toString("hex");
    await runtime.setWebhookSecret({ customerId, sourceId, actorSubject: pmo.subject, secret: webhookSecret });

    const rotation = await runtime.accessOrBeginRotation(customerId, sourceId, now);
    expect(rotation.kind).toBe("rotate");
    if (rotation.kind !== "rotate") throw new Error("Expected refresh lease");
    expect(await runtime.accessOrBeginRotation(customerId, sourceId, now)).toMatchObject({
      kind: "unavailable",
      reason: "ROTATION_IN_PROGRESS",
    });
    const renewed = {
      ...credential,
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    expect(await runtime.completeOAuthRotation(rotation.rotation, renewed, now)).toMatchObject({ committed: true });
    expect(await runtime.completeOAuthRotation(rotation.rotation, renewed, now)).toMatchObject({ committed: false, reason: "FENCED" });
    expect(await runtime.accessOrBeginRotation(customerId, sourceId, now)).toMatchObject({ kind: "access" });

    const nonce = randomUUID();
    const requestBody = Buffer.from("{}", "utf8");
    const timestampSeconds = String(Math.floor(now.getTime() / 1000));
    const nonceReceipt = { nonce, keyId: keyRing.currentKeyId, timestampSeconds, body: requestBody };
    expect(await runtime.acceptTaskNonce(nonceReceipt, now)).toBe(true);
    expect(await runtime.acceptTaskNonce(nonceReceipt, now)).toBe(false);

    const scheduledIds = await runtime.enqueueDueJobs(customerId, 15, 20, now);
    expect(scheduledIds).toHaveLength(1);
    const scheduled = await runtime.claimNextJob(customerId, now);
    expect(scheduled?.jobId).toBe(scheduledIds[0]);
    if (!scheduled) throw new Error("Expected scheduled runtime job");
    expect((await ingestion.readConnectorSyncSnapshot(customerId, scheduled.jobId, scheduled.claimGeneration, now)).resetRequired).toBe(true);
    await ingestion.resetConnectorCursorForJob(customerId, scheduled.jobId, scheduled.claimGeneration, now);

    const eventId = `event-${randomUUID()}`;
    const rawBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated" }));
    const signature = "sha256=" + createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    const webhook = await runtime.acceptWebhook({
      sourceId,
      eventId,
      signature,
      rawBody,
      now,
    });
    expect(webhook.replayed).toBe(false);
    const duplicate = await runtime.acceptWebhook({
      sourceId,
      eventId,
      signature,
      rawBody,
      now,
    });
    expect(duplicate).toMatchObject({ receiptId: webhook.receiptId, jobId: webhook.jobId, replayed: true });
    await expect(
      runtime.acceptWebhook({
        sourceId,
        eventId,
        signature: "sha256=" + createHmac("sha256", webhookSecret).update(Buffer.from("different payload")).digest("hex"),
        rawBody: Buffer.from("different payload"),
        now,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const webhookJob = await runtime.claimNextJob(customerId, now);
    expect(webhookJob?.jobId).toBe(webhook.jobId);
    if (!webhookJob) throw new Error("Expected webhook reconciliation job");
    const reclaimedAt = new Date(now.getTime() + 61_000);
    const reclaimedWebhookJob = await runtime.claimNextJob(customerId, reclaimedAt);
    expect(reclaimedWebhookJob?.jobId).toBe(webhook.jobId);
    if (!reclaimedWebhookJob) throw new Error("Expected expired webhook job to be reclaimed");
    expect(reclaimedWebhookJob.claimGeneration).toBe(webhookJob.claimGeneration + 1);
    await expect(
      runtime.failRunningJob({
        customerId,
        jobId: webhookJob.jobId,
        claimGeneration: webhookJob.claimGeneration,
        code: "INVALID_RESPONSE",
      }, reclaimedAt),
    ).resolves.toMatchObject({ state: "STALE_CLAIM" });
    await expect(
      ingestion.readConnectorSyncSnapshot(customerId, webhookJob.jobId, webhookJob.claimGeneration, reclaimedAt),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const resetSnapshot = await ingestion.readConnectorSyncSnapshot(customerId, reclaimedWebhookJob.jobId, reclaimedWebhookJob.claimGeneration, reclaimedAt);
    expect(resetSnapshot.resetRequired).toBe(true);
    await ingestion.resetConnectorCursorForJob(customerId, reclaimedWebhookJob.jobId, reclaimedWebhookJob.claimGeneration, reclaimedAt);
    const readyJob = await runtime.claimNextJob(customerId, reclaimedAt);
    expect(readyJob?.jobId).toBe(webhook.jobId);
    if (!readyJob) throw new Error("Expected reset webhook job");
    const snapshot = await ingestion.readConnectorSyncSnapshot(customerId, readyJob.jobId, readyJob.claimGeneration, reclaimedAt);
    expect(snapshot.resetRequired).toBe(false);
    const page = {
      binding: snapshot.configuration.binding,
      inputCursor: null,
      nextCursor: null,
      terminal: true,
      records: [],
    };
    const finalReclaimedAt = new Date(reclaimedAt.getTime() + 61_000);
    const finalJob = await runtime.claimNextJob(customerId, finalReclaimedAt);
    expect(finalJob?.jobId).toBe(webhook.jobId);
    if (!finalJob) throw new Error("Expected expired page job to be reclaimed");
    expect(finalJob.claimGeneration).toBe(readyJob.claimGeneration + 1);
    await expect(ingestion.persistConnectorPageForJob({
      customerId,
      jobId: readyJob.jobId,
      expectedClaimGeneration: readyJob.claimGeneration,
      expectedConfigRevision: snapshot.configRevision,
      expectedMappingRevision: snapshot.mappingRevision,
      expectedCursorRevision: snapshot.cursorRevision,
      expectedGeneration: snapshot.generation,
      page,
    }, finalReclaimedAt)).rejects.toMatchObject({ code: "CONFLICT" });
    const finalSnapshot = await ingestion.readConnectorSyncSnapshot(customerId, finalJob.jobId, finalJob.claimGeneration, finalReclaimedAt);
    const committed = await ingestion.persistConnectorPageForJob({
      customerId,
      jobId: finalJob.jobId,
      expectedClaimGeneration: finalJob.claimGeneration,
      expectedConfigRevision: finalSnapshot.configRevision,
      expectedMappingRevision: finalSnapshot.mappingRevision,
      expectedCursorRevision: finalSnapshot.cursorRevision,
      expectedGeneration: finalSnapshot.generation,
      page,
    }, finalReclaimedAt);
    expect(committed.terminal).toBe(true);
    const persistedJob = await db.$queryRaw<{ state: string; completedAt: Date | null }[]>`
      SELECT state,"completedAt" FROM public."ConnectorSyncJob" WHERE id=${readyJob.jobId}::uuid`;
    expect(persistedJob[0]).toMatchObject({ state: "COMPLETED" });
    expect(persistedJob[0]!.completedAt).toBeInstanceOf(Date);
  });
});
