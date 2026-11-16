import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { verifyBrowserToolchain } from "../../scripts/acceptance/browser-toolchain.mjs";
import {
  createDisclosureCheck,
  observeBrowserDisclosure,
} from "../../scripts/acceptance/disclosure.mjs";
import {
  installCsvDeliveryLoss,
  readCsvDeliveryLoss,
  restoreCsvDeliveryLoss,
} from "../../scripts/acceptance/csv-import-delivery-loss.mjs";

// Synthetic recorder controls, separate from the genuine packaged CSV journey.
test.use({ trace: "off", screenshot: "off", video: "off" });
test.beforeAll(async ({ browser }) => {
  console.log(
    "CSV recorder toolchain: " +
      JSON.stringify(verifyBrowserToolchain(browser)),
  );
});
for (const mode of ["plain", "body-canary", "header-canary"] as const) {
  test(`CSV acknowledgement delivery loss preserves original capture: ${mode}`, async ({
    browser,
  }) => {
    const sourceId = randomUUID(),
      parent = randomUUID(),
      publicId = randomUUID(),
      canary = randomUUID();
    const path = `/api/ingestion/sources/${sourceId}/reviewed-imports`;
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><h1>CSV acknowledgement fixture</h1>");
      } else if (request.url === path && request.method === "POST") {
        request.resume();
        request.on("end", () => {
          posts++;
          response.writeHead(201, {
            "Content-Type": "application/json",
            ...(mode === "header-canary" && posts === 1
              ? { "Set-Cookie": `fixture=${canary}; Path=/` }
              : {}),
          });
          const acknowledgement = JSON.stringify({
            receiptId: publicId,
            parentPreviewReceiptId: parent,
            replayed: posts > 1,
            rowCount: 1,
          });
          // A duplicate overwritten metadata key tests original-byte scanning
          // and ensures minimized exported metadata contains no hidden value.
          response.end(
            mode === "body-canary" && posts === 1
              ? `{"receiptId":${JSON.stringify(canary)},${acknowledgement.slice(1)}`
              : acknowledgement,
          );
        });
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ public: true }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("CSV loopback unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      const check = createDisclosureCheck([canary]);
      context = await browser.newContext();
      const capture = await observeBrowserDisclosure(context, base, check);
      page = await capture.newPage();
      await page.goto(base);
      await capture.settle(page);
      await page.evaluate(() => {
        const native = window.fetch;
        const state = window as unknown as { lastNative?: Response };
        window.fetch = async function (...args: Parameters<typeof fetch>) {
          const response = await native.apply(this, args);
          state.lastNative = response;
          if (response.status === 201 && response.body) {
            const counts = { acquired: 0, eof: 0, released: 0 };
            const observation = window as unknown as {
              csvReaders?: (typeof counts)[];
            };
            (observation.csvReaders ??= []).push(counts);
            const getReader = response.body.getReader.bind(response.body);
            response.body.getReader = (() => {
              counts.acquired++;
              const reader = getReader();
              const read = reader.read.bind(reader),
                release = reader.releaseLock.bind(reader);
              reader.read = (async () => {
                const value = await read();
                if (value.done) counts.eof++;
                return value;
              }) as typeof reader.read;
              reader.releaseLock = () => {
                release();
                counts.released++;
              };
              return reader;
            }) as typeof response.body.getReader;
          }
          return response;
        };
      });
      await installCsvDeliveryLoss(page, {
        base,
        sourceId,
        previewReceiptId: parent,
        rowOrdinals: [3],
      });
      // A nonmatching URL and a nonmatching method preserve the actual response.
      for (const url of [base + "/unrelated", base + path]) {
        expect(
          await page.evaluate(async (target) => {
            const response = await fetch(target);
            const identical =
              response ===
              (window as unknown as { lastNative?: Response }).lastNative;
            await response.arrayBuffer();
            return identical;
          }, url),
        ).toBe(true);
      }
      const body = JSON.stringify({
        previewReceiptId: parent,
        rowOrdinals: [3],
        commandKey: randomUUID(),
      });
      const finished = page.waitForEvent(
        "requestfinished",
        (request) =>
          request.url() === base + path && request.method() === "POST",
      );
      const failed: unknown[] = [];
      page.on("requestfailed", (request) => {
        if (request.url() === base + path) failed.push(request);
      });
      expect(
        await page.evaluate(
          async ({ target, body }) => {
            try {
              await fetch(target, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
              });
              return "unexpected";
            } catch (error) {
              return error instanceof TypeError
                ? error.message
                : "wrong failure";
            }
          },
          { target: base + path, body },
        ),
      ).toBe("Synthetic CSV acknowledgement delivery withheld");
      await finished;
      await capture.settle(page);
      const first = await readCsvDeliveryLoss(page);
      expect(first.failure).toBeNull();
      expect(first.first).toMatchObject({
        status: 201,
        eof: true,
        released: true,
        body: { parentPreviewReceiptId: parent, replayed: false, rowCount: 1 },
      });
      expect(first.first).not.toHaveProperty("bodyBase64");
      expect(first.posts).toEqual([body]);
      expect(JSON.stringify(first).includes(canary)).toBe(false);
      expect(posts).toBe(1);
      expect(failed).toHaveLength(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { csvReaders: unknown[] }).csvReaders[0],
        ),
      ).toEqual({ acquired: 1, eof: 1, released: 1 });
      if (mode !== "plain")
        expect(() =>
          check.verify([
            mode === "body-canary"
              ? "browser-response-bodies"
              : "browser-response-headers",
          ]),
        ).toThrow(/^Secret disclosure detected$/);
      expect(
        await page.evaluate(
          async ({ target, body }) => {
            const response = await fetch(target, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            });
            const identical =
              response ===
              (window as unknown as { lastNative?: Response }).lastNative;
            const value = (await response.json()) as { replayed: boolean };
            return {
              identical,
              replayed: value.replayed,
              status: response.status,
            };
          },
          { target: base + path, body },
        ),
      ).toEqual({ identical: true, replayed: true, status: 201 });
      await capture.settle(page);
      expect((await readCsvDeliveryLoss(page)).posts).toEqual([body, body]);
      expect(posts).toBe(2);
      if (mode === "plain") {
        // Repeated invalid calls cannot retain additional POST bodies.
        await page.evaluate(
          async ({ target, body }) => {
            for (let i = 0; i < 8; i++)
              await fetch(target, { method: "POST", body }).catch(() => {});
          },
          { target: base + path, body },
        );
        const bounded = await readCsvDeliveryLoss(page);
        expect(bounded.posts).toHaveLength(2);
        expect(bounded.attempts).toBe(3);
        expect(bounded.failure).toBe("REQUEST_COUNT");
        expect(posts).toBe(2);
      }
      await restoreCsvDeliveryLoss(page);
      await capture.close();
      if (mode === "plain")
        expect(() =>
          check.verify(["browser-response-headers", "browser-response-bodies"]),
        ).not.toThrow();
      else
        expect(() =>
          check.verify([
            mode === "body-canary"
              ? "browser-response-bodies"
              : "browser-response-headers",
          ]),
        ).toThrow(/^Secret disclosure detected$/);
    } finally {
      try {
        if (page && !page.isClosed()) await restoreCsvDeliveryLoss(page);
      } finally {
        try {
          await context?.close();
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  });
}

// These are isolated verifier failure controls. No result is packaged-product evidence.
for (const mode of [
  "wrong-status",
  "wrong-parent",
  "already-replayed",
  "malformed",
  "extra-field",
  "invalid-utf8",
  "oversized",
  "truncated",
  "reader-error",
  "release-error",
  "held-body",
] as const) {
  test(`CSV delivery verifier fails closed: ${mode}`, async ({ browser }) => {
    const sourceId = randomUUID(),
      parent = randomUUID();
    const path = `/api/ingestion/sources/${sourceId}/reviewed-imports`;
    let posts = 0;
    const server = createServer((request, response) => {
      if (request.url !== path) {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><p>Verifier failure control</p>");
        return;
      }
      posts++;
      request.resume();
      request.on("end", () => {
        const value = {
          receiptId: randomUUID(),
          parentPreviewReceiptId:
            mode === "wrong-parent" ? randomUUID() : parent,
          replayed: mode === "already-replayed",
          rowCount: 1,
          ...(mode === "extra-field" ? { private: "unrequested" } : {}),
        };
        const body =
          mode === "malformed"
            ? "{invalid"
            : mode === "oversized"
              ? " ".repeat(65537)
              : JSON.stringify(value);
        response.writeHead(mode === "wrong-status" ? 200 : 201, {
          "Content-Type": "application/json",
          ...(mode === "truncated" ? { "Content-Length": "10000" } : {}),
        });
        if (mode === "held-body") {
          response.write("{");
          return;
        }
        if (mode === "invalid-utf8") {
          response.end(Buffer.from([0xc3, 0x28]));
          return;
        }
        response.end(body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("CSV control unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      // Intentionally no CDP recorder: held-body control must reach the App reader.
      context = await browser.newContext();
      page = await context.newPage();
      await page.goto(base);
      if (mode === "reader-error" || mode === "release-error")
        await page.evaluate((failure) => {
          const native = window.fetch;
          window.fetch = async function (...args: Parameters<typeof fetch>) {
            const response = await native.apply(this, args);
            if (response.body) {
              const getReader = response.body.getReader.bind(response.body);
              response.body.getReader = (() => {
                const reader = getReader();
                if (failure === "reader-error")
                  reader.read = (() =>
                    Promise.reject(
                      new Error("synthetic reader failure"),
                    )) as typeof reader.read;
                else {
                  const release = reader.releaseLock.bind(reader);
                  reader.releaseLock = () => {
                    release();
                    throw new Error("synthetic release failure");
                  };
                }
                return reader;
              }) as typeof response.body.getReader;
            }
            return response;
          };
        }, mode);
      await installCsvDeliveryLoss(page, {
        base,
        sourceId,
        previewReceiptId: parent,
        rowOrdinals: [3],
      });
      const body = JSON.stringify({
        previewReceiptId: parent,
        rowOrdinals: [3],
        commandKey: randomUUID(),
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await page.evaluate(
            async ({ url, body }) => {
              try {
                await fetch(url, { method: "POST", body });
                return "unexpected success";
              } catch (error) {
                return error instanceof Error
                  ? error.message
                  : "unexpected error";
              }
            },
            { url: base + path, body },
          ),
        ).toBe("CSV acknowledgement observation failed");
      }
      const state = await readCsvDeliveryLoss(page);
      expect(state.first).toBeNull();
      expect(state.posts).toEqual([body]);
      expect(state.failure).toBe(
        mode === "wrong-status"
          ? "RESPONSE_BINDING"
          : ["wrong-parent", "already-replayed", "extra-field"].includes(mode)
            ? "ACK_BINDING"
            : ["malformed", "invalid-utf8"].includes(mode)
              ? "ACK_SHAPE"
              : mode === "release-error"
                ? "RELEASE"
                : "BODY_INCOMPLETE",
      );
      expect(posts).toBe(1);
    } finally {
      try {
        if (page && !page.isClosed()) await restoreCsvDeliveryLoss(page);
      } finally {
        try {
          await context?.close();
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  });
}
