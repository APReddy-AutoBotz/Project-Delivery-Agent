import { expect, test, type Page } from "@playwright/test";

const customerId = "10000000-0000-4000-8000-000000000001";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projects = [1, 2].map((n) => ({ id: id(n), code: `H-${n}`, name: `Health scope project ${n}`,
  description: "Synthetic fixture", reportedStatus: "UNKNOWN" }));
const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
const canonical = (project: typeof projects[number]) => ({ ...project, configured: true,
  portfolio: { id: id(50), name: "Synthetic portfolio" }, programme: null,
  creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates,
  responsibilities: [], sprints: [], milestones: [{ id: id(10), key: "MS-1", name: "Release", state: "COMPLETE", dates }],
  workItems: [], requiredWorkItems: [], raidItems: [], sourceMappings: [], sourceMappingsWithheld: true });
const assessment = (project: typeof projects[number]) => ({ assessmentId: id(project.id === id(1) ? 101 : 102), projectId: project.id,
  assessedAt: "2026-10-21T00:00:00.000Z", coverage: "SCHEDULE_ONLY", ruleRevision: `health-canary-${project.code}`,
  envelopeHash: "a".repeat(64), contentAvailable: false, input: null, result: null, replayed: false });

async function watchStaleCanary(page: Page, canary: string) {
  await page.evaluate(async (text) => {
    const state = window as unknown as { staleHealthMutations: string[]; staleHealthObserver: MutationObserver };
    state.staleHealthMutations = [];
    state.staleHealthObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") state.staleHealthMutations.push(record.oldValue ?? "", record.target.textContent ?? "");
        for (const node of [...record.addedNodes, ...record.removedNodes]) state.staleHealthMutations.push(node.textContent ?? "");
      }
    });
    state.staleHealthObserver.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
    const positive = document.createElement("span"); positive.textContent = "initial";
    document.body.append(positive); positive.firstChild!.textContent = text; positive.firstChild!.textContent = "cleared"; positive.remove();
    await Promise.resolve();
  }, canary);
  await expect.poll(() => page.evaluate((text) => (window as unknown as { staleHealthMutations: string[] }).staleHealthMutations.some((value) => value.includes(text)), canary)).toBe(true);
  await page.evaluate(() => { (window as unknown as { staleHealthMutations: string[] }).staleHealthMutations = []; });
}
async function expectNoStaleCanary(page: Page, canary: string) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate((text) => (window as unknown as { staleHealthMutations: string[] }).staleHealthMutations.some((value) => value.includes(text)), canary)).toBe(false);
}
async function stopStaleWatch(page: Page) {
  await page.evaluate(() => (window as unknown as { staleHealthObserver?: MutationObserver }).staleHealthObserver?.disconnect()).catch(() => {});
}

test("the separate milestone link has keyboard focus and no implicit observation or write", async ({ page }) => {
  test.setTimeout(90000);
  let observationReads = 0, writes = 0, persona = "", holdStructure = false, arrived!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) {
      if (holdStructure) { holdStructure = false; arrived(); await gate; }
      return route.fulfill({ json: canonical(structure) }).catch(() => {});
    }
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) return route.fulfill({ json: assessment(health) });
    if (path.includes("leadership-conflict-observation")) { observationReads++; return route.fulfill({ status: 503 }); }
    if (path.endsWith("/health-assessments") && route.request().method() === "POST") { writes++; return route.fulfill({ status: 500 }); }
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  const link = page.getByRole("link", { name: /separate milestone completion check/i });
  await expect(link).toBeVisible(); await link.focus(); await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe("delivery-structure");
  expect(observationReads).toBe(0); expect(writes).toBe(0);
  await expect(page.getByText("Ask about milestone completion")).toHaveCount(1);
  const selected = page.getByLabel("Milestone", { exact: true });
  const question = page.getByLabel("Question", { exact: true });
  await selected.selectOption(id(10)); await question.fill("A draft question");
  try {
    holdStructure = true; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await entered;
    await expect(selected).toHaveCount(0); release();
    await expect(selected).toHaveValue(id(10)); await expect(question).toHaveValue("A draft question");
  } finally { release(); }
  await expect(page.getByRole("button", { name: "Run assessment" })).toBeEnabled();
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const back = buttons.find((button) => button.textContent?.includes("All projects"));
    const stale = buttons.find((button) => button.textContent?.trim() === "Run assessment");
    if (!back || !stale) throw new Error("Positive control buttons missing");
    back.click(); stale.click();
  });
  await expect(page.getByRole("button", { name: /Health scope project 1/ })).toBeVisible();
  expect(writes).toBe(0);
});

test("withheld assessment content clears previously displayed synthetic evidence in both panels", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", withheld = false;
  const target = "synthetic-private-target-canary";
  const visibleAssessment = { ...assessment(projects[0]!), contentAvailable: true,
    input: { scheduleHealthPolicy: { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1 } },
    result: { reported: { status: "UNKNOWN", sourceFact: { source: { recordId: "synthetic-project" } } },
      calculated: { status: "AMBER", rationale: { text: "Synthetic rationale" } }, contradiction: null,
      objectiveSignals: [{ signalId: "synthetic-signal", kind: "OVERDUE_MILESTONE", targetType: "MILESTONE", targetKey: target,
        state: "OPEN", severity: "AMBER", targetSource: { recordId: "synthetic-record" }, sourceFacts: [], rule: { parameters: [] } }] } };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`)
      return route.fulfill({ json: withheld ? assessment(projects[0]!) : visibleAssessment });
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByText(target, { exact: false })).toHaveCount(2);
  withheld = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText(target, { exact: false })).toHaveCount(0);
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  await expect(page.getByText("No assessment has been saved.")).toHaveCount(0);
  await expect(page.getByText(/content is unavailable under current source access or retention/i).first()).toBeVisible();
});

test("a nonleader receives no milestone entry point or observation request", async ({ page }) => {
  test.setTimeout(90000);
  let observations = 0, persona = "";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) return route.fulfill({ json: assessment(health) });
    if (path.includes("leadership-conflict-observation")) observations++;
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).first().click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  await expect(page.getByRole("link", { name: /separate milestone completion check/i })).toHaveCount(0);
  await expect(page.getByText("Ask about milestone completion")).toHaveCount(0);
  expect(observations).toBe(0);
});

test("an old assessment body already being read cannot repopulate the new project", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "";
  await page.addInitScript(() => {
    const state = window as unknown as { armBody?: boolean; bodyReadStarted?: boolean; bodyReadFinished?: boolean; bodyAppEof?: boolean; bodyReaderReleased?: boolean; releaseBody?: () => void };
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!state.armBody || !url.includes("/health-assessments/latest") || !init) return original(input, init);
      state.armBody = false;
      const { signal: _signal, ...rest } = init;
      return original(input, rest).then(async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const gate = new Promise<void>((resolve) => { state.releaseBody = resolve; });
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (sent) return;
            sent = true; state.bodyReadStarted = true;
            await gate; controller.enqueue(bytes); controller.close(); state.bodyReadFinished = true;
          },
        }, { highWaterMark: 0 });
        const wrapped = new Response(body, { status: response.status, headers: response.headers });
        const stream = wrapped.body!;
        const getReader = stream.getReader.bind(stream);
        stream.getReader = (() => {
          const reader = getReader();
          const read = reader.read.bind(reader);
          const releaseLock = reader.releaseLock.bind(reader);
          reader.read = async () => { const value = await read(); if (value.done) state.bodyAppEof = true; return value; };
          reader.releaseLock = () => { releaseLock(); state.bodyReaderReleased = true; };
          return reader;
        }) as typeof stream.getReader;
        return wrapped;
      });
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) return route.fulfill({ json: assessment(health) });
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
    await page.evaluate(() => { (window as unknown as { armBody: boolean }).armBody = true; window.dispatchEvent(new Event("focus")); });
    await expect.poll(() => page.evaluate(() => (window as unknown as { bodyReadStarted?: boolean }).bodyReadStarted)).toBe(true);
    await page.getByRole("button", { name: "← All projects" }).click();
    await page.getByRole("button", { name: /Health scope project 2/ }).click();
    await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(2);
    await watchStaleCanary(page, "health-canary-H-1");
    await page.evaluate(() => (window as unknown as { releaseBody?: () => void }).releaseBody?.());
    await expect.poll(() => page.evaluate(() => (window as unknown as { bodyReadFinished?: boolean }).bodyReadFinished)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { bodyAppEof?: boolean }).bodyAppEof)).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { bodyReaderReleased?: boolean }).bodyReaderReleased)).toBe(true);
    await expectNoStaleCanary(page, "health-canary-H-1");
    await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(0);
    await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(2);
  } finally { await page.evaluate(() => (window as unknown as { releaseBody?: () => void }).releaseBody?.()).catch(() => {}); await stopStaleWatch(page); }
});

test("late old health bodies cannot restore either panel after a project switch", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", hold = false, denyHold = false, arrived!: () => void, release!: () => void, delivered = false;
  let deniedArrived!: () => void, releaseDenied!: () => void, denialDelivered = false;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const denialEntered = new Promise<void>((resolve) => { deniedArrived = resolve; });
  const denialGate = new Promise<void>((resolve) => { releaseDenied = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/health-assessments/latest") && init) {
        const { signal: _signal, ...rest } = init;
        return original(input, rest).then(async (response) => {
          await response.clone().text();
          const tag = response.headers.get("x-health-test");
          if (tag) (window as unknown as { healthTags?: string[] }).healthTags = [...((window as unknown as { healthTags?: string[] }).healthTags ?? []), tag];
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
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) {
      if (denyHold && health.id === projects[1]!.id) {
        denyHold = false; deniedArrived(); await denialGate;
        try { await route.fulfill({ status: 503, json: { message: "Unavailable" }, headers: { "x-health-test": "denied-body" } }); denialDelivered = true; }
        catch { /* A failed delivery cannot satisfy the positive control. */ }
        return;
      }
      if (hold && health.id === projects[0]!.id) {
        hold = false; arrived(); await gate;
        try { await route.fulfill({ json: assessment(health), headers: { "x-health-test": "old-body" } }); delivered = true; }
        catch { /* The assertion below distinguishes actual delivery from cancellation. */ }
        return;
      }
      return route.fulfill({ json: assessment(health) });
    }
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  try {
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  hold = true; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await entered;
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Health scope project 2/ }).click();
  await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(2);
  await watchStaleCanary(page, "health-canary-H-1");
  release(); await expect.poll(() => delivered).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { healthTags?: string[] }).healthTags ?? [])).toContain("old-body");
  await expectNoStaleCanary(page, "health-canary-H-1");
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(0);
  await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(2);
  denyHold = true; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await denialEntered;
  await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(0);
  await expect(page.getByText("No assessment has been saved.")).toHaveCount(0);
  releaseDenied(); await expect.poll(() => denialDelivered).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { healthTags?: string[] }).healthTags ?? [])).toContain("denied-body");
  await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(0);
  await expect(page.getByText("No assessment has been saved.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run assessment" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Assess schedule" })).toBeDisabled();
  } finally { release(); releaseDenied(); await stopStaleWatch(page); }
});

test("a lost assessment response keeps one retry key across panels and sign-in", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", healthReads = 0;
  const commandKeys: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) { healthReads++; return route.fulfill({ json: assessment(health) }); }
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
      commandKeys.push(route.request().postDataJSON().commandKey);
      if (commandKeys.length === 1) return route.abort("failed");
      return route.fulfill({ json: assessment(projects[0]!) });
    }
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  const login = async () => { await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2); };
  await page.goto("/"); await login();
  const beforeHide = healthReads;
  await page.evaluate(() => { window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(0);
  await page.waitForTimeout(100); expect(healthReads).toBe(beforeHide);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  await page.getByRole("button", { name: "Run assessment" }).click();
  await expect(page.getByText("A previous health write may still have an unknown outcome.", { exact: false }).first()).toBeVisible();
  expect(commandKeys).toHaveLength(1);
  await page.getByRole("button", { name: "Sign out" }).click(); await login();
  await expect(page.getByText("A previous health write may still have an unknown outcome.", { exact: false }).first()).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry previous assessment" }).last();
  await expect(retry).toBeEnabled(); await retry.click();
  await expect.poll(() => commandKeys.length).toBe(2);
  expect(commandKeys[1]).toBe(commandKeys[0]);
});

test("a held assessment response cannot start a second write across sign-in", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", arrived!: () => void, release!: () => void, delivered = false;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const commandKeys: string[] = [];
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/health-assessments") && init?.method === "POST") {
        return original(input, init).then(async (response) => {
          await response.clone().text();
          if (response.headers.get("x-health-write") === "held") (window as unknown as { heldHealthWrite?: boolean }).heldHealthWrite = true;
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
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) return route.fulfill({ json: assessment(health) });
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
      commandKeys.push(route.request().postDataJSON().commandKey);
      if (commandKeys.length === 1) {
        arrived(); await gate;
        try { await route.fulfill({ json: assessment(projects[0]!), headers: { "x-health-write": "held" } }); delivered = true; }
        catch { /* A canceled response cannot satisfy the positive control. */ }
        return;
      }
      return route.fulfill({ json: assessment(projects[0]!) });
    }
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  const login = async () => { await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click(); };
  try {
  await page.goto("/"); await login();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  await page.getByRole("button", { name: "Run assessment" }).click(); await entered;
  await page.getByRole("button", { name: "Sign out" }).click(); await login();
  await expect(page.getByRole("button", { name: "Run assessment" })).toHaveCount(0);
  expect(commandKeys).toHaveLength(1);
  release(); await expect.poll(() => delivered).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { heldHealthWrite?: boolean }).heldHealthWrite === true)).toBe(true);
  await expect(page.getByText("A previous health write may still have an unknown outcome.", { exact: false }).first()).toBeVisible();
  const retry = page.getByRole("button", { name: "Retry previous assessment" }).last();
  await expect(retry).toBeEnabled(); await retry.click(); await expect.poll(() => commandKeys.length).toBe(2);
  expect(commandKeys[1]).toBe(commandKeys[0]);
  } finally { release(); }
});
