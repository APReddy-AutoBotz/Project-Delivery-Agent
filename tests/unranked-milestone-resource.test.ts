import { afterEach, expect, it, vi } from "vitest";
import type { UnrankedMilestoneObservation } from "../packages/domain/src/unranked-milestone.js";
import { createUnrankedMilestoneResource } from "../apps/web/src/unranked-milestone-resource.js";
import { createUnrankedRequestLease } from "../apps/web/src/unranked-milestone-lease.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const observation = (): UnrankedMilestoneObservation => ({ kind: "UNRANKED_NO_POLICY", projectId: id(2), milestoneId: id(3),
  bindingId: id(4), factId: id(5), factType: "canonical.state.10000000000040008000000000000003", asOf: "2026-10-31T12:00:00.000Z",
  positions: ["COMPLETE", "OPEN"].map((state, index) => ({ state: state as "COMPLETE" | "OPEN", supports: [{ versionId: id(10 + index),
    evidenceId: id(20 + index), sourceId: id(30 + index), provenance: "HUMAN_CONFIRMED" as const,
    effectiveAt: "2026-10-31T11:00:00.000Z", observedAt: "2026-10-31T11:00:00.000Z", versionValidUntil: "2026-10-31T12:00:10.000Z" }] })) });
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = async () => { await vi.advanceTimersByTimeAsync(0); };
afterEach(() => { vi.useRealTimers(); });

it("requires an explicit request and expires without polling or retry", async () => {
  vi.useFakeTimers(); let wall = 1000, monotonic = 500;
  const load = vi.fn(async () => observation()), publish = vi.fn();
  const resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => wall, monotonic: () => monotonic } });
  await vi.advanceTimersByTimeAsync(60000); expect(load).not.toHaveBeenCalled();
  resource.refresh(); await tick(); expect(resource.current().phase).toBe("ready"); expect(load).toHaveBeenCalledTimes(1);
  wall += 10000; monotonic += 10000; await vi.advanceTimersByTimeAsync(10000);
  expect(resource.current().phase).toBe("error"); expect(load).toHaveBeenCalledTimes(1);
  resource.dispose();
});

it("aborts and discards a stale refresh before starting its queued successor", async () => {
  vi.useFakeTimers(); const first = deferred<UnrankedMilestoneObservation>(), second = deferred<UnrankedMilestoneObservation>();
  const signals: AbortSignal[] = [], load = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  const publish = vi.fn(), resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); resource.refresh();
  expect(signals[0]!.aborted).toBe(true); expect(load).toHaveBeenCalledTimes(1);
  first.resolve(observation()); await tick(); expect(load).toHaveBeenCalledTimes(2); expect(resource.current().phase).toBe("loading");
  second.resolve(observation()); await tick(); expect(resource.current().phase).toBe("ready");
  expect(publish.mock.calls.filter(([state]) => state.phase === "ready")).toHaveLength(1);
  resource.dispose();
});

it("hides on backgrounding, revalidates on return and discards late results after disposal", async () => {
  vi.useFakeTimers(); const first = deferred<UnrankedMilestoneObservation>(), second = deferred<UnrankedMilestoneObservation>();
  const signals: AbortSignal[] = [], load = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  const publish = vi.fn(), resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); resource.setVisible(false);
  expect(signals[0]!.aborted).toBe(true); expect(resource.current().phase).toBe("idle");
  resource.setVisible(true); first.resolve(observation()); await tick(); expect(load).toHaveBeenCalledTimes(2);
  const calls = publish.mock.calls.length; resource.dispose(); second.resolve(observation()); await tick();
  expect(publish).toHaveBeenCalledTimes(calls); expect(resource.current().phase).toBe("idle");
});

it("fails closed on a stalled body and never overlaps an uncooperative request", async () => {
  vi.useFakeTimers(); const first = deferred<UnrankedMilestoneObservation>(), second = deferred<UnrankedMilestoneObservation>();
  const signals: AbortSignal[] = [], load = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  const resource = createUnrankedMilestoneResource({ load, publish: vi.fn(), clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); await vi.advanceTimersByTimeAsync(30000);
  expect(signals[0]!.aborted).toBe(true); expect(resource.current().phase).toBe("error");
  resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(1); expect(resource.current().phase).toBe("error");
  first.resolve(observation()); await tick(); expect(resource.current().phase).toBe("error");
  resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(2); second.resolve(observation()); await tick();
  expect(resource.current().phase).toBe("ready"); resource.dispose();
});

it("checks elapsed time at display even if the expiry timer was delayed", async () => {
  vi.useFakeTimers(); let wall = 1000, monotonic = 500;
  const load = vi.fn(async () => observation()), publish = vi.fn(), resource = createUnrankedMilestoneResource({ load, publish,
    clock: { wall: () => wall, monotonic: () => monotonic } });
  resource.refresh(); await tick(); expect(resource.current().phase).toBe("ready");
  const calls = publish.mock.calls.length; wall += 10000; expect(resource.current().phase).toBe("error");
  expect(publish).toHaveBeenCalledTimes(calls);
  resource.check(); expect(publish).toHaveBeenLastCalledWith({ phase: "error" });
  resource.setVisible(false); resource.setVisible(true); await tick(); expect(load).toHaveBeenCalledTimes(1);
  resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000); expect(load).toHaveBeenCalledTimes(2); resource.dispose();
});

it("requires a manual retry when a response has already expired on arrival", async () => {
  vi.useFakeTimers(); let wall = 1000, monotonic = 500;
  const reply = deferred<UnrankedMilestoneObservation>(), load = vi.fn(() => reply.promise);
  const resource = createUnrankedMilestoneResource({ load, publish: vi.fn(), clock: { wall: () => wall, monotonic: () => monotonic } });
  resource.refresh(); await tick(); wall += 10000; monotonic += 10000; reply.resolve(observation()); await tick();
  expect(resource.current().phase).toBe("error"); resource.setVisible(false); resource.setVisible(true); await tick();
  expect(load).toHaveBeenCalledTimes(1); resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(2); resource.dispose();
});

it("fails closed on loader and malformed-result errors without visibility retries", async () => {
  vi.useFakeTimers();
  const load = vi.fn<() => Promise<UnrankedMilestoneObservation>>()
    .mockRejectedValueOnce(new Error("synthetic-private-error"))
    .mockResolvedValueOnce({ asOf: "invalid" } as never);
  const publish = vi.fn(), resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); expect(resource.current().phase).toBe("error");
  resource.setVisible(false); resource.setVisible(true); await tick(); expect(load).toHaveBeenCalledTimes(1);
  resource.refresh(); await tick(); expect(resource.current().phase).toBe("error");
  expect(JSON.stringify(publish.mock.calls)).not.toContain("synthetic-private-error");
  resource.setVisible(false); resource.setVisible(true); await tick(); expect(load).toHaveBeenCalledTimes(2); resource.dispose();
});

it("requires a manual retry if contributor validity expires while hidden", async () => {
  vi.useFakeTimers(); let wall = 1000, monotonic = 500;
  const load = vi.fn(async () => observation()), resource = createUnrankedMilestoneResource({ load, publish: vi.fn(),
    clock: { wall: () => wall, monotonic: () => monotonic } });
  resource.refresh(); await tick(); expect(resource.current().phase).toBe("ready");
  resource.setVisible(false); wall += 10000; resource.setVisible(true); await tick();
  expect(resource.current().phase).toBe("error"); expect(load).toHaveBeenCalledTimes(1);
  resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(2); resource.dispose();
});

it("does not invoke an already canceled loader after same-turn hide or disposal", async () => {
  vi.useFakeTimers();
  for (const action of ["hide", "dispose"] as const) {
    const load = vi.fn(async () => observation()), publish = vi.fn();
    const resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => 1000, monotonic: () => 500 } });
    resource.refresh(); if (action === "hide") resource.setVisible(false); else resource.dispose();
    await tick(); expect(load).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({ phase: action === "hide" ? "idle" : "loading" });
    resource.dispose();
  }
});

it("replaces a same-turn refresh without starting the canceled loader", async () => {
  vi.useFakeTimers(); const load = vi.fn(async () => observation());
  const resource = createUnrankedMilestoneResource({ load, publish: vi.fn(), clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); resource.refresh(); await tick();
  expect(load).toHaveBeenCalledTimes(1); expect(resource.current().phase).toBe("ready"); resource.dispose();
});

it("revalidates on focus only after a request and not after an observed expiry", async () => {
  vi.useFakeTimers(); let wall = 1000, monotonic = 500;
  const load = vi.fn(async () => observation()), publish = vi.fn();
  const resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => wall, monotonic: () => monotonic } });
  resource.revalidate(); await tick(); expect(load).not.toHaveBeenCalled();
  resource.refresh(); await tick(); resource.revalidate(); await tick(); expect(load).toHaveBeenCalledTimes(2);
  wall += 10000; monotonic += 10000; resource.revalidate(); await tick();
  expect(load).toHaveBeenCalledTimes(2); expect(publish).toHaveBeenLastCalledWith({ phase: "error" });
  resource.dispose();
});

it("discards a pending pre-focus result before revalidating", async () => {
  vi.useFakeTimers(); const first = deferred<UnrankedMilestoneObservation>(), second = deferred<UnrankedMilestoneObservation>();
  const signals: AbortSignal[] = [], load = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  const resource = createUnrankedMilestoneResource({ load, publish: vi.fn(), clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); resource.revalidate(); expect(signals[0]!.aborted).toBe(true);
  first.resolve(observation()); await tick(); expect(load).toHaveBeenCalledTimes(2); expect(resource.current().phase).toBe("loading");
  second.resolve(observation()); await tick(); expect(resource.current().phase).toBe("ready"); resource.dispose();
});

it("shares one lease across scope replacement until an abort-ignoring body settles", async () => {
  vi.useFakeTimers(); const lease = createUnrankedRequestLease(), oldBody = deferred<UnrankedMilestoneObservation>();
  const oldPublish = vi.fn(), nextPublish = vi.fn(), nextLoad = vi.fn(async () => ({ ...observation(), projectId: id(91) }));
  let oldSignal: AbortSignal | undefined;
  const clock = { wall: () => 1000, monotonic: () => 500 };
  const old = createUnrankedMilestoneResource({ clock, publish: oldPublish, load: (signal) => { oldSignal = signal; return lease.run(signal, () => oldBody.promise); } });
  const next = createUnrankedMilestoneResource({ clock, publish: nextPublish, load: (signal) => lease.run(signal, nextLoad) });
  old.refresh(); await tick(); const oldCalls = oldPublish.mock.calls.length; old.dispose(); expect(oldSignal?.aborted).toBe(true);
  next.refresh(); await tick(); expect(next.current().phase).toBe("error"); expect(nextLoad).not.toHaveBeenCalled();
  oldBody.resolve({ ...observation(), projectId: id(90) }); await tick(); expect(oldPublish).toHaveBeenCalledTimes(oldCalls);
  next.refresh(); await tick(); expect(nextLoad).toHaveBeenCalledTimes(1);
  expect(next.current()).toMatchObject({ phase: "ready", data: { projectId: id(91) } }); next.dispose();
});

it("clears immediately on a known failure while allowing its body to finish", async () => {
  vi.useFakeTimers(); const body = deferred<UnrankedMilestoneObservation>(); let signal: AbortSignal | undefined;
  const load = vi.fn((value: AbortSignal) => { signal = value; return body.promise; }), publish = vi.fn();
  const resource = createUnrankedMilestoneResource({ load, publish, clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick();
  resource.unavailable(new AbortController().signal); expect(resource.current().phase).toBe("loading");
  resource.unavailable(signal!); expect(signal!.aborted).toBe(false); expect(resource.current().phase).toBe("error");
  expect(publish).toHaveBeenLastCalledWith({ phase: "error" });
  resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(1);
  body.resolve(observation()); await tick(); expect(resource.current().phase).toBe("error");
  resource.dispose();
});

it("aborts a stalled denial body at its deadline and never overlaps it", async () => {
  vi.useFakeTimers(); const body = deferred<UnrankedMilestoneObservation>(); let signal: AbortSignal | undefined;
  const load = vi.fn((value: AbortSignal) => { signal = value; return body.promise; });
  const resource = createUnrankedMilestoneResource({ load, publish: vi.fn(), clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); resource.unavailable(signal!); expect(signal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(30000); expect(signal!.aborted).toBe(true); expect(resource.current().phase).toBe("error");
  resource.refresh(); await tick(); expect(load).toHaveBeenCalledTimes(1);
  body.resolve(observation()); await tick(); expect(resource.current().phase).toBe("error"); resource.dispose();
});

it("ignores an unavailable callback from a previous settled request", async () => {
  vi.useFakeTimers(); const first = deferred<UnrankedMilestoneObservation>(), second = deferred<UnrankedMilestoneObservation>();
  const signals: AbortSignal[] = [], load = vi.fn((signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; });
  const resource = createUnrankedMilestoneResource({ load, publish: vi.fn(), clock: { wall: () => 1000, monotonic: () => 500 } });
  resource.refresh(); await tick(); resource.refresh(); first.resolve(observation()); await tick();
  expect(load).toHaveBeenCalledTimes(2); resource.unavailable(signals[0]!);
  expect(resource.current().phase).toBe("loading"); expect(signals[1]!.aborted).toBe(false);
  second.resolve(observation()); await tick(); expect(resource.current().phase).toBe("ready"); resource.dispose();
});
