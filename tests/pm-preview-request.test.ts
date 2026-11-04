import { expect, it, vi } from "vitest";
import { ManagedReadRegistry } from "../apps/web/src/managed-read-registry.js";
import { createPreviewRequestFactory } from "../apps/web/src/pm-preview-request.js";
import { previewPath } from "../apps/web/src/pm-reconciliation-preview.js";
import type { RequestFn } from "../apps/web/src/request-types.js";

const first = "30000000-0000-4000-8000-000000000001", second = "30000000-0000-4000-8000-000000000002";
const third = "30000000-0000-4000-8000-000000000003", time = "2026-01-01T00:00:00.000Z";
const noop = () => {};
function setup(limit = 2) {
  const calls: Array<{ path: string; init?: RequestInit; limit?: number; expected?: number }> = [];
  const request: RequestFn = async <T>(...args: Parameters<RequestFn>) => {
    const path = args[0], init = args[1], max = args[2], managed = args[4], expected = args[6];
    calls.push({ path, init, limit: max, expected }); managed?.completion("eof"); return { ok: true } as T;
  };
  const registry = new ManagedReadRegistry(limit), issuedSignals = new WeakSet<AbortSignal>();
  let owner = true;
  const factory = createPreviewRequestFactory({ queueCurrent: () => owner, projectIds: [first, second, third], request, registry, issuedSignals });
  return { calls, registry, factory, revoke: () => { owner = false; } };
}

it("admits only captured batch paths once with fixed bounded transport", async () => {
  const { factory, calls } = setup(), controller = new AbortController();
  const operation = factory({ kind: "batch", projectIds: [first, second] }, controller.signal, () => true);
  const one = previewPath(first, "milestone"), two = previewPath(second, "scalar");
  await expect(operation(previewPath(third, "milestone"), { signal: controller.signal }, noop)).rejects.toThrow();
  await operation(one, { signal: controller.signal }, noop);
  await expect(operation(one, { signal: controller.signal }, noop)).rejects.toThrow();
  await operation(two, { signal: controller.signal }, noop);
  expect(calls).toEqual([one, two].map((path) => ({ path, init: { redirect: "error" }, limit: 65_536, expected: 200 })));
  expect(() => factory({ kind: "batch", projectIds: [first] }, controller.signal, () => true)).toThrow();
});

it("binds one page to its copied canonical cursor and consumes invalid attempts", async () => {
  const { factory, calls } = setup(), controller = new AbortController();
  const after = { id: first, createdAt: time }, expected = previewPath(first, "milestone", after);
  const operation = factory({ kind: "page", projectId: first, category: "milestone", after }, controller.signal, () => true);
  after.id = second;
  await expect(operation(previewPath(first, "milestone", after), { signal: controller.signal }, noop)).rejects.toThrow();
  await expect(operation(expected, { signal: new AbortController().signal }, noop)).rejects.toThrow();
  await expect(operation(expected, { signal: controller.signal }, noop)).rejects.toThrow();
  expect(calls).toEqual([]);
  const retry = new AbortController(), fresh = factory({ kind: "page", projectId: first, category: "milestone", after: { id: first, createdAt: time } }, retry.signal, () => true);
  await fresh(expected, { signal: retry.signal }, noop); expect(calls).toHaveLength(1);
});

it("rejects a reentrant mint and a reentrant attempt at the same path", async () => {
  const { factory, calls } = setup(), controller = new AbortController();
  let nestedMintRejected = false, entered = false;
  const operation = factory({ kind: "batch", projectIds: [first] }, controller.signal, () => {
    if (!entered) {
      entered = true;
      try { factory({ kind: "batch", projectIds: [first] }, controller.signal, () => true); }
      catch { nestedMintRejected = true; }
    }
    return true;
  });
  const path = previewPath(first, "milestone"); let nested: Promise<unknown> | undefined;
  const init = Object.defineProperty({}, "signal", { enumerable: true, get() {
    nested = operation(path, { signal: controller.signal }, noop); void nested.catch(() => {}); return controller.signal;
  } }) as RequestInit;
  await operation(path, init, noop); expect(nestedMintRejected).toBe(true);
  await expect(nested).rejects.toThrow(); expect(calls).toHaveLength(1);
});

it("does not release occupied capacity or reuse a spent path after capacity failure", async () => {
  const { factory, registry, calls } = setup(1), occupied = registry.begin()!;
  const controller = new AbortController(), path = previewPath(first, "milestone");
  const operation = factory({ kind: "batch", projectIds: [first] }, controller.signal, () => true);
  await expect(operation(path, { signal: controller.signal }, noop)).rejects.toThrow();
  occupied.finish("eof");
  await expect(operation(path, { signal: controller.signal }, noop)).rejects.toThrow();
  expect(calls).toEqual([]);
  const retry = new AbortController(), next = factory({ kind: "batch", projectIds: [first] }, retry.signal, () => true);
  await next(path, { signal: retry.signal }, noop); expect(calls).toHaveLength(1);
});

it("suppresses stale scoped callbacks but keeps the original lease until cleanup", async () => {
  const registry = new ManagedReadRegistry(1), issuedSignals = new WeakSet<AbortSignal>();
  let owner = true, finish!: () => void, unavailable!: (denied?: boolean) => void, effects!: () => boolean;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const request: RequestFn = async <T>(...args: Parameters<RequestFn>) => {
    const onUnavailable = args[3], managed = args[4], sideEffectCurrent = args[5];
    unavailable = onUnavailable!; effects = sideEffectCurrent!; await gate; managed!.completion("eof"); return {} as T;
  };
  const factory = createPreviewRequestFactory({ queueCurrent: () => owner, projectIds: [first], request, registry, issuedSignals });
  const controller = new AbortController(), handler = vi.fn();
  const operation = factory({ kind: "batch", projectIds: [first] }, controller.signal, () => true);
  const pending = operation(previewPath(first, "milestone"), { signal: controller.signal }, handler);
  expect(registry.full()).toBe(true); owner = false;
  expect(effects()).toBe(false); unavailable(true); expect(handler).not.toHaveBeenCalled();
  expect(registry.full()).toBe(true); finish(); await expect(pending).rejects.toThrow(); expect(registry.count()).toBe(0);
});

it("shares the one-mint guard across factory replacement, including failed mints", () => {
  const issuedSignals = new WeakSet<AbortSignal>(), registry = new ManagedReadRegistry(2);
  const request: RequestFn = async <T>() => ({} as T);
  const options = { queueCurrent: () => true, projectIds: [first], request, registry, issuedSignals };
  const original = createPreviewRequestFactory(options), replacement = createPreviewRequestFactory(options);
  const signal = new AbortController().signal;
  expect(() => original({ kind: "batch", projectIds: [first, first] }, signal, () => true)).toThrow();
  expect(() => replacement({ kind: "batch", projectIds: [first] }, signal, () => true)).toThrow();
  expect(() => replacement({ kind: "batch", projectIds: [first] }, new AbortController().signal, () => true)).not.toThrow();
});

it("holds two physical slots until both distinct originals report cleanup", async () => {
  const registry = new ManagedReadRegistry(2), issuedSignals = new WeakSet<AbortSignal>();
  const releases: Array<() => void> = [];
  const request: RequestFn = async <T>(...args: Parameters<RequestFn>) => {
    const managed = args[4];
    await new Promise<void>((resolve) => releases.push(resolve)); managed!.completion("eof"); return {} as T;
  };
  const factory = createPreviewRequestFactory({ queueCurrent: () => true, projectIds: [first, second, third], request, registry, issuedSignals });
  const controller = new AbortController(), operation = factory({ kind: "batch", projectIds: [first, second, third] }, controller.signal, () => true);
  const one = operation(previewPath(first, "milestone"), { signal: controller.signal }, noop);
  const two = operation(previewPath(second, "milestone"), { signal: controller.signal }, noop);
  expect(registry.count()).toBe(2);
  await expect(operation(previewPath(third, "milestone"), { signal: controller.signal }, noop)).rejects.toThrow();
  expect(registry.count()).toBe(2); releases[0]!(); await one; expect(registry.count()).toBe(1);
  releases[1]!(); await two; expect(registry.count()).toBe(0);
});

it("keeps an indeterminate cleanup slot occupied and prevents further dispatch", async () => {
  const registry = new ManagedReadRegistry(1), issuedSignals = new WeakSet<AbortSignal>();
  let dispatches = 0;
  const request: RequestFn = async () => { dispatches++; throw new Error("Synthetic transport failure"); };
  const factory = createPreviewRequestFactory({ queueCurrent: () => true, projectIds: [first], request, registry, issuedSignals });
  const firstSignal = new AbortController().signal, firstOperation = factory({ kind: "batch", projectIds: [first] }, firstSignal, () => true);
  await expect(firstOperation(previewPath(first, "milestone"), { signal: firstSignal }, noop)).rejects.toThrow();
  expect(registry.full()).toBe(true); expect(dispatches).toBe(1);
  const retry = new AbortController().signal, next = factory({ kind: "batch", projectIds: [first] }, retry, () => true);
  await expect(next(previewPath(first, "milestone"), { signal: retry }, noop)).rejects.toThrow();
  expect(registry.full()).toBe(true); expect(dispatches).toBe(1);
});

it("keeps a logically canceled original in capacity until EOF, then permits an explicit fresh operation", async () => {
  const registry = new ManagedReadRegistry(1), issuedSignals = new WeakSet<AbortSignal>();
  let finish!: () => void, calls = 0;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const request: RequestFn = async <T>(...args: Parameters<RequestFn>) => {
    calls++; if (calls === 1) await gate; args[4]!.completion("eof"); return {} as T;
  };
  const factory = createPreviewRequestFactory({ queueCurrent: () => true, projectIds: [first], request, registry, issuedSignals });
  const old = new AbortController(), operation = factory({ kind: "batch", projectIds: [first] }, old.signal, () => true);
  const pending = operation(previewPath(first, "milestone"), { signal: old.signal }, noop);
  old.abort(); expect(registry.full()).toBe(true);
  const blocked = new AbortController(), blockedOperation = factory({ kind: "batch", projectIds: [first] }, blocked.signal, () => true);
  await expect(blockedOperation(previewPath(first, "milestone"), { signal: blocked.signal }, noop)).rejects.toThrow();
  expect(calls).toBe(1); finish(); await expect(pending).rejects.toThrow(); expect(registry.count()).toBe(0);
  const retry = new AbortController(), next = factory({ kind: "batch", projectIds: [first] }, retry.signal, () => true);
  await next(previewPath(first, "milestone"), { signal: retry.signal }, noop); expect(calls).toBe(2);
});
