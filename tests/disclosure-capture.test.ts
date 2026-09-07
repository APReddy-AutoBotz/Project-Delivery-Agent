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
  const session = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string, args?: { requestId?: string }) =>
      method === "Fetch.getResponseBody" ? bodies.get(args!.requestId!)!() : {},
    ),
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
    },
    body: () => Promise<unknown> = async () => ({
      body: "public response",
      base64Encoded: false,
    }),
  ) => {
    const requestId = String(++sequence);
    bodies.set(requestId, body);
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
  ]) {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    const first = f.pause({
      path: "/asset.woff2",
      error: fault === "no-error" ? undefined : "Failed",
      noResponse: fault !== "metadata",
      networkId: fault === "no-id" ? undefined : "native-request",
    });
    f.page.waitForLoadState = async () => {
      if (fault !== "missing")
        f.pause(
          {
            path: fault === "url" ? "/other.woff2" : "/asset.woff2",
            method: fault === "method" ? "POST" : "GET",
            networkId: fault === "id" ? "different-request" : "native-request",
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
