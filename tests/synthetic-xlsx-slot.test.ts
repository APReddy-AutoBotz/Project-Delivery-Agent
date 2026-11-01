import { afterEach, expect, it, vi } from "vitest";
import { SyntheticXlsxSlot } from "../apps/api/src/synthetic-xlsx-slot.js";
import { encodeSyntheticXlsxRequest, encodeSyntheticXlsxResponse, SyntheticXlsxFrameDecoder } from "../packages/domain/src/synthetic-xlsx-frame.js";

const codec = {
  encode: encodeSyntheticXlsxRequest,
  response: (expected: { job: string; generation: string }) => {
    const decoder = new SyntheticXlsxFrameDecoder("response", expected);
    return { push: (chunk: unknown) => decoder.push(chunk), finish: () => {
      const result = decoder.finish();
      if (result.kind !== "response") throw new Error("bad codec");
      return result;
    } };
  },
};
const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const bytes = async function* (...parts: Uint8Array[]) { for (const part of parts) yield part; };
const request = (chunks = bytes(Uint8Array.of(5, 6)), length = 2, timeoutMs = 1000) =>
  ({ chunks, length, timeoutMs, parser: "synthetic.v1", sheet: "Confidential sheet" });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const successPort = () => ({
  exchange: async function* (frame: Uint8Array) {
    const decoder = new SyntheticXlsxFrameDecoder("request"); decoder.push(frame);
    const input = decoder.finish();
    if (input.kind !== "request") throw new Error("bad request");
    const result = encodeSyntheticXlsxResponse({ job: input.header.job, generation: input.header.generation, status: "OK" }, Uint8Array.of(9));
    yield result.subarray(0, 3); yield result.subarray(3);
  },
  reset: async (_previous: string, next: string) => next,
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("returns a correlated opaque response and resets every successful lease", async () => {
  const port = successPort(), reset = vi.spyOn(port, "reset");
  const slot = new SyntheticXlsxSlot(codec, port, 2, 10);
  expect(await slot.submit(request())).toEqual(Uint8Array.of(9));
  await flush();
  expect(reset).toHaveBeenCalledTimes(1);
  expect(reset.mock.calls[0]![0]).toMatch(/^[0-9a-f]{32}$/);
  expect(reset.mock.calls[0]![1]).not.toBe(reset.mock.calls[0]![0]);
  expect(slot.snapshot()).toEqual({ state: "IDLE", jobs: 0, reserved: 0 });
});

it("uses distinct job and generation identities across successive leases", async () => {
  const seen: string[] = [], base = successPort();
  const slot = new SyntheticXlsxSlot(codec, { ...base, exchange: (frame) => {
    const decoder = new SyntheticXlsxFrameDecoder("request"); decoder.push(frame); const input = decoder.finish();
    if (input.kind !== "request") throw new Error("bad request");
    seen.push(input.header.job, input.header.generation);
    return base.exchange(frame);
  } }, 1, 2);
  await slot.submit(request()); await flush();
  await slot.submit(request()); await flush();
  expect(new Set(seen).size).toBe(4);
  expect(seen.every((value) => /^[0-9a-f]{32}$/.test(value))).toBe(true);
});

it("bounds admission and reserves before starting queued input", async () => {
  const gate = pending<void>(), base = successPort();
  let inputStarts = 0;
  const port = { ...base, reset: async (_previous: string, next: string) => { await gate.promise; return next; } };
  const slot = new SyntheticXlsxSlot(codec, port, 2, 4);
  const first = slot.submit(request());
  const second = slot.submit(request((async function* () { inputStarts++; yield Uint8Array.of(1, 2); })()));
  expect(await first).toEqual(Uint8Array.of(9));
  await flush();
  expect(inputStarts).toBe(0);
  expect(slot.snapshot()).toEqual({ state: "RESETTING", jobs: 2, reserved: 4 });
  await expect(slot.submit(request())).rejects.toThrow("XLSX_SLOT_UNAVAILABLE");
  gate.resolve();
  expect(await second).toEqual(Uint8Array.of(9));
  await flush();
  expect(slot.snapshot()).toEqual({ state: "IDLE", jobs: 0, reserved: 0 });
});

it("retains slot and reservation when a timed-out input ignores abort", async () => {
  vi.useFakeTimers();
  const gate = pending<void>(), reset = vi.fn(successPort().reset);
  const slot = new SyntheticXlsxSlot(codec, { ...successPort(), reset }, 2, 4);
  const first = slot.submit(request((async function* () { await gate.promise; yield Uint8Array.of(5, 6); })(), 2, 10));
  const firstResult = expect(first).rejects.toThrow("XLSX_SLOT_UNAVAILABLE");
  await vi.advanceTimersByTimeAsync(10); await firstResult;
  expect(slot.snapshot()).toEqual({ state: "QUARANTINED", jobs: 1, reserved: 2 });
  expect(reset).not.toHaveBeenCalled();
  const queued = slot.submit(request(bytes(Uint8Array.of(3, 4)), 2, 10));
  const queuedResult = expect(queued).rejects.toThrow("XLSX_SLOT_UNAVAILABLE");
  await vi.advanceTimersByTimeAsync(10); await queuedResult;
  expect(slot.snapshot()).toEqual({ state: "QUARANTINED", jobs: 1, reserved: 2 });
  gate.resolve(); await flush();
  expect(reset).toHaveBeenCalledTimes(1);
  expect(slot.snapshot()).toEqual({ state: "IDLE", jobs: 0, reserved: 0 });
});

it("keeps a timed-out exchange quarantined until its iterator settles", async () => {
  vi.useFakeTimers();
  const gate = pending<void>(), reset = vi.fn(successPort().reset);
  const slot = new SyntheticXlsxSlot(codec, { reset, exchange: async function* () { await gate.promise; yield Uint8Array.of(1); } }, 1, 2);
  const result = expect(slot.submit(request(undefined, 2, 10))).rejects.toThrow("XLSX_SLOT_UNAVAILABLE");
  await flush(); await vi.advanceTimersByTimeAsync(10); await result;
  expect(reset).not.toHaveBeenCalled();
  expect(slot.snapshot().reserved).toBe(2);
  gate.resolve(); await flush();
  expect(reset).toHaveBeenCalledTimes(1);
  expect(slot.snapshot().state).toBe("IDLE");
});

it("fails closed on wrong reset acknowledgement and fences a late reset after close", async () => {
  const slot = new SyntheticXlsxSlot(codec, { ...successPort(), reset: async (previous) => previous }, 2, 10);
  await slot.submit(request()); await flush();
  expect(slot.snapshot()).toEqual({ state: "QUARANTINED", jobs: 1, reserved: 2 });
  slot.close();
  expect(slot.snapshot()).toEqual({ state: "CLOSED", jobs: 0, reserved: 0 });
  await expect(slot.submit(request())).rejects.toThrow("XLSX_SLOT_UNAVAILABLE");
  const gate = pending<string>();
  const other = new SyntheticXlsxSlot(codec, { ...successPort(), reset: () => gate.promise }, 2, 10);
  await other.submit(request()); await flush();
  expect(other.snapshot().state).toBe("RESETTING");
  other.close();
  expect(other.snapshot()).toEqual({ state: "CLOSED", jobs: 1, reserved: 2 });
  gate.resolve("0".repeat(32)); await flush();
  expect(other.snapshot()).toEqual({ state: "CLOSED", jobs: 0, reserved: 0 });
});

it("releases a settled rejected reset only after close", async () => {
  const slot = new SyntheticXlsxSlot(codec, { ...successPort(), reset: async () => { throw new Error("private reset"); } }, 1, 2);
  expect(await slot.submit(request())).toEqual(Uint8Array.of(9)); await flush();
  expect(slot.snapshot()).toEqual({ state: "QUARANTINED", jobs: 1, reserved: 2 });
  slot.close(); expect(slot.snapshot()).toEqual({ state: "CLOSED", jobs: 0, reserved: 0 });
});

it("rejects malformed, trailing and wrong-generation frames with generic errors", async () => {
  for (const mode of ["truncated", "trailing", "wrong"] as const) {
    const port = { reset: successPort().reset, exchange: async function* (frame: Uint8Array) {
      const d = new SyntheticXlsxFrameDecoder("request"); d.push(frame); const r = d.finish();
      if (r.kind !== "request") throw new Error("bad request");
      const value = encodeSyntheticXlsxResponse({ job: r.header.job, generation: mode === "wrong" ? "a".repeat(32) : r.header.generation, status: "OK" }, Uint8Array.of(7));
      yield mode === "truncated" ? value.subarray(0, value.length - 1) : value;
      if (mode === "trailing") yield Uint8Array.of(0);
    } };
    const slot = new SyntheticXlsxSlot(codec, port, 1, 2);
    await expect(slot.submit(request())).rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
    await flush(); expect(slot.snapshot().state).toBe("IDLE");
  }
});

it("rejects length mismatch and shared buffers without disclosing input", async () => {
  for (const chunks of [bytes(Uint8Array.of(1)), bytes(Uint8Array.of(1, 2, 3)), bytes(new Uint8Array(new SharedArrayBuffer(2)))]) {
    const slot = new SyntheticXlsxSlot(codec, successPort(), 1, 2);
    await expect(slot.submit(request(chunks))).rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
    await flush(); expect(slot.snapshot().state).toBe("IDLE");
  }
});

it("rejects a parser rejection and resets before accepting the next lease", async () => {
  const base = successPort(), resets = vi.fn(base.reset);
  const slot = new SyntheticXlsxSlot(codec, { reset: resets, exchange: async function* (frame) {
    const decoder = new SyntheticXlsxFrameDecoder("request"); decoder.push(frame);
    const input = decoder.finish(); if (input.kind !== "request") throw new Error("bad request");
    yield encodeSyntheticXlsxResponse({ job: input.header.job, generation: input.header.generation, status: "REJECTED" }, new Uint8Array());
  } }, 1, 2);
  await expect(slot.submit(request())).rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
  await flush(); expect(resets).toHaveBeenCalledTimes(1); expect(slot.snapshot().state).toBe("IDLE");
});

it("bounds empty input chunks as well as total bytes", async () => {
  const slot = new SyntheticXlsxSlot(codec, successPort(), 1, 2);
  const chunks = (async function* () { for (let i = 0; i < 65_537; i++) yield new Uint8Array(); })();
  await expect(slot.submit(request(chunks))).rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
  await flush(); expect(slot.snapshot().state).toBe("IDLE");
});

it("closes a pending lease without reopening after late input completion", async () => {
  const gate = pending<void>(), reset = vi.fn(successPort().reset);
  const slot = new SyntheticXlsxSlot(codec, { ...successPort(), reset }, 1, 2);
  const result = expect(slot.submit(request((async function* () { await gate.promise; yield Uint8Array.of(5, 6); })())))
    .rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
  slot.close(); await result;
  expect(slot.snapshot()).toEqual({ state: "CLOSED", jobs: 1, reserved: 2 });
  gate.resolve(); await flush();
  expect(reset).not.toHaveBeenCalled();
  expect(slot.snapshot()).toEqual({ state: "CLOSED", jobs: 0, reserved: 0 });
});

it("rejects forged signals generically without leaking a timer or reservation", async () => {
  vi.useFakeTimers();
  const slot = new SyntheticXlsxSlot(codec, successPort(), 1, 2);
  const forged = { aborted: false, addEventListener() { throw new Error("private signal"); } } as unknown as AbortSignal;
  await expect(slot.submit({ ...request(), signal: forged })).rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
  expect(slot.snapshot()).toEqual({ state: "IDLE", jobs: 0, reserved: 0 });
  expect(vi.getTimerCount()).toBe(0);
  expect(await slot.submit(request())).toEqual(Uint8Array.of(9));
  await flush(); expect(slot.snapshot().reserved).toBe(0);
});

it("does not call overridden signal methods or leave a completed caller pending", async () => {
  const signal = new AbortController().signal;
  Object.defineProperty(signal, "addEventListener", { value: () => { throw new Error("private add"); } });
  Object.defineProperty(signal, "removeEventListener", { value: () => { throw new Error("private remove"); } });
  const slot = new SyntheticXlsxSlot(codec, successPort(), 1, 2);
  expect(await slot.submit({ ...request(), signal })).toEqual(Uint8Array.of(9));
  await flush(); expect(slot.snapshot().reserved).toBe(0);
});

it("does not start transport if the deadline passes during frame encoding", async () => {
  vi.useFakeTimers();
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  let encodes = 0;
  const delayedCodec = { ...codec, encode: (...args: Parameters<typeof codec.encode>) => {
    const result = codec.encode(...args);
    if (++encodes === 2) now.mockReturnValue(11);
    return result;
  } };
  const exchange = vi.fn(successPort().exchange);
  const slot = new SyntheticXlsxSlot(delayedCodec, { ...successPort(), exchange }, 1, 2);
  await expect(slot.submit(request(undefined, 2, 10))).rejects.toThrow(/^XLSX_SLOT_UNAVAILABLE$/);
  await flush(); expect(exchange).not.toHaveBeenCalled(); expect(slot.snapshot().state).toBe("IDLE");
});

it("captures queue metadata and cancels queued jobs without reading them", async () => {
  const gate = pending<void>(), controller = new AbortController(); let started = 0;
  const slot = new SyntheticXlsxSlot(codec, { ...successPort(), reset: async (_, next) => { await gate.promise; return next; } }, 2, 4);
  const first = slot.submit(request());
  const mutable = { ...request((async function* () { started++; yield Uint8Array.of(1, 2); })()), signal: controller.signal };
  const second = slot.submit(mutable); mutable.length = 999; mutable.sheet = "changed";
  controller.abort(); await expect(second).rejects.toThrow("XLSX_SLOT_UNAVAILABLE");
  await first; await flush(); expect(started).toBe(0); expect(slot.snapshot().reserved).toBe(2);
  gate.resolve(); await flush(); expect(slot.snapshot().reserved).toBe(0);
});
