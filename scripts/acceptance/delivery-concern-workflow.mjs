// GOLDEN-002 synthetic workflow shared by the development and packaged browser tests.
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { canonicalFixture } from "./canonical-projects.mjs";

export async function exerciseDeliveryConcernWorkflow({ api, portfolioId, openProject, screenshot, configurationVariant }) {
  const fixture = canonicalFixture(portfolioId);
  fixture.name = "Synthetic delivery concern " + randomUUID().slice(0, 8);
  if (configurationVariant) {
    fixture.sourceMappings = fixture.sourceMappings.map((mapping) => ({
      ...mapping, sourceSystem: configurationVariant.sourceSystem,
      externalId: configurationVariant.mappingPrefix + mapping.externalId,
    }));
    fixture.responsibilities = fixture.responsibilities.map((assignment) => assignment.role === "PROJECT_MANAGER"
      ? { ...assignment, subject: configurationVariant.reportApprover } : assignment);
  }
  fixture.raidItems = fixture.raidItems.map((entry, index) => ({
    ...entry, state: index < 2 ? "OPEN" : "COMPLETE",
  }));
  const created = await api("/projects", "POST", fixture);
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).id;
  const project = "/projects/" + projectId;
  const canonical = await api(project + "/canonical");
  expect(canonical.status()).toBe(200);
  const configuration = await canonical.json();
  if (configurationVariant) {
    expect(configuration.sourceMappings).toHaveLength(fixture.sourceMappings.length);
    for (const mapping of fixture.sourceMappings) {
      expect(configuration.sourceMappings).toContainEqual(expect.objectContaining({
        sourceSystem: mapping.sourceSystem, externalId: mapping.externalId, targetType: mapping.targetType,
      }));
    }
  }
  const milestone = configuration.milestones[0];
  const blockers = configuration.raidItems.filter((item) => item.state === "OPEN");
  expect(blockers).toHaveLength(2);
  const criticalTargets = {
    milestoneIds: [milestone.id],
    raidItemIds: blockers.map((item) => item.id).sort(),
  };

  const retentionPath = "/admin/health-assessment-retention";
  const retention = await api(retentionPath);
  expect(retention.status()).toBe(200);
  if (!(await retention.json())) {
    expect((await api(retentionPath, "POST", {
      contentRetentionHours: 24, auditRetentionHours: 48, idempotencyRetentionHours: 72,
    })).status()).toBe(200);
  }
  const thresholdPath = "/admin/blocker-age-threshold-policy";
  const threshold = await api(thresholdPath);
  expect(threshold.status()).toBe(200);
  if (!(await threshold.json())) {
    expect((await api(thresholdPath, "POST", {
      expectedRevision: 0, minimumBlockerAgeDays: 10, auditRetentionHours: 720,
    })).status()).toBe(200);
  }

  const effectiveAt = new Date(Date.now() - 60_000).toISOString();
  const openedAt = effectiveAt.slice(0, 10);
  async function addFact(factType, value, openPeriod = false) {
    const authority = await api(project + "/authority-policies", "POST", {
      projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt,
      definition: {
        tiers: [{ selectors: [{
          sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
          validity: openPeriod ? { mode: "UNTIL_SUPERSEDED" } : { basis: "observedAt", durationMs: 86_400_000 },
        }] }],
        conflictBehavior: "REQUEST_RECONCILIATION",
      },
    });
    expect(authority.status()).toBe(201);
    const statement = await api(project + "/fact-statements", "POST", {
      projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt, value,
      validUntil: null, originalStatement: "Synthetic delivery signal evidence.",
    });
    expect(statement.status()).toBe(201);
    return (await statement.json()).entry;
  }

  const updateType = "project.forecast";
  const update = await addFact(updateType, { type: "text", value: "Synthetic forecast update" });
  const freshnessSeconds = configurationVariant?.freshnessSeconds ?? 1;
  const freshnessBoundary = performance.now() + freshnessSeconds * 1000 + 100;
  const escalationDays = configurationVariant?.escalationDays ?? 0;
  const escalationSubject = escalationDays
    ? fixture.responsibilities.find(({ role }) => role === "PROJECT_MANAGER").subject : null;
  if (configurationVariant) {
    for (const [subject, role] of [[configurationVariant.reportApprover, "project_manager"],
      [configurationVariant.reportAuthor, "leadership"]]) {
      expect((await api("/access-grants", "POST", {
        subject, scopeType: "project", scopeId: projectId, role,
      })).status()).toBe(204);
    }
  }
  const updatePolicyPath = project + "/project-update-policy";
  const updatePolicy = {
    expectedRevision: 0,
    freshnessWindowSeconds: freshnessSeconds,
    timeZone: "UTC",
    requiredFacts: [{ factType: updateType, label: configurationVariant?.forecastLabel ?? "Current forecast" }],
    responsibleSubject: "synthetic-owner-4",
    scheduledScanEnabled: false,
    reminderBusinessDayOffsets: escalationDays ? [1] : [],
    escalationAfterBusinessDays: escalationDays,
    escalationRecipientSubject: escalationSubject,
    quietHoursStartLocal: null,
    quietHoursEndLocal: null,
  };
  if (configurationVariant) {
    const invalid = await api(updatePolicyPath, "POST", { ...updatePolicy, timeZone: "Invalid/Customer-Time" });
    expect(invalid.status()).toBe(400);
  }
  const savedUpdatePolicy = await api(updatePolicyPath, "POST", updatePolicy);
  expect(savedUpdatePolicy.status()).toBe(200);
  const confirmedUpdatePolicy = await savedUpdatePolicy.json();
  expect(confirmedUpdatePolicy).toMatchObject({
    revision: 1, freshnessWindowSeconds: freshnessSeconds, requiredFacts: updatePolicy.requiredFacts,
    reminderBusinessDayOffsets: updatePolicy.reminderBusinessDayOffsets, escalationAfterBusinessDays: escalationDays,
    escalationRecipientSubject: escalationSubject,
  });
  await addFact("project.open_blocker_inventory_complete", { type: "boolean", value: true });
  for (const blocker of blockers) {
    await addFact(`raid_item.${blocker.id}.blocks_delivery`, { type: "boolean", value: true });
    await addFact(`raid_item.${blocker.id}.opened_at`, { type: "date", value: openedAt }, true);
  }

  const page = await openProject(fixture.name);
  const policyRegion = page.getByRole("region", { name: "Project schedule overdue policy" });
  const targetField = policyRegion.getByLabel("Critical delivery targets (JSON)");
  await expect(targetField).toHaveValue("null");
  await targetField.fill(JSON.stringify(criticalTargets));
  const overdueDays = configurationVariant?.overdueDays ?? 1;
  if (configurationVariant)
    await policyRegion.getByLabel("Default overdue threshold (local calendar days)").fill(String(overdueDays));
  const policyPath = project + "/schedule-health-policy";
  const savedPolicy = page.waitForResponse((response) =>
    response.url().endsWith(policyPath) && response.request().method() === "POST",
  );
  await policyRegion.getByRole("button", { name: "Save project schedule policy" }).click();
  const policyResponse = await savedPolicy;
  expect(policyResponse.status()).toBe(200);
  const policy = await policyResponse.json();
  expect(policy.criticalTargets).toEqual(criticalTargets);
  expect(policy.defaultMinimumOverdueDays).toBe(overdueDays);
  await expect.poll(() => performance.now(), { timeout: freshnessSeconds * 1000 + 1500 }).toBeGreaterThan(freshnessBoundary);

  const assessmentPath = project + "/health-assessments";
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(assessmentPath) && response.request().method() === "POST",
  );
  const region = page.getByRole("region", { name: "Schedule and blocker age" });
  await region.getByRole("button", { name: "Run assessment", exact: true }).click();
  const assessmentResponse = await saved;
  expect(assessmentResponse.status()).toBe(201);
  const assessment = await assessmentResponse.json();
  expect(assessment).toMatchObject({
    projectId,
    ruleRevision: "schedule-health@2+blocker-age@1+delivery-concern@1",
    coverage: "SCHEDULE_BLOCKER_AGE_AND_DELIVERY_CONCERN",
    contentAvailable: true,
    input: { deliveryConcern: {
      criticalTargetsPolicyRevision: policy.revision,
      updateEvidence: [expect.objectContaining({
        evidenceId: update.evidenceId, versionId: update.id, sourceId: update.sourceId, timestampBasis: "HUMAN_OBSERVED_AT",
      })],
    } },
    result: {
      reported: { status: "GREEN" },
      calculated: { status: "RED", rule: { key: "schedule-health" } },
      blockerAge: { coverage: "COMPLETE" },
      deliveryConcern: {
        reported: { status: "GREEN" },
        calculated: { status: "RED", rule: { key: "delivery-concern", revision: "1" } },
        recommendation: "PM_REVIEW",
      },
    },
  });
  const concern = assessment.result.deliveryConcern;
  expect(concern.assessedAt).toBe(assessment.assessedAt);
  expect(assessment.result.blockerAge.asOf).toBe(assessment.assessedAt);
  expect(assessment.input.deliveryConcern.evaluation.assessedAt).toBe(assessment.assessedAt);
  expect(concern.objectiveSignals).toHaveLength(4);
  for (const blocker of blockers) {
    expect(concern.objectiveSignals).toContainEqual(expect.objectContaining({
      kind: "CRITICAL_BLOCKER", state: "ACTIVE", targetSource: expect.objectContaining({ recordId: blocker.id }),
      rule: expect.objectContaining({ parameters: expect.arrayContaining([{ name: "resolvedOpenedAt", value: openedAt }]) }),
    }));
  }
  expect(concern.objectiveSignals).toContainEqual(expect.objectContaining({
    kind: "OVERDUE_MILESTONE", state: "ACTIVE", targetSource: expect.objectContaining({ recordId: milestone.id }),
    rule: expect.objectContaining({ parameters: expect.arrayContaining([{ name: "minimumOverdueDays", value: overdueDays }]) }),
    sourceFacts: expect.arrayContaining([expect.objectContaining({ field: "selectedDueDate", value: fixture.milestones[0]?.dates.forecastEnd })]),
  }));
  expect(concern.objectiveSignals).toContainEqual(expect.objectContaining({
    kind: "UPDATE_FRESHNESS", state: "ACTIVE",
    rule: expect.objectContaining({ parameters: expect.arrayContaining([{
      name: "latestValidUpdateAt", value: assessment.input.deliveryConcern.updateEvidence[0].observedAt,
    }]) }),
  }));
  const view = region.getByRole("region", { name: "Calculated delivery concern" });
  await expect(view).toContainText("Reported GREEN at assessment · calculated RED");
  await expect(view).toContainText("Critical milestone " + milestone.key);
  await expect(view).toContainText("Configured schedule due date " + fixture.milestones[0].dates.forecastEnd);
  for (const blocker of blockers) await expect(view).toContainText("Critical blocker target " + blocker.key);
  await expect(view).toContainText("Opened " + openedAt);
  await expect(view).toContainText("Project update freshness · STALE");
  await expect(view).toContainText("Last valid update " + assessment.input.deliveryConcern.updateEvidence[0].observedAt);
  await expect(view).toContainText("Calculated RED because active red-band delivery signals");
  await expect(view).toContainText("Recommend PM review");
  await view.screenshot({ path: screenshot });

  const latest = await api(assessmentPath + "/latest");
  expect(latest.status()).toBe(200);
  expect(await latest.json()).toEqual(assessment);
  expect((await api(policyPath, "POST", {
    expectedRevision: policy.revision, timeZone: policy.timeZone,
    defaultMinimumOverdueDays: policy.defaultMinimumOverdueDays,
    targetOverrides: policy.targetOverrides, criticalTargets: null,
  })).status()).toBe(200);
  const command = assessmentResponse.request().postDataJSON();
  const replay = await api(assessmentPath, "POST", command);
  expect(replay.status()).toBe(201);
  expect(await replay.json()).toEqual({ ...assessment, replayed: true });

  const sourcePath = project + "/fact-sources/" + update.sourceId + "/access";
  const access = await api(sourcePath);
  expect(access.status()).toBe(200);
  expect((await api(sourcePath, "POST", {
    projectId, sourceId: update.sourceId, expectedRevision: (await access.json()).revision,
    state: "REVOKED", readers: [],
  })).status()).toBe(200);
  for (const response of [
    await api(assessmentPath + "/latest"),
    await api(assessmentPath, "POST", command),
  ]) {
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({
      assessmentId: assessment.assessmentId, contentAvailable: false, input: null, result: null,
    });
  }
  return {
    projectId,
    assessmentId: assessment.assessmentId,
    assessedAt: assessment.assessedAt,
    ruleRevision: assessment.ruleRevision,
    envelopeHash: assessment.envelopeHash,
    criticalTargetsPolicyRevision: policy.revision,
    ...(configurationVariant && { configuration: {
      sourceSystem: configurationVariant.sourceSystem, mappingPrefix: configurationVariant.mappingPrefix,
      forecastLabel: confirmedUpdatePolicy.requiredFacts[0].label, freshnessSeconds, escalationDays, overdueDays,
    } }),
  };
}

// Called from the guarded customer harness for the original and restored rows.
export async function deliveryConcernStorageHash(pool, customerId, receipt) {
  const { rows } = await pool.query(`
    SELECT a."envelopeHash", a."ruleRevision",
      (SELECT count(*)::int FROM "HealthAssessmentCommandReceipt" r
        WHERE r."customerId"=$1 AND r."projectId"=$2 AND r."assessmentId"=a.id) AS receipts,
      (SELECT count(*)::int FROM "ScheduleHealthPolicyRevision" p
        WHERE p."customerId"=$1 AND p."projectId"=$2
          AND p.revision=$4 AND p."criticalTargets" IS NOT NULL) AS applied,
      jsonb_build_array(to_jsonb(a),
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r."commandKeyHash")
         FROM "HealthAssessmentCommandReceipt" r
         WHERE r."customerId"=$1 AND r."projectId"=$2 AND r."assessmentId"=a.id),
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.revision)
         FROM "ScheduleHealthPolicyRevision" p
         WHERE p."customerId"=$1 AND p."projectId"=$2)
      )::text AS proof
    FROM "HealthAssessment" a
    WHERE a."customerId"=$1 AND a."projectId"=$2 AND a.id=$3
  `, [customerId, receipt.projectId, receipt.assessmentId, receipt.criticalTargetsPolicyRevision]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.envelopeHash, receipt.envelopeHash);
  assert.equal(row.ruleRevision, receipt.ruleRevision);
  assert.equal(row.receipts, 1);
  assert.equal(row.applied, 1);
  return createHash("sha256").update(row.proof).digest("hex");
}
