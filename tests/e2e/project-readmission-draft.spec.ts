import { test, expect, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";

// SEC-AUTH-001 / FR-HLT-008: keep a same-owner policy draft while requiring
// newly admitted evidence and policy responses before showing or writing them.
for (const scenario of [{ revision: 1, malformed: false, transient: false }, { revision: 2, malformed: false, transient: false },
  { revision: 1, malformed: true, transient: false }, { revision: 1, malformed: false, transient: true }] as const) {
  const { revision: nextRevision, malformed, transient } = scenario;
  test(`project readmission retains a dirty policy draft at revision ${nextRevision}${malformed ? " with an unconfirmed save" : transient ? " after a transient failure" : ""}`, async ({ browser }) => {
    const upstream = new URL(String(test.info().project.use.baseURL));
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Local upstream required");
    const projectId = "30000000-0000-4000-8000-000000000001";
    const policy = (revision: number) => ({ projectId, key: "reporting", revision, freshnessWindowSeconds: 3600, timeZone: "UTC",
      requiredFacts: [{ factType: "project.status", label: "Status" }], responsibleSubject: "synthetic-owner", scheduledScanEnabled: false,
      reminderBusinessDayOffsets: [], escalationAfterBusinessDays: 0, escalationRecipientSubject: null,
      quietHoursStartLocal: null, quietHoursEndLocal: null, changedBy: "synthetic-actor", changedAt: "2026-10-20T00:00:00.000Z" });
    const facts = (name: string) => ({ canAppend: true, canConfigure: false,
      facts: [{ factId: "40000000-0000-4000-8000-000000000001", factType: name, revision: 1 }], next: null });
    let phase = 0, detailReads = 0, identityReads = 0, reassessmentReads = 0, policyReads = 0, factReads = 0, saveRequests = 0, logins = 0, savedBody: Record<string, unknown> | undefined;
    const fastReads = { identity: 0, detail: 0, reassessment: 0, wrongRequest: false };
    let projectHold: ServerResponse | undefined, policyHold: ServerResponse | undefined, factHold: ServerResponse | undefined;
    let projectArrived!: () => void, policyArrived!: () => void, factArrived!: () => void;
    const projectEntered = new Promise<void>((resolve) => { projectArrived = resolve; });
    const policyEntered = new Promise<void>((resolve) => { policyArrived = resolve; });
    const factEntered = new Promise<void>((resolve) => { factArrived = resolve; });
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
      const json = (code: number, value: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (phase === 3 && ["/api/me", `/api/projects/${projectId}`, `/api/projects/${projectId}/ingestion-reassessments`].includes(path)) {
        if (req.method !== "GET" || req.headers.authorization !== "Bearer synthetic-token") fastReads.wrongRequest = true;
        if (path === "/api/me") fastReads.identity++;
        else if (path === `/api/projects/${projectId}`) fastReads.detail++;
        else fastReads.reassessment++;
      }
      if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
      if (path === "/api/auth/development") { logins++; return json(200, { token: "synthetic-token" }); }
      if (path === "/api/me") { identityReads++; return json(200, { subject: logins > 1 ? "second-actor" : "synthetic-actor", customerId: "10000000-0000-4000-8000-000000000001", roles: ["pmo_admin"] }); }
      if (path === "/api/projects") return json(200, [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }]);
      if (path === `/api/projects/${projectId}`) {
        detailReads++;
        if (phase === 1 && !projectHold) { projectHold = res; projectArrived(); return; }
        return json(200, { id: projectId, code: "S", name: "Current project", description: "Fixture", reportedStatus: "UNKNOWN" });
      }
      if (path === `/api/projects/${projectId}/facts`) {
        factReads++;
        if (phase === 2 && !factHold) { factHold = res; res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "fresh-facts" }); res.flushHeaders(); factArrived(); return; }
        return json(200, facts(phase >= 2 ? "new.fact" : "old.fact"));
      }
      if (path === `/api/projects/${projectId}/facts/old.fact/history`) return json(200, {
        factId: "40000000-0000-4000-8000-000000000001", throughRevision: 1, entries: [], next: null,
      });
      if (path === `/api/projects/${projectId}/facts/old.fact/authority`) return json(200, { throughRevision: null, event: null });
      if (path === `/api/projects/${projectId}/project-update-policy`) {
        if (req.method === "POST") {
          saveRequests++;
          let body = ""; req.setEncoding("utf8"); req.on("data", (chunk: string) => { body += chunk; });
          req.on("end", () => { savedBody = JSON.parse(body) as Record<string, unknown>;
            const { expectedRevision, ...fields } = savedBody;
            json(200, { ...policy(Number(expectedRevision) + 1), ...fields,
              ...(malformed ? { projectId: "30000000-0000-4000-8000-000000000099" } : {}) }); });
          return;
        }
        policyReads++;
        if (phase === 2 && !policyHold) { policyHold = res; res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": "fresh-policy" }); res.flushHeaders(); policyArrived(); return; }
        return json(200, policy(phase >= 2 ? nextRevision : 1));
      }
      if (path === `/api/projects/${projectId}/project-update-assessments/latest`) return json(200, null);
      if (path === `/api/projects/${projectId}/ingestion-reassessments`) { reassessmentReads++; return json(200, { items: [], nextCursor: null }); }
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
          const state = window as unknown as { policyPosts?: number; factStarted?: boolean; factConsumed?: boolean;
            policyReader?: boolean; policyEof?: boolean; policyReleased?: boolean };
          if (new URL(url, location.href).pathname === `/api/projects/${id}/project-update-policy` && init?.method === "POST")
            state.policyPosts = (state.policyPosts ?? 0) + 1;
          const response = await original(input, init), marker = response.headers.get("x-synthetic-case");
          if (marker === "fresh-facts") {
            const json = response.json.bind(response);
            response.json = async () => { state.factStarted = true; const value = await json(); state.factConsumed = true; return value; };
          }
          if (marker === "fresh-policy" && response.body) {
            const stream = response.body, getReader = stream.getReader.bind(stream);
            stream.getReader = (() => {
              const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              state.policyReader = true;
              reader.read = async () => { const value = await read(); if (value.done) state.policyEof = true; return value; };
              reader.releaseLock = () => { release(); state.policyReleased = true; };
              return reader;
            }) as typeof stream.getReader;
          }
          return response;
        };
      }, projectId);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: /^Project manager / }).first().click();
      await page.getByRole("button", { name: /Synthetic project/ }).click();
      await expect(page.getByRole("heading", { name: "Current project", level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: /old\.fact/ })).toBeVisible();
      await page.getByRole("button", { name: /old\.fact/ }).click();
      const statementDraft = page.getByLabel("Original statement");
      await expect(statementDraft).toBeVisible(); await statementDraft.fill("Retained synthetic evidence draft");
      await page.getByText("Reporting policy · PMO administration").click();
      const draft = page.getByLabel("Freshness window (seconds)"); await expect(draft).toHaveValue("3600");
      await draft.fill("9876"); await expect.poll(() => detailReads).toBeGreaterThanOrEqual(2);
      expect(policyReads).toBeGreaterThan(0); expect(factReads).toBeGreaterThan(0);
      const form = page.locator(".project-updates form");
      await form.evaluate((element) => {
        const state = window as unknown as { oldPolicyForm: HTMLFormElement; attemptedSubmissions: number };
        state.oldPolicyForm = element as HTMLFormElement; state.attemptedSubmissions = 0;
        element.addEventListener("submit", () => { state.attemptedSubmissions++; });
      });
      phase = 1; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([projectEntered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Project check did not start")), 15000); })]); }
      finally { if (timer !== undefined) clearTimeout(timer); }
      await expect(page.getByRole("button", { name: /old\.fact/ })).toBeHidden();
      await expect(statementDraft).toBeHidden();
      const calibrated = await page.evaluate(async () => {
        const state = window as unknown as { oldVisible: boolean; observer: MutationObserver };
        state.oldVisible = false;
        const visibleOld = () => [...document.querySelectorAll("button")].some((button) =>
          button.textContent?.includes("old.fact") && button.getClientRects().length > 0 && getComputedStyle(button).visibility !== "hidden");
        state.observer = new MutationObserver(() => { if (visibleOld()) state.oldVisible = true; });
        state.observer.observe(document.body, { childList: true, characterData: true, attributes: true, subtree: true });
        const marker = document.createElement("button"); marker.textContent = "old.fact"; document.body.append(marker);
        await Promise.resolve(); const observed = state.oldVisible; marker.remove(); await Promise.resolve(); state.oldVisible = false; return observed;
      });
      expect(calibrated).toBe(true);
      phase = 2; projectHold!.writeHead(transient ? 503 : 200, { "Content-Type": "application/json" });
      projectHold!.end(JSON.stringify(transient ? { message: "Synthetic temporary failure" }
        : { id: projectId, code: "S", name: "Current project", description: "Fixture", reportedStatus: "UNKNOWN" }));
      if (transient) {
        await expect(page.getByRole("button", { name: "Retry access checks" })).toBeVisible();
        await page.getByRole("button", { name: "Retry access checks" }).click();
      }
      let freshTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([policyEntered, factEntered]), new Promise<never>((_resolve, reject) => { freshTimer = setTimeout(() => reject(new Error("Fresh evidence checks did not start")), 15000); })]); }
      finally { if (freshTimer !== undefined) clearTimeout(freshTimer); }
      await expect(page.getByRole("heading", { name: "Current project", level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: /old\.fact/ })).toHaveCount(0);
      await expect(draft).toBeHidden();
      await expect.poll(() => page.evaluate(() => {
        const state = window as unknown as { policyReader?: boolean; factStarted?: boolean }; return Boolean(state.policyReader && state.factStarted);
      })).toBe(true);
      const postsBeforeBlocked = await page.evaluate(() => (window as unknown as { policyPosts?: number }).policyPosts ?? 0);
      const attempted = await page.evaluate(() => {
        const state = window as unknown as { oldPolicyForm: HTMLFormElement; attemptedSubmissions: number };
        const connected = state.oldPolicyForm.isConnected; state.oldPolicyForm.requestSubmit();
        return { connected, events: state.attemptedSubmissions };
      });
      expect(attempted).toEqual({ connected: true, events: 1 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => (window as unknown as { policyPosts?: number }).policyPosts ?? 0)).toBe(postsBeforeBlocked);
      expect(await page.evaluate(() => (window as unknown as { oldVisible: boolean }).oldVisible)).toBe(false);
      expect(savedBody).toBeUndefined();
      factHold!.end(JSON.stringify(facts("new.fact"))); policyHold!.end(JSON.stringify(policy(nextRevision)));
      await expect.poll(() => page.evaluate(() => {
        const state = window as unknown as { policyEof?: boolean; policyReleased?: boolean; factConsumed?: boolean };
        return Boolean(state.policyEof && state.policyReleased && state.factConsumed);
      })).toBe(true);
      await expect(page.getByRole("button", { name: /new\.fact/ })).toBeVisible();
      await expect(draft).toHaveValue("9876");
      await expect(statementDraft).toBeVisible();
      await expect(statementDraft).toHaveValue("Retained synthetic evidence draft");
      if (nextRevision === 1 && !malformed && !transient) {
        const priorIdentityReads = identityReads, priorDetailReads = detailReads;
        phase = 3;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => fastReads.identity).toBeGreaterThan(0);
        await expect.poll(() => fastReads.detail).toBeGreaterThan(0);
        expect(identityReads).toBeGreaterThan(priorIdentityReads); expect(detailReads).toBeGreaterThan(priorDetailReads);
        await expect(page.getByRole("button", { name: /new\.fact/ })).toBeVisible();
        await page.getByRole("button", { name: "Load reassessment status" }).click();
        await expect(page.getByText("No reassessment work was visible to your account on this page.")).toBeVisible();
        expect(reassessmentReads).toBe(1); expect(fastReads.reassessment).toBe(1);
        expect(fastReads.wrongRequest).toBe(false); expect(logins).toBe(1);
      }
      if (nextRevision === 2) {
        await expect(page.getByText("The saved reporting policy changed.", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "Save policy revision" })).toBeDisabled();
        await page.getByRole("button", { name: "Discard draft and use current policy" }).click();
        await expect(draft).toHaveValue("3600"); await draft.fill("7777");
      }
      const submitResult = await form.evaluate((element) => {
        const state = window as unknown as { attemptedSubmissions: number; policyPosts?: number };
        const formElement = element as HTMLFormElement, beforeEvents = state.attemptedSubmissions, beforePosts = state.policyPosts ?? 0;
        formElement.requestSubmit(); formElement.requestSubmit();
        return { events: state.attemptedSubmissions - beforeEvents, posts: (state.policyPosts ?? 0) - beforePosts };
      });
      expect(submitResult).toEqual({ events: 2, posts: 1 });
      await expect.poll(() => savedBody?.expectedRevision).toBe(nextRevision);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(savedBody?.freshnessWindowSeconds).toBe(nextRevision === 1 ? 9876 : 7777);
      expect(saveRequests).toBe(1);
      if (malformed) {
        await expect(page.getByText("The earlier policy save could not be confirmed.", { exact: false })).toBeVisible();
        await expect(draft).toHaveValue("9876");
        await expect(page.getByRole("button", { name: "Save policy revision" })).toBeDisabled();
        await page.getByRole("button", { name: "Sign out" }).click();
        await page.getByRole("button", { name: /^Project manager / }).first().click();
        await expect(page.getByText("second-actor", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: /Synthetic project/ }).click();
        await page.getByText("Reporting policy · PMO administration").click();
        await expect(page.getByText("The earlier policy save could not be confirmed.", { exact: false })).toBeVisible();
        await expect(page.getByRole("button", { name: "Save policy revision" })).toBeDisabled();
        expect(saveRequests).toBe(1);
      } else {
        await expect(page.getByText("Reporting policy saved as an immutable revision.")).toBeVisible();
      }
    } finally {
      try { for (const held of [projectHold, policyHold, factHold]) if (held && !held.writableEnded && !held.destroyed) held.end(); }
      finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
    }
  });
}
