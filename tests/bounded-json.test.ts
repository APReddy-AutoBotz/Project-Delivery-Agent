import { expect, it, vi } from "vitest";
import { discardResponse, readBoundedJson, readCompleteJson } from "../apps/web/src/bounded-json.js";

it("accepts valid JSON within its byte limit", async () => {
  const body = '{"value":"✓"}', bytes = new TextEncoder().encode(body);
  expect(await readBoundedJson(new Response(bytes), bytes.length)).toEqual({ value: "✓" });
});
it("enforces the proposed identity limit on encoded bytes, not characters or headers", async () => {
  const prefix = '{"customerId":"10000000-0000-4000-8000-000000000001","roles":["leadership"],"subject":"é\\\\', suffix = '"}';
  const encoder = new TextEncoder();
  const fixed = encoder.encode(prefix + suffix).length;
  const make = (length: number) => encoder.encode(prefix + "x".repeat(length - fixed) + suffix);
  const exact = make(65536), oversize = make(65537), complete = vi.fn(), rejected = vi.fn();
  expect(exact.byteLength).toBe(65536); expect(oversize.byteLength).toBe(65537);
  await expect(readBoundedJson(new Response(exact), 65536, undefined, complete)).resolves.toMatchObject({ roles: ["leadership"] });
  await expect(readBoundedJson(new Response(oversize), 65536, undefined, rejected)).rejects.toThrow("Response unavailable");
  expect(complete).toHaveBeenCalledExactlyOnceWith("eof");
  expect(rejected).toHaveBeenCalledExactlyOnceWith("terminated");
});
it("reports complete unbounded JSON independently of parse success", async () => {
  const valid = vi.fn(), malformed = vi.fn();
  await expect(readCompleteJson(new Response('{"value":1}'), valid)).resolves.toEqual({ value: 1 });
  await expect(readCompleteJson(new Response("not-json"), malformed)).rejects.toThrow();
  expect(valid).toHaveBeenCalledExactlyOnceWith("eof");
  expect(malformed).toHaveBeenCalledExactlyOnceWith("eof");
});
it("does not claim EOF when an unbounded JSON stream breaks or has no body", async () => {
  const broken = vi.fn(), absent = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic break")); } });
  await expect(readCompleteJson(new Response(stream), broken)).rejects.toThrow();
  await expect(readCompleteJson(new Response(null), absent)).rejects.toThrow();
  expect(broken).toHaveBeenCalledExactlyOnceWith("unknown");
  expect(absent).toHaveBeenCalledExactlyOnceWith("unknown");
});
it("reports an oversize response before a stalled cancellation and keeps the reader until it settles", async () => {
  let release!: () => void, reported = false, settled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { return new Promise<void>((resolve) => { release = resolve; }); },
  });
  const result = readBoundedJson(new Response(stream), 4, () => { reported = true; });
  void result.catch(() => { settled = true; });
  await vi.waitFor(() => expect(reported).toBe(true));
  expect(settled).toBe(false); release();
  await expect(result).rejects.toThrow("Response unavailable");
});
it("drains denial bodies without retaining or exposing their bytes", async () => {
  let release!: () => void, settled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("private")); release = () => controller.close(); },
  });
  const result = discardResponse(new Response(stream)); void result.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false); release(); await result; expect(settled).toBe(true);
});
it("rejects oversized or invalid UTF-8 bodies without exposing contents", async () => {
  await expect(readBoundedJson(new Response(new TextEncoder().encode('{"secret":"private"}')), 3)).rejects.toThrow("Response unavailable");
  await expect(readBoundedJson(new Response(new Uint8Array([0xff])), 10)).rejects.toThrow("Response unavailable");
});

it("reports EOF even when parsing fails after the complete body", async () => {
  const complete = vi.fn();
  await expect(readBoundedJson(new Response("not-json"), 100, undefined, complete)).rejects.toThrow("Response unavailable");
  expect(complete).toHaveBeenCalledExactlyOnceWith("eof");
});

it("reports local termination only after an oversized body's cancellation finishes", async () => {
  let release!: () => void;
  const complete = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { return new Promise<void>((resolve) => { release = resolve; }); },
  });
  const result = readBoundedJson(new Response(stream), 4, undefined, complete);
  void result.catch(() => {});
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(complete).not.toHaveBeenCalled();
  release(); await expect(result).rejects.toThrow("Response unavailable");
  expect(complete).toHaveBeenCalledExactlyOnceWith("terminated");
});

it("does not report a rejected cancellation as terminal or captured", async () => {
  const complete = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(5)); },
    cancel() { return Promise.reject(new Error("synthetic cancellation failure")); },
  });
  await expect(readBoundedJson(new Response(stream), 4, undefined, complete)).rejects.toThrow("Response unavailable");
  expect(complete).toHaveBeenCalledExactlyOnceWith("unknown");
});

it("distinguishes a failed stream, protocol-bodyless response and opaque failure", async () => {
  const failed = vi.fn(), empty = vi.fn(), opaque = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic stream failure")); } });
  await discardResponse(new Response(stream), failed);
  await discardResponse(new Response(null, { status: 204 }), empty);
  await discardResponse(Response.error(), opaque);
  expect(failed).toHaveBeenCalledExactlyOnceWith("unknown");
  expect(empty).toHaveBeenCalledExactlyOnceWith("terminated");
  expect(opaque).toHaveBeenCalledExactlyOnceWith("unknown");
});

it("reports reader acquisition failure as unknown without changing rejection behavior", async () => {
  for (const discard of [false, true]) {
    const response = new Response("synthetic"), held = response.body!.getReader(), complete = vi.fn();
    try {
      const result = discard ? discardResponse(response, complete) : readBoundedJson(response, 100, undefined, complete);
      await expect(result).rejects.toThrow();
      expect(complete).toHaveBeenCalledExactlyOnceWith("unknown");
    } finally { held.releaseLock(); }
  }
});

it("reports successful handling after the reader lock has been released", async () => {
  const response = new Response('{"valid":true}');
  const lockedAtReport: boolean[] = [];
  const complete = vi.fn(() => { lockedAtReport.push(response.body!.locked); });
  expect(await readBoundedJson(response, 100, undefined, complete)).toEqual({ valid: true });
  expect(complete).toHaveBeenCalledExactlyOnceWith("eof");
  expect(lockedAtReport).toEqual([false]);
});

it("reports unknown and preserves rejection when reader lock release fails", async () => {
  for (const discard of [false, true]) {
    let reads = 0; const complete = vi.fn();
    const reader = {
      read: async () => ++reads === 1 && !discard
        ? { done: false, value: new TextEncoder().encode("{}") } : { done: true },
      cancel: async () => {},
      releaseLock: () => { throw new Error("synthetic release failure"); },
    };
    const response = { body: { getReader: () => reader } } as unknown as Response;
    const result = discard ? discardResponse(response, complete) : readBoundedJson(response, 100, undefined, complete);
    await expect(result).rejects.toThrow("synthetic release failure");
    expect(complete).toHaveBeenCalledExactlyOnceWith("unknown");
  }
});

it("retains denial ownership until the held body reaches EOF", async () => {
  let release!: () => void; const complete = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); release = () => controller.close(); } });
  const result = discardResponse(new Response(stream, { status: 403 }), complete);
  await Promise.resolve(); expect(complete).not.toHaveBeenCalled();
  release(); await result; expect(complete).toHaveBeenCalledExactlyOnceWith("eof");
});
