import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: exercise the product App and the original loopback response.
// All identities and tokens here are synthetic and stay on localhost.
async function heldResponse(browser: Browser, replaceSession: boolean, oldStatus: 200 | 401 | 403 | 404) {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname))
    throw new Error("Synthetic application upstream must be local HTTP");
  let held: ServerResponse | undefined, reads = 0, logins = 0, identities = 0, arrived!: () => void, heldClosed = false;
  const projectAuthorization: Array<string | undefined> = [];
  const replacementAuthorization: Array<string | undefined> = [];
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") { logins++; return json(200, { token: "same-synthetic-token" }); }
    if (path === "/api/me") { identities++; return json(200, { subject: "synthetic-pm", customerId: "10000000-0000-4000-8000-000000000001", roles: ["project_manager"] }); }
    if (path === "/api/projects") {
      reads++; projectAuthorization.push(req.headers.authorization);
      if (reads === 1) {
        held = res; res.on("close", () => { if (!res.writableFinished) heldClosed = true; });
        arrived(); return;
      }
      if (logins >= 2) {
        replacementAuthorization.push(req.headers.authorization);
        return json(200, [{ id: "30000000-0000-4000-8000-000000000001", portfolioId: "30000000-0000-4000-8000-000000000050", code: "NEW", name: "Synthetic replacement project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
      }
      return json(200, []);
    }
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    context = await browser.newContext();
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const state = window as unknown as { requestedPaths?: string[] };
        (state.requestedPaths ??= []).push(new URL(url, location.href).pathname);
        const response = await original(input, init);
        if (response.headers.get("x-synthetic-case") === "old-response") {
          const consume = response.arrayBuffer.bind(response);
          response.arrayBuffer = async () => {
            const bytes = await consume();
            (window as unknown as { originalResponseConsumed: boolean }).originalResponseConsumed = true;
            return bytes;
          };
          if (response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
              reader.read = async () => { const value = await read(); if (value.done) eof = true; return value; };
              reader.releaseLock = () => { release(); if (eof) (window as unknown as { originalResponseConsumed: boolean }).originalResponseConsumed = true; };
              return reader;
            }) as typeof stream.getReader;
          }
        }
        return response;
      };
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const signIn = () => page.getByRole("button", { name: /^Project manager / }).first().click();
    await signIn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Held request did not start")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect.poll(() => identities).toBeGreaterThanOrEqual(1);
    expect(projectAuthorization[0]).toBe("Bearer same-synthetic-token");
    if (replaceSession) {
      const identitiesBeforeReplacement = identities;
      const requestsBeforeReplacement = await page.evaluate(() => ((window as unknown as { requestedPaths?: string[] }).requestedPaths ?? [])
        .filter((path) => path === "/api/projects").length);
      await page.getByRole("button", { name: "Sign out" }).click();
      await signIn();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect.poll(() => logins).toBe(2);
      await expect.poll(() => identities).toBeGreaterThan(identitiesBeforeReplacement);
      await expect.poll(() => page.evaluate(() => ((window as unknown as { requestedPaths?: string[] }).requestedPaths ?? [])
        .filter((path) => path === "/api/projects").length)).toBeGreaterThan(requestsBeforeReplacement);
      await expect.poll(() => replacementAuthorization.length).toBeGreaterThanOrEqual(1);
      expect(replacementAuthorization[0]).toBe("Bearer same-synthetic-token");
      await expect(page.getByRole("button", { name: /Synthetic replacement project/ })).toBeVisible();
      const calibrated = await page.evaluate(async () => {
        const state = window as unknown as { sawLogin: boolean; sawOldProject: boolean; observer: MutationObserver };
        state.sawLogin = false; state.sawOldProject = false;
        state.observer = new MutationObserver((records) => {
          const nodes = records.flatMap((record) => [...record.addedNodes, ...record.removedNodes]);
          if (nodes.some((node) => node instanceof Element && (node.matches(".login") || Boolean(node.querySelector(".login"))))) state.sawLogin = true;
          if (nodes.some((node) => node.textContent?.includes("Old synthetic project")) || records.some((record) =>
            record.type === "characterData" && (record.oldValue?.includes("Old synthetic project") || record.target.textContent?.includes("Old synthetic project")))) state.sawOldProject = true;
        });
        state.observer.observe(document.body, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
        const marker = document.createElement("div"); marker.className = "login"; marker.textContent = "Old synthetic project";
        document.body.append(marker); marker.remove();
        await Promise.resolve(); const insertionObserved = state.sawLogin && state.sawOldProject;
        state.sawOldProject = false;
        const textMarker = document.createTextNode("baseline"); document.body.append(textMarker); await Promise.resolve();
        textMarker.data = "Old synthetic project"; textMarker.data = "baseline"; await Promise.resolve();
        const textObserved = state.sawOldProject; textMarker.remove(); await Promise.resolve();
        state.sawLogin = false; state.sawOldProject = false; return insertionObserved && textObserved;
      });
      expect(calibrated).toBe(true);
    }
    expect(heldClosed).toBe(false);
    held!.writeHead(oldStatus, { "Content-Type": "application/json", "x-synthetic-case": "old-response" });
    held!.end(JSON.stringify(oldStatus === 200
      ? [{ id: "30000000-0000-4000-8000-000000000002", portfolioId: "30000000-0000-4000-8000-000000000050", code: "OLD", name: "Old synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]
      : { message: "Synthetic unavailable session" }));
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { originalResponseConsumed?: boolean }).originalResponseConsumed))).toBe(true);
    if (replaceSession) {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      await expect(page.getByRole("button", { name: /Synthetic replacement project/ })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { sawLogin: boolean }).sawLogin)).toBe(false);
      expect(await page.evaluate(() => (window as unknown as { sawOldProject: boolean }).sawOldProject)).toBe(false);
    } else {
      await expect(page.getByText("Your session has ended. Please sign in again.")).toBeVisible();
    }
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally {
      try { await context?.close(); }
      finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    }
  }
}

test("an old 401 cannot expire a replacement session with the same token", async ({ browser }) => {
  await heldResponse(browser, true, 401);
});

test("a current session 401 still expires the session", async ({ browser }) => {
  await heldResponse(browser, false, 401);
});

for (const status of [200, 403, 404] as const) {
  test(`an old ${status} cannot replace the new session's project list`, async ({ browser }) => {
    await heldResponse(browser, true, status);
  });
}
