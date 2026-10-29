import { afterEach, expect, it, vi } from "vitest";
import { createPmQueueResource, type PmQueueResourceState } from "../apps/web/src/pm-queue-resource.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

it("allows a slow successful read to finish without overlapping periodic refreshes", async () => {
  vi.useFakeTimers(); const first = deferred<string>(), states: PmQueueResourceState<string>[] = [];
  const load = vi.fn(() => first.promise);
  const resource = createPmQueueResource({ load, publish: (state) => states.push(state), visible: () => true });
  resource.refresh(); await flush(); await vi.advanceTimersByTimeAsync(16000);
  expect(load).toHaveBeenCalledTimes(1); first.resolve("current"); await flush();
  expect(states.at(-1)).toEqual({ phase: "ready", data: "current" });
  await vi.advanceTimersByTimeAsync(29999); expect(load).toHaveBeenCalledTimes(1);
  resource.dispose();
});
it("coalesces invalidations, hides the stale response and starts only one replacement", async () => {
  vi.useFakeTimers(); const first = deferred<string>(), second = deferred<string>(), states: PmQueueResourceState<string>[] = [];
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const resource = createPmQueueResource({ load, publish: (state) => states.push(state), visible: () => true });
  resource.refresh(); await flush(); resource.refresh(); resource.refresh();
  expect(load).toHaveBeenCalledTimes(1); first.resolve("stale"); await flush();
  expect(load).toHaveBeenCalledTimes(2); expect(states).not.toContainEqual({ phase: "ready", data: "stale" });
  second.resolve("fresh"); await flush(); expect(states.at(-1)).toEqual({ phase: "ready", data: "fresh" });
  resource.dispose();
});
it("reports a deadline, aborts and never displays a late timed-out result", async () => {
  vi.useFakeTimers(); const first = deferred<string>(), states: PmQueueResourceState<string>[] = []; let signal: AbortSignal | undefined;
  const resource = createPmQueueResource({ load: (value) => { signal = value; return first.promise; }, publish: (state) => states.push(state), visible: () => true });
  resource.refresh(); await flush(); await vi.advanceTimersByTimeAsync(30000);
  expect(signal?.aborted).toBe(true); expect(states.at(-1)).toEqual({ phase: "error" });
  first.resolve("late"); await flush(); expect(states).not.toContainEqual({ phase: "ready", data: "late" }); resource.dispose();
});
it("keeps the error visible if an aborted request never settles and is refreshed", async () => {
  vi.useFakeTimers(); const first = deferred<string>(), states: PmQueueResourceState<string>[] = [];
  const load = vi.fn(() => first.promise);
  const resource = createPmQueueResource({ load, publish: (state) => states.push(state), visible: () => true });
  resource.refresh(); await flush(); await vi.advanceTimersByTimeAsync(30000);
  resource.refresh(); resource.refresh(); await flush();
  expect(load).toHaveBeenCalledTimes(1); expect(states.at(-1)).toEqual({ phase: "error" });
  resource.dispose();
});
it("disposal aborts the request and suppresses a prior scope's late result", async () => {
  vi.useFakeTimers(); const first = deferred<string>(), states: PmQueueResourceState<string>[] = []; let signal: AbortSignal | undefined;
  const resource = createPmQueueResource({ load: (value) => { signal = value; return first.promise; }, publish: (state) => states.push(state), visible: () => true });
  resource.refresh(); await flush(); resource.dispose(); expect(signal?.aborted).toBe(true);
  first.resolve("old scope"); await flush(); expect(states).not.toContainEqual({ phase: "ready", data: "old scope" });
});
