import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  createDisclosureCheck,
  observeBrowserDisclosure,
  scanBrowserAssets,
  scanExecutionLogs,
  rejectLoggedTokens,
  createHostDisclosure,
  formatCaptureDiagnostic,
  reportIdentityCaptureDiagnostic,
} from "../scripts/acceptance/disclosure.mjs";

const base = "https://product.example.test";
const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
const secret = () => randomBytes(32).toString("base64url");
it("SEC-SECRET-001: host receipts must match the current run, profile, phase and required channels", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-disclosure-"));
  try {
    for (const fault of [
      "none",
      "run",
      "profile",
      "phase",
      "empty",
      "malformed",
    ]) {
      const check = createHostDisclosure({
        output: directory,
        runId: "current-run",
        profile: "bundled",
        command: (name: string) => [name],
        run: ([name]: string[]) => {
          const input = JSON.parse(
            readFileSync(join(directory, name + ".input.json"), "utf8"),
          );
          expect(input.required).toEqual(["configuration"]);
          expect(input.captures).toEqual([
            { channel: "configuration", text: "public settings" },
          ]);
          const receipt = {
            status: "passed",
            runId: fault === "run" ? "old-run" : "current-run",
            profile: fault === "profile" ? "external" : "bundled",
            phase: fault === "phase" ? "old-phase" : name,
            channels: {
              configuration: { captures: 1, bytes: fault === "empty" ? 0 : 15 },
            },
          };
          writeFileSync(
            join(directory, name + ".receipt.json"),
            fault === "malformed" ? "invalid" : JSON.stringify(receipt),
          );
        },
      });
      check.add("configuration", "public settings");
      if (fault === "none")
        expect(check.verify(["configuration"]).configuration.bytes).toBe(15);
      else
        expect(() => check.verify(["configuration"])).toThrow(
          /^Host disclosure verification incomplete$/,
        );
    }
  } finally {
    if (dirname(realpathSync(directory)) !== realpathSync(tmpdir()))
      throw new Error("Unexpected disclosure test directory");
    rmSync(directory, { recursive: true });
  }
});

async function observer() {
  const canary = secret();
  const check = createDisclosureCheck([canary]);
  const bodies = new Map<string, () => Promise<unknown>>();
  const continuationFailures = new Set<string>();
  const session = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string, args?: { requestId?: string }) => {
      if (
        method === "Fetch.continueRequest" &&
        continuationFailures.has(args!.requestId!)
      )
        throw new Error(canary);
      return method === "Fetch.getResponseBody"
        ? bodies.get(args!.requestId!)!()
        : {};
    }),
  });
  const page = Object.assign(new EventEmitter(), {
    waitForLoadState: async () => {},
    content: async () => "<html>Public page</html>",
    evaluate: async () => ({ local: {}, session: {} }),
  });
  let created = false;
  const context = Object.assign(new EventEmitter(), {
    pages: () => (created ? [page] : []),
    serviceWorkers: () => [],
    newCDPSession: async () => session,
    newPage: async () => {
      created = true;
      context.emit("page", page);
      return page;
    },
    close: async () => {
      context.emit("closed");
    },
  });
  const capture = await observeBrowserDisclosure(context, base, check);
  await capture.newPage();
  let sequence = 0;
  const pause = (
    response: {
      path?: string;
      status?: number;
      method?: string;
      headers?: { name: string; value: string }[];
      error?: string;
      noResponse?: boolean;
      networkId?: string;
      continuationError?: boolean;
    },
    body: () => Promise<unknown> = async () => ({
      body: "public response",
      base64Encoded: false,
    }),
  ) => {
    const requestId = String(++sequence);
    bodies.set(requestId, body);
    if (response.continuationError) continuationFailures.add(requestId);
    session.emit("Fetch.requestPaused", {
      requestId,
      networkId: response.networkId,
      request: {
        url: base + (response.path ?? "/api/example"),
        method: response.method ?? "GET",
      },
      responseStatusCode: response.noResponse
        ? undefined
        : (response.status ?? 200),
      responseHeaders: response.noResponse
        ? undefined
        : (response.headers ?? []),
      responseErrorReason: response.error,
    });
    return requestId;
  };
  const response = (
    path: string,
    value: unknown,
    headers = {},
    broken = false,
  ) =>
    pause(
      {
        path,
        method: path === tokenPath ? "POST" : "GET",
        headers: Object.entries({
          "content-type": "application/json",
          ...headers,
        }).map(([name, value]) => ({ name, value })),
      },
      async () => {
        if (broken) throw new Error(canary);
        return { body: JSON.stringify(value), base64Encoded: false };
      },
    );
  const tokens = {
    access_token: secret(),
    id_token: secret(),
    refresh_token: secret(),
    expires_in: 120,
  };
  return {
    canary,
    check,
    context,
    page,
    capture,
    response,
    tokens,
    pause,
    session,
  };
}

it("reports only fixed, saturated capture diagnostics and preserves the original failure", () => {
  const canary = secret();
  const emit = vi.fn();
  reportIdentityCaptureDiagnostic("other-stage", { diagnostic: () => ({ phase: canary }) }, emit);
  expect(emit).not.toHaveBeenCalled();
  reportIdentityCaptureDiagnostic("loaded-details-disclosure", {
    diagnostic: () => ({ phase: canary, counters: { body: 999, response: -1, headers: canary }, tokenSeen: canary, url: base, error: canary }),
  }, emit);
  expect(emit).toHaveBeenCalledTimes(1);
  const line = emit.mock.calls[0]![0] as string;
  expect(line).not.toContain(canary);
  expect(line).not.toContain(base);
  const value = JSON.parse(line.slice("SEC-AUTH-001 capture diagnostic ".length));
  expect(value).toEqual({ phase: "unavailable", counters: { response: 0, headers: 0, body: 2, continuation: 0, console: 0, timeout: 0, targets: 0, unresolved: 0, unprepared: 0, inflight: 0, requests: 0 }, tokenSeen: false,
    continuation: { branch: "unknown", resource: "unknown", error: "unknown", page: "unknown" },
    request: { resource: "unknown", method: "unknown", failure: "unknown", response: "unknown", phase: "unknown" } });
  expect(() => reportIdentityCaptureDiagnostic("loaded-details-disclosure", {
    diagnostic: () => { throw new Error(canary); },
  }, () => { throw new Error(canary); })).not.toThrow();
  reportIdentityCaptureDiagnostic("loaded-details-before-click-disclosure", { diagnostic: () => ({}) }, emit);
  expect(emit).toHaveBeenCalledTimes(2);
  reportIdentityCaptureDiagnostic("scalar-proof-disclosure", {
    diagnostic: () => ({ phase: "dom", counters: { body: 9 }, tokenSeen: false, url: canary, error: canary }),
  }, emit);
  expect(emit).toHaveBeenCalledTimes(3);
  const scalarLine = emit.mock.calls[2]![0] as string;
  expect(scalarLine).not.toContain(canary);
  expect(JSON.parse(scalarLine.slice("SEC-AUTH-001 capture diagnostic ".length))).toMatchObject({ phase: "dom", counters: { body: 2 }, tokenSeen: false });
  const hostile = { get phase() { throw new Error(canary); } };
  expect(formatCaptureDiagnostic(hostile)).not.toContain(canary);
});

it("reports only allowlisted failed-request classes without relaxing capture", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  const request = { url: () => base + "/api/access-grants", method: () => "DELETE",
    failure: () => ({ errorText: "net::ERR_ABORTED" }), response: async () => response };
  const response = { request: () => ({}), status: () => 204, fromServiceWorker: () => false };
  f.page.emit("request", request); f.page.emit("requestfailed", request);
  await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  const emit = vi.fn();
  reportIdentityCaptureDiagnostic("operator-disclosure", f.capture, emit);
  const line = emit.mock.calls[0]![0] as string;
  expect(line).not.toContain(base);
  expect(JSON.parse(line.slice("SEC-SECRET-001 operator capture diagnostic ".length)).request).toEqual({
    resource: "access_grants", method: "DELETE", failure: "aborted", response: "204", phase: "identity",
  });
  expect(formatCaptureDiagnostic({ request: { resource: f.canary, method: f.canary, failure: f.canary, response: f.canary, phase: f.canary } })).not.toContain(f.canary);
});

it("does not read diagnostic getters before an otherwise successful capture decision", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  let methods = 0, failures = 0, urls = 0, statuses = 0;
  const request = { url: () => ++urls === 1 ? base + "/empty" : f.canary,
    method: () => ++methods === 1 ? "POST" : f.canary,
    failure: () => ({ errorText: ++failures === 1 ? "net::ERR_ABORTED" : f.canary }), response: async () => response };
  const response = { request: () => request, url: () => base + "/empty", status: () => ++statuses === 1 ? 204 : 200,
    fromServiceWorker: () => false, headersArray: async () => [{ name: "x-proof", value: "public" }] };
  f.page.emit("request", request); f.page.emit("requestfailed", request);
  await f.capture(f.page);
  expect({ methods, failures, urls, statuses }).toEqual({ methods: 1, failures: 1, urls: 1, statuses: 1 });
  expect(f.capture.diagnostic().counters.requests).toBe(0);
});

it("keeps failure closed when request diagnostic getters throw", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  const hostile = () => { throw new Error(f.canary); };
  const request = { response: async () => null, url: hostile, method: hostile, failure: hostile };
  f.page.emit("request", request); f.page.emit("requestfailed", request);
  await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  const diagnostic = formatCaptureDiagnostic(f.capture.diagnostic());
  expect(diagnostic).not.toContain(f.canary);
  expect(JSON.parse(diagnostic).request).toEqual({ resource: "unknown", method: "unknown", failure: "unknown", response: "none", phase: "identity" });
});

it("does not combine different request URLs to qualify a DELETE fallback", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  let calls = 0;
  const request = { url: () => ++calls === 1 ? base + "/api/access-grants" : base + "/unrelated",
    method: () => "DELETE", failure: () => ({ errorText: "net::ERR_ABORTED" }), response: async () => response };
  const response = { request: () => request, url: () => base + "/unrelated", status: () => 204,
    fromServiceWorker: () => false, headersArray: async () => [{ name: "x-proof", value: "public" }] };
  f.page.emit("request", request); f.page.emit("requestfailed", request);
  await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  expect(f.capture.diagnostic().counters.requests).toBe(1);
});

it("waits for multiple observed requests, including one started while capture drains", async () => {
  const f = await observer();
  f.response(tokenPath, f.tokens);
  const first = {}, second = {}, later = {};
  f.page.emit("request", first); f.page.emit("request", second);
  let settled = false;
  const capture = f.capture(f.page).then(() => { settled = true; });
  await Promise.resolve();
  f.page.emit("requestfinished", second);
  expect(settled).toBe(false);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.pause({ path: "/asset" }, async () => { started(); await held; return { body: "public", base64Encoded: false }; });
  f.page.emit("requestfinished", first);
  await entered;
  f.page.emit("request", later);
  f.pause({ path: "/late", error: "Failed", noResponse: true, networkId: "new-native" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  f.pause({ path: "/late", networkId: "new-native" });
  f.page.emit("requestfinished", later);
  await capture;
  expect(settled).toBe(true);
});

it("fails closed for a tracked request failure without any CDP response", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  const request = {};
  f.page.emit("request", request); f.page.emit("requestfailed", request);
  await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  expect(f.capture.diagnostic().counters.requests).toBe(1);
});

it("only accepts exact eligible failed 204 responses after recording their original headers", async () => {
  for (const requestMethod of ["POST", "DELETE"]) for (const fault of ["none", "query", "header-secret", "null", "other-request", "foreign", "status", "method", "failure", "worker", "url", "headers", "header-error", "continuation", "delete-path"]) {
    const f = await observer(); f.response(tokenPath, f.tokens);
    const request = {
      url: () => (fault === "foreign" ? "https://foreign.example.test" : base) + (requestMethod === "DELETE" && fault !== "delete-path" ? "/api/access-grants" : "/empty") + (fault === "query" ? "?synthetic=1" : ""),
      method: () => fault === "method" ? "GET" : requestMethod,
      failure: () => ({ errorText: fault === "failure" ? "net::ERR_FAILED" : "net::ERR_ABORTED" }),
      response: async () => fault === "null" ? null : response,
    };
    const response = {
      request: () => fault === "other-request" ? { ...request } : request,
      url: () => fault === "url" ? base + "/different" : request.url(), status: () => fault === "status" ? 200 : 204,
      fromServiceWorker: () => fault === "worker",
      headersArray: async () => {
        if (fault === "header-error") throw new Error(f.canary);
        return fault === "headers" ? [{ name: "invalid" }] : [{ name: "x-proof", value: fault === "header-secret" ? f.canary : "public" }];
      },
    };
    f.page.emit("request", request);
    if (fault === "continuation") f.pause({ path: "/empty", status: 204, method: "POST", continuationError: true });
    f.page.emit("requestfailed", request);
    if (fault === "none" || fault === "query" || fault === "header-secret" || (fault === "delete-path" && requestMethod === "POST")) {
      await f.capture(f.page);
      if (fault === "header-secret") expect(() => f.check.verify(["browser-response-headers"])).toThrow(/^Secret disclosure detected$/);
      else expect(f.check.verify(["browser-response-headers"])["browser-response-headers"].captures).toBeGreaterThan(0);
    } else await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  }
});

it("does not match two concurrent failed requests merely because their URLs agree", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  const first = { url: () => base + "/empty", method: () => "POST", failure: () => ({ errorText: "net::ERR_ABORTED" }), response: async () => response };
  const second = { ...first };
  const response = { request: () => first, url: () => first.url(), status: () => 204,
    fromServiceWorker: () => false, headersArray: async () => [{ name: "x-proof", value: "public" }] };
  f.page.emit("request", first); f.page.emit("request", second);
  f.page.emit("requestfailed", first); f.page.emit("requestfailed", second);
  await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
});

it("times out closed if a failed 204 response's original headers cannot be read", async () => {
  vi.useFakeTimers();
  try {
    const f = await observer(); f.response(tokenPath, f.tokens);
    const request = { url: () => base + "/empty", method: () => "POST", failure: () => ({ errorText: "net::ERR_ABORTED" }), response: async () => response };
    const response = { request: () => request, url: () => request.url(), status: () => 204,
      fromServiceWorker: () => false, headersArray: async () => new Promise(() => {}) };
    f.page.emit("request", request); f.page.emit("requestfailed", request);
    const failure = expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
    await vi.advanceTimersByTimeAsync(10001);
    await failure;
    expect(f.capture.diagnostic().counters.timeout).toBe(1);
  } finally { vi.useRealTimers(); }
});

it("waits for a request started during DOM capture and retains its canary", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  const request = {};
  let started!: () => void;
  const reached = new Promise<void>((resolve) => { started = resolve; });
  f.page.content = async () => { f.page.emit("request", request); started(); return "<html>Public page</html>"; };
  const done = f.capture(f.page);
  await reached;
  f.response("/late", { value: f.canary });
  f.page.emit("requestfinished", request);
  await done;
  expect(() => f.check.verify(["browser-response-bodies"])).toThrow(/^Secret disclosure detected$/);
});

it("waits for a request already in flight before intentional close", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  await f.capture(f.page);
  const request = {};
  f.page.emit("request", request);
  let closed = false;
  f.context.on("closed", () => { closed = true; });
  const done = f.capture.close();
  await Promise.resolve();
  expect(closed).toBe(false);
  f.response("/late", { value: f.canary });
  f.page.emit("requestfinished", request);
  await done;
  expect(closed).toBe(true);
  expect(() => f.check.verify(["browser-response-bodies"])).toThrow(/^Secret disclosure detected$/);
});

it("does not let failed requests erase unresolved CDP response evidence", async () => {
  const f = await observer();
  f.response(tokenPath, f.tokens);
  const request = {};
  f.page.emit("request", request);
  f.pause({ error: "Aborted", noResponse: true, networkId: "synthetic" });
  f.page.emit("requestfailed", request);
  await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
  expect(f.capture.diagnostic().counters.unresolved).toBe(1);
});

it("fails closed on request tracking overflow and unexpected page closure", async () => {
  for (const fault of ["overflow", "closed"]) {
    const f = await observer(); f.response(tokenPath, f.tokens);
    if (fault === "overflow") for (let i = 0; i < 1025; i++) f.page.emit("request", {});
    else { f.page.emit("request", {}); f.page.emit("close"); }
    await expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
    const counters = f.capture.diagnostic().counters;
    expect(fault === "overflow" ? counters.requests : counters.targets).toBe(1);
  }
});

it("counts network-idle timeouts without leaking the underlying message", async () => {
  const f = await observer(); f.response(tokenPath, f.tokens);
  f.page.waitForLoadState = async () => { throw Object.assign(new Error(f.canary), { name: "TimeoutError" }); };
  await expect(f.capture(f.page)).rejects.toThrow();
  const diagnostic = formatCaptureDiagnostic(f.capture.diagnostic());
  expect(JSON.parse(diagnostic)).toMatchObject({ phase: "networkidle", counters: { timeout: 1 } });
  expect(diagnostic).not.toContain(f.canary);
});

it("fails closed when a tracked request never finishes", async () => {
  vi.useFakeTimers();
  try {
    const f = await observer(); f.response(tokenPath, f.tokens);
    f.page.emit("request", {});
    const failure = expect(f.capture(f.page)).rejects.toThrow(/^Browser disclosure capture incomplete$/);
    await vi.advanceTimersByTimeAsync(10001);
    await failure;
    expect(f.capture.diagnostic()).toMatchObject({ phase: "inflight", counters: { timeout: 1, inflight: 1 } });
  } finally { vi.useRealTimers(); }
});

it("keeps capture failures closed while distinguishing finite diagnostic phases", async () => {
  for (const fault of ["networkidle", "dom", "storage", "token", "headers", "body", "continuation", "console", "unresolved", "unprepared", "target"]) {
    const f = await observer();
    if (fault !== "token") f.response(tokenPath, f.tokens);
    if (fault === "networkidle") f.page.waitForLoadState = async () => { throw new Error(f.canary); };
    if (fault === "dom") f.page.content = async () => { throw new Error(f.canary); };
    if (fault === "storage") f.page.evaluate = async () => { throw new Error(f.canary); };
    if (fault === "body") f.response("/api/me", {}, {}, true);
    if (fault === "headers") f.pause({ noResponse: true });
    if (fault === "continuation") f.pause({ continuationError: true });
    if (fault === "console") f.page.emit("console", { text: () => "public", args: () => [{ jsonValue: async () => { throw new Error(f.canary); } }] });
    if (fault === "unresolved") f.pause({ error: "Aborted", noResponse: true, networkId: "synthetic" });
    if (fault === "unprepared") f.context.emit("page", new EventEmitter());
    if (fault === "target") f.page.emit("worker", {});
    await expect(f.capture(f.page)).rejects.toThrow();
    const diagnostic = JSON.parse(formatCaptureDiagnostic(f.capture.diagnostic()));
    expect(JSON.stringify(diagnostic)).not.toContain(f.canary);
    expect(JSON.stringify(diagnostic)).not.toContain(base);
    if (["networkidle", "dom", "storage"].includes(fault)) expect(diagnostic.phase).toBe(fault);
    if (fault === "token") expect(diagnostic).toMatchObject({ phase: "token_seen", tokenSeen: false });
    if (fault === "body") expect(diagnostic.counters.body).toBe(1);
    if (fault === "headers") expect(diagnostic.counters.headers).toBe(1);
    if (fault === "continuation") expect(diagnostic.counters.continuation).toBe(1);
    if (fault === "continuation") expect(diagnostic.continuation).toEqual({ branch: "response", resource: "other", error: "other", page: "unknown" });
    if (fault === "console") expect(diagnostic.counters.console).toBe(1);
    if (fault === "unresolved") expect(diagnostic.counters.unresolved).toBe(1);
    if (fault === "unprepared") expect(diagnostic.counters.unprepared).toBe(1);
    if (fault === "target") expect(diagnostic.counters.targets).toBe(1);
  }
});

it("reports only fixed categories for full and provisional continuation failures", async () => {
  for (const branch of ["response", "provisional"] as const) {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    f.pause({ path: "/api/pm/action-queue?token=" + f.canary, continuationError: true,
      ...(branch === "provisional" ? { error: "Aborted", noResponse: true, networkId: "synthetic" } : {}) });
    await expect(f.capture(f.page)).rejects.toThrow();
    const diagnostic = JSON.parse(formatCaptureDiagnostic(f.capture.diagnostic()));
    expect(diagnostic.continuation).toEqual({ branch, resource: "pm_queue", error: "other", page: "unknown" });
    expect(JSON.stringify(diagnostic)).not.toContain(f.canary);
    expect(JSON.stringify(diagnostic)).not.toContain(base);
  }
  const canary = secret();
  let reads = 0;
  const diagnostic = formatCaptureDiagnostic({ continuation: {
    get branch() { reads++; return reads === 1 ? "response" : canary; },
    resource: canary, error: canary, page: canary,
  } });
  expect(reads).toBe(1);
  expect(diagnostic).not.toContain(canary);
  expect(JSON.parse(diagnostic).continuation).toEqual({ branch: "response", resource: "unknown", error: "unknown", page: "unknown" });
});

it("SEC-SECRET-001: browser collector detects nested console values, error stacks and token header leaks", async () => {
  for (const channel of [
    "console",
    "stack",
    "token-header",
    "unexpected-token-path",
    "token-metadata",
    "issued-server-secret",
  ]) {
    const f = await observer();
    f.response(
      tokenPath,
      f.tokens,
      channel === "token-header" ? { private: f.canary } : {},
    );
    if (channel === "console")
      f.page.emit("console", {
        text: () => "Object",
        args: () => [
          { jsonValue: async () => ({ nested: { token: f.canary } }) },
        ],
      });
    if (channel === "stack")
      f.page.emit("pageerror", {
        toString: () => "Error",
        stack: "Error\n at " + f.canary,
      });
    if (channel === "unexpected-token-path")
      f.response("/api/other/protocol/openid-connect/token", {
        access_token: f.tokens.access_token,
      });
    if (channel === "token-metadata")
      f.response(tokenPath, { ...f.tokens, debug: f.canary });
    if (channel === "issued-server-secret")
      f.response(tokenPath, { ...f.tokens, access_token: f.canary });
    if (channel === "issued-server-secret" || channel === "token-metadata") {
      await expect(f.capture(f.page)).rejects.toThrow(
        /^Browser disclosure capture incomplete$/,
      );
    } else {
      await f.capture(f.page);
      expect(() => f.check.verify(["browser-dom"])).toThrow(
        /^Secret disclosure detected$/,
      );
    }
  }
});

it("SEC-SECRET-001: browser capture requires an observed token response and complete awaited bodies", async () => {
  const missing = await observer();
  await expect(missing.capture(missing.page)).rejects.toThrow(
    /token response was not observed/,
  );
  const broken = await observer();
  broken.response(tokenPath, broken.tokens);
  broken.response("/api/me", {}, {}, true);
  await expect(broken.capture(broken.page)).rejects.toThrow(
    /^Browser disclosure capture incomplete$/,
  );
  const complete = await observer();
  complete.response(tokenPath, complete.tokens);
  complete.response("/api/me", { subject: "synthetic" });
  await complete.capture(complete.page);
  expect(
    complete.check.verify([
      "browser-response-bodies",
      "browser-response-headers",
      "browser-dom",
      "browser-storage",
      "identity-token-metadata",
    ])["identity-token-metadata"].captures,
  ).toBe(1);
});

it("SEC-SECRET-001: original responses remain paused until delayed and newly queued bodies are captured", async () => {
  const f = await observer();
  expect(f.session.send.mock.calls[0]).toEqual([
    "Fetch.enable",
    { patterns: [{ urlPattern: base + "/*", requestStage: "Response" }] },
  ]);
  f.response(tokenPath, f.tokens);
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const first = f.pause(
    {},
    () =>
      new Promise((resolve) => {
        releaseFirst = () => resolve({ body: "first", base64Encoded: false });
      }),
  );
  const completion = f.capture(f.page);
  const second = f.pause(
    {},
    () =>
      new Promise((resolve) => {
        releaseSecond = () =>
          resolve({
            body: Buffer.from("second").toString("base64"),
            base64Encoded: true,
          });
      }),
  );
  const continued = (id: string) =>
    f.session.send.mock.calls.some(
      ([method, args]) =>
        method === "Fetch.continueRequest" && args?.requestId === id,
    );
  expect(continued(first)).toBe(false);
  expect(continued(second)).toBe(false);
  releaseFirst();
  await Promise.resolve();
  expect(continued(second)).toBe(false);
  releaseSecond();
  await completion;
  expect(continued(first)).toBe(true);
  expect(continued(second)).toBe(true);
  for (const [method, args] of f.session.send.mock.calls)
    if (method === "Fetch.continueRequest")
      expect(Object.keys(args!)).toEqual(["requestId"]);
  expect(
    f.check.verify(["browser-response-bodies"])["browser-response-bodies"]
      .captures,
  ).toBe(2);
});

it.each(["public", "body", "header"])(
  "SEC-SECRET-001: close drains pending bodies, acknowledgements and newly queued responses (%s)",
  async (leak) => {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    await f.capture(f.page);
    let closed = false;
    f.context.on("closed", () => {
      closed = true;
    });
    let releaseBody!: () => void;
    let releaseContinuation!: () => void;
    let started!: () => void;
    const continuationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const acknowledgement = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    const original = f.session.send.getMockImplementation()!;
    let delayedId: string;
    f.session.send.mockImplementation(async (method, args) => {
      if (method === "Fetch.continueRequest" && args?.requestId === delayedId) {
        started();
        await acknowledgement;
      }
      if (closed) throw new Error(f.canary);
      return original(method, args);
    });
    delayedId = f.pause(
      {},
      () =>
        new Promise((resolve) => {
          releaseBody = () =>
            resolve({ body: "first public response", base64Encoded: false });
        }),
    );
    const completion = f.capture.close();
    void completion.catch(() => {});
    expect(closed).toBe(false);
    releaseBody();
    await continuationStarted;
    expect(closed).toBe(false);
    const second = f.response(
      "/late",
      { value: leak === "body" ? f.canary : "public" },
      leak === "header" ? { private: f.canary } : {},
    );
    releaseContinuation();
    await completion;
    expect(closed).toBe(true);
    expect(f.session.send.mock.calls).toContainEqual([
      "Fetch.continueRequest",
      { requestId: second },
    ]);
    const channels = ["browser-response-bodies", "browser-response-headers"];
    if (leak === "public")
      expect(f.check.verify(channels)["browser-response-bodies"].captures).toBe(
        2,
      );
    else
      expect(() => f.check.verify(channels)).toThrow(
        /^Secret disclosure detected$/,
      );
  },
);

it("SEC-SECRET-001: close still destroys the context after a bounded pre-close failure", async () => {
  vi.useFakeTimers();
  try {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    await f.capture(f.page);
    const closed = vi.fn();
    f.context.on("closed", closed);
    f.pause({}, () => new Promise(() => {}));
    const completion = expect(f.capture.close()).rejects.toThrow(
      /^Browser disclosure capture incomplete$/,
    );
    await vi.advanceTimersByTimeAsync(10001);
    await completion;
    expect(closed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("SEC-SECRET-001: bodyless and redirect responses retain duplicate-header disclosure checks", async () => {
  for (const leaked of [false, true]) {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    const body = vi.fn(async () => {
      throw new Error("No body available");
    });
    for (const [method, status] of [
      ["POST", 204],
      ["POST", 205],
      ["HEAD", 200],
      ["GET", 304],
      ["GET", 302],
    ] as const) {
      f.pause(
        {
          method,
          status,
          headers: [
            { name: "Location", value: "/public" },
            { name: "Set-Cookie", value: "public" },
            { name: "Set-Cookie", value: leaked ? f.canary : "also-public" },
          ],
        },
        body,
      );
    }
    await f.capture(f.page);
    expect(body).not.toHaveBeenCalled();
    if (leaked)
      expect(() => f.check.verify(["browser-response-headers"])).toThrow(
        /^Secret disclosure detected$/,
      );
    else
      expect(
        f.check.verify(["browser-response-headers"])[
          "browser-bodyless-responses"
        ].captures,
      ).toBe(5);
  }
  for (const status of [200, 300, 302, 404]) {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    f.pause({ status }, async () => ({ body: f.canary, base64Encoded: false }));
    await f.capture(f.page);
    expect(() => f.check.verify(["browser-response-bodies"])).toThrow(
      /^Secret disclosure detected$/,
    );
  }
});

it("SEC-SECRET-001: provisional errors require the same native request's complete response", async () => {
  for (const fault of [
    "none",
    "id",
    "url",
    "method",
    "missing",
    "body",
    "metadata",
    "no-id",
    "no-error",
    "continuation",
    "provisional-continuation",
  ]) {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    const first = f.pause({
      path: "/asset.woff2",
      error: fault === "no-error" ? undefined : "Failed",
      noResponse: fault !== "metadata",
      networkId: fault === "no-id" ? undefined : "native-request",
      continuationError: fault === "provisional-continuation",
    });
    f.page.waitForLoadState = async () => {
      if (fault !== "missing")
        f.pause(
          {
            path: fault === "url" ? "/other.woff2" : "/asset.woff2",
            method: fault === "method" ? "POST" : "GET",
            networkId: fault === "id" ? "different-request" : "native-request",
            continuationError: fault === "continuation",
          },
          async () => {
            if (fault === "body") throw new Error(f.canary);
            return { body: "original asset", base64Encoded: false };
          },
        );
    };
    if (fault === "none") {
      await f.capture(f.page);
      await f.capture.close();
      expect(
        f.check.verify(["browser-response-bodies"])["browser-response-bodies"]
          .captures,
      ).toBe(1);
      expect(
        f.session.send.mock.calls.filter(
          ([method, args]) => args?.requestId === first,
        ),
      ).toEqual([["Fetch.continueRequest", { requestId: first }]]);
    } else {
      await expect(f.capture(f.page)).rejects.toThrow(
        /^Browser disclosure capture incomplete$/,
      );
      await expect(f.capture.close()).rejects.toThrow(
        /^Browser disclosure capture incomplete$/,
      );
    }
  }
});

it("SEC-SECRET-001: unsupported targets, transport errors and late close failures cannot pass", async () => {
  const existing = await observer();
  await expect(
    observeBrowserDisclosure(existing.context, base, existing.check),
  ).rejects.toThrow(/^Browser disclosure requires a fresh context$/);
  for (const fault of [
    "popup",
    "worker",
    "frame",
    "serviceworker",
    "transport",
    "close",
  ]) {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    if (fault === "popup") f.context.emit("page", new EventEmitter());
    if (fault === "worker") f.page.emit("worker", {});
    if (fault === "frame") f.page.emit("frameattached", {});
    if (fault === "serviceworker") f.context.emit("serviceworker", {});
    if (fault === "transport") f.pause({ error: "Failed" });
    if (fault === "close") {
      await f.capture(f.page);
      f.context.on("closed", () => f.pause({ error: "Aborted" }));
      await expect(f.capture.close()).rejects.toThrow(
        /^Browser disclosure capture incomplete$/,
      );
    } else
      await expect(f.capture(f.page)).rejects.toThrow(
        /^Browser disclosure capture incomplete$/,
      );
  }
});

it("SEC-SECRET-001: stuck response capture fails within its deadline without continuing an unread body", async () => {
  vi.useFakeTimers();
  try {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    const requestId = f.pause({}, () => new Promise(() => {}));
    const completion = expect(f.capture(f.page)).rejects.toThrow(
      /^Browser disclosure capture incomplete$/,
    );
    await vi.advanceTimersByTimeAsync(10001);
    await completion;
    expect(JSON.parse(formatCaptureDiagnostic(f.capture.diagnostic()))).toMatchObject({
      phase: "drain_before_dom", counters: { timeout: 1 },
    });
    expect(
      f.session.send.mock.calls.some(
        ([method, args]) =>
          ["Fetch.continueRequest", "Fetch.failRequest"].includes(method) &&
          args?.requestId === requestId,
      ),
    ).toBe(false);
    await expect(f.capture(f.page)).rejects.toThrow(
      /^Browser disclosure capture incomplete$/,
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("SEC-SECRET-001: asset coverage rejects missing, altered, unsafe and malformed inventory without reflecting content", async () => {
  const canary = secret();
  const script = 'console.log("public")';
  const digest = createHash("sha256").update(script).digest("hex");
  for (const scenario of [
    "valid",
    "missing",
    "hash",
    "path",
    "malformed",
    "leak",
  ]) {
    const check = createDisclosureCheck([canary]);
    const manifest = {
      schemaVersion: 1,
      assets: [
        {
          file: scenario === "path" ? "../secret.js" : "assets/main.js",
          sha256: scenario === "hash" ? "0".repeat(64) : digest,
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("third-party-components.json"))
          return new Response(
            scenario === "malformed"
              ? '{"private":"' + canary + '",invalid'
              : JSON.stringify(manifest),
          );
        if (path.endsWith("main.js"))
          return new Response(script, {
            status: scenario === "missing" ? 404 : 200,
          });
        return new Response(scenario === "leak" ? canary : "public notices");
      });
    try {
      if (scenario === "valid" || scenario === "leak") {
        expect(await scanBrowserAssets(base, check)).toBe(3);
        if (scenario === "leak")
          expect(() => check.verify(["assets"])).toThrow(
            /^Secret disclosure detected$/,
          );
        else
          expect(
            check.verify(["assets", "asset-headers"]).assets.captures,
          ).toBe(3);
      } else {
        let failure: unknown;
        try {
          await scanBrowserAssets(base, check);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure).includes(canary)).toBe(false);
      }
    } finally {
      fetchMock.mockRestore();
    }
  }
});

it("SEC-SECRET-001: private command logs include stderr-only leaks and reject signed token shapes", () => {
  const directory = mkdtempSync(join(tmpdir(), "pdaa-disclosure-"));
  const canary = secret();
  try {
    // The host saves stdout plus stderr even when stdout is separately parsed.
    writeFileSync(
      join(directory, "backup.log"),
      '{"operation":"backup"}\n' + canary,
    );
    const check = createDisclosureCheck([canary]);
    scanExecutionLogs(directory, check);
    expect(() => check.verify(["execution-logs"])).toThrow(
      /^Secret disclosure detected$/,
    );
    expect(() =>
      rejectLoggedTokens(
        "eyJ" + "a".repeat(20) + "." + "b".repeat(24) + "." + "c".repeat(32),
      ),
    ).toThrow(/Credential-shaped token/);
    expect(() => rejectLoggedTokens('{"event":"api.started"}')).not.toThrow();
  } finally {
    if (dirname(realpathSync(directory)) !== realpathSync(tmpdir()))
      throw new Error("Unexpected disclosure test directory");
    rmSync(directory, { recursive: true });
  }
});
