import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: exercise the actual selected-project owner with the original
// loopback denial held open while a fresh explicit retry succeeds.
for (const status of [200, 403, 404] as const) {
  test(status === 200 ? "selected project checks block scoped reads until success" : `selected project ${status} stays denied until explicit retry`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const projectId = "30000000-0000-4000-8000-000000000001";
    let armed = false, held: ServerResponse | undefined, heldClosed = false, arrived!: () => void, detailReads = 0, factReads = 0;
    const detailBearers: Array<string | undefined> = [], factBearers: Array<string | undefined> = [];
    const entered = new Promise<void>((resolve) => { arrived = resolve; });
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") return json(200, { token: "synthetic-token" });
      if (path === "/api/me") return json(200, { subject: "synthetic-actor", customerId: "10000000-0000-4000-8000-000000000001", roles: ["contributor"] });
      if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
      if (path === `/api/projects/${projectId}`) {
        detailReads++; detailBearers.push(req.headers.authorization);
        if (armed && !held) {
          held = res; res.on("close", () => { if (!res.writableFinished) heldClosed = true; });
          res.writeHead(status, { "Content-Type": "application/json", "x-synthetic-case": "project-denial" }); res.flushHeaders(); arrived(); return;
        }
        return json(200, { id: projectId, code: "S", name: held ? "Restored project" : "Original project", description: "Fixture", reportedStatus: "UNKNOWN" });
      }
      if (path === `/api/projects/${projectId}/facts`) { factReads++; factBearers.push(req.headers.authorization); return json(200, { canAppend: false, canConfigure: false, facts: [], next: null }); }
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
      await context.addInitScript((id) => {
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const state = window as unknown as { factDispatches?: number; oldAction?: HTMLButtonElement; live?: boolean; delta?: number; clicks?: number };
          if (new URL(url, location.href).pathname === `/api/projects/${id}/facts`) state.factDispatches = (state.factDispatches ?? 0) + 1;
          const response = await original(input, init);
          if (response.headers.get("x-synthetic-case") === "project-denial" && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              const before = state.factDispatches ?? 0;
              state.live = state.oldAction instanceof HTMLButtonElement && state.oldAction.isConnected && !state.oldAction.disabled;
              state.oldAction?.click(); state.delta = (state.factDispatches ?? 0) - before;
              (window as unknown as { projectReaderAcquired: boolean }).projectReaderAcquired = true;
              reader.read = async () => { const value = await read(); if (value.done) (window as unknown as { projectEof: boolean }).projectEof = true; return value; };
              reader.releaseLock = () => { release(); (window as unknown as { projectReleased: boolean }).projectReleased = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      }, projectId);
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await page.getByRole("button", { name: /Synthetic project/ }).click();
      await expect(page.getByRole("heading", { name: "Original project", level: 1 })).toBeVisible();
      const refresh = page.getByRole("button", { name: "Refresh evidence access" });
      await expect(refresh).toBeVisible(); await expect.poll(() => factReads).toBeGreaterThan(0);
      await expect(page.getByText("No fact types on this catalogue page.")).toBeVisible();
      const beforePositive = factReads;
      const positiveDelta = await page.evaluate(() => {
        const state = window as unknown as { factDispatches?: number };
        const button = [...document.querySelectorAll("button")].find((value) => value.textContent?.includes("Refresh evidence access"));
        if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error("Evidence action unavailable");
        const before = state.factDispatches ?? 0; button.click(); return (state.factDispatches ?? 0) - before;
      });
      expect(positiveDelta).toBe(1); await expect.poll(() => factReads).toBeGreaterThan(beforePositive);
      await page.evaluate(() => {
        const state = window as unknown as { oldAction: HTMLButtonElement; clicks: number };
        const button = [...document.querySelectorAll("button")].find((value) => value.textContent?.includes("Refresh evidence access"));
        if (!(button instanceof HTMLButtonElement)) throw new Error("Evidence action unavailable");
        state.oldAction = button; state.clicks = 0; button.addEventListener("click", () => { state.clicks++; });
      });
      armed = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([entered, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Project denial was not issued")), 15000); })]); }
      finally { if (timeout !== undefined) clearTimeout(timeout); }
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { projectReaderAcquired?: boolean }).projectReaderAcquired))).toBe(true);
      const action = await page.evaluate(() => { const s = window as unknown as { live: boolean; clicks: number; delta: number }; return { live: s.live, clicks: s.clicks, delta: s.delta }; });
      expect(action).toEqual({ live: true, clicks: 1, delta: 0 });
      expect(heldClosed).toBe(false); expect(await page.evaluate(() => Boolean((window as unknown as { projectEof?: boolean }).projectEof))).toBe(false);
      expect(detailBearers.every((value) => value === "Bearer synthetic-token")).toBe(true);
      expect(factBearers.every((value) => value === "Bearer synthetic-token")).toBe(true);
      if (status !== 200) {
        await expect(page.getByText("Project access could not be established.")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Original project", level: 1 })).toHaveCount(0);
        const readsAtDenial = detailReads;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(detailReads).toBe(readsAtDenial);
        await page.getByRole("button", { name: "Check project access" }).click();
        await expect(page.getByRole("heading", { name: "Restored project", level: 1 })).toBeVisible();
        expect(heldClosed).toBe(false);
      }
      held!.end(JSON.stringify(status === 200
        ? { id: projectId, code: "S", name: "Restored project", description: "Fixture", reportedStatus: "UNKNOWN" }
        : { message: "Synthetic project denial" }));
      await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { projectEof?: boolean; projectReleased?: boolean }).projectEof &&
        (window as unknown as { projectReleased?: boolean }).projectReleased))).toBe(true);
      await expect(page.getByRole("heading", { name: "Restored project", level: 1 })).toBeVisible();
      if (status === 200) await expect(page.getByText("No fact types on this catalogue page.")).toBeVisible({ timeout: 3000 });
      await expect(page.getByRole("button", { name: "Refresh evidence access" })).toBeVisible();
      const afterRetryDelta = await page.evaluate(() => {
        const state = window as unknown as { factDispatches?: number };
        const button = [...document.querySelectorAll("button")].find((value) => value.textContent?.includes("Refresh evidence access"));
        if (!(button instanceof HTMLButtonElement) || button.disabled) throw new Error("Evidence action unavailable after retry");
        const before = state.factDispatches ?? 0; button.click(); return (state.factDispatches ?? 0) - before;
      });
      expect(afterRetryDelta).toBe(1);
    } finally {
      try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}

for (const initial of ["503", "201", "204", "wrong-id"] as const) {
test(`an initial ${initial} project response exposes a working retry`, async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const projectId = "30000000-0000-4000-8000-000000000001"; let reads = 0, scopedReads = 0;
  const requestDetails: Array<{ method: string | undefined; bearer: string | undefined }> = [];
  const project = { id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Recovered project", description: "Fixture", reportedStatus: "UNKNOWN" };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "synthetic-token" });
    if (path === "/api/me") return json(200, { subject: "synthetic-actor", customerId: "10000000-0000-4000-8000-000000000001", roles: ["contributor"] });
    if (path === "/api/projects") return json(200, [project]);
    if (path === `/api/projects/${projectId}`) {
      reads++; requestDetails.push({ method: req.method, bearer: req.headers.authorization });
      if (reads !== 1) return json(200, project);
      if (initial === "503") return json(503, { message: "Synthetic failure" });
      if (initial === "201") return json(201, project);
      if (initial === "204") { res.writeHead(204); return res.end(); }
      return json(200, { ...project, id: "30000000-0000-4000-8000-000000000099" });
    }
    if (path.startsWith(`/api/projects/${projectId}/`)) scopedReads++;
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback unavailable");
    context = await browser.newContext(); const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await page.getByRole("button", { name: /Recovered project/ }).click();
    await expect(page.getByRole("button", { name: "Retry access checks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recovered project", level: 1 })).toHaveCount(0);
    expect(reads).toBe(1); expect(scopedReads).toBe(0);
    expect(requestDetails).toEqual([{ method: "GET", bearer: "Bearer synthetic-token" }]);
    await page.getByRole("button", { name: "Retry access checks" }).click();
    await expect(page.getByRole("heading", { name: "Recovered project", level: 1 })).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(2);
  } finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
});
}
