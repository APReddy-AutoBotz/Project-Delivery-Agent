import { createHmac, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  DatabaseConnectorRuntimeRepository,
  DatabaseIngestionRepository,
} from "../packages/data/src/index.js";
import { CredentialKeyRingVault, CredentialVault } from "../packages/platform/src/index.js";
import type { Actor } from "../packages/domain/src/index.js";
import { JiraRuntimeService } from "../apps/api/src/jira-runtime.js";

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
const integrationLeaseDurationSeconds = 5;
const runtime = new DatabaseConnectorRuntimeRepository(
  db,
  new CredentialKeyRingVault(keyRing),
  integrationLeaseDurationSeconds,
);
afterAll(() => db.$disconnect());

async function waitForLeaseExpiry() {
  // Verify expiry against the database clock without waiting for the production lease duration.
  await new Promise<void>((resolve) => setTimeout(resolve, integrationLeaseDurationSeconds * 1000 + 500));
  return new Date();
}

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

    const applicationClockAhead = new Date(Date.now() + 5 * 60_000);
    const concurrentRotations = await Promise.all([
      runtime.accessOrBeginRotation(customerId, sourceId, applicationClockAhead),
      runtime.accessOrBeginRotation(customerId, sourceId, applicationClockAhead),
    ]);
    const rotation = concurrentRotations.find((result) => result.kind === "rotate");
    expect(concurrentRotations.filter((result) => result.kind === "rotate")).toHaveLength(1);
    expect(
      concurrentRotations.filter(
        (result) => result.kind === "unavailable" && result.reason === "ROTATION_IN_PROGRESS",
      ),
    ).toHaveLength(1);
    if (!rotation || rotation.kind !== "rotate") throw new Error("Expected one refresh lease");
    const renewed = {
      ...credential,
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    expect(await runtime.completeOAuthRotation(rotation.rotation, renewed, applicationClockAhead)).toMatchObject({ committed: true });
    expect(await runtime.completeOAuthRotation(rotation.rotation, renewed, now)).toMatchObject({ committed: false, reason: "FENCED" });
    // A fresh database client and repository must read the atomically persisted rotated tokens.
    const reloadedDb = createDatabase(url);
    try {
      const reloadedRuntime = new DatabaseConnectorRuntimeRepository(
        reloadedDb,
        new CredentialKeyRingVault(keyRing),
        integrationLeaseDurationSeconds,
      );
      expect(await reloadedRuntime.accessOrBeginRotation(customerId, sourceId, now)).toMatchObject({
        kind: "access",
        credentials: {
          accessToken: "rotated-access-token",
          refreshToken: "rotated-refresh-token",
        },
      });
    } finally {
      await reloadedDb.$disconnect();
    }
    expect(await runtime.accessOrBeginRotation(customerId, sourceId, now)).toMatchObject({ kind: "access" });

    const nonce = randomUUID();
    const requestBody = Buffer.from("{}", "utf8");
    const timestampSeconds = String(Math.floor(now.getTime() / 1000));
    const nonceReceipt = { nonce, keyId: keyRing.currentKeyId, timestampSeconds, body: requestBody };
    expect(await runtime.acceptTaskNonce(nonceReceipt, now)).toBe(true);
    expect(await runtime.acceptTaskNonce(nonceReceipt, now)).toBe(false);

    const scheduledIds = await runtime.enqueueDueJobs(customerId, 15, 20, now);
    expect(scheduledIds).toHaveLength(1);
    const scheduled = await runtime.claimNextJob(customerId);
    expect(scheduled?.jobId).toBe(scheduledIds[0]);
    if (!scheduled) throw new Error("Expected scheduled runtime job");
    expect((await ingestion.readConnectorSyncSnapshot(customerId, scheduled.jobId, scheduled.claimGeneration, now)).resetRequired).toBe(true);
    await ingestion.resetConnectorCursorForJob(customerId, scheduled.jobId, scheduled.claimGeneration, now);

    const eventId = `event-${randomUUID()}`;
    const rawBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated", timestamp: now.getTime() }));
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
    const conflictingBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_created" }));
    await expect(
      runtime.acceptWebhook({
        sourceId,
        eventId,
        signature: "sha256=" + createHmac("sha256", webhookSecret).update(conflictingBody).digest("hex"),
        rawBody: conflictingBody,
        now,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const webhookJob = await runtime.claimNextJob(customerId);
    expect(webhookJob?.jobId).toBe(webhook.jobId);
    if (!webhookJob) throw new Error("Expected webhook reconciliation job");
    const reclaimedAt = await waitForLeaseExpiry();
    const reclaimedWebhookJob = await runtime.claimNextJob(customerId);
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
    const readyJob = await runtime.claimNextJob(customerId);
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
    const finalReclaimedAt = await waitForLeaseExpiry();
    const finalJob = await runtime.claimNextJob(customerId);
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
    const replayWithChangedDeliveryId = await runtime.acceptWebhook({
      sourceId,
      eventId: `changed-${eventId}`,
      signature,
      rawBody,
      now: new Date(finalReclaimedAt.getTime() + 1000),
    });
    expect(replayWithChangedDeliveryId).toMatchObject({
      receiptId: webhook.receiptId,
      jobId: webhook.jobId,
      replayed: true,
    });

    await runtime.setOAuthCredential({
      customerId,
      sourceId,
      actorSubject: pmo.subject,
      credential: {
        ...renewed,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const rateLimitedBody = Buffer.from(JSON.stringify({ webhookEvent: "jira:issue_updated" }));
    const rateLimitedWebhook = await runtime.acceptWebhook({
      sourceId,
      eventId: `rate-limit-${randomUUID()}`,
      signature: "sha256=" + createHmac("sha256", webhookSecret).update(rateLimitedBody).digest("hex"),
      rawBody: rateLimitedBody,
    });
    let rateLimitedJob = await runtime.claimNextJob(customerId);
    expect(rateLimitedJob?.jobId).toBe(rateLimitedWebhook.jobId);
    if (!rateLimitedJob) throw new Error("Expected rate-limited job claim");
    const retryableRotation = await runtime.accessOrBeginRotation(customerId, sourceId);
    expect(retryableRotation.kind).toBe("rotate");
    if (retryableRotation.kind !== "rotate") throw new Error("Expected retryable refresh lease");
    expect(await runtime.deferOAuthRotation(retryableRotation.rotation, {
      jobId: rateLimitedJob.jobId,
      claimGeneration: rateLimitedJob.claimGeneration,
      retryAfterMs: 2000,
    })).toBe(true);
    const deferredState = await db.$queryRaw<{ state: string; availableAt: Date; credentialState: string }[]>`
      SELECT j.state,j."availableAt",c.state AS "credentialState"
      FROM public."ConnectorSyncJob" j
      JOIN public."ConnectorCredential" c ON c."customerId"=j."customerId" AND c."sourceId"=j."sourceId" AND c.purpose='jira_oauth'
      WHERE j."customerId"=${customerId}::uuid AND j.id=${rateLimitedJob.jobId}::uuid`;
    expect(deferredState[0]?.state).toBe("READY");
    expect(deferredState[0]?.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(deferredState[0]?.credentialState).toBe("ACTIVE");
    // Simulate a crash after the atomic OAuth/job transaction and before any worker follow-up.
    expect(await runtime.claimNextJob(customerId)).toBeNull();
    await new Promise<void>((resolve) => setTimeout(resolve, 2100));
    rateLimitedJob = await runtime.claimNextJob(customerId);
    expect(rateLimitedJob?.jobId).toBe(rateLimitedWebhook.jobId);
    expect(rateLimitedJob?.claimGeneration).toBe(2);
    for (let attempt = 2; attempt <= 5; attempt++) {
      if (!rateLimitedJob) throw new Error("Expected rate-limited job claim");
      const failure = await runtime.failRunningJob({
        customerId,
        jobId: rateLimitedJob.jobId,
        claimGeneration: rateLimitedJob.claimGeneration,
        code: "RATE_LIMITED",
        retryAfterMs: attempt === 5 ? 86_400_000 : 0,
      });
      expect(failure.state).toBe(attempt < 5 ? "READY" : "FAILED");
      if (attempt < 5) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1) + 100));
        rateLimitedJob = await runtime.claimNextJob(customerId);
        expect(rateLimitedJob?.jobId).toBe(rateLimitedWebhook.jobId);
      }
    }
    expect(await runtime.enqueueDueJobs(
      customerId,
      15,
      20,
      new Date(Date.now() + 16 * 60_000),
    )).toEqual([]);
    const deferredBody = Buffer.from(JSON.stringify({
      webhookEvent: "jira:issue_updated",
      timestamp: Date.now(),
      issue: { id: `fence-probe-${randomUUID()}` },
    }));
    const deferredWebhook = await runtime.acceptWebhook({
      sourceId,
      eventId: `deferred-${randomUUID()}`,
      signature: "sha256=" + createHmac("sha256", webhookSecret).update(deferredBody).digest("hex"),
      rawBody: deferredBody,
    });
    expect(deferredWebhook.replayed).toBe(false);
    expect(await runtime.claimNextJob(customerId)).toBeNull();
  }, 60_000);

  it("runs a scheduled Jira read without a webhook and persists the returned issue and cursor", async () => {
    const isolatedCustomerId = randomUUID();
    const portfolioId = randomUUID();
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const pmo: Actor = {
      customerId: isolatedCustomerId,
      subject: "reconciliation-pmo-" + randomUUID(),
      roles: ["pmo_admin"],
    };
    const manager: Actor = {
      customerId: isolatedCustomerId,
      subject: "reconciliation-manager-" + randomUUID(),
      roles: ["project_manager"],
    };
    await db.customer.create({
      data: { id: isolatedCustomerId, name: "Synthetic Jira reconciliation fixture" },
    });
    await db.portfolio.create({
      data: { id: portfolioId, customerId: isolatedCustomerId, name: "Reconciliation fixture" },
    });
    await db.project.create({
      data: {
        id: projectId,
        customerId: isolatedCustomerId,
        portfolioId,
        code: "JR-" + projectId.slice(0, 8).toUpperCase(),
        name: "Jira reconciliation fixture",
        description: "Synthetic Jira source for scheduled recovery",
        reportedStatus: "UNKNOWN",
      },
    });
    for (const grant of [
      { subject: pmo.subject, role: "pmo_admin" },
      { subject: manager.subject, role: "project_manager" },
    ] as const) {
      await db.accessGrant.create({
        data: {
          customerId: isolatedCustomerId,
          subject: grant.subject,
          scopeType: "project",
          scopeId: projectId,
          role: grant.role,
        },
      });
    }

    const binding = {
      customerId: isolatedCustomerId,
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
      "scheduled-reconciliation-configure-" + sourceId,
    );
    await runtime.setOAuthCredential({
      customerId: isolatedCustomerId,
      sourceId,
      actorSubject: pmo.subject,
      credential: {
        cloudId: "cloud-1",
        selectedUrl: binding.origin,
        accessToken: "synthetic-reconciliation-access",
        refreshToken: "synthetic-reconciliation-refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ["read:jira-work", "offline_access"],
      },
    });

    const observedAt = "2026-09-26T03:00:00.000Z";
    const searchCalls: { jql: string; fields: string[] }[] = [];
    const jiraClient = {
      searchIssues: async (input: { jql: string; fields: string[] }) => {
        searchCalls.push({ jql: input.jql, fields: input.fields });
        return {
          issues: [
            {
              id: "95001",
              key: "SAFE-77",
              fields: {
                project: { id: "950", key: "SAFE" },
                updated: observedAt,
                status: { name: "In Progress" },
              },
            },
          ],
          isLast: true,
        } as never;
      },
    };
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify([
          {
            id: "cloud-1",
            url: binding.origin,
            scopes: ["read:jira-work"],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const service = new JiraRuntimeService(
      { CUSTOMER_ID: isolatedCustomerId } as never,
      runtime,
      ingestion,
      fetchImpl,
      () => jiraClient as never,
    );

    // A scheduled pass starts with a fenced reset, then reads Jira independently of webhook payloads.
    await expect(service.runOne()).resolves.toEqual({ status: "cursor_reset" });
    await expect(service.runOne()).resolves.toEqual({ status: "page_committed" });

    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]?.jql).toContain('"SAFE"');
    expect(searchCalls[0]?.fields).toContain("status");
    expect(
      await db.connectorWebhookReceipt.count({
        where: { customerId: isolatedCustomerId, sourceId },
      }),
    ).toBe(0);

    const job = await db.connectorSyncJob.findFirstOrThrow({
      where: { customerId: isolatedCustomerId, sourceId },
    });
    expect(job).toMatchObject({ kind: "SCHEDULED", state: "COMPLETED" });
    expect(job.completedAt).toBeInstanceOf(Date);
    const record = await db.ingestionExternalRecord.findFirstOrThrow({
      where: {
        customerId: isolatedCustomerId,
        sourceId,
        recordType: "jira.issue",
        recordKey: "SAFE-77",
      },
    });
    const revision = await db.ingestionSourceRevision.findFirstOrThrow({
      where: { customerId: isolatedCustomerId, sourceId, recordId: record.id },
    });
    expect(revision.revision).toBe(observedAt);
    const projection = await db.ingestionProposalProjection.findFirstOrThrow({
      where: { customerId: isolatedCustomerId, sourceId, recordId: record.id },
    });
    const content = await db.ingestionProposalContent.findUniqueOrThrow({
      where: { projectionId: projection.id },
    });
    expect(content.proposals).toMatchObject([
      { factType: "jira.status", value: { type: "text", value: "In Progress" } },
    ]);
    const receipt = await db.ingestionOperationReceipt.findFirstOrThrow({
      where: {
        customerId: isolatedCustomerId,
        sourceId,
        syncJobId: job.id,
        kind: "CONNECTOR_PAGE",
      },
    });
    expect(receipt.outcomeCount).toBe(1);
    expect(receipt.cursorRevisionAfter).toBeGreaterThan(0n);
    const sourceState = await db.ingestionSource.findFirstOrThrow({
      where: {
        customerId_id: { customerId: isolatedCustomerId, id: sourceId },
      },
    });
    expect(sourceState.cursorState).toBe("TERMINAL");
    expect(sourceState.cursorRevision).toBeGreaterThan(0n);
  }, 30_000);

});
