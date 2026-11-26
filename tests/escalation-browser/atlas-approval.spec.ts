import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { text as readStreamText } from "node:stream/consumers";
import yauzl from "yauzl";
import { createDatabase, DatabaseProjectFactRepository } from "../../packages/data/dist/index.js";

test("Atlas reply, PM delay evidence and distributed final report share the same evidence", async ({ page, request }) => {
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
  const leaderAccess = async (allowed: boolean, sourceId = fixture.sourceA.sourceId) => {
    const db = createDatabase(target.toString());
    try {
      const access = await db.factSourceAccess.findUniqueOrThrow({ where: { sourceId } });
      await new DatabaseProjectFactRepository(db).setSourceAccess(fixture.admin, {
        projectId: fixture.projectId, sourceId, expectedRevision: access.revision,
        state: "AVAILABLE", readers: fixture.readers.filter((subject: string) => allowed || subject !== "leader-atlas"),
      }, { correlationId: randomUUID() });
    } finally {
      await db.$disconnect();
    }
  };
  await page.goto("/update-requests/" + fixture.request.locator);
  await page.getByRole("button", { name: /Atlas contributor/ }).click();
  const reply = page.getByRole("textbox", { name: "Your update (unconfirmed)" });
  const submitReply = async (text: string) => {
    await reply.fill(text);
    const saved = page.waitForResponse((value) => value.url().endsWith("/responses") && value.request().method() === "POST");
    await page.getByRole("button", { name: "Record response" }).click();
    expect((await saved).status()).toBe(201);
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  };
  await submitReply("It might be available next week.");
  const interpretation = page.getByRole("region", { name: "Atlas demo interpretation" });
  await expect(interpretation).toContainText("Clarify whether API access is still pending");
  await expect(interpretation.getByRole("combobox")).toHaveValue("");
  await expect(interpretation.getByRole("button", { name: "Confirm for PM review" })).toBeDisabled();

  const text = "Access is still pending from Infrastructure. They expect to provide it on Wednesday. I need two working days after access to complete the integration task.";
  await submitReply(text);
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
  expect(await beforeApproval.json()).toMatchObject({
    schedule: { baseline: "2026-10-15", forecast: "2026-10-29", movementDays: 14 }, ownerReply: null, receipt: null,
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
  expect((await request.get(answerPath, { headers: managerHeaders })).status()).toBe(404);
  expect((await request.get(reportPath, { headers: managerHeaders })).status()).toBe(404);
  const record = () => request.post(receiptPath, { headers: managerHeaders, data: { approvalId } });
  expect((await record()).status()).toBe(409);

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /Project manager/ }).click();
  await page.getByRole("button", { name: /Atlas · Delivery approval/ }).click();
  const approval = page.getByRole("region", { name: "Atlas demo approval" });
  await expect(approval).toContainText("ATLAS-248");
  await expect(approval).toContainText("No comment in the fixture.");
  await expect(approval).toContainText("The Atlas owner confirmed that API access is still pending.");
  await expect(approval).not.toContainText(text);
  await approval.getByRole("button", { name: "Approve demo comment" }).click();
  await expect(approval).toContainText("Demo approval recorded.");
  await expect(approval.getByRole("button", { name: "Approve demo comment" })).toHaveCount(0);
  const persisted = await request.get(projectPath + "/atlas-approval", {
    headers: managerHeaders,
  });
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toMatchObject({ approvalId, decision: "APPROVED", approver: "pm-atlas", receipt: null });
  const replay = await request.post(projectPath + "/atlas-approval", {
    headers: managerHeaders, data: { approvalId, decision: "APPROVED" },
  });
  expect(replay.status()).toBe(200);
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
  expect(await freshView.json()).toMatchObject({ receipt });
  expect(await (await record()).json()).toEqual(receipt);
  const unknown = await request.get(answerPath, { headers: leaderHeaders });
  expect(unknown.status()).toBe(200);
  expect(await unknown.json()).toMatchObject({ delayAssessment: null, receipt });
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
  await expect(answer).toContainText("Integration testing started late.");
  await expect(answer).toContainText("The synthetic Jira blocker ATLAS-248 is open.");
  await expect(answer).toContainText("API access was pending at the time of the reply");
  await expect(answer).toContainText("A simulated escalation was captured for the assigned PM.");
  await expect(answer).toContainText("The PM confirmed that delayed API access caused the go-live delay.");
  await expect(answer).toContainText("The PM assessed forecast confidence as medium.");
  for (const [label, evidence] of [
    ["Schedule evidence", "Baseline 2026-10-15. Forecast 2026-10-29."],
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
  await expect(page.locator("body")).not.toContainText(text);
  const completeAnswer = await request.get(answerPath, { headers: leaderHeaders });
  expect(completeAnswer.status()).toBe(200);
  const complete = await completeAnswer.json();
  expect(complete.pmEscalation).toEqual({
    requestId: fixture.escalation.requestId, capturedAt: fixture.escalation.capturedAt, availableUntil: expect.any(String),
  });
  expect(JSON.stringify(complete)).not.toContain(fixture.escalation.locator);
  expect(JSON.stringify(complete)).not.toContain(fixture.sourceMarkerB);
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
  });
  expect(snapshot.id).not.toBe(originalReport.snapshot.id);
  const earlier = await request.get(`${reportPath}?snapshotId=${originalReport.snapshot.id}`, { headers: leaderHeaders });
  expect(earlier.status()).toBe(200);
  expect(await earlier.json()).toMatchObject({ snapshot: originalReport.snapshot, highlights: originalReport.highlights });
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
  const archive = await yauzl.openPromise((await download.path())!, { lazyEntries: true });
  let slide = "";
  try {
    for await (const entry of archive.eachEntry()) {
      if (entry.fileName === "ppt/slides/slide1.xml")
        slide = await readStreamText(await archive.openReadStreamPromise(entry));
    }
  } finally { archive.close(); }
  expect(slide).toContain("<a:t>Atlas management snapshot</a:t>");
  expect(slide).toContain(snapshot.id);
  expect(slide).toContain(snapshot.asOf);
  expect(slide).toContain(snapshot.reportingPeriod);
  expect(slide).toContain("Final • Approved");
  expect(slide).toContain(finalReport.approval.decidedAt);
  expect(slide).toContain(assessment.id);
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
    sourceRevision: 1, currentComment: "The Atlas owner confirmed that API access is still pending.",
    decision: "PENDING", receipt: null,
  });
  const pending = await request.get(answerPath, { headers: leaderHeaders });
  expect(pending.status()).toBe(200);
  expect(await pending.json()).toMatchObject({ ownerReply: null, receipt: null });
  expect((await request.post(projectPath + "/atlas-approval", {
    headers: managerHeaders, data: { approvalId: nextComment.approvalId, decision: "APPROVED" },
  })).status()).toBe(200);
  expect((await request.post(receiptPath, {
    headers: managerHeaders, data: { approvalId: nextComment.approvalId },
  })).status()).toBe(200);
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

  await leaderAccess(false);
  expect((await request.get(answerPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(reportPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(finalPath, { headers: leaderHeaders })).status()).toBe(404);
  expect((await request.get(distributionPath, { headers: leaderHeaders })).status()).toBe(404);
});
