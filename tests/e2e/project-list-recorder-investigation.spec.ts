import { expect, test, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { createDisclosureCheck, observeBrowserDisclosure } from "../../scripts/acceptance/disclosure.mjs";

// Local synthetic response only; do not retain recorder values in artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function observeProjectList(browser: Browser, focus: boolean, injectCanary: boolean) {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Expected local HTTP upstream");
  const marker = randomBytes(24).toString("hex"), canary = randomBytes(32).toString("base64url");
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  const project = { id: "30000000-0000-4000-8000-000000000001", portfolioId: "30000000-0000-4000-8000-000000000050",
    code: "CASE", name: "Synthetic list project", description: injectCanary ? canary : "Fixture", reportedStatus: "UNKNOWN" };
  let reads = 0, held: ServerResponse | undefined, disconnected = false, arrived!: () => void;
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path === tokenPath) return json(200, { access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") });
    if (path === "/api/auth/config") return json(200, { mode: "development", dataMode: "synthetic", scope: "openid", resource: "" });
    if (path === "/api/auth/development") return json(200, { token: "synthetic-local-token" });
    if (path === "/api/me") return json(200, { subject: "synthetic-pm", customerId: "10000000-0000-4000-8000-000000000001", roles: ["project_manager"] });
    if (path === "/api/projects") {
      if (++reads === 1) {
        held = res; res.on("close", () => { if (!res.writableFinished) disconnected = true; });
        res.writeHead(200, { "Content-Type": "application/json", "x-synthetic-case": marker }); res.flushHeaders(); arrived(); return;
      }
      return json(200, [project]);
    }
    if (path.startsWith("/api/")) return json(404, { message: "Unavailable" });
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  let context: BrowserContext | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    context = await browser.newContext();
    const responseNetwork = new Set<string>(), pausedNetwork = new Set<string>(), fetchIds = new Set<string>();
    const failures = new Set<string>(), body = new Set<string>(), continued = new Set<string>();
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const session = await originalSession(target);
      session.on("Network.responseReceived", (event) => {
        if (Object.entries(event.response.headers).some(([name, value]) => name.toLowerCase() === "x-synthetic-case" && value === marker)) responseNetwork.add(event.requestId);
      });
      session.on("Network.loadingFailed", (event) => { failures.add(event.requestId); });
      session.on("Fetch.requestPaused", (event) => {
        if (event.responseHeaders?.some((header) => header.name.toLowerCase() === "x-synthetic-case" && header.value === marker)) {
          fetchIds.add(event.requestId); if (event.networkId) pausedNetwork.add(event.networkId);
        }
      });
      const send = session.send.bind(session);
      session.send = (async (method: string, params?: { requestId?: string }) => {
        const result = await send(method as Parameters<typeof send>[0], params);
        if (params?.requestId && fetchIds.has(params.requestId)) {
          if (method === "Fetch.getResponseBody") body.add(params.requestId);
          if (method === "Fetch.continueRequest") continued.add(params.requestId);
        }
        return result;
      }) as typeof session.send;
      await session.send("Network.enable"); return session;
    };
    await context.addInitScript((caseMarker) => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (response.headers.get("x-synthetic-case") === caseMarker && response.body) {
          const stream = response.body, getReader = stream.getReader.bind(stream);
          stream.getReader = (() => {
            const reader = getReader(), read = reader.read.bind(reader), cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
            const state = window as unknown as { listReader: { eof: boolean; canceled: boolean; released: boolean } };
            state.listReader = { eof: false, canceled: false, released: false };
            reader.read = async () => { const part = await read(); if (part.done) state.listReader.eof = true; return part; };
            reader.cancel = async (reason) => { state.listReader.canceled = true; return cancel(reason); };
            reader.releaseLock = () => { release(); state.listReader.released = true; };
            return reader;
          }) as typeof stream.getReader;
        }
        return response;
      };
    }, marker);
    const disclosure = createDisclosureCheck([canary]);
    const capture = await observeBrowserDisclosure(context, origin, disclosure);
    const page: Page = await capture.newPage();
    let markedRequest: Request | undefined;
    const failedRequests = new Set<Request>(), finishedRequests = new Set<Request>();
    page.on("response", (response) => { if (response.headers()["x-synthetic-case"] === marker) markedRequest = response.request(); });
    page.on("requestfailed", (request) => { failedRequests.add(request); });
    page.on("requestfinished", (request) => { finishedRequests.add(request); });
    await page.goto(origin); await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath); await capture.settle(page);
    await page.getByRole("button", { name: /^Project manager / }).first().click();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("List did not start")), 15000); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    // A second list read is observed; this does not explain the hosted cancellation.
    if (focus) { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => reads).toBeGreaterThanOrEqual(2); }
    expect(disconnected).toBe(false); held!.end(JSON.stringify([project]));
    await expect.poll(() => page.evaluate(() => (window as unknown as { listReader?: { eof: boolean; canceled: boolean; released: boolean } }).listReader ?? null))
      .toEqual({ eof: true, canceled: false, released: true });
    await capture(page); await capture.close();
    expect(markedRequest).toBeTruthy(); expect(failedRequests.has(markedRequest!)).toBe(false);
    expect(finishedRequests.has(markedRequest!)).toBe(true); expect(disconnected).toBe(false);
    expect(responseNetwork.size).toBe(1); expect(pausedNetwork.size).toBe(1);
    expect([...responseNetwork].every((id) => pausedNetwork.has(id))).toBe(true); expect(fetchIds.size).toBe(1);
    for (const id of responseNetwork) expect(failures.has(id)).toBe(false);
    for (const id of fetchIds) { expect(body.has(id)).toBe(true); expect(continued.has(id)).toBe(true); }
    if (injectCanary) expect(() => disclosure.verify(["browser-response-bodies"])).toThrow("Secret disclosure detected");
    else expect(disclosure.verify(["browser-response-bodies"])["browser-response-bodies"].captures).toBeGreaterThan(0);
  } finally {
    try { if (held && !held.writableEnded && !held.destroyed) held.end(); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
}

for (const [label, focus, canary] of [["normal", false, false], ["focus", true, false], ["canary", false, true]] as const) {
  test(`project list recorder investigation: ${label}`, async ({ browser }) => { test.setTimeout(90000); await observeProjectList(browser, focus, canary); });
}
