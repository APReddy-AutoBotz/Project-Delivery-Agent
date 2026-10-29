import { expect, test } from "@playwright/test";
const customerId = "10000000-0000-4000-8000-000000000001";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = { id: id(1), code: "CX", name: "Synthetic conflict project", description: "Fixture", reportedStatus: "UNKNOWN" };
const milestones = [{ id: id(2), key: "MS-1", name: "First milestone", state: "COMPLETE" },
  { id: id(3), key: "MS-2", name: "Second milestone", state: "OPEN" }];
const workItems = [{ id: id(4), key: "WI-1", title: "Required work", state: "OPEN" }];
const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
const detail = { ...project, configured: true, portfolio: { id: id(50), name: "Synthetic portfolio" }, programme: null,
  creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates,
  responsibilities: [], sprints: [], milestones: milestones.map((m) => ({ ...m, dates })),
  workItems: workItems.map((w) => ({ ...w, sprintKey: null, dates })), requiredWorkItems: [], raidItems: [],
  sourceMappings: [], sourceMappingsWithheld: true };
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n+10), sourceId: id(n+20), provenance: "HUMAN_CONFIRMED",
  freshness: "CURRENT", validity: "FINITE", effectiveAt: "2026-10-20T00:00:00.000Z", observedAt: "2026-10-20T00:00:00.000Z",
  versionValidUntil: "2026-10-23T00:00:00.000Z", assessedValidUntil: "2026-10-22T00:00:00.000Z" });
const base = { projectId: project.id, asOf: "2026-10-21T00:00:00.000Z", ruleRevision: "milestone-required-state/v1" };
const conflict = { ...base, milestoneId: id(2), outcome: "CONFLICTING", positions: [
  { targetKind: "MILESTONE", targetId: id(2), bindingId: id(60), factId: id(61), factType: "canonical.state.00000000000000000000000000000001", policyRevisionId: id(62), state: "COMPLETE", supports: [support(100)] },
  { targetKind: "WORK_ITEM", targetId: id(4), bindingId: id(63), factId: id(64), factType: "canonical.state.00000000000000000000000000000002", policyRevisionId: id(65), state: "OPEN", supports: [support(200)] },
] };

test("milestone observation hides old details when selection, access and session change", async ({ page }) => {
  let persona = "", denied = false, hold = false, holdMe = false, demoted = false;
  let releaseMe!: () => void, arrivedMe!: () => void;
  const meGate = new Promise<void>((resolve) => { releaseMe = resolve; });
  const meEntered = new Promise<void>((resolve) => { arrivedMe = resolve; });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") {
      if (holdMe) { arrivedMe(); await meGate; }
      return route.fulfill({ json: { subject: persona, customerId, roles: persona === "leader-atlas" && !demoted ? ["leadership"] : ["project_manager"] } }).catch(() => {});
    }
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/canonical`) return route.fulfill({ json: detail });
    if (path.endsWith("/leadership-conflict-observation")) {
      if (denied) return route.fulfill({ status: 503, json: { message: "Unavailable" } });
      if (path.includes(id(2))) {
        if (hold) { arrived(); await gate; }
        return route.fulfill({ json: conflict }).catch(() => {});
      }
      return route.fulfill({ json: { ...base, milestoneId: id(3), outcome: "NOT_DETECTED" } }).catch(() => {});
    }
    if (path === "/pm/action-queue") return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic conflict project/ }).click();
  const select = page.getByLabel("Milestone", { exact: true });
  await select.selectOption(id(2)); await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  await expect(page.getByText(/Evidence .*version .*source/).first()).toBeVisible();
  denied = true; await page.getByRole("button", { name: "Refresh completion check" }).click();
  await expect(page.getByText("Completion check is unavailable", { exact: false })).toBeVisible();
  await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  denied = false; hold = true; await page.getByRole("button", { name: "Refresh completion check" }).click(); await entered;
  try {
    await select.selectOption(id(3)); await expect(page.getByText("This completion rule found no contradiction", { exact: false })).toBeVisible();
  } finally { release(); }
  await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  hold = false; await select.selectOption(id(2));
  await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  // Let the identity query become stale, then hold its real focus refetch. The
  // old evidence must disappear before the changed role is returned.
  await page.waitForTimeout(16000); holdMe = true; demoted = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  try { await meEntered; await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0); }
  finally { releaseMe(); }
  await expect(page.getByLabel("Milestone", { exact: true })).toHaveCount(0);
  holdMe = false;
  await page.getByRole("button", { name: "Sign out" }).click(); await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: /Synthetic conflict project/ }).click();
  await expect(page.getByLabel("Milestone", { exact: true })).toHaveCount(0);
});
