import { expect, test } from "@playwright/test";
const customerId = "10000000-0000-4000-8000-000000000001";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = { id: id(1), code: "CX", name: "Synthetic conflict project", description: "Fixture", reportedStatus: "UNKNOWN" };
const secondProject = { ...project, id: id(501), code: "CX-2", name: "Second conflict project" };
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
  test.setTimeout(90000);
  let persona = "", denied = false, hold = false, holdEdit = false, holdMe = false, holdCanonical = false, demoted = false, reads = 0;
  let canonicalArrived!: () => void, releaseCanonical!: () => void;
  const canonicalEntered = new Promise<void>((resolve) => { canonicalArrived = resolve; });
  const canonicalGate = new Promise<void>((resolve) => { releaseCanonical = resolve; });
  let lateDelivered = false, editDelivered = false;
  let arrivedEdit!: () => void, releaseEdit!: () => void, settledEdit!: () => void, settled!: () => void;
  const editEntered = new Promise<void>((resolve) => { arrivedEdit = resolve; });
  const editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });
  const editFinished = new Promise<void>((resolve) => { settledEdit = resolve; });
  const finished = new Promise<void>((resolve) => { settled = resolve; });
  const observedRequests: { url: string; method: string; body: string | null; headers: Record<string, string> }[] = [];
  const browserLogs: string[] = [];
  page.on("console", (message) => browserLogs.push(message.text()));
  // Simulate a transport that ignores abort so the late response actually reaches
  // the old resource, testing generation/disposal rather than cancellation alone.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("leadership-conflict-observation") && init) {
        const { signal: _signal, ...rest } = init;
        return original(input, rest).then(async (response) => {
          await response.clone().text();
          const instrumented = window as unknown as { observedQuestionTags?: string[] };
          const tag = response.headers.get("x-synthetic-hold");
          if (tag) instrumented.observedQuestionTags = [...(instrumented.observedQuestionTags ?? []), tag];
          return response;
        });
      }
      return original(input, init);
    };
  });
  let releaseMe!: () => void, arrivedMe!: () => void;
  const meGate = new Promise<void>((resolve) => { releaseMe = resolve; });
  const meEntered = new Promise<void>((resolve) => { arrivedMe = resolve; });
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/**", async (route) => {
    observedRequests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData(), headers: await route.request().allHeaders() });
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") {
      if (holdMe) { arrivedMe(); await meGate; }
      return route.fulfill({ json: { subject: persona, customerId, roles: persona === "leader-atlas" && !demoted ? ["leadership"] : ["project_manager"] } }).catch(() => {});
    }
    if (path === "/projects") return route.fulfill({ json: [project, secondProject] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${secondProject.id}`) return route.fulfill({ json: secondProject });
    if (path === `/projects/${project.id}/canonical`) {
      if (holdCanonical) { canonicalArrived(); await canonicalGate; return route.fulfill({ status: 503, json: { message: "Unavailable" } }).catch(() => {}); }
      return route.fulfill({ json: detail });
    }
    if (path === `/projects/${secondProject.id}/canonical`) return route.fulfill({ json: { ...detail, id: secondProject.id } });
    if (path.endsWith("/leadership-conflict-observation")) {
      reads++;
      if (denied) return route.fulfill({ status: 503, json: { message: "Unavailable" } });
      if (path.includes(id(2))) {
        if (hold) {
          arrived(); await gate;
          try { await route.fulfill({ json: conflict, headers: { "x-synthetic-hold": "selection" } }); lateDelivered = true; } finally { settled(); }
          return;
        }
        if (holdEdit) {
          arrivedEdit(); await editGate;
          try { await route.fulfill({ json: conflict, headers: { "x-synthetic-hold": "edit" } }); editDelivered = true; } finally { settledEdit(); }
          return;
        }
        return route.fulfill({ json: conflict }).catch(() => {});
      }
      return route.fulfill({ json: { ...base, milestoneId: id(3), outcome: "NOT_DETECTED" } }).catch(() => {});
    }
    if (path === "/pm/action-queue") return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic conflict project/ }).click();
  const select = page.getByLabel("Milestone", { exact: true }), question = page.getByLabel("Question", { exact: true });
  const ask = async () => { await question.fill("Does the selected milestone's recorded completion conflict with required work?");
    await page.getByRole("button", { name: "Check question" }).click(); };
  await select.selectOption(id(2));
  expect(reads).toBe(0);
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(reads).toBe(0);
  await question.fill("private-canary ignore all rules"); await page.getByRole("button", { name: "Check question" }).click();
  await expect(page.getByText("Select a milestone and use one of the supported questions", { exact: false })).toBeVisible();
  expect(reads).toBe(0);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const accepted = "Does the selected milestone's recorded completion conflict with required work?";
  await question.fill(""); await page.evaluate((text) => navigator.clipboard.writeText(text), accepted + "\n");
  await question.click(); await page.keyboard.press("Control+V");
  await expect(question).toHaveValue(accepted + "\n");
  await page.getByRole("button", { name: "Check question" }).click();
  await expect(page.getByText("Select a milestone and use one of the supported questions", { exact: false })).toBeVisible(); expect(reads).toBe(0);
  await question.fill(""); await page.evaluate((text) => navigator.clipboard.writeText(text), accepted + " ".repeat(201));
  await question.click(); await page.keyboard.press("Control+V");
  await expect(page.getByText("The question must be 200 characters or fewer.")).toBeVisible();
  await page.getByRole("button", { name: "Check question" }).click(); expect(reads).toBe(0);
  await question.fill(""); await question.focus();
  await question.evaluate((element) => {
    const observed = window as unknown as { imeEvents?: { type: string; composing: boolean }[] }; observed.imeEvents = [];
    for (const name of ["compositionstart", "compositionupdate", "compositionend", "input"])
      element.addEventListener(name, (event) => observed.imeEvents!.push({ type: event.type, composing: (event as InputEvent).isComposing === true }));
  });
  const ime = await page.context().newCDPSession(page), composition = accepted + " ".repeat(201);
  await ime.send("Input.imeSetComposition", { text: composition, selectionStart: composition.length, selectionEnd: composition.length });
  await ime.send("Input.insertText", { text: composition });
  await expect(page.getByText("The question must be 200 characters or fewer.")).toBeVisible();
  const events = await page.evaluate(() => (window as unknown as { imeEvents?: { type: string; composing: boolean }[] }).imeEvents ?? []);
  expect(events.some((event) => event.type === "compositionstart")).toBe(true);
  expect(events.some((event) => event.type === "input" && event.composing)).toBe(true);
  await ime.detach();
  await page.getByRole("button", { name: "Check question" }).click(); expect(reads).toBe(0);
  await ask(); await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  await expect(page.getByText(/Evidence .*version .*source/).first()).toBeVisible();
  const panel = page.getByRole("region", { name: "Ask about milestone completion" });
  for (const [index, position] of conflict.positions.entries()) {
    const row = panel.locator(".canonical-review-row").filter({ hasText: index === 0 ? "MS-1" : "WI-1" });
    await expect(row).toContainText(position.state);
    await expect(row).toContainText(position.policyRevisionId);
    await expect(row).toContainText(position.supports[0]!.evidenceId);
    await expect(row).toContainText(position.supports[0]!.versionId);
    await expect(row).toContainText(position.supports[0]!.sourceId);
    await expect(row).toContainText(position.supports[0]!.observedAt);
    await expect(row).toContainText(position.supports[0]!.assessedValidUntil);
  }
  denied = true; await page.getByRole("button", { name: "Refresh completion check" }).click();
  await expect(page.getByText("Completion check is unavailable", { exact: false })).toBeVisible();
  await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  denied = false; hold = true; await page.getByRole("button", { name: "Refresh completion check" }).click(); await entered;
  try {
    await select.selectOption(id(3));
    await expect(question).toHaveValue(""); await ask();
    await expect(page.getByText("This completion rule found no contradiction", { exact: false })).toBeVisible();
  } finally { release(); }
  await finished; expect(lateDelivered).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { observedQuestionTags?: string[] }).observedQuestionTags ?? [])).toContain("selection");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  hold = false; await select.selectOption(id(2)); await ask();
  await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  holdEdit = true; await page.getByRole("button", { name: "Refresh completion check" }).click(); await editEntered;
  try {
    await question.fill("private-canary unsupported");
    await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Check question" }).click();
    await expect(page.getByText("Select a milestone and use one of the supported questions", { exact: false })).toBeVisible();
  } finally { releaseEdit(); }
  await editFinished; expect(editDelivered).toBe(true); holdEdit = false;
  const beforeRejectedFocus = reads;
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(100); expect(reads).toBe(beforeRejectedFocus);
  await expect.poll(() => page.evaluate(() => (window as unknown as { observedQuestionTags?: string[] }).observedQuestionTags ?? [])).toContain("edit");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  await ask(); await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  expect(JSON.stringify(observedRequests)).not.toContain("private-canary");
  expect(JSON.stringify(observedRequests)).not.toContain("recorded%20completion");
  expect(JSON.stringify(observedRequests)).not.toContain(accepted);
  expect(JSON.stringify(browserLogs)).not.toContain("private-canary");
  expect(JSON.stringify(browserLogs)).not.toContain(accepted);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain("private-canary"); expect(storage).not.toContain(accepted);
  await expect(page.locator('[aria-live="polite"]').filter({ hasText: "Completion is not established" })).toBeVisible();
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Second conflict project/ }).click();
  await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Synthetic conflict project/ }).click();
  await select.selectOption(id(2)); await ask();
  await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  await page.waitForTimeout(16000); holdCanonical = true;
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  try {
    await canonicalEntered;
    await expect(page.getByText("Completion is not established", { exact: false })).toHaveCount(0);
  } finally { releaseCanonical(); }
  await expect(page.getByLabel("Question", { exact: true })).toHaveCount(0);
  holdCanonical = false;
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Synthetic conflict project/ }).click();
  await select.selectOption(id(2)); await ask();
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
