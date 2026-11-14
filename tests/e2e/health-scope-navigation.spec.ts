import { expect, test, type Page } from "@playwright/test";

const customerId = "10000000-0000-4000-8000-000000000001";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projects = [1, 2].map((n) => ({ id: id(n), portfolioId: id(50), code: `H-${n}`, name: `Health scope project ${n}`,
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
const confirmation = (project: typeof projects[number]) => ({ ...assessment(project), ruleRevision: "schedule-health@1" });

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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
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
  await question.evaluate((element) => {
    const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
    if (!key) throw new Error("Milestone draft handler unavailable");
    (window as unknown as { oldMilestoneChange: (event: { target: { value: string } }) => void }).oldMilestoneChange =
      (element as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!.onChange;
  });
  try {
    holdStructure = true; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await entered;
    await expect(selected).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { oldMilestoneChange: (event: { target: { value: string } }) => void }).oldMilestoneChange({ target: { value: "Stale draft" } }));
    release();
    await expect(selected).toHaveValue(id(10)); await expect(question).toHaveValue("A draft question");
  } finally { release(); }
  await question.fill("Updated current draft"); await expect(question).toHaveValue("Updated current draft");
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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
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

test("a held policy save retains its original response through health revalidation", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", arrived!: () => void, release!: () => void, saves = 0, assessments = 0, navigations = 0;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let policy = { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null as string | null, changedAt: null as string | null };
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === "/admin/blocker-age-threshold-policy") return route.fulfill({ json: null });
    if (path === `/projects/${projects[0]!.id}/schedule-health-policy`) {
      if (route.request().method() === "POST") {
        saves++; const change = route.request().postDataJSON();
        expect(change).toMatchObject({ expectedRevision: 1, timeZone: "America/Los_Angeles", defaultMinimumOverdueDays: 2, targetOverrides: [] });
        arrived(); await gate;
        policy = { revision: 2, timeZone: change.timeZone, defaultMinimumOverdueDays: change.defaultMinimumOverdueDays, targetOverrides: change.targetOverrides, changedBy: "synthetic-pmo", changedAt: "2026-10-21T00:00:00.000Z" };
        return route.fulfill({ status: 200, json: policy });
      }
      return route.fulfill({ json: policy });
    }
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) return route.fulfill({ json: assessment(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
      assessments++; return route.fulfill({ status: 201, json: confirmation(projects[0]!) });
    }
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    const panel = page.getByRole("region", { name: "Project schedule overdue policy", exact: true });
    await panel.getByLabel("Schedule health time zone (IANA)").fill("America/Los_Angeles");
    await panel.getByLabel("Default overdue threshold (local calendar days)").fill("2");
    const before = navigations;
    const saved = page.waitForResponse((response) => response.url().endsWith(`/projects/${projects[0]!.id}/schedule-health-policy`) && response.request().method() === "POST")
      .then(async (response) => ({ status: response.status(), body: await response.json() }));
    void saved.catch(() => {});
    const click = panel.getByRole("button", { name: "Save project schedule policy" }).click();
    await entered; await expect(panel).toHaveCount(0); release(); await click;
    const response = await saved;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ revision: 2, timeZone: "America/Los_Angeles", defaultMinimumOverdueDays: 2, targetOverrides: [] });
    await expect(panel).toContainText("Schedule health policy revision 2: America/Los_Angeles");
    expect(saves).toBe(1); expect(navigations).toBe(before);
    await page.getByRole("button", { name: "Run assessment" }).click();
    await expect.poll(() => assessments).toBe(1);
  } finally { release(); }
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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Project manager / }).first().click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  await expect(page.getByRole("link", { name: /separate milestone completion check/i })).toHaveCount(0);
  await expect(page.getByText("Ask about milestone completion")).toHaveCount(0);
  expect(observations).toBe(0);
});

test("a current optional-resource 404 latches the scoped view until explicit recheck", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", denyFacts = true, factReads = 0, healthReads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) { healthReads++; return route.fulfill({ json: assessment(projects[0]!) }); }
    if (path === `/projects/${projects[0]!.id}/facts`) {
      factReads++;
      return denyFacts ? route.fulfill({ status: 404, json: { message: "Unavailable" } })
        : route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    }
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(0);
  expect(factReads).toBeGreaterThanOrEqual(1); const before = healthReads; denyFacts = false;
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("pagehide")); window.dispatchEvent(new Event("pageshow")); });
  await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
  expect(healthReads).toBe(before);
  await page.getByRole("button", { name: "Check access again", exact: true }).click();
  await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
  await expect.poll(() => healthReads).toBeGreaterThan(before);
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
      const rest = { ...init }; delete rest.signal;
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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
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
        const rest = { ...init }; delete rest.signal;
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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
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

test("a lost assessment response blocks another submission across panels and sign-in", async ({ page }) => {
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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
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
  const blocked = page.getByRole("button", { name: "Assessment outcome unknown" });
  await expect(blocked).toHaveCount(2);
  await expect(blocked.first()).toBeDisabled(); await expect(blocked.last()).toBeDisabled();
  expect(commandKeys).toHaveLength(1);
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
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
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
  const blocked = page.getByRole("button", { name: "Assessment outcome unknown" });
  await expect(blocked).toHaveCount(2);
  await expect(blocked.first()).toBeDisabled(); await expect(blocked.last()).toBeDisabled();
  expect(commandKeys).toHaveLength(1);
  } finally { release(); }
});

test("a late old-project write denial does not invalidate the current project list", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", projectListReads = 0, arrived!: () => void, release!: () => void;
  let oldDenialDelivered = false;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") { projectListReads++; return route.fulfill({ json: projects }); }
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) return route.fulfill({ json: selected });
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) return route.fulfill({ json: assessment(health) });
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
      arrived(); await gate;
      try { await route.fulfill({ status: 403, json: { message: "Unavailable" } }); oldDenialDelivered = true; }
      catch { /* The delivery assertion below must fail if the request is canceled. */ }
      return;
    }
    if (path === `/projects/${projects[1]!.id}/health-assessments` && route.request().method() === "POST")
      return route.fulfill({ status: 403, json: { message: "Unavailable" } });
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 503, json: { message: "Unavailable" } });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
    await page.getByRole("button", { name: "Run assessment" }).click(); await entered;
    await page.getByRole("button", { name: "← All projects" }).click();
    await page.getByRole("button", { name: /Health scope project 2/ }).click();
    const beforeOldDenial = projectListReads;
    release(); await expect.poll(() => oldDenialDelivered).toBe(true);
    await expect(page.getByText("A previous health write may still have an unknown outcome.", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(2);
    await page.waitForTimeout(250);
    expect(projectListReads).toBe(beforeOldDenial);
    // Positive control: a denial from the current project still invalidates.
    await page.getByRole("button", { name: "Run assessment" }).click();
    await expect.poll(() => projectListReads).toBeGreaterThan(beforeOldDenial);
    await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
    await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "Check access again", exact: true }).click();
    await expect(page.getByText("health-canary-H-2", { exact: false })).toHaveCount(2);
  } finally { release(); }
});

test("coalesced leadership refresh holds dual-role health writes until both reads settle", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", holding = false, heldReads = 0, writes = 0;
  let arrivedFirst!: () => void, arrivedSecond!: () => void, releaseFirst!: () => void, releaseSecond!: () => void;
  const firstEntered = new Promise<void>((resolve) => { arrivedFirst = resolve; });
  const secondEntered = new Promise<void>((resolve) => { arrivedSecond = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership", "pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === "/admin/blocker-age-threshold-policy") return route.fulfill({ json: null });
    if (path === `/projects/${projects[0]!.id}/schedule-health-policy`) return route.fulfill({ json: {
      revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null, changedAt: null,
    } });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) return route.fulfill({ json: assessment(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
      writes++; return route.fulfill({ status: 201, json: assessment(projects[0]!) });
    }
    if (path.endsWith("/facts")) {
      if (holding) {
        heldReads++;
        if (heldReads === 1) { arrivedFirst(); await firstGate; }
        else if (heldReads === 2) { arrivedSecond(); await secondGate; }
      }
      return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    }
    return route.fulfill({ status: 503, json: { message: "Unavailable" } });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    const assess = page.getByRole("button", { name: "Run assessment" });
    const refresh = page.getByRole("button", { name: "Refresh fact list" });
    await expect(assess).toBeEnabled(); await expect(refresh).toBeVisible();
    holding = true; await refresh.click(); await firstEntered;
    await expect(assess).toBeDisabled(); await refresh.click();
    expect(writes).toBe(0); releaseFirst(); await secondEntered;
    await expect(assess).toBeDisabled(); expect(writes).toBe(0);
    holding = false; releaseSecond(); await expect(assess).toBeEnabled();
    await assess.click(); await expect.poll(() => writes).toBe(1);
  } finally { releaseFirst(); releaseSecond(); }
});

test("deselecting a held leadership read releases its logical write barrier", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", writes = 0, arrived!: () => void, release!: () => void, delivered = false;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("leadership-state-disagreement")) return original(input, init);
      return original(input, init).then(async (response) => {
        await response.clone().text();
        if (response.headers.get("x-held-denial") === "yes") (window as unknown as { heldDenialRead?: boolean }).heldDenialRead = true;
        return response;
      });
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership", "pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === "/admin/blocker-age-threshold-policy") return route.fulfill({ json: null });
    if (path === `/projects/${projects[0]!.id}/schedule-health-policy`) return route.fulfill({ json: {
      revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null, changedAt: null,
    } });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) return route.fulfill({ json: assessment(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
      writes++; return route.fulfill({ status: 201, json: assessment(projects[0]!) });
    }
    if (path.endsWith("/leadership-state-disagreement")) {
      arrived(); await gate;
      try { await route.fulfill({ status: 403, json: { message: "synthetic-held-denial" }, headers: { "x-held-denial": "yes" } }); delivered = true; }
      catch { /* A canceled original cannot satisfy the delivery control. */ }
      return;
    }
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 503, json: { message: "Unavailable" } });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    const assess = page.getByRole("button", { name: "Run assessment" });
    await expect(assess).toBeEnabled();
    const milestone = page.getByLabel("Milestone", { exact: true });
    await milestone.selectOption(id(10));
    await page.getByRole("button", { name: "Check for conflicting milestone states" }).click();
    await entered; await expect(assess).toBeDisabled();
    await milestone.selectOption(""); await expect(assess).toBeEnabled();
    await assess.click(); await expect.poll(() => writes).toBe(1);
    expect(delivered).toBe(false); release(); await expect.poll(() => delivered).toBe(true);
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldDenialRead?: boolean }).heldDenialRead)).toBe(true);
    await expect(page.getByText("Current health access could not be established.")).toHaveCount(0);
    await expect(page.getByText("synthetic-held-denial")).toHaveCount(0);
  } finally { release(); }
});

test("a canceled read's processed denial cannot latch the unchanged health view", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", projectReads = 0, holding = true, arrived!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("leadership-state-disagreement")) return original(input, init);
      return original(input, init).then((response) => {
        const body = response.body;
        if (body && response.headers.get("x-canceled-denial") === "yes") {
          const getReader = body.getReader.bind(body);
          Object.defineProperty(body, "getReader", { value: () => {
            const reader = getReader(), unlock = reader.releaseLock.bind(reader);
            reader.releaseLock = () => { unlock(); (window as unknown as { originalDenialReleased?: boolean }).originalDenialReleased = true; };
            return reader;
          } });
        }
        return response;
      });
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") { projectReads++; return route.fulfill({ json: projects }); }
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) return route.fulfill({ json: assessment(projects[0]!) });
    if (path.endsWith("/leadership-state-disagreement")) {
      if (holding) { arrived(); await gate; }
      return route.fulfill({ status: 403, json: { message: "synthetic-canceled-denial" }, headers: { "x-canceled-denial": "yes" } });
    }
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 503, json: { message: "Unavailable" } });
  });
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    const assess = page.getByRole("button", { name: "Run assessment" }), milestone = page.getByLabel("Milestone", { exact: true });
    await expect(assess).toBeEnabled(); await milestone.selectOption(id(10));
    await page.getByRole("button", { name: "Check for conflicting milestone states" }).click(); await entered;
    await milestone.selectOption(""); await expect(assess).toBeEnabled();
    const before = projectReads; holding = false; release();
    await expect.poll(() => page.evaluate(() => (window as unknown as { originalDenialReleased?: boolean }).originalDenialReleased)).toBe(true);
    await expect(assess).toBeEnabled(); expect(projectReads).toBe(before);
    await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
    // Positive control in the same view: a current denial must latch access.
    await milestone.selectOption(id(10));
    await page.getByRole("button", { name: "Check for conflicting milestone states" }).click();
    await expect(page.getByText("Current health access could not be established.").first()).toBeVisible();
    await expect.poll(() => projectReads).toBeGreaterThan(before);
  } finally { release(); }
});

test("policy drafts survive uncertain saves and require review of changed revisions", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", thresholdWrites = 0, scheduleWrites = 0;
  let threshold = { revision: 1, minimumBlockerAgeDays: 3, auditRetentionHours: 24, changedBy: "synthetic", changedAt: "2026-10-21T00:00:00.000Z" };
  let schedule = { revision: 1, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [] as Array<{ targetType: "MILESTONE" | "WORK_ITEM"; targetKey: string; minimumOverdueDays: number }>, changedBy: null as string | null, changedAt: null as string | null };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) return route.fulfill({ json: assessment(projects[0]!) });
    if (path === "/admin/blocker-age-threshold-policy") {
      if (route.request().method() !== "POST") return route.fulfill({ json: threshold });
      thresholdWrites++; const change = route.request().postDataJSON();
      if (thresholdWrites === 1) { expect(change.expectedRevision).toBe(1); threshold = { ...threshold, revision: 2, minimumBlockerAgeDays: 4 }; return route.fulfill({ status: 409, json: {} }); }
      if (thresholdWrites === 3) { expect(change.expectedRevision).toBe(3); return route.fulfill({ json: { revision: 4, minimumBlockerAgeDays: 8, auditRetentionHours: 48 } }); }
      expect(change).toMatchObject({ expectedRevision: 2, minimumBlockerAgeDays: 7, auditRetentionHours: 48 });
      threshold = { ...threshold, revision: 3, minimumBlockerAgeDays: change.minimumBlockerAgeDays, auditRetentionHours: change.auditRetentionHours };
      return route.fulfill({ json: threshold });
    }
    if (path === `/projects/${projects[0]!.id}/schedule-health-policy`) {
      if (route.request().method() !== "POST") return route.fulfill({ json: schedule });
      scheduleWrites++; const change = route.request().postDataJSON();
      if (scheduleWrites === 1) { expect(change.expectedRevision).toBe(1); schedule = { ...schedule, revision: 2, targetOverrides: [{ targetType: "WORK_ITEM", targetKey: "WI-2", minimumOverdueDays: 5 }] }; return route.fulfill({ status: 503, json: {} }); }
      expect(change).toMatchObject({ expectedRevision: 2, timeZone: "America/New_York", defaultMinimumOverdueDays: 2, targetOverrides: [{ targetType: "MILESTONE", targetKey: "MS-1", minimumOverdueDays: 2 }] });
      schedule = { revision: 3, timeZone: change.timeZone, defaultMinimumOverdueDays: change.defaultMinimumOverdueDays, targetOverrides: [{ targetType: "MILESTONE", targetKey: "MS-1", minimumOverdueDays: 2 }], changedBy: "synthetic", changedAt: "2026-10-21T00:00:00.000Z" };
      return route.fulfill({ json: schedule });
    }
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  const thresholdPanel = page.getByRole("region", { name: "Customer-wide blocker-age threshold" });
  const schedulePanel = page.getByRole("region", { name: "Project schedule overdue policy" });
  await thresholdPanel.getByLabel("Minimum blocker age (UTC calendar days)").fill("7");
  await thresholdPanel.getByLabel("Threshold audit retention (hours)").fill("48");
  await schedulePanel.getByLabel("Schedule health time zone (IANA)").fill("America/New_York");
  await schedulePanel.getByLabel("Default overdue threshold (local calendar days)").fill("2");
  await schedulePanel.getByLabel("Per-target threshold overrides (JSON)").fill("[{}]");
  await schedulePanel.getByRole("button", { name: "Save project schedule policy" }).click();
  await expect(schedulePanel.getByText("Check the time zone, threshold and target overrides.")).toBeVisible();
  expect(scheduleWrites).toBe(0);
  await schedulePanel.getByLabel("Per-target threshold overrides (JSON)").fill('[{"minimumOverdueDays":2,"targetKey":"MS-1","targetType":"MILESTONE"}]');
  await thresholdPanel.getByRole("button", { name: "Save customer threshold" }).click();
  await expect(thresholdPanel.getByText("This draft was based on revision 1.", { exact: false })).toBeVisible();
  await expect(thresholdPanel.getByLabel("Minimum blocker age (UTC calendar days)")).toHaveValue("7");
  await expect(schedulePanel.getByLabel("Schedule health time zone (IANA)")).toHaveValue("America/New_York");
  await expect(thresholdPanel.getByRole("button", { name: "Save customer threshold" })).toBeDisabled();
  await thresholdPanel.getByRole("button", { name: "Use current revision for this draft" }).click();
  await thresholdPanel.getByRole("button", { name: "Save customer threshold" }).click();
  await expect(thresholdPanel.getByText("Current revision 3:", { exact: false })).toBeVisible();
  await schedulePanel.getByRole("button", { name: "Save project schedule policy" }).click();
  await expect(schedulePanel.getByText("This draft was based on revision 1.", { exact: false })).toBeVisible();
  await expect(schedulePanel.getByLabel("Schedule health time zone (IANA)")).toHaveValue("America/New_York");
  await expect(schedulePanel.getByText("WORK_ITEM WI-2: 5 days")).toBeVisible();
  await expect(schedulePanel.getByRole("button", { name: "Save project schedule policy" })).toBeDisabled();
  expect(scheduleWrites).toBe(1);
  await schedulePanel.getByRole("button", { name: "Use current revision for this draft" }).click();
  await schedulePanel.getByRole("button", { name: "Save project schedule policy" }).click();
  await expect(schedulePanel.getByText("Schedule health policy revision 3:", { exact: false })).toBeVisible();
  await expect(schedulePanel.getByText("The save outcome could not be confirmed.", { exact: false })).toHaveCount(0);
  await expect(schedulePanel.getByText("This draft was based on revision", { exact: false })).toHaveCount(0);
  await expect(schedulePanel.getByLabel("Per-target threshold overrides (JSON)")).toHaveValue(/"targetType": "MILESTONE"/);
  await thresholdPanel.getByLabel("Minimum blocker age (UTC calendar days)").fill("8");
  await thresholdPanel.getByRole("button", { name: "Save customer threshold" }).click();
  await expect(thresholdPanel.getByText("The save outcome could not be confirmed.", { exact: false })).toBeVisible();
  await expect(thresholdPanel.getByLabel("Minimum blocker age (UTC calendar days)")).toHaveValue("8");
  expect(thresholdWrites).toBe(3); expect(scheduleWrites).toBe(2);
});

test("policy drafts survive transient access-check errors but not a selection change", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", failProject = false, failIdentity = false, failures = 0, identityFailures = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") {
      if (failIdentity) { failIdentity = false; identityFailures++; return route.fulfill({ status: 503, json: {} }); }
      return route.fulfill({ json: { subject: persona, customerId, roles: ["pmo_admin"] } });
    }
    if (path === "/projects") return route.fulfill({ json: projects });
    const selected = projects.find((item) => path === `/projects/${item.id}`);
    if (selected) {
      if (failProject && selected.id === projects[0]!.id) { failProject = false; failures++; return route.fulfill({ status: 503, json: {} }); }
      return route.fulfill({ json: selected });
    }
    const structure = projects.find((item) => path === `/projects/${item.id}/canonical`);
    if (structure) return route.fulfill({ json: canonical(structure) });
    const health = projects.find((item) => path === `/projects/${item.id}/health-assessments/latest`);
    if (health) return route.fulfill({ json: assessment(health) });
    if (path === "/admin/blocker-age-threshold-policy") return route.fulfill({ json: null });
    if (path.endsWith("/schedule-health-policy")) return route.fulfill({ json: {
      revision: 0, timeZone: "UTC", defaultMinimumOverdueDays: 1, targetOverrides: [], changedBy: null, changedAt: null,
    } });
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  const field = page.getByLabel("Schedule health time zone (IANA)");
  await field.fill("America/Los_Angeles");
  failProject = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => failures).toBe(1); await expect(field).toHaveCount(0);
  await expect(page.locator('main.main > div.error[role="alert"]')).toContainText("The request could not be completed.");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(field).toHaveValue("America/Los_Angeles");
  failIdentity = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => identityFailures).toBe(1); await expect(field).toHaveCount(0);
  await expect(page.locator('main.main > div.error[role="alert"]')).toContainText("The request could not be completed.");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(field).toHaveValue("America/Los_Angeles");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Health scope project 2/ }).click();
  await expect(field).toHaveValue("UTC");
  await page.getByRole("button", { name: "← All projects" }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(field).toHaveValue("UTC");
});


for (const scenario of [
  { name: "valid 201", status: 201, body: confirmation(projects[0]!), confirmed: true, button: "Run assessment" },
  { name: "redacted replay 201", status: 201, body: { ...confirmation(projects[0]!), replayed: true }, confirmed: true, button: "Assess schedule" },
  { name: "unexpected 200", status: 200, body: confirmation(projects[0]!), confirmed: false, button: "Run assessment" },
  { name: "empty 204", status: 204, body: undefined, confirmed: false, button: "Assess schedule" },
  { name: "malformed 201", status: 201, body: {}, confirmed: false, button: "Run assessment" },
  { name: "wrong-project 201", status: 201, body: confirmation(projects[1]!), confirmed: false, button: "Assess schedule" },
]) {
  test(`assessment original response: ${scenario.name}`, async ({ page }) => {
    test.setTimeout(90000);
    let persona = "";
    const keys: string[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
      if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
      if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
      if (path === "/projects") return route.fulfill({ json: projects });
      if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
      if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
      if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) return route.fulfill({ json: assessment(projects[0]!) });
      if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") {
        keys.push(route.request().postDataJSON().commandKey);
        return scenario.body === undefined ? route.fulfill({ status: scenario.status }) : route.fulfill({ status: scenario.status, json: scenario.body });
      }
      if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
      return route.fulfill({ status: 404, json: { message: "Unavailable" } });
    });
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Health scope project 1/ }).click();
    await expect(page.getByText("health-canary-H-1", { exact: false })).toHaveCount(2);
    await page.getByRole("button", { name: scenario.button, exact: true }).click();
    await expect.poll(() => keys.length).toBe(1);
    if (scenario.confirmed) {
      const next = page.getByRole("button", { name: scenario.button, exact: true });
      await expect(next).toBeEnabled(); await next.click();
      await expect.poll(() => keys.length).toBe(2); expect(keys[1]).not.toBe(keys[0]);
    } else {
      const blocked = page.getByRole("button", { name: "Assessment outcome unknown" });
      await expect(blocked).toHaveCount(2);
      await expect(blocked.first()).toBeDisabled(); await expect(blocked.last()).toBeDisabled();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(blocked.first()).toBeDisabled(); expect(keys).toHaveLength(1);
    }
  });
}


test("an empty latest check does not resolve an uncertain assessment", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", posts = 0, latestReads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: projects });
    if (path === `/projects/${projects[0]!.id}`) return route.fulfill({ json: projects[0] });
    if (path === `/projects/${projects[0]!.id}/canonical`) return route.fulfill({ json: canonical(projects[0]!) });
    if (path === `/projects/${projects[0]!.id}/health-assessments/latest`) { latestReads++; return route.fulfill({ json: null }); }
    if (path === `/projects/${projects[0]!.id}/health-assessments` && route.request().method() === "POST") { posts++; return route.abort("failed"); }
    if (path.endsWith("/facts")) return route.fulfill({ json: { canAppend: false, canConfigure: false, facts: [], next: null } });
    return route.fulfill({ status: 404, json: { message: "Unavailable" } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Health scope project 1/ }).click();
  await expect(page.getByRole("button", { name: "Run assessment" })).toBeEnabled();
  await page.getByRole("button", { name: "Run assessment" }).click();
  await expect(page.getByText("No saved assessment was available at the latest check; the earlier request may still complete.")).toHaveCount(2);
  const beforeRefresh = latestReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => latestReads).toBeGreaterThan(beforeRefresh);
  await expect(page.getByText("No saved assessment was available at the latest check; the earlier request may still complete.")).toHaveCount(2);
  await expect(page.getByText("No assessment has been saved.")).toHaveCount(0);
  await expect(page.getByText("No saved assessment yet.", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Assessment outcome unknown" })).toHaveCount(2);
  expect(posts).toBe(1);
});
