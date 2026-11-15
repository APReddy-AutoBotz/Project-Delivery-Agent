// FR-CON-006/007 / EXEC-009: controlled verifier-only acknowledgement loss.
// The native response must finish before the App receives the induced rejection.
import assert from "node:assert/strict";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function installCsvDeliveryLoss(page, options) {
  const origin = new URL(options.base);
  assert(
    !origin.username && !origin.password && !origin.search && !origin.hash,
  );
  assert.equal(origin.pathname, "/");
  assert(
    origin.origin === "https://web:8443" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(origin.hostname)),
    "Controlled CSV verifier origin required",
  );
  assert.match(options.sourceId, uuid);
  assert.match(options.previewReceiptId, uuid);
  assert(
    Array.isArray(options.rowOrdinals) &&
      options.rowOrdinals.length > 0 &&
      options.rowOrdinals.length <= 1000,
  );
  assert(
    options.rowOrdinals.every(
      (row, index, rows) =>
        Number.isSafeInteger(row) &&
        row >= 1 &&
        row <= 1000 &&
        (index === 0 || row > rows[index - 1]),
    ),
  );
  await page.evaluate(
    ({ target, parent, ordinals }) => {
      if (Object.hasOwn(window, "__pdaaCsvDeliveryLoss"))
        throw new Error("CSV verifier already installed");
      const nativeFetch = window.fetch;
      const state = {
        posts: [],
        attempts: 0,
        first: null,
        failure: null,
        armed: true,
        nativeFetch,
        wrapper: null,
      };
      const fail = (code) => {
        state.failure ??= code;
        throw new Error("CSV acknowledgement observation failed");
      };
      const equalKeys = (value, expected) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(",") === [...expected].sort().join(",");
      const validUuid = (value) =>
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          value,
        );
      state.wrapper = async function (...args) {
        const [input, init] = args;
        let url;
        try {
          if (typeof input === "string")
            url = new URL(input, globalThis.location.href);
          else if (input instanceof globalThis.Request || input instanceof URL)
            url = new URL(input.url ?? input.href);
          else return nativeFetch.apply(this, args);
        } catch {
          return nativeFetch.apply(this, args);
        }
        if (url.href !== target) return nativeFetch.apply(this, args);
        const method = String(
          init?.method ??
            (input instanceof globalThis.Request ? input.method : "GET"),
        ).toUpperCase();
        if (method !== "POST") return nativeFetch.apply(this, args);
        if (state.failure !== null) return fail(state.failure);
        state.attempts = Math.min(3, state.attempts + 1);
        if (state.attempts > 2) return fail("REQUEST_COUNT");
        const body = init?.body;
        if (
          typeof body !== "string" ||
          new globalThis.TextEncoder().encode(body).byteLength > 65536
        )
          return fail("REQUEST_SHAPE");
        let command;
        try {
          command = JSON.parse(body);
        } catch {
          return fail("REQUEST_SHAPE");
        }
        if (
          !equalKeys(command, [
            "previewReceiptId",
            "rowOrdinals",
            "commandKey",
          ]) ||
          JSON.stringify(command) !== body ||
          command.previewReceiptId !== parent ||
          !validUuid(command.commandKey) ||
          JSON.stringify(command.rowOrdinals) !== JSON.stringify(ordinals)
        )
          return fail("REQUEST_BINDING");
        state.posts.push(body);
        if (state.posts.some((value) => value !== state.posts[0]))
          return fail("REQUEST_REPLAY");
        const intercept = state.armed;
        state.armed = false;
        let response;
        try {
          response = await nativeFetch.apply(this, args);
        } catch {
          return fail("NATIVE_FETCH");
        }
        if (!intercept) return response;
        if (
          response.status !== 201 ||
          response.redirected ||
          response.url !== target ||
          response.headers
            .get("content-type")
            ?.split(";", 1)[0]
            .trim()
            .toLowerCase() !== "application/json" ||
          !response.body
        )
          return fail("RESPONSE_BINDING");
        let reader;
        try {
          reader = response.body.getReader();
        } catch {
          return fail("READER");
        }
        const chunks = [];
        let total = 0,
          reachedEof = false,
          released = false,
          failed = false;
        const deadline = performance.now() + 10000;
        try {
          while (!reachedEof) {
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw new Error("CSV verifier deadline");
            let timer;
            const next = await Promise.race([
              reader.read(),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("CSV verifier deadline")),
                  remaining,
                );
              }),
            ]).finally(() => clearTimeout(timer));
            if (next.done) {
              reachedEof = true;
              break;
            }
            if (
              !(next.value instanceof Uint8Array) ||
              total + next.value.byteLength > 65536
            )
              throw new Error("CSV verifier body bound");
            if (next.value.byteLength === 0) continue;
            chunks.push(next.value.slice());
            total += next.value.byteLength;
          }
        } catch {
          failed = true;
          state.failure ??= "BODY_INCOMPLETE";
          // Cleanup cannot turn an incomplete observation into the intended fault.
          let cleanupTimer;
          try {
            await Promise.race([
              Promise.resolve()
                .then(() => reader.cancel())
                .catch(() => {}),
              new Promise((resolve) => {
                cleanupTimer = setTimeout(resolve, 500);
              }),
            ]);
          } finally {
            clearTimeout(cleanupTimer);
          }
        } finally {
          try {
            reader.releaseLock();
            released = true;
          } catch {
            failed = true;
            state.failure ??= "RELEASE";
          }
        }
        if (failed || !reachedEof || !released) {
          for (const chunk of chunks) chunk.fill(0);
          chunks.length = 0;
          return fail("BODY_INCOMPLETE");
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
          chunk.fill(0);
        }
        chunks.length = 0;
        let acknowledgement;
        try {
          acknowledgement = JSON.parse(
            new globalThis.TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          bytes.fill(0);
          return fail("ACK_SHAPE");
        }
        if (
          !equalKeys(acknowledgement, [
            "receiptId",
            "parentPreviewReceiptId",
            "replayed",
            "rowCount",
          ]) ||
          !validUuid(acknowledgement.receiptId) ||
          acknowledgement.parentPreviewReceiptId !== parent ||
          acknowledgement.replayed !== false ||
          acknowledgement.rowCount !== ordinals.length
        ) {
          bytes.fill(0);
          return fail("ACK_BINDING");
        }
        let digest;
        try {
          digest = [
            ...new Uint8Array(
              await globalThis.crypto.subtle.digest("SHA-256", bytes),
            ),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join("");
        } catch {
          bytes.fill(0);
          return fail("ACK_DIGEST");
        }
        state.first = {
          status: 201,
          bytes: total,
          sha256: digest,
          body: acknowledgement,
          eof: true,
          released: true,
        };
        bytes.fill(0);
        throw new TypeError("Synthetic CSV acknowledgement delivery withheld");
      };
      window.__pdaaCsvDeliveryLoss = state;
      window.fetch = state.wrapper;
    },
    {
      target:
        origin.origin +
        `/api/ingestion/sources/${options.sourceId}/reviewed-imports`,
      parent: options.previewReceiptId,
      ordinals: options.rowOrdinals,
    },
  );
}

export async function readCsvDeliveryLoss(page) {
  return page.evaluate(() => {
    const state = window.__pdaaCsvDeliveryLoss;
    if (!state) throw new Error("CSV verifier unavailable");
    return {
      posts: [...state.posts],
      attempts: state.attempts,
      first: state.first,
      failure: state.failure,
      armed: state.armed,
    };
  });
}

export async function restoreCsvDeliveryLoss(page) {
  await page.evaluate(() => {
    const state = window.__pdaaCsvDeliveryLoss;
    if (!state) return;
    if (window.fetch !== state.wrapper)
      throw new Error("CSV verifier wrapper changed");
    window.fetch = state.nativeFetch;
    delete window.__pdaaCsvDeliveryLoss;
  });
}
