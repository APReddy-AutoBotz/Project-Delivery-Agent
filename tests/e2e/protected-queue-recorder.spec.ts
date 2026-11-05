import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { createServer, request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { createDisclosureCheck, observeBrowserDisclosure } from "../../scripts/acceptance/disclosure.mjs";

test.use({ trace: "off", screenshot: "off", video: "off" });

// Separate from held-header UI tests: the recorder pauses each original body.
// Synthetic loopback only; this does not mount the product application.
async function recordQueue(browser: Browser, injectCanary: boolean) {
  const upstream = new URL(String(test.info().project.use.baseURL));
  if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(upstream.hostname)) throw new Error("Synthetic upstream must be local HTTP");
  const canary = randomBytes(32).toString("base64url"), tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  const payload = injectCanary ? JSON.stringify({ message: canary }) : JSON.stringify({ rankPolicyRevision: "pm-review-order@1",
    coverage: { schedule: "AVAILABLE", updateInformation: "AVAILABLE_OR_UNCONFIGURED", approvals: "UNAVAILABLE",
      blockerAge: "AVAILABLE_OR_UNASSESSABLE", otherCategories: "UNAVAILABLE" }, projects: [], items: [] });
  let reads = 0, correctAuth = true;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
    if (path === tokenPath) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") })); return;
    }
    if (path === "/api/pm/action-queue") {
      reads++; correctAuth &&= req.method === "GET" && req.headers.authorization === "Bearer synthetic-fixture-token";
      res.writeHead(injectCanary ? 403 : 200, { "Content-Type": "application/json", "x-synthetic-case": "queue-original" });
      res.end(payload); return;
    }
    const proxy = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
      headers: { ...req.headers, host: upstream.host } }, (response) => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res); });
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(proxy);
  });
  await new Promise<void>((resolve, reject) => { const fail = (error: Error) => reject(error); server.once("error", fail);
    server.listen(0, "127.0.0.1", () => { server.off("error", fail); resolve(); }); });
  let context: BrowserContext | undefined, closeCapture: (() => Promise<void>) | undefined;
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`; context = await browser.newContext();
    const ids = new Set<string>(), bodies = new Map<string, string>(), continued = new Set<string>();
    const originalSession = context.newCDPSession.bind(context);
    context.newCDPSession = async (target) => {
      const session = await originalSession(target);
      session.on("Fetch.requestPaused", (event) => {
        if (event.responseHeaders?.some((header) => header.name.toLowerCase() === "x-synthetic-case" && header.value === "queue-original")) ids.add(event.requestId);
      });
      const originalSend = session.send.bind(session);
      session.send = (async (method: string, params?: { requestId?: string }) => {
        const result = await originalSend(method as Parameters<typeof originalSend>[0], params);
        if (params?.requestId && ids.has(params.requestId) && method === "Fetch.getResponseBody") {
          const body = result as { body: string; base64Encoded: boolean };
          bodies.set(params.requestId, Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8").toString("utf8"));
        }
        if (params?.requestId && ids.has(params.requestId) && method === "Fetch.continueRequest") continued.add(params.requestId);
        return result;
      }) as typeof session.send;
      return session;
    };
    const disclosure = createDisclosureCheck([canary]), capture = await observeBrowserDisclosure(context, origin, disclosure);
    closeCapture = () => capture.close();
    const page = await capture.newPage();
    await page.goto(`${origin}/test-fixtures/protected-queue-transport.html`);
    await page.evaluate(async (path: string) => { await fetch(path, { method: "POST" }); }, tokenPath); await capture.settle(page);
    await page.getByRole("button", { name: "Load queue" }).click();
    await expect(page.locator("#state")).toHaveText(injectCanary ? "unavailable" : "ready");
    if (injectCanary) expect(await page.evaluate((value: string) => document.body.textContent?.includes(value) ?? false, canary)).toBe(false);
    await capture(page); await capture.close(); closeCapture = undefined;
    expect(reads).toBe(1); expect(correctAuth).toBe(true); expect(ids.size).toBe(1);
    const [id] = [...ids]; expect(bodies.get(id!) === payload).toBe(true); expect(continued.has(id!)).toBe(true);
    if (injectCanary) expect(() => disclosure.verify(["browser-response-bodies"])).toThrow("Secret disclosure detected");
    else expect(disclosure.verify(["browser-response-bodies"])["browser-response-bodies"].captures).toBeGreaterThan(0);
  } finally {
    try { if (closeCapture) await closeCapture().catch(() => {}); }
    finally { try { await context?.close(); } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } }
  }
}

test("queue fixture captures and continues its original 200 body", async ({ browser }) => {
  test.setTimeout(90000); await recordQueue(browser, false);
});
test("queue fixture recorder detects a canary in the original 403 body", async ({ browser }) => {
  test.setTimeout(90000); await recordQueue(browser, true);
});
