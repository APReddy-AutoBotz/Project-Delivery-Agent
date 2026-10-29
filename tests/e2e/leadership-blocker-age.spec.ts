import { expect, test } from "@playwright/test";
import { buildBlockerAgeAdvice, buildPmActionQueue } from "../../packages/domain/dist/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const id = (number: number) => `30000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const projects = [1, 2].map((number) => ({ id: id(number), code: `BLK-${number}`, name: `Synthetic blocker ${number}`,
  description: "Synthetic browser project", reportedStatus: "UNKNOWN" }));
const asOf = "2026-10-21T11:00:00.000Z";
function advice(projectId: string, audience: "leadership" | "project_manager") {
  const raid = id(3);
  const proof = (factType: string, n: number, validity: "FINITE" | "UNTIL_SUPERSEDED") => ({ factId: id(n), factType, factRevision: 1,
    policyId: id(n + 100), policyRevisionId: id(n + 200), policyRevision: 1, status: "RESOLVED", provenance: "HUMAN_CONFIRMED",
    sourceType: "human_statement", freshness: "CURRENT", conflict: "NONE", validity,
    supports: [{ versionId: id(n + 300), evidenceId: id(n + 400), sourceId: id(n + 500), accessRevision: 1 }] });
  return buildBlockerAgeAdvice({ projectId, audience, asOf, coverage: "COMPLETE", threshold: { minimumBlockerAgeDays: 5, revision: 1 },
    noOpenBlockers: false, inventory: proof("project.open_blocker_inventory_complete", 10, "FINITE"),
    candidates: [{ raidItemId: raid, key: `ISSUE-${projectId === id(1) ? "FIRST" : "SECOND"}`, state: "OPEN", openedAt: "2026-10-16",
      classification: proof(`raid_item.${raid}.blocks_delivery`, 11, "FINITE"), openedAtProof: proof(`raid_item.${raid}.opened_at`, 12, "UNTIL_SUPERSEDED") }] });
}

test("EXEC-027: leadership blocker review hides denied and late results across project and session changes", async ({ page }) => {
  let persona = "", reads = 0, state: "success" | "denied" | "invalid" | "held" = "success";
  let release!: () => void, arrived!: () => void, settled!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId,
      roles: persona === "leader-atlas" ? ["leadership", "project_manager"] : ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === "/project-setup") return route.fulfill({ json: { portfolios: [] } });
    if (path === "/pm/action-queue") return route.fulfill({ json: buildPmActionQueue([]) });
    const project = projects.find((entry) => path === `/projects/${entry.id}`);
    if (project) return route.fulfill({ json: project });
    const selected = projects.find((entry) => path === `/projects/${entry.id}/leadership-blocker-age-suggestions`);
    if (selected) {
      reads++;
      if (state === "held") { arrived(); try { await held; await route.fulfill({ json: advice(selected.id, "leadership") }).catch(() => {}); }
        finally { settled(); } return; }
      if (state === "denied") return route.fulfill({ status: 404, json: { statusCode: 404, message: "Resource unavailable" } });
      if (state === "invalid") return route.fulfill({ json: advice(selected.id, "project_manager") });
      return route.fulfill({ json: advice(selected.id, "leadership") }).catch(() => {});
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic blocker 1/ }).click();
  const panel = page.getByRole("region", { name: "Blocker-age review" });
  await expect(panel).toContainText("ISSUE-FIRST"); await expect(panel).toContainText("whether an intervention is needed");
  await expect(panel).toContainText("Authorized inventory evidence");
  state = "denied"; await panel.getByRole("button", { name: "Refresh blocker review" }).click();
  await expect(panel).toContainText("Blocker-age review is unavailable"); await expect(panel).not.toContainText("ISSUE-FIRST");
  state = "invalid"; await panel.getByRole("button", { name: "Refresh blocker review" }).click();
  await expect(panel).toContainText("Blocker-age review is unavailable");
  state = "success"; const beforeFocus = reads; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => reads).toBeGreaterThan(beforeFocus); await expect(panel).toContainText("ISSUE-FIRST");
  const beforeVisibility = reads; await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => reads).toBeGreaterThan(beforeVisibility); await expect(panel).toContainText("ISSUE-FIRST");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Synthetic blocker 2/ }).click();
  await expect(panel).toContainText("ISSUE-SECOND"); await expect(panel).not.toContainText("ISSUE-FIRST");
  state = "held";
  try {
    await panel.getByRole("button", { name: "Refresh blocker review" }).click(); await entered;
    await page.getByRole("button", { name: "Sign out" }).click(); state = "success";
    await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Synthetic blocker 1/ }).click();
    await expect(panel).toContainText("ISSUE-FIRST");
  } finally { release(); }
  await finished;
  await expect(panel).toContainText("ISSUE-FIRST"); await expect(panel).not.toContainText("ISSUE-SECOND");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: /Synthetic blocker 1/ }).click();
  await expect(page.getByRole("region", { name: "Blocker-age review" })).toHaveCount(0);
});
