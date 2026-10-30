import { expect, test } from "@playwright/test";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customerId = id(1), projectId = id(2), factId = id(3), otherFact = id(4);
const project = { id: projectId, code: "SC", name: "Synthetic scalar project", description: "Fixture", reportedStatus: "UNKNOWN" };
const secondProject = { ...project, id: id(90), code: "SC-2", name: "Second scalar project" };
const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
const detail = { ...project, configured: true, portfolio: { id: id(50), name: "Synthetic portfolio" }, programme: null,
  creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates,
  responsibilities: [], sprints: [], milestones: [], workItems: [], requiredWorkItems: [], raidItems: [], sourceMappings: [], sourceMappingsWithheld: true };
const support = (n: number) => ({ versionId: id(n), evidenceId: id(n + 10), sourceId: id(n + 20), provenance: "HUMAN_CONFIRMED",
  effectiveAt: "2026-10-20T00:00:00.000Z", observedAt: "2026-10-20T00:00:00.000Z",
  versionValidUntil: "2026-10-23T00:00:00.000Z", assessedValidUntil: "2026-10-22T00:00:00.000Z" });
const observation = { projectId, factId, factType: "project.forecast", asOf: "2026-10-21T00:00:00.000Z", policyRevisionId: id(8),
  positions: [{ value: "2026-11-01", supports: [support(100)] }, { value: "2026-11-02", supports: [support(200)] }] };

test("scalar observation clears on selection, focus revalidation and late replies", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", reads = 0, hold = false, denyCatalogue = false, demoted = false, holdMe = false;
  let arrived!: () => void, release!: () => void, arrivedMe!: () => void, releaseMe!: () => void;
  let entered = new Promise<void>((resolve) => { arrived = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  const meEntered = new Promise<void>((resolve) => { arrivedMe = resolve; });
  const meGate = new Promise<void>((resolve) => { releaseMe = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/leadership-conflict") && init) {
        const rest = { ...init }; delete rest.signal;
        return original(input, rest).then(async (response) => {
          await response.clone().text();
          if (response.headers.get("x-synthetic-late")) {
            const current = window as unknown as { scalarLateCount?: number };
            current.scalarLateCount = (current.scalarLateCount ?? 0) + 1;
          }
          return response;
        });
      }
      return original(input, init);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") {
      if (holdMe) { arrivedMe(); await meGate; }
      return route.fulfill({ json: { subject: persona, customerId, roles: demoted ? ["project_manager"] : ["leadership"] } }).catch(() => {});
    }
    if (path === "/projects") return route.fulfill({ json: [project, secondProject] });
    if (path === `/projects/${projectId}`) return route.fulfill({ json: project });
    if (path === `/projects/${secondProject.id}`) return route.fulfill({ json: secondProject });
    if (path === `/projects/${projectId}/canonical`) return route.fulfill({ json: detail });
    if (path === `/projects/${secondProject.id}/canonical`) return route.fulfill({ json: { ...detail, id: secondProject.id } });
    if (path === `/projects/${projectId}/facts`) return denyCatalogue ? route.fulfill({ status: 404 }) : route.fulfill({ json: {
      canAppend: false, canConfigure: false, next: null, facts: [
        { factId, factType: "project.forecast", revision: 2 }, { factId: otherFact, factType: "project.start", revision: 1 },
      ],
    } });
    if (path.endsWith("/leadership-conflict")) {
      reads++;
      if (hold) { arrived(); await gate; return route.fulfill({ json: observation, headers: { "x-synthetic-late": "1" } }).catch(() => {}); }
      return route.fulfill({ json: observation });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic scalar project/ }).click();
  const select = page.getByLabel("Project fact"), check = page.getByRole("button", { name: "Check disagreement" });
  await select.selectOption(factId); expect(reads).toBe(0); await check.click();
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toBeVisible();
  await expect(page.getByText("2026-11-01", { exact: true })).toBeVisible();
  await expect(page.getByText(`Evidence ${id(110)}`, { exact: false })).toBeVisible();
  hold = true; await check.click(); await entered;
  await select.selectOption(otherFact); release();
  await expect.poll(() => page.evaluate(() => (window as unknown as { scalarLateCount?: number }).scalarLateCount ?? 0)).toBe(1);
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toHaveCount(0);
  hold = false; await select.selectOption(factId); await check.click();
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toBeVisible();
  denyCatalogue = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toHaveCount(0);
  await expect(page.getByText("The fact list is unavailable.", { exact: false })).toBeVisible();
  denyCatalogue = false; await page.getByRole("button", { name: "Refresh fact list" }).click();
  await select.selectOption(factId); await check.click();
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toBeVisible();
  entered = new Promise<void>((resolve) => { arrived = resolve; }); gate = new Promise<void>((resolve) => { release = resolve; });
  hold = true; await check.click(); await entered;
  try { await page.getByRole("button", { name: "← All projects" }).click();
    await page.getByRole("button", { name: /Second scalar project/ }).click(); }
  finally { release(); }
  await expect.poll(() => page.evaluate(() => (window as unknown as { scalarLateCount?: number }).scalarLateCount ?? 0)).toBe(2);
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toHaveCount(0);
  hold = false; await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Synthetic scalar project/ }).click();
  await select.selectOption(factId); await check.click();
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toBeVisible();
  await page.waitForTimeout(16000); holdMe = true; demoted = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  try { await meEntered; await expect(page.getByText("Sources currently disagree.", { exact: false })).toHaveCount(0); }
  finally { releaseMe(); }
  await expect(page.getByLabel("Project fact")).toHaveCount(0);
});

test("pages facts and withholds a late answer from the previous page", async ({ page }) => {
  test.setTimeout(60000);
  const first = Array.from({ length: 50 }, (_, index) => ({ factId: index === 0 ? factId : id(1000 + index),
    factType: `project.fact_${String(index).padStart(2, "0")}`, revision: 2 }));
  const next = first[49]!.factType, later = { factId: otherFact, factType: "project.later", revision: 2 };
  let persona = "", entered!: () => void, release!: () => void, reads = 0, laterQuery = "";
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/leadership-conflict") && init) {
        const rest = { ...init }; delete rest.signal;
        return original(input, rest).then(async (response) => {
          await response.clone().text();
          if (response.headers.get("x-synthetic-late")) (window as unknown as { pageLate?: boolean }).pageLate = true;
          return response;
        });
      }
      return original(input, init);
    };
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${projectId}`) return route.fulfill({ json: project });
    if (path === `/projects/${projectId}/canonical`) return route.fulfill({ json: detail });
    if (path === `/projects/${projectId}/facts`) return route.fulfill({ json: url.searchParams.get("afterFactType") === next
      ? { canAppend: false, canConfigure: false, facts: [later], next: null }
      : { canAppend: false, canConfigure: false, facts: first, next } });
    if (path.endsWith(`/fact-observations/${factId}/leadership-conflict`)) {
      reads++; entered(); await gate;
      return route.fulfill({ json: { ...observation, factType: first[0]!.factType }, headers: { "x-synthetic-late": "1" } }).catch(() => {});
    }
    if (path.endsWith(`/fact-observations/${otherFact}/leadership-conflict`)) {
      reads++; laterQuery = url.searchParams.get("afterFactType") ?? "";
      return route.fulfill({ json: { ...observation, factId: otherFact, factType: later.factType } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic scalar project/ }).click();
  const select = page.getByLabel("Project fact"), check = page.getByRole("button", { name: "Check disagreement" });
  await select.selectOption(factId); expect(reads).toBe(0); await check.click(); await waiting;
  try {
    await page.getByRole("button", { name: "Next fact page" }).click();
    await expect(select).toHaveValue(""); await expect(select.locator(`option[value="${otherFact}"]`)).toHaveCount(1);
  } finally { release(); }
  await expect.poll(() => page.evaluate(() => (window as unknown as { pageLate?: boolean }).pageLate ?? false)).toBe(true);
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toHaveCount(0);
  await select.selectOption(otherFact); await check.click();
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toBeVisible();
  expect(laterQuery).toBe(next); expect(reads).toBe(2);
  await page.getByRole("button", { name: "First fact page" }).click();
  await expect(page.getByText("Sources currently disagree.", { exact: false })).toHaveCount(0);
  await expect(select).toHaveValue("");
});

test("rejects a repeated catalogue cursor and can restart from the first page", async ({ page }) => {
  let persona = "";
  const pageRows = (base: number, lastType: string) => Array.from({ length: 50 }, (_, index) => ({
    factId: id(base + index), factType: index === 49 ? lastType : `project.item_${base}_${index}`, revision: 1,
  }));
  const first = pageRows(1000, "project.cursor_a"), second = pageRows(2000, "project.cursor_b"), third = pageRows(3000, "project.cursor_a");
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${projectId}`) return route.fulfill({ json: project });
    if (path === `/projects/${projectId}/canonical`) return route.fulfill({ json: detail });
    if (path === `/projects/${projectId}/facts`) {
      const after = url.searchParams.get("afterFactType");
      const facts = after === null ? first : after === "project.cursor_a" ? second : third;
      return route.fulfill({ json: { canAppend: false, canConfigure: false, facts, next: facts[49]!.factType } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic scalar project/ }).click();
  await page.getByRole("button", { name: "Next fact page" }).click();
  await expect(page.getByLabel("Project fact").locator(`option[value="${second[0]!.factId}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: "Next fact page" }).click();
  await expect(page.getByText("The fact list is unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Project fact")).toHaveCount(0);
  await page.getByRole("button", { name: "First fact page" }).click();
  await expect(page.getByLabel("Project fact").locator(`option[value="${first[0]!.factId}"]`)).toHaveCount(1);
});
