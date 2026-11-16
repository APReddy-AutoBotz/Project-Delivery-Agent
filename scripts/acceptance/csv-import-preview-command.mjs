// FR-CON-006/007: observe only command metadata on the original FormData.
// Chromium may omit file-bearing multipart postData from the Playwright request.
import assert from "node:assert/strict";

export async function observeCsvPreviewCommand(page, { base, sourceId }) {
  const origin = new URL(base);
  assert(
    !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash &&
      origin.pathname === "/",
  );
  assert(
    origin.origin === "https://web:8443" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)),
  );
  assert(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      sourceId,
    ),
  );
  await page.evaluate(
    (target) => {
      if (Object.hasOwn(window, "__pdaaCsvPreviewCommand"))
        throw new Error("CSV preview observer already installed");
      const state = {
        native: window.fetch,
        wrapper: null,
        calls: 0,
        command: null,
        failure: false,
      };
      const fail = () => {
        state.failure = true;
        throw new Error("CSV preview command observation failed");
      };
      state.wrapper = async function (...args) {
        const [input, init] = args;
        let url;
        try {
          url =
            typeof input === "string"
              ? new URL(input, globalThis.location.href).href
              : input instanceof URL
                ? input.href
                : input instanceof globalThis.Request
                  ? input.url
                  : null;
        } catch {
          return state.native.apply(this, args);
        }
        if (url !== target) return state.native.apply(this, args);
        const method = String(
          init?.method ??
            (input instanceof globalThis.Request ? input.method : "GET"),
        ).toUpperCase();
        if (method !== "POST") return state.native.apply(this, args);
        if (state.failure || state.calls !== 0) return fail();
        state.calls = 1;
        const form = init?.body;
        if (!(form instanceof globalThis.FormData)) return fail();
        const allowed = new Set([
          "commandKey",
          "configRevision",
          "file",
          "mappingRevision",
        ]);
        const seen = new Set();
        for (const key of form.keys()) {
          if (seen.size === 4 || !allowed.has(key) || seen.has(key))
            return fail();
          seen.add(key);
        }
        if (seen.size !== 4) return fail();
        const commandKey = form.get("commandKey"),
          config = form.get("configRevision"),
          mapping = form.get("mappingRevision"),
          file = form.get("file");
        if (
          typeof commandKey !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            commandKey,
          ) ||
          config !== "1" ||
          mapping !== "1" ||
          !(file instanceof globalThis.File) ||
          file.size < 1 ||
          file.size > 1048576
        )
          return fail();
        state.command = { commandKey, configRevision: 1, mappingRevision: 1 };
        try {
          return await state.native.apply(this, args);
        } catch {
          return fail();
        }
      };
      window.__pdaaCsvPreviewCommand = state;
      window.fetch = state.wrapper;
    },
    origin.origin + `/api/ingestion/sources/${sourceId}/csv-previews`,
  );
}

export async function readCsvPreviewCommand(page) {
  return page.evaluate(() => {
    const state = window.__pdaaCsvPreviewCommand;
    if (!state || state.failure || state.calls !== 1 || !state.command)
      throw new Error("CSV preview command observation failed");
    return { ...state.command };
  });
}
export async function restoreCsvPreviewCommand(page) {
  await page.evaluate(() => {
    const state = window.__pdaaCsvPreviewCommand;
    if (!state) return;
    if (window.fetch !== state.wrapper)
      throw new Error("CSV preview observer wrapper changed");
    window.fetch = state.native;
    delete window.__pdaaCsvPreviewCommand;
  });
}
