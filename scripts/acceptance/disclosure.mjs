import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const fixtureSecretNames = [
  "admin-password",
  "api-password",
  "worker-password",
  "migration-password",
  "backup-password",
  "login-password",
  "backup-key",
  "encryption-key",
  "server.key",
  "ca.key",
  "connector-secret",
];
export const readFixtureSecrets = (directory) =>
  fixtureSecretNames.map((name) =>
    readFileSync(join(directory, name), "utf8").trim(),
  );

// Fixed, saturated counters only: never serialize errors, response data or IDs.
const captureDiagnosticPhases = new Set([
  "unavailable", "settle_health", "networkidle", "inflight", "drain_before_dom",
  "settle_complete", "dom", "storage", "drain_after_dom", "completeness",
  "token_seen", "complete",
]);
const captureDiagnosticCounters = [
  "response", "headers", "body", "continuation", "console", "timeout",
  "targets", "unresolved", "unprepared", "inflight", "requests",
];
const continuationDiagnosticAllowed = {
  branch: new Set(["provisional", "response"]),
  resource: new Set(["pm_queue", "project", "identity", "other"]),
  error: new Set(["invalid_interception", "target_closed", "other"]),
  page: new Set(["closed", "open"]),
};
const requestDiagnosticAllowed = {
  resource: new Set(["access_grants", "pm_queue", "project", "other"]),
  method: new Set(["GET", "POST", "DELETE", "other"]),
  failure: new Set(["aborted", "other"]),
  response: new Set(["none", "204", "2xx", "3xx", "4xx", "5xx", "other"]),
  phase: new Set(["response", "identity", "eligibility", "origin", "headers"]),
};
const safeRequestDiagnostic = (value) => Object.fromEntries(
  Object.entries(requestDiagnosticAllowed).map(([key, allowed]) => {
    const candidate = value?.[key];
    return [key, allowed.has(candidate) ? candidate : "unknown"];
  }),
);
const safeContinuationDiagnostic = (value) => Object.fromEntries(
  Object.entries(continuationDiagnosticAllowed).map(([key, allowed]) => {
    const candidate = value?.[key];
    return [key, allowed.has(candidate) ? candidate : "unknown"];
  }),
);
const bucketCaptureCount = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value >= 2 ? 2 : 1
    : 0;
export function formatCaptureDiagnostic(value) {
  try {
    const inputPhase = value?.phase;
    const phase = captureDiagnosticPhases.has(inputPhase) ? inputPhase : "unavailable";
    return JSON.stringify({
      phase,
      counters: Object.fromEntries(captureDiagnosticCounters.map((key) => [key, bucketCaptureCount(value?.counters?.[key])])),
      tokenSeen: value?.tokenSeen === true,
      continuation: safeContinuationDiagnostic(value?.continuation),
      request: safeRequestDiagnostic(value?.request),
    });
  } catch {
    return JSON.stringify({ phase: "unavailable", counters: Object.fromEntries(captureDiagnosticCounters.map((key) => [key, 0])), tokenSeen: false, continuation: safeContinuationDiagnostic(undefined), request: safeRequestDiagnostic(undefined) });
  }
}
export function reportIdentityCaptureDiagnostic(stage, capture, emit = console.error) {
  if (!["loaded-details-disclosure", "loaded-details-before-click-disclosure", "operator-disclosure", "scalar-proof-disclosure"].includes(stage)) return;
  let result;
  try { result = formatCaptureDiagnostic(capture?.diagnostic?.()); }
  catch { result = formatCaptureDiagnostic(undefined); }
  try { emit((stage === "operator-disclosure" ? "SEC-SECRET-001 operator capture diagnostic " : "SEC-AUTH-001 capture diagnostic ") + result); }
  catch { /* Diagnostics must not replace the original failure. */ }
}

// An explicit verifier interaction must not abandon responses still being
// captured from the current view. This does not change product requests.
export async function afterDisclosureSettle(capture, page, action) {
  await capture.settle(page);
  return action();
}

// SEC-SECRET-001 / EXEC-015: the late-created capture task key is mounted only
// into the private verifier. Return no parser/secret details on malformed input.
export function readCaptureTaskSecrets(file) {
  try {
    const bytes = readFileSync(file);
    if (bytes.length === 0 || bytes.length > 16384 || bytes.includes(0)) throw new Error();
    const value = JSON.parse(bytes.toString("utf8"));
    if (Object.keys(value).sort().join() !== "currentKeyId,keys" || value.currentKeyId !== "capture-fixture" ||
        Object.keys(value.keys).join() !== "capture-fixture") throw new Error();
    const key = value.keys["capture-fixture"];
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key) || Buffer.from(key,"base64url").length !== 32 ||
        Buffer.from(key,"base64url").toString("base64url") !== key) throw new Error();
    return [key];
  } catch { throw new Error("Capture disclosure key unavailable"); }
}

// SEC-SECRET-001: captures stay in memory. Errors and receipts contain no payload,
// credential value, token, URL or hash of a secret, including in a failed check.
export function createDisclosureCheck(initialSecrets) {
  const secrets = new Set();
  const channels = new Map();
  const addSecrets = (values) => {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((v) => typeof v !== "string" || v.length < 16)
    )
      throw new Error("Disclosure check requires generated secrets");
    for (const value of values) {
      const encoded = encodeURIComponent(value);
      for (const form of [
        value,
        JSON.stringify(value).slice(1, -1),
        encoded,
        encodeURIComponent(encoded),
        encoded.replace(/%[A-F0-9]{2}/g, (v) => v.toLowerCase()),
      ])
        secrets.add(form);
    }
  };
  addSecrets(initialSecrets);
  const serverSecrets = [...secrets];
  return {
    addSecrets,
    checkServerSecrets(text) {
      if (serverSecrets.some((secret) => text.includes(secret)))
        throw new Error("Secret disclosure detected");
    },
    add(channel, text) {
      if (typeof text !== "string")
        throw new Error("Disclosure capture unavailable");
      if (!channels.has(channel)) channels.set(channel, []);
      channels.get(channel).push(text);
    },
    verify(required) {
      for (const channel of required)
        if (!channels.get(channel)?.some((text) => text.length > 0))
          throw new Error("Required disclosure channel is empty");
      for (const entries of channels.values())
        for (const text of entries)
          for (const secret of secrets)
            if (text.includes(secret))
              throw new Error("Secret disclosure detected");
      return Object.fromEntries(
        [...channels].map(([name, entries]) => [
          name,
          {
            captures: entries.length,
            bytes: entries.reduce((n, text) => n + Buffer.byteLength(text), 0),
          },
        ]),
      );
    },
  };
}

// Observe product and configured fixture IdP outputs. Only the three credential
// fields of the exact token response are expected to deliver browser credentials.
export async function observeBrowserDisclosure(
  context,
  origin,
  disclosure,
  identityOrigin = origin,
) {
  if (context.pages().length || context.serviceWorkers().length)
    throw new Error("Browser disclosure requires a fresh context");
  const pending = [];
  const unresolved = new Set();
  const failed = {
    response: 0,
    headers: 0,
    body: 0,
    continuation: 0,
    console: 0,
    timeout: 0,
    targets: 0,
    requests: 0,
  };
  const observedPages = new Set();
  const preparedPages = new Set();
  const requestTrackers = new Map();
  const requestWaiters = new Set();
  let closing = false;
  const notifyRequests = () => {
    for (const wake of requestWaiters) wake();
    requestWaiters.clear();
  };
  const inflightCount = () => [...requestTrackers.values()].reduce((count, tracker) => count + tracker.size, 0);
  context.on("page", (page) => observedPages.add(page));
  context.on("serviceworker", () => {
    failed.targets++;
  });
  let tokenResponses = 0;
  let diagnosticPhase = "unavailable";
  let continuationDiagnostic;
  let requestDiagnostic;
  const origins = [...new Set([origin, identityOrigin])];
  const tokenUrl =
    identityOrigin + "/identity/realms/pdaa/protocol/openid-connect/token";
  const collect = (kind, task) =>
    pending.push(
      task.catch(() => {
        failed[kind]++;
      }),
    );
  const incomplete = () =>
    new Error("Browser disclosure capture incomplete", {
      cause: { ...failed, unresolved: unresolved.size },
    });
  const assertHealthy = () => {
    if (
      [...observedPages].some((page) => !preparedPages.has(page)) ||
      Object.values(failed).some(Boolean)
    )
      throw incomplete();
  };
  const assertComplete = () => {
    assertHealthy();
    if (unresolved.size) throw incomplete();
  };
  const drain = async (timeoutMs = 10000) => {
    let timer;
    try {
      await Promise.race([
        (async () => {
          for (let start = 0; start < pending.length; ) {
            const end = pending.length;
            await Promise.all(pending.slice(start, end));
            start = end;
          }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            failed.timeout++;
            reject(incomplete());
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const settleRequests = async (deadline, drainPhase) => {
    do {
      diagnosticPhase = "inflight";
      while (inflightCount()) {
        assertHealthy();
        const remaining = deadline - performance.now();
        if (remaining <= 0) { failed.timeout++; throw incomplete(); }
        let wake, timer;
        try {
          await Promise.race([
            new Promise((resolve) => { wake = resolve; requestWaiters.add(wake); }),
            new Promise((_, reject) => { timer = setTimeout(() => { failed.timeout++; reject(incomplete()); }, remaining); }),
          ]);
        } finally { requestWaiters.delete(wake); clearTimeout(timer); }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { failed.timeout++; throw incomplete(); }
      diagnosticPhase = drainPhase;
      await drain(remaining);
      assertHealthy();
    } while (inflightCount());
    assertComplete();
  };
  const capture = async (page) => {
    await capture.settle(page);
    diagnosticPhase = "completeness";
    assertComplete();
    if (!preparedPages.has(page)) throw incomplete();
    diagnosticPhase = "dom";
    disclosure.add("browser-dom", await page.content());
    diagnosticPhase = "storage";
    disclosure.add(
      "browser-storage",
      JSON.stringify(
        await page.evaluate(() => ({
          local: { ...window.localStorage },
          session: { ...window.sessionStorage },
        })),
      ),
    );
    await settleRequests(performance.now() + 10000, "drain_after_dom");
    diagnosticPhase = "completeness";
    assertComplete();
    diagnosticPhase = "token_seen";
    if (!tokenResponses)
      throw new Error("Expected token response was not observed");
    diagnosticPhase = "complete";
  };
  capture.diagnostic = () => ({
    phase: diagnosticPhase,
    counters: {
      response: failed.response, headers: failed.headers, body: failed.body,
      continuation: failed.continuation, console: failed.console, timeout: failed.timeout,
      targets: failed.targets, unresolved: unresolved.size,
      unprepared: [...observedPages].filter((page) => !preparedPages.has(page)).length,
      inflight: inflightCount(), requests: failed.requests,
    },
    tokenSeen: tokenResponses > 0,
    continuation: continuationDiagnostic,
    request: requestDiagnostic,
  });
  // Explicit test interactions must not navigate away while unrelated assets
  // are still loading; the recorder fails if their capture is cancelled.
  capture.settle = async (page) => {
    diagnosticPhase = "settle_health";
    assertHealthy();
    const deadline = performance.now() + 10000;
    diagnosticPhase = "networkidle";
    try { await page.waitForLoadState("networkidle", { timeout: 10000 }); }
    catch (error) { if (error?.name === "TimeoutError") failed.timeout++; throw error; }
    await settleRequests(deadline, "drain_before_dom");
    diagnosticPhase = "settle_complete";
    assertComplete();
  };
  // Chromium Fetch pauses the ORIGINAL response before application JavaScript
  // can consume it and navigate away. Continue without any request/response
  // override: native networking, certificate validation and cookies remain active.
  // https://chromedevtools.github.io/devtools-protocol/tot/Fetch/
  capture.newPage = async () => {
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const provisional = new Map();
    const requests = new Set();
    requestTrackers.set(page, requests);
    page.on("request", (request) => {
      if (inflightCount() >= 1024) { failed.requests++; notifyRequests(); return; }
      requests.add(request); notifyRequests();
    });
    const finished = (request) => { requests.delete(request); notifyRequests(); };
    page.on("requestfinished", finished);
    page.on("requestfailed", (request) => {
      if (requests.has(request)) collect("requests", (async () => {
        const diagnostic = { phase: "response" };
        let response;
        try {
        // Chromium can report a completed bodyless request as aborted. Only
        // POST or the observed access-grant DELETE, with the exact request's
        // same-origin 204 response, can qualify;
        // record its original headers for the same secret scan. Every other
        // failed request remains fatal, as do all independent CDP failures.
        response = await request.response();
        diagnostic.phase = "identity";
        if (!response || response.request() !== request) throw new Error("Failed request capture incomplete");
        diagnostic.phase = "eligibility";
        const method = request.method();
        const requestUrl = request.url();
        const parsedUrl = new URL(requestUrl);
        if (!(method === "POST" || (method === "DELETE" && parsedUrl.pathname === "/api/access-grants")) || response.status() !== 204 ||
            request.failure()?.errorText !== "net::ERR_ABORTED" || response.fromServiceWorker() !== false)
          throw new Error("Failed request capture incomplete");
        diagnostic.phase = "origin";
        if (response.url() !== requestUrl || !origins.includes(parsedUrl.origin))
          throw new Error("Failed request capture incomplete");
        diagnostic.phase = "headers";
        const headers = await response.headersArray();
        if (!Array.isArray(headers) || headers.some((item) => typeof item?.name !== "string" || typeof item?.value !== "string"))
          throw new Error("Failed request headers unavailable");
        disclosure.add("browser-response-headers", JSON.stringify(headers));
        disclosure.add("browser-bodyless-responses", JSON.stringify({ method, status: 204 }));
        } catch (error) {
          // Only inspect accessors after the capture decision has already failed;
          // diagnostic getters cannot turn a success into a failure or vice versa.
          try {
            const url = new URL(request.url());
            diagnostic.resource = "other";
            if (url.origin === origin) {
              if (url.pathname === "/api/access-grants") diagnostic.resource = "access_grants";
              else if (url.pathname === "/api/pm/action-queue") diagnostic.resource = "pm_queue";
              else if (/^\/api\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/scalar-reconciliation-requests(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)?$/i.test(url.pathname)) diagnostic.resource = "project";
            }
          } catch { /* unavailable */ }
          try { const method = request.method(); diagnostic.method = ["GET", "POST", "DELETE"].includes(method) ? method : "other"; } catch { /* unavailable */ }
          try { diagnostic.failure = request.failure()?.errorText === "net::ERR_ABORTED" ? "aborted" : "other"; } catch { /* unavailable */ }
          try {
            if (response === null) diagnostic.response = "none";
            else if (response) {
              const status = response.status();
              diagnostic.response = status === 204 ? "204" : Number.isInteger(status) && status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
            }
          } catch { /* unavailable */ }
          if (!requestDiagnostic) requestDiagnostic = diagnostic;
          throw error;
        }
      })());
      finished(request);
    });
    page.on("close", () => {
      if (!closing || requests.size) failed.targets++;
      requests.clear(); requestTrackers.delete(page); notifyRequests();
    });
    page.on("worker", () => {
      failed.targets++;
    });
    page.on("frameattached", () => {
      failed.targets++;
    });
    page.on("console", (message) => {
      disclosure.add("browser-console", message.text());
      collect(
        "console",
        (async () => {
          for (const argument of message.args()) {
            const value = await argument.jsonValue();
            disclosure.add(
              "browser-console",
              JSON.stringify(value) ?? "undefined",
            );
          }
        })(),
      );
    });
    page.on("pageerror", (error) =>
      disclosure.add("browser-errors", error.stack ?? String(error)),
    );
    session.on("Fetch.requestPaused", (event) => {
      collect(
        "response",
        (async () => {
          let phase = "headers";
          let branch = "response", resource = "other";
          try {
            const url = new URL(event.request.url);
            if (!origins.includes(url.origin))
              throw new Error("Unexpected disclosure response origin");
            if (url.pathname === "/api/pm/action-queue") resource = "pm_queue";
            else if (/^\/api\/projects(?:\/|$)/.test(url.pathname)) resource = "project";
            else if (url.pathname.startsWith("/identity/")) resource = "identity";
            const status = event.responseStatusCode;
            const method = event.request.method;
            const headers = event.responseHeaders;
            const identity = JSON.stringify([
              event.networkId,
              event.request.url,
              method,
            ]);
            // Chromium can emit an error pause before the same native request
            // later supplies its HTTP response. Continue that provisional event
            // unchanged, but require its matching headers and body before passing.
            // Identities stay private and are scoped to this CDP session.
            if (
              typeof event.responseErrorReason === "string" &&
              event.responseErrorReason.length > 0 &&
              status === undefined &&
              headers === undefined &&
              typeof event.networkId === "string" &&
              event.networkId.length > 0 &&
              typeof method === "string" &&
              method.length > 0
            ) {
              branch = "provisional";
              if (!provisional.has(identity)) {
                const record = {};
                provisional.set(identity, record);
                unresolved.add(record);
              }
              phase = "continuation";
              await session.send("Fetch.continueRequest", {
                requestId: event.requestId,
              });
              return;
            }
            if (
              event.responseErrorReason ||
              !Number.isInteger(status) ||
              !Array.isArray(headers)
            )
              throw new Error("Disclosure response unavailable");
            disclosure.add("browser-response-headers", JSON.stringify(headers));
            const redirect =
              [301, 302, 303, 307, 308].includes(status) &&
              headers.some(({ name }) => name.toLowerCase() === "location");
            const bodyless =
              method === "HEAD" || [204, 205, 304].includes(status) || redirect;
            if (bodyless) {
              disclosure.add(
                "browser-bodyless-responses",
                JSON.stringify({ method, status }),
              );
            } else {
              phase = "body";
              const result = await session.send("Fetch.getResponseBody", {
                requestId: event.requestId,
              });
              if (
                typeof result.body !== "string" ||
                typeof result.base64Encoded !== "boolean"
              )
                throw new Error("Disclosure response body unavailable");
              const body = Buffer.from(
                result.body,
                result.base64Encoded ? "base64" : "utf8",
              ).toString("utf8");
              if (
                url.href === tokenUrl &&
                status === 200 &&
                method === "POST"
              ) {
                disclosure.checkServerSecrets(body);
                let tokens;
                try {
                  tokens = JSON.parse(body);
                } catch {
                  throw new Error("Expected browser credentials unavailable");
                }
                const { access_token, id_token, refresh_token, ...rest } =
                  tokens;
                if (
                  typeof access_token !== "string" ||
                  typeof id_token !== "string"
                )
                  throw new Error("Expected browser credentials unavailable");
                disclosure.addSecrets(
                  [access_token, id_token, refresh_token].filter(
                    (value) => typeof value === "string",
                  ),
                );
                disclosure.add("identity-token-metadata", JSON.stringify(rest));
                tokenResponses++;
              } else disclosure.add("browser-response-bodies", body);
            }
            phase = "continuation";
            await session.send("Fetch.continueRequest", {
              requestId: event.requestId,
            });
            unresolved.delete(provisional.get(identity));
            provisional.delete(identity);
          } catch (error) {
            if (phase === "continuation" && !continuationDiagnostic) {
              try {
                const message = typeof error?.message === "string" ? error.message : "";
                const category = /Invalid InterceptionId/i.test(message) ? "invalid_interception"
                  : /Target (?:page|closed)|Session closed/i.test(message) ? "target_closed" : "other";
                const closed = typeof page.isClosed === "function" ? (page.isClosed() ? "closed" : "open") : "unknown";
                continuationDiagnostic = safeContinuationDiagnostic({ branch, resource, error: category, page: closed });
              } catch { continuationDiagnostic = safeContinuationDiagnostic(undefined); }
            }
            failed[phase]++;
            await session
              .send("Fetch.failRequest", {
                requestId: event.requestId,
                errorReason: "Aborted",
              })
              .catch(() => {});
            // Do not attach raw protocol errors, which may contain credentials.
            // eslint-disable-next-line preserve-caught-error
            throw new Error("Disclosure response capture failed");
          }
        })(),
      );
    });
    try {
      await session.send("Fetch.enable", {
        patterns: origins.map((value) => ({
          urlPattern: value + "/*",
          requestStage: "Response",
        })),
      });
    } catch {
      failed.response++;
      throw incomplete();
    }
    preparedPages.add(page);
    return page;
  };
  capture.close = async () => {
    // Finish already queued original-body reads and continuation acknowledgements
    // before destroying their CDP target. Cleanup still runs if capture failed.
    try {
      await settleRequests(performance.now() + 10000, "drain_after_dom");
      assertComplete();
    } finally {
      closing = true;
      await context.close();
    }
    await drain();
    assertComplete();
  };
  return capture;
}

export async function scanBrowserAssets(base, disclosure) {
  const get = async (path) => {
    const response = await fetch(base + "/" + path, {
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200)
      throw new Error("Shipped disclosure asset unavailable");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error("Shipped disclosure asset empty");
    disclosure.add("asset-headers", JSON.stringify([...response.headers]));
    disclosure.add("assets", bytes.toString("utf8"));
    return bytes;
  };
  let manifest;
  const manifestBytes = await get("third-party-components.json");
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Shipped asset inventory unavailable");
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.assets) ||
    !manifest.assets.length
  )
    throw new Error("Shipped asset inventory unavailable");
  for (const asset of manifest.assets) {
    if (
      typeof asset.file !== "string" ||
      !/^[A-Za-z0-9_./-]+$/.test(asset.file) ||
      asset.file.startsWith("/") ||
      asset.file.includes("..")
    )
      throw new Error("Invalid disclosure asset path");
    const bytes = await get(asset.file);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error("Disclosure asset differs from shipped inventory");
  }
  await get("THIRD_PARTY_NOTICES.txt");
  return manifest.assets.length + 2;
}

export function scanExecutionLogs(output, disclosure, prefix = "") {
  for (const file of readdirSync(output)) {
    if (
      !file.startsWith(prefix) ||
      !file.endsWith(".log") ||
      file.startsWith("build-")
    )
      continue;
    const text = readFileSync(join(output, file), "utf8");
    disclosure.add("execution-logs", text);
    rejectLoggedTokens(text);
  }
}

export function rejectLoggedTokens(text) {
  // Fixture OIDC uses signed JWTs. This also catches token values issued inside
  // the browser container without exporting them to the host's evidence bundle.
  if (/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/.test(text))
    throw new Error("Credential-shaped token disclosed in logs");
}

// The host does not own the container's private secret files. Check captured
// output inside the existing verifier instead of weakening fixture permissions
// or transmitting secret values through a command's stdout.
export function createHostDisclosure({
  output,
  run,
  command,
  runId,
  profile = "production",
}) {
  const captures = [];
  let sequence = 0;
  return {
    add(channel, text) {
      if (typeof text !== "string")
        throw new Error("Disclosure capture unavailable");
      captures.push({ channel, text });
    },
    verify(required) {
      const name = "disclosure-host-" + ++sequence;
      writeFileSync(
        join(output, name + ".input.json"),
        JSON.stringify({ captures, required }),
        { mode: 0o600 },
      );
      run(command(name), name);
      let receipt;
      try {
        receipt = JSON.parse(
          readFileSync(join(output, name + ".receipt.json"), "utf8"),
        );
      } catch {
        throw new Error("Host disclosure verification incomplete");
      }
      if (
        receipt.status !== "passed" ||
        receipt.runId !== runId ||
        receipt.profile !== profile ||
        receipt.phase !== name ||
        required.some((channel) => !(receipt.channels?.[channel]?.bytes > 0))
      )
        throw new Error("Host disclosure verification incomplete");
      return receipt.channels;
    },
  };
}
