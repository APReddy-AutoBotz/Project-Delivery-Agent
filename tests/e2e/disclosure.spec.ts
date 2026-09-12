import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  createDisclosureCheck,
  observeBrowserDisclosure,
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

test("SEC-SECRET-001: Chromium captures original responses before immediate navigation", async ({
  browser,
}) => {
  const canary = randomBytes(32).toString("base64url");
  const tokens = {
    access_token: randomBytes(32).toString("base64url"),
    id_token: randomBytes(32).toString("base64url"),
  };
  const tokenPath = "/identity/realms/pdaa/protocol/openid-connect/token";
  let leaked = false;
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
    } else if (path === "/empty") {
      response.writeHead(204, { "X-Public": "bodyless" });
      response.end();
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        path === "/complete"
          ? "<h1>Complete</h1>"
          : `<script>
        fetch('${tokenPath}',{method:'POST'}).then(r=>r.json())
          .then(()=>fetch('/empty',{method:'POST'}))
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
  try {
    for (const inject of [false, true, false]) {
      leaked = inject;
      const before = metadataRequests;
      const check = createDisclosureCheck([canary]);
      const context = await browser.newContext();
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
        if (inject)
          expect(() => check.verify(["browser-response-bodies"])).toThrow(
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
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
