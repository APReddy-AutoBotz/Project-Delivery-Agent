import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

for (const scenario of ["stale", "confirmed", "confirmed-jump", "malformed"] as const) {
test(`FR-EVD-009: held source-access write ${scenario} outcome`, async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const projectId = "30000000-0000-4000-8000-000000000001", sourceId = "a0000000-0000-4000-8000-000000000001";
  const nextRevision = scenario === "confirmed-jump" ? 7 : 2;
  const confirmed = scenario === "confirmed" || scenario === "confirmed-jump";
  let held: ServerResponse | undefined, closed = false, postCount = 0, accessReads = 0, arrived!: () => void;
  const postBodies: unknown[] = [], postBearers: Array<string | undefined> = [];
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "synthetic-token" });
    if (path === "/api/me") return json(200, { subject: "synthetic-actor", customerId: "10000000-0000-4000-8000-000000000001", roles: ["pmo_admin"] });
    if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
    if (path === `/api/projects/${projectId}`) return json(200, { id: projectId, code: "S", name: "Current project", description: "Fixture", reportedStatus: "UNKNOWN" });
    if (path === `/api/projects/${projectId}/facts`) return json(200, { canAppend: true, canConfigure: true,
      facts: [{ factId: "40000000-0000-4000-8000-000000000001", factType: "source.fact", revision: 1 }], next: null });
    if (path === `/api/projects/${projectId}/facts/source.fact/history`) return json(200, { factId: "40000000-0000-4000-8000-000000000001", throughRevision: 1, next: null,
      entries: [{ id: "50000000-0000-4000-8000-000000000001", revision: 1, sourceId, evidenceId: "60000000-0000-4000-8000-000000000001", sourceAccessRevision: 1, visibility: "restricted" }] });
    if (path === `/api/projects/${projectId}/facts/source.fact/authority`) return json(200, { throughRevision: null, event: null });
    if (path === `/api/projects/${projectId}/fact-sources/${sourceId}/access`) {
      if (req.method === "POST") {
        postCount++; postBearers.push(req.headers.authorization); let body = ""; req.setEncoding("utf8");
        req.on("data", (chunk: string) => { body += chunk; });
        req.on("end", () => { postBodies.push(JSON.parse(body)); held = res;
          res.on("close", () => { if (!res.writableFinished) closed = true; }); arrived(); }); return;
      }
      accessReads++; return json(200, { sourceId, revision: postCount ? nextRevision : 1, state: "AVAILABLE", readers: [postCount ? "new-reader" : "old-reader"] });
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
    await context.addInitScript(({ project, source }) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url, location.href).pathname === `/api/projects/${project}/fact-sources/${source}/access` && init?.method === "POST") {
          const state = window as unknown as { sourcePosts?: number }; state.sourcePosts = (state.sourcePosts ?? 0) + 1;
        }
        const response = await original(input, init);
        if (response.headers.get("x-synthetic-case") === "source-post" && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = async () => { const value = await read(); if (value.done) (window as unknown as { sourceEof: boolean }).sourceEof = true; return value; };
            reader.releaseLock = () => { release(); (window as unknown as { sourceReleased: boolean }).sourceReleased = true; };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    }, { project: projectId, source: sourceId });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await page.getByRole("button", { name: /Synthetic project/ }).click();
    await page.getByRole("button", { name: /source\.fact/ }).click();
    await page.getByRole("button", { name: "Manage source readers" }).click();
    await expect(page.getByLabel("Reader account subjects")).toHaveValue("old-reader");
    await page.getByLabel("Reader account subjects").fill("new-reader");
    await page.getByRole("button", { name: "Review source access" }).click();
    await page.getByRole("button", { name: "Save source access" }).click();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Source write did not start")), 15000); })]); }
    finally { if (timeout !== undefined) clearTimeout(timeout); }
    expect(postBearers[0]).toBe("Bearer synthetic-token");
    expect(postBodies[0]).toEqual({ projectId, sourceId, expectedRevision: 1, state: "AVAILABLE", readers: ["new-reader"] });
    expect(await page.evaluate(() => (window as unknown as { sourcePosts?: number }).sourcePosts)).toBe(1);
    if (scenario === "stale") {
      const beforeRefresh = accessReads;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => accessReads).toBeGreaterThan(beforeRefresh);
      await expect(page.getByText("Saved access has changed to revision 2.", { exact: false })).toBeVisible();
    }
    expect(closed).toBe(false); expect(postCount).toBe(1);
    held!.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "source-post" });
    held!.end(JSON.stringify({ sourceId: scenario === "malformed" ? "a0000000-0000-4000-8000-000000000099" : sourceId, revision: nextRevision }));
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { sourceEof?: boolean; sourceReleased?: boolean }).sourceEof &&
      (window as unknown as { sourceReleased?: boolean }).sourceReleased))).toBe(true);
    if (!confirmed) {
      await expect(page.getByText("The earlier source access change could not be confirmed.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save source access" })).toBeDisabled();
      await page.getByRole("button", { name: "Close source readers" }).click();
    } else {
      await expect(page.getByRole("button", { name: "Close source readers" })).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Manage source readers" }).click();
    await page.getByRole("button", { name: "Review source access" }).click();
    if (confirmed) {
      await expect(page.getByRole("button", { name: "Save source access" })).toBeEnabled();
      await page.getByRole("button", { name: "Save source access" }).click();
      await expect.poll(() => postCount).toBe(2);
      await expect.poll(() => postBodies.length).toBe(2);
      expect(postBearers[1]).toBe("Bearer synthetic-token");
      expect(postBodies[1]).toEqual({ projectId, sourceId, expectedRevision: nextRevision, state: "AVAILABLE", readers: ["new-reader"] });
    } else {
      await expect(page.getByText("The earlier source access change could not be confirmed.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save source access" })).toBeDisabled();
      expect(postCount).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { sourcePosts?: number }).sourcePosts)).toBe(1);
    }
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
});
}
