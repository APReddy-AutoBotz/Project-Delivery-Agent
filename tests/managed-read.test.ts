import { expect, it, vi } from "vitest";
import { ManagedReadRegistry } from "../apps/web/src/managed-read-registry.js";
import { managedRead, ManagedReadCapacityError, ManagedReadIncompleteError, ManagedReadStaleError } from "../apps/web/src/managed-read.js";

it("does not admit or dispatch an already-canceled or stale operation", async () => {
  const registry = new ManagedReadRegistry(1), controller = new AbortController(), dispatch = vi.fn();
  controller.abort();
  await expect(managedRead(registry, controller.signal, () => true, dispatch)).rejects.toBeInstanceOf(ManagedReadStaleError);
  await expect(managedRead(registry, new AbortController().signal, () => false, dispatch)).rejects.toBeInstanceOf(ManagedReadStaleError);
  expect(dispatch).not.toHaveBeenCalled(); expect(registry.count()).toBe(0);
});

it("keeps the slot after reported EOF until the original request promise actually settles", async () => {
  const registry = new ManagedReadRegistry(1); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operation = managedRead(registry, new AbortController().signal, () => true, async (_live, report) => {
    report("eof"); await gate; return "value";
  });
  expect(registry.full()).toBe(true);
  await expect(managedRead(registry, new AbortController().signal, () => true, async () => "other")).rejects.toBeInstanceOf(ManagedReadCapacityError);
  release(); await expect(operation).resolves.toBe("value"); expect(registry.count()).toBe(0);
});

it("fences a disposed caller and late callbacks while retaining the physical slot", async () => {
  const registry = new ManagedReadRegistry(1), controller = new AbortController();
  let release!: () => void, wasLive = true;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const operation = managedRead(registry, controller.signal, () => true, async (live, report) => {
    await gate; wasLive = live(); report("eof"); return "old value";
  });
  void operation.catch(() => {}); controller.abort();
  expect(registry.full()).toBe(true); release();
  await expect(operation).rejects.toBeInstanceOf(ManagedReadStaleError);
  expect(wasLive).toBe(false); expect(registry.count()).toBe(0);
});

it("does not release a slot when request or cleanup status is unknown", async () => {
  const registry = new ManagedReadRegistry(1);
  await expect(managedRead(registry, new AbortController().signal, () => true, async () => {
    throw new Error("synthetic request failure");
  })).rejects.toThrow("synthetic request failure");
  expect(registry.full()).toBe(true);
  await expect(managedRead(registry, new AbortController().signal, () => true, async () => "other")).rejects.toBeInstanceOf(ManagedReadCapacityError);
});

it("does not accept a later terminal report after indeterminate cleanup", async () => {
  const registry = new ManagedReadRegistry(1);
  await expect(managedRead(registry, new AbortController().signal, () => true, async (_live, report) => {
    report("unknown"); report("eof"); return "value";
  })).rejects.toBeInstanceOf(ManagedReadIncompleteError);
  expect(registry.full()).toBe(true);
});

it("retains capacity for conflicting or repeated completion reports", async () => {
  for (const [first, second] of [["eof", "unknown"], ["terminated", "unknown"], ["eof", "eof"]] as const) {
    const registry = new ManagedReadRegistry(1);
    await expect(managedRead(registry, new AbortController().signal, () => true, async (_live, report) => {
      report(first); report(second); return "value";
    })).rejects.toBeInstanceOf(ManagedReadIncompleteError);
    expect(registry.full()).toBe(true);
  }
});

it("requires a cleanup report before publishing even a nominally successful result", async () => {
  const registry = new ManagedReadRegistry(1);
  await expect(managedRead(registry, new AbortController().signal, () => true, async () => "value"))
    .rejects.toBeInstanceOf(ManagedReadIncompleteError);
  expect(registry.full()).toBe(true);
});

it("allows an adapter to decline dispatch after a held preflight becomes stale", async () => {
  const registry = new ManagedReadRegistry(1), controller = new AbortController(), fetch = vi.fn();
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const operation = managedRead(registry, controller.signal, () => true, async (live, report) => {
    await gate;
    if (!live()) { report("terminated"); throw new ManagedReadStaleError(); }
    fetch(); report("eof"); return "value";
  });
  void operation.catch(() => {}); controller.abort(); release();
  await expect(operation).rejects.toBeInstanceOf(ManagedReadStaleError);
  expect(fetch).not.toHaveBeenCalled(); expect(registry.count()).toBe(0);
});

it("turns a late rejected request into a generic stale error without releasing early", async () => {
  const registry = new ManagedReadRegistry(1), controller = new AbortController();
  let reject!: (error: Error) => void, reportEnd!: (end: "terminated") => void;
  const gate = new Promise<never>((_resolve, fail) => { reject = fail; });
  const operation = managedRead(registry, controller.signal, () => true, async (_live, report) => {
    reportEnd = report; return gate;
  });
  void operation.catch(() => {}); controller.abort(); expect(registry.full()).toBe(true);
  reportEnd("terminated"); reject(new Error("synthetic-private-error"));
  await expect(operation).rejects.toBeInstanceOf(ManagedReadStaleError);
  expect(registry.count()).toBe(0);
});

it("releases a no-dispatch admission when the scope becomes stale synchronously", async () => {
  const registry = new ManagedReadRegistry(1); let calls = 0; const dispatch = vi.fn();
  await expect(managedRead(registry, new AbortController().signal, () => ++calls === 1, dispatch)).rejects.toBeInstanceOf(ManagedReadStaleError);
  expect(dispatch).not.toHaveBeenCalled(); expect(registry.count()).toBe(0);
});
