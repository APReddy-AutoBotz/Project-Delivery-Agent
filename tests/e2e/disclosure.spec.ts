import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  createDisclosureCheck,
  observeBrowserDisclosure,
} from "../../scripts/acceptance/disclosure.mjs";

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
