import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";

// SEC-AUTH-001: the two /me consumers reject invalid wire identities while
// their original reader reaches EOF or cancellation and a later valid check
// can recover; a bounded cancellation does not prove full response capture.
for (const consumer of ["global", "health"] as const) {
  for (const malformed of ["role", "extra", "uuid", "201", "204", "json", "oversize"] as const) {
    test(`${consumer} identity rejects ${malformed} and permits a valid retry`, async ({ browser }) => {
      const upstream = new URL(String(test.info().project.use.baseURL));
      if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
      const projectId = "30000000-0000-4000-8000-000000000001";
      const actor = { subject: "synthetic-actor", customerId: "10000000-0000-4000-8000-000000000001", roles: ["project_manager"] };
      const project = { id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic detail", description: "Fixture", reportedStatus: "UNKNOWN" };
      const detail = { ...project, configured: true, portfolio: { id: "30000000-0000-4000-8000-000000000050", name: "Fixture" }, programme: null,
        creation: { by: "fixture", at: "2026-10-20T00:00:00.000Z", revision: 1 },
        dates: { plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null }, responsibilities: [], sprints: [], milestones: [],
        workItems: [], requiredWorkItems: [], raidItems: [], sourceMappings: [], sourceMappingsWithheld: true };
      let invalid = false, badReads = 0, latestReads = 0, detailReads = 0;
      const observed: Array<{ authorization: string | undefined; owner: string | undefined; id: string }> = [];
      const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
        const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
        if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
        if (path === "/api/auth/development") return json(200, { token: "synthetic-token" });
        if (path === "/api/me") {
          if (!invalid || req.headers["x-synthetic-owner"] !== consumer) return json(200, actor);
          const id = `${consumer}-${++badReads}`;
          observed.push({ authorization: req.headers.authorization, owner: req.headers["x-synthetic-owner"] as string | undefined, id });
          res.writeHead(malformed === "201" ? 201 : malformed === "204" ? 204 : 200,
            { "Content-Type": "application/json", "x-synthetic-case": "invalid-identity", "x-synthetic-id": id });
          if (malformed === "204") return res.end();
          if (malformed === "json") return res.end("{invalid");
          if (malformed === "oversize") return res.end(JSON.stringify({ ...actor, subject: "é".repeat(33_000) }));
          return res.end(JSON.stringify(malformed === "role" ? { ...actor, roles: ["unknown"] } : malformed === "extra" ? { ...actor, extra: true }
            : malformed === "uuid" ? { ...actor, customerId: "not-a-uuid" } : actor));
        }
        if (path === "/api/projects") return json(200, [project]);
        if (path === `/api/projects/${projectId}`) { detailReads++; return json(200, project); }
        if (path === `/api/projects/${projectId}/canonical`) return json(200, detail);
        if (path === `/api/projects/${projectId}/health-assessments/latest`) { latestReads++; return json(200, null); }
        if (path === `/api/projects/${projectId}/facts`) return json(200, { canAppend: false, canConfigure: false, facts: [], next: null });
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
            if (new URL(url, location.href).pathname === "/api/me") {
              const stack = new Error().stack ?? "", headers = new Headers(init?.headers);
              headers.set("x-synthetic-owner", stack.includes("/health-scope-context.tsx") ? "health" : stack.includes("/main.tsx") ? "global" : "unknown");
              init = { ...init, headers };
            }
            const response = await original(input, init);
            if (response.headers.get("x-synthetic-case") === "invalid-identity") {
              const id = response.headers.get("x-synthetic-id"); if (!id) throw new Error("Missing synthetic response ID");
              const records = (window as unknown as { identityRecords?: Record<string, { noBody?: boolean; released?: boolean; eof?: boolean; cancelled?: boolean }> });
              records.identityRecords ??= {};
              const state: { noBody?: boolean; released?: boolean; eof?: boolean; cancelled?: boolean } = {};
              records.identityRecords[id] = state;
              if (!response.body) state.noBody = true;
              else {
                const stream = response.body, getReader = stream.getReader.bind(stream);
                stream.getReader = (() => {
                  const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
                  reader.read = async () => { const result = await read(); if (result.done) state.eof = true; return result; };
                  reader.cancel = async (reason) => { const result = await cancel(reason); state.cancelled = true; return result; };
                  reader.releaseLock = () => { release(); state.released = true; };
                  return reader;
                }) as typeof stream.getReader;
              }
            }
            return response;
          };
        });
        const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
        await page.getByRole("button", { name: /^Project manager / }).first().click();
        await expect(page.getByText("synthetic-actor", { exact: true })).toBeVisible();
        if (consumer === "health") invalid = true;
        await page.getByRole("button", { name: /Synthetic detail/ }).click();
        await expect(page.getByRole("heading", { name: "Synthetic detail", level: 1 })).toBeVisible();
        if (consumer === "global") {
          await expect(page.getByText("No saved assessment yet", { exact: false })).toBeVisible();
          invalid = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          await expect(page.getByRole("button", { name: "Retry access checks" })).toBeVisible();
          await expect(page.getByRole("heading", { name: "Synthetic detail", level: 1 })).toHaveCount(0);
        } else {
          await expect(page.getByText("Current health access could not be established.")).toBeVisible();
          expect(latestReads).toBe(0); expect(detailReads).toBe(1);
        }
        expect(observed).toEqual([{ authorization: "Bearer synthetic-token", owner: consumer, id: `${consumer}-1` }]);
        await expect.poll(() => page.evaluate(({ id, malformed }) => {
          const state = (window as unknown as { identityRecords?: Record<string, { noBody?: boolean; released?: boolean; eof?: boolean; cancelled?: boolean }> }).identityRecords?.[id];
          if (!state) return false;
          if (malformed === "204") return state.noBody === true || (state.released === true && state.eof === true);
          if (malformed === "oversize") return state.released === true && state.cancelled === true;
          return state.released === true && state.eof === true;
        }, { id: `${consumer}-1`, malformed })).toBe(true);
        expect(observed).toEqual([{ authorization: "Bearer synthetic-token", owner: consumer, id: `${consumer}-1` }]);
        invalid = false;
        await page.getByRole("button", { name: consumer === "global" ? "Retry access checks" : "Check access again" }).click();
        await expect(page.getByRole("heading", { name: "Synthetic detail", level: 1 })).toBeVisible();
        await expect(page.getByText("No saved assessment yet", { exact: false })).toBeVisible();
        expect(latestReads).toBeGreaterThan(0);
      } finally {
        try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
      }
    });
  }
}
