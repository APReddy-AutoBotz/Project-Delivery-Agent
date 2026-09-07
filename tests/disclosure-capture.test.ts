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
  const context = Object.assign(new EventEmitter(), {
    route: vi.fn(
      async (
        _pattern: string,
        _handler: (route: unknown) => Promise<void>,
      ) => {},
    ),
  });
  const page = Object.assign(new EventEmitter(), {
    content: async () => "<html>Public page</html>",
    evaluate: async () => ({ local: {}, session: {} }),
  });
  const capture = await observeBrowserDisclosure(context, base, check);
  context.emit("page", page);
  const response = (
    path: string,
    value: unknown,
    headers = {},
    broken = false,
  ) =>
    context.emit("response", {
      url: () => base + path,
      status: () => 200,
      request: () => ({ method: () => (path === tokenPath ? "POST" : "GET") }),
      allHeaders: async () => ({
        "content-type": "application/json",
        ...headers,
      }),
      json: async () => value,
      body: async () => {
        if (broken) throw new Error(canary);
        return Buffer.from(JSON.stringify(value));
      },
    });
  const tokens = {
    access_token: secret(),
    id_token: secret(),
    refresh_token: secret(),
    expires_in: 120,
  };
  return { canary, check, context, page, capture, response, tokens };
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

it("SEC-SECRET-001: response body capture begins while headers are pending", async () => {
  const f = await observer();
  f.response(tokenPath, f.tokens);
  let releaseHeaders!: (value: object) => void;
  const headers = new Promise((resolve) => {
    releaseHeaders = resolve;
  });
  const body = vi.fn(async () => Buffer.from("public response"));
  f.context.emit("response", {
    url: () => base + "/api/auth/config",
    status: () => 200,
    request: () => ({ method: () => "GET" }),
    allHeaders: () => headers,
    body,
  });
  expect(body).toHaveBeenCalledOnce();
  releaseHeaders({ "content-type": "application/json" });
  await f.capture(f.page);
  expect(
    f.check.verify(["browser-response-bodies"])["browser-response-bodies"]
      .bytes,
  ).toBeGreaterThan(0);
});

it("SEC-SECRET-001: bodyless HTTP responses retain disclosure checks on their headers", async () => {
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
    ] as const) {
      f.context.emit("response", {
        url: () => base + "/api/empty",
        status: () => status,
        request: () => ({ method: () => method }),
        allHeaders: async () => ({ value: leaked ? f.canary : "public" }),
        body,
      });
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
      ).toBe(3);
  }
});

it("SEC-SECRET-001: navigation waits for response capture and includes newly queued captures", async () => {
  const f = await observer();
  const navigate = f.context.route.mock.calls[0][1];
  const first = {
    request: () => ({ isNavigationRequest: () => true, url: () => base }),
    continue: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  await navigate(first);
  expect(first.continue).toHaveBeenCalledOnce();
  f.response(tokenPath, f.tokens);
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const pendingBody = () =>
    new Promise<Buffer>((resolve) => {
      releaseFirst = () => resolve(Buffer.from("first body"));
    });
  f.context.emit("response", {
    url: () => base + "/api/first",
    status: () => 200,
    request: () => ({ method: () => "GET" }),
    allHeaders: async () => ({}),
    body: pendingBody,
  });
  const route = { ...first, continue: vi.fn(async () => {}) };
  const completion = navigate(route);
  await Promise.resolve();
  expect(route.continue).not.toHaveBeenCalled();
  f.context.emit("response", {
    url: () => base + "/api/second",
    status: () => 200,
    request: () => ({ method: () => "GET" }),
    allHeaders: async () => ({}),
    body: () =>
      new Promise<Buffer>((resolve) => {
        releaseSecond = () => resolve(Buffer.from("second body"));
      }),
  });
  releaseFirst();
  await Promise.resolve();
  expect(route.continue).not.toHaveBeenCalled();
  releaseSecond();
  await completion;
  expect(route.continue).toHaveBeenCalledOnce();
  expect(route.abort).not.toHaveBeenCalled();
  await f.capture(f.page);
  expect(
    f.check.verify(["browser-response-bodies"])["browser-response-bodies"]
      .captures,
  ).toBe(2);
});

it("SEC-SECRET-001: stuck capture aborts navigation and remains a failure at the final snapshot", async () => {
  vi.useFakeTimers();
  try {
    const f = await observer();
    f.response(tokenPath, f.tokens);
    f.context.emit("response", {
      url: () => base + "/api/stuck",
      status: () => 200,
      request: () => ({ method: () => "GET" }),
      allHeaders: async () => ({}),
      body: () => new Promise(() => {}),
    });
    const route = {
      request: () => ({ isNavigationRequest: () => true, url: () => base }),
      continue: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const completion = f.context.route.mock.calls[0][1](route);
    await vi.advanceTimersByTimeAsync(10001);
    await completion;
    expect(route.abort).toHaveBeenCalledOnce();
    expect(route.continue).not.toHaveBeenCalled();
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
