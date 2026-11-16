// FR-CON-006/007: real file-bearing FormData metadata, without replacing native requests.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  observeCsvPreviewCommand,
  readCsvPreviewCommand,
  restoreCsvPreviewCommand,
} from "../../scripts/acceptance/csv-import-preview-command.mjs";

test.use({ trace: "off", screenshot: "off", video: "off" });
for (const mode of [
  "original",
  "extra-field",
  "duplicate-field",
  "invalid-file",
] as const) {
  test(`CSV preview command observes original file form: ${mode}`, async ({
    browser,
  }) => {
    const sourceId = randomUUID(),
      commandKey = randomUUID(),
      receiptId = randomUUID();
    const path = `/api/ingestion/sources/${sourceId}/csv-previews`;
    const csv = "Identity,Private\nfixture-key,fixture-private-cell\n";
    let posts = 0,
      originalFieldsReceived = false;
    const server = createServer((request, response) => {
      if (request.url === path && request.method === "POST") {
        posts++;
        const parts: Buffer[] = [];
        request.on("data", (chunk) => parts.push(Buffer.from(chunk)));
        request.on("end", () => {
          const body = Buffer.concat(parts).toString("utf8");
          originalFieldsReceived =
            body.includes(csv) &&
            body.includes(commandKey) &&
            /multipart\/form-data; boundary=/.test(
              request.headers["content-type"] ?? "",
            );
          response.writeHead(201, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({ receiptId, replayed: false, rowCount: 1 }),
          );
        });
      } else {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<!doctype html><p>CSV original FormData</p>");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    try {
      context = await browser.newContext();
      page = await context.newPage();
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("CSV loopback unavailable");
      const base = `http://127.0.0.1:${address.port}`;
      await page.goto(base);
      await page.evaluate(() => {
        const original = window.fetch;
        const state = window as unknown as {
          csvOriginalForm?: FormData;
          csvBodyIdentity?: boolean;
          csvResponse?: Response;
          csvObserverNative?: typeof fetch;
        };
        window.fetch = async function (...args: Parameters<typeof fetch>) {
          state.csvBodyIdentity = args[1]?.body === state.csvOriginalForm;
          const response = await original.apply(this, args);
          state.csvResponse = response;
          return response;
        };
        state.csvObserverNative = window.fetch;
      });
      await observeCsvPreviewCommand(page, { base, sourceId });
      for (const url of [base, base + path]) {
        expect(
          await page.evaluate(async (target) => {
            const response = await fetch(target);
            const same =
              response ===
              (window as unknown as { csvResponse?: Response }).csvResponse;
            await response.arrayBuffer();
            return same;
          }, url),
        ).toBe(true);
      }
      const result = await page.evaluate(
        async ({ url, commandKey, mode, csv }) => {
          const form = new FormData();
          form.set("commandKey", commandKey);
          form.set("configRevision", "1");
          form.set("mappingRevision", "1");
          if (mode === "invalid-file") form.set("file", "not a file");
          else
            form.set(
              "file",
              new File([csv], "fixture-private-name.csv", { type: "text/csv" }),
            );
          if (mode === "extra-field") form.set("baseline", "untrusted");
          if (mode === "duplicate-field") form.append("commandKey", commandKey);
          const state = window as unknown as {
            csvOriginalForm?: FormData;
            csvBodyIdentity?: boolean;
            csvResponse?: Response;
          };
          state.csvOriginalForm = form;
          try {
            const response = await fetch(url, { method: "POST", body: form });
            const sameResponse = response === state.csvResponse;
            const value = await response.json();
            return {
              sameBody: state.csvBodyIdentity,
              sameResponse,
              status: response.status,
              value,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : "unknown",
            };
          }
        },
        { url: base + path, commandKey, mode, csv },
      );
      if (mode === "original") {
        expect(result).toEqual({
          sameBody: true,
          sameResponse: true,
          status: 201,
          value: { receiptId, replayed: false, rowCount: 1 },
        });
        expect(await readCsvPreviewCommand(page)).toEqual({
          commandKey,
          configRevision: 1,
          mappingRevision: 1,
        });
        expect(posts).toBe(1);
        expect(originalFieldsReceived).toBe(true);
      } else {
        expect(result).toEqual({
          error: "CSV preview command observation failed",
        });
        await expect(readCsvPreviewCommand(page)).rejects.toThrow(
          "CSV preview command observation failed",
        );
        expect(posts).toBe(0);
      }
      // Matching second and later calls fail without a second native request.
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await page.evaluate(async (url) => {
            try {
              await fetch(url, {
                method: "POST",
                body: (window as unknown as { csvOriginalForm: FormData })
                  .csvOriginalForm,
              });
              return "unexpected success";
            } catch (error) {
              return error instanceof Error ? error.message : "unknown";
            }
          }, base + path),
        ).toBe("CSV preview command observation failed");
      }
      expect(posts).toBe(mode === "original" ? 1 : 0);
      await expect(readCsvPreviewCommand(page)).rejects.toThrow(
        "CSV preview command observation failed",
      );
      await restoreCsvPreviewCommand(page);
      expect(
        await page.evaluate(
          () =>
            window.fetch ===
              (window as unknown as { csvObserverNative: typeof fetch })
                .csvObserverNative &&
            !Object.hasOwn(window, "__pdaaCsvPreviewCommand"),
        ),
      ).toBe(true);
      // Removing the observer leaves the original native wrapper usable.
      expect(
        await page.evaluate(async (base) => (await fetch(base)).status, base),
      ).toBe(200);
    } finally {
      try {
        if (page && !page.isClosed()) await restoreCsvPreviewCommand(page);
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
