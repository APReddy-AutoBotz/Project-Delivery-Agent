// EXEC-027: hosted synthetic stack; exercises real API/auth/source access, not route mocks.
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { canonicalFixture } from "../../scripts/acceptance/canonical-projects.mjs";

const portfolioId = "20000000-0000-4000-8000-000000000001";
test.setTimeout(90000);
test.skip(process.env.PDAA_EXEC027_DISPOSABLE_E2E !== "1", "Requires an independently qualified disposable synthetic stack");

test("EXEC-027: live leadership review rechecks authorized blocker sources", async ({ page, request }) => {
  const tokens: Record<string, string> = {};
  for (const persona of ["operator", "pmo-portfolio", "pm-atlas", "leader-atlas"]) {
    const response = await request.post("/api/auth/development", { data: { persona } });
    expect(response.status()).toBe(200); tokens[persona] = (await response.json()).token;
  }
  const api = (persona: string, path: string, method = "GET", data?: unknown) => request.fetch("/api" + path, {
    method, headers: { Authorization: `Bearer ${tokens[persona]}` }, ...(data === undefined ? {} : { data }),
  });
  expect((await api("operator", "/access-grants", "POST", { subject: "pmo-portfolio", role: "pmo_admin", scopeType: "portfolio", scopeId: portfolioId })).status()).toBe(204);
  const input = canonicalFixture(portfolioId);
  input.code = `BLK-${randomUUID().slice(0, 8)}`; input.name = `Live blocker advice ${randomUUID().slice(0, 8)}`;
  input.responsibilities = input.responsibilities.map((entry: { role: string; subject: string }) =>
    entry.role === "PROJECT_MANAGER" ? { ...entry, subject: "pm-atlas" } : entry);
  input.raidItems = input.raidItems.map((entry: { state: string }, index: number) => ({ ...entry, state: index === 0 ? "OPEN" : "COMPLETE" }));
  const created = await api("pmo-portfolio", "/projects", "POST", input); expect(created.status()).toBe(201);
  const projectId: string = (await created.json()).id, prefix = `/projects/${projectId}`;
  for (const [subject, role] of [["pm-atlas", "project_manager"], ["leader-atlas", "leadership"]])
    expect((await api("operator", "/access-grants", "POST", { subject, role, scopeType: "project", scopeId: projectId })).status()).toBe(204);
  const policyResponse = await api("pmo-portfolio", "/admin/blocker-age-threshold-policy"); expect(policyResponse.status()).toBe(200);
  let policy = await policyResponse.json();
  if (!policy) {
    const configured = await api("pmo-portfolio", "/admin/blocker-age-threshold-policy", "POST",
      { expectedRevision: 0, minimumBlockerAgeDays: 5, auditRetentionHours: 720 });
    expect(configured.status()).toBe(200); policy = await configured.json();
  }
  const canonicalResponse = await api("pmo-portfolio", prefix + "/canonical"); expect(canonicalResponse.status()).toBe(200);
  const canonical = await canonicalResponse.json(), raid = canonical.raidItems.find((entry: { state: string }) => entry.state === "OPEN");
  expect(raid).toBeDefined();
  const effectiveAt = new Date(Date.now() - 60000).toISOString();
  const openedAt = new Date(Date.now() - (policy.minimumBlockerAgeDays + 2) * 86400000).toISOString().slice(0, 10);
  const current = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
    validity: { basis: "observedAt", durationMs: 86400000 } }] }], conflictBehavior: "REQUEST_RECONCILIATION" };
  const ongoing = { tiers: [{ selectors: [{ sourceType: "human_statement", instanceId: null, requiredApproval: "NOT_REQUIRED",
    validity: { mode: "UNTIL_SUPERSEDED" } }] }], conflictBehavior: "REQUEST_RECONCILIATION" };
  async function add(factType: string, value: unknown, definition: unknown) {
    const configured = await api("pmo-portfolio", prefix + "/authority-policies", "POST",
      { projectId, factType, expectedRevision: 0, idempotencyKey: randomUUID(), effectiveAt, definition });
    expect(configured.status()).toBe(201);
    const statement = await api("pmo-portfolio", prefix + "/fact-statements", "POST", { projectId, factType, expectedRevision: 0,
      idempotencyKey: randomUUID(), effectiveAt, value, validUntil: null, originalStatement: "Synthetic live blocker evidence." });
    expect(statement.status()).toBe(201);
    const sourceId: string = (await statement.json()).entry.sourceId, accessPath = `${prefix}/fact-sources/${sourceId}/access`;
    const access = await api("pmo-portfolio", accessPath); expect(access.status()).toBe(200);
    const shared = await api("pmo-portfolio", accessPath, "POST", { projectId, sourceId, expectedRevision: (await access.json()).revision,
      state: "AVAILABLE", readers: ["pmo-portfolio", "pm-atlas", "leader-atlas"] });
    expect(shared.status()).toBe(200); return { sourceId, revision: (await shared.json()).revision, accessPath };
  }
  await add("project.open_blocker_inventory_complete", { type: "boolean", value: true }, current);
  const classification = await add(`raid_item.${raid.id}.blocks_delivery`, { type: "boolean", value: true }, current);
  await add(`raid_item.${raid.id}.opened_at`, { type: "date", value: openedAt }, ongoing);
  const path = `${prefix}/leadership-blocker-age-suggestions`;
  expect((await api("pm-atlas", path)).status()).toBe(404);
  const first = await api("leader-atlas", path); expect(first.status()).toBe(200); expect(first.headers()["cache-control"]).toBe("no-store");
  expect(await first.json()).toMatchObject({ audience: "leadership", projectId, coverage: "COMPLETE",
    items: [{ raidItemId: raid.id, openedAt }] });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: new RegExp(input.name) }).click();
  const panel = page.getByRole("region", { name: "Blocker-age review" });
  await expect(panel).toContainText(raid.key); await expect(panel).toContainText("whether an intervention is needed");
  const revoked = await api("pmo-portfolio", classification.accessPath, "POST", { projectId, sourceId: classification.sourceId,
    expectedRevision: classification.revision, state: "AVAILABLE", readers: ["pmo-portfolio", "pm-atlas"] });
  expect(revoked.status()).toBe(200);
  const after = await api("leader-atlas", path); expect(after.status()).toBe(200);
  const withheld = await after.json(); expect(withheld).toMatchObject({ coverage: "UNASSESSABLE", items: [], noOpenBlockers: null });
  expect(JSON.stringify(withheld)).not.toContain(classification.sourceId);
  await panel.getByRole("button", { name: "Refresh blocker review" }).click();
  await expect(panel).toContainText("Blocker-age review is unavailable"); await expect(panel).not.toContainText(raid.key);
});
