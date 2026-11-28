import { expect, test } from "@playwright/test";
import { atlasApprovalProjectCode, buildBlockerAgeAdvice, buildPmActionQueue, type BlockerAgeAdvice } from "../../packages/domain/dist/index.js";

const customerId = "10000000-0000-4000-8000-000000000001";
const id = (number: number) => `30000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const projects = [1, 2].map((number) => ({ id: id(number), portfolioId: id(50), code: `BLK-${number}`, name: `Synthetic blocker ${number}`,
  description: "Synthetic browser project", reportedStatus: "UNKNOWN" }));
const atlas = { ...projects[0]!, id: id(4), code: atlasApprovalProjectCode, name: "Synthetic Atlas deadline" };
const asOf = "2026-10-21T11:00:00.000Z";
function advice(projectId: string, audience: BlockerAgeAdvice["audience"]) {
  const raid = id(3);
  const proof = (factType: string, n: number, validity: "FINITE" | "UNTIL_SUPERSEDED") => ({ factId: id(n), factType, factRevision: 1,
    policyId: id(n + 100), policyRevisionId: id(n + 200), policyRevision: 1, status: "RESOLVED", provenance: "HUMAN_CONFIRMED",
    sourceType: "human_statement", freshness: "CURRENT", conflict: "NONE", validity,
    supports: [{ versionId: id(n + 300), evidenceId: id(n + 400), sourceId: id(n + 500), accessRevision: 1 }] });
  return buildBlockerAgeAdvice({ projectId, audience, asOf, coverage: "COMPLETE", threshold: { minimumBlockerAgeDays: 5, revision: 1 },
    noOpenBlockers: false, inventory: proof("project.open_blocker_inventory_complete", 10, "FINITE"),
    candidates: [{ raidItemId: raid, key: `ISSUE-${projectId === id(1) ? "FIRST" : "SECOND"}`, state: "OPEN", openedAt: "2026-10-16",
      classification: proof(`raid_item.${raid}.blocks_delivery`, 11, "FINITE"), openedAtProof: proof(`raid_item.${raid}.opened_at`, 12, "UNTIL_SUPERSEDED"),
      ...(audience === "scrum_master" && { criticalDependency: { policyRevision: 1, escalationOwner: null,
        milestone: { id: id(60), key: "MS-1", dateField: "forecastEnd", dueDate: "2026-10-23", daysUntilDue: 2 } } }),
    }] });
}

test("EXEC-027 / AC-QA-002: leadership hides expired, denied and late evidence across project and session changes", async ({ page }) => {
  let persona = "", reads = 0, state: "success" | "denied" | "invalid" | "held" = "success";
  let causeReads = 0, atlasReads = 0;
  let release!: () => void, arrived!: () => void, settled!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId,
      roles: persona === "leader-atlas" ? ["leadership", "project_manager", "scrum_master"] : ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [...projects, atlas] });
    if (path === "/project-setup") return route.fulfill({ json: { portfolios: [] } });
    if (path === "/pm/action-queue") return route.fulfill({ json: buildPmActionQueue([]) });
    const project = [...projects, atlas].find((entry) => path === `/projects/${entry.id}`);
    if (project) return route.fulfill({ json: project });
    if (path === `/projects/${id(1)}/leadership-answer`) {
      const now = Date.now();
      const checkedAt = new Date(now).toISOString();
      const updateFreshness = causeReads === 0 ? {
        state: "STALE", assessedAt: checkedAt, sourceDate: asOf, sourceDateField: "project.latestValidUpdateAt",
        assessmentId: id(76), openObligation: true, obligationId: id(77),
      } : null;
      const facts = { state: "ANSWERED", projectId: id(1), asOf: checkedAt, updateFreshness,
        schedule: { revision: 1, baseline: "2026-10-17", forecast: "2026-10-21", movementDays: 4 } };
      if (++causeReads > 1) return route.fulfill({ json: { ...facts, cause: "UNKNOWN" } });
      const value = "Confirmed integration delay";
      return route.fulfill({ json: { ...facts, cause: "HUMAN_CONFIRMED", delayCause: {
        evidence: { factId: id(70), versionId: id(71), evidenceId: id(72), observedAt: checkedAt, value },
        confirmation: { id: id(73), clarificationId: id(74), versionId: id(71), confirmedAt: checkedAt },
        claim: { claimText: `PM-confirmed delay cause · ${value}`, projectId: id(1), factId: id(70), versionId: id(71),
          evidenceIds: [id(72)], policyRevisionId: id(75), assessedAt: checkedAt,
          validUntil: new Date(now + 15000).toISOString(), provenance: "HUMAN_CONFIRMED", classification: "HUMAN_CONFIRMED",
          freshness: "CURRENT", conflict: "NONE" },
      } } });
    }
    if (path === `/projects/${atlas.id}/atlas-leadership-answer`) {
      const now = Date.now();
      const checkedAt = new Date(now).toISOString();
      const facts = { projectId: atlas.id, asOf: checkedAt,
        schedule: { revision: 1, baseline: "2026-10-17", forecast: "2026-10-21", movementDays: 4 },
        ownerReply: { responseId: id(80), receivedAt: checkedAt, availableUntil: new Date(now + 5000).toISOString(),
          accessStatus: "ACCESS_PENDING" }, receipt: null, delayAssessment: null, pmEscalation: null,
        integrationStart: { milestoneId: id(81), planned: "2026-10-12", actual: "2026-10-13" } };
      if (++atlasReads > 1) return route.fulfill({ json: { ...facts, jiraBlocker: null } });
      return route.fulfill({ json: { ...facts, jiraBlocker: { mappingId: id(82), issueKey: "ATLAS-248",
        claim: { claimText: "The synthetic Jira blocker ATLAS-248 is open.", projectId: atlas.id, factId: id(83),
          versionId: id(84), evidenceIds: [id(85)], policyRevisionId: id(86), assessedAt: checkedAt,
          validUntil: new Date(now + 30000).toISOString(), provenance: "SYSTEM_VERIFIED", classification: "SYSTEM_VERIFIED",
          freshness: "CURRENT", conflict: "NONE" } }, forecastInference: { classification: "AGENT_INFERENCE",
        scheduleRevision: 1, milestoneId: id(81), blockerMappingId: id(82) } } });
    }
    const sprintProject = projects.find((entry) => path === `/projects/${entry.id}/scrum-master-blocker-age-suggestions`);
    if (sprintProject) return route.fulfill({ json: advice(sprintProject.id, "scrum_master") }).catch(() => {});
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
  await page.clock.install();
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic blocker 1/ }).click();
  const panel = page.getByRole("region", { name: "Blocker-age review" });
  await expect(panel).toContainText("ISSUE-FIRST"); await expect(panel).toContainText("whether an intervention is needed");
  await expect(panel).toContainText("Authorized inventory evidence");
  const sprint = page.getByRole("region", { name: "Sprint impediments" });
  await expect(sprint).toContainText("ISSUE-FIRST");
  await expect(sprint).toContainText("Upcoming milestone MS-1");
  await expect(sprint).toContainText("review its impact on the sprint");
  const answer = page.getByRole("region", { name: "Project leadership answer" });
  await answer.getByLabel("Project question").fill("Why is this project delayed?");
  await answer.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(answer.getByRole("link", { name: "Cause evidence" })).toBeVisible();
  await expect(answer.locator(`#project-answer-update-${id(1)}`)).toContainText(`Open update obligation ${id(77)}.`);
  await page.clock.fastForward(16000);
  await expect(answer).toContainText("The cause of the delay is unknown.");
  await expect(answer.getByRole("link", { name: "Cause evidence" })).toHaveCount(0);
  await expect(answer).not.toContainText(id(77));
  expect(causeReads).toBe(2);
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
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Synthetic Atlas deadline/ }).click();
  const atlasAnswer = page.getByRole("region", { name: "Atlas leadership answer" });
  await atlasAnswer.getByRole("button", { name: "Why is Atlas delayed?" }).click();
  await expect(atlasAnswer).toContainText("Agent inference.");
  await expect(atlasAnswer.getByRole("link", { name: "Reply evidence" })).toHaveCount(0);
  await page.clock.fastForward(16000);
  await expect(atlasAnswer.getByRole("link", { name: "Jira blocker evidence" })).toHaveCount(0);
  await expect(atlasAnswer).not.toContainText("Agent inference.");
  expect(atlasReads).toBe(2);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: /^Project manager / }).click();
  await page.getByRole("button", { name: /Synthetic blocker 1/ }).click();
  await expect(page.getByRole("region", { name: "Blocker-age review" })).toHaveCount(0);
  await expect(sprint).toHaveCount(0);
});
