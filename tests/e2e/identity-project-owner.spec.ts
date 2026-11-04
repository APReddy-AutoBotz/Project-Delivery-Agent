import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001: a project proof read under the old identity cannot be reused
// after the same session receives a different verified actor.
test("same-session actor change requires a new selected-project proof", async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const projectId = "30000000-0000-4000-8000-000000000001", customerId = "10000000-0000-4000-8000-000000000001";
  const project = (name: string) => ({ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name, description: "Synthetic", reportedStatus: "UNKNOWN" });
  const policy = { projectId, key: "reporting", revision: 1, freshnessWindowSeconds: 3600, timeZone: "UTC",
    requiredFacts: [{ factType: "project.status", label: "Status" }], responsibleSubject: "synthetic-owner", scheduledScanEnabled: false,
    reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0, escalationRecipientSubject: null,
    quietHoursStartLocal: null, quietHoursEndLocal: null, changedBy: "synthetic-actor", changedAt: "2026-10-20T00:00:00.000Z" };
  let phase = 0, logins = 0, initialProofs = 0, identityHeld: ServerResponse | undefined, projectHeld: ServerResponse | undefined;
  let freshProjectReleased = false, freshPolicyReads = 0, earlyPolicyRead = false, policyBeforeProjectEof = false;
  const freshPolicyBearers: Array<string | undefined> = [];
  const oldProjectHeld: ServerResponse[] = [], proofAuthorization: Array<string | undefined> = [];
  let freshProofAfterIdentity: string | undefined;
  let newProjectArrived!: () => void;
  const newProjectRead = new Promise<void>((resolve) => { newProjectArrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
    if (path === "/api/me") {
      if (phase === 1 && req.headers["x-synthetic-owner"] === "main") {
        if (identityHeld) return json(500, { message: "Unexpected duplicate identity check" });
        identityHeld = res; proofAuthorization.push(req.headers.authorization); return;
      }
      return json(200, { subject: phase >= 2 ? "new-actor" : "old-actor", customerId, roles: ["pmo_admin"] });
    }
    if (path === "/api/projects") return json(200, [project("Project card")]);
    if (path === `/api/projects/${projectId}`) {
      if (req.headers["x-synthetic-owner"] === "main") {
        proofAuthorization.push(req.headers.authorization);
        if (phase === 0) initialProofs++;
        if (phase === 1) { oldProjectHeld.push(res); return; }
        if (phase === 2) {
          if (projectHeld) return json(500, { message: "Unexpected duplicate project check" });
          freshProofAfterIdentity = req.headers["x-synthetic-identity-eof"] as string | undefined;
          projectHeld = res; newProjectArrived(); return;
        }
      }
      return json(200, project("Initial project"));
    }
    if (path === `/api/projects/${projectId}/project-update-policy`) {
      if (phase === 2) {
        freshPolicyReads++; freshPolicyBearers.push(req.headers.authorization);
        if (!freshProjectReleased) earlyPolicyRead = true;
        if (req.headers["x-synthetic-project-eof"] !== "true") policyBeforeProjectEof = true;
        return json(200, { ...policy, freshnessWindowSeconds: 4200 });
      }
      return json(200, policy);
    }
    if (path === `/api/projects/${projectId}/project-update-assessments/latest`) return json(200, null);
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
        if (new URL(url, location.href).pathname.startsWith("/api/")) {
          const stack = new Error().stack ?? "", headers = new Headers(init?.headers);
          headers.set("x-synthetic-owner", stack.includes("/health-scope-context.tsx") ? "health" : stack.includes("/main.tsx") ? "main" : "other");
          headers.set("x-synthetic-identity-eof", String(Boolean((window as unknown as { newIdentityReleased?: boolean }).newIdentityReleased)));
          headers.set("x-synthetic-project-eof", String(Boolean((window as unknown as { newProjectReleased?: boolean }).newProjectReleased)));
          init = { ...init, headers };
        }
        const response = await original(input, init);
        const marker = response.headers.get("x-synthetic-case");
        if ((marker === "new-identity" || marker === "new-project") && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
            reader.read = async () => { const value = await read(); if (value.done) eof = true; return value; };
            reader.releaseLock = () => { release(); if (eof) {
              const state = window as unknown as { newIdentityReleased?: boolean; newProjectReleased?: boolean };
              if (marker === "new-identity") state.newIdentityReleased = true; else state.newProjectReleased = true;
            } };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await expect(page.getByText("old-actor", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Project card/ }).click();
    await expect(page.getByRole("heading", { name: "Initial project", level: 1 })).toBeVisible();
    await page.getByText("Reporting policy · PMO administration").click();
    const draft = page.getByLabel("Freshness window (seconds)"); await expect(draft).toHaveValue("3600"); await draft.fill("9876");
    expect(initialProofs).toBe(1); expect(logins).toBe(1);
    phase = 1; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => Boolean(identityHeld)).toBe(true);
    await expect(page.getByRole("heading", { name: "Initial project", level: 1 })).toHaveCount(0);
    const calibrated = await page.evaluate(async () => {
      const state = window as unknown as { staleHeadingSeen: boolean; proofObserver: MutationObserver };
      state.staleHeadingSeen = false;
      state.proofObserver = new MutationObserver(() => {
        if ([...document.querySelectorAll("h1")].some((heading) => heading.getClientRects().length > 0 &&
          ["Initial project", "Old project proof"].includes(heading.textContent ?? ""))) state.staleHeadingSeen = true;
      });
      state.proofObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      const marker = document.createElement("h1"); marker.textContent = "Initial project"; document.body.append(marker);
      await Promise.resolve(); const detected = state.staleHeadingSeen; marker.remove(); await Promise.resolve(); state.staleHeadingSeen = false;
      return detected;
    });
    expect(calibrated).toBe(true);
    phase = 2; identityHeld!.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "new-identity" });
    identityHeld!.end(JSON.stringify({ subject: "new-actor", customerId, roles: ["pmo_admin"] }));
    await expect(page.getByText("new-actor", { exact: true })).toBeVisible();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([newProjectRead, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Fresh selected-project check did not start")), 10000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    expect(freshProofAfterIdentity).toBe("true");
    await expect(page.getByRole("heading", { name: "Initial project", level: 1 })).toHaveCount(0);
    await expect(draft).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { staleHeadingSeen: boolean }).staleHeadingSeen)).toBe(false);
    freshProjectReleased = true;
    projectHeld!.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "new-project" }); projectHeld!.end(JSON.stringify(project("New project proof")));
    await expect(page.getByRole("heading", { name: "New project proof", level: 1 })).toBeVisible();
    await page.getByText("Reporting policy · PMO administration").click();
    await expect(page.getByLabel("Freshness window (seconds)")).toHaveValue("4200");
    expect(freshPolicyReads).toBeGreaterThan(0); expect(earlyPolicyRead).toBe(false); expect(policyBeforeProjectEof).toBe(false);
    expect(freshPolicyBearers.every((value) => value === "Bearer synthetic-token")).toBe(true);
    for (const held of oldProjectHeld) { held.writeHead(200, { "Content-Type": "application/json" }); held.end(JSON.stringify(project("Old project proof"))); }
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("heading", { name: "New project proof", level: 1 })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { staleHeadingSeen: boolean }).staleHeadingSeen)).toBe(false);
    expect(proofAuthorization.length).toBeGreaterThanOrEqual(3); expect(proofAuthorization.every((value) => value === "Bearer synthetic-token")).toBe(true);
    expect(logins).toBe(1);
  } finally {
    try { for (const held of [identityHeld, projectHeld, ...oldProjectHeld]) if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
});

for (const afterRecovery of ["project-retry", "actor-change"] as const) {
test(`project denial survives identity failure and permits ${afterRecovery}`, async ({ browser }) => {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
  const projectId = "30000000-0000-4000-8000-000000000001", customerId = "10000000-0000-4000-8000-000000000001";
  const project = { id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Synthetic", reportedStatus: "UNKNOWN" };
  let actor = "actor-a", identityReads = 0, directProjectReads = 0, logins = 0, invalidIdentity = false, version = "initial";
  const bearers: Array<string | undefined> = [];
  const projectOwners: Array<string | undefined> = [], identityBearers: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
    if (path === "/api/me") {
      identityReads++;
      if (req.headers["x-synthetic-owner"] !== "main") return json(200, { subject: actor, customerId, roles: ["contributor"] });
      identityBearers.push(req.headers.authorization);
      res.writeHead(invalidIdentity ? 500 : 200, { "Content-Type": "application/json", "x-synthetic-identity": version });
      return res.end(JSON.stringify(invalidIdentity ? { message: "Synthetic identity failure" } : { subject: actor, customerId, roles: ["contributor"] }));
    }
    if (path === "/api/projects") return json(200, [project]);
    if (path === `/api/projects/${projectId}`) {
      if (req.headers["x-synthetic-owner"] === "main") {
        directProjectReads++; bearers.push(req.headers.authorization); projectOwners.push(req.headers["x-synthetic-identity-version"] as string | undefined);
        if (directProjectReads === 1) return json(403, { message: "Synthetic denial" });
      }
      return json(200, project);
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
        const stack = new Error().stack ?? "", headers = new Headers(init?.headers);
        headers.set("x-synthetic-owner", stack.includes("/health-scope-context.tsx") ? "health" : stack.includes("/main.tsx") ? "main" : "other");
        headers.set("x-synthetic-identity-version", (window as unknown as { identityVersion?: string }).identityVersion ?? "none");
        const response = await original(input, { ...init, headers });
        const marker = response.headers.get("x-synthetic-identity");
        if (marker && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader); let eof = false;
            reader.read = async () => { const value = await read(); if (value.done) eof = true; return value; };
            reader.releaseLock = () => { release(); if (eof) {
              const state = window as unknown as { identityVersion: string; identityCompleted?: string[] };
              state.identityVersion = marker; state.identityCompleted = [...(state.identityCompleted ?? []), marker];
            } };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    });
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    await page.getByRole("button", { name: /Synthetic project/ }).click();
    await expect(page.getByText("Project access could not be established.")).toBeVisible();
    expect(directProjectReads).toBe(1);
    const completed = (value: string) => page.evaluate((expected) =>
      Boolean((window as unknown as { identityCompleted?: string[] }).identityCompleted?.includes(expected)), value);
    const firstIdentityReads = identityReads; version = "same";
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => identityReads).toBeGreaterThan(firstIdentityReads);
    await expect.poll(() => completed("same")).toBe(true);
    await expect(page.getByRole("button", { name: "Check project access" })).toBeEnabled();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(directProjectReads).toBe(1);
    invalidIdentity = true; version = "failed"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => completed("failed")).toBe(true);
    await expect(page.getByRole("button", { name: "Retry account access" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check project access" })).toBeDisabled();
    invalidIdentity = false; version = "recovered"; await page.getByRole("button", { name: "Retry account access" }).click();
    await expect.poll(() => completed("recovered")).toBe(true);
    await expect(page.getByRole("button", { name: "Check project access" })).toBeEnabled();
    expect(directProjectReads).toBe(1);
    if (afterRecovery === "project-retry") {
      await page.getByRole("button", { name: "Check project access" }).click();
      await expect(page.getByRole("heading", { name: "Synthetic project", level: 1 })).toBeVisible();
      expect(projectOwners).toEqual(["initial", "recovered"]);
      expect(bearers).toEqual(["Bearer synthetic-token", "Bearer synthetic-token"]);
      expect(identityBearers.every((value) => value === "Bearer synthetic-token")).toBe(true); expect(logins).toBe(1);
      return;
    }
    actor = "actor-b"; version = "actor-b"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => completed("actor-b")).toBe(true);
    await expect(page.getByText("actor-b", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Synthetic project", level: 1 })).toBeVisible();
    expect(directProjectReads).toBe(2);
    actor = "actor-a"; version = "actor-a-again"; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => completed("actor-a-again")).toBe(true);
    await expect(page.getByText("actor-a", { exact: true })).toBeVisible();
    await expect.poll(() => directProjectReads).toBe(3);
    await expect(page.getByRole("heading", { name: "Synthetic project", level: 1 })).toBeVisible();
    expect(bearers).toEqual(["Bearer synthetic-token", "Bearer synthetic-token", "Bearer synthetic-token"]);
    expect(projectOwners).toEqual(["initial", "actor-b", "actor-a-again"]);
    expect(identityBearers.every((value) => value === "Bearer synthetic-token")).toBe(true); expect(logins).toBe(1);
  } finally {
    try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});
}
