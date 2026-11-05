import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: synthetic actual-App controls for overlapping identity and
// selected-project issuances. The original HTTP responses remain un-cloned.
for (const scenario of ["identity", "project"] as const) {
  for (const oldStatus of [200, 403, 404] as const) {
    test(`old ${scenario} ${oldStatus} cannot replace a newer issuance`, async ({ browser }) => {
      const upstream = new URL(String(test.info().project.use.baseURL));
      if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
      const customerId = "10000000-0000-4000-8000-000000000001";
      const projectA = "30000000-0000-4000-8000-000000000001", projectB = "30000000-0000-4000-8000-000000000002";
      const project = (id: string, name: string) => ({ id, portfolioId: "30000000-0000-4000-8000-000000000050", code: id === projectA ? "A" : "B", name, description: "Synthetic", reportedStatus: "UNKNOWN" });
      let logins = 0, identities = 0, aReads = 0, held: ServerResponse | undefined, closed = false, entered!: () => void;
      const heldStarted = new Promise<void>((resolve) => { entered = resolve; });
      const heldAuthorization: Array<string | undefined> = [], newerAuthorization: Array<string | undefined> = [];
      const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
        const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
        const hold = () => { held = res; heldAuthorization.push(req.headers.authorization); res.on("close", () => { if (!res.writableFinished) closed = true; }); entered(); };
        if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
        if (path === "/api/auth/development") { logins++; return json(200, { token: "same-synthetic-token" }); }
        if (path === "/api/me") {
          identities++;
          if (scenario === "identity" && identities === 1) { hold(); return; }
          if (scenario === "identity" && logins >= 2) newerAuthorization.push(req.headers.authorization);
          return json(200, { subject: "replacement-actor", customerId, roles: ["contributor"] });
        }
        if (path === "/api/projects") return json(200, [project(projectA, "Project Alpha"), project(projectB, "Project Beta")]);
        if (path === `/api/projects/${projectA}`) {
          aReads++;
          if (scenario === "project" && aReads === 1) { hold(); return; }
          if (scenario === "project") newerAuthorization.push(req.headers.authorization);
          return json(200, project(projectA, "New Alpha"));
        }
        if (path === `/api/projects/${projectB}`) return json(200, project(projectB, "New Beta"));
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
            const response = await original(input, init);
            if (response.headers.get("x-synthetic-case") === "held-old") {
              const json = response.json.bind(response), buffer = response.arrayBuffer.bind(response);
              response.json = async () => { const value = await json(); (window as unknown as { heldConsumed: boolean }).heldConsumed = true; return value; };
              response.arrayBuffer = async () => { const value = await buffer(); (window as unknown as { heldConsumed: boolean }).heldConsumed = true; return value; };
              if (response.body) {
                const stream = response.body, getReader = stream.getReader.bind(stream);
                stream.getReader = (() => {
                  const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
                  let eof = false;
                  reader.read = async () => { const value = await read(); if (value.done) eof = true; return value; };
                  reader.releaseLock = () => { release(); if (eof) (window as unknown as { heldConsumed: boolean }).heldConsumed = true; };
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
        if (scenario === "project") await page.getByRole("button", { name: /Project Alpha/ }).click();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([heldStarted, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Held read did not start")), 15000); })]); }
        finally { if (timeout !== undefined) clearTimeout(timeout); }
        expect(heldAuthorization).toEqual(["Bearer same-synthetic-token"]);
        if (scenario === "identity") {
          await page.getByRole("button", { name: "Sign out" }).click(); await signIn();
          await expect.poll(() => logins).toBe(2);
          await expect(page.getByText("replacement-actor", { exact: true })).toBeVisible();
        } else {
          await page.getByRole("button", { name: /All projects/ }).click();
          await page.getByRole("button", { name: /Project Beta/ }).click();
          await expect(page.getByRole("heading", { name: "New Beta", level: 1 })).toBeVisible();
          await page.getByRole("button", { name: /All projects/ }).click();
          await page.getByRole("button", { name: /Project Alpha/ }).click();
          await expect(page.getByRole("heading", { name: "New Alpha", level: 1 })).toBeVisible();
        }
        expect(newerAuthorization).toContain("Bearer same-synthetic-token");
        const calibrated = await page.evaluate(async () => {
          const state = window as unknown as { staleSeen: boolean; watch: MutationObserver };
          state.staleSeen = false;
          state.watch = new MutationObserver((records) => {
            const nodes = records.flatMap((record) => [...record.addedNodes, ...record.removedNodes]);
            if (nodes.some((node) => node.textContent?.includes("Old synthetic issuance")) || records.some((record) =>
              record.type === "characterData" && (record.oldValue?.includes("Old synthetic issuance") || record.target.textContent?.includes("Old synthetic issuance")))) state.staleSeen = true;
          });
          state.watch.observe(document.body, { childList: true, characterData: true, characterDataOldValue: true, subtree: true });
          const marker = document.createTextNode("Old synthetic issuance"); document.body.append(marker); marker.remove(); await Promise.resolve();
          const insertion = state.staleSeen; state.staleSeen = false;
          const text = document.createTextNode("baseline"); document.body.append(text); await Promise.resolve();
          text.data = "Old synthetic issuance"; text.data = "baseline"; await Promise.resolve(); const mutation = state.staleSeen;
          text.remove(); await Promise.resolve(); state.staleSeen = false; return insertion && mutation;
        });
        expect(calibrated).toBe(true); expect(closed).toBe(false);
        const oldValue = scenario === "identity" ? { subject: "Old synthetic issuance", customerId, roles: ["contributor"] }
          : project(projectA, "Old synthetic issuance");
        held!.writeHead(oldStatus, { "Content-Type": "application/json", "x-synthetic-case": "held-old" });
        held!.end(JSON.stringify(oldStatus === 200 ? oldValue : { message: "Synthetic unavailable" }));
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { heldConsumed?: boolean }).heldConsumed))).toBe(true);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (scenario === "identity") await expect(page.getByText("replacement-actor", { exact: true })).toBeVisible();
        else await expect(page.getByRole("heading", { name: "New Alpha", level: 1 })).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { staleSeen: boolean }).staleSeen)).toBe(false);
      } finally {
        try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
        finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
      }
    });
  }
}
