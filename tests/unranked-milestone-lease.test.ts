import { expect, it, vi } from "vitest";
import { createUnrankedRequestLease } from "../apps/web/src/unranked-milestone-lease.js";

const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

it("prevents overlap across separate resource generations until the old body settles", async () => {
  const lease = createUnrankedRequestLease(), first = deferred<string>();
  const oldScope = new AbortController(), nextScope = new AbortController(), firstLoad = vi.fn(() => first.promise), nextLoad = vi.fn(async () => "new");
  const old = lease.run(oldScope.signal, firstLoad); await Promise.resolve(); oldScope.abort();
  await expect(lease.run(nextScope.signal, nextLoad)).rejects.toThrow("Observation unavailable");
  expect(nextLoad).not.toHaveBeenCalled();
  first.resolve("old"); await expect(old).rejects.toThrow("Observation unavailable");
  expect(await lease.run(nextScope.signal, nextLoad)).toBe("new"); expect(nextLoad).toHaveBeenCalledTimes(1);
});

it("does not start a load canceled before its microtask and releases the lease", async () => {
  const lease = createUnrankedRequestLease(), controller = new AbortController(), load = vi.fn(async () => "value");
  const pending = lease.run(controller.signal, load); controller.abort();
  await expect(pending).rejects.toThrow("Observation unavailable"); expect(load).not.toHaveBeenCalled();
  expect(await lease.run(new AbortController().signal, load)).toBe("value");
});

it("releases after a failed body and rejects an already-aborted signal without starting", async () => {
  const lease = createUnrankedRequestLease(), failure = deferred<string>(), first = lease.run(new AbortController().signal, () => failure.promise);
  failure.reject(new Error("synthetic private error")); await expect(first).rejects.toThrow("Observation unavailable");
  const aborted = new AbortController(); aborted.abort(); const load = vi.fn(async () => "next");
  await expect(lease.run(aborted.signal, load)).rejects.toThrow("Observation unavailable"); expect(load).not.toHaveBeenCalled();
  expect(await lease.run(new AbortController().signal, load)).toBe("next");
});
