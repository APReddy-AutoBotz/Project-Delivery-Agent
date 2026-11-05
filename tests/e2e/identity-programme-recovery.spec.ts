import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: a confirmed programme and a later setup failure are distinct;
// an abandoned held write must not update a newer creation view.
for (const scenario of ["failed-setup", "truncated-setup", "identity-refresh", "left-view", "exact-replay", "digest-edit"] as const) {
  test(`programme creation handles ${scenario}`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const customerId = "10000000-0000-4000-8000-000000000001", portfolioId = "30000000-0000-4000-8000-000000000050";
    const programme = { id: "30000000-0000-4000-8000-000000000051", code: "P1", name: "Synthetic programme" };
    const setup = (include: boolean, truncated = false) => ({ truncated: false, portfolios: [{ id: portfolioId, name: "Synthetic portfolio",
      programmes: include ? [programme] : [], programmesTruncated: truncated }] });
    let setupReads = 0, programmePosts = 0, projectPosts = 0, logins = 0, freshSetupIdentity: string | undefined;
    let setupHeld: ServerResponse | undefined, programmeHeld: ServerResponse | undefined, command: Record<string, unknown> | undefined;
    const commands: Record<string, unknown>[] = [];
    let setupArrived!: () => void, programmeArrived!: () => void;
    const enteredSetup = new Promise<void>((resolve) => { setupArrived = resolve; });
    const enteredProgramme = new Promise<void>((resolve) => { programmeArrived = resolve; });
    const bearers: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
      if (path === "/api/me") {
        bearers.push(req.headers.authorization);
        if (scenario === "identity-refresh" && programmePosts > 0) {
          res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "fresh-identity" });
          return res.end(JSON.stringify({ customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] }));
        }
        return json(200, { customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] });
      }
      if (path === "/api/project-setup") {
        setupReads++; bearers.push(req.headers.authorization);
        if (setupReads === 1) return json(200, setup(false));
        if (setupReads === 2 && scenario === "failed-setup") return json(503, { message: "Synthetic setup failure" });
        if (setupReads === 2 && (scenario === "truncated-setup" || scenario === "exact-replay")) return json(200, setup(false, true));
        if (setupReads === 2 && scenario === "identity-refresh") {
          setupHeld = res; res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "held-setup" }); res.flushHeaders(); setupArrived(); return;
        }
        if (setupReads > 2 && scenario === "identity-refresh") {
          freshSetupIdentity = req.headers["x-synthetic-identity-done"] as string | undefined;
          res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "fresh-setup" }); return res.end(JSON.stringify(setup(true)));
        }
        return json(200, setup(true));
      }
      if (path === "/api/projects" && req.method === "POST") { projectPosts++; return json(500, { message: "Unexpected project write" }); }
      if (path === "/api/projects") return json(200, []);
      if (path === `/api/portfolios/${portfolioId}/programmes` && req.method === "POST") {
        programmePosts++; bearers.push(req.headers.authorization); let body = ""; req.setEncoding("utf8"); req.on("data", (part: string) => { body += part; });
        req.on("end", () => {
          command = JSON.parse(body) as Record<string, unknown>;
          commands.push(command);
          if (scenario === "left-view") { programmeHeld = res; res.writeHead(201, { "Content-Type": "application/json", "x-synthetic-case": "held-programme" }); res.flushHeaders(); programmeArrived(); }
          else if (scenario === "exact-replay" && programmePosts === 1) {
            res.writeHead(201, { "Content-Type": "application/json" }); res.flushHeaders(); res.write("{");
            setTimeout(() => res.destroy(), 20);
          }
          else json(201, programme);
        });
        return;
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
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = (async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
          const state = window as unknown as { holdDigest?: boolean; digestEntered?: boolean; releaseDigest?: () => void };
          if (state.holdDigest) {
            state.holdDigest = false; state.digestEntered = true;
            await new Promise<void>((resolve) => { state.releaseDigest = resolve; });
          }
          return digest(algorithm, data);
        }) as typeof crypto.subtle.digest;
        const original = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const state = window as unknown as { freshIdentityDone?: boolean };
          const headers = new Headers(init?.headers); headers.set("x-synthetic-identity-done", String(Boolean(state.freshIdentityDone)));
          const response = await original(input, { ...init, headers }), marker = response.headers.get("x-synthetic-case");
          if ((marker === "held-programme" || marker === "held-setup" || marker === "fresh-identity" || marker === "fresh-setup") && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
              const record = window as unknown as { heldProgrammeReader?: boolean; heldProgrammeDone?: boolean; heldSetupReader?: boolean; heldSetupDone?: boolean; freshIdentityDone?: boolean; freshSetupDone?: boolean };
              if (marker === "held-programme") record.heldProgrammeReader = true; else if (marker === "held-setup") record.heldSetupReader = true;
              reader.read = async () => { const value = await read(); if (value.done) eof = true; return value; };
              reader.releaseLock = () => { release(); if (eof) {
                if (marker === "held-programme") record.heldProgrammeDone = true;
                else if (marker === "held-setup") record.heldSetupDone = true;
                else if (marker === "fresh-identity") record.freshIdentityDone = true;
                else record.freshSetupDone = true;
              } };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      await page.getByLabel("Project code", { exact: true }).fill("SYN");
      await page.getByLabel("Project name", { exact: true }).fill("Retained project draft");
      await page.getByText("Create a programme in this portfolio").click();
      await page.getByLabel("Programme code").fill("P1"); await page.getByLabel("Programme name").fill("Synthetic programme");
      if (scenario === "digest-edit") {
        await expect(page.getByRole("button", { name: "Create programme" })).toBeEnabled();
        await page.getByLabel("Programme name").evaluate((element) => { (window as unknown as { programmeInput: HTMLInputElement }).programmeInput = element as HTMLInputElement; });
        const attempted = await page.evaluate(() => {
          const state = window as unknown as { holdDigest: boolean; programmeInput: HTMLInputElement; nativeInputs?: number; nativeClicks?: number };
          const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Create programme");
          if (!(button instanceof HTMLButtonElement) || button.disabled || !state.programmeInput.isConnected) throw new Error("Programme controls unavailable");
          state.nativeInputs = 0; state.nativeClicks = 0;
          state.programmeInput.addEventListener("input", () => { state.nativeInputs!++; }); button.addEventListener("click", () => { state.nativeClicks!++; });
          state.holdDigest = true; button.click();
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(state.programmeInput, "Changed programme");
          state.programmeInput.dispatchEvent(new Event("input", { bubbles: true }));
          return { inputs: state.nativeInputs, clicks: state.nativeClicks };
        });
        expect(attempted).toEqual({ inputs: 1, clicks: 1 });
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { digestEntered?: boolean }).digestEntered))).toBe(true);
        await page.evaluate(() => (window as unknown as { releaseDigest: () => void }).releaseDigest());
        await expect(page.getByText("The programme details or setup changed before the request started.")).toBeVisible();
        expect(programmePosts).toBe(0);
        await page.getByLabel("Programme name").fill("Synthetic programme");
        await page.getByRole("button", { name: "Create programme" }).click();
      } else await page.getByRole("button", { name: "Create programme" }).click();
      if (scenario === "failed-setup") {
        await expect(page.getByRole("button", { name: "Retry project setup" })).toBeVisible();
        await page.getByRole("button", { name: "Retry project setup" }).click();
        await expect(page.getByText("The programme was created, but project setup could not be refreshed.", { exact: false })).toBeVisible();
        await expect(page.getByLabel("Programme", { exact: true })).toHaveValue(programme.id);
        await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Retained project draft");
        await page.getByRole("button", { name: "Review project" }).click();
        await expect(page.getByRole("heading", { name: "Review project" })).toBeVisible();
      } else if (scenario === "truncated-setup" || scenario === "exact-replay" || scenario === "digest-edit") {
        if (scenario === "exact-replay") {
          await expect(page.getByText("The same programme request can be retried with its original key.")).toBeVisible();
          await page.getByLabel("Programme name").fill("Temporary edit");
          await expect(page.getByRole("button", { name: "Create programme" })).toBeDisabled();
          await page.getByLabel("Programme name").fill("Synthetic programme");
          await expect(page.getByRole("button", { name: "Create programme" })).toBeEnabled();
          await page.getByRole("button", { name: "Create programme" }).click();
        }
        await expect(page.getByLabel("Programme", { exact: true })).toHaveValue(programme.id);
        await expect(page.getByRole("option", { name: "Synthetic programme (P1)", exact: true })).toHaveCount(1);
        await page.getByRole("button", { name: "Review project" }).click();
        await expect(page.getByRole("heading", { name: "Review project" })).toBeVisible();
        await expect(page.getByText(/Synthetic portfolio \/ Synthetic programme/)).toBeVisible();
        expect(projectPosts).toBe(0);
      } else if (scenario === "identity-refresh") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([enteredSetup, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Setup refresh did not start")), 15000); })]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { heldSetupReader?: boolean }).heldSetupReader))).toBe(true);
        const before = setupReads; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => setupReads).toBeGreaterThan(before);
        await expect.poll(() => page.evaluate(() => {
          const state = window as unknown as { freshIdentityDone?: boolean; freshSetupDone?: boolean };
          return Boolean(state.freshIdentityDone && state.freshSetupDone);
        })).toBe(true);
        expect(freshSetupIdentity).toBe("true");
        setupHeld!.end(JSON.stringify(setup(true)));
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { heldSetupDone?: boolean }).heldSetupDone))).toBe(true);
        await expect(page.getByText("The programme was created, but project setup could not be refreshed.", { exact: false })).toBeVisible();
        await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Retained project draft");
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([enteredProgramme, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Programme request did not start")), 15000); })]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { heldProgrammeReader?: boolean }).heldProgrammeReader))).toBe(true);
        await page.getByRole("button", { name: "Projects", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Your projects", level: 1 })).toBeVisible();
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        const newerDraft = page.getByLabel("Project name", { exact: true }); await newerDraft.fill("Newer creation draft");
        const before = setupReads; programmeHeld!.end(JSON.stringify(programme));
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { heldProgrammeDone?: boolean }).heldProgrammeDone))).toBe(true);
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(setupReads).toBe(before);
        await expect(newerDraft).toHaveValue("Newer creation draft");
        await expect(page.getByText("A programme creation is pending or could not be confirmed in this page.", { exact: false })).toBeVisible();
        expect(programmePosts).toBe(1);
      }
      expect(programmePosts).toBe(scenario === "exact-replay" ? 2 : 1); expect(projectPosts).toBe(0); expect(logins).toBe(1);
      if (scenario === "exact-replay") expect(commands[0]).toEqual(commands[1]);
      expect(command?.code).toBe("P1"); expect(command?.name).toBe("Synthetic programme"); expect(command?.idempotencyKey).toEqual(expect.any(String));
      expect(bearers.every((value) => value === "Bearer synthetic-token")).toBe(true);
    } finally {
      try { for (const held of [setupHeld, programmeHeld]) if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
