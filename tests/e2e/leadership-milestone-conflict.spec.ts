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
  await expect(panel.getByRole("button", { name: "Check for a recorded request" })).toHaveCount(0);
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

test("dual-role request status uses its own conflict snapshot and hides stale results", async ({ page }) => {
  test.setTimeout(60000);
  let denied = false, hold = false, holdSelection = false, holdSignout = false, oversized = false, expiresSoon = false, requestStatus = "MATCHING_REQUEST_RECORDED", reads = 0;
  const requestConflict = { ...conflict, positions: conflict.positions.map((position, index) => ({ ...position, supports: [support(300 + index * 100)] })) };
  const heldConflict = { ...conflict, positions: conflict.positions.map((position, index) => ({ ...position, supports: [support(500 + index * 100)] })) };
  let arrived!: () => void, release!: () => void, delivered!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const finished = new Promise<void>((resolve) => { delivered = resolve; });
  let arrivedSignout!: () => void, releaseSignout!: () => void, deliveredSignout!: () => void;
  const enteredSignout = new Promise<void>((resolve) => { arrivedSignout = resolve; });
  const gateSignout = new Promise<void>((resolve) => { releaseSignout = resolve; });
  const finishedSignout = new Promise<void>((resolve) => { deliveredSignout = resolve; });
  let arrivedSelection!: () => void, releaseSelection!: () => void, deliveredSelection!: () => void;
  const enteredSelection = new Promise<void>((resolve) => { arrivedSelection = resolve; });
  const gateSelection = new Promise<void>((resolve) => { releaseSelection = resolve; });
  const finishedSelection = new Promise<void>((resolve) => { deliveredSelection = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("leadership-manager-request-observation") && init) {
        const { signal: _signal, ...rest } = init;
        return original(input, rest).then((response) => {
          const tag = response.headers.get("x-synthetic-held");
          if (tag && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
              const chunks: Uint8Array[] = []; let total = 0;
              reader.read = async () => {
                const part = await read();
                if (!part.done) { total += part.value.byteLength; if (tag !== "oversized" && total <= 262144) chunks.push(part.value); }
                if (part.done && tag !== "oversized") {
                  const bytes = new Uint8Array(total); let offset = 0;
                  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                  const text = new TextDecoder().decode(bytes);
                  if (text.includes("30000000-0000-4000-8000-000000000510")) {
                    const state = window as unknown as { consumedRequestResponses?: string[] };
                    state.consumedRequestResponses = [...(state.consumedRequestResponses ?? []), tag];
                  }
                }
                return part;
              };
              reader.cancel = async (reason) => {
                const state = window as unknown as { cancelledRequestResponses?: { tag: string; bytes: number }[] };
                state.cancelledRequestResponses = [...(state.cancelledRequestResponses ?? []), { tag, bytes: total }];
                return cancel(reason);
              };
              return reader;
            }) as typeof stream.getReader;
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
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-dual" } });
    if (path === "/me") return route.fulfill({ json: { subject: "synthetic-dual", customerId, roles: ["leadership", "pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/canonical`) return route.fulfill({ json: detail });
    if (path.endsWith("/leadership-conflict-observation")) return route.fulfill({ json: conflict });
    if (path.endsWith("/leadership-manager-request-observation")) {
      reads++;
      if (denied) return route.fulfill({ status: 503, json: { message: "Unavailable" } });
      if (oversized) return route.fulfill({ status: 200, contentType: "application/json", headers: { "x-synthetic-held": "oversized" },
        body: JSON.stringify({ observation: requestConflict, requestStatus }) + " ".repeat(262145) });
      if (hold) {
        arrived(); await gate;
        try { await route.fulfill({ json: { observation: heldConflict, requestStatus: "MATCHING_REQUEST_RECORDED" }, headers: { "x-synthetic-held": "mode" } }); } finally { delivered(); }
        return;
      }
      if (holdSignout) {
        arrivedSignout(); await gateSignout;
        try { await route.fulfill({ json: { observation: heldConflict, requestStatus: "MATCHING_REQUEST_RECORDED" }, headers: { "x-synthetic-held": "signout" } }); } finally { deliveredSignout(); }
        return;
      }
      if (holdSelection) {
        arrivedSelection(); await gateSelection;
        try { await route.fulfill({ json: { observation: heldConflict, requestStatus: "MATCHING_REQUEST_RECORDED" }, headers: { "x-synthetic-held": "selection" } }); } finally { deliveredSelection(); }
        return;
      }
      const observation = expiresSoon ? { ...requestConflict, positions: requestConflict.positions.map((position) => ({ ...position,
        supports: position.supports.map((row) => ({ ...row, assessedValidUntil: new Date(Date.parse(requestConflict.asOf) + 1500).toISOString() })) })) } : requestConflict;
      return route.fulfill({ json: { observation, requestStatus } });
    }
    if (path === "/pm/action-queue") return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic conflict project/ }).click();
  await page.getByLabel("Milestone", { exact: true }).selectOption(id(2));
  await page.getByLabel("Question", { exact: true }).fill("Does the selected milestone's recorded completion conflict with required work?");
  await page.getByRole("button", { name: "Check question" }).click();
  await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  expect(reads).toBe(0);
  await page.getByRole("button", { name: "Check for a recorded request" }).click();
  await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toBeVisible();
  await expect(page.getByText(`Evidence ${id(310)}`, { exact: false })).toBeVisible();
  await expect(page.getByText(`Evidence ${id(110)}`, { exact: false })).toHaveCount(0);
  await expect(page.getByText("This does not confirm a current assignment or delivery", { exact: false })).toBeVisible();
  oversized = true; await page.getByRole("button", { name: "Refresh completion check" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { cancelledRequestResponses?: { tag: string; bytes: number }[] })
    .cancelledRequestResponses?.some((item) => item.tag === "oversized" && item.bytes > 262144) ?? false)).toBe(true);
  await expect(page.getByText("Completion check is unavailable", { exact: false })).toBeVisible(); oversized = false;
  expiresSoon = true; await page.getByRole("button", { name: "Refresh completion check" }).click();
  await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toBeVisible();
  expiresSoon = false; denied = true;
  await expect(page.getByText("Completion check is unavailable", { exact: false })).toBeVisible({ timeout: 12000 });
  await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toHaveCount(0);
  denied = false; await page.getByRole("button", { name: "Refresh completion check" }).click();
  await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toBeVisible();
  denied = true; await page.getByRole("button", { name: "Refresh completion check" }).click();
  await expect(page.getByText("Completion check is unavailable", { exact: false })).toBeVisible();
  await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toHaveCount(0);
  denied = false; hold = true; await page.getByRole("button", { name: "Refresh completion check" }).click(); await entered;
  await page.evaluate(() => {
    const state = window as unknown as { staleRequestSeen?: boolean }; state.staleRequestSeen = false;
    const marker = "30000000-0000-4000-8000-000000000510";
    const check = () => { if (document.body.textContent?.includes(marker)) state.staleRequestSeen = true; };
    new MutationObserver((records) => { for (const record of records) if (record.oldValue?.includes(marker) ||
      [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(marker))) state.staleRequestSeen = true; check(); })
      .observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  });
  await page.evaluate(() => {
    const canary = document.createElement("span"); canary.textContent = "30000000-0000-4000-8000-000000000510";
    document.body.append(canary); canary.remove();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { staleRequestSeen?: boolean }).staleRequestSeen)).toBe(true);
  await page.evaluate(() => { (window as unknown as { staleRequestSeen?: boolean }).staleRequestSeen = false; });
  try {
    await page.getByRole("button", { name: "Show completion check only" }).click();
    await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
    await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toHaveCount(0);
  } finally { release(); }
  await finished; hold = false;
  await expect.poll(() => page.evaluate(() => (window as unknown as { consumedRequestResponses?: string[] }).consumedRequestResponses ?? [])).toContain("mode");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as unknown as { staleRequestSeen?: boolean }).staleRequestSeen)).toBe(false);
  await expect(page.getByText("a request was recorded for these contributing positions", { exact: false })).toHaveCount(0);
  requestStatus = "NO_MATCHING_REQUEST_RECORDED";
  await page.getByRole("button", { name: "Check for a recorded request" }).click();
  await expect(page.getByText("no request was recorded for these contributing positions", { exact: false })).toBeVisible();
  holdSelection = true; await page.getByRole("button", { name: "Refresh completion check" }).click(); await enteredSelection;
  try { await page.getByLabel("Milestone", { exact: true }).selectOption(id(3)); } finally { releaseSelection(); }
  await finishedSelection; holdSelection = false;
  await expect.poll(() => page.evaluate(() => (window as unknown as { consumedRequestResponses?: string[] }).consumedRequestResponses ?? [])).toContain("selection");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as unknown as { staleRequestSeen?: boolean }).staleRequestSeen)).toBe(false);
  await page.getByLabel("Milestone", { exact: true }).selectOption(id(2));
  await page.getByLabel("Question", { exact: true }).fill("Does the selected milestone's recorded completion conflict with required work?");
  await page.getByRole("button", { name: "Check question" }).click();
  await expect(page.getByText("Completion is not established", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Check for a recorded request" }).click();
  await expect(page.getByText("no request was recorded for these contributing positions", { exact: false })).toBeVisible();
  holdSignout = true; await page.getByRole("button", { name: "Refresh completion check" }).click(); await enteredSignout;
  try { await page.getByRole("button", { name: "Sign out" }).click(); } finally { releaseSignout(); }
  await finishedSignout;
  await expect.poll(() => page.evaluate(() => (window as unknown as { consumedRequestResponses?: string[] }).consumedRequestResponses ?? [])).toContain("signout");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as unknown as { staleRequestSeen?: boolean }).staleRequestSeen)).toBe(false);
  await expect(page.getByText("no request was recorded for these contributing positions", { exact: false })).toHaveCount(0);
});
