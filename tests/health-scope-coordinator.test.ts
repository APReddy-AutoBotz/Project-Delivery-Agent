import { expect, it } from "vitest";
import { HealthScopeFence } from "../apps/web/src/health-scope-fence.js";
import { establishHealthScope, sameHealthRoles } from "../apps/web/src/health-scope-coordinator.js";

const pending = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

it("compares duplicate roles as multisets without changing inputs", () => {
  const first = Array.from({ length: 4000 }, (_, index) => index % 2 ? "leadership" : "pmo_admin");
  const second = [...first].reverse(), changed = [...second]; changed[0] = "contributor";
  expect(sameHealthRoles(first, second)).toBe(true); expect(sameHealthRoles(first, changed)).toBe(false);
  expect(sameHealthRoles(first, second.slice(1))).toBe(false); expect(first[0]).toBe("pmo_admin");
});

it("checks identity before project and opens only after both fresh checks", async () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const identity = pending<boolean>(); let projectCalls = 0;
  const run = establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    () => identity.promise, async () => { projectCalls++; return true; });
  expect(projectCalls).toBe(0); expect(fence.capture(() => true)).toBeNull();
  identity.resolve(true); expect(await run).toBe(true); expect(projectCalls).toBe(1);
  expect(fence.capture(() => true)).not.toBeNull();
});

it("does not start project for failed or obsolete identity", async () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const identity = pending<boolean>(); let calls = 0;
  const old = establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    () => identity.promise, async () => { calls++; return true; });
  fence.transition(true); identity.resolve(true); expect(await old).toBe(false);
  expect(calls).toBe(0); expect(fence.capture(() => true)).toBeNull();
  expect(await establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    async () => false, async () => { calls++; return true; })).toBe(false);
  expect(calls).toBe(0);
});

it("cannot reopen after a project result arrives for an obsolete scope", async () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const project = pending<boolean>(); let started = false;
  const old = establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    async () => true, () => { started = true; return project.promise; });
  await Promise.resolve(); expect(started).toBe(true);
  fence.transition(false); fence.transition(true); project.resolve(true);
  expect(await old).toBe(false); expect(fence.capture(() => true)).toBeNull();
  expect(await establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    async () => true, async () => true)).toBe(true);
});

it("fails closed for aborted, denied or throwing checks", async () => {
  for (const mode of ["aborted", "denied", "throw"] as const) {
    const fence = new HealthScopeFence(); fence.transition(true); const controller = new AbortController();
    if (mode === "aborted") controller.abort();
    const result = await establishHealthScope(fence, fence.contextSnapshot(), () => true, controller.signal,
      async () => { if (mode === "throw") throw new Error("private"); return mode !== "denied"; }, async () => true);
    expect(result).toBe(false); expect(fence.capture(() => true)).toBeNull();
  }
});

it("does not allow an older identity check to start a project check in the same context", async () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const oldIdentity = pending<boolean>(); let oldProjectCalls = 0;
  const old = establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    () => oldIdentity.promise, async () => { oldProjectCalls++; return true; });
  const newer = establishHealthScope(fence, fence.contextSnapshot(), () => true, new AbortController().signal,
    async () => true, async () => true);
  expect(await newer).toBe(true); oldIdentity.resolve(true);
  expect(await old).toBe(false); expect(oldProjectCalls).toBe(0);
  expect(fence.capture(() => true)).not.toBeNull();
});

it("does not let an obsolete same-context check latch a later successful scope", async () => {
  const fence = new HealthScopeFence(); fence.transition(true);
  const oldIdentity = pending<boolean>(); let oldCurrent!: () => boolean;
  const context = fence.contextSnapshot();
  const old = establishHealthScope(fence, context, () => true, new AbortController().signal,
    (_signal, checkCurrent) => { oldCurrent = checkCurrent; return oldIdentity.promise; }, async () => true);
  const newer = establishHealthScope(fence, context, () => true, new AbortController().signal,
    async () => true, async () => true);
  expect(await newer).toBe(true); expect(oldCurrent()).toBe(false);
  if (oldCurrent()) fence.denyContext(context, () => true);
  expect(fence.denialLatched()).toBe(false);
  oldIdentity.resolve(false); expect(await old).toBe(false);
  expect(fence.capture(() => true)).not.toBeNull();
});
