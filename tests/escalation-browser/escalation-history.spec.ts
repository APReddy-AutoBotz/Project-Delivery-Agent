// INT-ESC-001: real saved API/browser history, without route interception or delivery claims.
import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase, DatabaseProjectFactRepository } from "../../packages/data/dist/index.js";

test("PM reads the exact protected request cycle and loses origin content after source revocation", async ({ page }) => {
  const f = JSON.parse(readFileSync(process.env.PDAA_ESCALATION_FIXTURE_PATH!, "utf8"));
  const target = new URL(process.env.PDAA_ESCALATION_BROWSER_DATABASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(target.hostname);
  expect(target.pathname).toMatch(/^\/pdaa_test_[0-9]+$/);
  const db = createDatabase(target.toString());
  try {
    const records = await db.projectUpdateCapturedRequest.findMany({
      where: { customerId: f.customerId, projectId: f.projectId }, orderBy: { capturedAt: "asc" },
    });
    expect(records).toHaveLength(5);
    expect(new Set(records.map((row) => row.id))).toEqual(new Set([
      f.request.requestId, f.reminder.requestId, f.secondReminder.requestId, f.ownerEscalation.requestId, f.escalation.requestId,
    ]));
    await page.goto("/update-requests/" + f.escalation.locator);
    const firstRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/project-update-invitations/" + f.escalation.locator);
    await page.getByRole("button", { name: "Project manager", exact: false }).click();
    const actualRead = await firstRead;
    expect(actualRead.status()).toBe(200);
    const response = await actualRead.json();
    expect(response.escalationContext.entries.map((entry: { requestId: string }) => entry.requestId)).toEqual([
      f.request.requestId, f.reminder.requestId, f.secondReminder.requestId, f.ownerEscalation.requestId,
    ]);
    const context = page.getByRole("region", { name: "Escalation request history" });
    await expect(context).toBeVisible();
    await expect(context.getByText("Original recorded request", { exact: true })).toBeVisible();
    await expect(context.getByText("Recorded reminder", { exact: true })).toHaveCount(2);
    await expect(context).toContainText(f.sourceMarkerA);
    await expect(context).toContainText("Delivery impact: unknown");
    await expect(context).not.toContainText(f.admin.subject);
    await expect(page.locator("body")).not.toContainText(f.privateResponse);
    await page.screenshot({ path: "artifacts/pm-escalation-history.png", fullPage: true });
    const access = await db.factSourceAccess.findUniqueOrThrow({ where: { sourceId: f.sourceA.sourceId } });
    await new DatabaseProjectFactRepository(db).setSourceAccess(f.admin, { projectId: f.projectId,
      sourceId: f.sourceA.sourceId, expectedRevision: access.revision, state: "AVAILABLE",
      readers: f.readers.filter((subject: string) => subject !== f.pm.subject) }, { correlationId: randomUUID() });
    const revokedRead = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/project-update-invitations/" + f.escalation.locator);
    await page.evaluate(() => window.dispatchEvent(new window.Event("visibilitychange")));
    expect((await revokedRead).status()).toBe(200);
    await expect(context).toBeVisible();
    await expect(context).not.toContainText(f.sourceMarkerA);
    await expect(context.getByText("Request content is restricted.", { exact: true })).toHaveCount(3);
    await expect(context).toContainText(f.sourceMarkerB);
    await expect(page.locator("body")).not.toContainText(f.privateResponse);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(context).not.toBeVisible();
    await expect(page.locator("body")).not.toContainText(f.sourceMarkerB);
    // Publish a receipt only after every saved-view, revocation and sign-out assertion passes.
    writeFileSync("artifacts/pm-escalation-history.json", JSON.stringify({ testId: "INT-ESC-001",
      projectId: f.projectId, requestId: f.escalation.requestId,
      originalRequestId: f.request.requestId, reminderRequestIds: [f.reminder.requestId, f.secondReminder.requestId],
      asOf: response.escalationContext.asOf, actualProtectedRecords: records.length,
      privateReplyWithheld: true, sourceARevocationRedactsThreeOrigins: true,
      sourceBRemainsReadable: true, signOutClearsContext: true,
      deliveryImpact: "UNKNOWN", externalDelivery: false }, null, 2) + "\n");
  } finally { await db.$disconnect(); }
});
