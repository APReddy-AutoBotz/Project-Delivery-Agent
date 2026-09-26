import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
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

const execFileAsync = promisify(execFile);

async function runOAuthRestartProbe(input: {
  customerId: string;
  sourceId: string;
  mode: "lease" | "rotated";
  accessToken?: string;
  refreshToken?: string;
}) {
  const probe = [
    'import { resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const root = process.env.PDAA_RESTART_ROOT;',
    'const data = await import(pathToFileURL(resolve(root, "packages/data/dist/index.js")).href);',
    'const platform = await import(pathToFileURL(resolve(root, "packages/platform/dist/index.js")).href);',
    'const keyId = process.env.PDAA_RESTART_KEY_ID;',
    'const db = data.createDatabase(process.env.PDAA_DATABASE_URL);',
    'try {',
    '  const runtime = new data.DatabaseConnectorRuntimeRepository(db, new platform.CredentialKeyRingVault({ currentKeyId: keyId, keys: { [keyId]: process.env.PDAA_RESTART_KEY } }), 5);',
    '  const access = await runtime.accessOrBeginRotation(process.env.PDAA_RESTART_CUSTOMER_ID, process.env.PDAA_RESTART_SOURCE_ID);',
    '  if (process.env.PDAA_RESTART_MODE === "lease") {',
    '    if (access.kind !== "unavailable" || access.reason !== "ROTATION_IN_PROGRESS") throw new Error("durable lease probe failed");',
    '  } else if (access.kind !== "access" || access.credentials.accessToken !== process.env.PDAA_RESTART_ACCESS || access.credentials.refreshToken !== process.env.PDAA_RESTART_REFRESH) {',
    '    throw new Error("rotated credential probe failed");',
    '  }',
    '  console.log("connector-restart-probe:ok");',
    '} finally {',
    '  await db.$disconnect();',
    '}',
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", probe],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PDAA_DATABASE_URL: url,
        PDAA_RESTART_ROOT: process.cwd(),
        PDAA_RESTART_CUSTOMER_ID: input.customerId,
        PDAA_RESTART_SOURCE_ID: input.sourceId,
        PDAA_RESTART_MODE: input.mode,
        PDAA_RESTART_KEY_ID: keyRing.currentKeyId,
        PDAA_RESTART_KEY: encryptionKey,
        PDAA_RESTART_ACCESS: input.accessToken ?? "",
        PDAA_RESTART_REFRESH: input.refreshToken ?? "",
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  expect(stdout.trim()).toBe("connector-restart-probe:ok");
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
    const configuredCredential = await runtime.setOAuthCredential({ customerId, sourceId, actorSubject: pmo.subject, credential });
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
    // A separate Node process must observe the database-backed lease and cannot
    // start a competing refresh while the original operation owns it.
    await runOAuthRestartProbe({ customerId, sourceId, mode: "lease" });
    const renewed = {
      ...credential,
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    };
    expect(await runtime.completeOAuthRotation(rotation.rotation, renewed, applicationClockAhead)).toMatchObject({ committed: true });
    expect(await runtime.completeOAuthRotation(rotation.rotation, renewed, now)).toMatchObject({ committed: false, reason: "FENCED" });
    const persistedRotation = await db.connectorCredential.findFirstOrThrow({
      where: { customerId, sourceId, purpose: "jira_oauth" },
      select: {
        revision: true,
        state: true,
        rotationOperationId: true,
        rotationDeadline: true,
        envelope: true,
      },
    });
    expect(persistedRotation).toMatchObject({
      revision: configuredCredential.revision + 2,
      state: "ACTIVE",
      rotationOperationId: null,
      rotationDeadline: null,
    });
    expect(persistedRotation.envelope).not.toContain("rotated-access-token");
    expect(persistedRotation.envelope).not.toContain("rotated-refresh-token");

    // Start a fresh Node process after the transaction commits. It must decrypt
    // the committed tokens from the database rather than rely on process memory.
    await runOAuthRestartProbe({
      customerId,
      sourceId,
      mode: "rotated",
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
    });
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
      records: [
        {
          ref: { customerId, sourceId, projectId, recordType: "jira.issue", recordId: "SAFE-77" },
          revision: now.toISOString(),
          sourceContentHash: "a".repeat(64),
          observedAt: now.toISOString(),
          effectiveAt: now.toISOString(),
          deepLink: "https://tenant.atlassian.net/browse/SAFE-77",
          observations: [{ factType: "jira.status", value: { type: "text", value: "In Progress" } }],
        },
      ],
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

    const [
      externalRecords,
      sourceRevisions,
      proposalProjections,
      pageReceipts,
      rowOutcomes,
      webhookReceipts,
      webhookJobs,
    ] = await Promise.all([
      db.ingestionExternalRecord.count({
        where: { customerId, sourceId, recordType: "jira.issue", recordKey: "SAFE-77" },
      }),
      db.ingestionSourceRevision.count({ where: { customerId, sourceId } }),
      db.ingestionProposalProjection.count({ where: { customerId, sourceId } }),
      db.ingestionOperationReceipt.count({
        where: { customerId, sourceId, executionMode: "CONNECTOR_SYNC", kind: "CONNECTOR_PAGE" },
      }),
      db.ingestionRowOutcome.count({
        where: { customerId, sourceId, recordKey: "SAFE-77" },
      }),
      db.connectorWebhookReceipt.count({ where: { customerId, sourceId } }),
      db.connectorSyncJob.count({ where: { customerId, sourceId, kind: "WEBHOOK" } }),
    ]);
    expect({
      externalRecords,
      sourceRevisions,
      proposalProjections,
      pageReceipts,
      rowOutcomes,
      webhookReceipts,
      webhookJobs,
    }).toEqual({
      externalRecords: 1,
      sourceRevisions: 1,
      proposalProjections: 1,
      pageReceipts: 1,
      rowOutcomes: 1,
      webhookReceipts: 1,
      webhookJobs: 1,
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

  it("recovers a missed Jira update and exposes safe health detail to an authorized administrator", async () => {
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
    const systemAdmin: Actor = {
      customerId: isolatedCustomerId,
      subject: "reconciliation-system-admin-" + randomUUID(),
      roles: ["system_admin"],
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
      { subject: systemAdmin.subject, role: "system_admin" },
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

    await ingestion.setRetention(
      systemAdmin,
      { retentionHours: 24 },
      "scheduled-reconciliation-retention-" + sourceId,
    );

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
        projects: [{ projectId, readers: [manager.subject, pmo.subject] }],
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

    const initialObservedAt = "2026-09-25T03:00:00.000Z";
    const recoveredObservedAt = "2026-09-26T03:00:00.000Z";
    let currentObservedAt = initialObservedAt;
    let currentStatus = "To Do";
    let failSearchWithSecret = false;
    let scheduledAt = new Date(Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000) - 1_000);
    const searchCalls: { jql: string; fields: string[] }[] = [];
    const jiraClient = {
      getProject: async ({ projectIdOrKey }: { projectIdOrKey: string }) => ({
        key: projectIdOrKey,
      }),
      searchIssues: async (input: { jql: string; fields: string[] }) => {
        searchCalls.push({ jql: input.jql, fields: input.fields });
        if (failSearchWithSecret) throw new Error("socket closed; synthetic-secret-token");
        return {
          issues: [
            {
              id: "95001",
              key: "SAFE-77",
              fields: {
                project: { id: "950", key: "SAFE" },
                updated: currentObservedAt,
                status: { name: currentStatus },
              },
            },
          ],
          isLast: true,
        } as never;
      },
    };
    let resourceLookups = 0;
    const fetchImpl: typeof fetch = async () => {
      resourceLookups++;
      return new Response(
        JSON.stringify([
          {
            id: "cloud-1",
            url: binding.origin,
            scopes: ["read:jira-work"],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    let jiraClientCreated = false;
    const observedFailures: string[] = [];
    const observedRuntime = new Proxy(runtime, {
      get(target, property) {
        if (property === "enqueueDueJobs") {
          return (
            customerId: string,
            intervalMinutes?: number,
            limit?: number,
          ) => runtime.enqueueDueJobs(customerId, intervalMinutes, limit, scheduledAt);
        }
        if (property === "failRunningJob") {
          return async (input: Parameters<typeof runtime.failRunningJob>[0]) => {
            observedFailures.push(input.code);
            return runtime.failRunningJob(input);
          };
        }
        if (property === "deferOAuthRotation") {
          return async (...args: Parameters<typeof runtime.deferOAuthRotation>) => {
            observedFailures.push("OAUTH_ROTATION_DEFERRED");
            return runtime.deferOAuthRotation(...args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let pagePersistenceReached = false;
    let pagePersistenceError = "none";
    const observedIngestion = new Proxy(ingestion, {
      get(target, property) {
        if (property === "persistConnectorPageForJob") {
          return async (...args: Parameters<typeof ingestion.persistConnectorPageForJob>) => {
            pagePersistenceReached = true;
            try {
              return await ingestion.persistConnectorPageForJob(...args);
            } catch (error) {
              pagePersistenceError =
                error instanceof Error
                  ? `${error.name}/${"code" in error ? String(error.code) : "NO_CODE"}`
                  : "NON_ERROR";
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new JiraRuntimeService(
      { CUSTOMER_ID: isolatedCustomerId } as never,
      observedRuntime,
      observedIngestion,
      fetchImpl,
      () => {
        jiraClientCreated = true;
        return jiraClient as never;
      },
    );

    // A scheduled pass starts with a fenced reset, then reads Jira independently of webhook payloads.
    await expect(service.runOne()).resolves.toEqual({ status: "cursor_reset" });
    const scheduledResult = await service.runOne();
    if (scheduledResult.status === "deferred")
      throw new Error(`Scheduled Jira reconciliation deferred: ${observedFailures.join(", ") || "no runtime failure code recorded"}; resourceLookups=${resourceLookups}; jiraClientCreated=${jiraClientCreated}; searches=${searchCalls.length}; pagePersistenceReached=${pagePersistenceReached}; pagePersistenceError=${pagePersistenceError}`);
    expect(scheduledResult).toEqual({ status: "page_committed" });

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
    expect(revision.revision).toBe(initialObservedAt);
    const projection = await db.ingestionProposalProjection.findFirstOrThrow({
      where: { customerId: isolatedCustomerId, sourceId, recordId: record.id },
    });
    const content = await db.ingestionProposalContent.findUniqueOrThrow({
      where: { projectionId: projection.id },
    });
    expect(content.proposals).toMatchObject([
      { factType: "jira.status", value: { type: "text", value: "To Do" } },
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
      where: { customerId: isolatedCustomerId, id: sourceId },
    });
    expect(sourceState.cursorState).toBe("TERMINAL");
    expect(sourceState.cursorRevision).toBeGreaterThan(0n);

    const recordHealthyAt = async (checkedAt: Date) => {
      const restoreTime = new Date();
      vi.setSystemTime(checkedAt);
      try {
        await ingestion.recordHealth(
          pmo,
          sourceId,
          "HEALTHY",
          "NONE",
          "scheduled-health-" + randomUUID(),
        );
      } finally {
        vi.setSystemTime(restoreTime);
      }
    };

    // No webhook is accepted for the changed issue. A later scheduled pass must
    // discover it and persist a second source revision and proposal projection.
    scheduledAt = new Date(scheduledAt.getTime() - 15 * 60_000);
    await recordHealthyAt(new Date(scheduledAt.getTime() - 16 * 60_000));
    currentObservedAt = recoveredObservedAt;
    currentStatus = "In Progress";
    await expect(service.runOne()).resolves.toEqual({ status: "cursor_reset" });
    await expect(service.runOne()).resolves.toEqual({ status: "page_committed" });
    expect(searchCalls).toHaveLength(2);
    expect(await db.connectorWebhookReceipt.count({ where: { customerId: isolatedCustomerId, sourceId } })).toBe(0);

    const recoveredRevisions = await db.ingestionSourceRevision.findMany({
      where: { customerId: isolatedCustomerId, sourceId },
    });
    expect(recoveredRevisions.map((item) => item.revision).sort()).toEqual(
      [initialObservedAt, recoveredObservedAt].sort(),
    );
    const recoveredProjections = await db.ingestionProposalProjection.findMany({
      where: { customerId: isolatedCustomerId, sourceId },
    });
    expect(recoveredProjections).toHaveLength(2);
    const recoveredContent = await Promise.all(
      recoveredProjections.map((item) =>
        db.ingestionProposalContent.findUniqueOrThrow({ where: { projectionId: item.id } }),
      ),
    );
    const persistedProposals = JSON.stringify(recoveredContent.map((item) => item.proposals));
    expect(persistedProposals).toContain('"value":"To Do"');
    expect(persistedProposals).toContain('"value":"In Progress"');
    expect(
      await db.ingestionOperationReceipt.count({
        where: {
          customerId: isolatedCustomerId,
          sourceId,
          executionMode: "CONNECTOR_SYNC",
          kind: "CONNECTOR_PAGE",
        },
      }),
    ).toBe(2);

    const recoveredSource = await db.ingestionSource.findFirstOrThrow({
      where: { customerId: isolatedCustomerId, id: sourceId },
    });
    expect(recoveredSource.cursorState).toBe("TERMINAL");
    expect(recoveredSource.cursorRevision).toBeGreaterThan(sourceState.cursorRevision);

    // A third scheduled pass fails with a secret-bearing synthetic transport
    // exception. Only finite health state/code/timestamp reach the authorized
    // administrator-facing source summary.
    scheduledAt = new Date(scheduledAt.getTime() - 15 * 60_000);
    await recordHealthyAt(new Date(scheduledAt.getTime() - 16 * 60_000));
    failSearchWithSecret = true;
    await expect(service.runOne()).resolves.toEqual({ status: "cursor_reset" });
    await expect(service.runOne()).resolves.toEqual({ status: "deferred" });
    expect(observedFailures).toContain("UNKNOWN_OUTCOME");
    const sourceSummaries = await ingestion.listSources(pmo);
    expect(sourceSummaries).toHaveLength(1);
    expect(sourceSummaries[0]).toMatchObject({
      sourceId,
      healthState: "DEGRADED",
      healthCode: "UNKNOWN_OUTCOME",
    });
    expect(sourceSummaries[0]?.healthCheckedAt).not.toBeNull();
    const safeSummary = JSON.stringify(sourceSummaries[0]);
    expect(safeSummary).not.toContain("socket closed");
    expect(safeSummary).not.toContain("synthetic-secret-token");
    expect(safeSummary).not.toContain("synthetic-reconciliation-access");
    expect(safeSummary).not.toContain("synthetic-reconciliation-refresh");
    expect(await db.connectorWebhookReceipt.count({ where: { customerId: isolatedCustomerId, sourceId } })).toBe(0);

    // A revoked refresh token stops the scheduled read and gives an authorized
    // administrator a finite reauthorization action without the provider body.
    const revokedSourceId = randomUUID();
    await ingestion.configure(
      pmo,
      {
        binding: { ...binding, sourceId: revokedSourceId },
        projects: [{ projectId, readers: [manager.subject, pmo.subject] }],
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
      "revoked-token-configure-" + revokedSourceId,
    );
    const revokedRefreshToken = "synthetic-revoked-refresh-token";
    const revokedAccessToken = "synthetic-revoked-access-token";
    await runtime.setOAuthCredential({
      customerId: isolatedCustomerId,
      sourceId: revokedSourceId,
      actorSubject: pmo.subject,
      credential: {
        cloudId: "cloud-1",
        selectedUrl: binding.origin,
        accessToken: revokedAccessToken,
        refreshToken: revokedRefreshToken,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        scopes: ["read:jira-work", "offline_access"],
      },
    });
    const revokedWebhookSecret = Buffer.alloc(32, 73).toString("hex");
    await runtime.setWebhookSecret({
      customerId: isolatedCustomerId,
      sourceId: revokedSourceId,
      actorSubject: pmo.subject,
      secret: revokedWebhookSecret,
    });
    const revokedBody = Buffer.from(JSON.stringify({
      webhookEvent: "jira:issue_updated",
      timestamp: Date.now(),
    }));
    await runtime.acceptWebhook({
      sourceId: revokedSourceId,
      eventId: "revoked-token-" + randomUUID(),
      signature: "sha256=" + createHmac("sha256", revokedWebhookSecret).update(revokedBody).digest("hex"),
      rawBody: revokedBody,
    });

    let observedRefreshToken = "";
    const revokedFetch: typeof fetch = async (_input, init) => {
      const form = new URLSearchParams(String(init?.body ?? ""));
      observedRefreshToken = form.get("refresh_token") ?? "";
      return new Response(JSON.stringify({
        error: "invalid_grant",
        error_description: "The synthetic refresh token was revoked: " + revokedRefreshToken,
      }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    };
    const revokedService = new JiraRuntimeService(
      {
        CUSTOMER_ID: isolatedCustomerId,
        JIRA_OAUTH_CLIENT_ID: "synthetic-client",
        JIRA_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
      } as never,
      observedRuntime,
      observedIngestion,
      revokedFetch,
    );
    let revokedAction = await revokedService.runOne();
    for (let reset = 0; reset < 4 && revokedAction.status === "cursor_reset"; reset++)
      revokedAction = await revokedService.runOne();
    expect(revokedAction).toEqual({ status: "reauthorization_required" });
    expect(observedRefreshToken).toBe(revokedRefreshToken);
    expect(observedFailures).toContain("INVALID_CREDENTIALS");

    const revokedCredential = await db.connectorCredential.findFirstOrThrow({
      where: { customerId: isolatedCustomerId, sourceId: revokedSourceId, purpose: "jira_oauth" },
      select: { state: true, rotationOperationId: true, rotationDeadline: true },
    });
    expect(revokedCredential).toEqual({
      state: "REAUTH_REQUIRED",
      rotationOperationId: null,
      rotationDeadline: null,
    });
    await expect(runtime.accessOrBeginRotation(isolatedCustomerId, revokedSourceId)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "REAUTH_REQUIRED",
    });
    const reauthorizationSummary = await ingestion.listSources(pmo);
    expect(reauthorizationSummary).toHaveLength(2);
    const revokedSummary = reauthorizationSummary.find((item) => item.sourceId === revokedSourceId);
    expect(revokedSummary).toMatchObject({
      sourceId: revokedSourceId,
      healthState: "FAILED",
      healthCode: "INVALID_CREDENTIALS",
    });
    expect(revokedSummary?.healthCheckedAt).not.toBeNull();
    const redactedAdminAction = JSON.stringify({
      action: revokedAction,
      source: revokedSummary,
    });
    expect(redactedAdminAction).not.toContain(revokedRefreshToken);
    expect(redactedAdminAction).not.toContain(revokedAccessToken);
    expect(redactedAdminAction).not.toContain("invalid_grant");
    expect(redactedAdminAction).not.toContain("revoked");
  }, 45_000);

});
