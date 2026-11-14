import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";

// SEC-AUTH-001: invalid global list/setup observations must not become an
// empty list or creation authority. Oversize cancellation is not full capture.
for (const target of ["projects", "setup"] as const) {
  for (const invalid of ["null", "shape", "201", "204", "403", "503", "oversize"] as const) {
    test(`${target} ${invalid} is unavailable and can be retried`, async ({ browser }) => {
      const upstream = new URL(String(test.info().project.use.baseURL));
      if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
      const customerId = "10000000-0000-4000-8000-000000000001", portfolioId = "30000000-0000-4000-8000-000000000050";
      const project = { id: "30000000-0000-4000-8000-000000000001", portfolioId, code: "S", name: "Synthetic project", description: "", reportedStatus: "UNKNOWN" };
      const setup = { truncated: false, portfolios: [{ id: portfolioId, name: "Synthetic portfolio", programmes: [], programmesTruncated: false }] };
      let reads = 0, logins = 0; const requests: Array<{ method: string | undefined; bearer: string | undefined }> = [];
      const targetPath = target === "projects" ? "/api/projects" : "/api/project-setup";
      const server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
        const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
        if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
        if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
        if (path === "/api/me") return json(200, { customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] });
        if (path === "/api/projects" || path === "/api/project-setup") {
          const value = path === "/api/projects" ? [project] : setup;
          if (path !== targetPath) return json(200, value);
          reads++; requests.push({ method: req.method, bearer: req.headers.authorization });
          if (reads > 1) return json(200, value);
          res.writeHead(invalid === "201" ? 201 : invalid === "204" ? 204 : invalid === "403" ? 403 : invalid === "503" ? 503 : 200,
            { "Content-Type": "application/json", "x-synthetic-case": "invalid-global" });
          if (invalid === "204") return res.end();
          if (invalid === "403" || invalid === "503") return res.end(JSON.stringify({ message: "Synthetic unavailable" }));
          if (invalid === "null") return res.end("null");
          if (invalid === "shape") return res.end(JSON.stringify(target === "projects" ? [{ ...project, portfolioId: "bad" }] : { ...setup, portfolios: "bad" }));
          if (invalid === "oversize") return res.end(JSON.stringify(target === "projects"
            ? [{ ...project, description: "x".repeat(16 * 1024 * 1024) }]
            : { ...setup, portfolios: [{ ...setup.portfolios[0], name: "x".repeat(8 * 1024 * 1024) }] }));
          return res.end(JSON.stringify(value));
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
            const response = await original(input, init);
            if (response.headers.get("x-synthetic-case") === "invalid-global") {
              const state = window as unknown as { noBody?: boolean; eof?: boolean; cancelled?: boolean; released?: boolean };
              if (!response.body) state.noBody = true;
              else {
                const stream = response.body, getReader = stream.getReader.bind(stream);
                stream.getReader = (() => {
                  const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
                  reader.read = async () => { const value = await read(); if (value.done) state.eof = true; return value; };
                  reader.cancel = async (reason) => { const value = await cancel(reason); state.cancelled = true; return value; };
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
        const retry = page.getByRole("button", { name: target === "projects" ? "Retry project access" : "Retry project setup" });
        await expect(retry).toBeVisible();
        if (target === "projects") {
          await expect(page.getByRole("button", { name: /Synthetic project/ })).toHaveCount(0);
          await expect(page.getByText("No projects are shared with this account")).toHaveCount(0);
        } else await expect(page.getByRole("button", { name: "Create project", exact: true })).toHaveCount(0);
        await expect.poll(() => page.evaluate((kind) => {
          const s = window as unknown as { noBody?: boolean; eof?: boolean; cancelled?: boolean; released?: boolean };
          return kind === "204" ? Boolean(s.noBody || (s.eof && s.released)) : kind === "oversize" ? Boolean(s.cancelled && s.released) : Boolean(s.eof && s.released);
        }, invalid)).toBe(true);
        await retry.click();
        if (target === "projects") await expect(page.getByRole("button", { name: /Synthetic project/ })).toBeVisible();
        else await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeVisible();
        expect(reads).toBe(2); expect(requests).toEqual([{ method: "GET", bearer: "Bearer synthetic-token" },
          { method: "GET", bearer: "Bearer synthetic-token" }]); expect(logins).toBe(1);
      } finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    });
  }
}
