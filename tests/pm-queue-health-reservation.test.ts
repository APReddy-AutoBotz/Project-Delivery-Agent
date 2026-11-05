import { afterEach, expect, it, vi } from "vitest";
import { HealthScopeFence } from "../apps/web/src/health-scope-fence.js";
import { ManagedReadRegistry } from "../apps/web/src/managed-read-registry.js";
import { managedRead, ManagedReadStaleError } from "../apps/web/src/managed-read.js";
import { createPmQueueResource } from "../apps/web/src/pm-queue-resource.js";

const current = () => true;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const fence = new HealthScopeFence(); fence.transition(true);
  fence.finish(fence.begin("identity"), true); fence.finish(fence.begin("project"), true);
  const ticket = fence.capture(current)!;
  const reserve = () => {
    const read = fence.trackRead(ticket, current);
    return read ? { current: () => !read.signal.aborted && fence.valid(ticket, current), release: read.release } : null;
  };
  return { fence, ticket, reserve };
}
afterEach(() => vi.useRealTimers());

it("fences header callbacks from superseded reads and keeps the replacement current", async () => {
  vi.useFakeTimers(); const { reserve } = setup();
  const first = deferred<string>(), second = deferred<string>(), signals: AbortSignal[] = [];
  const publish = vi.fn();
  const resource = createPmQueueResource({ reserve, visible: () => true, publish,
    load: (signal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; } });
  resource.refresh(); await flush();
  expect(resource.current(signals[0]!)).toBe(true);
  resource.refresh(); expect(resource.current(signals[0]!)).toBe(false);
  first.resolve("superseded"); await flush();
  expect(signals).toHaveLength(2); expect(resource.current(signals[0]!)).toBe(false);
  expect(resource.current(signals[1]!)).toBe(true);
  expect(publish).toHaveBeenLastCalledWith({ phase: "loading" });
  second.resolve("current"); await flush();
  expect(publish).toHaveBeenLastCalledWith({ phase: "ready", data: "current" });
  expect(resource.current(signals[1]!)).toBe(false); resource.dispose();
});

it("reserves the whole coalesced refresh before a write can be admitted", async () => {
  vi.useFakeTimers(); const { fence, ticket, reserve } = setup();
  const first = deferred<string>(), second = deferred<string>(), makeKey = vi.fn(() => "key");
  const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const resource = createPmQueueResource({ load, reserve, publish: () => {}, visible: () => true });
  resource.refresh();
  expect(load).not.toHaveBeenCalled();
  expect(fence.beginAssessment(ticket, current, "owner", "project", makeKey)).toBeNull();
  expect(makeKey).not.toHaveBeenCalled();
  await flush(); resource.refresh(); first.resolve("stale");
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    expect(fence.beginAssessment(ticket, current, "owner", "project", makeKey)).toBeNull();
  }
  expect(load).toHaveBeenCalledTimes(2); second.resolve("current"); await flush();
  const result = fence.beginAssessment(ticket, current, "owner", "project", makeKey);
  expect(result?.key).toBe("key"); fence.finishWrite(result!.lease); resource.dispose();
});

it("does not dispatch a deferred read after disposal, timeout or scope change", async () => {
  vi.useFakeTimers();
  for (const stop of ["dispose", "timeout", "transition"] as const) {
    const { fence, reserve } = setup(), load = vi.fn(async () => "value");
    const publish = vi.fn();
    const resource = createPmQueueResource({ load, reserve, publish, visible: () => true });
    resource.refresh();
    if (stop === "dispose") resource.dispose();
    else if (stop === "timeout") vi.advanceTimersByTime(30000);
    else fence.transition(false);
    await flush(); expect(load).not.toHaveBeenCalled();
    expect(publish.mock.calls.some(([value]) => value.phase === "ready")).toBe(false);
    resource.dispose();
  }
});

it("does not queue a denied refresh to run after an active write ends", async () => {
  vi.useFakeTimers(); const { fence, ticket, reserve } = setup();
  const lease = fence.beginWrite(ticket, current, "owner")!;
  const load = vi.fn(async () => "value"), publish = vi.fn();
  const resource = createPmQueueResource({ load, reserve, publish, visible: () => true });
  resource.refresh(); fence.finishWrite(lease); await flush();
  expect(load).not.toHaveBeenCalled();
  expect(publish).toHaveBeenLastCalledWith({ phase: "error" });
  resource.dispose();
});

it("separates a canceled logical read from its unsettled physical slot", async () => {
  const { fence, ticket } = setup(), registry = new ManagedReadRegistry(1);
  const logical = fence.trackRead(ticket, current)!, caller = new AbortController();
  const gate = deferred<void>(); let published = false;
  caller.signal.addEventListener("abort", logical.release, { once: true });
  const operation = managedRead(registry, caller.signal, () => fence.valid(ticket, current), async (live, report) => {
    await gate.promise; published = live(); report("eof"); return "old";
  });
  void operation.catch(() => {});
  caller.abort();
  expect(fence.reading()).toBe(false); expect(registry.full()).toBe(true);
  const lease = fence.beginWrite(ticket, current, "owner"); expect(lease).not.toBeNull();
  gate.resolve(); await expect(operation).rejects.toBeInstanceOf(ManagedReadStaleError);
  expect(published).toBe(false); expect(registry.count()).toBe(0);
  fence.finishWrite(lease!);
});

it("announces settlement only after the timed-out logical turn becomes idle", async () => {
  vi.useFakeTimers();
  const original = deferred<string>(), states: Array<{ pending: boolean; timedOut: boolean }> = [];
  const publish = vi.fn();
  const resource = createPmQueueResource({ load: () => original.promise, publish, visible: () => true,
    settled: () => states.push({ pending: resource.pending(), timedOut: resource.timedOut() }) });
  resource.refresh(); await flush();
  vi.advanceTimersByTime(30000);
  expect(resource.pending()).toBe(true); expect(resource.timedOut()).toBe(true);
  resource.refresh(); expect(states).toEqual([]);
  original.resolve("old"); await flush();
  expect(states).toEqual([{ pending: false, timedOut: true }]);
  expect(publish.mock.calls.some(([state]) => state.phase === "ready")).toBe(false);
  resource.dispose();
});
