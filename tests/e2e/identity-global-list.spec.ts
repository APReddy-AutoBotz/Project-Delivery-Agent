import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: list and setup observations belong to a verified identity
// issuance. All data, credentials and response markers here are synthetic.
for (const first of ["projects", "setup"] as const) {
test(`identity refresh fences old actions with ${first} read finishing first`, async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001";
  const portfolioId = "30000000-0000-4000-8000-000000000050";
  const project = (name: string) => ({ id: projectId, portfolioId, code: "S", name, description: "Synthetic", reportedStatus: "UNKNOWN" });
  const setup = (name: string) => ({ truncated: false, portfolios: [{ id: portfolioId, name, programmes: [], programmesTruncated: false }] });
  let phase = 0, logins = 0, detailReads = 0, unexpectedPosts = 0, identityBearer: string | undefined;
  let identityHeld: ServerResponse | undefined, projectsHeld: ServerResponse | undefined, setupHeld: ServerResponse | undefined;
  let meArrived!: () => void, projectsArrived!: () => void, setupArrived!: () => void;
  const enteredMe = new Promise<void>((resolve) => { meArrived = resolve; });
  const enteredProjects = new Promise<void>((resolve) => { projectsArrived = resolve; });
  const enteredSetup = new Promise<void>((resolve) => { setupArrived = resolve; });
  const freshRequests: Array<{ path: string; method: string | undefined; bearer: string | undefined; identityEof: string | undefined }> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
    if (path === "/api/me") {
      if (phase === 1) {
        if (identityHeld) return json(500, { message: "Unexpected identity duplicate" });
        identityBearer = req.headers.authorization; identityHeld = res; res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "held-identity" }); res.flushHeaders(); meArrived(); return;
      }
      return json(200, { customerId, subject: phase === 0 ? "actor-a" : "actor-b", roles: ["pmo_admin"] });
    }
    if (path === "/api/projects" && req.method === "POST") { unexpectedPosts++; return json(500, { message: "Unexpected write" }); }
    if (path === "/api/projects" || path === "/api/project-setup") {
      if (phase === 2) {
        freshRequests.push({ path, method: req.method, bearer: req.headers.authorization, identityEof: req.headers["x-synthetic-identity-eof"] as string | undefined });
        if (path === "/api/projects") { if (projectsHeld) return json(500, { message: "Unexpected projects duplicate" }); projectsHeld = res; projectsArrived(); }
        else { if (setupHeld) return json(500, { message: "Unexpected setup duplicate" }); setupHeld = res; setupArrived(); }
        return;
      }
      return json(200, path === "/api/projects" ? [project("Actor A project")] : setup("Actor A portfolio"));
    }
    if (path === `/api/projects/${projectId}`) { detailReads++; return json(200, project(phase === 2 ? "Actor B detail" : "Actor A detail")); }
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
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const state = window as unknown as { identityDone?: boolean; oldCard?: HTMLButtonElement; oldCreate?: HTMLButtonElement;
          cardLive?: boolean; createLive?: boolean; cardClicks?: number; createClicks?: number; navigationWrites?: number;
          identityEof?: boolean; identityReleased?: boolean; freshProjectsConsumed?: boolean; freshSetupConsumed?: boolean; armed?: boolean };
        if (state.armed && new URL(url, location.href).pathname === "/api/me") {
          state.armed = false;
          state.cardLive = Boolean(state.oldCard?.isConnected && !state.oldCard.disabled);
          state.createLive = Boolean(state.oldCreate?.isConnected && !state.oldCreate.disabled);
          state.oldCard?.click(); state.oldCreate?.click();
        }
        const headers = new Headers(init?.headers); headers.set("x-synthetic-identity-eof", String(Boolean(state.identityDone)));
        const response = await original(input, { ...init, headers });
        const marker = response.headers.get("x-synthetic-case");
        if (marker === "held-identity" && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = async () => { const value = await read(); if (value.done) state.identityEof = true; return value; };
            reader.releaseLock = () => { release(); state.identityReleased = true; if (state.identityEof) state.identityDone = true; };
            return reader;
          }) as typeof stream.getReader;
        }
        if ((marker === "fresh-projects" || marker === "fresh-setup") && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
            reader.read = async () => { const value = await read(); if (value.done) eof = true; return value; };
            reader.releaseLock = () => { release(); if (eof) { if (marker === "fresh-projects") state.freshProjectsConsumed = true; else state.freshSetupConsumed = true; } };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await expect(page.getByText("actor-a", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Actor A project/ }).click();
    await expect(page.getByRole("heading", { name: "Actor A detail", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: /All projects/ }).click();
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByLabel("Project name", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: /Actor A project/ })).toBeVisible();
    const initialDetails = detailReads;
    await page.evaluate(() => {
      const state = window as unknown as { oldCard: HTMLButtonElement; oldCreate: HTMLButtonElement; cardClicks: number; createClicks: number; navigationWrites: number };
      const card = document.querySelector("button.project-card"), create = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Create project");
      if (!(card instanceof HTMLButtonElement) || !(create instanceof HTMLButtonElement)) throw new Error("Synthetic actions unavailable");
      state.oldCard = card; state.oldCreate = create; state.cardClicks = 0; state.createClicks = 0; state.navigationWrites = 0;
      card.addEventListener("click", () => { state.cardClicks++; }); create.addEventListener("click", () => { state.createClicks++; });
      const replace = history.replaceState.bind(history); history.replaceState = (...args) => { state.navigationWrites++; return replace(...args); };
    });
    phase = 1; await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; window.dispatchEvent(new Event("focus")); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([enteredMe, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Held identity did not start")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await expect.poll(() => page.evaluate(() => {
      const s = window as unknown as { cardLive?: boolean; createLive?: boolean; cardClicks?: number; createClicks?: number; navigationWrites?: number };
      return { cardLive: s.cardLive, createLive: s.createLive, cardClicks: s.cardClicks, createClicks: s.createClicks, navigationWrites: s.navigationWrites };
    })).toEqual({ cardLive: true, createLive: true, cardClicks: 1, createClicks: 1, navigationWrites: 0 });
    await expect(page.getByRole("button", { name: /Actor A project/ })).toHaveCount(0);
    await expect(page.getByLabel("Project name", { exact: true })).toHaveCount(0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(detailReads).toBe(initialDetails); expect(unexpectedPosts).toBe(0); expect(identityBearer).toBe("Bearer synthetic-token");
    const calibrated = await page.evaluate(async () => {
      const state = window as unknown as { oldVisible: boolean; listObserver: MutationObserver };
      state.oldVisible = false;
      state.listObserver = new MutationObserver(() => {
        if ([...document.querySelectorAll("button")].some((button) => button.getClientRects().length > 0 && button.textContent?.includes("Actor A project"))) state.oldVisible = true;
      });
      state.listObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      const marker = document.createElement("button"); marker.textContent = "Actor A project"; document.body.append(marker);
      await Promise.resolve(); const detected = state.oldVisible; marker.remove(); await Promise.resolve(); state.oldVisible = false; return detected;
    });
    expect(calibrated).toBe(true);
    phase = 2; identityHeld!.end(JSON.stringify({ customerId, subject: "actor-b", roles: ["pmo_admin"] }));
    let freshTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([enteredProjects, enteredSetup]), new Promise<never>((_resolve, reject) => { freshTimer = setTimeout(() => reject(new Error("Fresh list and setup did not start")), 15000); })]); }
    finally { if (freshTimer !== undefined) clearTimeout(freshTimer); }
    await expect(page.getByText("actor-b", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Actor A project/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create project", exact: true })).toHaveCount(0);
    expect(freshRequests).toHaveLength(2);
    expect(freshRequests.every((item) => item.method === "GET" && item.bearer === "Bearer synthetic-token" && item.identityEof === "true")).toBe(true);
    const releaseProjects = () => { projectsHeld!.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "fresh-projects" }); projectsHeld!.end(JSON.stringify([project("Actor B project")])); };
    const releaseSetup = () => { setupHeld!.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "fresh-setup" }); setupHeld!.end(JSON.stringify(setup("Actor B portfolio"))); };
    if (first === "projects") {
      releaseProjects(); await expect(page.getByRole("button", { name: /Actor B project/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create project", exact: true })).toHaveCount(0); releaseSetup();
    } else {
      releaseSetup(); await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Actor B project/ })).toHaveCount(0); releaseProjects();
    }
    await expect.poll(() => page.evaluate(() => {
      const s = window as unknown as { identityEof?: boolean; identityReleased?: boolean; freshProjectsConsumed?: boolean; freshSetupConsumed?: boolean };
      return Boolean(s.identityEof && s.identityReleased && s.freshProjectsConsumed && s.freshSetupConsumed);
    })).toBe(true);
    await expect(page.getByRole("button", { name: /Actor B project/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { oldVisible: boolean }).oldVisible)).toBe(false);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("option", { name: "Actor B portfolio", exact: true })).toHaveCount(1);
    await expect(page.getByRole("option", { name: "Actor A portfolio", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: /Actor B project/ }).click();
    await expect(page.getByRole("heading", { name: "Actor B detail", level: 1 })).toBeVisible();
    expect(logins).toBe(1);
  } finally {
    try { for (const held of [identityHeld, projectsHeld, setupHeld]) if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
});
}
