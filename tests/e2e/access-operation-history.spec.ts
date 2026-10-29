import { test, expect } from "@playwright/test";

test("access operation history distinguishes loading and malformed results", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/access-operations", async (route) => {
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
      id: "50000000-0000-4000-8000-000000000001",
      event: "health.assessed", actor: "synthetic", occurredAt: "2026-09-06T00:00:00.000Z",
    }]) });
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Platform operator" }).click();
    await page.getByRole("button", { name: /Platform & access/ }).click();
    await expect(page.getByText("Loading operation history…")).toBeVisible();
    await expect(page.getByText("No recorded access operations found.")).toHaveCount(0);
    release();
    await expect(page.getByText("Access operation history is unavailable.")).toBeVisible();
    await expect(page.getByText("Revoke operation recorded", { exact: true })).toHaveCount(0);
    await expect(page.getByText("No recorded access operations found.")).toHaveCount(0);
  } finally { release(); }
});

test("PMO-only sessions do not request customer-wide operation history", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/access-operations", async (route) => {
    requests++;
    await route.fulfill({ status: 500 });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "PMO administrator" }).click();
  await page.getByRole("button", { name: /Platform & access/ }).click();
  await expect(page.getByText("Operation history is unavailable for this role.")).toBeVisible();
  expect(requests).toBe(0);
});

test("an impossible recorded date is not normalized into a different date", async ({ page }) => {
  await page.route("**/api/access-operations", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
      id: "50000000-0000-4000-8000-000000000001", event: "access.granted",
      actor: "synthetic", occurredAt: "2026-02-30T00:00:00.000Z",
    }]) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Platform operator" }).click();
  await page.getByRole("button", { name: /Platform & access/ }).click();
  await expect(page.getByText("Access operation history is unavailable.")).toBeVisible();
  await expect(page.getByText("synthetic", { exact: true })).toHaveCount(0);
});

test("an empty result is shown only after a successful read", async ({ page }) => {
  await page.route("**/api/access-operations", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Platform operator" }).click();
  await page.getByRole("button", { name: /Platform & access/ }).click();
  await expect(page.getByText("No recorded access operations found.")).toBeVisible();
  await expect(page.getByText("Access operation history is unavailable.")).toHaveCount(0);
});

test("accepts the full UUID range allowed by the access-operation contract", async ({ page }) => {
  await page.route("**/api/access-operations", (route) => route.fulfill({ json: [
    { id: "ffffffff-ffff-ffff-ffff-ffffffffffff", event: "access.granted", actor: "synthetic-max", occurredAt: "2026-09-06T00:00:00.000Z" },
    { id: "00000000-0000-0000-0000-000000000000", event: "access.revoked", actor: "synthetic-nil", occurredAt: "2026-09-06T00:00:00.000Z" },
  ] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Platform operator" }).click();
  await page.getByRole("button", { name: /Platform & access/ }).click();
  await expect(page.getByText("synthetic-max")).toBeVisible();
  await expect(page.getByText("synthetic-nil")).toBeVisible();
});

test("a late prior-session response is not shown after a role switch", async ({ page }) => {
  let release!: () => void;
  let finishFirst!: () => void;
  let requests = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstSettled = new Promise<void>((resolve) => { finishFirst = resolve; });
  await page.route("**/api/access-operations", async (route) => {
    const requestNumber = ++requests;
    if (requestNumber === 1) await gate;
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
        id: "50000000-0000-4000-8000-000000000001", event: "access.granted",
        actor: requestNumber === 1 ? "synthetic-previous-session" : "synthetic-current-session", occurredAt: "2026-09-06T00:00:00.000Z",
      }]) }).catch(() => {});
    } finally { if (requestNumber === 1) finishFirst(); }
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Platform operator" }).click();
    await page.getByRole("button", { name: /Platform & access/ }).click();
    await expect(page.getByText("Loading operation history…")).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "PMO administrator" }).click();
    await page.getByRole("button", { name: /Platform & access/ }).click();
    await expect(page.getByText("Operation history is unavailable for this role.")).toBeVisible();
    await expect(page.getByText("synthetic-previous-session")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Platform operator" }).click();
    await page.getByRole("button", { name: /Platform & access/ }).click();
    await expect(page.getByText("synthetic-current-session")).toBeVisible();
    release();
    await firstSettled;
    await expect(page.getByText("synthetic-previous-session")).toHaveCount(0);
    expect(requests).toBe(2);
  } finally { release(); }
});
