import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// Synthetic actual-App control for the two preview workers and their original
// response readers. This does not establish server authorization or recorder capture.
test("preview originals survive queue refresh and finish before a new batch", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const ids = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"], asOf = "2026-01-01T00:00:00.000Z";
  const oldTime = "2025-12-31T00:00:00.000Z", currentTime = "2026-02-01T00:00:00.000Z", nextTime = "2026-03-01T00:00:00.000Z";
  const requestPage = (projectId: string, createdAt: string) => ({ requests: [{ id: "40000000-0000-4000-8000-000000000001", projectId,
    milestoneId: "50000000-0000-4000-8000-000000000001", createdAt, state: "OPEN",
    assignment: { id: "60000000-0000-4000-8000-000000000001", revision: 1, occurredAt: createdAt, reason: "ASSIGNED", recipientSubject: "preview-actor" } }], next: null, live: true });
  const project = (projectId: string, name: string) => ({ projectId, name,
    schedule: { projectId, audience: "project_manager", coverage: "SCHEDULE_ONLY", sourceAuthority: "NOT_ASSESSED",
      approvalItems: "UNAVAILABLE", rankPolicyRevision: "advice-core@1", asOf, items: [] },
    update: { projectId, audience: "project_manager", availability: "UNCONFIGURED", approvalItems: "UNAVAILABLE", asOf },
    blockerAge: { projectId, audience: "project_manager", ruleRevision: "blocker-age@1", orderRevision: "blocker-review-order@1",
      timeZone: "UTC", asOf, coverage: "UNASSESSABLE", threshold: null, inventory: null, noOpenBlockers: null, items: [] } });
  const queue = { rankPolicyRevision: "pm-review-order@1", coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED",
    approvals: "UNAVAILABLE", blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" },
    projects: [project(ids[0]!, "First synthetic project"), project(ids[1]!, "Second synthetic project")], items: [] };
  let queueReads = 0, previewReads = 0, logins = 0, detailReads = 0, prematureClose = false;
  const held: ServerResponse[] = [], requests: Array<{ path: string; search: string; method: string | undefined; bearer: string | undefined }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid"), path = url.pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") { logins++; return json(200, { token: "preview-synthetic-token" }); }
    if (path === "/api/me") return json(200, { customerId: "10000000-0000-4000-8000-000000000001", subject: "preview-actor", roles: ["project_manager"] });
    if (path === "/api/projects") return json(200, []);
    if (ids.some((id) => path === `/api/projects/${id}`)) {
      detailReads++; return json(200, { id: path.split("/")[3], code: "S", name: "Preview project detail", description: "Synthetic", reportedStatus: "UNKNOWN" });
    }
    if (path === "/api/project-setup") return json(200, { truncated: false, portfolios: [] });
    if (path === "/api/pm/action-queue") {
      queueReads++;
      if (queueReads === 1) return json(200, queue);
      res.writeHead(200, { "Content-Type": "application/json", "x-queue-refresh": "fresh" });
      res.end(JSON.stringify({ ...queue, projects: [project(ids[0]!, "Renewed first project"), project(ids[1]!, "Renewed second project")] })); return;
    }
    if (ids.some((id) => path === `/api/projects/${id}/reconciliation-requests` || path === `/api/projects/${id}/scalar-reconciliation-requests`)) {
      previewReads++; requests.push({ path, search: url.search, method: req.method, bearer: req.headers.authorization });
      if (previewReads <= 2) {
        held.push(res); res.on("close", () => { if (!res.writableFinished) prematureClose = true; });
        res.writeHead(200, { "Content-Type": "application/json", "x-preview-original": String(previewReads) }); res.flushHeaders(); return;
      }
      if (path === `/api/projects/${ids[0]}/reconciliation-requests`) {
        if (url.searchParams.has("afterId")) return json(200, requestPage(ids[0]!, nextTime));
        const template = requestPage(ids[0]!, currentTime).requests[0]!;
        const rows = Array.from({ length: 20 }, (_, index) => ({ ...template,
          id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          createdAt: `2026-02-01T00:00:${String(index).padStart(2, "0")}.000Z` }));
        const last = rows.at(-1)!; return json(200, { requests: rows, next: { id: last.id, createdAt: last.createdAt }, live: true });
      }
      return json(200, { requests: [], next: null, live: true });
    }
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback unavailable");
    context = await browser.newContext();
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const state = window as unknown as { acquired?: string[]; eof?: string[]; released?: string[]; queueEof?: boolean; queueReleased?: boolean; dispatch?: Array<{ signal: boolean; redirect?: RequestRedirect; afterBoth: boolean }> };
        if (/^\/api\/projects\/[^/]+\/(scalar-)?reconciliation-requests$/.test(path)) {
          (state.dispatch ??= []).push({ signal: Boolean(init?.signal), redirect: init?.redirect,
            afterBoth: Boolean(state.released?.includes("1") && state.released.includes("2")) });
        }
        const response = await original(input, init), marker = response.headers.get("x-preview-original");
        if (response.headers.get("x-queue-refresh") === "fresh" && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = async () => { const result = await read(); if (result.done) state.queueEof = true; return result; };
            reader.releaseLock = () => { release(); state.queueReleased = true; };
            return reader;
          }) as typeof stream.getReader;
        }
        if (marker && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            (state.acquired ??= []).push(marker);
            reader.read = async () => { const result = await read(); if (result.done) (state.eof ??= []).push(marker); return result; };
            reader.releaseLock = () => { release(); (state.released ??= []).push(marker); };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    const panel = page.getByRole("region", { name: "Action suggestions" });
    await expect(panel.getByRole("heading", { name: "First synthetic project" })).toBeVisible();
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect.poll(() => previewReads).toBe(2);
    await expect.poll(() => page.evaluate(() => [...((window as unknown as { acquired?: string[] }).acquired ?? [])].sort())).toEqual(["1", "2"]);
    await panel.getByRole("button", { name: "Refresh suggestions" }).click();
    await expect.poll(() => queueReads).toBe(2);
    await expect(panel.getByRole("heading", { name: "Renewed first project" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => { const state = window as unknown as { queueEof?: boolean; queueReleased?: boolean }; return Boolean(state.queueEof && state.queueReleased); })).toBe(true);
    const calibrated = await page.evaluate(async (oldCreatedAt) => {
      const state = window as unknown as { sawOld: boolean; previewObserver: MutationObserver };
      const selector = `button[aria-label="Open milestone request recorded ${oldCreatedAt}"]`;
      state.sawOld = false;
      state.previewObserver = new MutationObserver((records) => {
        if (records.some((record) => (record.type === "attributes" && (record.oldValue?.includes(oldCreatedAt) ||
          (record.target instanceof Element && record.target.matches(selector)))) || (record.type === "characterData" &&
          (record.oldValue?.includes(oldCreatedAt) || record.target.textContent?.includes(oldCreatedAt))) ||
          [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes(oldCreatedAt) ||
            (node instanceof Element && (node.matches(selector) || Boolean(node.querySelector(selector))))))) state.sawOld = true;
      });
      state.previewObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
      const marker = document.createElement("button"); marker.textContent = oldCreatedAt;
      marker.setAttribute("aria-label", `Open milestone request recorded ${oldCreatedAt}`);
      document.body.append(marker); await Promise.resolve(); const insertionSeen = state.sawOld;
      marker.remove(); await Promise.resolve(); state.sawOld = false;
      const attribute = document.createElement("button"), text = document.createTextNode("baseline");
      document.body.append(attribute, text); await Promise.resolve();
      attribute.setAttribute("aria-label", `Open milestone request recorded ${oldCreatedAt}`); attribute.removeAttribute("aria-label");
      await Promise.resolve(); const attributeSeen = state.sawOld; state.sawOld = false;
      text.data = oldCreatedAt; text.data = "baseline"; await Promise.resolve(); const textSeen = state.sawOld;
      attribute.remove(); text.remove(); await Promise.resolve(); state.sawOld = false; return insertionSeen && attributeSeen && textSeen;
    }, oldTime);
    expect(calibrated).toBe(true);
    expect(previewReads).toBe(2); expect(prematureClose).toBe(false);
    held[0]!.end(JSON.stringify(requestPage(requests[0]!.path.split("/")[3]!, oldTime)));
    await expect.poll(() => page.evaluate(() => [...((window as unknown as { released?: string[] }).released ?? [])].sort())).toEqual(["1"]);
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect(panel.getByText("Previews are unavailable. Retry after the previous reads have finished.")).toBeVisible();
    expect(previewReads).toBe(2); expect(prematureClose).toBe(false);
    held[1]!.end(JSON.stringify(requestPage(requests[1]!.path.split("/")[3]!, oldTime)));
    await expect.poll(() => page.evaluate(() => {
      const state = window as unknown as { eof?: string[]; released?: string[] };
      return { eof: [...(state.eof ?? [])].sort(), released: [...(state.released ?? [])].sort() };
    })).toEqual({ eof: ["1", "2"], released: ["1", "2"] });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await panel.getByRole("button", { name: "Load reconciliation previews" }).click();
    await expect.poll(() => previewReads).toBe(6);
    await expect(panel.getByText("No recorded open requests on this page.")).toHaveCount(3);
    await expect(panel.getByRole("button", { name: `Open milestone request recorded ${currentTime}` })).toBeEnabled();
    expect(logins).toBe(1); expect(prematureClose).toBe(false);
    expect(requests.every((item) => item.method === "GET" && item.bearer === "Bearer preview-synthetic-token")).toBe(true);
    expect(new Set(requests.slice(0, 2).map((item) => item.path))).toEqual(new Set(ids.map((id) => `/api/projects/${id}/reconciliation-requests`)));
    expect(new Set(requests.slice(2).map((item) => item.path))).toEqual(new Set(ids.flatMap((id) =>
      [`/api/projects/${id}/reconciliation-requests`, `/api/projects/${id}/scalar-reconciliation-requests`])));
    expect(await page.evaluate(() => { const state = window as unknown as { sawOld: boolean; previewObserver: MutationObserver }; state.previewObserver.disconnect(); return state.sawOld; })).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { dispatch: Array<{ signal: boolean; redirect?: RequestRedirect; afterBoth: boolean }> }).dispatch)).toEqual([
      { signal: false, redirect: "error", afterBoth: false }, { signal: false, redirect: "error", afterBoth: false },
      ...Array.from({ length: 4 }, () => ({ signal: false, redirect: "error", afterBoth: true })),
    ]);
    await panel.getByRole("button", { name: "Next page", exact: true }).click();
    await expect.poll(() => previewReads).toBe(7);
    const pageQuery = new URLSearchParams(requests[6]!.search);
    expect(requests[6]).toMatchObject({ path: `/api/projects/${ids[0]}/reconciliation-requests`, method: "GET", bearer: "Bearer preview-synthetic-token" });
    expect([...pageQuery.entries()]).toEqual([["limit", "20"], ["afterCreatedAt", "2026-02-01T00:00:19.000Z"], ["afterId", "40000000-0000-4000-8000-000000000020"]]);
    const currentAction = panel.getByRole("button", { name: `Open milestone request recorded ${nextTime}` });
    await expect(currentAction).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { dispatch: Array<{ signal: boolean; redirect?: RequestRedirect; afterBoth: boolean }> }).dispatch.at(-1))).toEqual({ signal: false, redirect: "error", afterBoth: true });
    await currentAction.click();
    await expect(page.getByRole("heading", { name: "Preview project detail", level: 1 })).toBeVisible();
    expect(detailReads).toBeGreaterThanOrEqual(1);
    expect(new URL(page.url()).searchParams.get("project")).toBe(ids[0]);
    expect(new URL(page.url()).searchParams.get("reconciliation")).toBe("40000000-0000-4000-8000-000000000001");
  } finally {
    try { for (const response of held) if (!response.writableEnded && !response.destroyed) response.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
});
