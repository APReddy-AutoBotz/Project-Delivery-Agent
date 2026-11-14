import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: retained creation drafts and unconfirmed writes stay bound to
// their issuing identity/setup. This is a same-page synthetic loopback test.
for (const outcome of ["confirmed", "uncertain", "left-view", "stale-review", "review-mismatch", "row-mismatch", "edit-final", "permission-change", "exact-replay"] as const) {
  test(`creation draft survives identity/setup recovery with ${outcome} write`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const customerId = "10000000-0000-4000-8000-000000000001", portfolioId = "30000000-0000-4000-8000-000000000050";
    const projectId = "30000000-0000-4000-8000-000000000001", secondPortfolioId = "30000000-0000-4000-8000-000000000052";
    const project = { id: projectId, portfolioId, code: "SYN", name: "Created synthetic project", description: "", reportedStatus: "UNKNOWN" };
    const setup = { truncated: false, portfolios: [{ id: portfolioId, name: "Synthetic portfolio", programmes: [], programmesTruncated: false },
      { id: secondPortfolioId, name: "Second synthetic portfolio", programmes: [], programmesTruncated: false }] };
    let holdIdentity = false, failNextSetup = false, restrictedSetup = false, setupReads = 0, logins = 0, postCount = 0, programmePosts = 0;
    const protectedBearers: Array<string | undefined> = [];
    let identityHeld: ServerResponse | undefined, postHeld: ServerResponse | undefined, postBody: Record<string, unknown> | undefined;
    const postBodies: Record<string, unknown>[] = [];
    let setupAfterIdentity: string | undefined;
    let identityArrived!: () => void, postArrived!: () => void;
    const enteredIdentity = new Promise<void>((resolve) => { identityArrived = resolve; });
    const enteredPost = new Promise<void>((resolve) => { postArrived = resolve; });
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
      if (path === "/api/me") {
        protectedBearers.push(req.headers.authorization);
        if (holdIdentity && !identityHeld) { identityHeld = res; res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "held-identity" }); res.flushHeaders(); identityArrived(); return; }
        if (postCount > 0 && outcome === "uncertain" && req.headers["x-synthetic-refresh-epoch"] === "1") { res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "identity-after-post" }); return res.end(JSON.stringify({ customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] })); }
        return json(200, { customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] });
      }
      if (path === "/api/project-setup") {
        setupReads++; protectedBearers.push(req.headers.authorization);
        if (failNextSetup) { failNextSetup = false; return json(503, { message: "Synthetic failure" }); }
        if (postCount > 0 && outcome === "uncertain" && req.headers["x-synthetic-refresh-epoch"] === "1") {
          setupAfterIdentity = req.headers["x-synthetic-identity-after"] as string | undefined;
          res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "setup-after-post" }); return res.end(JSON.stringify(setup));
        }
        return json(200, restrictedSetup ? { ...setup, portfolios: [setup.portfolios[1]] } : setup);
      }
      if (path === "/api/projects" && req.method === "POST") {
        postCount++; protectedBearers.push(req.headers.authorization); let body = ""; req.setEncoding("utf8"); req.on("data", (part: string) => { body += part; });
        req.on("end", () => {
          postBody = JSON.parse(body) as Record<string, unknown>;
          postBodies.push(postBody);
          if (outcome === "uncertain" || outcome === "left-view") { postHeld = res; res.writeHead(201, { "Content-Type": "application/json", "x-synthetic-case": "held-create" }); res.flushHeaders(); postArrived(); }
          else if (outcome === "exact-replay" && postCount === 1) {
            res.writeHead(201, { "Content-Type": "application/json" }); res.flushHeaders(); res.write("{"); setTimeout(() => res.destroy(), 20);
          }
          else json(201, { id: projectId });
        });
        return;
      }
      if (path === `/api/portfolios/${portfolioId}/programmes` && req.method === "POST") { programmePosts++; protectedBearers.push(req.headers.authorization); return json(500, { message: "Unexpected programme write" }); }
      if (path === "/api/projects") return json(200, []);
      if (path === `/api/projects/${projectId}`) return json(200, { ...project, portfolioId: postBody?.portfolioId ?? portfolioId });
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
          const path = new URL(url, location.href).pathname;
          const state = window as unknown as { armed?: boolean; form?: HTMLFormElement; programmeButton?: HTMLButtonElement; finalButton?: HTMLButtonElement;
            formLive?: boolean; programmeLive?: boolean; submits?: number; clicks?: number; posts?: number; delta?: number;
            finalLive?: boolean; finalClicks?: number; postReader?: boolean; postEof?: boolean; postReleased?: boolean;
            identityAfter?: boolean; setupAfter?: boolean; refreshEpoch?: number };
          if (init?.method === "POST" && (path === "/api/projects" || path.endsWith("/programmes"))) state.posts = (state.posts ?? 0) + 1;
          if (state.armed && path === "/api/me") {
            state.armed = false; const before = state.posts ?? 0;
            state.formLive = Boolean(state.form?.isConnected); state.programmeLive = Boolean(state.programmeButton?.isConnected && !state.programmeButton.disabled);
            state.finalLive = Boolean(state.finalButton?.isConnected && !state.finalButton.disabled);
            state.form?.requestSubmit(); state.programmeButton?.click(); state.finalButton?.click(); state.delta = (state.posts ?? 0) - before;
          }
          const headers = new Headers(init?.headers);
          headers.set("x-synthetic-refresh-epoch", String(state.refreshEpoch ?? 0));
          headers.set("x-synthetic-identity-after", String(Boolean(state.identityAfter)));
          const response = await original(input, { ...init, headers });
          const marker = response.headers.get("x-synthetic-case");
          if (["held-create", "identity-after-post", "setup-after-post"].includes(marker ?? "") && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
              if (marker === "held-create") state.postReader = true;
              reader.read = async () => { const value = await read(); if (value.done) { eof = true; if (marker === "held-create") state.postEof = true; } return value; };
              reader.releaseLock = () => { release(); if (marker === "held-create") state.postReleased = true;
                if (eof && marker === "identity-after-post") state.identityAfter = true;
                if (eof && marker === "setup-after-post") state.setupAfter = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      });
      const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      const code = page.getByLabel("Project code", { exact: true }), name = page.getByLabel("Project name", { exact: true });
      await code.fill("SYN"); await name.fill("Retained draft");
      await page.getByText("Create a programme in this portfolio").click();
      await page.getByLabel("Programme code").fill("P1"); await page.getByLabel("Programme name").fill("Programme draft");
      if (outcome === "stale-review") {
        await page.getByRole("button", { name: "Review project" }).click();
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
      }
      await page.evaluate((reviewing) => {
        const state = window as unknown as { form?: HTMLFormElement; programmeButton?: HTMLButtonElement; finalButton?: HTMLButtonElement; submits: number; clicks: number; finalClicks: number };
        const form = document.querySelector(".canonical-form form"), button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Create programme");
        state.submits = 0; state.clicks = 0; state.finalClicks = 0;
        if (reviewing) {
          const final = [...document.querySelectorAll(".canonical-form button")].find((item) => item.textContent?.trim() === "Create project");
          if (!(final instanceof HTMLButtonElement)) throw new Error("Final creation control unavailable");
          state.finalButton = final; final.addEventListener("click", () => { state.finalClicks++; });
        } else {
          if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement)) throw new Error("Creation controls unavailable");
          state.form = form; state.programmeButton = button;
          form.addEventListener("submit", () => { state.submits++; }); button.addEventListener("click", () => { state.clicks++; });
        }
      }, outcome === "stale-review");
      holdIdentity = true; await page.evaluate(() => { (window as unknown as { armed: boolean }).armed = true; window.dispatchEvent(new Event("focus")); });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([enteredIdentity, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Identity check did not start")), 15000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      expect(await page.evaluate(() => {
        const s = window as unknown as { formLive?: boolean; programmeLive?: boolean; finalLive?: boolean; submits?: number; clicks?: number; finalClicks?: number; delta?: number };
        return { formLive: s.formLive, programmeLive: s.programmeLive, finalLive: s.finalLive, submits: s.submits, clicks: s.clicks, finalClicks: s.finalClicks, delta: s.delta };
      })).toEqual(outcome === "stale-review"
        ? { formLive: false, programmeLive: false, finalLive: true, submits: 0, clicks: 0, finalClicks: 1, delta: 0 }
        : { formLive: true, programmeLive: true, finalLive: false, submits: 1, clicks: 1, finalClicks: 0, delta: 0 });
      await expect(name).toBeHidden(); expect(postCount).toBe(0);
      holdIdentity = false; failNextSetup = true; identityHeld!.end(JSON.stringify({ customerId, subject: "synthetic-pmo", roles: ["pmo_admin"] }));
      await expect(page.getByRole("button", { name: "Retry project setup" })).toBeVisible();
      await expect(name).toBeHidden();
      await page.getByRole("button", { name: "Retry project setup" }).click();
      if (outcome === "stale-review") {
        await expect(page.getByRole("heading", { name: "Review project" })).toBeVisible();
        await page.getByRole("button", { name: "Edit details" }).click();
      }
      await expect(name).toBeVisible(); await expect(name).toHaveValue("Retained draft"); await expect(code).toHaveValue("SYN");
      await expect(page.getByLabel("Programme name")).toHaveValue("Programme draft");
      if (outcome === "review-mismatch" || outcome === "row-mismatch") {
        await page.evaluate(({ nextPortfolio, changeRow }) => {
          const form = document.querySelector(".canonical-form form"), select = document.querySelector(".canonical-form select");
          if (!(form instanceof HTMLFormElement) || !(select instanceof HTMLSelectElement)) throw new Error("Review controls unavailable");
          form.requestSubmit();
          if (changeRow) {
            const add = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Add sprint");
            if (!(add instanceof HTMLButtonElement)) throw new Error("Sprint action unavailable"); add.click();
          } else { select.value = nextPortfolio; select.dispatchEvent(new Event("change", { bubbles: true })); }
        }, { nextPortfolio: secondPortfolioId, changeRow: outcome === "row-mismatch" });
        await expect(page.getByText("Project details changed after review. Edit and review them again.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeDisabled();
        expect(postCount).toBe(0);
        await page.getByRole("button", { name: "Edit details" }).click();
        if (outcome === "review-mismatch") await expect(page.getByLabel("Portfolio", { exact: true })).toHaveValue(secondPortfolioId);
        else await page.getByRole("button", { name: "Remove sprint 1" }).click();
      }
      await page.getByRole("button", { name: "Review project" }).click();
      await expect(page.getByRole("heading", { name: "Review project" })).toBeVisible();
      if (outcome === "permission-change") {
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
        const before = setupReads; restrictedSetup = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => setupReads).toBeGreaterThan(before);
        await expect(page.getByText("The reviewed portfolio or programme is unavailable in the current setup.", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeDisabled();
        expect(postCount).toBe(0);
        await page.getByRole("button", { name: "Edit details" }).click();
        await expect(page.getByRole("option", { name: `Unavailable portfolio: ${portfolioId}` })).toHaveCount(1);
        await expect(page.getByLabel("Project name", { exact: true })).toHaveValue("Retained draft");
        await page.getByLabel("Portfolio", { exact: true }).selectOption(secondPortfolioId);
        await page.getByRole("button", { name: "Review project" }).click();
        await expect(page.getByRole("heading", { name: "Review project" })).toBeVisible();
      }
      if (outcome === "edit-final") {
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
        const attempt = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll(".canonical-form button")];
          const edit = buttons.find((item) => item.textContent?.trim() === "Edit details");
          const create = buttons.find((item) => item.textContent?.trim() === "Create project");
          if (!(edit instanceof HTMLButtonElement) || !(create instanceof HTMLButtonElement) || create.disabled) throw new Error("Review actions unavailable");
          const state = window as unknown as { posts?: number }; const before = state.posts ?? 0;
          let nativeClicks = 0; create.addEventListener("click", () => { nativeClicks++; }); edit.click(); create.click();
          return { clicks: nativeClicks, delta: (state.posts ?? 0) - before };
        });
        expect(attempt).toEqual({ clicks: 1, delta: 0 });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        expect(postCount).toBe(0);
        await expect(name).toBeVisible(); await page.getByRole("button", { name: "Review project" }).click();
        await expect(page.getByRole("heading", { name: "Review project" })).toBeVisible();
      }
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      if (outcome === "exact-replay") {
        await expect(page.getByText("The same project request can be retried with its original key.")).toBeVisible();
        await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Created synthetic project", level: 1 })).toBeVisible();
        expect(postBodies[0]).toEqual(postBodies[1]);
      } else if (outcome === "confirmed" || outcome === "stale-review" || outcome === "review-mismatch" || outcome === "row-mismatch" || outcome === "edit-final" || outcome === "permission-change") {
        await expect(page.getByRole("heading", { name: "Created synthetic project", level: 1 })).toBeVisible();
      } else {
        let postTimer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([enteredPost, new Promise<never>((_resolve, reject) => { postTimer = setTimeout(() => reject(new Error("Create request did not start")), 15000); })]); }
        finally { if (postTimer !== undefined) clearTimeout(postTimer); }
        await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { postReader?: boolean }).postReader))).toBe(true);
        if (outcome === "uncertain") {
          const beforeSetup = setupReads; await page.evaluate(() => {
            (window as unknown as { refreshEpoch: number }).refreshEpoch = 1; window.dispatchEvent(new Event("focus"));
          });
          await expect.poll(() => setupReads).toBeGreaterThan(beforeSetup);
          await expect.poll(() => page.evaluate(() => {
            const s = window as unknown as { identityAfter?: boolean; setupAfter?: boolean }; return Boolean(s.identityAfter && s.setupAfter);
          })).toBe(true);
          expect(setupAfterIdentity).toBe("true");
        } else {
          await page.getByRole("button", { name: "Projects", exact: true }).click();
          await expect(page.getByRole("heading", { name: "Your projects", level: 1 })).toBeVisible();
        }
        postHeld!.end(JSON.stringify({ id: projectId }));
        await expect.poll(() => page.evaluate(() => {
          const s = window as unknown as { postEof?: boolean; postReleased?: boolean }; return Boolean(s.postEof && s.postReleased);
        })).toBe(true);
        if (outcome === "uncertain") {
          await expect(page.getByText("A project creation is pending or could not be confirmed in this page.", { exact: false })).toBeVisible();
          await expect(page.getByRole("button", { name: "Create project", exact: true })).toBeEnabled();
          await expect(page.getByText("The same project request can be retried with its original key.")).toBeVisible();
          await page.getByRole("button", { name: "Projects", exact: true }).click();
        } else {
          await expect(page.getByRole("heading", { name: "Your projects", level: 1 })).toBeVisible();
          await expect(page.getByRole("heading", { name: "Created synthetic project", level: 1 })).toHaveCount(0);
        }
        await page.getByRole("button", { name: "Create project", exact: true }).click();
        await expect(page.getByText("A project creation is pending or could not be confirmed in this page.", { exact: false })).toBeVisible();
        expect(postCount).toBe(1);
      }
      expect(postCount).toBe(outcome === "exact-replay" ? 2 : 1); expect(programmePosts).toBe(0); expect(logins).toBe(1); expect(postBody?.idempotencyKey).toEqual(expect.any(String));
      expect(postBody?.portfolioId).toBe(outcome === "review-mismatch" || outcome === "permission-change" ? secondPortfolioId : portfolioId);
      expect(postBody?.name).toBe("Retained draft"); expect(postBody?.code).toBe("SYN");
      expect(protectedBearers.every((value) => value === "Bearer synthetic-token")).toBe(true);
    } finally {
      try { for (const held of [identityHeld, postHeld]) if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
