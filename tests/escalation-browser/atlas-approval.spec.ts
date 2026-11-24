import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

test("Atlas contributor confirms a reply and the assigned PM records one simulated comment", async ({ page, request }) => {
  const fixture = JSON.parse(readFileSync(process.env.PDAA_ESCALATION_FIXTURE_PATH!, "utf8"));
  const projectPath = `/api/projects/${fixture.projectId}`;
  const receiptPath = projectPath + "/atlas-comment-receipt";
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
  const denied = await request.post(projectPath + "/atlas-approval", {
    headers: leaderHeaders, data: { approvalId, decision: "APPROVED" },
  });
  expect(denied.status()).toBe(404);
  expect((await request.post(receiptPath, { headers: leaderHeaders, data: { approvalId } })).status()).toBe(404);
  const manager = await request.post("/api/auth/development", { data: { persona: "pm-atlas" } });
  expect(manager.status()).toBe(200);
  const managerHeaders = { Authorization: "Bearer " + (await manager.json()).token };
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

  const owner = await request.post("/api/auth/development", { data: { persona: "owner-atlas" } });
  expect(owner.status()).toBe(200);
  const ownerHeaders = { Authorization: "Bearer " + (await owner.json()).token };
  const invitationPath = "/api/project-update-invitations/" + fixture.request.locator;
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
  expect(await nextPreview.json()).toMatchObject({
    sourceRevision: 1, currentComment: "The Atlas owner confirmed that API access is still pending.",
    decision: "PENDING", receipt: null,
  });
});
