import { expect, test } from "@playwright/test";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = { id: id(1), code: "REASSESS", name: "Synthetic reassessment project", description: "Synthetic", reportedStatus: "UNKNOWN" };
const customerId = "10000000-0000-4000-8000-000000000001", time = "2026-10-21T11:00:00.000Z";
function row(n: number) {
  return { id: id(n), sourceId: id(700), receiptId: id(701), projectId: project.id, configRevision: 1, mappingRevision: 1,
    state: "READY", reason: "QUEUED", attemptCount: 0, totalAttempts: 1, recoveryRevision: 0,
    createdAt: time, availableAt: time, completedAt: null, assessmentId: null, obligationId: null, previewId: null };
}

test("PMO explicitly pages without putting the cursor in the URL and rejects same-task stale actions", async ({ page }) => {
  let firstReads = 0, pageReads = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) {
      firstReads++; const items = Array.from({ length: 25 }, (_, index) => row(index + 100));
      return route.fulfill({ json: { items, nextCursor: items[24]!.id } });
    }
    if (path === `/projects/${project.id}/ingestion-reassessment-pages`) {
      pageReads++; expect(url.search).toBe(""); expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({ cursor: id(124) });
      return route.fulfill({ json: { items: [{ ...row(125), state: "COMPLETED", reason: "COMPLETED" }], nextCursor: null } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel.getByRole("button", { name: "Next page" })).toBeVisible();
  await panel.getByRole("button", { name: "Next page" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(panel).toContainText("COMPLETED"); await expect(panel).not.toContainText("READY");
  await panel.getByRole("button", { name: "First page" }).click();
  await expect(panel.getByRole("button", { name: "Next page" })).toBeVisible();
  expect(firstReads).toBe(2); expect(pageReads).toBe(1); await expect(panel).not.toContainText(id(124));
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const next = buttons.find((button) => button.textContent?.trim() === "Next page")!;
    const projects = buttons.find((button) => button.textContent?.trim().endsWith("Projects"))!;
    projects.click(); next.click();
  });
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  expect(pageReads).toBe(1);
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel.getByRole("button", { name: "Next page" })).toBeVisible(); expect(firstReads).toBe(3);
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const next = buttons.find((button) => button.textContent?.trim() === "Next page")!;
    const signout = buttons.find((button) => button.textContent?.trim() === "Sign out")!;
    signout.click(); next.click();
  });
  await expect(page.getByRole("button", { name: /^PMO administrator/ })).toBeVisible();
  expect(pageReads).toBe(1);
});

test("a denied next page clears the prior page before draining without aborting its response", async ({ page }) => {
  let firstReads = 0;
  await page.addInitScript(() => {
    const original = window.fetch;
    const state = window as Window & { releaseDenied?: () => void; deniedState?: () => number[] };
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined, signal = 0, aborted = 0, chunks = 0, eof = 0, released = 0;
    state.deniedState = () => [stream ? 1 : 0, signal, aborted, chunks, eof, released];
    state.releaseDenied = () => { if (stream) { stream.enqueue(new TextEncoder().encode("{}")); stream.close(); stream = undefined; } };
    window.fetch = (input, init) => {
      if (String(input).endsWith("/ingestion-reassessment-pages")) {
        if (init?.signal) { signal++; init.signal.addEventListener("abort", () => { aborted++; }); }
        const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
        const getReader = body.getReader.bind(body);
        Object.defineProperty(body, "getReader", { value: () => {
          const reader = getReader(), read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
          reader.read = async () => { const value = await read(); if (value.done) eof++; else chunks++; return value; };
          reader.releaseLock = () => { released++; release(); }; return reader;
        } });
        return Promise.resolve(new Response(body, { status: 403 }));
      }
      return original(input, init);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) {
      firstReads++;
      const items = Array.from({ length: 25 }, (_, index) => row(index + 100));
      return route.fulfill({ json: { items, nextCursor: items[24]!.id } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  try {
    await panel.getByRole("button", { name: "Next page" }).click();
    await expect(panel).toContainText("Reassessment status is unavailable"); await expect(panel).not.toContainText("READY");
    expect(await page.evaluate(() => (window as Window & { deniedState: () => number[] }).deniedState())).toEqual([1, 1, 0, 0, 0, 0]);
    await panel.getByRole("button", { name: "Load reassessment status" }).click(); expect(firstReads).toBe(1);
    await page.evaluate(() => (window as Window & { releaseDenied: () => void }).releaseDenied());
    await expect.poll(() => page.evaluate(() => (window as Window & { deniedState: () => number[] }).deniedState())).toEqual([0, 1, 0, 1, 1, 1]);
    await panel.getByRole("button", { name: "Load reassessment status" }).click();
    await expect(panel.getByRole("button", { name: "Next page" })).toBeVisible(); expect(firstReads).toBe(2);
  } finally { await page.evaluate(() => (window as Window & { releaseDenied?: () => void }).releaseDenied?.()).catch(() => {}); }
});

test("a late next page cannot populate a newly selected project", async ({ page }) => {
  const second = { ...project, id: id(2), name: "Other synthetic project" };
  await page.addInitScript((staleRow) => {
    const original = window.fetch;
    const state = window as Window & { releaseNext?: () => void; nextPending?: () => boolean;
      nextState?: () => number[]; probeCanary?: () => Promise<boolean> };
    let release: (() => void) | undefined, eof = 0, released = 0, canaryHits = 0;
    state.nextPending = () => Boolean(release);
    state.nextState = () => [eof, released, canaryHits];
    state.probeCanary = async () => {
      const observer = new MutationObserver((records) => {
        if (records.some((record) => record.target.textContent?.includes("987654321") || record.oldValue?.includes("987654321") ||
          [...record.addedNodes, ...record.removedNodes].some((node) => node.textContent?.includes("987654321")))) canaryHits++;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      const marker = document.createElement("span"); marker.textContent = "987654321"; document.body.append(marker);
      marker.textContent = ""; marker.remove(); await Promise.resolve(); const worked = canaryHits > 0; canaryHits = 0; return worked;
    };
    state.releaseNext = () => release?.();
    window.fetch = (input, init) => {
      if (!String(input).endsWith("/ingestion-reassessment-pages")) return original(input, init);
      return new Promise<Response>((resolve) => {
        release = () => {
          release = undefined;
          const bytes = new TextEncoder().encode(JSON.stringify({ items: [staleRow], nextCursor: null }));
          const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
          const getReader = body.getReader.bind(body);
          Object.defineProperty(body, "getReader", { value: () => {
            const reader = getReader(), read = reader.read.bind(reader), releaseLock = reader.releaseLock.bind(reader);
            reader.read = async () => { const value = await read(); if (value.done) eof++; return value; };
            reader.releaseLock = () => { released++; releaseLock(); }; return reader;
          } });
          resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
        };
      });
    };
  }, { ...row(125), totalAttempts: 987654321 });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project, second] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${second.id}`) return route.fulfill({ json: second });
    if (path === `/projects/${project.id}/ingestion-reassessments`) {
      const items = Array.from({ length: 25 }, (_, index) => row(index + 100));
      return route.fulfill({ json: { items, nextCursor: items[24]!.id } });
    }
    if (path === `/projects/${second.id}/ingestion-reassessments`) return route.fulfill({ json: { items: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  let panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  try {
    await panel.getByRole("button", { name: "Next page" }).click();
    await expect.poll(() => page.evaluate(() => (window as Window & { nextPending: () => boolean }).nextPending())).toBe(true);
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: /Other synthetic project/ }).click();
    panel = page.getByRole("region", { name: "Ingestion reassessment status" });
    await panel.getByRole("button", { name: "Load reassessment status" }).click();
    await expect(panel).toContainText("Reassessment status is unavailable");
    expect(await page.evaluate(() => (window as Window & { probeCanary: () => Promise<boolean> }).probeCanary())).toBe(true);
    await page.evaluate(() => (window as Window & { releaseNext: () => void }).releaseNext());
    await expect.poll(() => page.evaluate(() => (window as Window & { nextState: () => number[] }).nextState())).toEqual([1, 1, 0]);
    await panel.getByRole("button", { name: "Load reassessment status" }).click();
    await expect(panel).toContainText("No reassessment work was visible to your account on this page.");
    expect(await page.evaluate(() => (window as Window & { nextState: () => number[] }).nextState())).toEqual([1, 1, 0]);
  } finally { await page.evaluate(() => (window as Window & { releaseNext?: () => void }).releaseNext?.()).catch(() => {}); }
});

test("PMO first-page status is explicit, bounded, scoped and expires", async ({ page }) => {
  let persona = "", reads = 0, writes = 0, state: "full" | "empty" | "invalid" | "error" | "oversize" = "full";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (route.request().method() !== "GET" && !path.startsWith("/auth/")) writes++;
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") { persona = route.request().postDataJSON().persona; return route.fulfill({ json: { token: "synthetic-same-token" } }); }
    if (path === "/me") return route.fulfill({ json: { subject: persona, customerId, roles: persona === "pmo-portfolio" ? ["pmo_admin"] : ["leadership"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) {
      reads++; expect(new URL(route.request().url()).search).toBe("");
      if (state === "empty") return route.fulfill({ json: { items: [], nextCursor: null } });
      if (state === "error") return route.fulfill({ status: 503, json: { message: "private-canary" } });
      if (state === "oversize") return route.fulfill({ body: `{"private":"${"x".repeat(70000)}"}`, contentType: "application/json" });
      if (state === "invalid") return route.fulfill({ json: { items: [{ ...row(100), private: "private-canary" }], nextCursor: null } });
      const items = Array.from({ length: 25 }, (_, index) => row(index + 100));
      return route.fulfill({ json: { items, nextCursor: items[24]!.id } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.clock.install(); await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await expect(panel).toContainText("Load this page"); expect(reads).toBe(0);
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("More work was indicated by this read"); expect(reads).toBe(1);
  await expect(panel).not.toContainText(id(100)); await expect(panel).not.toContainText(id(700));
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect(panel).toContainText("Load this page");
  expect(reads).toBe(1); await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("More work was indicated by this read");
  await page.clock.fastForward(30001); await expect(panel).toContainText("Load this page");
  state = "empty"; await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("No reassessment work was visible to your account on this page.");
  state = "error"; await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); await expect(panel).not.toContainText("No reassessment work was visible");
  state = "invalid"; await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); await expect(panel).not.toContainText("private-canary");
  state = "oversize"; await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); await expect(panel).not.toContainText("x".repeat(100));
  await page.getByRole("button", { name: "Sign out" }).click(); await page.getByRole("button", { name: /^Leadership / }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  await expect(panel).toHaveCount(0); expect(reads).toBe(6); expect(writes).toBe(0);
});

test("a stalled denial clears displayed work before its body ends and prevents overlapping reads", async ({ page }) => {
  let reads = 0;
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).endsWith("/ingestion-reassessments") && (window as Window & { denyStatus?: boolean }).denyStatus)
        return Promise.resolve(new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }), { status: 403 }));
      return original(input, init);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) { reads++; return route.fulfill({ json: { items: [row(100)], nextCursor: null } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click(); await expect(panel).toContainText("READY");
  await page.evaluate(() => { (window as Window & { denyStatus: boolean }).denyStatus = true; });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); await expect(panel).not.toContainText("READY");
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); expect(reads).toBe(1);
});

for (const oldStatus of [200, 401, 404]) test(`a delayed old-session ${oldStatus} is withheld until its lease settles`, async ({ page }) => {
  let reads = 0;
  await page.addInitScript((status) => {
    const original = window.fetch; let release: ((value: Response) => void) | undefined, held = true, delivered = 0;
    const state = window as Window & { previewCounts?: () => number[]; releasePreview?: () => void };
    state.previewCounts = () => [release ? 1 : 0, delivered];
    state.releasePreview = () => { held = false; delivered++; release?.(new Response(JSON.stringify({ items: [], nextCursor: null }), { status })); };
    window.fetch = (input, init) => String(input).endsWith("/ingestion-reassessments") && held
      ? new Promise<Response>((resolve) => { release = resolve; }) : original(input, init);
  }, oldStatus);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "same-synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) { reads++; return route.fulfill({ json: { items: [row(100)], nextCursor: null } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { previewCounts: () => number[] }).previewCounts()[0])).toBe(1);
  await page.getByRole("button", { name: "Sign out" }).click(); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); expect(reads).toBe(0);
  await page.evaluate(() => (window as Window & { releasePreview: () => void }).releasePreview());
  await expect.poll(() => page.evaluate(() => (window as Window & { previewCounts: () => number[] }).previewCounts()[1])).toBe(1);
  await page.waitForTimeout(100); await expect(panel).not.toContainText("No reassessment work was visible");
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("READY"); expect(reads).toBe(1);
});

test("a current 401 clears the panel and returns to sign-in", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) return route.fulfill({ status: 401, json: { message: "private-expiry" } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(page.getByRole("button", { name: /^PMO administrator/ })).toBeVisible();
  await expect(panel).toHaveCount(0); await expect(page.getByText("private-expiry")).toHaveCount(0);
});

test("a stalled successful response times out without allowing overlapping reads", async ({ page }) => {
  let reads = 0;
  await page.addInitScript(() => {
    const original = window.fetch; let held = true, registered = 0;
    const state = window as Window & { releaseStatusBody?: () => void; statusBodyRegistered?: () => number };
    state.statusBodyRegistered = () => registered;
    window.fetch = (input, init) => {
      if (!String(input).endsWith("/ingestion-reassessments") || !held) return original(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        registered++; state.releaseStatusBody = () => { held = false;
          controller.enqueue(new TextEncoder().encode('{"items":[],"nextCursor":null}')); controller.close(); };
      } }), { status: 200 }));
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${project.id}/ingestion-reassessments`) { reads++; return route.fulfill({ json: { items: [row(100)], nextCursor: null } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.clock.install(); await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { statusBodyRegistered: () => number }).statusBodyRegistered())).toBe(1);
  await page.clock.fastForward(15001); await expect(panel).toContainText("Reassessment status is unavailable");
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("Reassessment status is unavailable"); expect(reads).toBe(0);
  await page.evaluate(() => (window as Window & { releaseStatusBody: () => void }).releaseStatusBody());
  await page.waitForTimeout(100); await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("READY"); expect(reads).toBe(1);
});

test("switching projects clears the previous status and requires a fresh load", async ({ page }) => {
  const second = { ...project, id: id(2), code: "SECOND", name: "Second synthetic project" }; let reads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/auth/development") return route.fulfill({ json: { token: "synthetic-token" } });
    if (path === "/me") return route.fulfill({ json: { subject: "pmo-portfolio", customerId, roles: ["pmo_admin"] } });
    if (path === "/projects") return route.fulfill({ json: [project, second] });
    if (path === `/projects/${project.id}`) return route.fulfill({ json: project });
    if (path === `/projects/${second.id}`) return route.fulfill({ json: second });
    if (path === `/projects/${project.id}/ingestion-reassessments`) { reads++; return route.fulfill({ json: { items: [row(100)], nextCursor: null } }); }
    if (path === `/projects/${second.id}/ingestion-reassessments`) { reads++; return route.fulfill({ json: { items: [], nextCursor: null } }); }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/"); await page.getByRole("button", { name: /^PMO administrator/ }).click();
  await page.getByRole("button", { name: /Synthetic reassessment project/ }).click();
  const panel = page.getByRole("region", { name: "Ingestion reassessment status" });
  await panel.getByRole("button", { name: "Load reassessment status" }).click(); await expect(panel).toContainText("READY");
  await page.getByRole("button", { name: "← All projects" }).click(); await page.getByRole("button", { name: /Second synthetic project/ }).click();
  await expect(panel).toContainText("Load this page"); await expect(panel).not.toContainText("READY"); expect(reads).toBe(1);
  await panel.getByRole("button", { name: "Load reassessment status" }).click();
  await expect(panel).toContainText("No reassessment work was visible"); expect(reads).toBe(2);
});
