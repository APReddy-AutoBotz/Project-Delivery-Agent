import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { verifyIsolatedTlsRejection } from "../../scripts/acceptance/isolated-tls-probe.mjs";
import {
  createDisclosureCheck,
  observeBrowserDisclosure,
  afterDisclosureSettle,
  formatCaptureDiagnostic,
} from "../../scripts/acceptance/disclosure.mjs";

test("SEC-SECRET-001: Chromium teardown waits for a late original response continuation", async ({
  browser,
}) => {
  const canary = randomBytes(32).toString("base64url");
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let leak = false;
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === tokenPath
          ? {
              access_token: randomBytes(32).toString("base64url"),
              id_token: randomBytes(32).toString("base64url"),
            }
          : { value: request.url === "/late" && leak ? canary : "public" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback fixture unavailable");
  const base = "http://127.0.0.1:" + address.port;
  try {
    for (const inject of [false, true]) {
      leak = inject;
      const check = createDisclosureCheck([canary]);
      const context = await browser.newContext();
      const newSession = context.newCDPSession.bind(context);
      let release!: () => void;
      let started!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const continuationStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let lateId: string | undefined;
      let originalBody: string | undefined;
      context.newCDPSession = async (target) => {
        const session = await newSession(target);
        session.on("Fetch.requestPaused", (event) => {
          if (event.request.url === base + "/late") lateId = event.requestId;
        });
        const send = session.send.bind(session);
        session.send = (async (
          method: string,
          params?: { requestId?: string },
        ) => {
          if (
            method === "Fetch.continueRequest" &&
            params?.requestId === lateId &&
            lateId !== undefined
          ) {
            started();
            await held;
          }
          const result = await send(
            method as Parameters<typeof send>[0],
            params,
          );
          if (
            method === "Fetch.getResponseBody" &&
            params?.requestId === lateId &&
            lateId !== undefined
          ) {
            const body = result as { body: string; base64Encoded: boolean };
            originalBody = Buffer.from(
              body.body,
              body.base64Encoded ? "base64" : "utf8",
            ).toString("utf8");
          }
          return result;
        }) as typeof session.send;
        return session;
      };
      let closed = false;
      context.on("close", () => {
        closed = true;
      });
      try {
        const capture = await observeBrowserDisclosure(context, base, check);
        const page = await capture.newPage();
        await page.goto(base);
        await page.evaluate(async (path) => {
          await fetch(path, { method: "POST" });
        }, tokenPath);
        await capture(page);
        await page.evaluate(() => {
          void fetch("/late").catch(() => {});
        });
        await continuationStarted;
        expect(JSON.parse(originalBody!).value).toBe(
          inject ? canary : "public",
        );
        const completion = capture.close();
        void completion.catch(() => {});
        expect(closed).toBe(false);
        release();
        await completion;
        expect(closed).toBe(true);
        if (inject)
          expect(() => check.verify(["browser-response-bodies"])).toThrow(
            /^Secret disclosure detected$/,
          );
        else
          expect(
            check.verify(["browser-response-bodies"])["browser-response-bodies"]
              .captures,
          ).toBeGreaterThanOrEqual(2);
      } finally {
        release();
        await context.close();
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SEC-SECRET-001: an isolated rejected TLS probe leaves the recorded context strict", async ({ browser }) => {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-tls-probe-"));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  const canary = randomBytes(32).toString("base64url");
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let tlsServer: ReturnType<typeof createHttpsServer> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    execFileSync(process.env.PDAA_SYNTHETIC_OPENSSL ?? "openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=synthetic.invalid", "-addext", "subjectAltName=IP:127.0.0.1"],
      { stdio: "ignore", timeout: 20000 });
    tlsServer = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => response.end("unexpected"));
    await new Promise<void>((resolve) => tlsServer!.listen(0, "127.0.0.1", resolve));
    const tlsAddress = tlsServer.address();
    if (!tlsAddress || typeof tlsAddress === "string") throw new Error("TLS fixture unavailable");
    server = createServer((request, response) => {
      if (request.url === tokenPath) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") }));
      } else { response.writeHead(200, { "Content-Type": "text/html" }); response.end(`<h1>Fixture</h1><p>${canary}</p>`); }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
    const base = "http://127.0.0.1:" + address.port;
    const check = createDisclosureCheck([canary]);
    context = await browser.newContext();
    const capture = await observeBrowserDisclosure(context, base, check);
    const page = await capture.newPage();
    await page.goto(base);
    await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath);
    await capture(page);
    await verifyIsolatedTlsRejection(browser, `https://127.0.0.1:${tlsAddress.port}`, "ERR_CERT_AUTHORITY_INVALID");
    await capture(page);
    expect(() => check.verify(["browser-response-bodies"])).toThrow(/^Secret disclosure detected$/);
    const unexpected = await capture.newPage();
    await unexpected.close();
    await expect(capture(page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
    await expect(capture.close()).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  } finally {
    if (context) await context.close();
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    if (tlsServer) { tlsServer.closeAllConnections(); await new Promise<void>((resolve) => tlsServer!.close(() => resolve())); }
    if (dirname(realpathSync(directory)) !== realpathSync(tmpdir())) throw new Error("Unexpected TLS fixture directory");
    for (const file of [key, cert]) { try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    rmdirSync(directory);
  }
});

test("SEC-SECRET-001: Chromium continuation failures remain closed and diagnostics stay bounded", async ({ browser }) => {
  const canary = randomBytes(32).toString("base64url");
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end("<h1>Fixture</h1>");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(request.url === tokenPath
        ? { access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") }
        : { value: "public" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
  const base = "http://127.0.0.1:" + address.port;
  const context = await browser.newContext();
  const originalSession = context.newCDPSession.bind(context);
  let failed!: () => void;
  const failureRaised = new Promise<void>((resolve) => { failed = resolve; });
  let queueId: string | undefined;
  context.newCDPSession = async (target) => {
    const session = await originalSession(target);
    session.on("Fetch.requestPaused", (event) => { if (event.request.url === base + "/api/pm/action-queue") queueId = event.requestId; });
    const originalSend = session.send.bind(session);
    session.send = (async (method: string, params?: { requestId?: string }) => {
      if (method === "Fetch.continueRequest" && queueId !== undefined && params?.requestId === queueId) {
        failed(); throw new Error("Invalid InterceptionId " + canary + " " + base);
      }
      return originalSend(method as Parameters<typeof originalSend>[0], params);
    }) as typeof session.send;
    return session;
  };
  try {
    const check = createDisclosureCheck([canary]);
    const capture = await observeBrowserDisclosure(context, base, check);
    const page = await capture.newPage();
    await page.goto(base);
    await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath);
    await capture(page);
    await page.evaluate(() => { void fetch("/api/pm/action-queue").catch(() => {}); });
    await failureRaised;
    await expect(capture(page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
    const diagnostic = formatCaptureDiagnostic(capture.diagnostic());
    expect(JSON.parse(diagnostic).continuation).toEqual({ branch: "response", resource: "pm_queue", error: "invalid_interception", page: "open" });
    expect(diagnostic).not.toContain(canary);
    expect(diagnostic).not.toContain(base);
    await expect(capture.close()).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SEC-SECRET-001: Chromium close waits for a response held before headers", async ({ browser }) => {
  const canary = randomBytes(32).toString("base64url");
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let held: import("node:http").ServerResponse | undefined;
  let signal!: () => void;
  const requested = new Promise<void>((resolve) => { signal = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/late") { held = response; signal(); return; }
    if (request.url === tokenPath) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") }));
    } else { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<h1>Fixture</h1>"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
  const base = "http://127.0.0.1:" + address.port;
  const context = await browser.newContext();
  let closed = false; context.on("close", () => { closed = true; });
  try {
    const check = createDisclosureCheck([canary]);
    const capture = await observeBrowserDisclosure(context, base, check);
    const page = await capture.newPage();
    await page.goto(base);
    await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath);
    await capture(page);
    await page.evaluate(() => { void fetch("/late").catch(() => {}); });
    await requested;
    const closing = capture.close();
    expect(await Promise.race([closing.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 150))])).toBe("waiting");
    expect(closed).toBe(false);
    held!.writeHead(200, { "Content-Type": "application/json" });
    held!.end(JSON.stringify({ value: canary }));
    await closing;
    expect(closed).toBe(true);
    expect(() => check.verify(["browser-response-bodies"])).toThrow(/^Secret disclosure detected$/);
  } finally {
    held?.end(); await context.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SEC-SECRET-001: project interaction waits for a pending original response before unmount", async ({ browser }) => {
  const canary = randomBytes(32).toString("base64url");
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let pendingResponse: import("node:http").ServerResponse | undefined;
  let requestSeen!: () => void;
  const server = createServer((request, response) => {
    if (request.url === "/api/pm/action-queue") {
      pendingResponse = response; requestSeen();
    } else if (request.url === tokenPath) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ access_token: randomBytes(32).toString("base64url"), id_token: randomBytes(32).toString("base64url") }));
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<button id="project">Open project</button><button id="back">All projects</button><div id="view">List</div><script>
        let controller;
        window.startQueue = () => { controller = new AbortController(); fetch('/api/pm/action-queue', {signal: controller.signal}).catch(() => {}); };
        document.querySelector('#project').onclick = () => { controller.abort(); document.querySelector('#view').textContent = 'Project'; };
        document.querySelector('#back').onclick = () => { document.querySelector('#view').textContent = 'List'; window.startQueue(); };
      </script>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
  const base = "http://127.0.0.1:" + address.port;
  try {
    for (const leak of [false, true]) {
      pendingResponse = undefined;
      const check = createDisclosureCheck([canary]);
      const context = await browser.newContext();
      const originalSession = context.newCDPSession.bind(context);
      const queueIds: string[] = [];
      const queueBodies = new Map<string, string>();
      const continued = new Set<string>();
      const openings: Promise<unknown>[] = [];
      context.newCDPSession = async (target) => {
        const session = await originalSession(target);
        session.on("Fetch.requestPaused", (event) => {
          if (event.request.url === base + "/api/pm/action-queue" && !queueIds.includes(event.requestId)) queueIds.push(event.requestId);
        });
        const originalSend = session.send.bind(session);
        session.send = (async (method: string, params?: { requestId?: string }) => {
          const result = await originalSend(method as Parameters<typeof originalSend>[0], params);
          if (params?.requestId && queueIds.includes(params.requestId) && method === "Fetch.getResponseBody") {
            const body = result as { body: string; base64Encoded: boolean };
            queueBodies.set(params.requestId, Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8").toString("utf8"));
          }
          if (params?.requestId && queueIds.includes(params.requestId) && method === "Fetch.continueRequest") continued.add(params.requestId);
          return result;
        }) as typeof session.send;
        return session;
      };
      try {
        const capture = await observeBrowserDisclosure(context, base, check);
        const page = await capture.newPage();
        await page.goto(base);
        await page.evaluate(async (path) => { await fetch(path, { method: "POST" }); }, tokenPath);
        await capture(page);
        for (const navigation of [0, 1]) {
          pendingResponse = undefined;
          const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
          if (navigation === 0) await page.evaluate(() => { (window as unknown as { startQueue: () => void }).startQueue(); });
          else await page.getByRole("button", { name: "All projects" }).click();
          await seen;
          let settling!: () => void;
          const started = new Promise<void>((resolve) => { settling = resolve; });
          const expected = navigation === 1 && leak ? canary : `public-${navigation}`;
          const opening = afterDisclosureSettle({ settle: async (p: typeof page) => { settling(); await capture.settle(p); } }, page, async () => {
            const id = queueIds[navigation];
            expect(id).toBeTruthy();
            if (navigation === 1) expect(id).not.toBe(queueIds[0]);
            expect(continued.has(id)).toBe(true);
            expect(JSON.parse(queueBodies.get(id)!).value).toBe(expected);
            await page.getByRole("button", { name: "Open project" }).click();
          });
          openings.push(opening);
          void opening.catch(() => {});
          await started;
          expect(await Promise.race([opening.then(() => "opened"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 150))])).toBe("waiting");
          expect(await page.locator("#view").textContent()).toBe("List");
          pendingResponse!.writeHead(200, { "Content-Type": "application/json" });
          pendingResponse!.end(JSON.stringify({ value: expected }));
          await opening;
          await expect(page.locator("#view")).toHaveText("Project");
        }
        await capture(page);
        await capture.close();
        if (leak) expect(() => check.verify(["browser-response-bodies"])).toThrow(/^Secret disclosure detected$/);
        else expect(check.verify(["browser-response-bodies"])["browser-response-bodies"].captures).toBeGreaterThan(0);
      } finally {
        pendingResponse?.end();
        await context.close();
        await Promise.allSettled(openings);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("SEC-SECRET-001: Chromium captures original responses before immediate navigation", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const canary = randomBytes(32).toString("base64url");
  const tokens = {
    access_token: randomBytes(32).toString("base64url"),
    id_token: randomBytes(32).toString("base64url"),
  };
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let leaked = false;
  let leakedHeader = false;
  let emptyMethod = "POST";
  let metadataRequests = 0;
  const server = createServer((request, response) => {
    const path = request.url;
    if (path === tokenPath) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ...tokens, expires_in: 60 }));
    } else if (path === "/metadata") {
      metadataRequests++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ value: leaked ? canary : "public" }));
    } else if (path === "/empty" || path === "/api/access-grants") {
      response.writeHead(204, { "X-Public": "bodyless", ...(leakedHeader ? { "Set-Cookie": `proof=${canary}; Path=/` } : {}) });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        path === "/complete"
          ? "<h1>Complete</h1>"
          : `<script>
        fetch('${tokenPath}',{method:'POST'}).then(r=>r.json())
          .then(()=>fetch('${emptyMethod === "DELETE" ? "/api/access-grants" : "/empty"}',{method:'${emptyMethod}'}))
          .then(()=>fetch('/metadata')).then(r=>r.json())
          .then(()=>location.replace('/complete'));
        </script>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback fixture unavailable");
  const base = "http://127.0.0.1:" + address.port;
  const failedBodylessRequests = { POST: 0, DELETE: 0 }, fallbackHeaderReads = { POST: 0, DELETE: 0 }, fallbackSawCookie = { POST: false, DELETE: false };
  try {
    // Every independent iteration must pass; repeated header cases make the
    // observed Chromium abort path less sensitive to event scheduling.
    for (const method of ["POST", "DELETE"] as const) for (const inject of ["none", "body", "header", "header", "header", "none"]) {
      emptyMethod = method;
      const emptyPath = method === "DELETE" ? "/api/access-grants" : "/empty";
      leaked = inject === "body";
      leakedHeader = inject === "header";
      const before = metadataRequests;
      const check = createDisclosureCheck([canary]);
      const context = await browser.newContext();
      const originalNewPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await originalNewPage();
        page.on("request", (request) => {
          if (request.url() !== base + emptyPath) return;
          const originalResponse = request.response.bind(request);
          request.response = async () => {
            const response = await originalResponse();
            if (response) {
              const originalHeaders = response.headersArray.bind(response);
              response.headersArray = async () => {
                const headers = await originalHeaders();
                fallbackHeaderReads[method]++;
                if (headers.some((entry) => entry.name.toLowerCase() === "set-cookie" && entry.value.includes(canary))) fallbackSawCookie[method] = true;
                return headers;
              };
            }
            return response;
          };
        });
        page.on("requestfailed", (request) => { if (request.url() === base + emptyPath) failedBodylessRequests[method]++; });
        return page;
      };
      const capture = await observeBrowserDisclosure(context, base, check);
      try {
        const page = await capture.newPage();
        await page.goto(base);
        await expect(
          page.getByRole("heading", { name: "Complete" }),
        ).toBeVisible();
        await capture(page);
        await capture.close();
        expect(metadataRequests - before).toBe(1);
        if (inject !== "none")
          expect(() => check.verify([inject === "header" ? "browser-response-headers" : "browser-response-bodies"])).toThrow(
            /^Secret disclosure detected$/,
          );
        else {
          const evidence = check.verify([
            "browser-response-bodies",
            "browser-response-headers",
            "browser-dom",
            "browser-storage",
            "identity-token-metadata",
            "browser-bodyless-responses",
          ]);
          expect(
            evidence["browser-bodyless-responses"].captures,
          ).toBeGreaterThan(0);
        }
      } finally {
        await context.close();
      }
    }
    for (const method of ["POST", "DELETE"] as const) {
      expect(failedBodylessRequests[method]).toBeGreaterThan(0);
      expect(fallbackHeaderReads[method]).toBeGreaterThan(0);
      expect(fallbackSawCookie[method]).toBe(true);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
