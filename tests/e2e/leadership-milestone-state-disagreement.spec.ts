import { expect, test } from "@playwright/test";
const customerId = "10000000-0000-4000-8000-000000000001";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = { id: id(1), code: "CX", name: "Synthetic state project", description: "Fixture", reportedStatus: "UNKNOWN" };
const dates = { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null };
const milestones = [{ id: id(2), key: "MS-1", name: "First milestone", state: "COMPLETE", dates },
  { id: id(3), key: "MS-2", name: "Second milestone", state: "OPEN", dates }];
const detail = { ...project, configured: true, portfolio: { id: id(50), name: "Synthetic portfolio" }, programme: null,
  creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 }, dates,
  responsibilities: [], sprints: [], milestones, workItems: [], requiredWorkItems: [], raidItems: [],
  sourceMappings: [], sourceMappingsWithheld: true };
const disagreement = (milestoneId: string, n: number, ttl = 60000) => {
  const now = Date.now(), asOf = new Date(now).toISOString(), validUntil = new Date(now + ttl).toISOString();
  const support = (index: number) => ({ versionId: id(index), evidenceId: id(index + 10), sourceId: id(index + 20), provenance: "HUMAN_CONFIRMED",
    effectiveAt: new Date(now - 10000).toISOString(), observedAt: new Date(now - 10000).toISOString(),
    versionValidUntil: validUntil, assessedValidUntil: validUntil });
  return { projectId: project.id, milestoneId, bindingId: id(n + 1), factId: id(n + 2),
    factType: `canonical.state.${String(n).padStart(32, "0")}`, asOf, policyRevisionId: id(n + 3),
    positions: [{ state: "COMPLETE", supports: [support(n + 10)] }, { state: "OPEN", supports: [support(n + 11)] }] };
};

test("state evidence is scoped to the selected milestone and clears on denial and sign-out", async ({ page }) => {
  test.setTimeout(90000);
  let persona = "", denied = false, oversized = false, expiresSoon = false, reads = 0;
  const createGate = (tag: string) => {
    let arrived!: () => void, release!: () => void, settled!: () => void;
    return { tag, entered: new Promise<void>((resolve) => { arrived = resolve; }),
      gate: new Promise<void>((resolve) => { release = resolve; }), finished: new Promise<void>((resolve) => { settled = resolve; }),
      arrived: () => arrived(), release: () => release(), settled: () => settled() };
  };
  let held: ReturnType<typeof createGate> | undefined;
  const selectionGate = createGate("selection"), sessionGate = createGate("session");
  const requests: { method: string; url: string; body: string | null }[] = [];
  await page.addInitScript(({ firstEvidence, secondEvidence }) => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("leadership-state-disagreement") && init) {
        const { signal: _signal, ...rest } = init;
        return original(input, rest).then((response) => {
          const tag = response.headers.get("x-synthetic-held");
          if (tag && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
              const chunks: Uint8Array[] = []; let total = 0;
              reader.read = async () => {
                const value = await read();
                if (!value.done) { total += value.value.byteLength; if (tag !== "oversized" && total <= 262144) chunks.push(value.value); }
                if (value.done) {
                  const bytes = new Uint8Array(total); let offset = 0;
                  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                  const payload = JSON.parse(new TextDecoder().decode(bytes)) as { positions?: { supports?: { evidenceId?: string }[] }[] };
                  const expected = tag === "selection" ? firstEvidence : secondEvidence;
                  if (payload.positions?.some((position) => position.supports?.some((item) => item.evidenceId === expected))) {
                    const observed = window as unknown as { consumedStateResponses?: string[] };
                    observed.consumedStateResponses = [...(observed.consumedStateResponses ?? []), tag];
                  }
                }
                return value;
              };
              reader.cancel = async (reason) => {
                const observed = window as unknown as { cancelledStateResponses?: { tag: string; bytes: number }[] };
                observed.cancelledStateResponses = [...(observed.cancelledStateResponses ?? []), { tag, bytes: total }];
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
  }, { firstEvidence: id(120), secondEvidence: id(220) });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: `synthetic-${persona}` } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: persona === "leader-atlas" ? ["leadership"] : ["project_manager"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/canonical`) return route.fulfill({ json: detail });
    if (path.endsWith("/leadership-state-disagreement")) {
      reads++; requests.push({ method: route.request().method(), url: route.request().url(), body: route.request().postData() });
      if (denied) return route.fulfill({ status: 503, json: { message: "Unavailable" } });
      if (oversized) return route.fulfill({ status: 200, contentType: "application/json", headers: { "x-synthetic-held": "oversized" },
        body: JSON.stringify(disagreement(id(2), 100)) + " ".repeat(262145) });
      if (held) {
        const active = held; held = undefined; active.arrived(); await active.gate;
        try { await route.fulfill({ json: path.includes(id(2)) ? disagreement(id(2), 100) : disagreement(id(3), 200),
          headers: { "x-synthetic-held": active.tag } }); } finally { active.settled(); }
        return;
      }
      const ttl = expiresSoon ? 3000 : 60000;
      if (expiresSoon) { expiresSoon = false; denied = true; }
      return route.fulfill({ json: path.includes(id(2)) ? disagreement(id(2), 100, ttl) : disagreement(id(3), 200, ttl) });
    }
    if (path === "/pm/action-queue") return route.fulfill({ json: { projects: [] } });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  let selectionStarted = false, sessionStarted = false;
  const watch = async (tag: string, marker: string) => page.evaluate(({ tag, marker }) => {
    const state = window as unknown as { staleStateSeen?: Record<string, boolean> };
    state.staleStateSeen ??= {}; state.staleStateSeen[tag] = false;
    const check = () => { if (document.body.textContent?.includes(marker)) state.staleStateSeen![tag] = true; };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue?.includes(marker) || [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(marker)))
          state.staleStateSeen![tag] = true;
      }
      check();
    }).observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    check();
  }, { tag, marker });
  const consumed = async (tag: string) => {
    await expect.poll(() => page.evaluate((name) => (window as unknown as { consumedStateResponses?: string[] }).consumedStateResponses?.includes(name) ?? false, tag)).toBe(true);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate((name) => (window as unknown as { staleStateSeen?: Record<string, boolean> }).staleStateSeen?.[name], tag)).toBe(false);
  };
  try {
    await page.goto("/"); await page.getByRole("button", { name: /^Leadership / }).click();
    await page.getByRole("button", { name: /Synthetic state project/ }).click();
    await watch("observer-canary", "synthetic-transient-marker");
    await page.evaluate(() => { const node = document.createElement("span"); node.textContent = "synthetic-transient-marker"; document.body.append(node); node.remove(); });
    await expect.poll(() => page.evaluate(() => (window as unknown as { staleStateSeen?: Record<string, boolean> }).staleStateSeen?.["observer-canary"])).toBe(true);
    const select = page.getByLabel("Milestone", { exact: true });
    await select.selectOption(id(2)); expect(reads).toBe(0);
    await page.getByRole("button", { name: "Check for conflicting milestone states" }).click();
    await expect(page.getByText("No state has been selected as the winner.", { exact: false })).toBeVisible();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
    denied = true;
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
    await expect(page.getByText("Current conflicting state evidence could not be established", { exact: false })).toBeVisible();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    denied = false;
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
    oversized = true;
    const beforeOversized = reads;
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
    await expect.poll(() => reads).toBe(beforeOversized + 1);
    await expect.poll(() => page.evaluate(() => (window as unknown as { cancelledStateResponses?: { tag: string; bytes: number }[] })
      .cancelledStateResponses?.some((item) => item.tag === "oversized" && item.bytes > 262144) ?? false)).toBe(true);
    await expect(page.getByText("Current conflicting state evidence could not be established", { exact: false })).toBeVisible();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    oversized = false;
    denied = false; expiresSoon = true;
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click();
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toBeVisible();
    await expect(page.getByText("Current conflicting state evidence could not be established", { exact: false })).toBeVisible({ timeout: 12000 });
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    denied = false; held = selectionGate;
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click(); await selectionGate.entered; selectionStarted = true;
    await select.selectOption(id(3));
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    await watch("selection", `Evidence ${id(120)}`);
    await page.getByRole("button", { name: "Check for conflicting milestone states" }).click();
    await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toBeVisible();
    selectionGate.release(); await selectionGate.finished; await consumed("selection");
    await expect(page.getByText(`Evidence ${id(120)}`, { exact: false })).toHaveCount(0);
    held = sessionGate;
    await page.getByRole("button", { name: "Refresh milestone state evidence" }).click(); await sessionGate.entered; sessionStarted = true;
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText(`Evidence ${id(220)}`, { exact: false })).toHaveCount(0);
    await watch("session", `Evidence ${id(220)}`);
    sessionGate.release(); await sessionGate.finished; await consumed("session");
    expect(requests.every((item) => item.method === "GET" && item.body === null && new URL(item.url).search === "")).toBe(true);
  } finally {
    selectionGate.release(); sessionGate.release();
    const pending = [selectionStarted ? selectionGate.finished : Promise.resolve(), sessionStarted ? sessionGate.finished : Promise.resolve()];
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
});
