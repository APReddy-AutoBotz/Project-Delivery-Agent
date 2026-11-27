import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { text as readStreamText } from "node:stream/consumers";
import yauzl from "yauzl";
import { createDatabase, DatabaseAuthorityRepository, DatabaseCanonicalProjectRepository, DatabaseProjectFactRepository,
  DatabaseProjectUpdateRepository } from "../../packages/data/dist/index.js";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

async function readSlide(file: string | Buffer, slide = 1) {
  const archive = typeof file === "string" ? await yauzl.openPromise(file, { lazyEntries: true })
    : await yauzl.fromBufferPromise(file, { lazyEntries: true });
  try {
    for await (const entry of archive.eachEntry()) {
      if (entry.fileName === `ppt/slides/slide${slide}.xml`)
        return await readStreamText(await archive.openReadStreamPromise(entry));
    }
  } finally { archive.close(); }
  throw new Error(`The deck has no slide ${slide}`);
}

test("Atlas reply, PM delay evidence and distributed final report share the same evidence", async ({ page, request }) => {
  test.setTimeout(45_000);
  const fixture = JSON.parse(readFileSync(process.env.PDAA_ESCALATION_FIXTURE_PATH!, "utf8"));
  const projectPath = `/api/projects/${fixture.projectId}`;
  const receiptPath = projectPath + "/atlas-comment-receipt";
  const answerPath = projectPath + "/atlas-leadership-answer";
  const delayPath = projectPath + "/atlas-delay-confirmation";
  const reportPath = projectPath + "/atlas-management-snapshot";
  const reportReviewPath = projectPath + "/atlas-report-approval";
  const distributionPath = projectPath + "/atlas-report-distribution";
  const invitationPath = "/api/project-update-invitations/" + fixture.request.locator;
  const target = new URL(process.env.PDAA_ESCALATION_BROWSER_DATABASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  expect(target.pathname).toMatch(/^\/pdaa_test_[0-9]+$/);
  const leaderAccess = async (allowed: boolean, sourceId = fixture.sourceA.sourceId, readers = fixture.readers) => {
    const db = createDatabase(target.toString());
    try {
      const access = await db.factSourceAccess.findUniqueOrThrow({ where: { sourceId } });
      await new DatabaseProjectFactRepository(db).setSourceAccess(fixture.admin, {
        projectId: fixture.projectId, sourceId, expectedRevision: access.revision,
        state: "AVAILABLE", readers: readers.filter((subject: string) => allowed || subject !== "leader-atlas"),
      }, { correlationId: randomUUID() });
    } finally {
      await db.$disconnect();
    }
  };
  await page.goto("/update-requests/" + fixture.request.locator);
  await page.getByRole("button", { name: /Atlas contributor/ }).click();
  const updateRequest = page.getByRole("region", { name: "Respond to update request" });
  await expect(updateRequest.getByRole("heading", { level: 2 })).toHaveText("Atlas · Delivery approval: update requested");
  const context = updateRequest.locator(":scope > p.update-plain-text");
  await expect(context).toContainText("The integration team last reported that API access was pending on ATLAS-248.");
  await expect(context).toContainText("Expected API access date, current owner and impact on the integration forecast");
  const reply = updateRequest.getByRole("textbox", { name: "Your update (unconfirmed)" });
  const submitReply = async (text: string) => {
    await reply.fill(text);
    const saved = page.waitForResponse((value) => value.url().endsWith("/responses") && value.request().method() === "POST");
    await page.getByRole("button", { name: "Record response" }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
    return response.json();
  };
  await submitReply("It might be available next week.");
  const interpretation = page.getByRole("region", { name: "Atlas demo interpretation" });
  await expect(interpretation).toContainText("Clarify whether API access is still pending");
  await expect(interpretation.getByRole("combobox")).toHaveValue("");
  await expect(interpretation.getByRole("button", { name: "Confirm for PM review" })).toBeDisabled();

  const text = "Access is still pending from Infrastructure. They expect to provide it on Wednesday. I need two working days after access to complete the integration task.";
  const retained = await submitReply(text);
  const reviewer = await request.post("/api/auth/development", { data: { persona: "pmo-portfolio" } });
  expect(reviewer.status()).toBe(200);
  const reviewerHeaders = { Authorization: "Bearer " + (await reviewer.json()).token };
  const clarificationRequest = await request.post(projectPath + "/project-update-status-clarifications", {
    headers: reviewerHeaders,
    data: { requestId: fixture.request.requestId, responseId: retained.responseId, factType: "project.forecast" },
  });
  expect(clarificationRequest.status()).toBe(200);
  const clarification = await clarificationRequest.json();
  await expect(interpretation.getByRole("combobox")).toHaveValue("ACCESS_PENDING");
  const confirmationSaved = page.waitForResponse((value) => value.url().endsWith("/atlas-confirmation"));
  await interpretation.getByRole("button", { name: "Confirm for PM review" }).click();
  const confirmation = await confirmationSaved;
  expect(confirmation.status()).toBe(200);
  const { approvalId } = await confirmation.json();
  await expect(interpretation).toContainText("Atlas demo interpretation confirmed for PM review.");

  const leader = await request.post("/api/auth/development", { data: { persona: "leader-atlas" } });
  expect(leader.status()).toBe(200);
  const leaderHeaders = { Authorization: "Bearer " + (await leader.json()).token };
  expect((await request.get(projectPath, { headers: leaderHeaders })).status()).toBe(200);
  expect((await request.get(invitationPath, { headers: leaderHeaders })).status()).toBe(404);
  const beforeApproval = await request.get(answerPath, { headers: leaderHeaders });
  expect(beforeApproval.status()).toBe(200);
  const before = await beforeApproval.json();
  expect(before).toMatchObject({
    schedule: { baseline: "2026-10-15", forecast: "2026-10-29", movementDays: 14 }, ownerReply: null, receipt: null,
    updateFreshness: { state: "STALE", sourceDateField: "project.latestValidUpdateAt", sourceDate: fixture.lastPmUpdateAt,
      openObligation: true },
    jiraBlocker: { mappingId: fixture.jiraIntake.mappingId, issueKey: "ATLAS-248" },
  });
  const intakePath = `/api/ingestion/sources/${fixture.jiraIntake.sourceId}/receipts/${fixture.jiraIntake.receiptId}`;
  const intake = await request.get(intakePath, { headers: leaderHeaders });
  expect(intake.status()).toBe(200);
  expect(await intake.json()).toMatchObject({
    receipt: { id: fixture.jiraIntake.receiptId, sourceId: fixture.jiraIntake.sourceId, kind: "CONNECTOR_PAGE", rowCount: 1 },
    outcomes: [{ projectId: fixture.projectId, identity: ["jira.issue", "ATLAS-248"], contentAvailable: true,
      proposals: [{ factType: "jira.status", value: { type: "text", value: "To Do" } }] }],
  });
  const spreadsheet = fixture.spreadsheetIntake;
  expect(before.scheduleCitation).toMatchObject({ sourceId: spreadsheet.sourceId, receiptId: spreadsheet.receiptId });
  const reviewedImport = await request.get(`/api/ingestion/sources/${spreadsheet.sourceId}/receipts/${spreadsheet.receiptId}`, {
    headers: leaderHeaders,
  });
  expect(reviewedImport.status()).toBe(200);
  expect(await reviewedImport.json()).toMatchObject({
    receipt: { id: spreadsheet.receiptId, sourceId: spreadsheet.sourceId, kind: "CSV_REVIEWED_IMPORT",
      rowCount: 1, parentPreviewReceiptId: spreadsheet.previewReceiptId },
    outcomes: [{ projectId: fixture.projectId, state: "ACCEPTED", parentOrdinal: 1, contentAvailable: true,
      proposals: [
        { factType: "project.baseline", value: { type: "date", value: before.schedule.baseline } },
        { factType: "project.forecast", value: { type: "date", value: before.schedule.forecast } },
      ] }],
  });
  expect(await (await request.get(reportPath, { headers: leaderHeaders })).json()).toBeNull();
  expect((await request.post(reportPath, { headers: leaderHeaders, data: {} })).status()).toBe(409);
  const denied = await request.post(projectPath + "/atlas-approval", {
    headers: leaderHeaders, data: { approvalId, decision: "APPROVED" },
  });
  expect(denied.status()).toBe(404);
  expect((await request.post(receiptPath, { headers: leaderHeaders, data: { approvalId } })).status()).toBe(404);
  const manager = await request.post("/api/auth/development", { data: { persona: "pm-atlas" } });
  expect(manager.status()).toBe(200);
  const managerHeaders = { Authorization: "Bearer " + (await manager.json()).token };
  const updateAssessment = await request.get(projectPath + "/project-update-assessments/latest", { headers: managerHeaders });
  expect(updateAssessment.status()).toBe(200);
  const authorizedUpdate = await updateAssessment.json();
  expect(authorizedUpdate).toMatchObject({
    project: { id: fixture.projectId },
    policy: { responsibleSubject: "owner-atlas", freshnessWindowSeconds: 7 * 86400 },
    obligation: { state: "OPEN" },
    completeness: { state: "COMPLETE" },
  });
  expect(authorizedUpdate.knownPosition).toHaveLength(2);
  expect(authorizedUpdate.knownPosition).toEqual(expect.arrayContaining([expect.objectContaining({
    factType: "project.status", authorityRevision: 2, sourceId: fixture.sourceB.sourceId,
    value: { type: "text", value: fixture.sourceMarkerB }, observedAt: fixture.lastPmUpdateAt,
  }), expect.objectContaining({
    factType: "project.forecast", sourceId: fixture.lastForecast.sourceId, observedAt: fixture.lastPmUpdateAt,
  })]));
  expect(Math.floor((Date.parse(before.updateFreshness.assessedAt) - Date.parse(fixture.lastPmUpdateAt)) / 86400000)).toBe(9);
  const protectedReportPath = projectPath + "/management-draft";
  const protectedPreview = await request.get(protectedReportPath, { headers: leaderHeaders });
  expect(protectedPreview.status()).toBe(200);
  const protectedDraft = (await protectedPreview.json()).draft;
  expect(protectedDraft.updateFreshness.sourceDateField).toBe("project.latestValidUpdateAt");
  const protectedSave = await request.post(protectedReportPath, { headers: leaderHeaders, data: protectedDraft });
  expect(protectedSave.status()).toBe(200);
  const protectedSnapshotId = (await protectedSave.json()).snapshotId;
  const protectedSnapshotPath = `${protectedReportPath}?snapshotId=${protectedSnapshotId}`;
  const protectedApprovalPath = protectedReportPath + "/approval-request";
  const historicalQuestion = "What changed since this snapshot?";
  const protectedComparison = { headers: leaderHeaders, data: { question: historicalQuestion, priorSnapshotId: protectedSnapshotId } };
  expect((await request.post(projectPath + "/leadership-answer", protectedComparison)).status()).toBe(200);
  let fallbackReviewSnapshotId: string;
  await leaderAccess(false, fixture.lastForecast.sourceId, fixture.readers);
  try {
    const restrictedFreshness = await request.get(answerPath, { headers: leaderHeaders });
    expect(restrictedFreshness.status()).toBe(200);
    expect(await restrictedFreshness.json()).toMatchObject({ updateFreshness: null, jiraBlocker: before.jiraBlocker });
    expect((await request.get(protectedSnapshotPath, { headers: leaderHeaders })).status()).toBe(404);
    expect((await request.post(projectPath + "/leadership-answer", protectedComparison)).status()).toBe(404);
    const fallback = await request.get(protectedReportPath, { headers: leaderHeaders });
    expect(fallback.status()).toBe(200);
    const fallbackDraft = (await fallback.json()).draft;
    expect(fallbackDraft.updateFreshness).toBeNull();
    const fallbackSave = await request.post(protectedReportPath, { headers: leaderHeaders, data: fallbackDraft });
    expect(fallbackSave.status()).toBe(200);
    fallbackReviewSnapshotId = (await fallbackSave.json()).snapshotId;
    expect((await request.post(protectedApprovalPath, {
      headers: leaderHeaders, data: { snapshotId: fallbackReviewSnapshotId },
    })).status()).toBe(200);
  } finally {
    await leaderAccess(true, fixture.lastForecast.sourceId, fixture.readers);
  }
  const protectedHandoff = await request.post(protectedApprovalPath, {
    headers: leaderHeaders, data: { snapshotId: protectedSnapshotId },
  });
  expect(protectedHandoff.status()).toBe(200);
  const protectedApproval = (await protectedHandoff.json()).approval;
  const protectedManagerPath = projectPath + "/management-report-approval";
  await leaderAccess(true, fixture.lastForecast.sourceId, fixture.readers.filter((subject: string) => subject !== "pm-atlas"));
  try {
    const readableEarlier = await request.get(protectedManagerPath, { headers: managerHeaders });
    expect(readableEarlier.status()).toBe(200);
    expect(await readableEarlier.json()).toMatchObject({ snapshotId: fallbackReviewSnapshotId, approval: { state: "PENDING" } });
    expect((await request.post(protectedManagerPath, { headers: managerHeaders,
      data: { snapshotId: protectedSnapshotId, requestId: protectedApproval.requestId, decision: "APPROVED" },
    })).status()).toBe(404);
  } finally {
    await leaderAccess(true, fixture.lastForecast.sourceId, fixture.readers);
  }
  expect(before.updateFreshness).toEqual({
    state: authorizedUpdate.freshness.state, sourceDateField: authorizedUpdate.freshness.sourceDateField,
    sourceDate: authorizedUpdate.freshness.sourceDate, assessedAt: authorizedUpdate.freshness.assessedAt, openObligation: true,
    activeClarification: { clarificationId: clarification.clarificationId, requestedAt: clarification.requestedAt,
      factType: "project.forecast", availableUntil: expect.any(String) },
  });
  expect((await request.get(answerPath, { headers: managerHeaders })).status()).toBe(404);
  expect((await request.get(reportPath, { headers: managerHeaders })).status()).toBe(404);
  const record = () => request.post(receiptPath, { headers: managerHeaders, data: { approvalId } });
  expect((await record()).status()).toBe(409);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager/ }).click();
  const queuePath = "/api/pm/action-queue";
  const pendingQueue = await request.get(queuePath, { headers: managerHeaders });
  expect(pendingQueue.status()).toBe(200);
  const pendingItems = (await pendingQueue.json()).items;
  expect(pendingItems).toContainEqual({
    projectId: fixture.projectId, facet: "ATLAS_APPROVAL", index: null, key: approvalId, priority: "HIGH", category: "APPROVAL",
  });
  expect(pendingItems).toContainEqual({
    projectId: fixture.projectId, facet: "BLOCKER_AGE", index: null, key: "blocker-age", priority: "MEDIUM", category: "BLOCKER_REVIEW",
  });
  expect((await request.get(queuePath, { headers: leaderHeaders })).status()).toBe(404);
  const rankedQueue = page.getByRole("region", { name: "Action suggestions" });
  const rankedUpdates = rankedQueue.getByRole("heading", { level: 3 }).filter({
    hasText: /^Atlas · Delivery approval · (CRITICAL · RECONCILIATION|HIGH · APPROVAL|MEDIUM · UPDATE FOLLOW UP)$/u,
  });
  await expect(rankedUpdates).toHaveText([
    "Atlas · Delivery approval · CRITICAL · RECONCILIATION",
    "Atlas · Delivery approval · HIGH · APPROVAL",
    "Atlas · Delivery approval · MEDIUM · UPDATE FOLLOW UP",
  ]);
  await expect(rankedQueue.getByText(/^Freshness: STALE;/u)).toBeVisible();
  const blockerReview = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Atlas · Delivery approval · MEDIUM · BLOCKER REVIEW" }),
  });
  await expect(blockerReview.getByText("ATLAS-248", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review Atlas comment" }).click();
  const approval = page.getByRole("region", { name: "Atlas demo approval" });
  await expect(approval).toContainText("ATLAS-248");
  await expect(approval).toContainText("No comment in the fixture.");
  const proposedComment = approval.getByRole("textbox", { name: "Proposed comment" });
  await expect(proposedComment).toHaveValue("The Atlas owner confirmed that API access is still pending.");
  await expect(approval).not.toContainText(text);
  const approveComment = approval.getByRole("button", { name: "Approve demo comment" });
  await proposedComment.fill("   ");
  await expect(approveComment).toBeDisabled();
  const editedComment = "API access remains pending. The PM will reconfirm the integration forecast after access is granted.";
  await proposedComment.fill(editedComment);
  await approveComment.click();
  await expect(approval).toContainText("Demo approval recorded.");
  await expect(approval).toContainText(editedComment);
  await expect(approveComment).toHaveCount(0);
  const afterDecision = await request.get(queuePath, { headers: managerHeaders });
  expect(afterDecision.status()).toBe(200);
  expect((await afterDecision.json()).items).not.toContainEqual(expect.objectContaining({ key: approvalId }));
  await expect(proposedComment).toHaveCount(0);
  const persisted = await request.get(projectPath + "/atlas-approval", {
    headers: managerHeaders,
  });
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toMatchObject({ approvalId, decision: "APPROVED", approver: "pm-atlas",
    proposedComment: editedComment, receipt: null });
  const replay = await request.post(projectPath + "/atlas-approval", {
    headers: managerHeaders, data: { approvalId, decision: "APPROVED", proposedComment: editedComment },
  });
  expect(replay.status()).toBe(200);
  const changedText = await request.post(projectPath + "/atlas-approval", {
    headers: managerHeaders, data: { approvalId, decision: "APPROVED", proposedComment: editedComment + " " },
  });
  expect(changedText.status()).toBe(409);
  const conflicting = await request.post(projectPath + "/atlas-approval", {
    headers: managerHeaders, data: { approvalId, decision: "REJECTED" },
  });
  expect(conflicting.status()).toBe(409);

  await approval.getByRole("button", { name: "Record simulated comment" }).click();
  const receiptPanel = approval.getByRole("region", { name: "Simulated comment receipt" });
  await expect(receiptPanel).toContainText("Simulated comment recorded");
  const firstReplay = await record();
  expect(firstReplay.status()).toBe(200);
  const receipt = await firstReplay.json();
  expect(receipt).toMatchObject({ approvalId, target: "ATLAS-248", fixtureRevision: 1, result: "SIMULATED" });
  await expect(receiptPanel).toContainText(receipt.id);
  const freshView = await request.get(projectPath + "/atlas-approval", { headers: managerHeaders });
  expect(await freshView.json()).toMatchObject({ receipt, proposedComment: editedComment });
  expect(await (await record()).json()).toEqual(receipt);
  const unknown = await request.get(answerPath, { headers: leaderHeaders });
  expect(unknown.status()).toBe(200);
  const unknownFacts = await unknown.json();
  expect(unknownFacts).toMatchObject({ delayAssessment: null, receipt, delayClarificationState: "AVAILABLE" });
  const delayClarificationPath = projectPath + "/atlas-delay-clarification";
  const clarificationCommand = { scheduleRevision: unknownFacts.schedule.revision };
  expect((await request.post(delayClarificationPath, { headers: managerHeaders, data: clarificationCommand })).status()).toBe(404);
  expect((await request.get(delayClarificationPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.post(delayClarificationPath, {
    headers: leaderHeaders, data: { scheduleRevision: clarificationCommand.scheduleRevision + 1 },
  })).status()).toBe(409);
  const beforeClarification = await request.get(delayClarificationPath, { headers: managerHeaders });
  expect(beforeClarification.status()).toBe(200);
  expect(await beforeClarification.json()).toBeNull();
  let savedDelayClarification: unknown;
  const unknownCausePage = await page.context().newPage();
  try {
    await leaderAccess(false, fixture.jiraIntake.factSourceId, fixture.jiraIntake.sourceReaders);
    await unknownCausePage.goto("/");
    await unknownCausePage.getByRole("button", { name: /Leadership/ }).click();
    await unknownCausePage.getByRole("button", { name: /Atlas · Delivery approval/ }).click();
    const unknownAnswer = unknownCausePage.getByRole("region", { name: "Atlas leadership answer" });
    await unknownAnswer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
    await expect(unknownAnswer).toContainText("The forecast is 14 days later than the baseline.");
    await expect(unknownAnswer).toContainText("The verified cause of the schedule change and confidence in the forecast remain unknown.");
    await expect(unknownAnswer.getByRole("link", { name: "Jira blocker evidence" })).toHaveCount(0);
    await unknownAnswer.getByText("Draft a question for the assigned PM", { exact: true }).click();
    await expect(unknownAnswer.getByText("What caused the forecast finish date to move from 2026-10-15 to 2026-10-29? Please link the evidence that confirms the cause.", { exact: true })).toBeVisible();
    const saved = unknownCausePage.waitForResponse((response) =>
      response.url().endsWith(delayClarificationPath) && response.request().method() === "POST");
    await unknownAnswer.getByRole("button", { name: "Ask the assigned PM" }).click();
    const submitted = await saved;
    expect(submitted.status()).toBe(200);
    savedDelayClarification = await submitted.json();
    expect(savedDelayClarification).toMatchObject({ id: expect.any(String), schedule: unknownFacts.schedule });
    await expect(unknownAnswer).toContainText("Clarification added to the assigned PM’s Atlas project panel.");
  } finally {
    await unknownCausePage.close();
    await leaderAccess(true, fixture.jiraIntake.factSourceId, fixture.jiraIntake.sourceReaders);
  }
  const clarificationReplay = await request.post(delayClarificationPath, { headers: leaderHeaders, data: clarificationCommand });
  expect(clarificationReplay.status()).toBe(200);
  expect(await clarificationReplay.json()).toEqual(savedDelayClarification);
  const assignedClarification = await request.get(delayClarificationPath, { headers: managerHeaders });
  expect(assignedClarification.status()).toBe(200);
  expect(await assignedClarification.json()).toEqual(savedDelayClarification);
  const pmClarificationPage = await page.context().newPage();
  try {
    await pmClarificationPage.goto("/");
    await pmClarificationPage.getByRole("button", { name: /Project manager/ }).click();
    await pmClarificationPage.getByRole("button", { name: /Atlas · Delivery approval/ }).click();
    const pmClarification = pmClarificationPage.getByRole("region", { name: "Leadership clarification" });
    await expect(pmClarification).toContainText("What caused the forecast finish date to move from 2026-10-15 to 2026-10-29?");
  } finally {
    await pmClarificationPage.close();
  }
  const originalDraft = await request.post(reportPath, { headers: leaderHeaders, data: {} });
  expect(originalDraft.status()).toBe(200);
  const originalReport = await originalDraft.json();
  expect(originalReport.snapshot.delayAssessment).toBeNull();

  const delayForm = approval.getByRole("region", { name: "Atlas delay assessment" });
  await expect(delayForm).toContainText("Baseline 2026-10-15. Forecast 2026-10-29.");
  const confirmDelay = delayForm.getByRole("button", { name: "Confirm API access caused the delay" });
  await expect(confirmDelay).toBeDisabled();
  await delayForm.getByRole("combobox", { name: "Forecast confidence" }).selectOption("MEDIUM");
  const delayCommand = { approvalId, receiptId: receipt.id, scheduleRevision: originalReport.snapshot.schedule.revision,
    cause: "API_ACCESS_DELAY", confidence: "MEDIUM" };
  expect((await request.post(delayPath, { headers: leaderHeaders, data: delayCommand })).status()).toBe(404);
  expect((await request.post(delayPath, {
    headers: managerHeaders, data: { ...delayCommand, scheduleRevision: delayCommand.scheduleRevision + 1 },
  })).status()).toBe(409);
  await confirmDelay.click();
  await expect(delayForm).toContainText("PM delay assessment recorded. Forecast confidence is medium.");
  const resolvedClarification = await request.get(delayClarificationPath, { headers: managerHeaders });
  expect(resolvedClarification.status()).toBe(200);
  expect(await resolvedClarification.json()).toBeNull();
  expect((await request.post(delayClarificationPath, { headers: leaderHeaders, data: clarificationCommand })).status()).toBe(409);
  const genericAtlasDelayPath = projectPath + "/delay-clarification";
  expect((await request.get(genericAtlasDelayPath, { headers: managerHeaders })).status()).toBe(404);
  expect((await request.post(genericAtlasDelayPath, { headers: leaderHeaders, data: clarificationCommand })).status()).toBe(404);
  const delayReplay = await request.post(delayPath, { headers: managerHeaders, data: delayCommand });
  expect(delayReplay.status()).toBe(200);
  const assessment = await delayReplay.json();
  expect(assessment).toMatchObject({ ...delayCommand, confirmedBy: "pm-atlas", id: expect.any(String) });
  await expect(delayForm).toContainText(assessment.id);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Leadership/ }).click();
  await page.getByRole("button", { name: /Atlas · Delivery approval/ }).click();
  const answer = page.getByRole("region", { name: "Atlas leadership answer" });
  await answer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
  await expect(answer).toContainText("14 days later");
  await expect(answer).toContainText("The latest saved assessment marked the project update stale.");
  await expect(answer).toContainText("A clarification about the forecast finish date is open.");
  await expect(answer).toContainText("A project update remains due.");
  await expect(answer).toContainText("Integration testing started late.");
  await expect(answer).toContainText("The synthetic Jira blocker ATLAS-248 is open.");
  await expect(answer).toContainText("API access was pending at the time of the reply");
  await expect(answer).toContainText("A simulated escalation was captured for the assigned PM.");
  await expect(answer).toContainText("The PM confirmed that delayed API access caused the go-live delay.");
  await expect(answer).toContainText("The PM assessed forecast confidence as medium.");
  await expect(answer.getByText("Draft a question for the assigned PM", { exact: true })).toHaveCount(0);
  for (const [label, evidence] of [
    ["Schedule evidence", `Baseline 2026-10-15. Forecast 2026-10-29. Reviewed portfolio CSV receipt ${spreadsheet.receiptId}`],
    ["Update freshness evidence", `Assessed at ${before.updateFreshness.assessedAt}. Latest verified update at ${fixture.lastPmUpdateAt}.`],
    ["Integration start evidence", "Planned start 2026-10-05. Actual start 2026-10-08."],
    ["Jira blocker evidence", "Synthetic Jira issue ATLAS-248, recorded in source mapping"],
    ["Reply evidence", "Human-confirmed owner reply"],
    ["Receipt evidence", receipt.id],
    ["PM escalation evidence", `${fixture.escalation.requestId}, captured at ${fixture.escalation.capturedAt}`],
    ["PM assessment evidence", assessment.id],
  ]) {
    const link = answer.getByRole("link", { name: label! });
    const anchor = await link.getAttribute("href");
    expect(anchor).toMatch(/^#atlas-/);
    await expect(answer.locator(anchor!)).toContainText(evidence!);
  }
  await expect(answer).not.toContainText(/access was restored|developer|budget/i);
  await expect(answer).not.toContainText(fixture.sourceMarkerA);
  await expect(answer).not.toContainText(fixture.sourceMarkerB);
  await expect(answer.locator(`#atlas-blocker-${fixture.projectId}`)).toContainText("System verified.");
  await expect(page.locator("body")).not.toContainText(text);
  const completeAnswer = await request.get(answerPath, { headers: leaderHeaders });
  expect(completeAnswer.status()).toBe(200);
  const complete = await completeAnswer.json();
  expect(complete.pmEscalation).toEqual({
    requestId: fixture.escalation.requestId, capturedAt: fixture.escalation.capturedAt, availableUntil: expect.any(String),
  });
  expect(JSON.stringify(complete)).not.toContain(fixture.escalation.locator);
  expect(JSON.stringify(complete)).not.toContain(fixture.sourceMarkerB);
  expect(JSON.stringify(complete)).not.toContain(editedComment);
  const jiraAccess = (allowed: boolean) => leaderAccess(allowed, fixture.jiraIntake.factSourceId, fixture.jiraIntake.sourceReaders);
  await jiraAccess(false);
  try {
    const withheld = await request.get(answerPath, { headers: leaderHeaders });
    expect(withheld.status()).toBe(200);
    expect(await withheld.json()).toMatchObject({ jiraBlocker: null, schedule: complete.schedule });
    await answer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
    await expect(answer.getByRole("link", { name: "Schedule evidence" })).toBeVisible();
    await expect(answer.getByText("The synthetic Jira blocker ATLAS-248 is open.", { exact: true })).toHaveCount(0);
    await expect(answer.getByRole("link", { name: "Jira blocker evidence" })).toHaveCount(0);
  } finally {
    await jiraAccess(true);
  }
  await leaderAccess(false, fixture.sourceB.sourceId);
  try {
    await answer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
    await expect(answer).toContainText("PM escalation evidence is unavailable.");
    await expect(answer.getByRole("link", { name: "PM escalation evidence" })).toHaveCount(0);
    await expect(answer).toContainText("The PM confirmed that delayed API access caused the go-live delay.");
    await expect(answer.getByRole("link", { name: "Jira blocker evidence" })).toBeVisible();
  } finally {
    await leaderAccess(true, fixture.sourceB.sourceId);
  }
  await answer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
  await expect(answer.getByRole("link", { name: "PM escalation evidence" })).toBeVisible();

  const report = page.getByRole("region", { name: "Atlas management snapshot" });
  const reportSaved = page.waitForResponse((value) => value.url().endsWith(reportPath) && value.request().method() === "POST");
  await report.getByRole("button", { name: "Save draft snapshot" }).click();
  const saved = await reportSaved;
  expect(saved.status()).toBe(200);
  const { snapshot, highlights, livePath } = await saved.json();
  expect(snapshot).toMatchObject({
    schedule: { movementDays: 14 }, ownerReply: { accessStatus: "ACCESS_PENDING" }, receipt, delayAssessment: assessment, approvalState: "DRAFT",
    scheduleCitation: before.scheduleCitation,
  });
  expect(snapshot.id).not.toBe(originalReport.snapshot.id);
  const earlier = await request.get(`${reportPath}?snapshotId=${originalReport.snapshot.id}`, { headers: leaderHeaders });
  expect(earlier.status()).toBe(200);
  expect(await earlier.json()).toMatchObject({ snapshot: originalReport.snapshot, highlights: originalReport.highlights });
  const sources = await request.get("/api/ingestion/sources", { headers: reviewerHeaders });
  expect(sources.status()).toBe(200);
  const { configuration } = (await sources.json()).find((source: { sourceId: string }) => source.sourceId === spreadsheet.sourceId);
  const configureSpreadsheet = (allowed: boolean) => request.post("/api/ingestion/sources/configuration", {
    headers: reviewerHeaders,
    data: { ...configuration, projects: configuration.projects.map((project: { readers: string[] }) => ({
      ...project, readers: project.readers.filter((subject) => allowed || subject !== "leader-atlas"),
    })) },
  });
  expect((await configureSpreadsheet(false)).status()).toBe(201);
  try {
    await answer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
    await expect(answer).toContainText("Schedule movement is unavailable.");
    await expect(answer.getByRole("link", { name: "Schedule evidence" })).toHaveCount(0);
    await expect(answer).not.toContainText(spreadsheet.receiptId);
    expect((await request.get(`${reportPath}?snapshotId=${snapshot.id}`, { headers: leaderHeaders })).status()).toBe(404);
  } finally {
    expect((await configureSpreadsheet(true)).status()).toBe(201);
  }
  await answer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
  await expect(answer.locator(`#atlas-schedule-${fixture.projectId}`)).toContainText(spreadsheet.receiptId);
  await expect(report).toContainText(snapshot.id);
  await expect(report).toContainText("14 days later");
  const email = report.locator("details");
  const retry = await request.post(reportPath, { headers: leaderHeaders, data: {} });
  expect(retry.status()).toBe(200);
  expect((await retry.json()).snapshot).toEqual(snapshot);
  expect(await (await request.get(reportReviewPath, { headers: managerHeaders })).json()).toBeNull();
  await report.getByRole("button", { name: "Request final approval" }).click();
  await expect(report).toContainText("Awaiting PM approval");
  const pendingReview = await request.get(reportReviewPath, { headers: managerHeaders });
  expect(pendingReview.status()).toBe(200);
  const proposed = (await pendingReview.json()).snapshot;
  expect(proposed).toMatchObject({ ...snapshot, approvalState: "PENDING", approval: { approver: "pm-atlas", decidedAt: null } });
  const submitReport = (snapshotId: string) => request.post(`${reportPath}/approval-request`, {
    headers: leaderHeaders, data: { snapshotId },
  });
  expect((await (await submitReport(snapshot.id)).json()).snapshot).toEqual(proposed);
  const approve = { snapshotId: snapshot.id, requestId: proposed.approval.requestId, decision: "APPROVED" };
  const distributionVersion = { snapshotId: snapshot.id, requestId: proposed.approval.requestId };
  const distribute = () => request.post(distributionPath, { headers: managerHeaders, data: distributionVersion });
  expect((await distribute()).status()).toBe(409);
  expect((await request.post(distributionPath, { headers: leaderHeaders, data: distributionVersion })).status()).toBe(404);
  expect(await (await request.get(distributionPath, { headers: leaderHeaders })).json()).toBeNull();
  expect((await request.post(reportReviewPath, { headers: leaderHeaders, data: approve })).status()).toBe(404);
  expect((await request.post(reportReviewPath, {
    headers: managerHeaders, data: { ...approve, requestId: randomUUID() },
  })).status()).toBe(409);

  await page.goto(livePath);
  await page.getByRole("button", { name: /Project manager/ }).click();
  const pmReport = page.getByRole("region", { name: "Atlas final report approval" });
  await expect(pmReport).toContainText(snapshot.id);
  await expect(pmReport).toContainText(highlights[0]);
  await expect(pmReport).not.toContainText(text);
  await pmReport.getByRole("button", { name: "Approve final report" }).click();
  await expect(pmReport).toContainText("Final · Approved");
  const approvalReplay = await request.post(reportReviewPath, { headers: managerHeaders, data: approve });
  expect(approvalReplay.status()).toBe(200);
  const finalReport = (await approvalReplay.json()).snapshot;
  expect(finalReport).toEqual({ ...proposed, approvalState: "APPROVED",
    approval: { ...proposed.approval, decidedAt: expect.any(String) } });
  expect((await request.post(reportReviewPath, {
    headers: managerHeaders, data: { ...approve, decision: "REJECTED" },
  })).status()).toBe(409);

  await leaderAccess(false);
  try {
    expect((await distribute()).status()).toBe(404);
  } finally {
    await leaderAccess(true);
  }
  await pmReport.getByRole("button", { name: "Distribute to Atlas Leadership" }).click();
  await expect(pmReport).toContainText("Distributed to Atlas Leadership at");
  const distributed = await request.get(reportReviewPath, { headers: managerHeaders });
  expect(distributed.status()).toBe(200);
  const delivery = (await distributed.json()).distribution;
  expect(delivery).toMatchObject({ ...distributionVersion, recipient: "leader-atlas", id: expect.any(String) });
  const distributionReplay = await distribute();
  expect(distributionReplay.status()).toBe(200);
  expect(await distributionReplay.json()).toEqual(delivery);
  expect((await request.get(distributionPath, { headers: managerHeaders })).status()).toBe(404);

  await page.goto(livePath);
  await page.getByRole("button", { name: /Leadership/ }).click();
  await expect(report).toContainText("Final · Approved");
  await email.getByText("Leadership email preview").click();
  await expect(email).toContainText("Final · Approved");
  await expect(email).toContainText(snapshot.id);
  await expect(email).toContainText(highlights[0]);
  const sourceDeadline = `Evidence availability ends ${snapshot.ownerReply.availableUntil}.`;
  await expect(report).toContainText(sourceDeadline);
  await expect(email).toContainText(sourceDeadline);
  await expect(email.getByRole("link")).toHaveAttribute("href", livePath);
  await expect(report).not.toContainText(text);
  const inbox = page.getByRole("region", { name: "Atlas report inbox" });
  await expect(inbox).toContainText("Final · Approved");
  await expect(inbox).toContainText(snapshot.id);
  await expect(inbox).toContainText(delivery.id);
  await expect(inbox).not.toContainText(text);
  await inbox.screenshot({ path: "artifacts/atlas-management-snapshot.png" });
  const downloadReady = page.waitForEvent("download");
  await inbox.getByRole("button", { name: "Download distributed PowerPoint" }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toBe(`atlas-${snapshot.id}.pptx`);
  const slide = await readSlide((await download.path())!);
  expect(slide).toContain("<a:t>Atlas management snapshot</a:t>");
  expect(slide).toContain(snapshot.id);
  expect(slide).toContain(snapshot.asOf);
  expect(slide).toContain(snapshot.reportingPeriod);
  expect(slide).toContain("Final • Approved");
  expect(slide).toContain(finalReport.approval.decidedAt);
  expect(slide).toContain(assessment.id);
  expect(slide).toContain(snapshot.ownerReply.receivedAt);
  expect(slide).toContain(sourceDeadline);
  for (const highlight of highlights) expect(slide).toContain(highlight);

  const owner = await request.post("/api/auth/development", { data: { persona: "owner-atlas" } });
  expect(owner.status()).toBe(200);
  const ownerHeaders = { Authorization: "Bearer " + (await owner.json()).token };
  const laterReply = await request.post(invitationPath + "/responses", { headers: ownerHeaders, data: {
    text: "Infrastructure restored API access.", idempotencyKey: randomUUID(), correctsResponseId: null,
  } });
  expect(laterReply.status()).toBe(201);
  expect((await record()).status()).toBe(409);
  const laterConfirmation = await request.post(invitationPath + "/atlas-confirmation", { headers: ownerHeaders, data: {
    responseId: (await laterReply.json()).responseId, accessStatus: "ACCESS_RESTORED",
  } });
  expect(laterConfirmation.status()).toBe(200);
  const nextPreview = await request.get(projectPath + "/atlas-approval", { headers: managerHeaders });
  expect(nextPreview.status()).toBe(200);
  const nextComment = await nextPreview.json();
  expect(nextComment).toMatchObject({
    sourceRevision: 1, currentComment: editedComment,
    decision: "PENDING", receipt: null,
  });
  const pending = await request.get(answerPath, { headers: leaderHeaders });
  expect(pending.status()).toBe(200);
  const pendingAnswer = await pending.json();
  expect(pendingAnswer).toMatchObject({ ownerReply: null, receipt: null, delayClarificationState: "RESOLVED" });
  expect(pendingAnswer.updateFreshness).not.toHaveProperty("activeClarification");
  const afterReplacement = await request.get(delayClarificationPath, { headers: managerHeaders });
  expect(afterReplacement.status()).toBe(200);
  expect(await afterReplacement.json()).toBeNull();
  expect((await request.post(delayClarificationPath, { headers: leaderHeaders, data: clarificationCommand })).status()).toBe(409);
  const restoredComment = "API access was restored. Infrastructure will verify access with the integration team.";
  expect((await request.post(projectPath + "/atlas-approval", {
    headers: managerHeaders, data: { approvalId: nextComment.approvalId, decision: "APPROVED", proposedComment: restoredComment },
  })).status()).toBe(200);

  const changedSourceComment = "Infrastructure recorded a verification window for restored access.";
  const db = createDatabase(target.toString());
  try {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM public."Project" WHERE "customerId"=${fixture.customerId}::uuid
        AND id=${fixture.projectId}::uuid FOR UPDATE`;
      await tx.auditEvent.create({ data: { customerId: fixture.customerId, actor: "atlas-jira-fixture",
        event: "atlas_demo.fixture.changed", correlationId: randomUUID(),
        detail: { projectId: fixture.projectId, fixtureRevision: 2, comment: changedSourceComment },
      } });
    });
  } finally { await db.$disconnect(); }
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager/ }).click();
  await page.getByRole("button", { name: /Atlas · Delivery approval/ }).click();
  const staleExecution = page.waitForResponse((response) =>
    response.url().endsWith(receiptPath) && response.request().method() === "POST");
  await approval.getByRole("button", { name: "Record simulated comment" }).click();
  expect((await staleExecution).status()).toBe(409);
  await expect(approval).toContainText("The Jira fixture changed. Review the updated diff and approve it again.");
  await expect(approval).toContainText(changedSourceComment);
  await expect(approval.getByRole("button", { name: "Record simulated comment" })).toHaveCount(0);
  expect((await request.post(receiptPath, {
    headers: managerHeaders, data: { approvalId: nextComment.approvalId },
  })).status()).toBe(409);
  const refreshed = await request.get(projectPath + "/atlas-approval", { headers: managerHeaders });
  expect(refreshed.status()).toBe(200);
  const newComparison = await refreshed.json();
  expect(newComparison).toMatchObject({ responseId: nextComment.responseId, replacesApprovalId: nextComment.approvalId,
    sourceRevision: 2, currentComment: changedSourceComment, proposedComment: restoredComment, decision: "PENDING", receipt: null });
  expect(newComparison.approvalId).not.toBe(nextComment.approvalId);
  await approval.getByRole("button", { name: "Approve demo comment" }).click();
  await expect(approval).toContainText("Demo approval recorded.");

  // Simulate a lost acknowledgement using the two durable checkpoints. An
  // attempt without a verifiable effect must never post again.
  const recovery = createDatabase(target.toString());
  const recoveryScope = {
    customerId: fixture.customerId, actor: "pm-atlas",
    AND: [{ detail: { path: ["projectId"], equals: fixture.projectId } },
      { detail: { path: ["approvalId"], equals: newComparison.approvalId } }],
  };
  const retryReceipt = () => request.post(receiptPath, { headers: managerHeaders, data: { approvalId: newComparison.approvalId } });
  try {
    const decision = await recovery.auditEvent.findFirstOrThrow({
      where: { ...recoveryScope, event: "atlas_demo.approval.decided" },
    });
    const { captureIssuanceEpoch, payloadDigest } = decision.detail as { captureIssuanceEpoch: string; payloadDigest: string };
    const marker = "pdaa-atlas:" + newComparison.approvalId;
    const evidence = { projectId: fixture.projectId, approvalId: newComparison.approvalId, responseId: newComparison.responseId,
      decisionId: decision.id, captureIssuanceEpoch, payloadDigest, marker };
    const attempt = await recovery.auditEvent.create({
      data: { customerId: fixture.customerId, actor: recoveryScope.actor, correlationId: randomUUID(),
        event: "atlas_demo.comment.attempt_started", detail: { ...evidence, target: newComparison.target, sourceRevision: 2 } },
    });
    expect((await retryReceipt()).status()).toBe(409);
    expect(await recovery.auditEvent.count({ where: { ...recoveryScope, event: "atlas_demo.fixture.comment_posted" } })).toBe(0);
    await recovery.auditEvent.create({
      data: { customerId: fixture.customerId, actor: recoveryScope.actor, correlationId: randomUUID(),
        event: "atlas_demo.fixture.comment_posted", detail: { ...evidence, attemptId: attempt.id, fixtureRevision: 3,
          accessStatus: "ACCESS_RESTORED", template: "atlas-comment@1" } },
    });
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await approval.getByRole("button", { name: "Check simulated comment receipt" }).click();
    await expect(receiptPanel).toBeVisible();
    expect(await recovery.auditEvent.count({ where: { ...recoveryScope, event: "atlas_demo.fixture.comment_posted" } })).toBe(1);
    const recorded = await recovery.auditEvent.findFirstOrThrow({ where: { ...recoveryScope, event: "atlas_demo.comment.recorded" } });
    expect(recorded.detail).toMatchObject({ approvalId: newComparison.approvalId, decisionId: decision.id,
      responseId: newComparison.responseId, fixtureRevision: 3, payloadDigest });
  } finally { await recovery.$disconnect(); }
  await expect(receiptPanel).toContainText("Fixture revision");
  expect(await (await retryReceipt()).json()).toMatchObject({ approvalId: newComparison.approvalId, fixtureRevision: 3, result: "SIMULATED" });
  const newerDraft = await request.post(reportPath, { headers: leaderHeaders, data: {} });
  expect(newerDraft.status()).toBe(200);
  const newer = (await newerDraft.json()).snapshot;
  expect(newer.id).not.toBe(snapshot.id);
  expect(newer).toMatchObject({ approvalState: "DRAFT", delayAssessment: null, ownerReply: { accessStatus: "ACCESS_RESTORED" } });
  const newerSubmission = await submitReport(newer.id);
  expect(newerSubmission.status()).toBe(200);
  const newerRequestId = (await newerSubmission.json()).snapshot.approval.requestId;
  expect((await request.post(reportReviewPath, { headers: managerHeaders, data: approve })).status()).toBe(409);
  const rejection = await request.post(reportReviewPath, {
    headers: managerHeaders, data: { snapshotId: newer.id, requestId: newerRequestId, decision: "REJECTED" },
  });
  expect(rejection.status()).toBe(200);
  expect((await rejection.json()).snapshot).toMatchObject({ id: newer.id, approvalState: "REJECTED" });
  expect((await request.post(distributionPath, {
    headers: managerHeaders, data: { snapshotId: newer.id, requestId: newerRequestId },
  })).status()).toBe(409);
  const finalPath = `${reportPath}?snapshotId=${snapshot.id}`;
  const frozen = await request.get(finalPath, { headers: leaderHeaders });
  expect(frozen.status()).toBe(200);
  expect(await frozen.json()).toMatchObject({ snapshot: finalReport, highlights, livePath });

  const delivered = await request.get(distributionPath, { headers: leaderHeaders });
  expect(delivered.status()).toBe(200);
  expect(await delivered.json()).toMatchObject({ snapshot: finalReport, highlights, distribution: delivery });

  const comparePath = `${answerPath}?priorSnapshotId=${snapshot.id}`;
  const compared = await request.get(comparePath, { headers: leaderHeaders });
  expect(compared.status()).toBe(200);
  expect(await compared.json()).toMatchObject({
    ownerReply: { accessStatus: "ACCESS_RESTORED" }, receipt: { fixtureRevision: 3 },
    priorSnapshot: { id: snapshot.id, facts: {
      asOf: snapshot.asOf, ownerReply: { accessStatus: "ACCESS_PENDING" }, receipt: { fixtureRevision: 1 },
    } },
  });
  expect((await request.get(comparePath, { headers: managerHeaders })).status()).toBe(404);
  expect((await request.get(`${answerPath}?priorSnapshotId=${randomUUID()}`, { headers: leaderHeaders })).status()).toBe(404);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Leadership/ }).click();
  await page.getByRole("button", { name: /Atlas · Delivery approval/ }).click();
  await page.getByLabel("Saved snapshot ID").fill(snapshot.id);
  await page.getByRole("button", { name: "Compare with current facts" }).click();
  const changes = page.getByRole("region", { name: "Changes since the saved snapshot" });
  const access = changes.getByRole("row").filter({ hasText: "Owner-confirmed API access" });
  await expect(access.getByRole("cell", { name: "Pending" })).toBeVisible();
  await expect(access.getByRole("cell", { name: "Restored" })).toBeVisible();
  await expect(changes).toContainText(snapshot.id);
  await answer.getByText("Draft a question for the assigned PM", { exact: true }).click();
  await expect(answer).toContainText("The request for this schedule has been answered.");
  await expect(answer.getByRole("button", { name: "Ask the assigned PM", includeHidden: true })).toHaveCount(0);

  await leaderAccess(false);
  expect((await request.get(answerPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(comparePath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(reportPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(finalPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(distributionPath, { headers: leaderHeaders })).status()).toBe(404);

  await leaderAccess(true);
  const capturedEvidence = await request.post(`${projectPath}/assessments`, {
    headers: leaderHeaders,
    data: { projectId: fixture.projectId, factType: "project.status", idempotencyKey: randomUUID() },
  });
  expect(capturedEvidence.status()).toBe(201);
  const { assessmentId } = await capturedEvidence.json();
  const copiedEvidence = `${projectPath}/assessments/${assessmentId}`;
  const authorizedEvidence = await request.get(copiedEvidence, { headers: leaderHeaders });
  expect(authorizedEvidence.status()).toBe(200);
  expect(await authorizedEvidence.json()).toMatchObject({ assessmentId, result: { status: "RESOLVED" } });
  expect((await request.get(comparePath, { headers: leaderHeaders })).status()).toBe(200);

  let allowedProjectId: string;
  let delayEvidence: { sourceId: string; sourceAccessRevision: number; id: string; evidenceId: string };
  const causeText = "The test environment was unavailable during integration.";
  const causeFactType = "project.delay_cause";
  const causeReaders = ["pm-atlas", "leader-atlas"];
  const scopePolicy = { expectedRevision: 0, freshnessWindowSeconds: 7 * 86400,
    timeZone: "UTC", requiredFacts: [{ factType: "project.status", label: "Current status" }],
    responsibleSubject: "synthetic-owner-4", scheduledScanEnabled: false };
  const scopeDb = createDatabase(target.toString());
  try {
    const atlas = await scopeDb.project.findFirstOrThrow({ where: { customerId: fixture.customerId, id: fixture.projectId },
      select: { portfolioId: true } });
    const canonical = canonicalFixture(atlas.portfolioId);
    const created = await new DatabaseCanonicalProjectRepository(scopeDb).createProject(fixture.admin, {
      ...canonical, code: "SCOPE-CHECK", name: "Second synthetic project",
      responsibilities: canonical.responsibilities.map((role) =>
        role.role === "PROJECT_MANAGER" ? { ...role, subject: "pm-atlas" } : role),
      raidItems: [...canonical.raidItems,
        { key: "D-01", kind: "DECISION", title: "Confirm\u0085the integration environment",
          state: "OPEN", description: "", ownerSubject: null },
        { key: "D-02", kind: "DECISION", title: "Completed budget decision",
          state: "COMPLETE", description: "", ownerSubject: null }],
    }, randomUUID());
    allowedProjectId = created.id;
    const updates = new DatabaseProjectUpdateRepository(scopeDb);
    await updates.setPolicy(fixture.admin, allowedProjectId, scopePolicy, randomUUID());
    await updates.assess(fixture.admin, allowedProjectId, randomUUID());
    await scopeDb.$transaction(async (tx) => {
      const grant = { customerId: fixture.customerId, subject: "leader-atlas", scopeType: "project", role: "leadership" };
      await tx.accessGrant.create({ data: { ...grant, scopeId: allowedProjectId } });
      await tx.accessGrant.create({ data: { ...grant, subject: "pm-atlas", scopeId: allowedProjectId, role: "project_manager" } });
      const removed = await tx.accessGrant.deleteMany({ where: { ...grant, scopeId: fixture.projectId } });
      expect(removed.count).toBe(1);
    });
    const recordedAt = new Date().toISOString();
    const facts = new DatabaseProjectFactRepository(scopeDb);
    const manager = { customerId: fixture.customerId, subject: "pm-atlas", roles: ["project_manager"] };
    const { entry } = await facts.appendHumanStatement(manager, {
      projectId: allowedProjectId, factType: causeFactType, expectedRevision: 0, idempotencyKey: randomUUID(),
      effectiveAt: recordedAt, value: { type: "text", value: causeText }, originalStatement: causeText,
    }, { correlationId: randomUUID() });
    const access = await facts.setSourceAccess(fixture.admin, {
      projectId: allowedProjectId, sourceId: entry.sourceId, expectedRevision: entry.sourceAccessRevision,
      state: "AVAILABLE", readers: causeReaders,
    }, { correlationId: randomUUID() });
    delayEvidence = { ...entry, sourceAccessRevision: access.revision };
    await new DatabaseAuthorityRepository(scopeDb).appendPolicy(fixture.admin, {
      projectId: allowedProjectId, factType: causeFactType, expectedRevision: 0, idempotencyKey: randomUUID(),
      effectiveAt: recordedAt, definition: { tiers: [{ selectors: [{ sourceType: "human_statement",
        instanceId: entry.sourceId, requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 86400_000 } }] }],
        conflictBehavior: "REQUEST_RECONCILIATION" },
    }, { correlationId: randomUUID() });
  } finally { await scopeDb.$disconnect(); }
  const visibleProjects = await request.get("/api/projects", { headers: leaderHeaders });
  expect(visibleProjects.status()).toBe(200);
  expect(await visibleProjects.json()).toEqual([expect.objectContaining({ id: allowedProjectId, name: "Second synthetic project" })]);
  expect((await request.get(`/api/projects/${allowedProjectId}`, { headers: leaderHeaders })).status()).toBe(200);

  const missingProject = `/api/projects/${randomUUID()}`;
  for (const path of [answerPath, comparePath, finalPath, copiedEvidence]) {
    const [deniedProject, missing] = await Promise.all([path, path.replace(projectPath, missingProject)].map((url) =>
      request.get(url, { headers: leaderHeaders })));
    expect(deniedProject.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await deniedProject.json()).toEqual(await missing.json());
  }
  const genericQuestion = { question: "Why is this project delayed?" };
  const [forbiddenAnswer, absentAnswer] = await Promise.all([projectPath, missingProject].map((path) =>
    request.post(`${path}/leadership-answer`, { headers: leaderHeaders, data: genericQuestion })));
  expect(forbiddenAnswer.status()).toBe(404);
  expect(absentAnswer.status()).toBe(404);
  expect(await forbiddenAnswer.json()).toEqual(await absentAnswer.json());

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Leadership/ }).click();
  await page.getByRole("button", { name: /Second synthetic project/ }).click();
  const projectAnswer = page.getByRole("region", { name: "Project leadership answer" });
  await projectAnswer.getByLabel("Project question").fill(genericQuestion.question);
  await projectAnswer.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(projectAnswer).toContainText("The forecast is 15 days later than the baseline.");
  await expect(projectAnswer).toContainText("The cause of the delay is unknown.");
  await expect(projectAnswer).toContainText("Baseline 2026-06-30. Forecast 2026-07-15.");
  await expect(projectAnswer).toContainText("The latest saved assessment found the project current under its update policy.");
  await expect(projectAnswer.getByRole("link", { name: "Update evidence" })).toHaveAttribute("href", `#project-answer-update-${allowedProjectId}`);
  const projectDelayPath = `/api/projects/${allowedProjectId}/delay-clarification`;
  const emptyDelayReview = await request.get(projectDelayPath, { headers: managerHeaders });
  expect(emptyDelayReview.status()).toBe(200);
  expect(await emptyDelayReview.json()).toBeNull();
  await projectAnswer.getByText("Draft a question for the assigned PM", { exact: true }).click();
  const questionText = "What caused the forecast finish date to move from 2026-06-30 to 2026-07-15? Please link the evidence that confirms the cause.";
  await expect(projectAnswer).toContainText(questionText);
  const savedDelayRequest = page.waitForResponse((response) => response.url().endsWith(projectDelayPath));
  await projectAnswer.getByRole("button", { name: "Ask the assigned PM" }).click();
  const delayResponse = await savedDelayRequest;
  expect(delayResponse.status()).toBe(200);
  const delayRequest = await delayResponse.json();
  await expect(projectAnswer).toContainText(`Delay evidence requested. Request ${delayRequest.id}.`);
  const rereadDelay = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${allowedProjectId}/leadership-answer`));
  await projectAnswer.getByRole("button", { name: "Ask", exact: true }).click();
  expect(await (await rereadDelay).json()).toMatchObject({ cause: "UNKNOWN", pendingDelayClarification: delayRequest });
  await expect(projectAnswer).toContainText(`Delay evidence requested. Request ${delayRequest.id}.`);
  await expect(projectAnswer.getByRole("button", { name: "Ask the assigned PM", includeHidden: true })).toHaveCount(0);
  const pmScheduleAnswer = await request.post(`/api/projects/${allowedProjectId}/leadership-answer`, {
    headers: managerHeaders, data: genericQuestion,
  });
  expect(pmScheduleAnswer.status()).toBe(200);
  expect(await pmScheduleAnswer.json()).not.toHaveProperty("pendingDelayClarification");
  const projectDelayCommand = { scheduleRevision: delayRequest.schedule.revision };
  const replayedDelay = await request.post(projectDelayPath, { headers: leaderHeaders, data: projectDelayCommand });
  expect(replayedDelay.status()).toBe(200);
  expect(await replayedDelay.json()).toEqual(delayRequest);
  expect((await request.post(projectDelayPath, { headers: leaderHeaders,
    data: { scheduleRevision: projectDelayCommand.scheduleRevision + 1 } })).status()).toBe(409);
  expect((await request.post(projectDelayPath, { headers: managerHeaders, data: projectDelayCommand })).status()).toBe(404);
  expect((await request.get(projectDelayPath, { headers: leaderHeaders })).status()).toBe(404);
  const unsupported = "Compare this project with confidential Project Draco.";
  await projectAnswer.getByLabel("Project question").fill(unsupported);
  await projectAnswer.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(projectAnswer).toContainText("Ask about the current schedule or delay for the selected project.");
  await expect(projectAnswer.getByRole("link", { name: "Schedule evidence" })).toHaveCount(0);

  const draftPath = `/api/projects/${allowedProjectId}/management-draft`;
  const hiddenDraft = await request.get(projectPath + "/management-draft", { headers: leaderHeaders });
  expect(hiddenDraft.status()).toBe(404);
  const draftPanel = page.getByRole("region", { name: "Project management draft" });
  const receivedDraft = page.waitForResponse((response) => response.url().endsWith(draftPath));
  await draftPanel.getByRole("button", { name: "Preview management draft" }).click();
  const draftResponse = await receivedDraft;
  expect(draftResponse.status()).toBe(200);
  const { draft, highlights: draftHighlights } = await draftResponse.json();
  expect(draft).toMatchObject({ approvalState: "DRAFT", projectId: allowedProjectId,
    project: { code: "SCOPE-CHECK", name: "Second synthetic project" },
    schedule: { baseline: "2026-06-30", forecast: "2026-07-15", movementDays: 15 },
    updateFreshness: { state: "CURRENT", sourceDateField: "project.createdAt" },
    digest: { previousReport: null, decisions: [
      { key: "D-01", title: "Confirm the integration environment" },
      { key: "RAID-4", title: "Synthetic DECISION" },
    ], moreDecisions: false } });
  await expect(draftPanel).toContainText(`Draft · Reporting month ${draft.reportingPeriod}`);
  const draftEmail = draftPanel.locator("details");
  await draftEmail.getByText("Leadership email preview").click();
  await expect(draftEmail.getByRole("link")).toHaveAttribute("href", `/?project=${allowedProjectId}`);
  await expect(draftEmail).toContainText("Open decision D-01 · Confirm the integration environment");
  await expect(draftEmail).not.toContainText("Completed budget decision");
  const draftDownloadReady = page.waitForEvent("download");
  await draftPanel.getByRole("button", { name: "Download editable PowerPoint" }).click();
  const draftDownload = await draftDownloadReady;
  expect(draftDownload.suggestedFilename()).toBe(`project-${allowedProjectId}-${draft.reportingPeriod}-draft.pptx`);
  const draftSlide = await readSlide((await draftDownload.path())!);
  expect(draftSlide).toContain("Second synthetic project (SCOPE-CHECK)");
  expect(draftSlide).toContain(`Draft • Reporting month ${draft.reportingPeriod}`);
  expect(draftSlide).toContain(draft.asOf);
  for (const highlight of draftHighlights) {
    await expect(draftPanel).toContainText(highlight);
    await expect(draftEmail).toContainText(highlight);
    expect(draftSlide).toContain(highlight);
  }
  const saveResult = page.waitForResponse((response) => response.url().endsWith(draftPath) && response.request().method() === "POST");
  await draftPanel.getByRole("button", { name: "Save snapshot" }).click();
  const savedResponse = await saveResult;
  expect(savedResponse.status()).toBe(200);
  const savedReport = await savedResponse.json();
  expect(savedReport.snapshotId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(savedReport.draft).toEqual({ ...draft, asOf: savedReport.draft.asOf });
  await expect(draftPanel).toContainText(savedReport.snapshotId);
  const replayedSave = await request.post(draftPath, { headers: leaderHeaders, data: draft });
  expect(replayedSave.status()).toBe(200);
  expect(await replayedSave.json()).toMatchObject({ snapshotId: savedReport.snapshotId, draft: savedReport.draft });

  await draftPanel.getByRole("button", { name: "Preview management draft" }).click();
  await expect(draftPanel.getByRole("button", { name: "Save snapshot" })).toBeVisible();
  const changedPolicyDb = createDatabase(target.toString());
  try {
    await new DatabaseProjectUpdateRepository(changedPolicyDb).setPolicy(fixture.admin, allowedProjectId,
      { ...scopePolicy, expectedRevision: 1, freshnessWindowSeconds: 6 * 86400 }, randomUUID());
  } finally { await changedPolicyDb.$disconnect(); }
  const changedExport = page.waitForResponse((response) => response.url().endsWith(draftPath));
  let staleDownloads = 0;
  page.on("download", () => { staleDownloads++; });
  await draftPanel.getByRole("button", { name: "Download editable PowerPoint" }).click();
  const currentDraft = await (await changedExport).json();
  expect(currentDraft.draft.updateFreshness).toBeNull();
  await expect(draftPanel).toContainText("The management draft is unavailable.");
  await expect(draftPanel.getByRole("button", { name: "Download editable PowerPoint" })).toHaveCount(0);
  expect(staleDownloads).toBe(0);

  const compareProjectPath = `/api/projects/${allowedProjectId}/leadership-answer`;
  const compareCommand = { question: historicalQuestion, priorSnapshotId: savedReport.snapshotId };
  const comparedProject = page.waitForResponse((response) => response.url().endsWith(compareProjectPath));
  await projectAnswer.getByLabel("Saved snapshot ID").fill(savedReport.snapshotId);
  await projectAnswer.getByRole("button", { name: "Compare with current facts" }).click();
  const comparedProjectResponse = await comparedProject;
  expect(comparedProjectResponse.status()).toBe(200);
  expect(await comparedProjectResponse.json()).toMatchObject({ state: "COMPARISON", projectId: allowedProjectId,
    updateFreshness: null, priorSnapshot: { id: savedReport.snapshotId, asOf: savedReport.draft.asOf,
      updateFreshness: savedReport.draft.updateFreshness } });
  const comparison = projectAnswer.getByRole("region", { name: "Changes since the saved snapshot" });
  const freshnessChange = comparison.getByRole("row").filter({ hasText: "Update freshness" });
  await expect(freshnessChange.getByRole("cell", { name: "current", exact: true })).toBeVisible();
  await expect(freshnessChange.getByRole("cell", { name: "Unavailable", exact: true })).toBeVisible();
  await expect(comparison).toContainText(savedReport.draft.updateFreshness.assessmentId);
  await comparison.screenshot({ path: "artifacts/project-report-comparison.png" });
  const [wrongProjectSnapshot, missingSnapshot, managerComparison] = await Promise.all([
    request.post(compareProjectPath, { headers: leaderHeaders, data: { ...compareCommand, priorSnapshotId: fallbackReviewSnapshotId } }),
    request.post(compareProjectPath, { headers: leaderHeaders, data: { ...compareCommand, priorSnapshotId: randomUUID() } }),
    request.post(compareProjectPath, { headers: managerHeaders, data: compareCommand }),
  ]);
  expect([wrongProjectSnapshot.status(), missingSnapshot.status(), managerComparison.status()]).toEqual([404, 404, 404]);
  expect(await wrongProjectSnapshot.json()).toEqual(await missingSnapshot.json());

  expect((await request.post(draftPath, { headers: leaderHeaders, data: draft })).status()).toBe(409);
  expect((await request.get(`${projectPath}/management-draft?snapshotId=${savedReport.snapshotId}`,
    { headers: leaderHeaders })).status()).toBe(404);
  const latestSaved = page.waitForResponse((response) => response.url().endsWith(draftPath + "?snapshotId=latest"));
  await draftPanel.getByRole("button", { name: "Open latest saved draft" }).click();
  const reopened = await (await latestSaved).json();
  expect(reopened).toMatchObject({ snapshotId: savedReport.snapshotId, draft: savedReport.draft, highlights: savedReport.highlights });
  await expect(draftPanel).toContainText(savedReport.snapshotId);
  await draftEmail.getByText("Leadership email preview").click();
  await expect(draftEmail).toContainText(savedReport.snapshotId);
  const exportSaved = page.waitForEvent("download");
  await draftPanel.getByRole("button", { name: "Download editable PowerPoint" }).click();
  const savedSlide = await readSlide((await (await exportSaved).path())!);
  expect(savedSlide).toContain(savedReport.snapshotId);
  expect(savedSlide).toContain(savedReport.draft.asOf);
  for (const highlight of savedReport.highlights) expect(savedSlide).toContain(highlight);

  const approvalRequestPath = draftPath + "/approval-request";
  const requestedApproval = page.waitForResponse((response) => response.url().endsWith(approvalRequestPath));
  await draftPanel.getByRole("button", { name: "Request PM approval" }).click();
  const requested = await requestedApproval;
  expect(requested.status()).toBe(200);
  const pendingReport = await requested.json();
  expect(pendingReport).toMatchObject({ snapshotId: savedReport.snapshotId, draft: savedReport.draft,
    approval: { state: "PENDING", decidedAt: null } });
  await expect(draftPanel).toContainText("Awaiting PM approval");
  const managerReportPath = `/api/projects/${allowedProjectId}/management-report-approval`;
  const deliveryPath = managerReportPath + "/delivery";
  const deliveryCommand = { snapshotId: savedReport.snapshotId, requestId: pendingReport.approval.requestId };
  const decisionCommand = { snapshotId: savedReport.snapshotId, requestId: pendingReport.approval.requestId, decision: "APPROVED" };
  expect((await request.post(managerReportPath, { headers: leaderHeaders, data: decisionCommand })).status()).toBe(404);
  expect((await request.post(deliveryPath, { headers: managerHeaders, data: deliveryCommand })).status()).toBe(409);
  expect((await request.post(managerReportPath, { headers: managerHeaders,
    data: { ...decisionCommand, snapshotId: randomUUID() } })).status()).toBe(409);
  const repeatHandoff = await request.post(approvalRequestPath, { headers: leaderHeaders, data: { snapshotId: savedReport.snapshotId } });
  expect(repeatHandoff.status()).toBe(200);
  expect(await repeatHandoff.json()).toMatchObject({ approval: pendingReport.approval });

  const currentPreview = await request.get(draftPath, { headers: leaderHeaders });
  expect(currentPreview.status()).toBe(200);
  const nextSave = await request.post(draftPath, { headers: leaderHeaders, data: (await currentPreview.json()).draft });
  expect(nextSave.status()).toBe(200);
  const followingSnapshotId = (await nextSave.json()).snapshotId;
  expect(followingSnapshotId).not.toBe(savedReport.snapshotId);
  const followingHandoff = await request.post(approvalRequestPath, { headers: leaderHeaders, data: { snapshotId: followingSnapshotId } });
  expect(followingHandoff.status()).toBe(200);
  const followingApproval = (await followingHandoff.json()).approval;
  const latestPending = await request.get(managerReportPath, { headers: managerHeaders });
  expect(latestPending.status()).toBe(200);
  expect(await latestPending.json()).toMatchObject({ snapshotId: followingSnapshotId, approval: { state: "PENDING" } });
  const approveFollowing = await request.post(managerReportPath, { headers: managerHeaders,
    data: { snapshotId: followingSnapshotId, requestId: followingApproval.requestId, decision: "APPROVED" } });
  expect(approveFollowing.status()).toBe(200);
  expect(await approveFollowing.json()).toMatchObject({ snapshotId: followingSnapshotId, approval: { state: "APPROVED" } });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager/ }).click();
  const reportQueue = page.getByRole("region", { name: "Action suggestions" });
  const pendingReportCard = reportQueue.getByRole("article").filter({ hasText: savedReport.snapshotId });
  await expect(pendingReportCard.getByRole("heading", { name: "Second synthetic project · HIGH · APPROVAL" })).toBeVisible();
  await expect(reportQueue).not.toContainText(followingSnapshotId);
  await pendingReportCard.getByRole("button", { name: "Open project" }).click();
  const projectDelayReview = page.getByRole("region", { name: "Project delay evidence request" });
  await projectDelayReview.getByRole("button", { name: "Check delay requests" }).click();
  await expect(projectDelayReview).toContainText(questionText);
  await expect(projectDelayReview).toContainText(delayRequest.id);
  await expect(projectDelayReview).toContainText(causeText);
  await expect(projectDelayReview).toContainText(delayEvidence.evidenceId);
  const confirmDelayPath = projectDelayPath + "/confirmation";
  const causeCommand = { clarificationId: delayRequest.id, versionId: delayEvidence.id };
  expect((await request.post(confirmDelayPath, { headers: leaderHeaders, data: causeCommand })).status()).toBe(404);
  expect((await request.post(confirmDelayPath, { headers: managerHeaders,
    data: { ...causeCommand, versionId: randomUUID() } })).status()).toBe(409);
  const confirmedDelayReady = page.waitForResponse((response) => response.url().endsWith(confirmDelayPath));
  await projectDelayReview.getByRole("button", { name: "Confirm this delay cause" }).click();
  const confirmedDelay = await confirmedDelayReady;
  expect(confirmedDelay.status()).toBe(200);
  const causeConfirmation = await confirmedDelay.json();
  await expect(projectDelayReview).toContainText(`Delay cause confirmed. Receipt ${causeConfirmation.id}.`);
  const replayConfirmation = await request.post(confirmDelayPath, { headers: managerHeaders, data: causeCommand });
  expect(replayConfirmation.status()).toBe(200);
  expect(await replayConfirmation.json()).toEqual(causeConfirmation);
  const selectedProjectApproval = page.getByRole("region", { name: "Project report approval" });
  await selectedProjectApproval.getByRole("button", { name: "Check report approvals" }).click();
  await expect(selectedProjectApproval).toContainText(savedReport.snapshotId);
  await selectedProjectApproval.getByRole("button", { name: "Approve saved report" }).click();
  await expect(selectedProjectApproval).toContainText("Final · Approved");
  const afterReportApproval = await request.get(queuePath, { headers: managerHeaders });
  expect(afterReportApproval.status()).toBe(200);
  expect((await afterReportApproval.json()).items).not.toContainEqual(expect.objectContaining({
    projectId: allowedProjectId, facet: "PROJECT_REPORT_APPROVAL",
  }));
  const approvedProjectReport = await request.get(`${draftPath}?snapshotId=${savedReport.snapshotId}`, { headers: leaderHeaders });
  expect(approvedProjectReport.status()).toBe(200);
  const finalProjectReport = await approvedProjectReport.json();
  expect(finalProjectReport).toMatchObject({ snapshotId: savedReport.snapshotId, draft: savedReport.draft,
    highlights: savedReport.highlights, approval: { requestId: pendingReport.approval.requestId, state: "APPROVED" } });
  const finalProjectSlide = await readSlide(Buffer.from(finalProjectReport.powerpointBase64, "base64"));
  expect(finalProjectSlide).toContain("Final • Approved");
  expect(finalProjectSlide).toContain(`Reporting month ${savedReport.draft.reportingPeriod} • Confidential`);
  expect(finalProjectSlide).toContain(savedReport.snapshotId);
  expect(finalProjectSlide).toContain(savedReport.draft.asOf);

  const recipientGrant = { customerId: fixture.customerId, subject: "leader-atlas",
    scopeType: "project", scopeId: allowedProjectId, role: "leadership" };
  const managerGrant = { ...recipientGrant, subject: "pm-atlas", role: "project_manager" };
  const deliveryDb = createDatabase(target.toString());
  try {
    const revoked = await deliveryDb.accessGrant.deleteMany({ where: recipientGrant });
    expect(revoked.count).toBe(1);
    const pmGrant = await deliveryDb.accessGrant.deleteMany({ where: managerGrant });
    expect(pmGrant.count).toBe(1);
    try {
      expect((await request.get(projectDelayPath, { headers: managerHeaders })).status()).toBe(404);
    } finally { await deliveryDb.accessGrant.create({ data: managerGrant }); }
    expect((await request.post(compareProjectPath, { headers: leaderHeaders, data: compareCommand })).status()).toBe(404);
    expect((await request.post(deliveryPath, { headers: managerHeaders, data: deliveryCommand })).status()).toBe(404);
  } finally {
    await deliveryDb.accessGrant.create({ data: recipientGrant });
    await deliveryDb.$disconnect();
  }
  const deliveredVersion = page.waitForResponse((response) => response.url().endsWith(deliveryPath));
  await selectedProjectApproval.getByRole("button", { name: "Deliver to requesting leader" }).click();
  const sentReport = await deliveredVersion;
  expect(sentReport.status()).toBe(200);
  const deliveredReport = await sentReport.json();
  expect(deliveredReport).toMatchObject({ snapshotId: savedReport.snapshotId, draft: savedReport.draft,
    approval: finalProjectReport.approval, delivery: { ...deliveryCommand, id: expect.any(String), deliveredAt: expect.any(String) } });
  await expect(selectedProjectApproval).toContainText(`Receipt ${deliveredReport.delivery.id}`);
  await expect(selectedProjectApproval).toContainText(followingSnapshotId);
  await expect(selectedProjectApproval.getByRole("button", { name: "Deliver to requesting leader" })).toBeVisible();
  const replayDelivery = await request.post(deliveryPath, { headers: managerHeaders, data: deliveryCommand });
  expect(replayDelivery.status()).toBe(200);
  expect(await replayDelivery.json()).toMatchObject({ delivery: deliveredReport.delivery });

  const latestDraft = await request.get(`${draftPath}?snapshotId=latest`, { headers: leaderHeaders });
  expect(latestDraft.status()).toBe(200);
  expect(await latestDraft.json()).toMatchObject({ snapshotId: followingSnapshotId });
  const updatedReportDb = createDatabase(target.toString());
  try {
    await new DatabaseProjectUpdateRepository(updatedReportDb).assess(fixture.admin, allowedProjectId, randomUUID());
  } finally { await updatedReportDb.$disconnect(); }
  const currentReportAfterDelivery = await request.get(draftPath, { headers: leaderHeaders });
  expect(currentReportAfterDelivery.status()).toBe(200);
  const currentFactsAfterDelivery = (await currentReportAfterDelivery.json()).draft;
  expect(currentFactsAfterDelivery.updateFreshness.assessmentId).not.toBe(savedReport.draft.updateFreshness.assessmentId);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Leadership/ }).click();
  await page.getByRole("button", { name: /Second synthetic project/ }).click();
  await projectAnswer.getByLabel("Project question").fill(genericQuestion.question);
  await projectAnswer.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(projectAnswer).toContainText(`PM-confirmed delay cause · ${causeText}`);
  const causeLink = projectAnswer.getByRole("link", { name: "Cause evidence" });
  await expect(causeLink).toBeVisible();
  const causeEvidenceHref = await causeLink.getAttribute("href");
  await expect(projectAnswer.locator(causeEvidenceHref!)).toContainText(delayEvidence.evidenceId);
  const evidenceDb = createDatabase(target.toString());
  try {
    await new DatabaseProjectFactRepository(evidenceDb).setSourceAccess(fixture.admin, {
      projectId: allowedProjectId, sourceId: delayEvidence.sourceId, expectedRevision: delayEvidence.sourceAccessRevision,
      state: "AVAILABLE", readers: ["pm-atlas"],
    }, { correlationId: randomUUID() });
  } finally { await evidenceDb.$disconnect(); }
  await projectAnswer.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(projectAnswer).toContainText("The cause of the delay is unknown.");
  await expect(projectAnswer).not.toContainText(delayEvidence.evidenceId);
  const inboxResponse = page.waitForResponse((response) => response.url().endsWith(draftPath + "?snapshotId=delivered"));
  await draftPanel.getByRole("button", { name: "Open delivered report" }).click();
  const deliveredInbox = await inboxResponse;
  expect(deliveredInbox.status()).toBe(200);
  const deliveredOutput = await deliveredInbox.json();
  expect(deliveredOutput).toMatchObject({ snapshotId: savedReport.snapshotId, draft: savedReport.draft, delivery: deliveredReport.delivery });
  await expect(draftPanel).toContainText(deliveredReport.delivery.id);
  await draftEmail.getByText("Leadership email preview").click();
  await expect(draftEmail).toContainText(savedReport.snapshotId);
  await expect(draftEmail).toContainText("Final · Approved");
  const deliveredDownloadReady = page.waitForEvent("download");
  await draftPanel.getByRole("button", { name: "Download editable PowerPoint" }).click();
  const deliveredDownload = await deliveredDownloadReady;
  expect(deliveredDownload.suggestedFilename()).toBe(`project-${allowedProjectId}-${savedReport.snapshotId}-approved.pptx`);
  const deliveredSlide = await readSlide((await deliveredDownload.path())!);
  expect(deliveredSlide).toContain("Final • Approved • Delivered in-app");
  expect(deliveredSlide).toContain(`Reporting month ${savedReport.draft.reportingPeriod} • Confidential`);
  for (const highlight of deliveredOutput.highlights) {
    await expect(draftEmail).toContainText(highlight);
    expect(deliveredSlide).toContain(highlight);
  }
  const originalDigest = await readSlide((await deliveredDownload.path())!, 2);
  expect(originalDigest).toContain("Open decision D-01 · Confirm the integration environment");
  expect(deliveredOutput.draft.digest.previousReport).toBeNull();
  const digestPolicyDb = createDatabase(target.toString());
  try {
    await new DatabaseProjectUpdateRepository(digestPolicyDb).setPolicy(fixture.admin, allowedProjectId,
      { ...scopePolicy, expectedRevision: 2, freshnessWindowSeconds: 5 * 86400 }, randomUUID());
  } finally { await digestPolicyDb.$disconnect(); }
  const newDigestResponse = page.waitForResponse((response) => response.url().endsWith(draftPath));
  await draftPanel.getByRole("button", { name: "Preview management draft" }).click();
  const newerDigest = await newDigestResponse;
  expect(newerDigest.status()).toBe(200);
  const summary = await newerDigest.json();
  expect(summary.draft.digest.previousReport).toEqual({ snapshotId: savedReport.snapshotId,
    asOf: savedReport.draft.asOf, schedule: savedReport.draft.schedule, freshnessState: "CURRENT" });
  await draftEmail.getByText("Leadership email preview").click();
  await expect(draftEmail).toContainText("No change in the available baseline and forecast finish dates.");
  await expect(draftEmail).toContainText("Update freshness changed from current to unavailable.");
  const comparedDigest = await readSlide(Buffer.from(summary.powerpointBase64, "base64"), 2);
  expect(comparedDigest).toContain(savedReport.snapshotId);
  expect(comparedDigest).toContain("No change in the available baseline and forecast finish dates.");
  expect(comparedDigest).toContain("Update freshness changed from current to unavailable.");

  const digestDb = createDatabase(target.toString());
  try {
    const facts = new DatabaseProjectFactRepository(digestDb);
    const updates = new DatabaseProjectUpdateRepository(digestDb);
    const factType = "project.status";
    const recordedAt = new Date(Date.now() - 1000).toISOString();
    const { entry } = await facts.appendHumanStatement(fixture.pm, {
      projectId: allowedProjectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt: recordedAt,
      value: { type: "text", value: "Integration review in progress." }, originalStatement: "Integration review in progress.",
    }, { correlationId: randomUUID() });
    const backgroundReaders = [fixture.admin.subject, fixture.service];
    const readers = [...backgroundReaders, "pm-atlas", "leader-atlas"];
    const changeAccess = (expectedRevision: number, nextReaders: string[]) => facts.setSourceAccess(fixture.admin, {
      projectId: allowedProjectId, sourceId: entry.sourceId, expectedRevision, state: "AVAILABLE", readers: nextReaders,
    }, { correlationId: randomUUID() });
    const access = await changeAccess(entry.sourceAccessRevision, readers);
    await new DatabaseAuthorityRepository(digestDb).appendPolicy(fixture.admin, {
      projectId: allowedProjectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt: recordedAt,
      definition: { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: entry.sourceId,
        requiredApproval: "NOT_REQUIRED", validity: { basis: "observedAt", durationMs: 86400_000 } }] }],
        conflictBehavior: "REQUEST_RECONCILIATION" },
    }, { correlationId: randomUUID() });
    const assessed = await updates.assess(fixture.admin, allowedProjectId, randomUUID());
    expect(assessed.freshness.sourceDateField).toBe("project.latestValidUpdateAt");
    const sourcePreview = await request.get(draftPath, { headers: leaderHeaders });
    expect(sourcePreview.status()).toBe(200);
    const sourceDraft = (await sourcePreview.json()).draft;
    expect(sourceDraft.updateFreshness).toMatchObject({ state: "CURRENT", sourceDateField: "project.latestValidUpdateAt" });
    const savedSourceReport = await request.post(draftPath, { headers: leaderHeaders, data: sourceDraft });
    expect(savedSourceReport.status()).toBe(200);
    const { snapshotId: sourceSnapshotId } = await savedSourceReport.json();
    const sourceHandoff = await request.post(approvalRequestPath, { headers: leaderHeaders, data: { snapshotId: sourceSnapshotId } });
    expect(sourceHandoff.status()).toBe(200);
    const version = { snapshotId: sourceSnapshotId, requestId: (await sourceHandoff.json()).approval.requestId };
    expect((await request.post(managerReportPath, { headers: managerHeaders,
      data: { ...version, decision: "APPROVED" } })).status()).toBe(200);
    expect((await request.post(deliveryPath, { headers: managerHeaders, data: version })).status()).toBe(200);
    await updates.setPolicy(fixture.admin, allowedProjectId, { ...scopePolicy, expectedRevision: 3,
      freshnessWindowSeconds: 4 * 86400 }, randomUUID());
    const capturedDigest = await request.get(draftPath, { headers: leaderHeaders });
    expect(capturedDigest.status()).toBe(200);
    const protectedComparisonDraft = (await capturedDigest.json()).draft;
    expect(protectedComparisonDraft).toMatchObject({ updateFreshness: null,
      digest: { previousReport: { snapshotId: sourceSnapshotId, freshnessState: "CURRENT" } } });
    const savedDigest = await request.post(draftPath, { headers: leaderHeaders, data: protectedComparisonDraft });
    expect(savedDigest.status()).toBe(200);
    const digestId = (await savedDigest.json()).snapshotId;
    const digestApproval = await request.post(approvalRequestPath, { headers: leaderHeaders, data: { snapshotId: digestId } });
    expect(digestApproval.status()).toBe(200);
    const digestRequestId = (await digestApproval.json()).approval.requestId;
    const revoked = await changeAccess(access.revision, backgroundReaders);
    try {
      for (const id of [sourceSnapshotId, digestId])
        expect((await request.get(`${draftPath}?snapshotId=${id}`, { headers: leaderHeaders })).status()).toBe(404);
      expect((await request.post(managerReportPath, { headers: managerHeaders,
        data: { snapshotId: digestId, requestId: digestRequestId, decision: "APPROVED" } })).status()).toBe(404);
      const fallbackComparison = await request.get(draftPath, { headers: leaderHeaders });
      expect(fallbackComparison.status()).toBe(200);
      expect(await fallbackComparison.json()).toMatchObject({
        draft: { digest: { previousReport: { snapshotId: savedReport.snapshotId, freshnessState: "CURRENT" } } },
      });
    } finally { await changeAccess(revoked.revision, readers); }
  } finally { await digestDb.$disconnect(); }
});
