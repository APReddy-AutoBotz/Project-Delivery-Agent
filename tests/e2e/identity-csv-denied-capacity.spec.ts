import { test, expect } from "@playwright/test";

test("exhausted denied receipt tickets send no retry until the view is reopened", async ({ page }) => {
  test.setTimeout(180000);
  const customerId = "10000000-0000-4000-8000-000000000001", projectId = "30000000-0000-4000-8000-000000000001", sourceId = "40000000-0000-4000-8000-000000000001", reviewId = "60000000-0000-4000-8000-000000000001";
  const source = { sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid", configRevision: 1, mappingRevision: 1,
    healthState: "UNKNOWN", healthCode: "NONE", healthCheckedAt: null,
    configuration: { binding: { customerId, sourceId, sourceType: "csv-upload", origin: "https://csv-upload.invalid" }, projects: [{ projectId, readers: ["actor-a"] }],
      mapping: { kind: "CSV", sheet: "Projects", identityColumn: "Issue ID", projectColumn: "Project ID", fields: [{ column: "Forecast", factType: "project.forecast", type: "date", required: true }] } } };
  let previews = 0; const receiptReads = new Map<string, number>(), reviewBodies: unknown[] = [], reviewMethods: string[] = [];
  let identityInFlight = 0, sourcesInFlight = 0;
  const receiptEvents = new Map<string, Array<{ method: string; status: number }>>();
  let denialGate: { id: string; arrived: boolean; finished: boolean; wait: Promise<void>; release: () => void } | undefined;
  let retryGate: { id: string; arrived: boolean; wait: Promise<void>; release: () => void } | undefined;
  let automaticGate: { id: string; arrived: boolean; wait: Promise<void>; release: () => void } | undefined;
  const receipt = (id: string, parent: string | null) => ({ receipt: { id, sourceId, actor: "actor-a", kind: parent ? "CSV_REVIEWED_IMPORT" : "CSV_PREVIEW",
    eventId: null, configRevision: 1, mappingRevision: 1, cursorRevisionBefore: null, cursorRevisionAfter: null, generationBefore: null, generationAfter: null,
    rowCount: 1, createdAt: "2026-09-06T00:00:00.000Z", parentPreviewReceiptId: parent }, outcomes: [{ ordinal: 1, parentOrdinal: parent ? 1 : null,
      state: "ACCEPTED", operation: "CREATE", errorCodes: [], projectId, identity: ["csv-row", "one"], contentAvailable: true,
      proposals: [{ factType: "project.forecast", value: { type: "date", value: "2026-01-01" } }] }] });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const state = window as Window & { capacityObserved?: boolean; previewChangedAfterCapacity?: boolean };
    new MutationObserver(() => {
      const text = document.body?.textContent ?? "";
      if (text.includes("Receipt access is at capacity. Reopen Data imports to try again.")) state.capacityObserved = true;
      if (state.capacityObserved && text.includes("The preview changed. Review and select the proposals again.")) state.previewChangedAfterCapacity = true;
    }).observe(document, { subtree: true, childList: true, characterData: true });
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const retry = response.headers.get("x-synthetic-retry-parent") === "yes";
      const automatic = response.headers.get("x-synthetic-automatic-parent") === "yes";
      if ((!retry && !automatic) || !response.body) return response;
      const getReader = response.body.getReader.bind(response.body);
      response.body.getReader = (() => {
        const reader = getReader(), read = reader.read.bind(reader), releaseLock = reader.releaseLock.bind(reader);
        reader.read = async () => { const result = await read();
          if (result.done) { if (retry) (window as Window & { retryParentEof?: boolean }).retryParentEof = true;
            else (window as Window & { automaticParentEof?: boolean }).automaticParentEof = true; }
          return result; };
        reader.releaseLock = () => { releaseLock(); if (retry) (window as Window & { retryParentReleased?: boolean }).retryParentReleased = true;
          else (window as Window & { automaticParentReleased?: boolean }).automaticParentReleased = true; };
        return reader;
      }) as typeof response.body.getReader;
      return response;
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/config") return route.fulfill({ json: { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" } });
    if (path === "/api/auth/development") return route.fulfill({ json: { token: "csv-denied-capacity-token" } });
    if (path === "/api/me") { identityInFlight++; try { await route.fulfill({ json: { customerId, subject: "actor-a", roles: ["pmo_admin"] } }); }
      finally { identityInFlight--; } return; }
    if (path === "/api/projects") return route.fulfill({ json: [{ id: projectId, portfolioId: "30000000-0000-4000-8000-000000000050", code: "S", name: "Synthetic project", description: "Fixture", reportedStatus: "UNKNOWN" }] });
    if (path === "/api/project-setup") return route.fulfill({ json: { truncated: false, portfolios: [] } });
    if (path === "/api/ingestion/sources") { sourcesInFlight++; try { await route.fulfill({ json: [source] }); }
      finally { sourcesInFlight--; } return; }
    if (path.endsWith("/csv-previews")) { previews++; return route.fulfill({ status: 201, json: { receiptId: `50000000-0000-4000-8000-${previews.toString(16).padStart(12, "0")}`, replayed: false, rowCount: 1 } }); }
    if (path.endsWith("/reviewed-imports")) { reviewMethods.push(route.request().method()); const body = route.request().postDataJSON() as { previewReceiptId: string }; reviewBodies.push(body);
      return reviewBodies.length === 1 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 201, json: { receiptId: reviewId, parentPreviewReceiptId: body.previewReceiptId, replayed: true, rowCount: 1 } }); }
    const match = /\/receipts\/([^/]+)$/.exec(path);
    if (match) {
      const id = match[1]!; if (id === reviewId) return route.fulfill({ json: receipt(id, `50000000-0000-4000-8000-${(64).toString(16).padStart(12, "0")}`) });
      const count = (receiptReads.get(id) ?? 0) + 1; receiptReads.set(id, count);
      const status = count === 2 ? 403 : 200;
      if (count === 2) {
        if (!denialGate || denialGate.id !== id) throw new Error("Unexpected receipt denial");
        const gate = denialGate; gate.arrived = true; await gate.wait;
        await route.fulfill({ status, json: {} }); gate.finished = true;
      } else if (count === 3 && retryGate?.id === id) {
        const gate = retryGate; gate.arrived = true; await gate.wait;
        await route.fulfill({ status, headers: { "x-synthetic-retry-parent": "yes" }, json: receipt(id, null) });
      } else if (count === 4 && automaticGate?.id === id) {
        const gate = automaticGate; gate.arrived = true; await gate.wait;
        await route.fulfill({ status, headers: { "x-synthetic-automatic-parent": "yes" }, json: receipt(id, null) });
      } else await route.fulfill({ status, json: receipt(id, null) });
      const events = receiptEvents.get(id) ?? []; events.push({ method: route.request().method(), status }); receiptEvents.set(id, events);
      return;
    }
    return route.fulfill({ status: 404, json: {} });
  });
  const file = { name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(`Issue ID,Project ID,Forecast\n1,${projectId},2026-01-01\n`) };
  await page.goto("/"); await page.getByRole("button", { name: "PMO administrator" }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
  try {
    for (let index = 1; index <= 64; index++) {
      const id = `50000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      await page.getByLabel("CSV file").setInputFiles(file);
      await expect(page.getByLabel("Select row 1")).toHaveCount(0);
      await page.getByRole("button", { name: "Upload and preview" }).click();
      await expect.poll(() => previews).toBe(index); await expect.poll(() => receiptEvents.get(id)?.length).toBe(1);
      expect(receiptEvents.get(id)).toEqual([{ method: "GET", status: 200 }]);
      await expect(page.getByLabel("Select row 1")).toBeVisible();
      await expect(page.getByRole("button", { name: "Upload and preview" })).toBeEnabled();
      if (index === 64) {
        await page.getByLabel("Select row 1").check(); await page.getByRole("button", { name: "Save 1 reviewed proposal" }).click();
        await expect(page.getByRole("button", { name: "Retry original reviewed selection" })).toBeEnabled(); expect(reviewBodies).toHaveLength(1);
      }
      let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
      denialGate = { id, arrived: false, finished: false, wait, release };
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect.poll(() => denialGate?.arrived).toBe(true); await expect(page.getByLabel("CSV file")).toBeVisible();
      denialGate.release(); await expect.poll(() => denialGate?.finished).toBe(true);
      await expect(page.getByRole("alert").filter({ hasText: "The receipt is unavailable." })).toBeVisible();
      await expect.poll(() => receiptEvents.get(id)?.length).toBe(2);
      expect(receiptEvents.get(id)).toEqual([{ method: "GET", status: 200 }, { method: "GET", status: 403 }]);
      denialGate = undefined;
    }
    const parent = `50000000-0000-4000-8000-${(64).toString(16).padStart(12, "0")}`;
    expect(receiptEvents.get(parent)).toEqual([{ method: "GET", status: 200 }, { method: "GET", status: 403 }]);
    await expect.poll(() => [identityInFlight, sourcesInFlight]).toEqual([0, 0]);
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
    retryGate = { id: parent, arrived: false, wait, release };
    let releaseAutomatic!: () => void; const waitAutomatic = new Promise<void>((resolve) => { releaseAutomatic = resolve; });
    automaticGate = { id: parent, arrived: false, wait: waitAutomatic, release: releaseAutomatic };
    try {
      await page.getByRole("button", { name: "Retry original reviewed selection" }).click();
      await expect.poll(() => retryGate?.arrived).toBe(true);
      await expect(page.getByLabel("CSV file")).toBeVisible();
      await expect.poll(() => [identityInFlight, sourcesInFlight]).toEqual([0, 0]);
      retryGate.release();
      await expect.poll(() => receiptEvents.get(parent)?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(receiptEvents.get(parent)?.slice(0, 3)).toEqual([{ method: "GET", status: 200 }, { method: "GET", status: 403 }, { method: "GET", status: 200 }]);
      await expect.poll(() => page.evaluate(() => Boolean((window as Window & { retryParentEof?: boolean; retryParentReleased?: boolean }).retryParentEof &&
        (window as Window & { retryParentReleased?: boolean }).retryParentReleased))).toBe(true);
      await expect(page.getByText("Receipt access is at capacity. Reopen Data imports to try again.")).toBeVisible();
      await expect.poll(() => automaticGate?.arrived).toBe(true);
      await expect(page.getByLabel("Select row 1")).toHaveCount(0);
      expect(reviewBodies).toHaveLength(1);
      expect(reviewMethods).toEqual(["POST"]);
      automaticGate.release();
      await expect.poll(() => page.evaluate(() => Boolean((window as Window & { automaticParentEof?: boolean; automaticParentReleased?: boolean }).automaticParentEof &&
        (window as Window & { automaticParentReleased?: boolean }).automaticParentReleased))).toBe(true);
      await expect(page.getByLabel("Select row 1")).toBeVisible();
      await expect(page.getByText("Receipt access is at capacity. Reopen Data imports to try again.")).toBeVisible();
      expect(await page.evaluate(() => Boolean((window as Window & { previewChangedAfterCapacity?: boolean }).previewChangedAfterCapacity))).toBe(false);
    }
    catch (error) {
      const flags = await page.evaluate(() => {
        const text = document.body.textContent ?? "";
        return { originalUnverified: text.includes("The original preview or review could not be verified."),
          activityChanged: text.includes("Import activity changed. Review the source and try again."),
          reviewUnconfirmed: text.includes("The reviewed import could not be confirmed. Retry the original selection."),
          capacityObserved: Boolean((window as Window & { capacityObserved?: boolean }).capacityObserved),
          previewChangedAfterCapacity: Boolean((window as Window & { previewChangedAfterCapacity?: boolean }).previewChangedAfterCapacity),
          eof: Boolean((window as Window & { retryParentEof?: boolean }).retryParentEof),
          released: Boolean((window as Window & { retryParentReleased?: boolean }).retryParentReleased) };
      }).catch(() => null);
      throw new Error(`Synthetic capacity result: ${JSON.stringify({ reviewPostCount: reviewBodies.length, identityInFlight, sourcesInFlight,
        parentArrived: Boolean(retryGate?.arrived), ...(flags ?? {}) })}`, { cause: error });
    }
    expect(reviewBodies).toHaveLength(1);
    await page.getByRole("button", { name: "Projects", exact: true }).click(); await page.getByRole("button", { name: /Data imports/ }).click();
    await page.getByRole("button", { name: "Retry original reviewed selection" }).click();
    await expect(page.getByText("Reviewed import receipt saved")).toBeVisible();
    expect(reviewBodies).toHaveLength(2); expect(reviewBodies[1]).toEqual(reviewBodies[0]); expect(reviewMethods).toEqual(["POST", "POST"]);
  } finally { denialGate?.release(); retryGate?.release(); automaticGate?.release(); }
});
