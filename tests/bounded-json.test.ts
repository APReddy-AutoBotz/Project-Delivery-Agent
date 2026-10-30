import { expect, it, vi } from "vitest";
import { discardResponse, readBoundedJson } from "../apps/web/src/bounded-json.js";

it("accepts valid JSON within its byte limit", async () => {
  const body = '{"value":"✓"}', bytes = new TextEncoder().encode(body);
  expect(await readBoundedJson(new Response(bytes), bytes.length)).toEqual({ value: "✓" });
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
