import { test, expect, type Page } from "@playwright/test";

async function count(page: Page) { return page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length); }
async function finish(page: Page, index: number, value: string) {
  await page.evaluate(({ index: position, value: result }) =>
    (window as unknown as { calls: Array<{ resolve: (value: string) => void }> }).calls[position]!.resolve(result), { index, value });
}
async function setup(page: Page) {
  await page.goto("/test-fixtures/evidence-admission.html");
  await expect.poll(() => count(page)).toBe(1); await finish(page, 0, "first-A");
  await expect(page.getByTestId("resource")).toHaveText("ready:first-A");
  await page.getByRole("button", { name: "Capture old refresh" }).click();
}
test("an old A refresh cannot supersede the current B resource", async ({ page }) => {
  await setup(page); await page.getByRole("button", { name: "Select B" }).click();
  await expect.poll(() => count(page)).toBe(2);
  await page.getByRole("button", { name: "Run old refresh" }).click(); expect(await count(page)).toBe(2);
  await finish(page, 1, "current-B"); await expect(page.getByTestId("resource")).toHaveText("ready:current-B");
});
test("an old A refresh cannot borrow a later A after A→B→A", async ({ page }) => {
  await setup(page); await page.getByRole("button", { name: "Select B" }).click();
  await expect.poll(() => count(page)).toBe(2); await finish(page, 1, "current-B");
  await expect(page.getByTestId("resource")).toHaveText("ready:current-B");
  await page.getByRole("button", { name: "Select A" }).click(); await expect.poll(() => count(page)).toBe(3);
  await page.getByRole("button", { name: "Run old refresh" }).click(); expect(await count(page)).toBe(3);
  await finish(page, 2, "second-A"); await expect(page.getByTestId("resource")).toHaveText("ready:second-A");
});
test("an old refresh cannot borrow a later admission for the same key", async ({ page }) => {
  await setup(page); await page.getByRole("button", { name: "Renew admission" }).click();
  await expect.poll(() => count(page)).toBe(2);
  await page.getByRole("button", { name: "Run old refresh" }).click(); expect(await count(page)).toBe(2);
  await finish(page, 1, "new-admission"); await expect(page.getByTestId("resource")).toHaveText("ready:new-admission");
});
test("a changed scope does not expose or replace the old scope's data", async ({ page }) => {
  await setup(page); await page.getByRole("button", { name: "Select scope B" }).click();
  await expect.poll(() => count(page)).toBe(2);
  await expect(page.getByTestId("resource")).toHaveText("loading:none");
  await page.getByRole("button", { name: "Run old refresh" }).click(); expect(await count(page)).toBe(2);
  await finish(page, 1, "scope-B"); await expect(page.getByTestId("resource")).toHaveText("ready:scope-B");
  const commits = await page.evaluate(() => (window as unknown as { commits: Array<{ scope: string; phase: string; data: string | null }> }).commits);
  expect(commits).toContainEqual({ scope: "scope-A", phase: "ready", data: "first-A" });
  expect(commits.some((entry) => entry.scope === "scope-B" && entry.data === "first-A")).toBe(false);
});
test("a synchronous scope A→B→A cannot present the first A proof", async ({ page }) => {
  await setup(page);
  const before = await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits.length);
  await page.getByRole("button", { name: "Flip scope B then A" }).click();
  const commits = await page.evaluate(() => (window as unknown as { commits: Array<{ scope: string; phase: string; data: string | null }> }).commits);
  expect(commits.slice(before).some((entry) => entry.scope === "scope-A" && entry.data === "first-A")).toBe(false);
  await expect.poll(() => count(page)).toBeGreaterThan(1);
  const last = (await count(page)) - 1; await finish(page, last, "new-scope-A");
  await expect(page.getByTestId("resource")).toHaveText("ready:new-scope-A");
});
